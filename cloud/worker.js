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
 * What this Worker is NOT: it does not run the business. It holds no logic about
 * cost, stock or orders, and it never decides anything — it stores rows and hands
 * them back in order. Every rule lives in the app, on the laptops, where it can
 * be tested and where it keeps working when Cloudflare cannot be reached.
 *
 * Deployed from the dashboard (Workers & Pages → Create → paste this file).
 * Bindings it expects:
 *   DB          D1 database binding
 *   SHARED_KEY  secret; the shared key every laptop sends
 *   BRAND       optional plain-text var; company name shown on the public form
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
  async fetch(request, env) {
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
      if (path.startsWith('/clock/api/')) return clockApi(request, env, path)

      // ---- Job 1: sync. Everything below needs the shared key. -------------
      if (!authorized(request, env)) {
        return json({ ok: false, error: 'Unauthorized.' }, 401)
      }

      if (path === '/v1/state' && request.method === 'GET') return state(env)
      if (path === '/v1/push' && request.method === 'POST') return push(request, env)
      if (path === '/v1/pull' && request.method === 'GET') return pull(url, env)
      if (path === '/v1/reset' && request.method === 'POST') return reset(request, env)

      return json({ ok: false, error: 'Not found.' }, 404)
    } catch (err) {
      return json({ ok: false, error: String((err && err.message) || err) }, 500)
    }
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
async function push(request, env) {
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
  return json({ ok: true, accepted: statements.length, cursor: end })
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
 */
function portalEligible(emp) {
  if (!emp) return false
  if (emp.status !== 'active') return false
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

async function clockApi(request, env, path) {
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
  if (route === 'punch' && request.method === 'POST') return clockPunch(request, env, emp)
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
async function clockPunch(request, env, emp) {
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
