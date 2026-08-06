# The web app: deploying, backing up, and what to do when it breaks

The app now runs in a browser. Same database, same handlers, same permission
checks — a different transport in front of them. Nobody installs anything, and
the Mac auto-updater stops being a problem because there is nothing to update.

This document is the operations manual for that. If you only read one section,
read **[The volume](#the-volume)**.

---

## What actually changed

Nothing about the backend. The app registers 232 operations with
`ipcMain.handle(channel, fn)`; those handlers *are* the backend — the permission
checks, the transactions, the FIFO cost engine. They register with
`src/main/ipcRegistry.ts` rather than with Electron directly, so the same
functions can be bound to IPC (desktop) or to HTTP routes (server) without a
second copy existing.

```
screens → lib/api.ts → createBridge(transport) ─┬─ ipcRenderer  → ipcMain.handle → SQLite
                                                └─ HTTP + SSE   → /api/call/…  ↗
```

Three files decide which:

| File | Job |
|---|---|
| `src/bridge/index.ts` | The ~300 methods every screen calls. One definition, both transports. |
| `src/preload/index.ts` | Electron: passes `ipcRenderer` to it. |
| `src/renderer/src/lib/httpTransport.ts` | Browser: passes an HTTP+SSE object with the same methods. |

`lib/api.ts` picks at runtime — `window.rmops ?? createBridge(httpTransport)` —
so one renderer bundle serves both and there is no wrong build to ship.

---

## Running it locally

```bash
npm run web        # builds the renderer + the server, then starts it
```

Then open <http://localhost:8787>. Over plain http the session cookie has to
lose its `Secure` flag or the browser will silently drop it and the login form
will appear to do nothing:

```bash
RMOPS_COOKIE_SECURE=0 npm run web
```

The database lands in `./data`, which is git-ignored.

### Environment

| Variable | Default | What it does |
|---|---|---|
| `RMOPS_DATA_DIR` | `./data` | Database, product images, QuickBooks token. **Must be a volume in production.** |
| `RMOPS_PORT` | `8787` | Listening port. |
| `RMOPS_HOST` | `0.0.0.0` | Bind address. |
| `RMOPS_COOKIE_SECURE` | on | Set to `0` only for local http. |
| `RMOPS_TRUST_PROXY` | off | `1` when something sets `x-forwarded-*` in front. |
| `RMOPS_MAX_BODY_MB` | `48` | Upload ceiling — a 200-page packing slip plus base64. |
| `RMOPS_SYNC_URL` / `RMOPS_SYNC_KEY` | unset | The relay. Unset = no outbound connection at all. |
| `RMOPS_RENDERER_DIR` | `out/renderer` | Where the built app is. |
| `RMOPS_ALLOW_EPHEMERAL_DATA` | unset | Escape hatch. Read [The volume](#the-volume) first. |

---

## Deploying

Fly.io, and `fly.toml` says why: this app is one process owning one SQLite file,
and a Fly volume is a real block device attached to exactly one machine. That
makes the single-writer arrangement the FIFO engine assumes true by
construction. Render works too, but its mental model is "scale by adding
instances", and here that is the failure mode rather than the feature.

First time:

```bash
fly launch --no-deploy               # answer no to Postgres, no to Redis
fly volumes create rmops_data --size 10 --region iad
fly secrets set RMOPS_SYNC_URL=https://… RMOPS_SYNC_KEY=…   # optional
fly deploy
fly scale count 1                    # see below — this is not optional
```

Afterwards, every deploy is `fly deploy`.

### One machine. Always one.

Two machines do not share a volume. They would each get their own database, each
answer half the requests, and **nothing would look broken** — until the numbers
stopped agreeing and neither copy was right. `fly.toml` sets
`auto_stop_machines = false` and `min_machines_running = 1`; check with
`fly status` after any scaling change.

### The volume

This is the mistake that costs the company its data, so the server refuses to
make it.

`RMOPS_DATA_DIR` defaults to `./data`. Inside a container that is a perfectly
ordinary, perfectly writable directory — on the container's own filesystem. The
app works. Everyone signs in, counts stock, imports a ledger. Then the next
deploy replaces the container and **all of it is gone**, with no error, no
warning and no missing file. The app comes up asking to create an Owner account,
which is exactly what a brand-new install looks like.

So on boot, in production, the server checks two things and refuses to start if
either fails:

1. `RMOPS_DATA_DIR` is set.
2. It is on a **different filesystem** from `/` — that is, something is actually
   mounted there. A typo in the mount path, a volume that failed to attach, or a
   `docker run` without `-v` all leave the variable set and pointing at nothing
   durable, and the device-number check is the only thing that can tell the
   difference.

A failed check looks like this in `fly logs`, and the machine will not come up:

```
RMOPS_DATA_DIR (/data) is on the container's own filesystem, not a mounted
volume. Refusing to start: everything written there is destroyed by the next
deploy.
```

Fix the mount. `RMOPS_ALLOW_EPHEMERAL_DATA=1` turns the check off and exists for
throwaway demos only — setting it on the real deployment is the same as deleting
the database on a timer.

Product images live on the same volume (`$RMOPS_DATA_DIR/product-images`) for
the same reason, and are served through the ordinary permission-checked
`inventory:images:list` operation as `data:` URLs — there is no second,
unauthenticated route handing out customer-facing photos.

### Secrets

`RMOPS_SYNC_URL` and `RMOPS_SYNC_KEY` are set with `fly secrets set` and reach
the process as environment variables. They are **never** baked into the image:
this repository is public, and an image layer containing a URL and a bearer
token is found by automated scanning in hours. The browser is told whether a key
is set — never what it is, and only administrators see even the last four
characters.

---

## Backups

The database is now the only copy of the business. Back it up before you need to.

**A consistent copy, while the app is running** — `VACUUM INTO` takes one
without stopping anybody or copying a half-written WAL:

```bash
fly ssh console -C "sqlite3 /data/rm-operations.db \"VACUUM INTO '/data/backup-\$(date +%F).db'\""
fly sftp get /data/backup-2026-08-06.db ./backups/
```

Never copy `rm-operations.db` with `cp` while the server is running. WAL mode
means the file on disk is not the whole database, and the copy you get is one
nobody can reconcile afterwards.

**Nightly, off the machine.** A backup that lives on the same volume as the
database is not a backup — it dies with it. Run the two commands above from a
laptop or a CI cron and keep at least 30 days.

**Product images** are files, not rows:

```bash
fly ssh console -C "tar czf - -C /data product-images" > images-2026-08-06.tar.gz
```

**Test a restore once.** A backup nobody has restored is a hypothesis.

---

## Restoring

```bash
fly scale count 0                                  # stop the writer first
fly sftp shell                                     # put the file back as /data/rm-operations.db
fly scale count 1
```

Stopping first matters: restoring underneath a running process leaves it holding
file handles to a database that no longer exists, and it will keep serving from
them until it doesn't.

---

## When it breaks

**Nobody can sign in / the login form does nothing.**
The session cookie is `Secure`, so it is dropped over plain http. Check
`force_https` is on and that you are reaching the app over https. Locally, set
`RMOPS_COOKIE_SECURE=0`.

**"Too many sign-in attempts."**
Ten failures in fifteen minutes, counted per address *and* per account. It
clears itself; a restart also clears it, because the counters are in memory.

**The app loads but every call returns 401.**
The session expired (12 hours idle, 30 days absolute) or the account was
disabled — `resolveSession` re-checks the employee on every request, so
disabling somebody takes effect immediately rather than whenever their token
happens to lapse. Sign in again.

**A blank page after a deploy.**
`index.html` is served `no-store` and the hashed assets are `immutable`, which
should make this impossible. If it happens anyway, something in front is caching
`index.html` — check the CDN, not the app.

**Exports do nothing.**
The browser blocked the download, or the two-minute ticket expired between the
call and the click. Try again; the export is regenerated, not resumed.

**"Opening a link" does nothing** (tracking pages, the batch "open all").
Popup blocker. Those operations hand back a list of URLs for the tab to open,
and 35 USPS tabs at once is exactly what popup blockers exist to stop. Allow
popups for the site.

**A purchase order downloads as `.html` instead of `.pdf`.**
Expected. Chromium is what renders the PDF on the desktop, and there is no
Chromium in the container. The document is byte-identical; print it from the
browser (⌘P → Save as PDF). Shipping a headless browser to lay out one purchase
order is a hundred megabytes and a monthly CVE feed for something every viewer
already has.

**Two machines are running.**
`fly scale count 1` immediately, then work out which volume has the newer data
(`fly ssh console -C "ls -la /data"`), restore it everywhere, and reconcile by
hand anything written to the loser. Prevention is the whole point of the rule.

**SQLITE_BUSY in the logs.**
`busy_timeout` is 5s, so this means a single write took longer than that — an
inventory reset over a very large sheet, most likely. It is a symptom of size,
not of corruption.

---

## Security posture

The desktop app assumed a trusted machine. A public URL does not. What is in
place:

- **Every route needs a session** except `/health`, the login POST, and the two
  first-run setup operations (`auth:setup-state`, `auth:create-owner` — the
  latter refuses once any account exists). That includes every read. Static
  assets are served to anyone, because they are the code that asks for data, not
  the data.
- **The permission checks are the same ones.** They live inside the handlers and
  read the caller from an `AsyncLocalStorage` request context, so ten
  simultaneous callers each see themselves. `tests/webServer.test.ts` asserts
  over real HTTP that a Shipping-role session cannot export the customer list or
  create a product — if the transport ever started bypassing the handlers, that
  test fails.
- **Session cookies** are `HttpOnly` (no script can read one), `Secure` (never
  sent in the clear) and `SameSite=Strict` (no other site can cause one to be
  sent). Tokens are stored as SHA-256 hashes, so a leaked backup is not a set of
  live logins.
- **CSRF**: every operation also requires an `x-rmops-request` header. A form on
  another site cannot set one, and a script trying would need a preflight this
  server never answers — it sends no CORS headers at all.
- **Login is rate-limited**: 10 attempts per 15 minutes, per address and per
  account, checked *before* bcrypt runs so a blocked attempt costs no CPU.
  bcrypt stays at cost 12.
- **Exports** are one-shot tickets, bound to the session that created them and
  expiring in two minutes.
- **The relay key** never leaves the server. Non-administrators no longer see
  even the four-character hint.
- **"Remember me" is refused** on this transport. It wrote a password into a
  shared `meta` row, which is fine on one person's laptop and is a credential
  store nobody designed on a shared server. The session cookie already survives
  closing the tab.

### What is NOT secured, plainly

- **The QuickBooks refresh token sits on the volume in plain text.** There is no
  OS keychain in a datacentre, and `safeStorage` correctly reports "not
  available", so `quickbooks/store.ts` falls back to unencrypted JSON — the same
  fallback it has always had on Linux. Anyone with shell access to the machine
  or a copy of the volume can read it. Rotate it if the machine is ever
  compromised, and treat volume backups as secret material.
- **Rate-limit counters are in memory.** A redeploy forgets them, and a
  determined attacker who can trigger restarts gets fresh attempts. Adequate at
  this size; not adequate for more than one process.
- **There is no audit of reads.** Writes are recorded in `audit_log` as they
  always were; nobody is recording who *looked* at the customer list.
- **There is no per-IP allowlist.** The app is on the open internet behind a
  password. If the team is only ever in two buildings, a Cloudflare Access rule
  or a Fly private network in front would be a cheap and large improvement, and
  is not done here.
- **No offline mode.** No connection means no app. Known, not discovered.

---

## The operations the browser handles differently

Fourteen operations ended by asking an operating system for something. Nine of
them are better in a browser; five needed real work.

| Operation | Desktop | Browser |
|---|---|---|
| Ledger CSV import | native picker → path | file chosen in the tab, content uploaded |
| Count-sheet import | native picker → path | as above |
| Packing-slip PDF | native picker → path | as above (bytes, base64) |
| Product image / supply photo / avatar | native picker → path | as above |
| Hours CSV, shipping CSV, count export | save dialog → disk | streamed back as a download |
| Purchase-order document | Chromium → PDF | HTML, printed by the browser |
| Tracking pages, batch open, invite email | `shell.openExternal` | `window.open` |
| Parse progress, live refresh | `webContents.send` | Server-Sent Events |
| "Remember me" | OS keychain | the session cookie |
| App auto-update | electron-updater | nothing to update; the tab is always current |

The three importers take CONTENT rather than a path, with a path-taking wrapper
kept for the desktop — a server that accepted a path would be offering to read
any file it can reach to anybody who can name one.

PDF parsing runs server-side under plain Node. `pdfjs-dist` is deliberately
**not** bundled into the server: bundled to CJS it loses the environment it
expects and dies on a missing `DOMMatrix` on the first page. It stays a real
runtime import, which is why `node_modules` ships in the image.
