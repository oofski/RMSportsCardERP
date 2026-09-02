/**
 * QuickBooks, held by the relay instead of by a laptop.
 *
 * The connection moved into cloud/worker.js so that ONE holder exists. That
 * change is mostly invisible when it works and expensive when it does not, and
 * three parts of it fail silently by construction:
 *
 *   · THE ENCRYPTION AT REST. A wrong key derivation still produces a
 *     ciphertext, still stores, and only fails on the day somebody tries to
 *     read it back — which is the day the owner's invoices stop. So the round
 *     trip is exercised for real, through the actual Worker functions, plus the
 *     case that gets people: an envelope sealed under one key source being
 *     opened after a second one is added.
 *   · THE REFRESH RACE. Intuit rotates the refresh token on every refresh. Two
 *     concurrent Worker invocations both finding a stale access token is
 *     exactly the situation that used to exist between two laptops, and moving
 *     the code to Cloudflare does not by itself fix it — the lease does.
 *     Section 4 runs two refreshes at once and insists Intuit is called once.
 *   · THE ROUTING DECISION. An unreachable relay must NOT make a machine fall
 *     back to whatever stale tokens it still has. That would recreate the second
 *     holder during an outage, when nobody is watching.
 *
 * Plus the two mirrored implementations. `isSafeQboPath` (app) and
 * `qboSafePath` (Worker) are the same rule written twice in files that cannot
 * import each other, which is the shape that drifts — so section 3 runs both
 * over the same cases and fails if they ever disagree.
 *
 * No real credential is in this file. Every key, token and company id here is
 * invented, and the encryption keys are generated inline.
 *
 * Run: npm run test:qbo-relay
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const {
  chooseQboHolder,
  describePromotionBlock,
  describeRelayFailure,
  explainQboRelayProblem,
  isRelayTransportFailure,
  isSafeQboPath,
  promotionBlock,
  promotionSummary,
  qboNotConnectedReason
} = require('../src/shared/quickbooksRelay')

// The Worker itself, not a reimplementation of it. These named exports exist
// purely so this suite can reach them; Cloudflare only ever calls fetch().
const worker = require('../cloud/worker.js')
const { describeQboFault, qboConnection, qboEnsureFresh, qboOpen, qboSafePath, qboSeal } = worker

let pass = 0
let fail = 0
const ok = (c: boolean, n: string, e = ''): void => {
  if (c) {
    pass++
    console.log('  ok   ' + n)
  } else {
    fail++
    console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`)
  }
}

// Invented throughout. Shapes only.
const FAKE_CLIENT_ID = 'ABtest0000000000000000000000000000000'
const FAKE_SECRET = 'secret-that-is-not-real-0000000000000000'
const FAKE_REFRESH_1 = 'refresh-token-one-0000000000000000000000'
const FAKE_REFRESH_2 = 'refresh-token-two-1111111111111111111111'
const FAKE_ACCESS_1 = 'access-token-one-000000000000'
const FAKE_ACCESS_2 = 'access-token-two-111111111111'
const FAKE_REALM = '9341454816183285'
const ENC_KEY = 'enc-key-for-tests-only-aaaaaaaaaaaaaaaaaaaa'
const SHARED = 'shared-key-for-tests-only-bbbbbbbbbbbbbbbb'

// ---------------------------------------------------------------------------
// A D1 stand-in.
//
// One row, and an interpreter over exactly the statements Job 6 issues. Real
// enough for the thing under test: `changes` on a conditional UPDATE is what the
// refresh lease is built on, so it is reported honestly rather than always 1.
// ---------------------------------------------------------------------------
interface Row {
  client_id: string | null
  client_secret: string | null
  redirect_uri: string | null
  realm_id: string | null
  company_name: string | null
  access_token: string | null
  refresh_token: string | null
  expires_at: number
  refresh_expires_at: number
  refresh_lock_until: number
  last_error: string | null
  updated_at: string | null
}

function makeDb(row: Row | null): { DB: unknown; peek: () => Row | null } {
  let stored: Row | null = row ? { ...row } : null

  const exec = (sql: string, args: unknown[]): { results: unknown[]; meta: { changes: number } } => {
    const one = (n: number): unknown => args[n - 1]
    if (sql.includes('CREATE TABLE')) return { results: [], meta: { changes: 0 } }
    if (sql.includes('SELECT * FROM qbo_connection')) {
      return { results: stored ? [stored] : [], meta: { changes: 0 } }
    }
    if (!stored) return { results: [], meta: { changes: 0 } }
    if (sql.includes('SET refresh_lock_until = ?1') && sql.includes('refresh_lock_until < ?2')) {
      // The claim. Conditional, and this is the whole point of the fake.
      if (stored.refresh_lock_until < Number(one(2))) {
        stored.refresh_lock_until = Number(one(1))
        return { results: [], meta: { changes: 1 } }
      }
      return { results: [], meta: { changes: 0 } }
    }
    if (sql.includes('SET refresh_lock_until = 0 WHERE id = 1')) {
      stored.refresh_lock_until = 0
      return { results: [], meta: { changes: 1 } }
    }
    if (sql.includes('SET access_token = ?1, refresh_token = ?2')) {
      stored.access_token = one(1) as string
      stored.refresh_token = one(2) as string
      stored.realm_id = one(3) as string
      stored.expires_at = Number(one(4))
      stored.refresh_expires_at = Number(one(5))
      stored.refresh_lock_until = 0
      stored.last_error = null
      stored.updated_at = one(6) as string
      return { results: [], meta: { changes: 1 } }
    }
    if (sql.includes('SET last_error = ?1')) {
      stored.last_error = (one(1) as string) ?? null
      return { results: [], meta: { changes: 1 } }
    }
    if (sql.includes('SET company_name = ?1')) {
      stored.company_name = one(1) as string
      return { results: [], meta: { changes: 1 } }
    }
    throw new Error('the D1 stand-in does not know this statement: ' + sql.slice(0, 60))
  }

  return {
    peek: () => (stored ? { ...stored } : null),
    DB: {
      prepare(sql: string) {
        let bound: unknown[] = []
        const stmt = {
          bind(...a: unknown[]) {
            bound = a
            return stmt
          },
          async run() {
            return exec(sql, bound)
          },
          async first() {
            return exec(sql, bound).results[0] ?? null
          },
          async all() {
            return exec(sql, bound)
          }
        }
        return stmt
      },
      async batch(list: Array<{ run: () => Promise<unknown> }>) {
        const out = []
        for (const s of list) out.push(await s.run())
        return out
      }
    }
  }
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  console.log('=== 1. encryption at rest ===')
  // -------------------------------------------------------------------------
  const encEnv = { DB: makeDb(null).DB, QBO_ENC_KEY: ENC_KEY, SHARED_KEY: SHARED }
  const sealed = await qboSeal(encEnv, FAKE_REFRESH_1)

  ok(typeof sealed === 'string' && sealed.startsWith('qbo1.d.'), 'the dedicated key is preferred')
  ok(!sealed.includes(FAKE_REFRESH_1), 'and the plaintext is nowhere in the envelope')
  ok((await qboOpen(encEnv, sealed)) === FAKE_REFRESH_1, 'it round-trips')

  const again = await qboSeal(encEnv, FAKE_REFRESH_1)
  ok(again !== sealed, 'sealing the same value twice gives two different envelopes')
  ok((await qboOpen(encEnv, again)) === FAKE_REFRESH_1, 'and both open')

  // The salt is per record; without it, two fields sealed under one secret would
  // share a key and an AES-GCM nonce, which is the one thing GCM does not survive.
  ok(sealed.split('.')[2] !== again.split('.')[2], 'because the salt is fresh each time')

  const sharedOnly = { DB: makeDb(null).DB, SHARED_KEY: SHARED }
  const sharedSealed = await qboSeal(sharedOnly, FAKE_SECRET)
  ok(sharedSealed.startsWith('qbo1.s.'), 'with no dedicated key it falls back to the shared one')
  ok((await qboOpen(sharedOnly, sharedSealed)) === FAKE_SECRET, 'and that round-trips too')

  // THE CASE THAT BREAKS A NAIVE IMPLEMENTATION. The owner sets QBO_ENC_KEY
  // after connecting. Everything already stored was sealed under SHARED_KEY, and
  // an implementation that simply used "the best key available" would fail to
  // open any of it — as an AES-GCM tag mismatch, which names nothing.
  const upgraded = { DB: makeDb(null).DB, QBO_ENC_KEY: ENC_KEY, SHARED_KEY: SHARED }
  ok(
    (await qboOpen(upgraded, sharedSealed)) === FAKE_SECRET,
    'an envelope sealed under the shared key still opens after a dedicated key is added'
  )
  ok(
    (await qboSeal(upgraded, FAKE_SECRET)).startsWith('qbo1.d.'),
    'while anything sealed from then on uses the better key'
  )

  let changedKeyError = ''
  try {
    await qboOpen({ DB: encEnv.DB, QBO_ENC_KEY: ENC_KEY + 'x', SHARED_KEY: SHARED }, sealed)
  } catch (err) {
    changedKeyError = (err as Error).message
  }
  ok(changedKeyError !== '', 'a changed encryption key refuses rather than returning rubbish')
  ok(
    /secret .*has changed|could not be decrypted/i.test(changedKeyError),
    'and says the secret changed, which is the only thing that causes it',
    changedKeyError
  )
  ok(!changedKeyError.includes(FAKE_REFRESH_1), 'and never echoes the value it failed on')

  let malformed = ''
  try {
    await qboOpen(encEnv, 'not-an-envelope')
  } catch (err) {
    malformed = (err as Error).message
  }
  ok(malformed !== '', 'a malformed envelope is refused')

  // -------------------------------------------------------------------------
  console.log('\n=== 2. Intuit faults, described the same on both sides ===')
  // -------------------------------------------------------------------------
  const fault = JSON.stringify({
    Fault: { Error: [{ Message: 'Invalid Reference Id', Detail: 'Names element id not found' }] }
  })
  ok(
    describeQboFault(400, fault) === 'QuickBooks: Invalid Reference Id — Names element id not found',
    'the message and the detail both survive',
    describeQboFault(400, fault)
  )
  ok(
    describeQboFault(400, JSON.stringify({ fault: { error: [{ message: 'Nope' }] } })) ===
      'QuickBooks: Nope',
    'and the lower-case variant Intuit also sends is read'
  )
  ok(/accounting scope/.test(describeQboFault(403, 'not json')), 'a 403 names the likely cause')
  ok(/rate limiting/.test(describeQboFault(429, '')), 'a 429 says to try again')
  ok(/HTTP 500/.test(describeQboFault(500, '<html>')), 'and anything else falls back to the status')

  // -------------------------------------------------------------------------
  console.log('\n=== 3. path safety — two implementations, one rule ===')
  // -------------------------------------------------------------------------
  const paths: Array<[string, boolean]> = [
    ['invoice', true],
    ['query', true],
    ['invoice/123', true],
    ['companyinfo/9341454816183285', true],
    ['preferences', true],
    ['', false],
    ['/invoice', false],
    ['\\invoice', false],
    ['../v3/company/999/invoice', false],
    ['invoice/../../other', false],
    ['https://evil.example/invoice', false],
    ['invoice?operation=delete', false],
    ['invoice 123', false],
    ['inv oice', false],
    ['a'.repeat(400), false]
  ]
  for (const [path, expected] of paths) {
    const label = path.length > 30 ? path.slice(0, 27) + '…' : path || '(empty)'
    ok(isSafeQboPath(path) === expected, `app: ${label} → ${expected}`)
    ok(qboSafePath(path) === expected, `worker: ${label} → ${expected}`)
  }

  // -------------------------------------------------------------------------
  console.log('\n=== 4. the refresh race, which is the reason for all of this ===')
  // -------------------------------------------------------------------------
  const staleRow = async (env: { QBO_ENC_KEY?: string; SHARED_KEY?: string; DB: unknown }): Promise<Row> => ({
    client_id: FAKE_CLIENT_ID,
    client_secret: await qboSeal(env, FAKE_SECRET),
    redirect_uri: null,
    realm_id: FAKE_REALM,
    company_name: 'Invented Cards LLC',
    access_token: await qboSeal(env, FAKE_ACCESS_1),
    refresh_token: await qboSeal(env, FAKE_REFRESH_1),
    // An hour ago: stale by any measure, including the five-minute skew.
    expires_at: Date.now() - 60 * 60 * 1000,
    refresh_expires_at: Date.now() + 90 * 24 * 60 * 60 * 1000,
    refresh_lock_until: 0,
    last_error: null,
    updated_at: new Date().toISOString()
  })

  const realFetch = globalThis.fetch
  let tokenCalls = 0
  const intuitAnswers = (): void => {
    globalThis.fetch = (async () => {
      tokenCalls++
      // A LITTLE SLOWER THAN INSTANT, on purpose. A fetch that resolves in the
      // same microtask never lets a second caller reach the claim, so the race
      // this section exists to test would not occur.
      await new Promise((r) => setTimeout(r, 60))
      return new Response(
        JSON.stringify({
          access_token: FAKE_ACCESS_2,
          refresh_token: FAKE_REFRESH_2,
          expires_in: 3600,
          x_refresh_token_expires_in: 8726400
        }),
        { status: 200 }
      )
    }) as typeof fetch
  }

  try {
    // -- one caller, stale token -> exactly one refresh, rotation stored ------
    {
      const db = makeDb(null)
      const env = { DB: db.DB, QBO_ENC_KEY: ENC_KEY }
      const seeded = makeDb(await staleRow(env))
      const env2 = { DB: seeded.DB, QBO_ENC_KEY: ENC_KEY }
      tokenCalls = 0
      intuitAnswers()
      const conn = await qboConnection(env2)
      const fresh = await qboEnsureFresh(env2, conn, false)
      ok(tokenCalls === 1, 'a stale access token is refreshed once', String(tokenCalls))
      ok(fresh.accessToken === FAKE_ACCESS_2, 'and the new access token comes back')
      const after = seeded.peek() as Row
      ok(
        (await qboOpen(env2, after.refresh_token)) === FAKE_REFRESH_2,
        'THE ROTATED REFRESH TOKEN IS STORED — keeping the old one works once more and then stops'
      )
      ok(after.refresh_lock_until === 0, 'and the lease is released')
      ok(after.expires_at > Date.now(), 'and the new expiry is in the future')
    }

    // -- two callers at once -> still exactly one refresh ---------------------
    {
      const seeded = makeDb(await staleRow({ DB: makeDb(null).DB, QBO_ENC_KEY: ENC_KEY }))
      const env = { DB: seeded.DB, QBO_ENC_KEY: ENC_KEY }
      tokenCalls = 0
      intuitAnswers()
      const go = async (): Promise<{ accessToken: string }> =>
        qboEnsureFresh(env, await qboConnection(env), false)
      const [a, b] = await Promise.all([go(), go()])
      ok(
        tokenCalls === 1,
        'two admins pressing send in the same second produce ONE call to Intuit',
        `${tokenCalls} calls`
      )
      ok(
        a.accessToken === FAKE_ACCESS_2 && b.accessToken === FAKE_ACCESS_2,
        'and both of them end up with the token that was actually issued'
      )
      ok(
        (await qboOpen(env, (seeded.peek() as Row).refresh_token)) === FAKE_REFRESH_2,
        'and the stored refresh token is the single rotation, not a discarded second one'
      )
    }

    // -- a token that is still good is left alone -----------------------------
    {
      const row = await staleRow({ DB: makeDb(null).DB, QBO_ENC_KEY: ENC_KEY })
      row.expires_at = Date.now() + 60 * 60 * 1000
      const seeded = makeDb(row)
      const env = { DB: seeded.DB, QBO_ENC_KEY: ENC_KEY }
      tokenCalls = 0
      intuitAnswers()
      const conn = await qboConnection(env)
      const same = await qboEnsureFresh(env, conn, false)
      ok(tokenCalls === 0, 'a live access token is not refreshed for nothing')
      ok(same.accessToken === FAKE_ACCESS_1, 'and is used as it stands')
    }

    // -- a token inside the skew IS refreshed ---------------------------------
    {
      const row = await staleRow({ DB: makeDb(null).DB, QBO_ENC_KEY: ENC_KEY })
      // Two minutes left: valid, and inside the five-minute skew. A call that
      // starts here would otherwise land just the wrong side of expiry.
      row.expires_at = Date.now() + 2 * 60 * 1000
      const seeded = makeDb(row)
      const env = { DB: seeded.DB, QBO_ENC_KEY: ENC_KEY }
      tokenCalls = 0
      intuitAnswers()
      await qboEnsureFresh(env, await qboConnection(env), false)
      ok(tokenCalls === 1, 'a token about to expire is refreshed before it is used')
    }

    // -- a failed refresh releases the lease ----------------------------------
    {
      const seeded = makeDb(await staleRow({ DB: makeDb(null).DB, QBO_ENC_KEY: ENC_KEY }))
      const env = { DB: seeded.DB, QBO_ENC_KEY: ENC_KEY }
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as typeof fetch
      let threw = ''
      try {
        await qboEnsureFresh(env, await qboConnection(env), false)
      } catch (err) {
        threw = (err as Error).message
      }
      ok(threw !== '', 'a refused refresh throws')
      ok(
        (seeded.peek() as Row).refresh_lock_until === 0,
        'AND RELEASES THE LEASE — holding it would make every later call wait for a refresh that already failed'
      )
    }

    // -- an expired refresh token does not even try ---------------------------
    {
      const row = await staleRow({ DB: makeDb(null).DB, QBO_ENC_KEY: ENC_KEY })
      row.refresh_expires_at = Date.now() - 1000
      const seeded = makeDb(row)
      const env = { DB: seeded.DB, QBO_ENC_KEY: ENC_KEY }
      tokenCalls = 0
      intuitAnswers()
      let threw = ''
      try {
        await qboEnsureFresh(env, await qboConnection(env), false)
      } catch (err) {
        threw = (err as Error).message
      }
      ok(/re-authorised|approve again/i.test(threw), 'an expired grant says to approve again', threw)
      ok(tokenCalls === 0, 'without spending a call on a token Intuit has already retired')
    }
  } finally {
    globalThis.fetch = realFetch
  }

  // -------------------------------------------------------------------------
  console.log('\n=== 5. which holder answers the next call ===')
  // -------------------------------------------------------------------------
  const holder = (relayConfigured: boolean, relayHolds: boolean, localConnected: boolean): string =>
    chooseQboHolder({ relayConfigured, relayHolds, localConnected })

  ok(holder(true, true, false) === 'relay', 'a laptop with nothing of its own uses the relay')
  ok(holder(true, true, true) === 'relay', 'AND SO DOES ONE THAT STILL HAS LOCAL TOKENS')
  ok(holder(true, false, true) === 'local', 'a relay holding nothing leaves the local grant in charge')
  ok(holder(false, false, true) === 'local', 'a standalone build uses its own')
  ok(holder(true, false, false) === 'none', 'and nothing anywhere is nothing')
  ok(holder(false, true, false) === 'none', 'a relay this build is not wired to does not count')

  // The rule that keeps the guarantee during an outage. `relayHolds` is what the
  // relay LAST said, so an unreachable relay does not change the answer — the
  // laptop reports the relay as unreachable instead of quietly promoting itself
  // to second holder and refreshing a grant Intuit rotates.
  ok(
    holder(true, true, true) === 'relay',
    'an unreachable relay does not hand the grant back to a laptop'
  )

  const reason = qboNotConnectedReason({
    relayConfigured: true,
    relayHolds: false,
    localConnected: false
  })
  ok(/relay/i.test(reason) && /once/i.test(reason), 'the not-connected message points at the relay', reason)
  ok(
    !/this computer/i.test(reason) || /not on this computer/i.test(reason),
    'and does not send an admin to set anything up on their own machine',
    reason
  )
  const standalone = qboNotConnectedReason({
    relayConfigured: false,
    relayHolds: false,
    localConnected: false
  })
  ok(
    /Cloud sync/.test(standalone),
    'while a standalone build is told where the relay setting is',
    standalone
  )

  // -------------------------------------------------------------------------
  console.log('\n=== 6. a failure that names the relay, not QuickBooks ===')
  // -------------------------------------------------------------------------
  const outdated = explainQboRelayProblem('Relay error 404.')
  ok(/older copy of cloud\/worker\.js/.test(outdated), 'a 404 names the stale paste', outdated)
  ok(/CLOUDFLARE\.md/.test(outdated), 'and the document with the four clicks in it')

  const unauthorised = explainQboRelayProblem('Relay error 401.')
  ok(
    /shared key/i.test(unauthorised) && /not QuickBooks/i.test(unauthorised),
    'a 401 is the relay refusing us, and says so',
    unauthorised
  )

  const dead = explainQboRelayProblem('fetch failed')
  ok(/cloud relay/i.test(dead), 'anything else is still attributed to the relay', dead)
  ok(
    /invoice itself is saved/i.test(dead),
    'AND SAYS THE INVOICE IS SAFE — that is the sentence that stops somebody raising it twice',
    dead
  )
  ok(dead.startsWith('fetch failed'), 'while keeping the original text rather than inventing one')
  ok(explainQboRelayProblem('') !== '', 'an empty error still says something')

  /**
   * THE MESSAGE NODE ACTUALLY PRODUCES, which was the one shape this missed.
   *
   * `controller.abort()` — what the relay's own timeout calls — throws
   * "This operation was aborted". The check looked for "the operation was
   * aborted", which is what `AbortSignal.timeout()` says and nothing here uses.
   * One word, and the timeout this app causes itself was the only transport
   * failure that did not read as one.
   */
  ok(
    isRelayTransportFailure('This operation was aborted'),
    'THE ABORT NODE ACTUALLY THROWS is a transport failure — "This", not "The", and the ' +
      'difference was the whole bug'
  )
  ok(
    isRelayTransportFailure('The operation was aborted due to timeout'),
    'and so is the other spelling, which is what AbortSignal.timeout says'
  )
  ok(isRelayTransportFailure('AbortError'), 'and the bare error name, however it reaches here')
  ok(isRelayTransportFailure('fetch failed'), 'a dead socket is a transport failure')
  ok(isRelayTransportFailure('Relay error 500.'), 'and so is a relay 500')

  /**
   * EVERY CALL OUT OF THE WORKER HAS A DEADLINE.
   *
   * It had none, and that is the whole reason a stuck QuickBooks call produced
   * silence rather than an error: the app asks the relay, the relay asks Intuit,
   * and with nothing bounding the second hop the only observable event was the
   * APP giving up — which names the wrong end of the chain.
   *
   * Asserted against the FILE because the Worker is deployed by hand and never
   * imported by these tests. A bare fetch added later would reintroduce exactly
   * this, invisibly.
   */
  {
    const worker = require('node:fs').readFileSync('cloud/worker.js', 'utf8') as string
    const intuitHosts = ['QBO_TOKEN_URL', 'QBO_REVOKE_URL']
    const bare = intuitHosts.filter((h) =>
      new RegExp(`fetch\\(\\s*${h}`).test(worker)
    )
    ok(
      bare.length === 0,
      'NO CALL TO INTUIT IS MADE WITH A BARE fetch — they all go through qboUpstream, which ' +
        'carries the deadline. Without one, a quiet Intuit hangs the relay for ever and the ' +
        'app can only report itself giving up',
      bare.join(', ')
    )
    ok(
      /AbortSignal\.timeout\(QBO_UPSTREAM_TIMEOUT_MS\)/.test(worker),
      'and the deadline is a real AbortSignal, not a comment about one'
    )
    ok(
      /TimeoutError|AbortError/.test(worker) && /did not answer within/.test(worker),
      'AND A TIMEOUT COMES BACK AS A SENTENCE naming Intuit and the stage, rather than as a ' +
        'dropped connection the app has to guess about'
    )
  }
  {
    const said = explainQboRelayProblem('This operation was aborted')
    ok(
      /did not answer in time/i.test(said) && /NOTHING WAS REFUSED/.test(said),
      'A TIMEOUT IS EXPLAINED AS A TIMEOUT, not repeated as "aborted" — which reads like ' +
        'QuickBooks looked at the invoice and said no, when nothing looked at it',
      said
    )
    ok(
      !/^This operation was aborted/.test(said),
      'and the raw wording does not lead the sentence, because it sent people to check their ' +
        'QuickBooks data for a fault that was never there'
    )
    ok(
      /Cloudflare/i.test(said),
      'and it names where the answer actually is — the Worker log',
      said
    )
  }
  ok(
    !isRelayTransportFailure('QuickBooks: Invalid Reference Id — Names element id not found'),
    'AND AN INTUIT REFUSAL IS NOT — retrying that unchanged never works'
  )
  ok(
    !isRelayTransportFailure('QuickBooks has no customer called “Nobody”.'),
    'nor is a missing customer'
  )

  // The attribution itself, which is the decision the two above exist to make.
  const missingCustomer = 'QuickBooks has no customer called “Nobody”. Add them in QuickBooks first.'
  ok(
    describeRelayFailure(missingCustomer) === missingCustomer,
    'a business refusal is passed through word for word — it is the actionable one',
    describeRelayFailure(missingCustomer)
  )
  ok(
    describeRelayFailure('QuickBooks: Invalid Reference Id — Names element id not found') ===
      'QuickBooks: Invalid Reference Id — Names element id not found',
    'and so is an Intuit fault'
  )
  ok(
    describeRelayFailure('QuickBooks is not connected on the relay.').startsWith('QuickBooks is not'),
    'and so is the relay saying nobody has connected it'
  )
  ok(
    /cloud relay/i.test(describeRelayFailure('fetch failed')),
    'while a dead socket is named as the relay'
  )
  ok(
    /older copy of cloud\/worker\.js/.test(describeRelayFailure('Relay error 404.')),
    'and a stale Worker is named as a stale Worker'
  )

  // -------------------------------------------------------------------------
  console.log('\n=== 7. the one-time move ===')
  // -------------------------------------------------------------------------
  const block = (r: boolean, rc: boolean, lc: boolean, lt: boolean): string | null =>
    promotionBlock({
      relayConfigured: r,
      relayConnected: rc,
      localConfigured: lc,
      localConnected: lt
    })

  ok(block(true, false, true, true) === null, 'the owner’s connected laptop can move it')
  ok(block(false, false, true, true) === 'no-relay', 'a standalone build has nowhere to move it to')
  ok(block(true, true, true, true) === 'already-there', 'a relay already holding one needs no move')
  ok(block(true, false, false, false) === 'no-local-config', 'no keys here means nothing to move')
  ok(block(true, false, true, false) === 'no-local-tokens', 'keys without a grant is not a move')
  ok(describePromotionBlock(null) === null, 'and a clear path has nothing to explain')
  ok(
    /Cloud sync/.test(describePromotionBlock('no-relay') as string),
    'each refusal says what to do instead'
  )

  const summary = promotionSummary('Invented Cards LLC')
  ok(summary.length >= 4, 'the summary lists what will happen')
  ok(summary.some((l: string) => l.includes('Invented Cards LLC')), 'and names the company')
  ok(
    summary.some((l: string) => /ERASED|erased|deleted/.test(l)),
    'AND SAYS THE LOCAL COPY IS ERASED — before the button, because that half cannot be undone'
  )
  ok(
    summary.some((l: string) => /nothing is changed|stays connected/i.test(l)),
    'and that a failure changes nothing'
  )
  ok(
    promotionSummary(null).every((l: string) => !l.includes('undefined') && !l.includes('null')),
    'an unnamed company does not leak a placeholder into the sentence'
  )

  // -------------------------------------------------------------------------
  console.log('\n=== the Worker survives being PASTED ===')
  // -------------------------------------------------------------------------
  // HOW THE RELAY IS DEPLOYED IS PART OF ITS CONTRACT. cloud/worker.js is not
  // bundled or uploaded by a tool — somebody opens the Cloudflare dashboard and
  // pastes the file into a browser editor. So "it parses in Node" is NOT the
  // property that matters; "it survives a paste" is.
  //
  // This exists because of one shipped bug. A regex character class was written
  // with two LITERAL control characters where a space and a hyphen belonged.
  // Node accepted it — the class read as the ascending range U+0000 to U+001F —
  // so `node --check cloud/worker.js` passed and it went out. Cloudflare's editor
  // then stripped the invisible NUL on paste, which left the hyphen sitting
  // between `/` (U+002F) and U+001F: a DESCENDING range, and the Worker refused
  // to save with "Range out of order in character class".
  //
  // A control character is invisible in every editor, every diff and every code
  // review it passes through. Nothing but a byte-level check can see one.
  const workerSource: string = require('node:fs').readFileSync(
    require('node:path').join(process.cwd(), 'cloud/worker.js'),
    'utf8'
  )
  const controlChars: string[] = []
  workerSource.split('\n').forEach((line: string, i: number) => {
    for (const ch of line) {
      const code = ch.codePointAt(0) ?? 0
      // Tab is legitimate whitespace; the split already consumed the newlines.
      if ((code < 32 && code !== 9) || code === 127) {
        controlChars.push(`line ${i + 1}: U+${code.toString(16).padStart(4, '0')}`)
      }
    }
  })
  ok(
    controlChars.length === 0,
    'cloud/worker.js contains no literal control characters',
    controlChars.slice(0, 5).join(', ')
  )

  // And every regex in it actually compiles — the failure the control characters
  // caused, checked directly rather than only via its cause.
  const literals = workerSource.match(/\/\[[^\n]*?\]([gimsuy]*)/g) ?? []
  const broken: string[] = []
  for (const lit of literals) {
    const body = lit.slice(1).replace(/\/[gimsuy]*$/, '')
    try {
      new RegExp(body)
    } catch (err) {
      broken.push(`${lit}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  ok(broken.length === 0, 'and every character class in it compiles', broken.slice(0, 3).join(' | '))

  /**
   * AND NEITHER DOES ANY OTHER SOURCE FILE.
   *
   * This check was worker-only for a long time, on the reasoning that the paste
   * into Cloudflare was the thing that broke. That reasoning was too narrow, and
   * it was proved so: a literal NUL went into `src/main/db/invoices.ts` as the
   * separator in a Map key, joined and split with the same invisible byte, so it
   * worked — typecheck, build and every test passed — and it would have gone on
   * working until something normalised the file and silently changed what the
   * two halves of a key were.
   *
   * A control character costs nothing to forbid and cannot be seen by any human
   * process. Every character that needs to be one is written as an escape.
   */
  const walk = (dir: string, out: string[] = []): string[] => {
    const fs = require('node:fs')
    const path = require('node:path')
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'out', 'dist', 'release', 'build'].includes(entry.name)) continue
        walk(full, out)
      } else if (/\.(ts|tsx|js|jsx|css)$/.test(entry.name)) {
        out.push(full)
      }
    }
    return out
  }
  const offenders: string[] = []
  for (const file of [
    ...walk(require('node:path').join(process.cwd(), 'src')),
    ...walk(require('node:path').join(process.cwd(), 'tests')),
    ...walk(require('node:path').join(process.cwd(), 'cloud'))
  ]) {
    const bytes: Buffer = require('node:fs').readFileSync(file)
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]
      // Tab, newline and carriage return are the only ones a source file may hold.
      if ((b < 32 && b !== 9 && b !== 10 && b !== 13) || b === 127) {
        offenders.push(`${file.replace(process.cwd() + '/', '')} byte ${i}: 0x${b.toString(16)}`)
        break
      }
    }
  }
  ok(
    offenders.length === 0,
    'NO SOURCE FILE ANYWHERE CONTAINS A LITERAL CONTROL CHARACTER — no editor, diff or review can see one',
    offenders.slice(0, 5).join(', ')
  )

  // -------------------------------------------------------------------------
  console.log('\n=== attachments: what the relay will and will not carry ===')
  // -------------------------------------------------------------------------
  // The relay is the boundary. The app checks these too, but THIS check is the
  // one standing between somebody holding the shared key and an oversized or
  // malformed upload aimed at the connected company — the same reason
  // qboSafePath is duplicated rather than trusted from the app side.

  // The size cap is applied to the ENCODED string before anything is decoded.
  // Checking after decoding means a caller who sends 200MB has already had 200MB
  // allocated inside the isolate by the time it is refused.
  /** The message a synchronous call threw, or null. */
  const threwAsync = (fn: () => unknown): string | null => {
    try {
      fn()
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }

  const tiny = Buffer.from('%PDF-1.4 hello').toString('base64')
  ok(worker.qboAttachmentBytes(tiny).length === 14, 'a small file decodes to its bytes')
  ok(
    worker.qboAttachmentBytes(tiny) instanceof Uint8Array,
    'as bytes rather than a string, which is what FormData needs'
  )
  ok(threwAsync(() => worker.qboAttachmentBytes('')) !== null, 'an empty attachment is refused')

  // 12MB of base64 is ~9MB decoded, over the 8MB cap.
  const oversized = 'A'.repeat(12 * 1024 * 1024)
  const tooBig = threwAsync(() => worker.qboAttachmentBytes(oversized))
  ok(tooBig !== null, 'an oversized attachment is refused')
  ok((tooBig ?? '').toLowerCase().includes('too large'), 'and says why', tooBig ?? '')

  // The file name travels into a Content-Disposition header, so a quote or a
  // newline in it would break the multipart FRAMING rather than merely producing
  // an odd name. Stripped rather than rejected — failing an upload over a
  // punctuation mark in a customer's name is the worse outcome.
  ok(
    !/[\r\n"]/.test(worker.qboAttachmentName('inv "2293"\r\nX-Evil: 1', 'doc')),
    'quotes and newlines cannot escape the Content-Disposition header'
  )
  ok(worker.qboAttachmentName('', 'document') === 'document', 'a blank name falls back')
  // HYPHENS SURVIVE. They are the separator this app puts in its own file names,
  // and the first version of this stripped them — turning invoice-2293.pdf into
  // invoice_2293.pdf on every attachment.
  ok(
    worker.qboAttachmentName('invoice-2293.pdf', 'doc') === 'invoice-2293.pdf',
    'the name this app actually generates comes back untouched',
    worker.qboAttachmentName('invoice-2293.pdf', 'doc')
  )
  ok(
    !/[/\\:*?<>|]/.test(worker.qboAttachmentName('a/b\\c:d*e?f<g>h|i', 'doc')),
    'and every character a filesystem or a header would object to is gone',
    worker.qboAttachmentName('a/b\\c:d*e?f<g>h|i', 'doc')
  )
  ok(
    worker.qboAttachmentName('...', 'doc') === 'doc',
    'a name that is nothing but punctuation falls back rather than becoming an empty file name'
  )
  ok(
    worker.qboAttachmentName('x'.repeat(400), 'doc').length <= 120,
    'and an absurd one is trimmed rather than sent'
  )

  // -------------------------------------------------------------------------
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
