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

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
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
