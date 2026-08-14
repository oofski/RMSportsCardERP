# Open bugs — RM Operations App

Last updated at **v0.0.182**.

## How to read this, and one caveat up front

The original audit ran across 150 files and produced a ranked list that was
published as an artifact. **That artifact is no longer reachable from the build
environment** — the network policy blocks its host — so everything below v0.0.181
is a re-derivation from the code rather than a transcription of that list. The
practical consequence: the *fixed* section is exact (it is the commit history),
and the *open* section is everything I have since found and verified by reading
the code, not a guaranteed-complete copy of the original ranking. Where the
original list had items I have not independently rediscovered, they are not here.

Everything in "Still open" has been confirmed against the current source. Nothing
in it is a guess.

---

## Fixed so far — 16 findings, v0.0.178 → v0.0.182

Each one is pinned by a test that fails without the fix, and each was
mutation-tested: the guard removed, the suite confirmed red, the guard restored.

### v0.0.178 — seven

| # | Severity | What it was |
|---|---|---|
| 1 | CRITICAL | The container ran on UTC while the business runs on Central. Payroll bucketed overtime into the wrong week, availability could not be set after 19:00, the owner board read zero all evening. `configureBusinessTimeZone` now sets `process.env.TZ`; `render.yaml` sets it too. |
| 2 | CRITICAL | The USPS tracking-number regex matched the package **weight** instead of the tracking number. A greedy group with backtracking; the discriminator is that a weight has a decimal point and a tracking number never does. |
| 3 | CRITICAL | Editing a sales order forgot what had already shipped. `saveInvoice` rewrites lines and the INSERT did not name `qty_fulfilled`, so a memo edit reset 6-of-10 picked to 0-of-10 and the scan queue re-offered ten units already gone. |
| 4 | CRITICAL | `so_line` was missing from the scan-commit allowlist, so the IPC boundary rejected every sales-order scan-out. |
| 5 | HIGH | An oversized unauthenticated POST killed the whole server: `req.socket` is null after the body-size throw, and the TypeError inside the catch became an unhandled rejection. |
| 6 | HIGH | A hand-typed copy of the payment-terms list in `asTerms` silently mapped "Net 2" to Net 30 on read **and** write, so a buyer given two days got thirty. |
| 7 | HIGH | `createQboCustomer` referenced a bare `name` that only existed as a lib.dom global — a ReferenceError *after* the customer had been created in QuickBooks, so the natural retry made a duplicate contact. |

### v0.0.179 — five

| # | Severity | What it was |
|---|---|---|
| 8 | CRITICAL | An invoice could post to QuickBooks **twice**. The only guard read `invoice.qboId` off a snapshot taken before an await. Now an atomic SQL claim plus an in-flight set, and the Retry button has a busy state. |
| 9 | CRITICAL | Two machines minted the same PO number and the second order **silently vanished** — quarantined by sync with the cursor already past it. The allocator now reads the table, and sync renumbers a genuine clash instead of dropping it. Six more UNIQUE constraints on synced tables had the identical gap. |
| 10 | CRITICAL | `dedupeProducts` cascade-**deleted purchase order lines** (the FK is ON DELETE CASCADE and the table was not re-pointed), leaving orders with their stored total and no contents. Three more tables were left dangling. |
| 11 | CRITICAL | The same migration merged on the **name alone**, pooling two different boxes' shelves and FIFO cost lots. |
| 12 | HIGH | Changing a password revoked no sessions. Tokens issued against the old one kept working for up to 30 days. `revokeAllForEmployee` existed for exactly this and had zero callers. |
| 13 | HIGH | The login throttle could be spent without limit by forging `x-forwarded-for` — proxies *append*, and the code read the first entry. |

### v0.0.180 — two

| # | Severity | What it was |
|---|---|---|
| 14 | HIGH | Snapping an emptied cost layer to zero could outrun the shelf, breaking `Σ lot.qty_remaining == inventory_stock.quantity` permanently on any shelf with more than one layer. |
| 15 | MEDIUM | Found stock was priced at the average across **every** location, so finding two boxes at AM opened an AM layer at a blend of AM and RM — permanent, and straight into COGS. |

### v0.0.181 — four

| # | Severity | What it was |
|---|---|---|
| 16 | HIGH | An order listing the same product on two lines forgot half its picking on the next save, and the scan queue re-offered units already on a van. |
| 17 | MEDIUM | A replayed sales-order scan reported the stock as coming **in**. |
| 18 | MEDIUM | Rejecting an already-accepted intake submission left the customer it created in the shipping list while the submission read "rejected". |
| 19 | MEDIUM | A check-in form submitted with only a state and a zip **overwrote a complete stored address** with two fragments, leaving the next packing slip nowhere to send. |

---

## Still open

### 1. The QuickBooks bill/purchase double-post defence does not exist
**Severity: HIGH** · `src/main/db/qboSync.ts`

The schema comment on `qbo_sync_log` calls this table "the entire double-post
defence": QuickBooks has no bulk undo and no natural idempotency key on
Bill/Purchase/SalesReceipt, so "did we already send this?" can only be answered
locally.

**Nothing writes to it.** `beginSync`, `completeSync`, `failSync` and
`decideSync` — 228 lines including a canonical payload hash and a deliberate
"never auto-retry a pending row" rule — have **zero callers**. `listSyncRows` is
read by `IPC.qboSyncLog`, and the bridge exposes `qbo.syncLog()`, but no renderer
file calls it, so the screen it was built for does not exist either.

Invoices are safe — they have their own `qbo_id` column plus the guards added in
v0.0.179. Anything else pushed to QuickBooks has no protection at all.

*Not fixed because wiring it up is building a feature, not fixing a bug, and it
needs a decision about which entities push and what the screen shows.*

### 2. `supplies.quantity` is arbitrated by whoever wrote last
**Severity: MEDIUM** · `src/main/db/sync.ts` (`NEVER_OVERWRITE`, `touchedSupplies`)

A supply count is a number two machines can each overwrite. The current guard
stops an incoming row landing its stale count on an existing one, which handles
the common case, but the count is still a value rather than a counter.

The code says so itself, at length, and explains why the obvious fix (rebuild
from `supply_transactions` on apply) is *worse* than the problem: tier ordering
only holds inside a batch, a quarantined movement is never retried, and any count
that legitimately is not the sum of its movements gets silently rewritten. The
real fix — apply each movement's delta once, on first sight — is a bigger change.

### 3. A product dedupe can silently drop a child re-point
**Severity: MEDIUM** · `src/main/db/sync.ts` `resolveTwin`

When two machines create the same product and sync settles it, the loser's
children are re-pointed at the survivor inside a `try {} catch {}` that swallows
everything. `inventory_stock` is UNIQUE on (product_id, location), so if both
products have a row for RM the re-point throws and is silently skipped; the rows
are then removed by the delete. `rebuildDerivedStock` recovers the quantity from
the surviving lots, which is why this has not been visible — but it is a
correctness path that depends on a later repair rather than on being right.

### 4. De-duplicating a ledger row loses its sighting history
**Severity: LOW** · `src/main/db/sync.ts` `CHILD_REFS`

`ledger_rows` gained a natural-key dedupe in v0.0.179. Its child
`ledger_row_imports` is a WITHOUT ROWID table with no `id` column, so the generic
re-point loop cannot address it and the losing row's "import 3 also saw this
sale" lines go with it via cascade. The **sale itself** survives under the winning
id, which is the trade that was made deliberately; what is lost is one line of an
import's coverage report.

### 5. Login throttling is per-process and in memory
**Severity: LOW today, HIGH if the server is ever scaled** · `src/server/rateLimit.ts`

A redeploy forgets every counter, and two server processes would each allow the
full budget. Documented in `docs/WEB.md` rather than papered over. Fine at one
process; this becomes a real hole the day there are two.

### 6. `revokeAllForEmployee` is now an unused wrapper
**Severity: LOW** · `src/server/sessions.ts:136`

v0.0.179 moved the revocation into the credential write itself, which is what
closed the bug. The old entry point remains and has no callers. Harmless, but
it is the same shape as the thing that caused finding #12 — a function that looks
like the defence while nothing calls it.

### 7. A real customer name is still in git history
**Severity: MEDIUM (privacy)** · pre-existing, in an old `tests/invoices.test.ts`

The repository is **public**. Removing it requires rewriting history and a
force-push, which is the owner's call to make, not mine.

---

## Where the undiscovered bugs most likely are

These are not findings. They are the places where a finding would be invisible,
which is exactly the shape of six of the nine CRITICALs already fixed — each of
those was hidden from the suite *by construction*.

| Module | Lines | Test coverage |
|---|---|---|
| `src/main/db/shippingCalendar.ts` | 597 | **none** |
| `src/main/db/contactImport.ts` | 262 | **none** |
| `src/main/db/qboSync.ts` | 228 | **none** (and dead — see #1) |
| `src/main/db/vendorImport.ts` | 211 | **none** |
| `src/main/db/shipClaims.ts` | 200 | **none** |
| `src/main/db/timeEntries.ts` | 191 | **none** |
| `src/main/db/incoming.ts` | 123 | **none** |

`shippingCalendar.ts` is the one I would look at first: it is the largest, it is
entirely untested, and it does date arithmetic in a codebase whose own CLAUDE.md
lists date handling as a trap it has fallen into repeatedly.

The two importers are second, because they handle real customer and supplier
records and a silent mis-parse there is a wrong address on a package rather than
an error on a screen.

---

## The two structural notes worth keeping

**CI never runs the tests.** `Build & Typecheck` runs typecheck and build only, so
a suite that breaks fails on a laptop and nowhere else. `npm test` is 54 suites
and has to be run by hand before every push.

**A test suite can hide the bug it was written for.** The pattern behind most of
what was found: the harness pins a timezone production does not have; a 146-case
parser suite never asserts a tracking number; a scanning suite bypasses the IPC
boundary that rejected the call. When adding coverage, the question worth asking
is not "does this pass" but "what would this suite still pass with".
