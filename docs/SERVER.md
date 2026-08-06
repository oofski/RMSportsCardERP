# Multi-user: moving to a server + browser app

> **This shipped.** The server exists (`src/server/`), the browser transport
> exists (`src/renderer/src/lib/httpTransport.ts`), and the deployment is
> documented in **[WEB.md](./WEB.md)** — read that one to run it. This document
> is kept for the reasoning: why a server rather than Cloudflare D1, why SQLite
> stays, and what the measurement said before any of it was built.

## Where we are today

**Every install has its own private database.** `db/database.ts` opens a SQLite
file in `app.getPath('userData')` — a local file on that one computer. Two
people running the app have two unrelated warehouses. Nothing syncs, and nothing
ever has.

That is the whole problem this document solves. It is not an update-distribution
problem (see UPDATES.md, which is a different thing entirely).

## Decisions

| Question | Answer |
|---|---|
| How many, where | 10+ people, mixed locations → hosted, real sessions, backups |
| Client | **Browser.** No installers, no Apple signing, no Gatekeeper |
| Existing data | Migrate the current local database up as the real one |

Going browser-only **cancels two projects in flight**: the Cloudflare update feed
and the Apple Developer signing work. There is nothing to distribute and nothing
to sign if everyone opens a URL. That saves the $99/yr enrolment and all the
notarization plumbing.

## Why this is tractable

The app is already split at a clean boundary, even though both halves run
locally today:

```
screens  →  window.rmops.*  →  180 IPC channels  →  handlers  →  SQLite
└── renderer ──────────────┘                     └── main ──────────────┘
```

The screens never touch the database. They call `api.inventory.list()`, that
crosses a boundary, and a handler on the other side does the work. **That
boundary is where the network goes.** Both sides of it are swappable without
touching anything in between:

- `renderer/src/lib/api.ts` is literally `export const api = window.rmops`.
  Reimplement that one module as an HTTP client with the same shape and every
  screen works unchanged.
- The handlers are registered with `ipcMain.handle(channel, fn)`. Register the
  same functions as HTTP routes instead and the database layer, the FIFO
  engine, the P&L code and all 891 tests carry over untouched.

Measured, not estimated (`scripts/survey-ipc.mjs`):

```
IPC handlers registered:            180
Portable to a server as-is:         166  (92%)
Touch a desktop-only API:            14
Push/event channels (WebSocket):      2
```

The 14 are four patterns, and three of them get *easier* in a browser:

| Pattern | Handlers | Browser equivalent |
|---|---|---|
| File picker | 6 | `<input type="file">` + multipart upload |
| Save dialog | 3 | HTTP response with `Content-Disposition` |
| Open external link | 4 | already a browser — `window.open` |
| OS theme | 1 | `prefers-color-scheme` + a stored preference |

## Why NOT Cloudflare Workers / D1 for the app itself

Workers cannot run `better-sqlite3` — it is a native module, and Workers are not
Node. D1 is Cloudflare's SQLite, but it is **async and HTTP-based**, so every one
of the several thousand `db.prepare(...).get()` calls in this codebase would have
to be rewritten, including the FIFO and ledger code that depends on synchronous
multi-statement transactions. That is the single largest and riskiest rewrite
available, in exchange for nothing this app needs.

**Cloudflare still earns its place — in front.** DNS, TLS, DDoS protection and
static-asset caching for a small VPS behind it. That is what it is good at here.

## Why stay on SQLite

Moving to Postgres would mean rewriting every query in the app. SQLite in **WAL
mode** gives many concurrent readers and one writer, which comfortably covers a
dozen people doing warehouse operations — and the FIFO engine *wants* a single
writer. `assertStockLotsConsistent` and the cost-layer invariants are written
assuming one process owns the database, and on a server that becomes true rather
than merely assumed.

Revisit only if writes actually contend. They will not at this size.

---

## Plan

### Phase 1 — Foundation (ships to the current desktop app, no behaviour change)

The two things that must be right before a server exists.

1. **Per-request sessions.** `services/auth.ts` holds `currentUserId` as a single
   module-level variable — one signed-in user per process. That is correct for a
   desktop app and completely wrong for a server, where every request is a
   different person. Becomes a context passed to each handler: in Electron it is
   the one logged-in user, on the server it comes from the request's session
   token. **26 call sites of `currentUser()` across 7 files.**
2. **Transport-agnostic handler registry.** Handlers move from
   `ipcMain.handle(channel, fn)` into a table of
   `{ channel, permission, handler(ctx, ...args) }`. Electron binds it to IPC;
   the server binds the same table to routes. One definition, two transports —
   so the desktop app and the browser app can never drift.

Both are mechanical, both are testable, and the app behaves identically after.

### Phase 2 — The server

- Node + Fastify, `better-sqlite3` in WAL mode, serving the built renderer as
  static files.
- Session tokens in httpOnly cookies. `bcryptjs` is already in use for password
  hashing, so that part does not change.
- Permission checks stay exactly where they are — inside the handlers, reading
  from the request context instead of the global.
- **Backups from day one**, not later: nightly `VACUUM INTO` a dated copy, kept
  offsite. This is the moment the data stops being on someone's laptop and
  starts being the only copy that exists.

Hosting: a small VPS (~$10/month) with a domain and automatic HTTPS, Cloudflare
in front for DNS and TLS.

### Phase 3 — Browser client

- `lib/api.ts` becomes an HTTP client with the identical method shape. Every
  screen compiles and runs unchanged — this is the payoff for the boundary
  already being clean.
- Browser equivalents for the 14 desktop-bound handlers (table above).
- Login page replaces the Electron-window auth flow. "Remember me" currently uses
  the OS keychain via `safeStorage`, which has no browser equivalent; it becomes
  an ordinary long-lived session cookie.

### Phase 4 — Live data

The point of the whole exercise: when someone scans a box, everyone else's screen
should show it.

Simplest correct approach — the server broadcasts *what changed* over a WebSocket
after every mutating handler, and clients holding that data refetch. Deliberately
**not** a sync engine: no client-side merge, no conflict resolution, no offline
writes. The server stays the single source of truth, which is the only way an
inventory count and a FIFO cost basis stay correct with a dozen people touching
them.

### Phase 5 — Migrate the existing data

Much simpler than it sounds: **the schema is identical**, so the file itself
moves. `VACUUM INTO` a clean copy of the local database, upload it, point the
server at it. No export format, no field mapping, no re-import — the products,
stock, cost layers, ledger imports, scan history and audit trail all arrive
intact because they are the same rows in the same tables.

### Phase 6 — Cutover

Everyone moves to the URL. The desktop app can either be retired or kept pointed
at the same server for anyone who prefers it.

---

## What this changes about risk

Worth being explicit, because it is a real shift:

- **The data becomes a single shared thing.** Today a mistake affects one laptop.
  After this, a bad bulk inventory reset affects everybody at once. The
  preview-and-confirm design of the reset screen was already built for that; the
  backups matter more now.
- **It is on the internet.** Passwords, sessions and HTTPS stop being
  theoretical. The QuickBooks credentials in particular should be rotated and
  stored server-side as secrets, never in the repo.
- **There is no longer an offline mode.** No connection means no app. For
  warehouse work in a building with reliable wifi that is fine; it is worth
  knowing rather than discovering.
