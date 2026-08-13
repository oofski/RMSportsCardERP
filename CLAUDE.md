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

### "Ship it" means the WEB app, not an installer

The owner's day-to-day target is the web app on Render, and **every push to
`claude/rm-operations-app-initial-3sml0r` redeploys it automatically** — no
version bump, no marker, nothing to ask for. Pushing IS shipping.

So when the owner asks for something to be updated, live, out, or "in a new
version", the finished job is: verify, commit, push. Stop there and say the web
app is updating.

The `.exe` and the `.dmg` are a SEPARATE, occasional thing that the owner asks
for in those words — "cut a release", "I need the installers", "release it".
Words like "push a new version" are NOT that request; they have meant the web
app every time. When it is genuinely ambiguous, push without the marker and
ask, because an unwanted installer cannot be taken back: it moves the
auto-update feed and prompts everybody's installed copy.

## Verify before pushing

`npm run typecheck && npm run build && npm test` — all three, every time. CI
runs typecheck and build but **never runs the tests**, so a suite that breaks
only fails locally. `npm test` is currently 51 suites.

## Traps this repo has fallen into

**A backtick inside a SQL comment inside a JS template literal terminates the
literal.** `src/main/db/database.ts` is one enormous template string, and this
has broken it five separate times — always as a baffling `TS1005: ',' expected`
hundreds of lines away. Never write `` `column_name` `` in a migration comment.

**A literal control character in source is invisible until it is pasted.** A
regex class in `cloud/worker.js` was written with a real NUL and a real U+001F
where a space and a hyphen belonged. Node accepted it — the class read as the
ascending range U+0000–U+001F — so `node --check` passed and it shipped.
Cloudflare's editor strips the NUL on paste, which left the hyphen between `/`
(U+002F) and U+001F: a descending range, and the Worker would not save. The
relay suite now fails on any literal control character in that file, because no
editor, diff or review can see one. Write every character class member as an
escape.

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
