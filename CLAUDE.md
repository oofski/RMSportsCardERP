# RM Operations App — working notes

## Releases are opt-in

**Do NOT put `[release]` in a commit message unless the owner has explicitly
asked for a build.** That marker is the only thing that triggers
`.github/workflows/release.yml`, which builds and publishes the Windows `.exe`
and the Mac `.dmg`/`.zip` and moves the auto-update feed everyone's installed
copy follows.

An ordinary push still runs `Build & Typecheck`, which is the check that
matters day to day. Cutting an installer for every change costs ~10 minutes of
CI, pushes an update prompt at everyone using the app, and buries the releases
that were actually worth shipping.

So the default is: bump nothing, commit, push. Version bumps and `[release]`
happen when asked for.

## Verify before pushing

`npm run typecheck && npm run build && npm test` — all three, every time. CI
runs typecheck and build but **never runs the tests**, so a suite that breaks
only fails locally. `npm test` is currently 33 suites.

## Traps this repo has fallen into

**A backtick inside a SQL comment inside a JS template literal terminates the
literal.** `src/main/db/database.ts` is one enormous template string, and this
has broken it five separate times — always as a baffling `TS1005: ',' expected`
hundreds of lines away. Never write `` `column_name` `` in a migration comment.

**Secrets must never be committed.** The repo is PUBLIC. The cloud-sync relay
URL and key are injected at build time from the GitHub secrets `RMOPS_SYNC_URL`
and `RMOPS_SYNC_KEY`; the QuickBooks OAuth client id and secret are entered by
the operator at runtime and stored locally. Grep the diff before every commit.

**Dates are parsed at UTC noon, never local midnight.** A date-only string
parsed as local midnight and shifted across a daylight-saving boundary lands on
23:00 the previous day and rounds the wrong way. See `addDays` in
`@shared/homeTasks`, `@shared/schedule` and `@shared/invoices` — three copies,
each with the same reason written down.

**Wall clock vs instant.** A shift or an availability answer is a local day plus
local `HH:MM` (an intention). A clock-in is a UTC ISO instant (a physical
event). Do not convert one into the other.
