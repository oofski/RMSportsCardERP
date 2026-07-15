# RM Operations App

The internal operations platform for **RM Cardz** — a single Windows/Mac desktop
app that will grow to house nine major modules. Current release: **v0.0.1** —
the app foundation, the **Admin** module, and a full **Time & Payroll** module.

> Navy-blue, professional, built to scale. SQLite today (same SQL dialect as
> Cloudflare D1), so the move to a shared cloud database later is a drop-in swap.

---

## What's in v0.0.0

- **App shell & branding** — navy theme, Inter typeface, sidebar navigation with
  all nine modules registered (Admin is live; the other eight show as "on the
  roadmap").
- **Accounts & sign-in**
  - First run creates the **Owner** account.
  - Employees sign in with their **Company ID or email** + password.
  - Passwords are hashed with bcrypt; sessions live in memory only.
- **Admin module**
  - **Employees** — create with first name, last name, Company ID, title, email
    and role. New employees get a **temporary password** and an **invite email**
    (pre-filled, opens in your mail client) explaining how to download/access the
    app and set their own password.
  - **Hours** — per-employee totals and a time-entry log (manual entry now;
    automatic clock-in/out arrives with the Time & Payroll module).
  - **Roles & Permissions** — three roles to start (**Owner**, **Operations**,
    **Staff**) with a permission matrix that grows as modules ship.
- **Check for updates** — available to every role. On **Windows** it checks,
  downloads and installs new versions automatically (via `electron-updater` +
  GitHub Releases). macOS auto-update is a later pass; today it points Mac users
  to the download page.

## New in v0.0.1 — Time & Payroll

- **Self-service time clock** on the Home page (every user): clock in / out with a
  live shift timer; a **rough location** is captured on each punch.
- **Time & Payroll module** (company-level): per-employee **timesheets** grouped by
  day and pay period, weekly-overtime totals, and **CSV export** — a detailed
  timesheet and a **Gusto-friendly hours summary** (single employee or whole team).
- **Admin › Hours** is now a high-level overview that links into Time & Payroll.
- **Individual permission overrides**: from Roles & Permissions, grant a specific
  person extra access on top of their role (e.g. give a Staff member "view hours").
- **Dark mode**, a **workspace switcher** (RM Cardz Operations, with RM Cardz
  Shipping coming soon), **Remember me** on sign-in, and **Check for updates**
  reachable from the top bar on every screen.

## The nine modules

| # | Module | Status |
|---|--------|--------|
| 1 | Admin (employees, hours overview, permissions) | ✅ Live |
| 2 | Time Tracker / Payroll (timesheets, Gusto export) | ✅ Live |
| 3 | Order & Fulfillment | 🚧 Roadmap |
| 4 | Shipping Tracking & CRM | 🚧 Roadmap |
| 5 | Bookkeeping / Business Ledger | 🚧 Roadmap |
| 6 | Invoice & Purchase Order Automation | 🚧 Roadmap |
| 7 | Chart of Accounts & Categorization | 🚧 Roadmap |
| 8 | SOP Creation | 🚧 Roadmap |
| 9 | Financial Forecasting | 🚧 Roadmap |

---

## Tech stack

- **Electron** + **electron-builder** — one codebase → downloadable Windows
  `.exe` and Mac builds.
- **React + TypeScript + Vite** (via `electron-vite`) — the UI foundation for all
  modules.
- **better-sqlite3** — local database. SQLite shares a dialect with **Cloudflare
  D1**, the intended shared cloud database.
- **bcryptjs** — password hashing.
- **electron-updater** — the "Check for updates" feature.

## Project layout

```
src/
  main/          Electron main process (window, DB, services, IPC)
    db/          SQLite schema + repositories (employees, time entries)
    services/    auth, email (invites), updater
  preload/       Secure contextBridge API exposed to the UI
  renderer/      React UI (screens, components, the Admin module)
  shared/        Types, roles/permissions, module registry (used by both sides)
```

---

## Running locally (development)

Requires **Node 20+**.

```bash
npm install     # also rebuilds the native SQLite module for Electron
npm run dev      # launches the app with hot reload
```

First launch drops you on the **workspace setup** screen — create the Owner
account and you're in.

### Handy scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | Run the app in development |
| `npm run typecheck` | Type-check main + renderer |
| `npm run build` | Bundle main/preload/renderer |
| `npm run build:win` | Build the Windows installer (`.exe`) |
| `npm run build:mac` | Build the Mac app (`.dmg` / `.zip`) |
| `npm run build:unpack` | Build an unpacked app for quick local testing |

Built installers land in `release/<version>/`.

> Building a Windows `.exe` is done on Windows (locally or via the included
> GitHub Actions workflow). Cross-building from Linux/Mac isn't supported here.

---

## Cutting a release (and enabling auto-update)

Auto-update reads from **GitHub Releases**. To ship an update:

1. Bump `version` in `package.json` (e.g. `0.0.0` → `0.0.1`).
2. Commit, then tag and push:
   ```bash
   git tag v0.0.1
   git push origin v0.0.1
   ```
3. The **Release** workflow (`.github/workflows/release.yml`) builds on Windows
   and Mac runners and attaches the artifacts to a GitHub Release.
4. Installed Windows copies will now find `0.0.1` under **Check for updates** and
   can download + install it.

---

## Where this is heading

- **Cloudflare**: swap the local SQLite repositories for a Cloudflare D1 database
  behind a Workers API so the whole team shares live data; host the web version on
  Cloudflare Pages for the Mac side of the team.
- **Per-employee permissions**: fine-grained overrides on top of roles, added
  alongside the modules that need them.
- **Mac auto-update**: code-sign + notarize so `electron-updater` works on macOS.
- The remaining **eight modules**, one at a time.
