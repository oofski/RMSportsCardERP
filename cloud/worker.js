/**
 * RM Operations relay — a Cloudflare Worker in front of a D1 database.
 *
 * Two jobs, deliberately kept apart:
 *
 *   1. THE SYNC BRAIN.  Every laptop pushes the rows it changed and pulls the
 *      rows everyone else changed, every few seconds. Authenticated with a
 *      shared key. This is what makes ten people see the same inventory.
 *
 *   2. THE PUBLIC INTAKE FORM.  One unguessable link per event. No key, because
 *      customers do not have one. Submissions are stored as ordinary sync rows,
 *      so they arrive on the laptops through job 1 with no extra machinery.
 *
 *   3. THE STAFF CLOCK.  A phone, a PIN, two buttons.
 *
 *   4. CLOCK-IN PUSH NOTIFICATIONS.  Real W3C Web Push, signed and encrypted
 *      here. See the "Job 4" section for why it is HERE and not in the app.
 *
 *   6. THE QUICKBOOKS CONNECTION.  The only holder of the accounting grant. The
 *      laptops have no client secret and no tokens; they ask this Worker to make
 *      the Intuit call. See the "Job 6" section — Intuit rotates the refresh
 *      token on every refresh, and one holder is the only arrangement in which
 *      that cannot silently kill somebody's connection.
 *
 * What this Worker is NOT: it does not run the business. It holds no logic about
 * cost, stock or orders, and it never decides anything — it stores rows and hands
 * them back in order. Every rule lives in the app, on the laptops, where it can
 * be tested and where it keeps working when Cloudflare cannot be reached.
 *
 * Deployed from the dashboard (Workers & Pages → Create → paste this file).
 * Bindings it expects:
 *   DB                D1 database binding
 *   SHARED_KEY        secret; the shared key every laptop sends
 *   BRAND             optional plain-text var; company name shown on the public form
 *   VAPID_PRIVATE_KEY secret; 32 bytes base64url. REQUIRED for notifications, and the
 *                     one thing here with no default. NEVER in the repo — see
 *                     docs/CLOUDFLARE.md. Missing it is logged loudly on every punch
 *   VAPID_PUBLIC_KEY  optional plain-text var; overrides VAPID_PUBLIC_KEY_DEFAULT below,
 *                     which is where the public half normally lives. Not a secret
 *   VAPID_SUBJECT     optional; a mailto: or https: URI a push service can use to
 *                     contact whoever runs this. Defaults to VAPID_SUBJECT_DEFAULT below
 *   QBO_ENC_KEY       secret; any long random string. What the stored QuickBooks client
 *                     secret and tokens are encrypted with at rest. Strongly recommended
 *                     and not required: without it they are sealed under SHARED_KEY
 *                     instead, which is weaker because SHARED_KEY is compiled into every
 *                     laptop's build. NEVER in the repo. See the "Job 6" section
 *
 * No R2. R2 stores files, and nothing here is a file — the rows travel as JSON
 * in D1. R2 only becomes necessary the day product photos should travel too.
 */

const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_PUSH_ROWS = 500
const MAX_PULL_ROWS = 1000

/**
 * How far ahead of the relay a laptop's clock may be and still be believed.
 *
 * Conflicts are settled by comparing timestamps written by the laptops, so a
 * machine whose clock is a year fast would win every conflict forever — its
 * edits would beat everyone's, including edits made after them. Clamping to the
 * relay's own clock costs nothing when clocks are sane and contains the damage
 * when one is not.
 */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000

export default {
  // `ctx` is Cloudflare's third argument and is what makes push notifications
  // free at the point of use: sending one is several TLS round trips to Apple,
  // Google and Mozilla, and nobody pressing "Clock in" on a warehouse phone
  // should wait for them. ctx.waitUntil keeps the Worker alive to finish that
  // work AFTER the response has already gone back. See scheduleAfterResponse.
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'

    try {
      if (request.method === 'OPTIONS') return preflight()

      if (path === '/health' || path === '/') return json({ ok: true, service: 'rm-operations-relay' })

      // ---- Job 2: the public form. Before the key check, on purpose. --------
      if (path.startsWith('/checkin/')) {
        const token = decodeURIComponent(path.slice('/checkin/'.length))
        if (request.method === 'GET') return intakeForm(env, token)
        if (request.method === 'POST') return intakeSubmit(request, env, token)
        return json({ ok: false, error: 'Method not allowed.' }, 405)
      }

      // ---- Job 3: the staff clock. Also before the key check --------------
      // Employees have no shared key and never will: it is the credential that
      // lets a caller read and write the whole company, and it is not going on
      // a phone. They authenticate as themselves, with their own PIN.
      if (path === '/clock' && request.method === 'GET') return clockPage(env)
      if (path.startsWith('/clock/api/')) return clockApi(request, env, path, ctx)

      // ---- Job 1: sync. Everything below needs the shared key. -------------
      if (!authorized(request, env)) {
        return json({ ok: false, error: 'Unauthorized.' }, 401)
      }

      if (path === '/v1/state' && request.method === 'GET') return state(env)
      if (path === '/v1/push' && request.method === 'POST') return push(request, env, ctx)
      if (path === '/v1/pull' && request.method === 'GET') return pull(url, env)
      if (path === '/v1/reset' && request.method === 'POST') return reset(request, env)

      // ---- Job 4: web push. Behind the shared key because the APP SERVER is
      // what calls these, never a browser. A phone has no shared key, so its
      // subscription travels browser → app (session cookie, permission check) →
      // relay (shared key). That is also why there are no CORS headers on the
      // replies: nothing cross-origin is supposed to reach this.
      if (path === '/v1/push-notify/key' && request.method === 'GET') return pushKey(env)
      if (path === '/v1/push-notify/subscribe' && request.method === 'POST') {
        return pushSubscribe(request, env)
      }
      if (path === '/v1/push-notify/unsubscribe' && request.method === 'POST') {
        return pushUnsubscribe(request, env)
      }
      if (path === '/v1/push-notify/list' && request.method === 'GET') return pushList(url, env)
      if (path === '/v1/push-notify/test' && request.method === 'POST') {
        return pushTest(request, env)
      }
      if (path === '/v1/push-notify/generate-keys' && request.method === 'POST') {
        return generateVapidKeys()
      }

      // ---- Job 6: QuickBooks. Behind the shared key, because these routes ARE
      // the accounting connection: whoever can call them can raise an invoice in
      // the owner's real books. Nothing here ever hands a token back — the app
      // asks the relay to make a call, it does not ask for the credentials to
      // make one itself. That asymmetry is the whole feature.
      if (path.startsWith('/v1/qbo/')) return qboApi(request, env, path)

      return json({ ok: false, error: 'Not found.' }, 404)
    } catch (err) {
      return json({ ok: false, error: String((err && err.message) || err) }, 500)
    }
  },

  /**
   * Job 5: the only thing in this file that nobody asked for.
   *
   * Every other route here reacts — a laptop pushes, a phone posts, the Worker
   * answers. A stream reminder has to fire when NOTHING has happened, at ten to
   * nine on a Friday with every laptop asleep, so it needs a clock of its own.
   * That clock is a Cloudflare Cron Trigger, and this is what it calls.
   *
   * IT DOES NOT EXIST UNTIL SOMEBODY ADDS THE TRIGGER IN THE DASHBOARD. Pasting
   * this file in is not enough — there is no wrangler.toml in this project and
   * therefore nothing that declares a schedule. A Worker with this handler and no
   * trigger is a Worker where scheduled streams are recorded, displayed, synced,
   * and silently never announced. docs/CLOUDFLARE.md has the four clicks.
   *
   * Never throws outward and never leaves work floating: waitUntil is what keeps
   * the invocation alive while it talks to Apple and Google, exactly as the punch
   * path does.
   */
  async scheduled(event, env, ctx) {
    // event.scheduledTime is the moment the cron was DUE, not the moment this
    // started. Using it means a queued invocation evaluates the window it was
    // scheduled for rather than one drifted by however long the queue was —
    // which is the difference between a reminder landing inside its window and
    // one being suppressed for lateness it did not cause.
    const at = Number((event && event.scheduledTime) || Date.now())
    await scheduleAfterResponse(ctx, () => runStreamReminders(env, at))
  }
}

/**
 * Run work after the response has been sent, or inline when there is no runtime
 * to hold the Worker open.
 *
 * The fallback is not decoration. `ctx` is absent in tests and in any harness
 * that calls a route function directly, and a floating promise there is work
 * that silently never happens — which for a notification means "it worked in
 * production and did nothing in the suite", the exact shape of bug this repo
 * keeps writing comments about.
 */
async function scheduleAfterResponse(ctx, task) {
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(
      task().catch((err) => {
        // A failed notification must never turn a successful punch into a 500.
        // The punch is the record; the push is a courtesy on top of it.
        console.log('push: ' + String((err && err.message) || err))
      })
    )
    return
  }
  try {
    await task()
  } catch (err) {
    console.log('push: ' + String((err && err.message) || err))
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Compared character by character over the FULL length rather than with `===`,
 * so the time this takes does not depend on how much of the key was right. It
 * is a small thing, but it is the difference between a secret and a secret that
 * can be guessed one character at a time.
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function authorized(request, env) {
  // SHARED_KEY is the name to use. CLINIC_KEY is accepted too, so a Worker set
  // up from the earlier project's habits works without anyone hunting for why
  // every request is a 401.
  const expected = env.SHARED_KEY || env.CLINIC_KEY
  if (!expected) return false
  const header = request.headers.get('authorization') || ''
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
  return safeEqual(bearer, expected)
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function json(body, status = 200, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign(
      {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      },
      // The staff clock sets and clears its session cookie on ordinary JSON
      // replies, so this has to be able to carry a header the sync routes never
      // needed.
      extra || {}
    )
  })
}

function preflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type'
    }
  })
}

async function readJson(request) {
  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) throw new Error('Request body too large.')
  if (!raw.trim()) return {}
  return JSON.parse(raw)
}

// ---------------------------------------------------------------------------
// Job 1 — sync
// ---------------------------------------------------------------------------

/**
 * Reserve `count` sequence numbers and return the last one.
 *
 * Done as a batch (which D1 runs as one transaction) rather than with
 * UPDATE ... RETURNING, so it does not depend on a SQLite feature the platform
 * could lag on. The atomicity is the point: two laptops pushing in the same
 * millisecond must never be handed overlapping ranges, or one push would
 * overwrite the other's rows in the log and those rows would never be delivered.
 */
async function allocateSeq(env, count) {
  const [, read] = await env.DB.batch([
    env.DB.prepare('UPDATE sync_seq SET value = value + ?1 WHERE id = 1').bind(count),
    env.DB.prepare('SELECT value FROM sync_seq WHERE id = 1')
  ])
  const row = (read.results || [])[0]
  if (!row) throw new Error('sync_seq is missing — run cloud/schema.sql against this database.')
  return Number(row.value)
}

async function state(env) {
  const seq = await env.DB.prepare('SELECT value FROM sync_seq WHERE id = 1').first()
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM sync_rows').first()
  return json({
    ok: true,
    cursor: seq ? Number(seq.value) : 0,
    rows: count ? Number(count.n) : 0,
    now: new Date().toISOString()
  })
}

/**
 * Take rows from one laptop.
 *
 * Conflict resolution is last-write-wins on `updated_at`, applied per row in
 * SQL: a push only overwrites a stored row that is OLDER than what is being
 * pushed. This is what makes a retry safe — pushing the same batch twice is a
 * no-op the second time — and what stops a laptop that has been offline for a
 * week from overwriting a colleague's newer edits when it reconnects.
 *
 * Every accepted row gets a fresh sequence number, because the sequence is a
 * DELIVERY order, not an edit order: a row updated today must be handed to
 * everyone who has not seen today's version, regardless of where it sat before.
 */
async function push(request, env, ctx) {
  const body = await readJson(request)
  const rows = Array.isArray(body.rows) ? body.rows : []
  const device = String(body.device || '').slice(0, 100)
  if (rows.length > MAX_PUSH_ROWS) {
    return json({ ok: false, error: `Too many rows (max ${MAX_PUSH_ROWS}).` }, 413)
  }
  if (rows.length === 0) {
    const seq = await env.DB.prepare('SELECT value FROM sync_seq WHERE id = 1').first()
    return json({ ok: true, accepted: 0, cursor: seq ? Number(seq.value) : 0 })
  }

  // What the timesheet rows in this batch looked like BEFORE it landed.
  //
  // Read here, not after, because the whole point is the difference: a punch is
  // an EDIT to a row, and only the before-and-after says whether somebody
  // started a shift, ended one, or whether an admin merely corrected a note on
  // a shift that ended last Tuesday. Guessing from the incoming row alone would
  // send a "clocked in" every time any laptop re-pushed an old entry.
  const timeIds = []
  for (const row of rows) {
    if (String(row && row.kind) === 'time_entries' && row.id) timeIds.push(String(row.id))
  }
  const before = await readTimeEntries(env, timeIds)

  const ceiling = Date.now() + MAX_CLOCK_SKEW_MS
  const nowIso = new Date().toISOString()

  // One sequence number per row, allocated as a single atomic bump so two
  // laptops pushing at the same moment can never be handed the same number.
  const end = await allocateSeq(env, rows.length)
  let next = end - rows.length

  const statements = []
  for (const row of rows) {
    const kind = String(row.kind || '')
    const id = String(row.id || '')
    if (!kind || !id) continue
    let updatedAt = String(row.updated_at || nowIso)
    if (Date.parse(updatedAt) > ceiling || Number.isNaN(Date.parse(updatedAt))) updatedAt = nowIso
    const deleted = row.deleted ? 1 : 0
    const data = deleted ? null : typeof row.data === 'string' ? row.data : JSON.stringify(row.data)
    next += 1
    statements.push(
      env.DB.prepare(
        `INSERT INTO sync_rows (kind, id, seq, updated_at, deleted, device, data)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (kind, id) DO UPDATE SET
           seq        = excluded.seq,
           updated_at = excluded.updated_at,
           deleted    = excluded.deleted,
           device     = excluded.device,
           data       = excluded.data
         WHERE excluded.updated_at >= sync_rows.updated_at`
      ).bind(kind, id, next, updatedAt, deleted, device, data)
    )
  }

  if (statements.length > 0) await env.DB.batch(statements)

  // And what they look like now.
  //
  // Re-read rather than assuming the pushed row won: the INSERT above carries a
  // last-write-wins guard, so a laptop that has been offline for a week can push
  // a stale punch that is correctly refused. Comparing against what is actually
  // STORED means a refused write sends no notification, and it means pushing the
  // same batch twice — which retries do — is silent the second time.
  if (timeIds.length > 0) {
    const after = await readTimeEntries(env, timeIds)
    const events = []
    for (const id of timeIds) {
      const kind = clockTransition(before.get(id) || null, after.get(id) || null)
      if (kind) events.push({ kind, entry: after.get(id) })
    }
    if (events.length > 0) {
      await scheduleAfterResponse(ctx, () => notifyClockEvents(env, events))
    }
  }

  return json({ ok: true, accepted: statements.length, cursor: end })
}

/** The stored time_entries rows for a set of ids, parsed, keyed by id. */
async function readTimeEntries(env, ids) {
  const found = new Map()
  if (!ids || ids.length === 0) return found
  // Bound the IN list rather than expanding it to whatever a caller sent: a push
  // may carry 500 rows, and D1 has a limit on bound parameters per statement.
  const unique = [...new Set(ids)].slice(0, MAX_PUSH_ROWS)
  const marks = unique.map((_, i) => '?' + (i + 1)).join(', ')
  const result = await env.DB.prepare(
    'SELECT id, deleted, data FROM sync_rows WHERE kind = ' +
      "'time_entries'" +
      ' AND id IN (' +
      marks +
      ')'
  )
    .bind(...unique)
    .all()
  for (const row of result.results || []) {
    if (row.deleted) continue
    try {
      found.set(String(row.id), JSON.parse(row.data))
    } catch {
      // A row that will not parse is not an entry.
    }
  }
  return found
}

/**
 * Hand back everything after the caller's cursor.
 *
 * `device` lets a laptop skip the echo of its own push. It is an optimisation,
 * not a correctness requirement — applying your own row again is harmless — but
 * it halves the traffic on a busy machine.
 */
async function pull(url, env) {
  const since = Number(url.searchParams.get('since') || 0) || 0
  const limit = Math.min(Number(url.searchParams.get('limit') || 500) || 500, MAX_PULL_ROWS)
  const device = url.searchParams.get('device') || ''

  const result = await env.DB.prepare(
    `SELECT kind, id, seq, updated_at, deleted, data
     FROM sync_rows
     WHERE seq > ?1 AND (?2 = '' OR device IS NULL OR device <> ?2)
     ORDER BY seq ASC LIMIT ?3`
  )
    .bind(since, device, limit)
    .all()

  const rows = result.results || []
  let cursor
  if (rows.length > 0) {
    cursor = Number(rows[rows.length - 1].seq)
  } else {
    // Nothing to deliver. Advance past the caller's own echo rows so they are
    // not re-examined every round forever — but only as far as a row that is
    // actually COMMITTED in the table. Jumping to the counter instead could
    // step over rows from a push that has reserved its numbers and not yet
    // written them, and those rows would never be delivered to this laptop.
    const head = await env.DB.prepare(
      `SELECT COALESCE(MAX(seq), ?1) AS s FROM sync_rows WHERE seq > ?1`
    )
      .bind(since)
      .first()
    cursor = Number(head.s)
  }
  const more = rows.length === limit
  return json({ ok: true, rows, cursor, more })
}

/**
 * Wipe the log. Used once, when seeding the relay from the laptop that holds the
 * real data — otherwise a half-seeded relay from an abandoned attempt would hand
 * partial rows to everyone.
 *
 * Requires the key AND an explicit confirmation string, because it is the only
 * destructive route here.
 */
async function reset(request, env) {
  const body = await readJson(request)
  if (body.confirm !== 'ERASE-RELAY') {
    return json({ ok: false, error: 'Send { "confirm": "ERASE-RELAY" } to wipe the relay.' }, 400)
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sync_rows'),
    env.DB.prepare('UPDATE sync_seq SET value = 0 WHERE id = 1')
  ])
  return json({ ok: true, wiped: true })
}

// ---------------------------------------------------------------------------
// Job 2 — the public intake form
// ---------------------------------------------------------------------------

/**
 * Look up the link this token belongs to.
 *
 * Read straight out of sync_rows, because the laptops already pushed the
 * intake_links rows there as part of ordinary sync. The Worker needs no table of
 * its own and no admin screen: staff create a link in the app, and it is live as
 * soon as that laptop's next push lands.
 */
const TOKEN_RE = /^[A-Za-z0-9]{16,64}$/

async function findLink(env, token) {
  // Validated before it reaches SQL. Restricting the alphabet is also what
  // makes the LIKE below safe: there is no % or _ to smuggle in.
  if (!TOKEN_RE.test(token || '')) return null
  const result = await env.DB.prepare(
    `SELECT data FROM sync_rows
     WHERE kind = 'intake_links' AND deleted = 0 AND data LIKE ?1
     LIMIT 5`
  )
    .bind(`%"token":"${token}"%`)
    .all()
  for (const row of result.results || []) {
    try {
      // The LIKE narrows; the parse decides. A substring match is not proof the
      // token is this row's token rather than text inside some other field.
      const link = JSON.parse(row.data)
      if (link && link.token === token) return link
    } catch {
      // A row that will not parse is not a link.
    }
  }
  return null
}

async function intakeForm(env, token) {
  const link = await findLink(env, token)
  const brand = env.BRAND || 'RM Cardz'
  if (!link || !link.active) {
    return html(page(brand, closedBody(brand)), 404)
  }
  return html(page(brand, formBody(brand, link, token)))
}

async function intakeSubmit(request, env, token) {
  const link = await findLink(env, token)
  if (!link || !link.active) {
    return json({ ok: false, error: 'This form is closed.' }, 404)
  }

  const contentType = request.headers.get('content-type') || ''
  let fields
  if (contentType.includes('application/json')) {
    fields = await readJson(request)
  } else {
    const form = await request.formData()
    fields = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]))
  }

  // A field no human sees and no human fills in. Bots fill in everything, so a
  // value here is a bot, and a bot is answered with a cheerful 200 rather than
  // an error that tells it to try differently.
  if (String(fields.website || '').trim()) {
    return json({ ok: true, received: true })
  }

  const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max)
  const handle = clean(fields.handle, 80)
  const realName = clean(fields.real_name, 120)
  if (!handle && !realName) {
    return json({ ok: false, error: 'Enter your Whatnot handle or your name.' }, 400)
  }

  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  const record = {
    id,
    link_id: clean(link.id, 60),
    token: clean(token, 120),
    handle,
    real_name: realName,
    email: clean(fields.email, 160),
    phone: clean(fields.phone, 40),
    address1: clean(fields.address1, 160),
    address2: clean(fields.address2, 160),
    city: clean(fields.city, 80),
    state: clean(fields.state, 40),
    postal_code: clean(fields.postal_code, 20),
    country: clean(fields.country, 40) || 'US',
    request: clean(fields.request, 2000),
    status: 'new',
    status_note: null,
    customer_id: null,
    reviewed_at: null,
    reviewed_by: null,
    created_at: now,
    updated_at: now
  }

  const seq = await allocateSeq(env, 1)
  await env.DB.prepare(
    `INSERT INTO sync_rows (kind, id, seq, updated_at, deleted, device, data)
     VALUES ('intake_submissions', ?1, ?2, ?3, 0, 'public-form', ?4)`
  )
    .bind(id, seq, now, JSON.stringify(record))
    .run()

  const accept = request.headers.get('accept') || ''
  if (accept.includes('application/json')) return json({ ok: true, id })
  const brand = env.BRAND || 'RM Cardz'
  return html(page(brand, thanksBody(brand, realName || handle)))
}

// ---------------------------------------------------------------------------
// Job 3 — the staff clock
// ---------------------------------------------------------------------------

/**
 * A phone, a six-digit PIN, and two buttons.
 *
 * ## Why this can exist at all without new machinery
 *
 * `employees` and `time_entries` are both in the app's sync manifest, so every
 * employee row and every punch is ALREADY in this database — the laptops put
 * them there. The portal reads those rows and writes new ones in exactly the
 * same shape, which means a punch made on a phone reaches the laptops through
 * the pull every one of them is already doing. There is no portal database, no
 * second copy of a timesheet, and nothing to reconcile.
 *
 * ## Why a PIN and not the app password
 *
 * The passwords are bcrypt at cost 12 and this Worker is on the free plan,
 * where an invocation is killed after 10ms of CPU — perhaps a thirtieth of what
 * one bcrypt verification needs. So an employee gets a separate PIN, hashed
 * with PBKDF2 through native WebCrypto, set from the desktop app. The app
 * password is never sent here and cannot be discovered from here.
 *
 * ## What actually protects a six-digit PIN
 *
 * Not the hash. A million candidates is a small number and no iteration count
 * this Worker can afford would change that. What protects it is `portal_lockout`
 * below: wrong tries are counted in the database, so the limit holds across
 * every Worker instance and every phone, and a locked account stops answering
 * for a while. Somebody guessing gets a handful of attempts an hour, not a
 * million.
 *
 * The trade that comes with it, stated rather than hidden: a person who knows a
 * company ID can deliberately lock that employee out of the WEB clock for
 * fifteen minutes. They cannot touch the desktop app, which is where the work
 * is run from, and the window is short on purpose for exactly this reason.
 */

const CLOCK_COOKIE = 'rmclock'
const CLOCK_SESSION_MS = 12 * 60 * 60 * 1000
const CLOCK_MAX_FAILS = 5
const CLOCK_LOCK_MS = 15 * 60 * 1000
/** How far back the timesheet reaches. Two weeks covers "did I get paid right". */
const CLOCK_MAX_WEEKS = 8

const enc = new TextEncoder()

/**
 * The lockout table, created on first use.
 *
 * Deliberately NOT in schema.sql: that file is pasted into the D1 console by
 * hand, and a portal that only works after somebody remembers a second paste is
 * a portal that appears broken. This is Worker-local operational state — it is
 * not a sync row, it never reaches a laptop, and losing it entirely would cost
 * nothing but a reset counter.
 */
let lockoutReady = false
async function ensureLockoutTable(env) {
  if (lockoutReady) return
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS portal_lockout (
       employee_id  TEXT PRIMARY KEY,
       fails        INTEGER NOT NULL DEFAULT 0,
       locked_until TEXT
     )`
  ).run()
  lockoutReady = true
}

function bytesFromBase64(s) {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function base64FromBytes(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/**
 * Read a stored PIN hash.
 *
 * The format is `pbkdf2$sha256$<iterations>$<salt-b64>$<hash-b64>` and every
 * parameter travels inside it, which is the point: this Worker needs no shared
 * constant with the app and no redeploy when the app changes its iteration
 * count. It verifies whatever it is handed, on that hash's own terms.
 *
 * The mirror of this lives in the app at src/shared/portalPin.ts, and a test
 * there hashes a PIN with the app and verifies it with THIS function, so the
 * two cannot drift.
 */
function parsePinHash(stored) {
  if (!stored || typeof stored !== 'string') return null
  const parts = stored.split('$')
  if (parts.length !== 5) return null
  if (parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return null
  const iterations = Number(parts[2])
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 5000000) return null
  try {
    const salt = bytesFromBase64(parts[3])
    const hash = bytesFromBase64(parts[4])
    if (!salt.length || !hash.length) return null
    return { iterations, salt, hash }
  } catch {
    return null
  }
}

export async function verifyPortalPin(stored, pin) {
  const parsed = parsePinHash(stored)
  if (!parsed) return false
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: parsed.salt, iterations: parsed.iterations },
    key,
    parsed.hash.length * 8
  )
  return equalBytes(new Uint8Array(bits), parsed.hash)
}

/**
 * The key that signs session cookies.
 *
 * Derived from SHARED_KEY rather than being the key itself, and rather than
 * being a second secret somebody has to remember to set. Derivation means a
 * signed cookie can never be replayed as a bearer token even if the signature
 * scheme were misused, and rotating the shared key invalidates every session,
 * which is the behaviour you want from rotating it.
 */
async function sessionKey(env) {
  const base = env.SHARED_KEY || env.CLINIC_KEY || ''
  const seed = await crypto.subtle.importKey('raw', enc.encode(base), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const derived = await crypto.subtle.sign('HMAC', seed, enc.encode('rmops-portal-session-v1'))
  return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

async function mintSession(env, employeeId) {
  const expires = Date.now() + CLOCK_SESSION_MS
  const body = `${employeeId}.${expires}`
  const key = await sessionKey(env)
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body))
  return `${body}.${base64FromBytes(new Uint8Array(sig))}`
}

async function readSession(request, env) {
  const cookie = request.headers.get('cookie') || ''
  const hit = cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${CLOCK_COOKIE}=`))
  if (!hit) return null
  const raw = decodeURIComponent(hit.slice(CLOCK_COOKIE.length + 1))
  const cut = raw.lastIndexOf('.')
  if (cut < 0) return null
  const body = raw.slice(0, cut)
  const sigText = raw.slice(cut + 1)
  const dot = body.indexOf('.')
  if (dot < 0) return null
  const employeeId = body.slice(0, dot)
  const expires = Number(body.slice(dot + 1))
  if (!employeeId || !Number.isFinite(expires) || Date.now() > expires) return null
  try {
    const key = await sessionKey(env)
    const ok = await crypto.subtle.verify('HMAC', key, bytesFromBase64(sigText), enc.encode(body))
    return ok ? employeeId : null
  } catch {
    return null
  }
}

function cookieHeader(value, maxAgeSeconds) {
  // Path is the whole portal and nothing else, so this cookie is never attached
  // to a sync request. HttpOnly because no script here needs to read it, and a
  // token a script cannot read is a token an injected script cannot steal.
  return `${CLOCK_COOKIE}=${encodeURIComponent(value)}; Path=/clock; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`
}

/** One employee, straight out of the synced rows. Null if there is no such person. */
async function employeeByCompanyId(env, companyId) {
  const row = await env.DB.prepare(
    `SELECT data FROM sync_rows
      WHERE kind = 'employees' AND deleted = 0
        AND lower(json_extract(data, '$.company_id')) = lower(?1)
      LIMIT 1`
  )
    .bind(companyId)
    .first()
  if (!row || !row.data) return null
  try {
    return JSON.parse(row.data)
  } catch {
    return null
  }
}

async function employeeById(env, id) {
  const row = await env.DB.prepare(
    `SELECT data FROM sync_rows WHERE kind = 'employees' AND id = ?1 AND deleted = 0`
  )
    .bind(id)
    .first()
  if (!row || !row.data) return null
  try {
    return JSON.parse(row.data)
  } catch {
    return null
  }
}

/**
 * May this person use the portal at all?
 *
 * Three separate refusals, and they are all the same answer to the caller. A
 * portal that says "that company ID exists but has no PIN" has told an
 * anonymous caller which company IDs are real.
 *
 * ## Not 'active' — NOT DISABLED. The difference cost a real shift.
 *
 * This asked for `status === 'active'`, which sounds like the careful choice and
 * is the wrong one. An employee created with an email address starts 'invited'
 * and only becomes 'active' when they sign into the DESKTOP APP and choose a
 * password (see `insertEmployee` and `setChosenPassword`). A new hire who was
 * given a PIN and sent to the warehouse has never opened the desktop app — so
 * they were refused, and told their PIN was wrong, which is a lie that leads
 * somebody to type it again.
 *
 * The PIN is a SEPARATE credential. That is the entire design: it exists so
 * clocking in does not depend on the app password, and gating it on the app
 * password's state put the dependency straight back. An administrator setting a
 * PIN is the authorisation; nothing about the desktop is part of that decision.
 *
 * 'disabled' still refuses, and must: that is somebody deliberately switched
 * off, and `setPortalPin` refuses to arm one for exactly the same reason.
 */
function portalEligible(emp) {
  if (!emp) return false
  if (emp.status === 'disabled') return false
  if (emp.account_kind === 'station') return false
  if (!emp.portal_pin_hash) return false
  return true
}

async function lockoutFor(env, employeeId) {
  await ensureLockoutTable(env)
  const row = await env.DB.prepare(
    `SELECT fails, locked_until FROM portal_lockout WHERE employee_id = ?1`
  )
    .bind(employeeId)
    .first()
  if (!row) return { fails: 0, lockedUntil: 0 }
  return { fails: Number(row.fails) || 0, lockedUntil: row.locked_until ? Date.parse(row.locked_until) : 0 }
}

async function recordFail(env, employeeId) {
  const { fails } = await lockoutFor(env, employeeId)
  const next = fails + 1
  const lockedUntil = next >= CLOCK_MAX_FAILS ? new Date(Date.now() + CLOCK_LOCK_MS).toISOString() : null
  await env.DB.prepare(
    `INSERT INTO portal_lockout (employee_id, fails, locked_until) VALUES (?1, ?2, ?3)
     ON CONFLICT (employee_id) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until`
  )
    .bind(employeeId, next, lockedUntil)
    .run()
}

async function clearFails(env, employeeId) {
  await ensureLockoutTable(env)
  await env.DB.prepare(`DELETE FROM portal_lockout WHERE employee_id = ?1`).bind(employeeId).run()
}

/** This employee's punches, newest first. */
async function entriesFor(env, employeeId, limit) {
  const result = await env.DB.prepare(
    `SELECT id, data FROM sync_rows
      WHERE kind = 'time_entries' AND deleted = 0
        AND json_extract(data, '$.employee_id') = ?1
      ORDER BY json_extract(data, '$.clock_in') DESC
      LIMIT ?2`
  )
    .bind(employeeId, limit)
    .all()
  const out = []
  for (const row of result.results || []) {
    try {
      const e = JSON.parse(row.data)
      out.push({ id: e.id, clockIn: e.clock_in, clockOut: e.clock_out ?? null, source: e.source || 'clock' })
    } catch {
      // A row that will not parse is not an entry.
    }
  }
  return out
}

async function openEntryFor(env, employeeId) {
  const row = await env.DB.prepare(
    `SELECT id, data FROM sync_rows
      WHERE kind = 'time_entries' AND deleted = 0
        AND json_extract(data, '$.employee_id') = ?1
        AND json_extract(data, '$.clock_out') IS NULL
      ORDER BY json_extract(data, '$.clock_in') DESC
      LIMIT 1`
  )
    .bind(employeeId)
    .first()
  if (!row || !row.data) return null
  try {
    return JSON.parse(row.data)
  } catch {
    return null
  }
}

/**
 * Put a row in the log, the same way a laptop's push would.
 *
 * The LWW guard is here for the same reason it is on `push`: a clock-out edits
 * a row a laptop may also have edited, and the newer of the two has to win. The
 * portal always stamps `now`, so it beats anything written earlier and loses to
 * anything written later — which is exactly right, and is what stops a punch
 * from quietly reverting an admin's correction made a minute ago.
 */
async function writeSyncRow(env, kind, id, record) {
  const now = new Date().toISOString()
  const seq = await allocateSeq(env, 1)
  await env.DB.prepare(
    `INSERT INTO sync_rows (kind, id, seq, updated_at, deleted, device, data)
     VALUES (?1, ?2, ?3, ?4, 0, 'staff-portal', ?5)
     ON CONFLICT (kind, id) DO UPDATE SET
       seq = excluded.seq, updated_at = excluded.updated_at,
       deleted = excluded.deleted, device = excluded.device, data = excluded.data
     WHERE excluded.updated_at >= sync_rows.updated_at`
  )
    .bind(kind, id, seq, now, JSON.stringify(record))
    .run()
  return now
}

function cleanCoord(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return n
}

async function clockApi(request, env, path, ctx) {
  const route = path.slice('/clock/api/'.length)

  if (route === 'login' && request.method === 'POST') return clockLogin(request, env)
  if (route === 'logout' && request.method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': cookieHeader('', 0) })
  }

  const employeeId = await readSession(request, env)
  if (!employeeId) return json({ ok: false, error: 'Sign in again.' }, 401)
  const emp = await employeeById(env, employeeId)
  // Re-checked on EVERY request, not just at login. Somebody disabled at 2pm
  // must stop being able to punch at 2pm, not when their twelve hours run out.
  if (!portalEligible(emp)) {
    return json({ ok: false, error: 'This account can no longer clock in here.' }, 403, {
      'set-cookie': cookieHeader('', 0)
    })
  }

  if (route === 'session' && request.method === 'GET') return clockSession(env, emp)
  if (route === 'punch' && request.method === 'POST') return clockPunch(request, env, emp, ctx)
  if (route === 'timesheet' && request.method === 'GET') return clockTimesheet(request, env, emp)
  return json({ ok: false, error: 'Not found.' }, 404)
}

async function clockLogin(request, env) {
  const body = await readJson(request)
  const companyId = String(body.companyId || '').trim().slice(0, 60)
  const pin = String(body.pin || '').trim()

  // ONE message for every way this can fail. Anything more specific tells an
  // anonymous caller which company IDs are real and which of them have a PIN.
  const refuse = () => json({ ok: false, error: 'That company ID or PIN is not right.' }, 401)

  if (!companyId || !/^[0-9]{6}$/.test(pin)) return refuse()

  const emp = await employeeByCompanyId(env, companyId)
  if (!portalEligible(emp)) {
    // Still costs a moment, so a missing account is not obviously faster than a
    // wrong PIN. Cheap, and it closes the timing channel that would otherwise
    // enumerate the staff list.
    await verifyPortalPin('pbkdf2$sha256$25000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', pin)
    return refuse()
  }

  const { lockedUntil } = await lockoutFor(env, emp.id)
  if (lockedUntil && lockedUntil > Date.now()) {
    const mins = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 60000))
    return json(
      { ok: false, error: `Too many wrong PINs. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` },
      429
    )
  }

  const good = await verifyPortalPin(emp.portal_pin_hash, pin)
  if (!good) {
    await recordFail(env, emp.id)
    return refuse()
  }

  await clearFails(env, emp.id)
  const token = await mintSession(env, emp.id)
  return json({ ok: true, name: `${emp.first_name || ''} ${emp.last_name || ''}`.trim() }, 200, {
    'set-cookie': cookieHeader(token, Math.floor(CLOCK_SESSION_MS / 1000))
  })
}

async function clockSession(env, emp) {
  const open = await openEntryFor(env, emp.id)
  return json({
    ok: true,
    name: `${emp.first_name || ''} ${emp.last_name || ''}`.trim(),
    companyId: emp.company_id || '',
    open: open ? { id: open.id, clockIn: open.clock_in } : null
  })
}

/**
 * One button, and the row decides which way it goes.
 *
 * Deliberately not two endpoints. An open shift means the next press ends it and
 * a closed one means the next press starts one — read from the database at the
 * moment of the press, so a phone whose screen is out of date cannot open two
 * shifts by pressing the stale button.
 */
async function clockPunch(request, env, emp, ctx) {
  const body = await readJson(request)
  const lat = cleanCoord(body.lat)
  const lng = cleanCoord(body.lng)
  const place = String(body.place || '').trim().slice(0, 200) || null

  const open = await openEntryFor(env, emp.id)
  const now = new Date().toISOString()

  if (open) {
    const updated = {
      ...open,
      clock_out: now,
      clock_out_lat: lat,
      clock_out_lng: lng,
      clock_out_place: place
    }
    await writeSyncRow(env, 'time_entries', open.id, updated)
    // No before/after diffing needed on this path: the portal is the thing that
    // made the change, so it already knows which way the punch went.
    await scheduleAfterResponse(ctx, () =>
      notifyClockEvents(env, [{ kind: 'out', entry: updated }])
    )
    return json({ ok: true, action: 'out', at: now, entryId: open.id })
  }

  const id = crypto.randomUUID()
  const record = {
    id,
    employee_id: emp.id,
    clock_in: now,
    clock_out: null,
    note: null,
    // 'clock' is what the desktop's own punch writes. The portal is the same
    // act from a different screen, and calling it something else would split
    // one column into two meanings for no gain.
    source: 'clock',
    created_at: now,
    clock_in_lat: lat,
    clock_in_lng: lng,
    clock_in_place: place,
    clock_out_lat: null,
    clock_out_lng: null,
    clock_out_place: null
  }
  await writeSyncRow(env, 'time_entries', id, record)
  await scheduleAfterResponse(ctx, () =>
    notifyClockEvents(env, [{ kind: 'in', entry: record }])
  )
  return json({ ok: true, action: 'in', at: now, entryId: id })
}

/**
 * The punches themselves, and no arithmetic.
 *
 * Totals are worked out on the phone, on purpose. Hours belong to a LOCAL day
 * and a local week, and this Worker has no idea what timezone the person
 * holding the phone is in — the browser does, exactly and for free. Summing
 * here would mean guessing a timezone, and a guess that is wrong puts a Sunday
 * night shift in the wrong week on a payroll screen.
 */
async function clockTimesheet(request, env, emp) {
  const url = new URL(request.url)
  const weeks = Math.min(Math.max(Number(url.searchParams.get('weeks') || 2) || 2, 1), CLOCK_MAX_WEEKS)
  // Generous: enough rows to cover the window even for somebody punching in and
  // out several times a day, and bounded so one query cannot run away.
  const entries = await entriesFor(env, emp.id, Math.min(weeks * 40, 400))
  return json({ ok: true, weeks, entries })
}

/**
 * The whole portal, as one page.
 *
 * Served with no session check: the page itself is not a secret, and it asks
 * the API who you are the moment it loads. That keeps the sign-in state in ONE
 * place — the signed cookie the API checks on every call — rather than having
 * the HTML and the API each hold an opinion about it.
 *
 * Everything is inline. No fonts, no framework, no CDN: this gets opened on a
 * phone on warehouse wifi, and a clock that will not load because a stylesheet
 * timed out is a clock nobody uses twice.
 */
function clockPage(env) {
  const brand = env.BRAND || 'RM Cardz'
  return clockHtml(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#12141a">
<title>${esc(brand)} — Time clock</title>
<style>
  :root { color-scheme: light dark; --bg:#f5f6f8; --card:#fff; --ink:#16181d; --muted:#5b6270;
          --line:#dfe3ea; --accent:#1e63d0; --good:#13804a; --good-bg:#e6f5ed; --bad:#b3261e; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#12141a; --card:#1b1e26; --ink:#eceef3; --muted:#9aa3b4; --line:#2c313d;
            --accent:#5b96f5; --good:#54c48c; --good-bg:#16301f; --bad:#f2857c; }
  }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  body { margin:0; background:var(--bg); color:var(--ink); padding:20px 16px 56px;
         font:16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { max-width:460px; margin:0 auto; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:22px; }
  h1 { font-size:20px; margin:0 0 2px; letter-spacing:-.01em; }
  .sub { color:var(--muted); margin:0 0 20px; font-size:13.5px; }
  label { display:block; font-size:13px; font-weight:650; margin:14px 0 6px; }
  input { width:100%; padding:13px 12px; font:inherit; color:inherit; background:var(--bg);
          border:1px solid var(--line); border-radius:10px; }
  input:focus { outline:2px solid var(--accent); outline-offset:1px; border-color:var(--accent); }
  /* A PIN is digits. Big, spaced, and the phone shows a number pad. */
  #pin { font-size:26px; letter-spacing:.42em; text-align:center; padding:15px 12px; font-variant-numeric:tabular-nums; }
  button { width:100%; padding:15px; font:inherit; font-weight:650; border-radius:11px;
           border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; }
  button:disabled { opacity:.55; cursor:default; }
  button.ghost { background:transparent; color:var(--muted); border-color:var(--line); font-weight:550; }
  .punch { margin-top:18px; padding:22px; font-size:19px; }
  .punch.out { background:var(--bad); border-color:var(--bad); }
  .status { margin:18px 0 0; padding:14px 16px; border-radius:12px; background:var(--bg);
            border:1px solid var(--line); }
  .status.on { background:var(--good-bg); border-color:var(--good); }
  .status b { display:block; font-size:15px; }
  .status span { color:var(--muted); font-size:13.5px; }
  .err { margin:14px 0 0; color:var(--bad); font-size:13.5px; min-height:1.2em; }
  .who { display:flex; align-items:baseline; justify-content:space-between; gap:10px; margin-bottom:16px; }
  .who b { font-size:17px; }
  .who a { color:var(--muted); font-size:13px; text-decoration:none; border-bottom:1px solid var(--line); cursor:pointer; }
  .sheet { margin-top:22px; }
  .sheet h2 { font-size:14px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:0 0 10px; }
  .wk { border:1px solid var(--line); border-radius:12px; overflow:hidden; margin-bottom:12px; }
  .wk-h { display:flex; justify-content:space-between; padding:9px 13px; background:var(--bg);
          border-bottom:1px solid var(--line); font-size:13px; }
  .wk-h b { font-variant-numeric:tabular-nums; }
  .day { padding:9px 13px; border-top:1px solid var(--line); font-size:13.5px; }
  .day:first-child { border-top:none; }
  .day-h { display:flex; justify-content:space-between; font-weight:600; }
  .day-h span { font-variant-numeric:tabular-nums; color:var(--muted); font-weight:500; }
  .punchrow { color:var(--muted); font-size:12.5px; font-variant-numeric:tabular-nums; }
  .open { color:var(--good); font-weight:600; }
  .empty { color:var(--muted); font-size:13.5px; padding:6px 0 2px; }
  .hide { display:none !important; }
</style>
</head><body>
<main>
  <section class="card" id="login">
    <h1>${esc(brand)}</h1>
    <p class="sub">Clock in and out, and check your hours.</p>
    <label for="cid">Company ID</label>
    <input id="cid" autocomplete="username" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="RM-001">
    <label for="pin">6-digit PIN</label>
    <input id="pin" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" placeholder="******">
    <p class="err" id="loginErr"></p>
    <button id="go">Sign in</button>
  </section>

  <section class="card hide" id="home">
    <div class="who"><b id="name"></b><a id="out">Sign out</a></div>
    <div class="status" id="status"><b>—</b><span></span></div>
    <button class="punch" id="punch">Clock in</button>
    <p class="err" id="punchErr"></p>
    <div class="sheet">
      <h2>Your timesheet</h2>
      <div id="sheet"><p class="empty">Loading…</p></div>
    </div>
  </section>
</main>
<script>
${clockScript()}
</script>
</body></html>`)
}

/**
 * The page's behaviour.
 *
 * Two things are worth knowing about it. Location is asked for but never
 * insisted on — the punch fires whether the browser answers, refuses or takes
 * too long, because a shift that cannot be started because somebody declined a
 * permission prompt is a worse outcome than a shift with no coordinates.
 *
 * And all the arithmetic is here rather than in the Worker. Hours belong to a
 * local day and a local week; the phone knows its own timezone exactly, and the
 * Worker would have to guess.
 */
function clockScript() {
  return `
const $ = (id) => document.getElementById(id)
const api = async (path, opts) => {
  const r = await fetch('/clock/api/' + path, Object.assign({ headers: { 'content-type': 'application/json' } }, opts))
  let body = {}
  try { body = await r.json() } catch (e) {}
  return { status: r.status, body }
}
let state = null

function fmtClock(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
function fmtHours(mins) {
  const h = Math.floor(mins / 60), m = Math.round(mins % 60)
  return h + 'h ' + String(m).padStart(2, '0') + 'm'
}
function dayKey(iso) {
  const d = new Date(iso)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}
// Weeks start Monday, which is how a pay week is usually read and is not what
// getDay() gives you on a Sunday.
function weekStart(iso) {
  const d = new Date(iso)
  d.setHours(0, 0, 0, 0)
  const back = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - back)
  return d
}

function render() {
  $('login').classList.toggle('hide', !!state)
  $('home').classList.toggle('hide', !state)
  if (!state) return
  $('name').textContent = state.name || state.companyId || 'Signed in'
  const open = state.open
  const st = $('status')
  st.classList.toggle('on', !!open)
  st.querySelector('b').textContent = open ? 'On the clock' : 'Not clocked in'
  st.querySelector('span').textContent = open
    ? 'Since ' + fmtClock(open.clockIn) + ' — ' + fmtHours((Date.now() - Date.parse(open.clockIn)) / 60000) + ' so far'
    : 'Press the button when you start.'
  const b = $('punch')
  b.textContent = open ? 'Clock out' : 'Clock in'
  b.classList.toggle('out', !!open)
}

function renderSheet(entries) {
  const box = $('sheet')
  if (!entries.length) { box.innerHTML = '<p class="empty">No shifts recorded yet.</p>'; return }
  const weeks = new Map()
  for (const e of entries) {
    const ws = weekStart(e.clockIn)
    const wk = ws.getTime()
    if (!weeks.has(wk)) weeks.set(wk, { start: ws, days: new Map(), mins: 0 })
    const w = weeks.get(wk)
    const dk = dayKey(e.clockIn)
    if (!w.days.has(dk)) w.days.set(dk, { date: new Date(e.clockIn), mins: 0, punches: [] })
    const d = w.days.get(dk)
    // An open shift shows its punch but adds no minutes. Counting time that has
    // not been worked yet would make today's total drift upward all afternoon
    // and never match what payroll pays.
    const mins = e.clockOut ? (Date.parse(e.clockOut) - Date.parse(e.clockIn)) / 60000 : 0
    d.mins += mins; w.mins += mins
    d.punches.push(e)
  }
  const parts = []
  for (const w of [...weeks.values()].sort((a, b) => b.start - a.start)) {
    const label = w.start.toLocaleDateString([], { month: 'short', day: 'numeric' })
    const end = new Date(w.start); end.setDate(end.getDate() + 6)
    parts.push('<div class="wk"><div class="wk-h"><span>' + label + ' – ' +
      end.toLocaleDateString([], { month: 'short', day: 'numeric' }) + '</span><b>' + fmtHours(w.mins) + '</b></div>')
    for (const d of [...w.days.values()].sort((a, b) => b.date - a.date)) {
      parts.push('<div class="day"><div class="day-h">' +
        d.date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) +
        '<span>' + fmtHours(d.mins) + '</span></div>')
      for (const p of d.punches.sort((a, b) => Date.parse(a.clockIn) - Date.parse(b.clockIn))) {
        parts.push('<div class="punchrow">' + fmtClock(p.clockIn) + ' – ' +
          (p.clockOut ? fmtClock(p.clockOut) : '<span class="open">still on</span>') + '</div>')
      }
      parts.push('</div>')
    }
    parts.push('</div>')
  }
  box.innerHTML = parts.join('')
}

async function loadSheet() {
  const r = await api('timesheet?weeks=4')
  if (r.body && r.body.ok) renderSheet(r.body.entries || [])
}

async function refresh() {
  const r = await api('session')
  state = r.body && r.body.ok ? r.body : null
  render()
  if (state) loadSheet()
}

/** Best effort, with a deadline. A prompt nobody answers must not hang the punch. */
function locate() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({})
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    setTimeout(() => finish({}), 6000)
    navigator.geolocation.getCurrentPosition(
      (p) => finish({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => finish({}),
      { enableHighAccuracy: false, timeout: 5500, maximumAge: 120000 }
    )
  })
}

$('go').onclick = async () => {
  $('loginErr').textContent = ''
  const companyId = $('cid').value.trim()
  const pin = $('pin').value.trim()
  if (!companyId || !/^[0-9]{6}$/.test(pin)) { $('loginErr').textContent = 'Enter your company ID and your six-digit PIN.'; return }
  $('go').disabled = true
  try {
    const r = await api('login', { method: 'POST', body: JSON.stringify({ companyId, pin }) })
    if (!r.body.ok) { $('loginErr').textContent = r.body.error || 'That did not work.'; return }
    $('pin').value = ''
    await refresh()
  } catch (e) {
    $('loginErr').textContent = 'No connection. Try again.'
  } finally {
    $('go').disabled = false
  }
}
$('pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('go').click() })

$('punch').onclick = async () => {
  $('punchErr').textContent = ''
  $('punch').disabled = true
  const was = $('punch').textContent
  $('punch').textContent = 'Working…'
  try {
    const where = await locate()
    const r = await api('punch', { method: 'POST', body: JSON.stringify(where) })
    if (!r.body.ok) { $('punchErr').textContent = r.body.error || 'That did not save.'; $('punch').textContent = was; return }
    await refresh()
  } catch (e) {
    $('punchErr').textContent = 'No connection — nothing was recorded. Try again.'
    $('punch').textContent = was
  } finally {
    $('punch').disabled = false
  }
}

$('out').onclick = async () => { await api('logout', { method: 'POST' }); state = null; render() }

refresh()
// Keeps "2h 14m so far" honest without a reload.
setInterval(() => { if (state && state.open) render() }, 30000)
`
}

function clockHtml(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // Its own policy, one step looser than the intake form's: this page has
      // behaviour, so it needs its inline script and it needs to call back here.
      // Everything else stays shut — no remote script, no remote style, no
      // frame, and nowhere for an injected script to send anything.
      'content-security-policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        "connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff'
    }
  })
}

// ---------------------------------------------------------------------------
// Job 4 — clock-in push notifications
// ---------------------------------------------------------------------------

/**
 * Real W3C Web Push, signed and encrypted right here.
 *
 * ## Why not ntfy, Discord, Pushover or an email
 *
 * Because every one of them means handing a third party a stream that reads
 * "Dana Whitfield started work at 07:58" — who works here, what hours they keep,
 * and on bad days what they were doing at 2am. That is the company's payroll
 * shape sitting in somebody else's database forever, in exchange for saving an
 * afternoon. So the notification goes from this Worker straight to the browser
 * vendor's push service and nowhere else, and the vendor sees an ENCRYPTED blob
 * addressed to one device. The name is not in it in any form they can read.
 *
 * That is the entire reason the aes128gcm code below exists rather than a
 * payload-less "something happened" ping. A payload-less push would be private
 * too, but it would tell the phone nothing, and the service worker would have to
 * call back for the detail — which is a network round trip that fails exactly
 * when the phone is asleep, which is always.
 *
 * ## Why the WORKER sends and not the app
 *
 * Punches arrive from at least three places: the desktop app on any of several
 * machines, the web app on Render, and the /clock portal above. A sender living
 * in the Electron app only fires when that particular machine is awake, so the
 * 7am shift — nobody at a desk yet — would silently never notify. The relay sees
 * every one of those paths, because they all end as a row in sync_rows.
 *
 * ## What the crypto is, in the order it happens
 *
 * Per push:
 *   1. VAPID (RFC 8292): an ES256 JWT proving the sender is us, so a push
 *      service will accept the request at all.
 *   2. aes128gcm (RFC 8291 + RFC 8188): ECDH against the phone's public key plus
 *      its auth secret, HKDF down to a content key and a nonce, AES-128-GCM.
 *
 * Both are done by hand with WebCrypto. There is no npm here — this file is
 * PASTED into the Cloudflare dashboard — so `web-push` is not an option, and a
 * bundler would be a build step the deployment story does not have.
 *
 * ## Why so much of this section is exported
 *
 * Hand-rolled crypto that nobody can run is hand-rolled crypto that is wrong.
 * The named exports below exist purely so tests/webPush.test.ts can call the
 * REAL functions — generating throwaway keys at runtime, encrypting, and then
 * decrypting the result itself to prove the bytes are what a phone will be able
 * to open. The Cloudflare runtime only ever calls the default export's fetch.
 */

/** Room for a name and a timestamp with a very great deal to spare. */
export const PUSH_RECORD_SIZE = 4096
/** One AES-GCM tag (16) plus the record delimiter (1). */
export const PUSH_MAX_PLAINTEXT = PUSH_RECORD_SIZE - 17
/**
 * How long a push service should hold a notification for a phone that is off.
 *
 * Six hours, not days. "Rhea clocked in" that arrives tomorrow morning is not
 * information, it is confusion — and a shift that started six hours ago has
 * either been noticed or stopped mattering.
 */
const PUSH_TTL_SECONDS = 6 * 60 * 60
/** RFC 8292 caps a VAPID token at 24h. Half that leaves room for clock skew. */
export const VAPID_JWT_TTL_SECONDS = 12 * 60 * 60
/** A ceiling so a bug in a client loop cannot grow this table without bound. */
const PUSH_MAX_SUBSCRIPTIONS = 500

/**
 * The PUBLIC half of the VAPID pair, in the file on purpose.
 *
 * It is not a secret in any sense: it is published to every browser that
 * subscribes, and it is derivable from any push request this Worker makes. What
 * it IS, is a value the phone and the Worker must agree on exactly — the phone
 * bakes it into the subscription, and delivery is refused if the signature does
 * not match it. Two hand-pasted copies of a 87-character string is a drift
 * waiting to happen, and the failure lands at DELIVERY: subscribing succeeds,
 * the toggle goes green, and nothing ever arrives.
 *
 * So one copy, here, served to the browser by /v1/push-notify/key rather than
 * committed a second time into the app. VAPID_PUBLIC_KEY overrides it, which is
 * what a rotation uses: set the new pair as a variable and a secret, confirm
 * pushes arrive, then move the new public half into this line.
 *
 * The PRIVATE half is a Cloudflare secret and appears nowhere in this
 * repository. This repository is public.
 */
export const VAPID_PUBLIC_KEY_DEFAULT =
  'BKqBBWG-N2QzNFKzvwIvJgavQ89ZD2yTynktJIQcgeBzkItdByFR3CCY69CQWBRlYx2B-0cVQPwlrLChcror7S8'

/**
 * Who a push service should complain to.
 *
 * Mozilla and Google both write to this address before they start throttling or
 * dropping a sender, so an address nobody reads means the first sign of trouble
 * is notifications quietly stopping.
 *
 * The FORMAT is load-bearing and unforgiving: `mailto:` immediately followed by
 * the address, no space, no angle brackets, no display name. A malformed subject
 * is rejected by some services as a 400 on the push itself — which surfaces as
 * "notifications don't arrive", never as anything naming the subject. Hence
 * VAPID_SUBJECT_RE and the loud log in vapidSubject().
 */
export const VAPID_SUBJECT_DEFAULT = 'mailto:team.rmsportscardz@gmail.com'
const VAPID_SUBJECT_RE = /^(mailto:[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+|https:\/\/[^\s<>]+)$/

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

export function b64urlFromBytes(bytes) {
  return base64FromBytes(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * base64url → bytes, tolerating standard base64 as well.
 *
 * Both alphabets turn up: the push API's keys are handed to JavaScript as
 * ArrayBuffers and whoever encodes them picks. Accepting either here is one line
 * and removes a class of "the key looks right and does not decrypt".
 */
export function bytesFromB64url(text) {
  const s = String(text || '').replace(/-/g, '+').replace(/_/g, '/')
  return bytesFromBase64(s + '='.repeat((4 - (s.length % 4)) % 4))
}

function concatBytes(...parts) {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

// ---------------------------------------------------------------------------
// The subscription table
// ---------------------------------------------------------------------------

/**
 * Created on first use, like portal_lockout above and for the same reason.
 *
 * cloud/schema.d1.sql is pasted into the D1 console by hand, and a feature that
 * only works after somebody remembers a SECOND paste is a feature that appears
 * broken — with no error to search for, because nothing errors: subscribing just
 * fails and the toggle springs back off.
 *
 * The endpoint is the PRIMARY KEY, not a surrogate id, because the endpoint IS
 * the identity of a subscription — it is the URL the push service will accept
 * deliveries at. Re-subscribing on the same phone (which browsers do on their
 * own, after a permission change, a long idle, or an app update) yields the same
 * endpoint, so the upsert refreshes the row instead of leaving a second copy
 * behind that would deliver every notification twice.
 */
let pushTableReady = false
async function ensurePushTable(env) {
  if (pushTableReady) return
  await env.DB.batch([
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS push_subscriptions (
         endpoint    TEXT PRIMARY KEY,
         employee_id TEXT NOT NULL,
         p256dh      TEXT NOT NULL,
         auth        TEXT NOT NULL,
         label       TEXT,
         created_at  TEXT NOT NULL,
         last_sent_at TEXT
       )`
    ),
    env.DB.prepare(
      'CREATE INDEX IF NOT EXISTS idx_push_subscriptions_employee ON push_subscriptions (employee_id)'
    )
  ])
  pushTableReady = true
}

/**
 * A stable, non-reversible name for a subscription.
 *
 * The endpoint itself is a bearer capability: anybody holding it can deliver a
 * notification to that phone. It therefore does not go back to a browser screen
 * that only needs to say "this device, added Tuesday" — a hash does that job and
 * cannot be replayed.
 */
async function subscriptionId(endpoint) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(String(endpoint || '')))
  return b64urlFromBytes(new Uint8Array(digest)).slice(0, 22)
}

// ---------------------------------------------------------------------------
// VAPID — proving to a push service that this sender is us
// ---------------------------------------------------------------------------

/**
 * The audience of a VAPID token is the push service's ORIGIN and nothing else.
 *
 * Not the full endpoint. A token whose `aud` carries the path is rejected, and
 * the rejection is a flat 401 from Apple or Google with no explanation — the
 * single most common way a hand-rolled implementation of this fails.
 */
export function vapidAudience(endpoint) {
  const url = new URL(String(endpoint))
  if (url.protocol !== 'https:') throw new Error('A push endpoint must be https.')
  return url.origin
}

/**
 * Rebuild a signing key from the two halves the operator pasted in.
 *
 * WebCrypto cannot import a raw EC private scalar, and it has no way to derive a
 * public key from one, so both halves have to be supplied and are stitched into
 * a JWK here. That is also why the two are stored separately and why
 * /v1/push-notify/key serves the public half rather than the app carrying its
 * own copy: two hand-pasted values that must agree are two values that will
 * eventually not, and the failure is silent — every push 401s.
 */
export async function vapidSigningKey(env) {
  if (!String(env.VAPID_PRIVATE_KEY || '').trim()) {
    throw new Error(
      'VAPID_PRIVATE_KEY is not set on this Worker, so no notification can be signed or sent. ' +
        'Cloudflare dashboard → this Worker → Settings → Variables and Secrets → Add → Secret, ' +
        'named VAPID_PRIVATE_KEY. See docs/CLOUDFLARE.md.'
    )
  }
  const priv = bytesFromB64url(env.VAPID_PRIVATE_KEY)
  const pub = bytesFromB64url(vapidPublicKey(env))
  if (priv.length !== 32) {
    throw new Error(
      'VAPID_PRIVATE_KEY is ' +
        priv.length +
        ' bytes; it must be exactly 32, base64url. This is the "privateKey" field from ' +
        '/v1/push-notify/generate-keys — not the public key and not a PEM file.'
    )
  }
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('VAPID_PUBLIC_KEY must be a 65-byte uncompressed P-256 point, base64url.')
  }
  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: b64urlFromBytes(priv),
      x: b64urlFromBytes(pub.slice(1, 33)),
      y: b64urlFromBytes(pub.slice(33, 65)),
      ext: false
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  )
}

/**
 * An ES256 JWT, built by hand.
 *
 * The one detail worth stating: WebCrypto's ECDSA output is already the raw
 * 64-byte r||s concatenation that JOSE wants. OpenSSL and most server-side
 * libraries produce a DER SEQUENCE instead, so code copied from a Node example
 * has to unwrap it. Doing that unwrapping here would corrupt a perfectly good
 * signature, and the only symptom would be a 401 from the push service.
 */
export async function signVapidJwt(signingKey, { audience, subject, expiresAtSeconds }) {
  const header = b64urlFromBytes(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const payload = b64urlFromBytes(
    enc.encode(JSON.stringify({ aud: audience, exp: expiresAtSeconds, sub: subject }))
  )
  const signingInput = `${header}.${payload}`
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signingKey,
    enc.encode(signingInput)
  )
  return `${signingInput}.${b64urlFromBytes(new Uint8Array(signature))}`
}

/** The public half: the file's copy unless a variable deliberately overrides it. */
export function vapidPublicKey(env) {
  return String((env && env.VAPID_PUBLIC_KEY) || '').trim() || VAPID_PUBLIC_KEY_DEFAULT
}

/**
 * The contact URI, validated rather than trusted.
 *
 * A subject with a space after the colon, or wrapped in angle brackets the way
 * an email client would show it, is the exact shape somebody pastes — and some
 * push services answer that with a 400 on the notification. Nothing in that
 * chain mentions the subject, so the visible symptom is "pushes stopped" with no
 * lead to follow. Checking the shape here costs one regex and turns a silent
 * outage into a line in `wrangler tail` naming the value that is wrong.
 *
 * A bad override falls back to the default rather than refusing to send: a
 * malformed contact address is a reason to shout, not a reason to leave a shift
 * unannounced.
 */
export function vapidSubject(env) {
  const configured = String((env && env.VAPID_SUBJECT) || '').trim()
  if (!configured) return VAPID_SUBJECT_DEFAULT
  if (VAPID_SUBJECT_RE.test(configured)) return configured
  console.log(
    'push: VAPID_SUBJECT is malformed (' +
      JSON.stringify(configured) +
      '). It must be exactly "mailto:someone@example.com" or an https:// URL — no space after ' +
      'the colon, no angle brackets, no display name. Falling back to ' +
      VAPID_SUBJECT_DEFAULT
  )
  return VAPID_SUBJECT_DEFAULT
}

export function vapidAuthorizationHeader(jwt, publicKeyB64url) {
  return `vapid t=${jwt}, k=${publicKeyB64url}`
}

// ---------------------------------------------------------------------------
// aes128gcm — RFC 8291 over RFC 8188
// ---------------------------------------------------------------------------

async function hmacSha256(keyBytes, messageBytes) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, messageBytes))
}

/**
 * HKDF, spelled out rather than delegated.
 *
 * Extract is HMAC(key = salt, message = input key material) and expand is
 * HMAC(key = PRK, message = info || 0x01) truncated — which is the whole of it
 * for outputs of one block or less, and every output here is. Written out
 * because the argument order of extract is the one people get backwards (the
 * SALT is the key), and because it makes each of the five derivations below
 * readable against the RFC line by line.
 */
async function hkdf(salt, ikm, info, length) {
  const prk = await hmacSha256(salt, ikm)
  const okm = await hmacSha256(prk, concatBytes(info, new Uint8Array([1])))
  return okm.slice(0, length)
}

/**
 * Encrypt one payload for one subscription.
 *
 * `serverKeys` and `salt` are injectable ONLY so the test suite can pin them and
 * compare against a decryption it performs itself; production always generates
 * both fresh. Reusing either across two pushes to the same subscription reuses
 * an AES-GCM key and nonce pair, which is the one thing GCM does not survive.
 */
export async function encryptWebPushPayload({ plaintext, p256dh, auth, serverKeys, salt }) {
  const uaPublicBytes = bytesFromB64url(p256dh)
  const authSecret = bytesFromB64url(auth)
  if (uaPublicBytes.length !== 65 || uaPublicBytes[0] !== 0x04) {
    throw new Error('p256dh must be a 65-byte uncompressed P-256 point.')
  }
  if (authSecret.length !== 16) throw new Error('The auth secret must be 16 bytes.')
  if (plaintext.length > PUSH_MAX_PLAINTEXT) {
    throw new Error(`A push payload may not exceed ${PUSH_MAX_PLAINTEXT} bytes.`)
  }

  const keys =
    serverKeys ||
    (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']))
  const asPublicBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))
  const uaPublicKey = await crypto.subtle.importKey(
    'raw',
    uaPublicBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  )
  // 256 bits: the x-coordinate of the shared point, which is what RFC 8291 calls
  // ecdh_secret. WebCrypto returns exactly that and nothing else.
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPublicKey }, keys.privateKey, 256)
  )

  const realSalt = salt || crypto.getRandomValues(new Uint8Array(16))

  // The key_info string is what BINDS the ciphertext to this exact pair of
  // keys. Getting the order wrong (ours before theirs) produces a body that
  // encrypts and transmits perfectly and that the phone silently cannot open —
  // the service worker never fires and there is nothing anywhere to read.
  const keyInfo = concatBytes(
    enc.encode('WebPush: info'),
    new Uint8Array([0]),
    uaPublicBytes,
    asPublicBytes
  )
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32)
  const cek = await hkdf(
    realSalt,
    ikm,
    concatBytes(enc.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])),
    16
  )
  const nonce = await hkdf(
    realSalt,
    ikm,
    concatBytes(enc.encode('Content-Encoding: nonce'), new Uint8Array([0])),
    12
  )

  const contentKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, [
    'encrypt'
  ])
  // 0x02 is the RFC 8188 delimiter meaning "last record". 0x01 would mean
  // another record follows, and a receiver told to expect one that never comes
  // treats the whole message as truncated.
  const padded = concatBytes(plaintext, new Uint8Array([2]))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, contentKey, padded)
  )

  const header = new Uint8Array(21)
  header.set(realSalt, 0)
  // Record size, big-endian. It describes the maximum record, not this one.
  header[16] = (PUSH_RECORD_SIZE >>> 24) & 0xff
  header[17] = (PUSH_RECORD_SIZE >>> 16) & 0xff
  header[18] = (PUSH_RECORD_SIZE >>> 8) & 0xff
  header[19] = PUSH_RECORD_SIZE & 0xff
  header[20] = asPublicBytes.length
  return concatBytes(header, asPublicBytes, ciphertext)
}

// ---------------------------------------------------------------------------
// What a clock event is, and what it says
// ---------------------------------------------------------------------------

/**
 * Did this row change from "no shift" to "shift open", or from open to closed?
 *
 * Everything else is not a punch and must not notify: a note edited on a shift
 * from last week, an admin correcting yesterday's finish time, a laptop
 * re-pushing rows it already pushed, or the echo of a row another machine wrote
 * a second ago. Returning null for all of those is what makes this idempotent —
 * and idempotence is not a nicety here, because the sync loop retries pushes on
 * any error and ten laptops each pull the same row.
 */
export function clockTransition(before, after) {
  if (!after || !after.clock_in) return null
  const wasOpen = !!before && !!before.clock_in && !before.clock_out
  const isOpen = !after.clock_out
  if (!before && isOpen) return 'in'
  if (wasOpen && !isOpen) return 'out'
  return null
}

/**
 * What actually travels to the phone.
 *
 * `at` is a UTC ISO INSTANT and is passed through untouched. This Worker has no
 * idea what timezone the person holding the phone is in — the phone knows,
 * exactly and for free — so the service worker formats it and this does not. The
 * same reasoning as clockTimesheet above: a wall-clock time computed on a guess
 * is a wrong time on somebody's screen, and here it would be a wrong time in a
 * notification about when a colleague started work.
 *
 * The name is deliberately IN the payload. It is readable only by the phone this
 * was encrypted for; the push service carries ciphertext. Putting it here rather
 * than having the phone look it up is what lets the notification arrive while
 * the device is asleep and the app is not running.
 */
export function buildClockPayload({ kind, name, at, place }) {
  return {
    v: 1,
    kind: kind === 'out' ? 'out' : 'in',
    name: String(name || 'Someone').slice(0, 80),
    at: String(at || new Date().toISOString()),
    place: place ? String(place).slice(0, 60) : null
  }
}

/**
 * A subscription that answered 404 or 410 is GONE — the browser was uninstalled,
 * the user cleared site data, or the push service retired the endpoint. Nothing
 * will ever be delivered to it again.
 *
 * Deleting it immediately is the difference between a table of live phones and a
 * table of corpses. Every send walks every row, so a relay that keeps them
 * spends longer and longer per punch doing TLS handshakes with services that
 * will only ever say 410 — and it never recovers on its own, because nothing
 * else in the system has any reason to look at this table.
 *
 * Every OTHER failure is kept. A 500 from Apple, a 429, a timeout: those are the
 * service having a bad minute, and dropping a real phone because of one is a
 * person who quietly stops getting notifications and has no way to know.
 */
export function isDeadPushStatus(status) {
  return status === 404 || status === 410
}

/**
 * Walk the subscriptions, send, and reap the dead ones.
 *
 * The sending, the deleting and the "this one worked" note are all injected so
 * this — the part with the rules in it — can be tested without a network or a
 * database. Sequential rather than parallel on purpose: a Worker has a
 * subrequest budget per invocation, and a burst of parallel fetches to three
 * different push services is the shape that hits it. Ten phones at a couple of
 * hundred milliseconds each is well inside the time a waitUntil is allowed to
 * take.
 *
 * `touch` is optional and its failure is swallowed. It records when a device was
 * last successfully sent to, which is what lets somebody look at their own list
 * of phones and see that one of them stopped weeks ago — but it is bookkeeping,
 * and a bookkeeping write that fails must never turn a delivered notification
 * into a failed one.
 */
export async function deliverPush({ subscriptions, send, drop, touch }) {
  const result = { sent: 0, dropped: 0, failed: 0 }
  for (const subscription of subscriptions) {
    let status
    try {
      status = await send(subscription)
    } catch {
      // A thrown fetch is a network fault, not evidence about the subscription.
      result.failed += 1
      continue
    }
    if (isDeadPushStatus(status)) {
      await drop(subscription.endpoint)
      result.dropped += 1
      continue
    }
    if (status >= 200 && status < 300) {
      result.sent += 1
      if (touch) {
        try {
          await touch(subscription.endpoint)
        } catch {
          /* See above: the notification was delivered. */
        }
      }
    } else result.failed += 1
  }
  return result
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * The only thing that can be missing is the private key.
 *
 * The public half has a default in this file and the subject has a default too,
 * so "configured" reduces to one question: has the secret been pasted in? That
 * matters because it is the one failure mode nobody notices — subscribing works,
 * the screen says notifications are on, and every shift goes unannounced.
 */
function vapidConfigured(env) {
  return String((env && env.VAPID_PRIVATE_KEY) || '').trim().length > 0
}

const VAPID_MISSING_MESSAGE =
  'VAPID_PRIVATE_KEY is not set on the relay Worker, so no notification can be sent. ' +
  'Cloudflare dashboard → Workers → rm-operations → Settings → Variables and Secrets → ' +
  'Add → Secret, named VAPID_PRIVATE_KEY (see docs/CLOUDFLARE.md).'

/**
 * Everyone except the person who just punched.
 *
 * Split out from the query for the same reason findLink parses after its LIKE:
 * the SQL narrows and this decides. It is also the only form of this rule that
 * can be tested without a database, and it is a rule worth testing — somebody
 * holding the phone that clocked them in has already been told by the screen in
 * front of them, and a second buzz two seconds later reads as a duplicate. A
 * notification system people mute is a notification system that does nothing.
 */
export function notifyTargets(subscriptions, punchedBy) {
  const self = String(punchedBy || '')
  return (subscriptions || []).filter((s) => String(s.employee_id || '') !== self)
}

async function subscriptionsForSend(env, excludeEmployeeId) {
  await ensurePushTable(env)
  const result = await env.DB.prepare(
    `SELECT endpoint, employee_id, p256dh, auth FROM push_subscriptions
      WHERE employee_id <> ?1
      ORDER BY created_at ASC LIMIT ?2`
  )
    .bind(String(excludeEmployeeId || ''), PUSH_MAX_SUBSCRIPTIONS)
    .all()
  return notifyTargets(result.results || [], excludeEmployeeId)
}

async function dropSubscription(env, endpoint) {
  await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1').bind(endpoint).run()
}

/**
 * Record that a notification actually reached this device.
 *
 * The only durable evidence anybody has that the chain works. "Turned on" is a
 * row in a table and says nothing about delivery; a phone whose last delivery
 * was three weeks ago is a phone that quietly stopped, and without this the
 * person holding it has no way to tell that from a quiet week.
 */
async function markSent(env, endpoint) {
  await env.DB.prepare('UPDATE push_subscriptions SET last_sent_at = ?1 WHERE endpoint = ?2')
    .bind(new Date().toISOString(), endpoint)
    .run()
}

/**
 * How long a push service should hold a notification that could not be
 * delivered, in seconds, given how long the thing it is about stays true.
 *
 * A clock notification is worth six hours (see PUSH_TTL_SECONDS). A stream
 * reminder is worth exactly as long as it is still ahead of the show: "start the
 * stream" arriving after the stream should have started is not a reminder, it is
 * a phone shouting about last night. So a reminder's TTL is the time remaining
 * until the start, and a push service that could not reach the phone in that
 * window throws it away rather than delivering it stale.
 *
 * Floored at 60 because zero means "deliver now or never", and one minute is
 * enough for a phone that is merely between cell towers.
 */
export function pushTtlUntil(startsAt, nowMs = Date.now()) {
  const at = Date.parse(String(startsAt || ''))
  if (Number.isNaN(at)) return PUSH_TTL_SECONDS
  return Math.max(60, Math.round((at - nowMs) / 1000))
}

/**
 * One HTTPS POST to one push service.
 *
 * Returns the status rather than throwing on a bad one, because the CALLER is
 * what decides whether a status means "delete this row" — see deliverPush.
 *
 * `options` is optional and every caller that does not care gets the clock
 * defaults. It exists because a reminder and a punch expire differently and want
 * different urgencies, and baking one answer in would make the reminder either
 * arrive stale or wake somebody's phone at 3am about a shift.
 */
export async function sendOnePush(env, subscription, payloadBytes, options) {
  const audience = vapidAudience(subscription.endpoint)
  const signingKey = await vapidSigningKey(env)
  const jwt = await signVapidJwt(signingKey, {
    audience,
    subject: vapidSubject(env),
    expiresAtSeconds: Math.floor(Date.now() / 1000) + VAPID_JWT_TTL_SECONDS
  })
  const body = await encryptWebPushPayload({
    plaintext: payloadBytes,
    p256dh: subscription.p256dh,
    auth: subscription.auth
  })
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      authorization: vapidAuthorizationHeader(jwt, vapidPublicKey(env)),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String((options && options.ttlSeconds) || PUSH_TTL_SECONDS),
      // Phones are quiet at 3am for a reason and a shift starting is not an
      // emergency. 'normal' lets the OS batch it; 'high' would wake the device.
      //
      // A stream reminder overrides this to 'high', and that is not enthusiasm:
      // it has a deadline. A batched "start the stream in 15 minutes" that the
      // OS decides to hand over in twenty is not a late notification, it is a
      // wrong one, and the show it was about has already been missed.
      urgency: (options && options.urgency) || 'normal'
    },
    body
  })
  return response.status
}

/**
 * The one entry point every punch path ends at.
 *
 * Never throws outward: the punch is the record and the push is a courtesy on
 * top of it, so a push service having a bad minute must not turn a working
 * clock-in into a 500 on a warehouse phone.
 *
 * But "does not throw" is not "says nothing". A missing VAPID_PRIVATE_KEY is the
 * worst failure this feature has — everything upstream succeeds, the toggle in
 * the app reads as on, and shifts simply go unannounced until somebody
 * eventually asks why. So it is logged, loudly, with the fix in the message,
 * every time there was somebody to notify. `wrangler tail` or the dashboard's
 * live log is where that lands.
 */
async function notifyClockEvents(env, events) {
  if (!events || events.length === 0) return
  if (!vapidConfigured(env)) {
    const waiting = await subscriptionCount(env)
    if (waiting > 0) {
      console.log(
        `push: ${waiting} device(s) are subscribed and ${events.length} clock event(s) ` +
          `were NOT delivered. ${VAPID_MISSING_MESSAGE}`
      )
    }
    return
  }
  for (const event of events) {
    const entry = event.entry || {}
    const employeeId = String(entry.employee_id || '')
    if (!employeeId) continue

    // Everyone EXCEPT the person who just punched. They are holding the phone
    // that did it and have already been told by the screen in front of them; a
    // second buzz two seconds later reads as a duplicate and is the fastest way
    // to teach somebody to turn notifications off.
    const subscriptions = await subscriptionsForSend(env, employeeId)
    if (subscriptions.length === 0) continue

    const emp = await employeeById(env, employeeId)
    const name = emp
      ? `${emp.first_name || ''} ${emp.last_name || ''}`.trim() || emp.company_id || 'Someone'
      : 'Someone'
    const payload = buildClockPayload({
      kind: event.kind,
      name,
      at: event.kind === 'out' ? entry.clock_out : entry.clock_in,
      place: event.kind === 'out' ? entry.clock_out_place : entry.clock_in_place
    })
    const bytes = enc.encode(JSON.stringify(payload))

    const outcome = await deliverPush({
      subscriptions,
      send: (subscription) => sendOnePush(env, subscription, bytes),
      drop: (endpoint) => dropSubscription(env, endpoint),
      touch: (endpoint) => markSent(env, endpoint)
    })
    if (outcome.failed > 0 || outcome.dropped > 0) {
      console.log(
        `push: clock-${event.kind} — sent ${outcome.sent}, failed ${outcome.failed}, ` +
          `removed ${outcome.dropped} dead subscription(s).`
      )
    }
  }
}

async function subscriptionCount(env) {
  try {
    await ensurePushTable(env)
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').first()
    return row ? Number(row.n) : 0
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// The routes the app server calls
// ---------------------------------------------------------------------------

async function pushKey(env) {
  const configured = vapidConfigured(env)
  return json({
    ok: true,
    configured,
    // Not a secret — it is published to every phone that subscribes. Served
    // from here rather than copied into the app so that the key the browser
    // subscribes with and the key the Worker signs with are physically the same
    // value. Two copies of it drift, and a subscription made against the wrong
    // one fails at DELIVERY, weeks later, with no error anywhere.
    publicKey: vapidPublicKey(env),
    subject: vapidSubject(env),
    // Carried all the way to the screen. Without it the app can only say
    // "notifications are on" while the relay quietly sends nothing.
    problem: configured ? null : VAPID_MISSING_MESSAGE
  })
}

async function pushSubscribe(request, env) {
  const body = await readJson(request)
  const employeeId = String(body.employeeId || '').trim().slice(0, 80)
  const endpoint = String(body.endpoint || '').trim()
  const p256dh = String(body.p256dh || '').trim()
  const auth = String(body.auth || '').trim()
  const label = String(body.label || '').trim().slice(0, 80) || null

  if (!employeeId) return json({ ok: false, error: 'Who is subscribing?' }, 400)
  let audience
  try {
    audience = vapidAudience(endpoint)
  } catch {
    return json({ ok: false, error: 'That is not a usable push endpoint.' }, 400)
  }
  // Validated HERE rather than at send time. A malformed key stored now is a
  // notification that fails months later, once, silently, for one person.
  try {
    if (bytesFromB64url(p256dh).length !== 65) throw new Error('p256dh')
    if (bytesFromB64url(auth).length !== 16) throw new Error('auth')
  } catch {
    return json({ ok: false, error: 'That subscription is missing its keys.' }, 400)
  }

  await ensurePushTable(env)
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, employee_id, p256dh, auth, label, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (endpoint) DO UPDATE SET
       employee_id = excluded.employee_id,
       p256dh      = excluded.p256dh,
       auth        = excluded.auth,
       label       = excluded.label`
  )
    .bind(endpoint, employeeId, p256dh, auth, label, now)
    .run()

  return json({ ok: true, id: await subscriptionId(endpoint), service: audience })
}

async function pushUnsubscribe(request, env) {
  const body = await readJson(request)
  const endpoint = String(body.endpoint || '').trim()
  if (!endpoint) return json({ ok: false, error: 'Which subscription?' }, 400)
  await ensurePushTable(env)
  await dropSubscription(env, endpoint)
  // Always ok. Unsubscribing something already gone is the desired end state,
  // and a browser whose subscription expired underneath it must still be able
  // to tidy up rather than being told it is wrong.
  return json({ ok: true })
}

async function pushList(url, env) {
  const employeeId = String(url.searchParams.get('employeeId') || '').trim()
  await ensurePushTable(env)
  const result = employeeId
    ? await env.DB.prepare(
        `SELECT endpoint, employee_id, label, created_at, last_sent_at FROM push_subscriptions
          WHERE employee_id = ?1 ORDER BY created_at ASC`
      )
        .bind(employeeId)
        .all()
    : await env.DB.prepare(
        `SELECT endpoint, employee_id, label, created_at, last_sent_at FROM push_subscriptions
          ORDER BY created_at ASC LIMIT ?1`
      )
        .bind(PUSH_MAX_SUBSCRIPTIONS)
        .all()

  const devices = []
  for (const row of result.results || []) {
    devices.push({
      id: await subscriptionId(row.endpoint),
      employeeId: row.employee_id,
      label: row.label,
      createdAt: row.created_at,
      lastSentAt: row.last_sent_at,
      // The service, not the endpoint. "Apple" or "Google" is what a person
      // needs to recognise their own phone in a list; the URL is a capability.
      service: (() => {
        try {
          return new URL(row.endpoint).hostname
        } catch {
          return 'unknown'
        }
      })()
    })
  }
  return json({ ok: true, devices })
}

/**
 * Prove the whole chain works, on demand, without waiting for a shift.
 *
 * Worth a route of its own: everything between pressing the toggle and a phone
 * buzzing is invisible — the key pair, the subscription row, the JWT, the
 * encryption, the push service. Without this the first evidence any of it is
 * wrong arrives at 7am on a Monday, and the person who could fix it is asleep.
 */
async function pushTest(request, env) {
  if (!vapidConfigured(env)) return json({ ok: false, error: VAPID_MISSING_MESSAGE }, 400)
  const body = await readJson(request)
  const employeeId = String(body.employeeId || '').trim()
  if (!employeeId) return json({ ok: false, error: 'Who is testing?' }, 400)

  await ensurePushTable(env)
  const result = await env.DB.prepare(
    `SELECT endpoint, employee_id, p256dh, auth FROM push_subscriptions
      WHERE employee_id = ?1 LIMIT ?2`
  )
    .bind(employeeId, PUSH_MAX_SUBSCRIPTIONS)
    .all()
  const subscriptions = result.results || []
  if (subscriptions.length === 0) {
    return json({ ok: false, error: 'This account has no device turned on yet.' }, 400)
  }

  const bytes = enc.encode(
    JSON.stringify({
      v: 1,
      kind: 'test',
      name: String(body.name || 'Test notification').slice(0, 80),
      at: new Date().toISOString(),
      place: null
    })
  )
  const outcome = await deliverPush({
    subscriptions,
    send: (subscription) => sendOnePush(env, subscription, bytes),
    drop: (endpoint) => dropSubscription(env, endpoint),
    touch: (endpoint) => markSent(env, endpoint)
  })
  return json({
    ok: outcome.sent > 0,
    ...outcome,
    error:
      outcome.sent > 0
        ? undefined
        : outcome.dropped > 0
          ? 'The push service says this device no longer exists. Turn notifications off and on again.'
          : 'The push service refused the notification.'
  })
}

/**
 * Mint a VAPID key pair and hand both halves back, once.
 *
 * Nothing is stored: this is a generator, not a key store. The operator pastes
 * the private half into the VAPID_PRIVATE_KEY secret and the public half into
 * VAPID_PUBLIC_KEY_DEFAULT in this file (or the VAPID_PUBLIC_KEY variable), and
 * this route never needs calling again.
 *
 * It exists because the documented deployment story for this relay is "no
 * command line, no wrangler, paste a file into a dashboard", and the ordinary
 * way to produce these keys is an npm package. Behind the shared key, which
 * already grants read and write over the entire business, so it widens nothing.
 */
async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify'
  ])
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  return json({
    ok: true,
    publicKey: b64urlFromBytes(publicKey),
    privateKey: jwk.d,
    note:
      'privateKey is a SECRET: paste it into the Worker secret VAPID_PRIVATE_KEY and nowhere ' +
      'else — never into a chat, an issue or a commit. publicKey is not secret and belongs in ' +
      'VAPID_PUBLIC_KEY_DEFAULT in cloud/worker.js (or the VAPID_PUBLIC_KEY variable). ' +
      'Changing either one invalidates every phone already subscribed; they have to turn ' +
      'notifications off and on again.'
  })
}

// ---------------------------------------------------------------------------
// Job 6 — THE QUICKBOOKS CONNECTION
//
// This relay is the only holder of the QuickBooks grant. Not one of several: the
// only one. The laptops and the web app have no client secret, no access token
// and no refresh token, and after the owner's one-time setup they never will.
//
// ## Why it moved here, in two sentences that are worth keeping
//
// 1. INTUIT ROTATES THE REFRESH TOKEN ON EVERY REFRESH. A refresh answers with a
//    new refresh token and retires the one that was sent. Two machines holding
//    the same grant will eventually refresh within the same hour, and the loser
//    is left holding a token that is already dead — which it does not discover
//    for another hour, at which point somebody is halfway through raising an
//    invoice. One holder does not mitigate that race; it removes it.
// 2. THE CLIENT SECRET WOULD OTHERWISE BE ON EVERY LAPTOP. Which means rotating
//    it and reconnecting everybody the day somebody leaves, and it means the
//    secret exists in as many places as there are admins.
//
// ## Everything sensitive is encrypted before it touches D1
//
// D1 rows are readable in the Cloudflare dashboard by anybody who can open the
// account, and a D1 export is a plain file. So the client secret and both tokens
// are sealed with AES-GCM under a key derived from a WORKER SECRET, which the
// dashboard cannot display back and which no laptop has a copy of. See qboSeal.
//
// ## Nothing here ever logs a token
//
// Not on success, not on failure, not in an error message handed back to the
// app. Worker logs are readable in the dashboard and stream to anybody running
// `wrangler tail`; a refresh token in one is a permanent, silent compromise of
// somebody's accounting system. Errors carry Intuit's own fault text, which
// names the problem and never the credential.
// ---------------------------------------------------------------------------

/**
 * Production, always — there is no sandbox switch here and there must not be.
 *
 * This business has one set of books. An environment toggle is a way to point a
 * night's real billing at a test company and not notice until somebody asks
 * where the invoices went. The app made the same decision (see setQboConfig);
 * these two agreeing is not a coincidence to be tidied away later.
 */
const QBO_API_BASE = 'https://quickbooks.api.intuit.com'
const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
const QBO_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke'
const QBO_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2'
/** Accounting only. Widening this is a deliberate act, not a default. */
const QBO_SCOPE = 'com.intuit.quickbooks.accounting'
/** Pinned, so a minor-version bump at Intuit cannot change response shapes
 *  underneath a relay nobody is watching. Must match QBO_MINOR_VERSION in
 *  src/shared/quickbooks.ts. */
const QBO_MINOR_VERSION = '75'
/**
 * Intuit's OAuth Playground redirect, which Intuit has already registered
 * against every app. Production keys cannot register a loopback URI at all, so
 * this is the default the app uses and therefore the default here.
 */
const QBO_DEFAULT_REDIRECT_URI = 'https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl'

/** Refresh this far ahead of expiry, so a call starting just under the wire does
 *  not land just over it. Matches QBO_REFRESH_SKEW_MS in the app. */
const QBO_REFRESH_SKEW_MS = 5 * 60 * 1000

/**
 * How long one invocation may hold the refresh lease.
 *
 * Short, because it is a crash window: a Worker killed mid-refresh leaves the
 * lease set, and nothing else may refresh until it lapses. Thirty seconds is
 * far longer than a token round trip and short enough that a crash costs one
 * unlucky call rather than an outage.
 */
const QBO_REFRESH_LEASE_MS = 30 * 1000

/** How long a waiter will sit out somebody else's refresh before giving up. */
const QBO_REFRESH_WAIT_MS = 6 * 1000
const QBO_REFRESH_POLL_MS = 250

let qboTableReady = false

/**
 * Created on first use, like portal_lockout and push_subscriptions above and for
 * the same reason: cloud/schema.d1.sql is pasted into the D1 console by hand,
 * and a feature that only works after somebody remembers a SECOND paste is a
 * feature that appears broken with no error to search for.
 *
 * One row, forced by the CHECK. There is one company and there is one grant; a
 * table that could hold two would need a rule for which one an invoice goes to,
 * and no such rule exists.
 */
async function ensureQboTable(env) {
  if (qboTableReady) return
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS qbo_connection (
       id                 INTEGER PRIMARY KEY CHECK (id = 1),
       client_id          TEXT,
       client_secret      TEXT,
       redirect_uri       TEXT,
       realm_id           TEXT,
       company_name       TEXT,
       access_token       TEXT,
       refresh_token      TEXT,
       expires_at         INTEGER NOT NULL DEFAULT 0,
       refresh_expires_at INTEGER NOT NULL DEFAULT 0,
       refresh_lock_until INTEGER NOT NULL DEFAULT 0,
       last_error         TEXT,
       updated_at         TEXT
     )`
  ).run()
  qboTableReady = true
}

// ---------------------------------------------------------------------------
// Encryption at rest
// ---------------------------------------------------------------------------

/**
 * Which secret is protecting the stored credentials.
 *
 * QBO_ENC_KEY is the one to set, and it is strictly better than the fallback for
 * a reason worth stating: SHARED_KEY is compiled into every laptop's build, so a
 * stolen laptop plus a D1 export would be enough to open the tokens. QBO_ENC_KEY
 * exists only inside Cloudflare and is on no machine anybody carries.
 *
 * The fallback exists anyway because the alternative is worse. Refusing to store
 * anything until a second secret is set turns "connect QuickBooks" into a step
 * that fails with a configuration error in the middle of the one setup the owner
 * is ever asked to do. So it works either way, the envelope RECORDS which key
 * sealed it, and /v1/qbo/status reports the mode so the screen can say plainly
 * that the better one is not set yet.
 */
function qboEncryptionMode(env) {
  if (String(env.QBO_ENC_KEY || '').trim()) return 'dedicated'
  if (String(env.SHARED_KEY || env.CLINIC_KEY || '').trim()) return 'shared'
  return 'none'
}

function qboSecretFor(env, source) {
  const secret =
    source === 'd'
      ? String(env.QBO_ENC_KEY || '').trim()
      : String(env.SHARED_KEY || env.CLINIC_KEY || '').trim()
  if (!secret) {
    throw new Error(
      source === 'd'
        ? 'The stored QuickBooks credentials were encrypted with QBO_ENC_KEY, and that secret is ' +
          'no longer set on this Worker. Put it back, or disconnect and connect QuickBooks again.'
        : 'This Worker has no SHARED_KEY, so nothing stored can be decrypted.'
    )
  }
  return secret
}

/**
 * A per-record AES-256 key, derived rather than used directly.
 *
 * HKDF and not PBKDF2, deliberately: the input is a high-entropy random secret,
 * not a password, so stretching buys nothing — and this Worker is on a plan that
 * kills an invocation after 10ms of CPU, which a real iteration count would eat
 * on every single invoice.
 *
 * The salt is fresh per record and travels in the envelope, so the two sealed
 * fields never share a key and re-sealing the same value twice produces two
 * different ciphertexts.
 */
async function qboWrapKey(env, source, salt) {
  const raw = await hkdf(salt, enc.encode(qboSecretFor(env, source)), enc.encode('rmops-qbo-v1'), 32)
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/**
 * Seal one value for storage.
 *
 * Format: qbo1.<key source>.<salt>.<iv>.<ciphertext>, all base64url. The key
 * SOURCE is in there because the fallback above means two different secrets can
 * be in play over the lifetime of one database — and a record sealed under the
 * shared key that is later opened with the dedicated one does not fail with a
 * clear message, it fails as an AES-GCM tag mismatch that names nothing.
 */
export async function qboSeal(env, value) {
  const source = qboEncryptionMode(env) === 'dedicated' ? 'd' : 's'
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await qboWrapKey(env, source, salt)
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, enc.encode(String(value)))
  )
  return `qbo1.${source}.${b64urlFromBytes(salt)}.${b64urlFromBytes(iv)}.${b64urlFromBytes(ct)}`
}

export async function qboOpen(env, sealed) {
  const text = String(sealed || '')
  if (!text) return null
  const parts = text.split('.')
  if (parts.length !== 5 || parts[0] !== 'qbo1') {
    throw new Error('A stored QuickBooks credential is not in a format this Worker understands.')
  }
  const source = parts[1] === 'd' ? 'd' : 's'
  const key = await qboWrapKey(env, source, bytesFromB64url(parts[2]))
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytesFromB64url(parts[3]), tagLength: 128 },
      key,
      bytesFromB64url(parts[4])
    )
    return new TextDecoder().decode(plain)
  } catch {
    // AES-GCM refuses with nothing useful, so say what actually causes this.
    // Never echo any part of the ciphertext.
    throw new Error(
      'The stored QuickBooks credentials could not be decrypted, which means the Worker secret ' +
        'that sealed them has changed. Disconnect and connect QuickBooks again.'
    )
  }
}

// ---------------------------------------------------------------------------
// The stored connection
// ---------------------------------------------------------------------------

async function qboRow(env) {
  await ensureQboTable(env)
  return env.DB.prepare('SELECT * FROM qbo_connection WHERE id = 1').first()
}

/**
 * The row with its sealed fields opened. Null when there is no connection.
 *
 * Everything that talks to Intuit goes through this, so there is exactly one
 * place where plaintext credentials come into existence and it is a local
 * variable that dies with the invocation.
 */
export async function qboConnection(env) {
  const row = await qboRow(env)
  if (!row) return null
  return {
    clientId: String(row.client_id || ''),
    clientSecret: row.client_secret ? await qboOpen(env, row.client_secret) : '',
    redirectUri: String(row.redirect_uri || '') || QBO_DEFAULT_REDIRECT_URI,
    realmId: String(row.realm_id || ''),
    companyName: String(row.company_name || ''),
    accessToken: row.access_token ? await qboOpen(env, row.access_token) : '',
    refreshToken: row.refresh_token ? await qboOpen(env, row.refresh_token) : '',
    expiresAt: Number(row.expires_at) || 0,
    refreshExpiresAt: Number(row.refresh_expires_at) || 0,
    lastError: row.last_error ? String(row.last_error) : null
  }
}

function qboIso(ms) {
  const n = Number(ms)
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null
}

/** What the app is told. Never a token, never the secret, never the client id in
 *  full — the last four is enough to tell two app registrations apart. */
async function qboStatusBody(env) {
  const row = await qboRow(env)
  const clientId = row ? String(row.client_id || '') : ''
  const hasConfig = !!clientId && !!(row && row.client_secret)
  const connected = hasConfig && !!(row && row.refresh_token) && !!(row && row.realm_id)
  return {
    ok: true,
    hasConfig,
    connected,
    realmId: row && row.realm_id ? String(row.realm_id) : null,
    companyName: row && row.company_name ? String(row.company_name) : null,
    clientIdHint: clientId ? clientId.slice(-4) : null,
    expiresAt: row ? qboIso(row.expires_at) : null,
    refreshExpiresAt: row ? qboIso(row.refresh_expires_at) : null,
    encryption: qboEncryptionMode(env),
    lastError: row && row.last_error ? String(row.last_error) : null,
    // What this DEPLOYED copy of the Worker can do.
    //
    // The relay is deployed separately from the app, by hand, so the two are
    // routinely different ages — and nothing in the Cloudflare dashboard says
    // the running code is older than the repository. Without this, calling a
    // route that has not been deployed yet is a 404 from a button labelled
    // "Send to QuickBooks", which everybody reads as QuickBooks being down.
    //
    // Announcing capabilities by NAME rather than by version number means the
    // app asks "can you do this" instead of "are you new enough", which is the
    // question it actually has. A relay that predates this field answers with
    // nothing, and absence reads correctly as "no".
    features: ['upload']
  }
}

async function qboNoteError(env, message) {
  await ensureQboTable(env)
  await env.DB.prepare('UPDATE qbo_connection SET last_error = ?1 WHERE id = 1')
    .bind(message ? String(message).slice(0, 500) : null)
    .run()
}

// ---------------------------------------------------------------------------
// Talking to Intuit
// ---------------------------------------------------------------------------

function qboBasicAuth(conn) {
  return 'Basic ' + btoa(`${conn.clientId}:${conn.clientSecret}`)
}

async function qboPostToken(conn, form) {
  const res = await fetch(QBO_TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: qboBasicAuth(conn),
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json'
    },
    body: form.toString()
  })
  const text = await res.text()
  let parsed = {}
  try {
    parsed = JSON.parse(text)
  } catch {
    // Intuit answers some failures with HTML. The status is the useful part, and
    // the body is not echoed — it can contain the request that was sent.
    throw new Error(`QuickBooks rejected the token request (HTTP ${res.status}).`)
  }
  if (!res.ok || parsed.error) {
    throw new Error(
      parsed.error_description || parsed.error || `QuickBooks rejected the token request (HTTP ${res.status}).`
    )
  }
  return parsed
}

/**
 * Store a token response, keeping what a refresh response does not carry.
 *
 * A REFRESH reply contains neither the company nor, always, a new refresh token.
 * Dropping either would silently disconnect the integration an hour later, which
 * is the single most expensive way this can go wrong: everything keeps working
 * until the access token lapses, and then nothing does.
 */
async function qboStoreTokens(env, conn, body, realmId) {
  const now = Date.now()
  const refreshToken = body.refresh_token || conn.refreshToken
  if (!body.access_token || !refreshToken) {
    throw new Error('QuickBooks did not return a usable token.')
  }
  const expiresAt = now + (Number(body.expires_in) || 3600) * 1000
  const refreshExpiresAt = now + (Number(body.x_refresh_token_expires_in) || 8726400) * 1000
  await env.DB.prepare(
    `UPDATE qbo_connection
        SET access_token = ?1, refresh_token = ?2, realm_id = ?3,
            expires_at = ?4, refresh_expires_at = ?5,
            refresh_lock_until = 0, last_error = NULL, updated_at = ?6
      WHERE id = 1`
  )
    .bind(
      await qboSeal(env, body.access_token),
      await qboSeal(env, refreshToken),
      String(realmId || conn.realmId || ''),
      expiresAt,
      refreshExpiresAt,
      new Date().toISOString()
    )
    .run()
  return {
    ...conn,
    accessToken: body.access_token,
    refreshToken,
    realmId: String(realmId || conn.realmId || ''),
    expiresAt,
    refreshExpiresAt
  }
}

/**
 * Swap the refresh token for a fresh access token, ONCE, even when several
 * invocations want one at the same moment.
 *
 * ## Why a lease and not just "refresh when stale"
 *
 * Moving the connection here removed the race BETWEEN MACHINES. It does not by
 * itself remove the race between two Worker invocations: three admins pressing
 * "send to QuickBooks" in the same second, an hour after the last refresh, are
 * three concurrent fetches that all see an expired access token. Each would call
 * Intuit, each would be issued a rotated refresh token, and the last write would
 * win — leaving two perfectly good tokens that Intuit has already retired and a
 * stored one that may not be the newest. So one invocation claims the right to
 * refresh with a conditional UPDATE, and the others WAIT for it and then use
 * what it stored.
 *
 * The claim is `WHERE refresh_lock_until < now`, which is atomic in D1 because
 * it is a single statement. The waiter polls the row rather than sleeping a
 * fixed time, so the common case costs a couple of hundred milliseconds.
 *
 * If the waiter times out it refreshes anyway. A duplicate refresh is a real but
 * survivable problem — Intuit accepts the previous refresh token for a short
 * grace window — whereas refusing to refresh means an invoice fails for a reason
 * nobody can act on.
 */
export async function qboEnsureFresh(env, conn, force) {
  const now = Date.now()
  if (!force && conn.accessToken && conn.expiresAt - QBO_REFRESH_SKEW_MS > now) return conn
  if (!conn.refreshToken) throw new Error('QuickBooks is not connected on the relay.')
  if (conn.refreshExpiresAt > 0 && conn.refreshExpiresAt <= now) {
    throw new Error(
      'The QuickBooks connection has expired and has to be re-authorised. Open Invoices → ' +
        'QuickBooks and approve again.'
    )
  }

  const claim = await env.DB.prepare(
    'UPDATE qbo_connection SET refresh_lock_until = ?1 WHERE id = 1 AND refresh_lock_until < ?2'
  )
    .bind(now + QBO_REFRESH_LEASE_MS, now)
    .run()
  const claimed = !!(claim && claim.meta && Number(claim.meta.changes) > 0)

  if (!claimed) {
    const waited = await qboWaitForRefresh(env, conn)
    if (waited) return waited
  }

  try {
    const body = await qboPostToken(
      conn,
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: conn.refreshToken })
    )
    return await qboStoreTokens(env, conn, body, conn.realmId)
  } catch (err) {
    // Release the lease on the way out. Holding it after a failure would make
    // every later call wait the full lease for a refresh that already failed.
    await env.DB.prepare('UPDATE qbo_connection SET refresh_lock_until = 0 WHERE id = 1').run()
    throw err
  }
}

/** Poll for somebody else's refresh to land. Null if it does not. */
async function qboWaitForRefresh(env, conn) {
  const deadline = Date.now() + QBO_REFRESH_WAIT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, QBO_REFRESH_POLL_MS))
    const fresh = await qboConnection(env)
    if (!fresh) return null
    // A token that is comfortably in date, and not the one we started with, is
    // evidence somebody else finished. Comparing expiry rather than the token
    // itself avoids ever holding two tokens side by side to compare.
    if (fresh.accessToken && fresh.expiresAt > conn.expiresAt) return fresh
  }
  return null
}

/**
 * One Accounting API call against the connected company.
 *
 * The 401 retry is deliberately once. A token still rejected after a forced
 * refresh is not a timing problem, and retrying again turns a clear failure into
 * a slow one.
 */
async function qboFetch(env, conn, call) {
  let live = await qboEnsureFresh(env, conn, false)

  const send = async (state) => {
    const url = new URL(`${QBO_API_BASE}/v3/company/${state.realmId}/${call.path}`)
    url.searchParams.set('minorversion', QBO_MINOR_VERSION)
    for (const [k, v] of Object.entries(call.query || {})) url.searchParams.set(k, String(v))

    // An ATTACHMENT is multipart, not JSON. Intuit's /upload wants exactly two
    // parts with exactly these names: the Attachable record as JSON, then the
    // bytes. FormData is rebuilt on every attempt rather than built once and
    // reused, because the 401 path below sends a SECOND time — and a body that
    // has already been streamed is empty the next time it is read, which would
    // upload a zero-byte file after a token refresh.
    if (call.upload) {
      const form = new FormData()
      form.append(
        'file_metadata_01',
        new Blob([JSON.stringify(call.upload.metadata)], { type: 'application/json' }),
        'metadata.json'
      )
      form.append(
        'file_content_01',
        new Blob([call.upload.bytes], { type: call.upload.mimeType }),
        call.upload.fileName
      )
      return fetch(url.toString(), {
        method: 'POST',
        // NO content-type header. fetch sets multipart/form-data WITH the
        // boundary it generated; naming the type here without the boundary
        // produces a body Intuit cannot parse.
        headers: { authorization: `Bearer ${state.accessToken}`, accept: 'application/json' },
        body: form
      })
    }

    return fetch(url.toString(), {
      method: call.method || 'GET',
      headers: {
        authorization: `Bearer ${state.accessToken}`,
        accept: 'application/json',
        ...(call.body !== undefined && call.body !== null ? { 'content-type': 'application/json' } : {})
      },
      body: call.body !== undefined && call.body !== null ? JSON.stringify(call.body) : undefined
    })
  }

  let res = await send(live)
  if (res.status === 401) {
    live = await qboEnsureFresh(env, live, true)
    res = await send(live)
  }
  const text = await res.text()
  return { status: res.status, ok: res.ok, text }
}

/**
 * Turn an Intuit fault into one useful sentence.
 *
 * Their faults nest as { Fault: { Error: [{ Message, Detail }] } } and the
 * Detail is usually the part that says what actually went wrong. Mirrors
 * describeQboError in src/main/quickbooks/client.ts, because the app can no
 * longer see the raw response when the relay is the caller.
 */
export function describeQboFault(status, body) {
  try {
    const parsed = JSON.parse(body)
    const err = (parsed.Fault && parsed.Fault.Error && parsed.Fault.Error[0]) ||
      (parsed.fault && parsed.fault.error && parsed.fault.error[0])
    if (err) {
      const parts = [err.Message || err.message, err.Detail || err.detail].filter(Boolean)
      if (parts.length > 0) return `QuickBooks: ${parts.join(' — ')}`
    }
  } catch {
    // Not JSON; the status is what is left.
  }
  if (status === 403) return 'QuickBooks refused the request (403). Check the app has accounting scope.'
  if (status === 429) return 'QuickBooks is rate limiting requests. Try again shortly.'
  return `QuickBooks request failed (HTTP ${status}).`
}

/**
 * Is this a path the relay is willing to call?
 *
 * The mirror of isSafeQboPath in src/shared/quickbooksRelay.ts, and it is here
 * for a different reason than the one there. The app-side check catches a bug in
 * the app; THIS one is the only thing standing between somebody holding the
 * shared key and a request aimed outside the connected company — a leading
 * slash, a scheme or a '..' segment would each escape /v3/company/{realm}/.
 */
export function qboSafePath(path) {
  const p = String(path || '').trim()
  if (!p || p.length > 300) return false
  if (p.startsWith('/') || p.startsWith('\\')) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return false
  if (p.includes('..')) return false
  return /^[A-Za-z0-9/_-]+$/.test(p)
}

/**
 * What an attachment may be attached TO.
 *
 * A whitelist rather than a pattern, because this names a transaction in a real
 * company's books. Anything not on this list is something the app does not
 * create and therefore has no business attaching a document to — and the check
 * has to live HERE, not only in the app, for the same reason qboSafePath does:
 * this is the boundary somebody holding the shared key is on the other side of.
 */
const QBO_ATTACHABLE_ENTITIES = new Set(['Invoice', 'PurchaseOrder', 'Bill', 'SalesReceipt', 'Estimate'])

/**
 * How large an attachment may be.
 *
 * Intuit's own ceiling is 100MB, which is not the number that matters here — a
 * Worker holds the whole thing in memory and the base64 that carried it is a
 * third larger again. An invoice PDF is tens of kilobytes; eight megabytes is
 * generous for a scanned supplier document and small enough that a mistake
 * cannot exhaust the isolate.
 */
const QBO_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

/** Types this relay will pass on. Not a security boundary — a sanity one. */
const QBO_ATTACHMENT_TYPES = new Set([
  'application/pdf',
  'text/html',
  'text/csv',
  'text/plain',
  'image/png',
  'image/jpeg'
])

/**
 * Decode base64 to bytes, refusing anything oversized BEFORE allocating it.
 *
 * The length check is on the encoded string, which is why it is 4/3 of the byte
 * cap: checking after decoding means a caller who sends 200MB has already had
 * 200MB allocated by the time it is refused.
 */
export function qboAttachmentBytes(base64) {
  const raw = String(base64 || '')
  if (!raw) throw new Error('The attachment has no content.')
  if (raw.length > Math.ceil((QBO_MAX_ATTACHMENT_BYTES * 4) / 3) + 8) {
    throw new Error('That attachment is too large for the relay to carry.')
  }
  const binary = atob(raw)
  if (binary.length > QBO_MAX_ATTACHMENT_BYTES) {
    throw new Error('That attachment is too large for the relay to carry.')
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * A file name QuickBooks will store and a filesystem will not object to.
 *
 * The name travels into a Content-Disposition header, so a newline or a quote in
 * it would break the multipart framing itself rather than merely producing an
 * odd file name. Stripped rather than rejected: the name is cosmetic, and
 * failing an upload over a punctuation mark in a customer's name would be a
 * worse outcome than a slightly tidied file name.
 */
export function qboAttachmentName(name, fallback) {
  const cleaned = String(name || '')
    .replace(/[\r\n"\\/ -]+/g, '_')
    .trim()
    .slice(0, 120)
  return cleaned || fallback
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function qboApi(request, env, path) {
  const route = path.slice('/v1/qbo/'.length)

  if (route === 'status' && request.method === 'GET') {
    return json(await qboStatusBody(env))
  }

  // ---- Setup, done once, by the owner -------------------------------------
  if (route === 'config' && request.method === 'POST') {
    const body = await readJson(request)
    const clientId = String(body.clientId || '').trim()
    const clientSecret = String(body.clientSecret || '').trim()
    const redirectUri = String(body.redirectUri || '').trim() || QBO_DEFAULT_REDIRECT_URI
    if (!clientId || !clientSecret) {
      return json({ ok: false, error: 'Send both clientId and clientSecret.' }, 400)
    }
    await ensureQboTable(env)
    const existing = await qboRow(env)
    // Changing the app registration invalidates any grant already stored: tokens
    // minted by one Intuit app are meaningless to another, and keeping them would
    // leave the relay claiming a connection whose first call 401s.
    const keepGrant = existing && String(existing.client_id || '') === clientId
    await env.DB.prepare(
      `INSERT INTO qbo_connection (id, client_id, client_secret, redirect_uri, updated_at)
       VALUES (1, ?1, ?2, ?3, ?4)
       ON CONFLICT (id) DO UPDATE SET
         client_id = excluded.client_id,
         client_secret = excluded.client_secret,
         redirect_uri = excluded.redirect_uri,
         updated_at = excluded.updated_at,
         last_error = NULL`
    )
      .bind(clientId, await qboSeal(env, clientSecret), redirectUri, new Date().toISOString())
      .run()
    if (!keepGrant) {
      await env.DB.prepare(
        `UPDATE qbo_connection
            SET access_token = NULL, refresh_token = NULL, realm_id = NULL, company_name = NULL,
                expires_at = 0, refresh_expires_at = 0, refresh_lock_until = 0
          WHERE id = 1`
      ).run()
    }
    return json(await qboStatusBody(env))
  }

  /**
   * The consent URL, built HERE.
   *
   * The app needs somewhere to send the browser and the URL carries the client
   * id — so building it here is what lets the client id stay on the relay
   * instead of being handed back to every machine that wants to connect. It is
   * not a secret (it travels in the address bar either way), but a value that
   * never leaves cannot be pasted into the wrong box by mistake.
   */
  if (route === 'authorize-url' && request.method === 'GET') {
    const conn = await qboRow(env)
    if (!conn || !conn.client_id) {
      return json({ ok: false, error: 'The relay has no QuickBooks keys yet.' }, 400)
    }
    const url = new URL(request.url)
    const redirectUri =
      String(url.searchParams.get('redirect') || '').trim() ||
      String(conn.redirect_uri || '') ||
      QBO_DEFAULT_REDIRECT_URI
    const state = String(url.searchParams.get('state') || '').trim() || crypto.randomUUID()
    const params = new URLSearchParams({
      client_id: String(conn.client_id),
      response_type: 'code',
      scope: QBO_SCOPE,
      redirect_uri: redirectUri,
      state
    })
    return json({ ok: true, url: `${QBO_AUTHORIZE_URL}?${params.toString()}`, redirectUri })
  }

  /**
   * Finish consent. The relay does the EXCHANGE, so the client secret never
   * leaves it and the tokens are never on a laptop even for a moment.
   *
   * The redirect URI sent here MUST equal the one sent with the authorize
   * request — Intuit compares them and refuses otherwise, which is a confusing
   * failure precisely because consent appeared to work.
   */
  if (route === 'exchange' && request.method === 'POST') {
    const body = await readJson(request)
    const code = String(body.code || '').trim()
    const realmId = String(body.realmId || '').trim()
    if (!code || !/^[0-9]{6,25}$/.test(realmId)) {
      return json({ ok: false, error: 'Send the authorization code and a numeric realmId.' }, 400)
    }
    const conn = await qboConnection(env)
    if (!conn || !conn.clientId || !conn.clientSecret) {
      return json({ ok: false, error: 'The relay has no QuickBooks keys yet.' }, 400)
    }
    const redirectUri = String(body.redirectUri || '').trim() || conn.redirectUri
    try {
      const token = await qboPostToken(
        conn,
        new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri })
      )
      const stored = await qboStoreTokens(env, conn, token, realmId)
      // Prove the grant works before calling it connected. A stored token that
      // 401s on first use is worse than an honest failure now.
      await qboRefreshCompanyName(env, stored)
    } catch (err) {
      const message = String((err && err.message) || err)
      await qboNoteError(env, message)
      return json({ ok: false, error: message }, 400)
    }
    return json(await qboStatusBody(env))
  }

  /**
   * Adopt a token pair minted somewhere else.
   *
   * Two callers, one route. The owner PROMOTING the connection they already have
   * on their laptop, and anybody pasting tokens out of Intuit's OAuth Playground.
   * Both are the same act: the tokens belong to the SAME app registration, so
   * once stored the ordinary refresh cycle takes over and it is never repeated.
   *
   * expiresAt is forced to 0 so the very first call MUST refresh. That proves the
   * refresh token and the stored client credentials work together before any of
   * this is called connected, and replaces guessed lifetimes with the real ones
   * Intuit hands back.
   */
  if (route === 'adopt' && request.method === 'POST') {
    const body = await readJson(request)
    const refreshToken = String(body.refreshToken || '').trim()
    const realmId = String(body.realmId || '').trim()
    if (!refreshToken || !/^[0-9]{6,25}$/.test(realmId)) {
      return json({ ok: false, error: 'Send a refreshToken and a numeric realmId.' }, 400)
    }
    const conn = await qboConnection(env)
    if (!conn || !conn.clientId || !conn.clientSecret) {
      return json({ ok: false, error: 'Send the client id and secret first.' }, 400)
    }
    await env.DB.prepare(
      `UPDATE qbo_connection
          SET refresh_token = ?1, access_token = NULL, realm_id = ?2,
              expires_at = 0, refresh_expires_at = ?3, refresh_lock_until = 0,
              last_error = NULL, updated_at = ?4
        WHERE id = 1`
    )
      .bind(
        await qboSeal(env, refreshToken),
        realmId,
        Number(body.refreshExpiresAt) || Date.now() + 100 * 24 * 60 * 60 * 1000,
        new Date().toISOString()
      )
      .run()
    try {
      const stored = await qboConnection(env)
      await qboRefreshCompanyName(env, await qboEnsureFresh(env, stored, true))
    } catch (err) {
      const message = String((err && err.message) || err)
      await qboNoteError(env, message)
      return json({ ok: false, error: message }, 400)
    }
    return json(await qboStatusBody(env))
  }

  // ---- The connection test, and the company name --------------------------
  if (route === 'company' && request.method === 'GET') {
    const conn = await qboConnection(env)
    if (!conn || !conn.refreshToken) {
      return json({ ok: false, error: 'QuickBooks is not connected on the relay.' }, 409)
    }
    try {
      const info = await qboRefreshCompanyName(env, await qboEnsureFresh(env, conn, false))
      return json({ ok: true, companyName: info.name, realmId: conn.realmId, info: info.raw })
    } catch (err) {
      const message = String((err && err.message) || err)
      await qboNoteError(env, message)
      return json({ ok: false, error: message }, 502)
    }
  }

  // ---- Everything the app actually does day to day ------------------------
  if (route === 'request' && request.method === 'POST') {
    const body = await readJson(request)
    const method = String(body.method || 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'POST') {
      return json({ ok: false, error: 'Only GET and POST are allowed.' }, 400)
    }
    if (!qboSafePath(body.path)) {
      return json({ ok: false, error: 'That is not a QuickBooks path this relay will call.' }, 400)
    }
    const conn = await qboConnection(env)
    if (!conn || !conn.refreshToken || !conn.realmId) {
      return json(
        {
          ok: false,
          error:
            'QuickBooks is not connected on the relay. The owner sets this up once, under ' +
            'Invoices → QuickBooks.'
        },
        409
      )
    }
    let result
    try {
      result = await qboFetch(env, conn, {
        method,
        path: String(body.path).trim(),
        query: body.query && typeof body.query === 'object' ? body.query : {},
        body: body.body
      })
    } catch (err) {
      const message = String((err && err.message) || err)
      await qboNoteError(env, message)
      return json({ ok: false, error: message }, 502)
    }
    if (!result.ok) {
      const message = describeQboFault(result.status, result.text)
      await qboNoteError(env, message)
      return json({ ok: false, error: message, status: result.status }, 200)
    }
    await qboNoteError(env, null)
    let parsed = {}
    try {
      parsed = result.text ? JSON.parse(result.text) : {}
    } catch {
      return json({ ok: false, error: 'QuickBooks returned something that is not JSON.' }, 502)
    }
    return json({ ok: true, status: result.status, body: parsed })
  }

  /**
   * Attach a document to a transaction.
   *
   * ITS OWN ROUTE, not a flag on `request`, because it is a different KIND of
   * call. Everything on `request` is JSON in and JSON out; this one carries
   * bytes, has to be framed as multipart, and needs limits on size and on what
   * it may attach to. Folding it in would have made the common path carry checks
   * that only matter here, and made the size cap something a JSON caller could
   * wander into by accident.
   *
   * The bytes arrive base64-encoded inside JSON rather than as a raw multipart
   * body from the app. That costs a third in transfer and buys two things worth
   * more: the relay's own request framing stays uniform (one shape, one auth
   * check, one place that reads a body), and the app never has to build a
   * multipart body it would then have to keep in step with this file.
   */
  if (route === 'upload' && request.method === 'POST') {
    const body = await readJson(request)
    const entityType = String(body.entityType || '').trim()
    const entityId = String(body.entityId || '').trim()
    const mimeType = String(body.mimeType || '').trim().toLowerCase()

    if (!QBO_ATTACHABLE_ENTITIES.has(entityType)) {
      return json({ ok: false, error: 'That is not something this relay will attach a file to.' }, 400)
    }
    // Ids are Intuit's own, and they are numeric. Anything else is either a bug
    // or somebody probing, and both deserve the same flat refusal.
    if (!/^[0-9]{1,20}$/.test(entityId)) {
      return json({ ok: false, error: 'That is not a QuickBooks id.' }, 400)
    }
    if (!QBO_ATTACHMENT_TYPES.has(mimeType)) {
      return json({ ok: false, error: `The relay will not carry a ${mimeType || 'blank'} file.` }, 400)
    }

    let bytes
    try {
      bytes = qboAttachmentBytes(body.contentBase64)
    } catch (err) {
      return json({ ok: false, error: String((err && err.message) || err) }, 400)
    }

    const fileName = qboAttachmentName(body.fileName, 'document')

    const conn = await qboConnection(env)
    if (!conn || !conn.refreshToken || !conn.realmId) {
      return json(
        {
          ok: false,
          error:
            'QuickBooks is not connected on the relay. The owner sets this up once, under ' +
            'Invoices → QuickBooks.'
        },
        409
      )
    }

    let result
    try {
      result = await qboFetch(env, conn, {
        method: 'POST',
        path: 'upload',
        upload: {
          bytes,
          fileName,
          mimeType,
          // The Attachable record. AttachableRef is what LINKS the file to the
          // transaction — without it the file uploads successfully and lands
          // nowhere anybody will find it, attached to nothing.
          metadata: {
            AttachableRef: [{ EntityRef: { type: entityType, value: entityId } }],
            FileName: fileName,
            ContentType: mimeType
          }
        }
      })
    } catch (err) {
      const message = String((err && err.message) || err)
      await qboNoteError(env, message)
      return json({ ok: false, error: message }, 502)
    }

    if (!result.ok) {
      const message = describeQboFault(result.status, result.text)
      await qboNoteError(env, message)
      return json({ ok: false, error: message, status: result.status }, 200)
    }
    await qboNoteError(env, null)

    let parsed = {}
    try {
      parsed = result.text ? JSON.parse(result.text) : {}
    } catch {
      return json({ ok: false, error: 'QuickBooks returned something that is not JSON.' }, 502)
    }

    // /upload answers with a LIST, one entry per part, and a per-part Fault
    // rather than an HTTP error — so a 200 here does not by itself mean the file
    // landed. The entry is unwrapped and checked before this reports success.
    const entry = Array.isArray(parsed.AttachableResponse) ? parsed.AttachableResponse[0] : null
    const fault = entry && entry.Fault
    if (fault) {
      const message = describeQboFault(200, JSON.stringify({ Fault: fault }))
      await qboNoteError(env, message)
      return json({ ok: false, error: message }, 200)
    }
    const attachable = (entry && entry.Attachable) || null
    if (!attachable || !attachable.Id) {
      return json({ ok: false, error: 'QuickBooks accepted the file but did not say where it went.' }, 200)
    }

    return json({ ok: true, id: String(attachable.Id), fileName: String(attachable.FileName || fileName) })
  }

  // ---- Taking it apart again ----------------------------------------------
  if (route === 'disconnect' && request.method === 'POST') {
    const conn = await qboConnection(env)
    if (conn && conn.refreshToken && conn.clientId && conn.clientSecret) {
      // Tell Intuit if we can, but never let that stop the disconnect — a network
      // failure must not leave the relay stuck claiming a connection.
      try {
        await fetch(QBO_REVOKE_URL, {
          method: 'POST',
          headers: {
            authorization: qboBasicAuth(conn),
            'content-type': 'application/json',
            accept: 'application/json'
          },
          body: JSON.stringify({ token: conn.refreshToken })
        })
      } catch {
        /* best effort */
      }
    }
    await env.DB.prepare(
      `UPDATE qbo_connection
          SET access_token = NULL, refresh_token = NULL, realm_id = NULL, company_name = NULL,
              expires_at = 0, refresh_expires_at = 0, refresh_lock_until = 0, last_error = NULL
        WHERE id = 1`
    ).run()
    return json(await qboStatusBody(env))
  }

  /** Forget the app registration too, secret included. */
  if (route === 'forget' && request.method === 'POST') {
    await ensureQboTable(env)
    await env.DB.prepare('DELETE FROM qbo_connection WHERE id = 1').run()
    return json(await qboStatusBody(env))
  }

  return json({ ok: false, error: 'Not found.' }, 404)
}

/**
 * The cheapest authenticated read there is, used as the connection test — and
 * the only place the company name is learned.
 *
 * Stored rather than fetched per status call: the status route is polled by
 * every screen that mentions QuickBooks, and an Intuit round trip behind each
 * one would burn the rate limit on rendering a label.
 */
async function qboRefreshCompanyName(env, conn) {
  const result = await qboFetch(env, conn, { path: `companyinfo/${conn.realmId}` })
  if (!result.ok) throw new Error(describeQboFault(result.status, result.text))
  let info = {}
  try {
    info = JSON.parse(result.text || '{}')
  } catch {
    info = {}
  }
  const company = (info && info.CompanyInfo) || {}
  const name = String(company.CompanyName || company.LegalName || '')
  await env.DB.prepare('UPDATE qbo_connection SET company_name = ?1, last_error = NULL WHERE id = 1')
    .bind(name)
    .run()
  return { name, raw: company }
}

// ---------------------------------------------------------------------------
// Job 5 — scheduled-stream reminders
//
// An hour before a planned show, and again a quarter of an hour before, every
// admin's phone (and the host's, if the host is not an admin) is told to go and
// start the stream.
//
// ## Why this is the odd one out
//
// Everything else in this file happens because somebody did something. This
// happens because a clock struck. That is a Cloudflare Cron Trigger calling the
// `scheduled` handler at the top of this file — added BY HAND in the dashboard,
// because there is no wrangler.toml here to declare it. Without that trigger,
// every part of this section is dead code and nothing anywhere says so.
//
// ## The failure this section is mostly about
//
// A cron re-examines the same show every five minutes. The naive version of this
// feature therefore sends "your stream starts soon" twelve times an hour, after
// which everybody mutes the app and the feature is worse than absent — it has
// spent the notification permission that the clock-in notifications rely on.
//
// So: every reminder claims a row in push_reminders_sent BEFORE it is sent, and
// the claim is a primary-key INSERT. Two overlapping cron invocations both read
// the same show; only one of them gets the row.
//
// ## Wall clock and instant
//
// A planned show carries both: `stream_date` + `start_time` are the intention
// ("9:00 PM on Friday"), and `starts_at` is the same moment as a UTC instant,
// converted ONCE on the machine that scheduled it. This Worker reads ONLY
// `starts_at`. It runs in UTC and has no idea what timezone this business is in,
// so reading "21:00" here would put every reminder out by the local offset —
// four or five hours — and it would look like the notification system was broken
// rather than a date conversion. src/shared/streamReminders.ts is the canonical
// statement of all of this and carries the same rules in TypeScript;
// tests/streamReminders.test.ts runs both copies over the same cases and fails
// if they ever disagree.
// ---------------------------------------------------------------------------

/** An hour out, and a quarter of an hour out. Longest first: that is send order. */
export const STREAM_REMINDER_LEADS = [60, 15]

/**
 * How late a reminder may be and still go out, in minutes.
 *
 * Ten: two ticks of a five-minute cron, so one missed or failed invocation still
 * delivers. Past that it is SUPPRESSED rather than sent, because "starts in an
 * hour" arriving twenty minutes late is a false statement about the show — and
 * it is also what stops a relay that was asleep waking up and firing a flurry of
 * stale reminders at everybody at once.
 */
export const STREAM_REMINDER_WINDOW_MINUTES = 10

/** Never look at more planned shows than this in one tick. A bug upstream must
 *  not turn one cron invocation into a thousand push sends. */
const STREAM_REMINDER_MAX_ROWS = 50

/** How long a sent-reminder record is kept before it is swept up. Long enough
 *  that no live show can still be pending, short enough that the table does not
 *  grow forever — nothing else in this Worker would ever look at it again. */
const STREAM_REMINDER_KEEP_DAYS = 30

/**
 * Half-open window: [start - lead, start - lead + window). Half-open because a
 * closed one double-counts its boundary, and a cron that lands on exact
 * five-minute marks hits boundaries constantly.
 *
 * The last clause — nothing once the show has started — is redundant today (the
 * shortest lead is 15 and the window is 10, so every window closes five minutes
 * clear of the start) and is here anyway. It is the rule the owner actually
 * cares about, and it stays true if a five-minute lead is ever added.
 */
export function streamReminderDue(nowMs, startsAtMs, lead) {
  if (!Number.isFinite(nowMs) || !Number.isFinite(startsAtMs)) return false
  const dueAt = startsAtMs - lead * 60000
  if (nowMs < dueAt) return false
  if (nowMs >= dueAt + STREAM_REMINDER_WINDOW_MINUTES * 60000) return false
  return nowMs < startsAtMs
}

/**
 * The key a sent reminder is filed under. THE START INSTANT IS PART OF IT.
 *
 * Keying on the show and the lead alone would mean a show moved from 9pm to 11pm
 * never reminds again — there is already a "60 minutes before" against it, for a
 * time that is no longer true. Including the instant makes a rescheduled show a
 * different reminder, which is what it is, while the common case (ten laptops
 * pulling the same unchanged row) produces the identical key and is refused.
 */
export function streamReminderKey(scheduleId, startsAt, lead) {
  return String(scheduleId) + '|' + String(startsAt) + '|' + String(lead)
}

/**
 * Which reminders are due at `nowMs`, out of the planned shows handed in.
 *
 * Pure, and pure on purpose: the four refusals in here are the whole behaviour
 * of this feature, and they are the part that has to be testable without a
 * database, a cron or a phone.
 *
 *  · not 'planned' — cancelled, or already started. Both reach this Worker as
 *    ordinary synced rows.
 *  · an unparseable instant — never guess at a time.
 *  · outside the window — covers "already started" and "the cron has been down
 *    and is catching up" in one rule.
 *  · already sent — NOT decided here, because a pure function cannot know. The
 *    caller claims the key in D1 first, which is what makes it hold across two
 *    invocations running at once.
 */
export function streamRemindersDue(rows, nowMs) {
  const out = []
  for (const row of rows || []) {
    if (!row || String(row.status) !== 'planned') continue
    const startsAtMs = Date.parse(String(row.startsAt))
    if (Number.isNaN(startsAtMs)) continue
    for (const lead of STREAM_REMINDER_LEADS) {
      if (!streamReminderDue(nowMs, startsAtMs, lead)) continue
      out.push({
        scheduleId: String(row.id),
        title: String(row.title || ''),
        startsAt: String(row.startsAt),
        hostId: row.hostId ? String(row.hostId) : null,
        lead,
        key: streamReminderKey(row.id, row.startsAt, lead)
      })
    }
  }
  out.sort((a, b) => (a.startsAt === b.startsAt ? b.lead - a.lead : a.startsAt < b.startsAt ? -1 : 1))
  return out
}

/** Longest lead plus the window: past that, nothing can be due yet. */
export function streamReminderLookaheadMinutes() {
  let longest = 0
  for (const lead of STREAM_REMINDER_LEADS) if (lead > longest) longest = lead
  return longest + STREAM_REMINDER_WINDOW_MINUTES
}

/**
 * Does this employee row have admin access?
 *
 * A HAND-COPIED MIRROR of `grantsAdminAccess` in src/shared/streamReminders.ts,
 * which is the canonical one and reads the real permission table. This file is
 * pasted into a dashboard and can import nothing, so the role list is spelled
 * out — and tests/streamReminders.test.ts walks every role defined in
 * @shared/permissions through both copies and fails the moment they disagree.
 * That test is the only thing standing between this constant and the day
 * somebody grants a new role admin access and half the company stops being
 * reminded about anything.
 *
 * The overrides are additive by construction in the app, so a packer who was
 * granted admin.access by hand counts — which is the entire point of the
 * override, and a role-only check here would silently exclude them.
 */
export function grantsAdminAccess(role, permissionsJson) {
  const named = String(role || '')
  if (named === 'owner' || named === 'operations') return true
  let overrides = permissionsJson
  if (typeof permissionsJson === 'string' && permissionsJson.trim()) {
    try {
      overrides = JSON.parse(permissionsJson)
    } catch {
      // A blob that will not parse is not a grant. The role alone is the
      // conservative reading and matches what the app does with this column.
      overrides = []
    }
  }
  if (!Array.isArray(overrides)) return false
  for (const p of overrides) if (String(p) === 'admin.access') return true
  return false
}

/**
 * Every admin, plus the host if the host is not one of them.
 *
 * A Set, because in this business the host usually IS an admin, and two
 * notifications for one show is how you teach somebody that this app buzzes
 * twice for everything.
 *
 * PEOPLE, not devices. One person with a phone and an iPad hears about it on
 * both, correctly; that fan-out happens against push_subscriptions afterwards.
 */
export function streamReminderRecipients(adminIds, hostId) {
  const set = new Set()
  for (const id of adminIds || []) {
    const clean = String(id || '').trim()
    if (clean) set.add(clean)
  }
  const host = String(hostId || '').trim()
  if (host) set.add(host)
  return [...set]
}

/**
 * What travels to the phone.
 *
 * `at` is the start INSTANT, untouched, for the same reason a punch is: the
 * relay has no idea what timezone the phone is in and the phone knows exactly.
 * The service worker computes "in 12 minutes" from it against the phone's own
 * clock at the moment it draws — which matters, because a push can sit in
 * Apple's queue for minutes and "in 15 minutes" drawn ten minutes later is a lie
 * the phone was in a position not to tell. `lead` rides along for the wording
 * and the log, never for the timing.
 */
export function buildStreamReminderPayload(input) {
  const title = String((input && input.title) || '').trim() || 'Stream'
  return {
    v: 1,
    kind: 'stream',
    // Carried so the phone can tag both reminders for one show alike and have
    // the second REPLACE the first. Tagging by title would collide two different
    // shows that happen to share a name into a single notification.
    id: String((input && input.scheduleId) || ''),
    title: title.slice(0, 80),
    at: String((input && input.startsAt) || ''),
    lead: Number(input && input.lead) || 0
  }
}

/**
 * Created on first use, like push_subscriptions and portal_lockout above and for
 * the same reason: cloud/schema.d1.sql is pasted into a console by hand, and a
 * feature that only works after somebody remembers a SECOND paste is a feature
 * that appears broken with no error to search for.
 *
 * `key` is the primary key and that is the whole once-only guarantee — see
 * claimReminder.
 */
let reminderTableReady = false
async function ensureReminderTable(env) {
  if (reminderTableReady) return
  await env.DB.batch([
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS push_reminders_sent (
         key         TEXT PRIMARY KEY,
         schedule_id TEXT NOT NULL,
         lead        INTEGER NOT NULL,
         sent_at     TEXT NOT NULL
       )`
    ),
    env.DB.prepare(
      'CREATE INDEX IF NOT EXISTS idx_push_reminders_sent_at ON push_reminders_sent (sent_at)'
    )
  ])
  reminderTableReady = true
}

/**
 * Claim a reminder. True means "you send it"; false means somebody already has.
 *
 * A bare INSERT, and the primary-key collision IS the answer. Not a SELECT
 * followed by an INSERT: two cron invocations overlapping — which Cloudflare
 * permits, and which a slow push service makes likely — would both read nothing
 * and both send. Not a check on `meta.changes` either, which is a shape of the
 * D1 result object rather than a guarantee.
 *
 * A genuine database fault also lands here and also returns false, so the
 * reminder is skipped. That is the safe direction and it is chosen deliberately:
 * a reminder that did not arrive costs one show; a reminder that arrives every
 * five minutes costs the notification permission on every phone in the building.
 */
async function claimReminder(env, reminder) {
  try {
    await env.DB.prepare(
      `INSERT INTO push_reminders_sent (key, schedule_id, lead, sent_at)
       VALUES (?1, ?2, ?3, ?4)`
    )
      .bind(reminder.key, reminder.scheduleId, reminder.lead, new Date().toISOString())
      .run()
    return true
  } catch {
    return false
  }
}

/** Sweep records nobody will ever consult again. Cheap, and it runs on the tick
 *  rather than on a second schedule nobody would remember to add. */
async function reapReminders(env) {
  const cutoff = new Date(Date.now() - STREAM_REMINDER_KEEP_DAYS * 86400000).toISOString()
  try {
    await env.DB.prepare('DELETE FROM push_reminders_sent WHERE sent_at < ?1').bind(cutoff).run()
  } catch {
    // Housekeeping. A failed sweep must never stop a reminder going out.
  }
}

/**
 * The planned shows near enough to matter, straight out of the synced rows.
 *
 * The SQL bound is an OPTIMISATION and nothing more — `streamRemindersDue`
 * decides. Written that way on purpose: the interesting rules then live in a
 * pure function a test can drive, rather than half here in a WHERE clause that
 * nothing can exercise without a D1 instance.
 *
 * The instants compare as strings because every one of them was written by
 * `Date.prototype.toISOString`, which is fixed-width UTC. A row carrying an
 * instant in any other shape simply falls outside the bound and is not reminded
 * about, which is the right failure: silence, not a notification at a wrong time.
 */
async function plannedStreamsNear(env, nowMs) {
  const from = new Date(nowMs).toISOString()
  const to = new Date(nowMs + streamReminderLookaheadMinutes() * 60000).toISOString()
  const result = await env.DB.prepare(
    `SELECT data FROM sync_rows
      WHERE kind = 'stream_schedule' AND deleted = 0
        AND json_extract(data, '$.status') = 'planned'
        AND json_extract(data, '$.starts_at') >= ?1
        AND json_extract(data, '$.starts_at') <= ?2
      ORDER BY json_extract(data, '$.starts_at') ASC
      LIMIT ?3`
  )
    .bind(from, to, STREAM_REMINDER_MAX_ROWS)
    .all()
  const rows = []
  for (const row of result.results || []) {
    let parsed
    try {
      parsed = JSON.parse(row.data)
    } catch {
      continue
    }
    rows.push({
      id: String(parsed.id || ''),
      title: String(parsed.title || ''),
      startsAt: String(parsed.starts_at || ''),
      hostId: parsed.host_id ? String(parsed.host_id) : null,
      status: String(parsed.status || '')
    })
  }
  return rows
}

/**
 * Everyone with admin access, by employee id.
 *
 * Read whole and filtered here rather than in SQL, because the answer depends on
 * a role table and an additive override list and neither of those is expressible
 * in a WHERE clause without pinning the permission model into this file twice.
 * The employee list is dozens of rows.
 *
 * Disabled accounts are skipped. Somebody switched off is somebody who is not
 * being asked to start a stream, and a notification to them is a notification to
 * a phone that should have stopped hearing from this company.
 */
async function adminEmployeeIds(env) {
  const result = await env.DB.prepare(
    `SELECT id, data FROM sync_rows WHERE kind = 'employees' AND deleted = 0 LIMIT 500`
  ).all()
  const ids = []
  for (const row of result.results || []) {
    let emp
    try {
      emp = JSON.parse(row.data)
    } catch {
      continue
    }
    if (!emp || emp.status === 'disabled') continue
    if (grantsAdminAccess(emp.role, emp.permissions_json)) ids.push(String(row.id))
  }
  return ids
}

/** Every device belonging to any of these people. */
async function subscriptionsForPeople(env, employeeIds) {
  await ensurePushTable(env)
  const unique = [...new Set((employeeIds || []).map((id) => String(id)))].slice(0, 100)
  if (unique.length === 0) return []
  const marks = unique.map((_, i) => '?' + (i + 1)).join(', ')
  const result = await env.DB.prepare(
    'SELECT endpoint, employee_id, p256dh, auth FROM push_subscriptions WHERE employee_id IN (' +
      marks +
      ') ORDER BY created_at ASC LIMIT ' +
      PUSH_MAX_SUBSCRIPTIONS
  )
    .bind(...unique)
    .all()
  return result.results || []
}

/**
 * One cron tick.
 *
 * Order matters in exactly one place: the claim happens BEFORE the send. If the
 * send then fails the reminder is lost rather than retried, which is the
 * trade-off written down in claimReminder — and the second reminder is still
 * coming, so a failed hour-before is not a silent show.
 *
 * Logged when there is something to say. A missing VAPID_PRIVATE_KEY is
 * announced loudly for the same reason it is on the punch path: everything
 * upstream succeeds, the app's toggle reads as on, and shows simply go
 * unannounced until somebody eventually asks why.
 */
async function runStreamReminders(env, nowMs) {
  await ensureReminderTable(env)
  await reapReminders(env)

  const planned = await plannedStreamsNear(env, nowMs)
  const due = streamRemindersDue(planned, nowMs)
  if (due.length === 0) return

  if (!vapidConfigured(env)) {
    console.log(
      `push: ${due.length} stream reminder(s) were NOT delivered. ${VAPID_MISSING_MESSAGE}`
    )
    return
  }

  // Read once per tick, not once per show. The admin list is the same for every
  // reminder in this batch and each read is a D1 round trip.
  const admins = await adminEmployeeIds(env)

  for (const reminder of due) {
    const people = streamReminderRecipients(admins, reminder.hostId)
    const subscriptions = await subscriptionsForPeople(env, people)
    if (subscriptions.length === 0) continue

    // Claimed here — after we know there is somebody to tell, before a single
    // byte goes out. Claiming earlier would burn the key on a tick where nobody
    // had notifications turned on yet.
    if (!(await claimReminder(env, reminder))) continue

    const bytes = enc.encode(
      JSON.stringify(
        buildStreamReminderPayload({
          scheduleId: reminder.scheduleId,
          title: reminder.title,
          startsAt: reminder.startsAt,
          lead: reminder.lead
        })
      )
    )
    // Expires when the show starts, and jumps the queue. Both for the same
    // reason: this notification is only true until nine o'clock.
    const options = { ttlSeconds: pushTtlUntil(reminder.startsAt, nowMs), urgency: 'high' }
    const outcome = await deliverPush({
      subscriptions,
      send: (subscription) => sendOnePush(env, subscription, bytes, options),
      drop: (endpoint) => dropSubscription(env, endpoint),
      touch: (endpoint) => markSent(env, endpoint)
    })
    console.log(
      `push: stream reminder T-${reminder.lead} for ${reminder.scheduleId} — sent ${outcome.sent}, ` +
        `failed ${outcome.failed}, removed ${outcome.dropped} dead subscription(s).`
    )
  }
}

// ---------------------------------------------------------------------------
// The public page
// ---------------------------------------------------------------------------

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // The form posts to itself and loads nothing from anywhere. Saying so
      // means an injected script has nowhere to run and nowhere to send.
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff'
    }
  })
}

function esc(value) {
  return String(value == null ? '' : value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )
}

function page(brand, body) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(brand)}</title>
<style>
  :root { color-scheme: light dark; --bg:#f5f6f8; --card:#fff; --ink:#16181d; --muted:#5b6270;
          --line:#dfe3ea; --accent:#1e63d0; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#12141a; --card:#1b1e26; --ink:#eceef3; --muted:#9aa3b4; --line:#2c313d;
            --accent:#5b96f5; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 -apple-system,
         BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding:24px 16px 64px; }
  main { max-width:560px; margin:0 auto; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:24px; }
  h1 { font-size:22px; margin:0 0 4px; letter-spacing:-.01em; }
  .sub { color:var(--muted); margin:0 0 24px; font-size:14px; }
  label { display:block; font-size:13px; font-weight:600; margin:16px 0 6px; }
  input, textarea { width:100%; padding:11px 12px; font:inherit; color:inherit; background:var(--bg);
                    border:1px solid var(--line); border-radius:9px; }
  input:focus, textarea:focus { outline:2px solid var(--accent); outline-offset:1px; border-color:var(--accent); }
  textarea { min-height:88px; resize:vertical; }
  .row { display:flex; gap:12px; }
  .row > div { flex:1; }
  button { margin-top:24px; width:100%; padding:13px; font:inherit; font-weight:650; color:#fff;
           background:var(--accent); border:0; border-radius:9px; cursor:pointer; }
  .hp { position:absolute; left:-9999px; width:1px; height:1px; overflow:hidden; }
  .note { color:var(--muted); font-size:13px; margin-top:20px; }
</style>
</head><body><main>${body}</main></body></html>`
}

function formBody(brand, link, token) {
  const heading = link.event_name || link.label || 'Shipping details'
  const when = link.event_date ? ` — ${esc(link.event_date)}` : ''
  return `<div class="card">
  <h1>${esc(brand)}</h1>
  <p class="sub">${esc(heading)}${when}</p>
  <form method="post" action="/checkin/${encodeURIComponent(token)}">
    <div class="hp"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>
    <label for="handle">Whatnot handle</label>
    <input id="handle" name="handle" autocomplete="nickname" placeholder="@yourhandle">
    <label for="real_name">Full name</label>
    <input id="real_name" name="real_name" autocomplete="name">
    <div class="row">
      <div><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email"></div>
      <div><label for="phone">Phone</label><input id="phone" name="phone" type="tel" autocomplete="tel"></div>
    </div>
    <label for="address1">Address</label>
    <input id="address1" name="address1" autocomplete="address-line1">
    <input id="address2" name="address2" autocomplete="address-line2" placeholder="Apt, suite (optional)" style="margin-top:8px">
    <div class="row">
      <div><label for="city">City</label><input id="city" name="city" autocomplete="address-level2"></div>
      <div><label for="state">State</label><input id="state" name="state" autocomplete="address-level1"></div>
      <div><label for="postal_code">ZIP</label><input id="postal_code" name="postal_code" autocomplete="postal-code"></div>
    </div>
    <label for="request">Anything we should know?</label>
    <textarea id="request" name="request" placeholder="Hold my cards until next week, combine with my last order, ..."></textarea>
    <button type="submit">Send</button>
  </form>
  <p class="note">We use this to ship your cards. Nothing here is charged or shared.</p>
</div>`
}

function thanksBody(brand, who) {
  return `<div class="card">
  <h1>Got it${who ? `, ${esc(who)}` : ''}</h1>
  <p class="sub">Your details are with the ${esc(brand)} team. You can close this page.</p>
</div>`
}

function closedBody(brand) {
  return `<div class="card">
  <h1>This form is closed</h1>
  <p class="sub">The link has expired or was turned off. Ask ${esc(brand)} for a current one.</p>
</div>`
}
