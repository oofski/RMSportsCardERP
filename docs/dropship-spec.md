# Dropship & per-line routing — build spec

Status: ready to implement. Target schema version **67**.

---

## Summary

A purchase order stops being "one supplier, one destination, all of it lands on
our shelf". After this change:

1. **Destination is any party, not just a shelf.** RM and AM stay first and
   second in the picker; then pinned favourites; then every vendor and every
   invoice customer. RM and AM remain the **only stock-holding locations**.
2. **Dropship is derived, never stored as a flag.** An order whose units are all
   going somewhere that is not RM or AM displays as `Drop-0042` with a glow. The
   stored `po_number` is unchanged (`PO-0042`) and the counter is shared.
3. **A dropship allocation never touches on-hand stock.** No `inventory_stock`
   write, no `inventory_lots` row, no appearance in Incoming Inventory or the
   scan queue. COGS and the money book exactly as they do today.
4. **A line of quantity N can be split into allocations**, each carrying its own
   quantity, supplier and destination. A line with no split rows behaves exactly
   as it does today, byte for byte.

### Why rule 3 is absolute

`receivePoLine` calls `addStock`, and `addStock` **does not validate the
location** (`src/main/db/inventory.ts:947`). Given a customer's name it would
happily create a real `inventory_stock` row and a real FIFO layer keyed to that
name. `syncProductAvgCost` then calls `lotWeightedAvgCost`, which averages
`inventory_lots` **across all locations** (`src/main/db/lots.ts:488-500`) — so a
phantom layer at "Fenwick Cards" would move the unit cost, and therefore the
reported margin, of boxes physically sitting on the RM shelf.
`assertStockLotsConsistent` would still pass, because the phantom row is
internally consistent. Nothing in the app would catch it.

The reporting layer would disagree with itself too: `toProduct` builds
`quantityByLocation` over `LOCATION_IDS` only (`inventory.ts:104-106`), while
`PRODUCT_TOTALS` sums `inventory_stock` with no location filter
(`inventory.ts:1224`). Stock at a non-RM/AM location is invisible on the
dashboard and present in the products table, silently.

So the rule is not stylistic. It is the only thing standing between a dropship
and a wrong cost basis on real inventory.

---

## Data model

### Vocabulary (use these words in code and comments)

| Term | Meaning |
|---|---|
| **location** | `RM` or `AM`. A shelf. Stock can exist here. `isLocation()` decides. |
| **destination** | Where units are going: a *location*, or a party name (vendor/customer). A **wider** concept than a location. |
| **party** | A name from the vendor/customer directory, or from PO/receipt history. |
| **allocation** | A slice of a line: quantity + supplier + destination. |
| **stock allocation** | An allocation whose destination `isLocation()`. |
| **drop allocation** | An allocation whose destination does not. |

`isLocation()` in `src/shared/inventory.ts` **keeps its exact current meaning and
its current hard-coded body**. Nine call sites gate stock writes on it
(`inventoryIpc.ts:228,263,409,470,496,562,643`; `db/streaming.ts:870`;
`db/scanning.ts:496,552`). Do **not** widen it, and do **not** introduce an
`isDestination()` that shadows it. A destination is validated by a separate,
new predicate that is never used to gate a stock write.

### 1. New columns on `purchase_order_lines`

```sql
ALTER TABLE purchase_order_lines ADD COLUMN supplier    TEXT;  -- NULL = inherit header
ALTER TABLE purchase_order_lines ADD COLUMN destination TEXT;  -- NULL = inherit header
```

Both nullable, both defaulting to NULL. Every existing row keeps NULL, which
means "same as the header" — which is what those rows already meant.

### 2. New table: allocations

```sql
CREATE TABLE IF NOT EXISTS purchase_order_allocations (
  id           TEXT PRIMARY KEY,
  po_id        TEXT NOT NULL,
  po_line_id   TEXT NOT NULL,
  quantity     INTEGER NOT NULL,
  supplier     TEXT,
  destination  TEXT NOT NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  qty_received INTEGER NOT NULL DEFAULT 0,
  received_at  TEXT,
  created_at   TEXT NOT NULL,
  FOREIGN KEY (po_id)      REFERENCES purchase_orders (id)      ON DELETE CASCADE,
  FOREIGN KEY (po_line_id) REFERENCES purchase_order_lines (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_po_alloc_po   ON purchase_order_allocations (po_id);
CREATE INDEX IF NOT EXISTS idx_po_alloc_line ON purchase_order_allocations (po_line_id);
```

`po_id` is denormalised alongside `po_line_id` for the same reason
`po_line_receipts` does it: cascade correctness plus a one-table sweep per order.

**Invariants**, enforced in the write path (not by SQL constraints — SQLite
cannot express a cross-row sum):

* **I1.** For any line with allocation rows: `Σ allocations.quantity = line.quantity`.
* **I2.** For any line with allocation rows: `Σ allocations.qty_received = line.qty_received`.
* **I3.** A line with **zero** allocation rows is a line with **one implicit
  allocation** of the whole quantity at the line's effective supplier and
  destination. This is the entire back-compat mechanism.
* **I4.** `qty_received = 0` and `received_at IS NULL` for every drop
  allocation, permanently. Nothing ever receives one.
* **I5.** `quantity >= 1` on every allocation row. Zero-quantity splits are
  deleted, not stored.

### 3. New table: pins

```sql
CREATE TABLE IF NOT EXISTS order_party_pins (
  id         TEXT PRIMARY KEY,   -- derived: 'pin:' || lower(trim(name))
  name       TEXT NOT NULL,      -- the spelling to show
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

The id is **derived from the lower-cased name**, not minted, so two laptops
pinning the same shop write the same row and last-write-wins only ever compares
that row against an older copy of itself. Same reasoning as `availability` in
`syncTables.ts`.

RM and AM are **not rows here.** They are locations, not parties; they are
prepended in code and cannot be unpinned. Six user pins are shown before the
full list.

### 4. New columns on `po_line_receipts`

```sql
ALTER TABLE po_line_receipts ADD COLUMN allocation_id TEXT;
ALTER TABLE po_line_receipts ADD COLUMN location      TEXT;
-- backfill, one statement, existing rows only:
UPDATE po_line_receipts
   SET location = (SELECT po.location FROM purchase_orders po WHERE po.id = po_line_receipts.po_id)
 WHERE location IS NULL;
```

**This is required for correctness, not tidiness.** Three reversal paths
currently re-read the destination from the PO header:

* `reverseReceivedLines` — `purchaseOrders.ts:829-833`, `JOIN purchase_orders p … p.location`
* `forceDeletePurchaseOrder` — `purchaseOrders.ts:951-957`, same join
* `forceDeletePurchaseOrder` fallback — `purchaseOrders.ts:1028`, `stockQty(line.product_id, line.location)`

With per-line destinations, a header-derived location unwinds against the wrong
shelf, and the refusal message names a cause that is not the real one. After
this change all three read `po_line_receipts.location`.

### 5. New column on `inventory_scans`

```sql
ALTER TABLE inventory_scans ADD COLUMN po_allocation_id TEXT;
CREATE INDEX IF NOT EXISTS idx_inv_scans_po_alloc ON inventory_scans (po_allocation_id);
```

Undo (`db/scanning.ts:730-740`) decrements `purchase_order_lines.qty_received`.
It must decrement the allocation's counter too, or I2 breaks after any undo of a
scan against a split line.

### 6. The one definition of "where is each unit going" — a VIEW

Every query reads this. There is no second place to get it wrong.

```sql
CREATE VIEW IF NOT EXISTS po_unit_destinations AS
  SELECT l.po_id, l.id AS po_line_id, a.id AS allocation_id,
         a.quantity, a.qty_received, a.position,
         COALESCE(a.supplier,    l.supplier,    po.supplier) AS supplier,
         COALESCE(a.destination, l.destination, po.location) AS destination
    FROM purchase_order_lines l
    JOIN purchase_orders po ON po.id = l.po_id
    JOIN purchase_order_allocations a ON a.po_line_id = l.id
  UNION ALL
  SELECT l.po_id, l.id, NULL, l.quantity, l.qty_received, l.position,
         COALESCE(l.supplier, po.supplier),
         COALESCE(l.destination, po.location)
    FROM purchase_order_lines l
    JOIN purchase_orders po ON po.id = l.po_id
   WHERE NOT EXISTS (SELECT 1 FROM purchase_order_allocations a WHERE a.po_line_id = l.id);
```

The second arm is invariant I3 expressed in SQL: an unsplit line materialises as
exactly one row carrying its own quantity. **A legacy PO produces exactly the
rows it produced before, with `destination` equal to its header location.**

Stock-bound test in SQL is `destination IN ('RM','AM')`. That duplicates
`LOCATION_IDS`; a test asserts the two agree (see Test plan, T13).

> **TRAP — read `CLAUDE.md` before writing this migration.** `database.ts` is one
> enormous JS template literal. A backtick inside a SQL comment terminates it and
> produces a `TS1005` hundreds of lines away. Write the comments above this view
> with no backticks around column names. This has broken the repo five times.

### 7. Sync registration

In `src/main/db/syncTables.ts`:

```ts
{ table: 'order_party_pins',            key: ['id'], tier: 0 },   // beside invoice_customers
{ table: 'purchase_order_allocations',  key: ['id'], tier: 2 },   // child of a line, beside po_line_receipts
```

The view is schema, created by the migration on every machine; it is not synced
and must not be.

In `src/renderer/src/lib/live.ts`, add `purchase_order_allocations` and
`order_party_pins` to `LIVE.purchasing`, or the board will not repaint when a
split changes on another machine.

---

## Derivation rules

Put every one of these in `src/shared/purchaseOrders.ts` so the renderer and the
main process cannot disagree.

```ts
export type OrderKind = 'stock' | 'drop' | 'mixed'

/** A destination is a location, or any non-empty party name. */
export function isDestination(v: unknown): v is string

/** 'RM'/'rm'/'Rm' all canonicalise to 'RM'. Any other name is returned trimmed. */
export function canonicalDestination(v: string): string

/** RM/AM only. Delegates to isLocation — never reimplement the test. */
export function destinationHoldsStock(dest: string): boolean

export function orderKindOf(receivableUnits: number, dropUnits: number, headerDest: string): OrderKind

/** 'PO-0042' -> 'Drop-0042' for kind 'drop'. Display only. Never stored. */
export function displayOrderNumber(poNumber: string, kind: OrderKind): string
```

**R1 — effective supplier / destination.**
`allocation.x ?? line.x ?? header.x`. `header.destination` is
`purchase_orders.location`.

**R2 — canonicalisation on write.** A destination that case-insensitively equals
a location id is stored as the canonical upper-case id. Without this, `"Rm"`
typed by hand becomes a dropship to a shop called Rm, and the units silently
stop being receivable.

**R3 — order kind.** From the allocation set, not from the header:

| Condition | Kind | Number | Glow |
|---|---|---|---|
| `dropUnits == 0` | `stock` | `PO-0042` | no |
| `receivableUnits == 0 && dropUnits > 0` | `drop` | `Drop-0042` | yes |
| both `> 0` | `mixed` | `PO-0042` | yes, plus a split chip |
| no lines at all | falls back to the header destination | | |

**Why `mixed` reads `PO`, not `Drop`.** The prefix answers one question: *are
boxes coming to this building?* On a mixed order they are. The glow says part of
it never arrives; the chip names the split (`12 → RM · 8 → Fenwick Cards`).
Calling a mixed order `Drop` would tell the receiving desk to expect nothing.

**R4 — the stock decision is made PER ALLOCATION, never per order.** There is no
"this is a dropship PO" branch anywhere in the receiving code. Every write asks
one allocation whether its destination holds stock.

**R5 — receivable vs ordered.**

* `orderedUnits` = `Σ line.quantity`. **Meaning unchanged.** Includes drop units.
* `receivableUnits` = `Σ quantity` over stock allocations.
* `dropshipUnits` = `orderedUnits − receivableUnits`.
* `receivedUnits` = `Σ line.qty_received`. Unchanged. By I4 this is already
  exactly the stock-received figure, so **no new received column is needed.**

Progress bars measure `receivedUnits / receivableUnits`. Add one wrapper to
`@shared/receiving` and leave the tested arithmetic in that file untouched:

```ts
export function receivableProgressOf(
  lines: Array<{ qtyReceivable: number; qtyReceived: number }>
): ReceiveProgress {
  return receiveProgressOf(lines.map((l) => ({ quantity: l.qtyReceivable, qtyReceived: l.qtyReceived })))
}
```

**R6 — completion.** A PO auto-completes when every line with
`qtyReceivable > 0` has `qty_received >= qtyReceivable`. A PO with **no**
receivable lines (pure drop) **never** auto-completes — it is closed by hand on
the board. Legacy POs: `qtyReceivable == quantity` for every line, so R6 is the
current rule verbatim.

A mixed order reaching `received` means *everything due here is here*. There is
no signal in this app for "the shop got theirs", and inventing a fifth status
nobody can update would be worse. The receipt says so in words: *"All 12 units
due here are in. 8 drop-shipped to Fenwick Cards."*

---

## Backend surface

### `src/main/db/purchaseOrders.ts`

**`createPurchaseOrder(input, actorId)` — the line that kills the feature**

```ts
// purchaseOrders.ts:193 — CURRENT, must change:
const location = isLocation(input.location) ? input.location : LOCATION_IDS[0]
```

This **silently rewrites any non-RM/AM destination to `'RM'`.** Every dropship
would become an RM purchase order and every unit would land on the shelf. Replace
with:

```ts
const location = canonicalDestination(String(input.location ?? '').trim()) || LOCATION_IDS[0]
```

Empty still falls back to RM. An unrecognised name is **kept**, not coerced — a
one-off drop to a shop not yet in the directory must not require a detour into a
contacts screen first, which is the rule `ContactTypeahead` already states for
suppliers.

Also in create:

* Insert `supplier` / `destination` on each line when the draft carries them
  (NULL when it matches the header — store the inheritance, not a copy).
* Insert allocation rows only when a line was actually split. **An unsplit line
  writes zero allocation rows.**
* Validate I1 per line and I5 per allocation before any insert; reject the whole
  order naming the product and both numbers, in the style
  `receivePurchaseOrderLines` already uses.
* If the header supplier is empty **and** every line resolves to the same
  non-empty supplier, stamp the header with it. Keeps `listVendors` figures
  correct for the common "one supplier, several destinations" order without
  inventing an allocation of money across suppliers.
* `nextPoNumber`, `recordPoCogs` and the `total` computation are **unchanged**.
  The total includes drop lines.

**`receivePoLine` — one new optional parameter, appended**

```ts
export function receivePoLine(
  db: Database.Database,
  lineId: string,
  qty: number,
  note: string | null,
  actorId: string | null,
  allowOverage = false,
  /** Which slice of the line this receipt is against. Null resolves the line's
   *  STOCK allocations in position order — which for an unsplit line is the one
   *  implicit allocation, i.e. exactly today's behaviour. */
  allocationId: string | null = null
): ReceivedPoLine
```

Behaviour:

1. Resolve the target allocation(s) from `po_unit_destinations`, filtered to
   `destination IN ('RM','AM')`.
2. **If the resolved set is empty — every allocation on this line is a drop —
   THROW** `"<product> on <PO-0042> is drop-shipped to <dest>; it is not
   received into stock."` Throwing (not returning) matches the existing contract
   and rolls the caller's transaction back.
3. The outstanding clamp, the explicit-quantity refusal and the overage override
   are **unchanged**, but they now measure against the **allocation's**
   `quantity − qty_received`, not the line's.
4. `addStock(productId, allocation.destination, take, unit_price, note, actorId,
   effectiveSupplier)`. The location is the **allocation's** destination, and the
   vendor is the **allocation's** effective supplier — not the header's. That
   fixes a real defect the moment lines can carry their own supplier: the cost
   layer would otherwise name the wrong vendor in the lot picker.
5. Bump **both** `purchase_order_allocations.qty_received` and
   `purchase_order_lines.qty_received` (I2), stamping `received_at` on each when
   it reaches its own quantity.
6. Insert `po_line_receipts` with the new `allocation_id` and `location`.

**`completePoIfFullyReceived(db, poId)` — same signature, receivable denominator**

```sql
SELECT COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN r.received >= r.receivable THEN 1 ELSE 0 END), 0) AS done
  FROM (SELECT po_line_id,
               SUM(CASE WHEN destination IN ('RM','AM') THEN quantity     ELSE 0 END) AS receivable,
               SUM(CASE WHEN destination IN ('RM','AM') THEN qty_received ELSE 0 END) AS received
          FROM po_unit_destinations WHERE po_id = ? GROUP BY po_line_id) r
 WHERE r.receivable > 0
```

The existing `total === 0` guard now also covers the pure-drop case: no
receivable lines means no auto-completion, ever.

**`setPurchaseOrderStatus(id, 'received', actorId)`**

The outstanding loop selects **stock allocations only**:

```sql
SELECT allocation_id, po_line_id, quantity - qty_received AS outstanding
  FROM po_unit_destinations
 WHERE po_id = ? AND destination IN ('RM','AM') AND qty_received < quantity
 ORDER BY position, po_line_id
```

For a pure-drop order this returns nothing, so moving it to Received stamps the
status and books no stock — which is the manual way a Drop order is closed.
Everything else in this function (transitions, timestamps, cancel → reverse +
`voidPoCogs`) is unchanged.

**Cancel and delete for drop / mixed orders**

* **Cancel a pure-drop order** — nothing has `qty_received > 0`, so
  `reverseReceivedLines` finds no lines, `voidPoCogs` runs, the money comes back
  out of COGS. Correct today, correct after, no change needed beyond the receipt
  location fix.
* **Cancel a mixed order** — only the stock allocations ever received anything.
  Each is reversed against **`po_line_receipts.location`** (its own shelf), never
  the header. The pre-v20 refusal message is unchanged.
* **Delete** — still refused once `receivedUnits > 0`. A pure-drop order always
  has `receivedUnits == 0`, so **Delete is always available on a Drop order**,
  and Cancel is the right move only when the money should come out of COGS. Say
  so in the button's title text.
* **Force delete** — `removeStock: true` walks `po_line_receipts` and uses each
  receipt's own `location`; the `stockQty(...)` fallback at `:1028` uses the
  receipt's location, not `line.location`.

**`outstandingLinesForProduct(productId)` — the scan queue, narrowed**

Today it copies the **header** destination onto every candidate
(`purchaseOrders.ts:610` selects `po.location`, `:645` maps it to
`ScanPoCandidate.location`), which the ScanQueue draws as a pill and the commit
uses as the shelf. Under per-line destinations that is wrong twice over.

Rewrite to select from `po_unit_destinations` with `destination IN ('RM','AM')`,
returning **one candidate per stock allocation**:

* `allocationId: string | null` — new field, NULL for an unsplit line.
* `location` — the **allocation's** destination. Always RM or AM by construction.
* `quantity` / `qtyReceived` / `qtyOutstanding` — the **allocation's**. For an
  unsplit line these are the line's, i.e. unchanged.
* `poLinesTotal` / `poLinesOutstanding` / `completesPo` — computed over
  **receivable** lines only.

**Drop allocations never appear.** A product ordered only for dropship produces
zero candidates, so a scan of it resolves as `no_order` — the honest answer,
because those boxes are not in the building.

One line split 6 → RM and 6 → AM therefore yields **two** candidates. That is
deliberate: the shelf is the operator's choice, and silently picking one would
misplace six boxes.

**`listActivePurchaseOrderBoxes()` — same signature, narrowed result**

Add to the existing `WHERE`:

```sql
AND NOT (receivable_units = 0 AND drop_units > 0)   -- exclude PURE dropship orders only
```

Phrased as "pure dropship" rather than "has receivable units" on purpose: a
zero-line PO has both figures at 0 and keeps rendering exactly as it does today.

Lines are returned **re-projected**: `quantity` stays the ordered quantity,
`qtyReceivable` carries the stock-bound figure, and `allocations` is populated.
A line whose `qtyReceivable` is 0 (wholly drop) is still returned so the receipt
and the box can explain the gap — but it contributes **nothing** to any count.

**New functions**

```ts
/** RM, AM, pins, then every vendor and every invoice customer, deduped. */
export function listOrderParties(): OrderParty[]

/** Pin or unpin a party. Returns the fresh list. RM/AM are refused (permanent). */
export function setPartyPinned(name: string, pinned: boolean): OrderParty[]

/** Change a line's or an allocation's routing on an EXISTING order. */
export function setPurchaseOrderRouting(
  poId: string,
  patch: {
    lines?: Array<{ lineId: string; supplier?: string | null; destination?: string | null }>
    splits?: Array<{
      lineId: string
      allocations: Array<{ id?: string; quantity: number; supplier: string | null; destination: string }>
    }>
  }
): PoStatusResult
```

`setPurchaseOrderRouting` **refuses** when the PO is cancelled, or when any
affected line has `qty_received > 0`. Re-routing units that already landed on a
shelf would mean moving stock, which is Inventory's job and not this document's.
Refuse by name: *"12 units of X on PO-0042 have already been checked in;
re-route them by adjusting stock in Inventory."* It re-validates I1 and I5, and
runs in one transaction.

`OrderParty` (in `@shared/purchaseOrders`):

```ts
export interface OrderParty {
  name: string
  /** 'location' | 'vendor' | 'customer' | 'both' | 'history' */
  kind: OrderPartyKind
  /** Email · phone · city, when a contact record exists. */
  detail: string | null
  /** True only for RM and AM. Drives every stock/no-stock decision downstream. */
  holdsStock: boolean
  pinned: boolean
  /** Can this pin be removed? False for RM and AM. */
  pinnable: boolean
  /** Most recent order or receipt, ISO. Null = never dealt with. */
  lastAt: string | null
}
```

Ordering, top to bottom: **RM, AM** → user pins in `position` order (max 6 shown
before the fold) → everyone else, most recently dealt with first, then
alphabetical. That tiebreak is the one `listVendors` already uses and exists for
the same reason: without it every never-used directory name shares a null date
and comes back in map-insertion order.

Vendors and customers merge into **one** list, case-insensitively, exactly as
`listVendors` merges its three sources. A business that both buys and sells is
one row with `kind: 'both'` — the v62 decision, honoured.

**Supplier suggestions.** `listSupplierSuggestions` and `listVendors` gain a
fourth source: `DISTINCT` supplier from `po_unit_destinations`. It contributes
**names and `lastAt` only** — `orders` and `ordered` stay header-derived.
Apportioning a header total across line suppliers cannot be reconciled against
the stored `purchase_orders.total` without double counting, and quietly changing
the Vendors screen's money figures is not part of this change. Noted as a limit
below.

### IPC

`src/shared/ipc.ts` — three additions, following the existing `po:` prefix:

```ts
poParties:    'po:parties',
poPartyPin:   'po:party-pin',
poSetRouting: 'po:set-routing',
```

Handlers in `src/main/purchaseOrdersIpc.ts`:

| Channel | Gate | Returns |
|---|---|---|
| `po:parties` | `can('module.invoicing')`, else `[]` | `OrderParty[]` |
| `po:party-pin` | `requireInvoicing()` | `Result<OrderParty[]>` |
| `po:set-routing` | `requireInvoicing()` | `Result<PurchaseOrderDetail>` |

`po:parties` is gated on the same single permission as `po:suppliers` and for the
identical stated reason: it discloses contact detail, which `module.invoicing`
already grants via the Buyers tab.

Bridge additions in `src/bridge/index.ts` under `purchaseOrders`:
`parties()`, `pinParty(name, pinned)`, `setRouting(id, patch)`.

**`poReceiveLines` and `poScanIn` keep their gates and signatures.**
`PoReceiptItem` gains an optional `allocationId?: string | null`.

### Types (`src/shared/types.ts`)

```ts
export interface PurchaseOrderAllocation {
  id: string
  quantity: number
  /** Effective supplier after inheritance. */
  supplier: string | null
  /** Effective destination after inheritance. Always canonical. */
  destination: string
  /** destinationHoldsStock(destination). */
  holdsStock: boolean
  qtyReceived: number
  qtyOutstanding: number
  receivedAt: string | null
}
```

`PurchaseOrderLine` gains — **every existing field keeps its exact meaning**:

```ts
  /** Effective supplier when uniform across the line; null when the splits differ. */
  supplier: string | null
  /** Effective destination when uniform; null when the splits differ. */
  destination: string | null
  /** Units bound for RM or AM. Equals `quantity` on every legacy line. */
  qtyReceivable: number
  /** Empty when the line is not split. */
  allocations: PurchaseOrderAllocation[]
```

`PurchaseOrder` gains `orderKind: OrderKind`, `receivableUnits`, `dropshipUnits`,
`destinationCount`. **`location` keeps its name and its position on the type** —
it is now "the order's default destination".

`NewPurchaseOrderLine` gains optional `supplier`, `destination`, and
`allocations: Array<{ quantity; supplier: string | null; destination: string }>`.

`ScanPoCandidate` gains `allocationId: string | null`.
`ScanCommitInput` gains `allocationId?: string | null`.

---

## Why `purchase_orders.location` is NOT renamed

**Keep the column name.** Rename it and sync breaks in a way nobody will
diagnose from the symptom.

`upsertFor` in `src/main/db/sync.ts:237-256` discovers columns via
`PRAGMA table_info` and **silently filters out any column the receiving database
does not have** (`cols = Object.keys(data).filter((c) => known.has(c))`) — by
design, so a staggered rollout does not stop sync dead. So during any rollout
where one laptop is on the new build:

* New laptop pushes `destination` → old laptop drops it → the row lands with
  `location` untouched, i.e. at whatever it was before, defaulting to `'RM'`.
* Old laptop pushes `location` → new laptop drops it → the destination the
  operator chose is silently replaced by nothing.

Both directions produce a dropship that quietly became an RM purchase order,
with the stock consequence described at the top of this document. Widening the
meaning of an existing column costs one doc comment. Renaming it costs a data
incident.

---

## Frontend surface

### `CreatePurchaseOrderModal.tsx`

**Header.** The `<Select>` over `LOCATIONS` is replaced by `<DestinationPicker>`.
Default value `'RM'`; second entry `'AM'`. Everything else in the header row is
untouched.

**New `DestinationPicker.tsx`** (modelled on `ContactTypeahead`, same
`.typeahead` / `.ta-menu` / `.ta-item` markup):

| State | Rendering |
|---|---|
| closed | the chosen name; a `Drop` chip when `!destinationHoldsStock(value)` |
| open, no query | RM, AM, up to 6 pins, then the first 8 of the rest, with a `Show all` affordance |
| open, query | filtered on name **and** `detail` (email/city), 8 shown — same rule ContactTypeahead states |
| free text | whatever is in the box wins, matched or not |
| pin toggle | a star on each row; RM/AM render it filled and disabled |

**Lines table.** Two columns are added inline — **Supplier** and **Destination**
— each defaulting to the header value and shown muted while inherited, solid once
overridden. Clicking a line's product cell opens the pop-out.

**New `LineDetailModal.tsx` — the 7-column pop-out (requirement 4).**

| # | Column | Editable |
|---|---|---|
| 1 | Product (image, name, SKU, category) | no |
| 2 | Quantity | yes |
| 3 | Unit price | yes |
| 4 | Line total | derived |
| 5 | Supplier | yes — `ContactTypeahead`, pins first |
| 6 | Destination | yes — `DestinationPicker`, RM, AM, pins, then all |
| 7 | **Split** | yes — the allocation editor |

The split control is column 7. Collapsed it reads `1 destination` or
`3 destinations`. Expanded it shows one row per allocation: quantity stepper,
supplier picker, destination picker, remove. `Add split` appends a row taking
the unassigned remainder.

Live guard rail under the rows: **`Σ splits must equal <quantity>`**, showing the
running sum and the shortfall/excess. Save is disabled while I1 is violated. Zero
splits is valid and means "not split" — the modal deletes rather than stores a
single full-quantity allocation, so the unsplit path writes no rows at all.

Each split row carries a small `Drop` marker when its destination does not hold
stock, plus one line of copy the first time it appears: *"These units go straight
to the destination — they never reach RM or AM stock."*

### `PurchaseOrderReceipt.tsx`

* **`DeliveryPanel` is removed from this file** — the import, the render, and the
  `canReceive` prop. Requirement 1. The receipt may **show** what has arrived and
  may not **record** it.
* The **`ReceiveBar` and the per-line `ReceivePill` stay**, read-only, now fed by
  `receivableProgressOf(detail.lines)`.
* Modal title and `po-rh-num` use `displayOrderNumber(...)`.
* `po-rh-date` reads `Ships to RM` for a stock order, `Drop-ships to Fenwick
  Cards` for a drop order, and `2 destinations` for a mixed one.
* A `.po-receipt-drop` class on the root paints the glow for `drop` and `mixed`.
* Lines are **grouped by effective supplier** with a subheading per group when
  more than one supplier appears, so a multi-supplier order still reads as a
  document. Single-supplier orders render exactly as they do now: no subheading.
* Two columns are added to the line rows — Destination, and a split disclosure
  that expands to the allocation rows.
* A wholly-drop line shows a `Drop` pill in the `In` column instead of a progress
  pill, because there is no progress to report.
* Footer, PDF button, `FreightEditor` and the stage-move buttons are unchanged.

### `PurchaseOrderBoard.tsx` — `PoCard`

* `po-card-num` renders `displayOrderNumber(po.poNumber, po.orderKind)`.
* Card class gains `po-card-drop` when `orderKind === 'drop'` and
  `po-card-mixed` when `'mixed'`. **The glow is a class on the existing card, not
  a new card component** — a drop order is a purchase order.
* `po-card-dest` reads `→ RM`, `→ Fenwick Cards`, or `→ 2 destinations` with the
  full list in the `title`.
* `showProgress` is computed from `receivableUnits`, so a pure-drop card shows no
  progress rail at all — there is nothing arriving to measure.
* Drag, drop, move buttons and the `receivedUnits === 0` delete rule are
  unchanged.

**Stylesheet rule.** `tests/mobileLayout.test.ts` (assertion 3, line 176) asserts
that **no class name used in `styles/mobile.css` appears in `app.css` or
`theme.css`.** Define `.po-card-drop`, `.po-card-mixed` and `.po-receipt-drop`
in the **desktop** stylesheets only. If the phone layout needs to adjust the
glow, it must do so through an existing name or a mobile-only name, never by
mentioning these three. Adding a shared name to both files **will** fail
`npm run test:mobile`.

### `InventoryOverview.tsx` — Incoming Inventory

**`DeliveryPanel` stays here, and this is now its only home.** No change to its
props or behaviour.

For a **mixed** order (line X: 20 units, 12 → RM, 8 → Fenwick Cards):

* `PurchaseOrderBox` counts **12**, never 20. All of `summariseIncoming`,
  `IncomingPanel`'s headline, the Incoming orders tile, the hover card and
  `ownerDashboard.incomingOrders` read `qtyOutstanding` restricted to the
  **stock-bound** figure.
* `DeliveryPanel` offers **12** and its per-line `All` fills 12.
* `All of it arrived` (`scanIn`) receives 12 and completes the order.
* Under the box, one muted, **non-counting** caption:
  *"8 units drop-shipped to Fenwick Cards — not arriving here."* It exists so the
  box's 12 reconciles against the receipt's 20 without anybody opening the PO. It
  must never be added to any total.
* `po-ship-sub` reads `→ 2 destinations`.

For a **pure-drop** order: **the box does not appear at all.** Not greyed, not
collapsed — absent. Those boxes are not coming to the building.

### `ScanQueue` / `ScanPreview`

The candidate pill shows the **allocation's** destination. When one line yields
two candidates (6 → RM, 6 → AM) both are listed and the operator picks; the
chosen `allocationId` travels on `ScanCommitInput`. A product that exists only on
drop allocations resolves as `no_order`, unchanged in every other respect.

---

## The PO PDF for a Drop order (`src/main/poPdf.ts`)

The PDF is the document **the supplier receives**. For a dropship the supplier is
the party who physically ships to the destination, so the destination must be on
it — printing it is the point, not a leak to be plugged. Be plain about the
consequence: **a dropship PDF discloses the destination party, usually a
customer, to the vendor. That is inherent to dropshipping**, and if the owner
ever wants a redacted variant it is a separate decision, not a default.

Changes, all additive:

1. `<title>`, the `<h1>` and the footer use `displayOrderNumber(...)` →
   `Drop-0042`. The **filename** follows (`Drop-0042.pdf`).
2. The meta block's third cell is relabelled from **Destination** to **Ship to**
   (`poPdf.ts:166`) and prints the effective destination. For a mixed order it
   prints `Multiple — see lines`.
3. For `drop` and `mixed`, a bordered **DROP SHIP** banner sits under the header:
   *"Ship directly to the address below. Do not ship to RM Sportscards."*
4. Under it, a **Ship to** block: the destination name, plus its address when the
   name matches an `invoice_customers` row. Name only when it does not.
5. The 5-column item table gains **Supplier** and **Destination** columns **only
   when the order is mixed or multi-supplier.** A single-supplier, single-
   destination order — which is every legacy PO — renders the **existing
   5-column table unchanged**.
6. A split line prints its allocations as indented sub-rows under the line, with
   quantity, supplier and destination and no repeated money.
7. `STATUS_LABEL`, the totals block, `shipMeta` and the notes block are
   unchanged. The `Units` total remains `Σ line.quantity` — the whole order.

---

## Migration & back-compat

Schema **v67**, one block in `src/main/db/database.ts` following the existing
`addColumnIfMissing` / `CREATE TABLE IF NOT EXISTS` convention, ending
`setMeta(database, 'schema_version', '67')`.

```
addColumnIfMissing purchase_order_lines.supplier     TEXT
addColumnIfMissing purchase_order_lines.destination  TEXT
addColumnIfMissing po_line_receipts.allocation_id    TEXT
addColumnIfMissing po_line_receipts.location         TEXT
addColumnIfMissing inventory_scans.po_allocation_id  TEXT
CREATE TABLE       purchase_order_allocations
CREATE TABLE       order_party_pins
CREATE VIEW        po_unit_destinations
UPDATE             po_line_receipts SET location = <header location> WHERE location IS NULL
```

**No allocation rows are written for any existing purchase order. Ever.** That
single fact is what makes requirement (b) true, and it is worth stating as the
migration's whole contract:

An existing PO has `location` in `('RM','AM')` and NULL in both new line columns.
Therefore:

* the view's second arm produces exactly one row per line, at the header
  location — **the same destination the old code read from the header**;
* every unit is stock-bound, so `receivableUnits == orderedUnits` and
  `dropshipUnits == 0`;
* `orderKind` is `'stock'`, so the number renders `PO-0042` with no glow;
* `qtyReceivable == quantity` on every line, so every progress bar, every
  completion test and every Incoming count produces the number it produces today;
* `outstandingLinesForProduct` returns one candidate per line with
  `allocationId: null` and the header location — identical to today;
* `receivePoLine` with `allocationId: null` resolves the one implicit allocation
  and writes stock exactly as it does today;
* `po_line_receipts.location` is backfilled to the header location, which is what
  the reversal paths were reading anyway, so cancel and force-delete behave
  identically.

**Rollout safety.** An older build reading a v67 database sees columns and tables
it does not know and ignores them; it also ignores the view. It reads
`purchase_orders.location` and gets a party name on a dropship, which it will
render as a location string in a badge and — critically — **will attempt to
receive into**. There is no way to prevent that from this side. Mitigation:
`schema_version` is already bumped, and the release notes must say that dropship
POs require every machine on the build. Flag it in Open risks.

---

## What must not change

The reviewer checks this list.

**Money and ledgers**

1. `recordPoCogs` is still called once, at PO creation, for the **full** order
   total including drop lines. Same rounded total, same timestamp.
2. `voidPoCogs` is still the single void point, called only from cancel and
   delete.
3. `purchase_orders.total` is still `Σ(round(qty) × max(0, unitPrice))` rounded
   to cents, computed identically.
4. Nothing is booked to COGS on receipt. Ever.

**Numbering**

5. `nextPoNumber` is untouched: `po_seq` in `meta`, `'PO-' + pad(4)`.
6. `purchase_orders.po_number` stores `PO-0042` for a dropship too. The `Drop`
   prefix is computed at render time and stored nowhere.
7. Drops and POs share one counter, so the sequence has no gaps and no branches.

**Schema and sync**

8. `purchase_orders.location` keeps its name, type, `NOT NULL` and `'RM'`
   default.
9. `isLocation` keeps its exact body and its exact meaning. RM and AM remain the
   only stock-holding locations. All nine existing gates keep gating.
10. `LOCATIONS` / `LOCATION_IDS` are not extended. A party is not a location.
11. No existing synced table is removed or re-keyed; no `tier` changes.

**Receiving arithmetic**

12. `purchase_order_lines.qty_received` still means *units folded into on-hand
    stock here*, and is still zero for anything that never arrived.
13. `receiveProgress` / `receiveProgressOf` / `receiveSummary` / `receiveShort` /
    `receiveTone` in `@shared/receiving` are **not edited**. The 1..99 clamp
    stays. New behaviour arrives as a wrapper above them.
14. Over-receipt is still **refused and named** for a typed quantity, and still
    **clamped** for a scan. The `allowOverage` override still has to be chosen.
15. A whole delivery is still one transaction; a refusal on line seven still
    rolls back lines one to six.
16. `completePoIfFullyReceived` still writes no COGS and still stamps
    `scanned_at`, which is still what retires a box from Incoming.
17. `receivePoLine` still **throws** rather than returning an error, and is still
    called inside the caller's transaction, opening none of its own.
18. `po_line_receipts` is still written once per receipt, and cancel still
    unwinds newest-first against each receipt's own lot.
19. The pre-v20 "cannot be cancelled safely" refusal keeps its exact wording and
    its exact trigger.

**Stock**

20. `addStock` is not modified. `adjustStock`, `reverseStockReceipt`,
    `createLot`, `syncProductAvgCost` are not modified.
21. **No `inventory_stock` row, `inventory_lots` row or `inventory_transactions`
    row is ever written at a location that is not RM or AM.** This is the
    load-bearing invariant of the whole change.

**Behaviour of existing orders**

22. Every PO in the database before the upgrade renders, receives, cancels,
    deletes, scans, prints and syncs exactly as it did.
23. `tests/receiving.test.ts` and `tests/scanning.test.ts` pass **unedited**.

**Permissions**

24. Every PO write is still gated on `module.invoicing`; `poScanIn`,
    `poReceiveLines` and `poIncomingBoxes` still accept `module.inventory` **or**
    `module.invoicing`. No new permission is introduced.

---

## Test plan

New suite `tests/dropship.test.ts`, `npm run test:dropship`, appended to the
`test` script in `package.json` (the suite count goes 45 → 46). Same harness as
`tests/receiving.test.ts`: `TEST_DB_DIR`, `require` the repo modules, `ok(...)`
counters.

**Back-compat — the half the reviewer cares about most**

* **T1.** A PO created with `location: 'RM'` and no line routing writes **zero**
  rows to `purchase_order_allocations`.
* **T2.** For that PO, `po_unit_destinations` returns exactly one row per line,
  `destination = 'RM'`, `quantity` = the line quantity.
* **T3.** `getPurchaseOrder` on it reports `orderKind === 'stock'`,
  `receivableUnits === orderedUnits`, `dropshipUnits === 0`, and
  `qtyReceivable === quantity` on every line.
* **T4.** `displayOrderNumber(po.poNumber, 'stock') === 'PO-0001'`.
* **T5.** Receiving it moves stock, opens a lot and completes the PO with the
  same figures as `tests/receiving.test.ts` asserts today.
* **T6.** `tests/receiving.test.ts` and `tests/scanning.test.ts` **pass
  unedited.** Non-negotiable — it is the proof existing behaviour is untouched.

**Destination is not coerced**

* **T7.** `createPurchaseOrder({ location: 'Fenwick Cards', ... })` stores
  `'Fenwick Cards'` — **not** `'RM'`. This is the `purchaseOrders.ts:193` guard.
* **T8.** `createPurchaseOrder({ location: 'rm' })` stores `'RM'` (R2).
* **T9.** `createPurchaseOrder({ location: '' })` stores `'RM'` (unchanged
  fallback).

**A dropship never touches stock**

* **T10.** Pure-drop PO, 10 units. After create: `inventory_stock` has **no** row
  at that destination; `inventory_lots` has none; the product's `quantity` and
  `unitCost` are byte-identical to before the PO existed.
* **T11.** `receivePoLine` against a drop allocation **throws**, and the message
  names the product and the destination.
* **T12.** `setPurchaseOrderStatus(dropPo, 'received')` returns no error, stamps
  the status, and writes **zero** stock rows and zero lots.
* **T13.** `LOCATION_IDS` matches the `IN ('RM','AM')` list compiled into
  `po_unit_destinations` — a guard against the SQL and the TS drifting apart.
* **T14.** After a full drop-order lifecycle (create → paid → received →
  cancelled), `lotWeightedAvgCost(productId)` is unchanged from its value before
  the order existed. This is the cost-basis hazard, pinned.

**Invisibility**

* **T15.** `listActivePurchaseOrderBoxes()` does **not** include a pure-drop PO.
* **T16.** It **does** include a mixed PO, and that PO's `qtyReceivable` counts
  only the RM/AM units (12, not 20).
* **T17.** `outstandingLinesForProduct` returns **zero** candidates for a product
  ordered only on drop allocations.
* **T18.** For a line split 6 → RM and 6 → AM it returns **two** candidates with
  distinct `allocationId` and `location` values.
* **T19.** `ownerDashboard` incoming units for a mixed order equal the stock-bound
  outstanding figure.
* **T20.** A zero-line PO still appears in Incoming exactly as it does today (the
  "pure dropship" phrasing of the filter, not "has receivable units").

**Badge and number**

* **T21.** all-drop → `Drop-0042`, `orderKind === 'drop'`.
* **T22.** mixed → `PO-0042`, `orderKind === 'mixed'` (glow, not rename).
* **T23.** Numbers are consecutive across a PO, a Drop and a PO — one counter.
* **T24.** No `Drop-` string is ever written to `purchase_orders.po_number`.

**Splits**

* **T25.** I1: a create whose splits sum to 19 on a line of 20 is **refused**,
  naming the product and both numbers, and writes nothing.
* **T26.** I5: a zero-quantity split is refused.
* **T27.** I2: after receiving 5 of a 12-unit RM allocation, the allocation's
  `qty_received` is 5 and the line's is 5.
* **T28.** After undoing that scan, both are 0 (the `po_allocation_id` path).
* **T29.** `setPurchaseOrderRouting` is refused on a line with
  `qty_received > 0`, and the message says to adjust stock in Inventory.
* **T30.** A mixed order auto-completes when its **12 receivable** units are in,
  even with 8 drop units outstanding; a pure-drop order **never**
  auto-completes.

**Money and reversal**

* **T31.** A drop PO's COGS row equals its full total, drop lines included.
* **T32.** Cancelling it removes the COGS row and touches no stock.
* **T33.** Cancelling a mixed order reverses the stock half against the
  **receipt's own location**, not the header's — asserted with a line whose
  allocation went to AM on an order whose header says RM.
* **T34.** `forceDeletePurchaseOrder(removeStock: true)` on that same order
  removes the units from AM and reports `removedUnits` correctly.
* **T35.** Deleting a pure-drop PO succeeds (`receivedUnits === 0`).

**Parties and pins**

* **T36.** `listOrderParties()[0].name === 'RM'`, `[1].name === 'AM'`, both
  `holdsStock: true`, `pinnable: false`.
* **T37.** A pinned vendor appears at index 2, before any unpinned name.
* **T38.** A contact that is both vendor and customer appears **once**, with
  `kind: 'both'`.
* **T39.** `setPartyPinned('RM', false)` is refused.
* **T40.** The pin row's id is `'pin:' + lower(name)` — two "pins" of the same
  shop in different cases produce one row.

**Regression guards**

* **T41.** `npm run test:mobile` passes: none of `po-card-drop`,
  `po-card-mixed`, `po-receipt-drop` appears in `styles/mobile.css`.
* **T42.** `npm run test:vendors` passes unedited — line-level suppliers add
  names without changing any existing `orders` or `ordered` figure.
* **T43.** Full gate: `npm run typecheck && npm run build && npm test`, all
  three, per `CLAUDE.md`. CI never runs the tests.

---

## Open risks

1. **`po_seq` lives in `meta`, and `meta` is deliberately not synced**
   (`syncTables.ts:31-33`). Two machines offline mint the same
   `PO-0043`; `po_number` is `UNIQUE`, so the second machine's insert fails hard
   on pull. This is **pre-existing and out of scope here**, but drops share the
   counter, so this change roughly doubles the number of documents contending for
   it. *Recommendation for a separate change:* derive the number at insert from
   `MAX(po_number)` inside the create transaction, or seed each machine's
   sequence with a per-install offset; do not "fix" it by giving drops their own
   counter, which the owner explicitly ruled out.

2. **A mixed order reaching `received` says nothing about the drop half.** There
   is no signal in this app for "the shop got theirs" and no screen to enter one.
   If the owner later wants that, it is a per-allocation `delivered_at` stamped
   by hand, not a fifth PO status.

3. **Mixed-version rollout.** An older build reads `purchase_orders.location`,
   gets a party name, and will try to receive into it — creating exactly the
   phantom cost layer this document exists to prevent. Nothing on the v67 side
   can stop it. Ship this to every machine before anybody raises a dropship, and
   say so in the release notes.

4. **A party named `RM` or `AM`.** `canonicalDestination` would fold it into the
   shelf and the units would become receivable. Vanishingly unlikely, silently
   wrong if it happens. Mitigation if wanted later: refuse to save a contact
   whose name case-insensitively equals a location id.

5. **Vendor spend figures ignore line-level suppliers.** `listVendors` still
   attributes a whole order's total to the header supplier. A genuinely
   multi-supplier order therefore overstates one vendor and understates another.
   Fixing it means apportioning `Σ(qty × price)` per supplier and reconciling
   against the stored header total — a separate change with its own test for the
   reconciliation.

6. **The dropship PDF discloses the destination to the vendor.** Inherent to
   dropshipping and required for the vendor to ship, but it is a real disclosure
   of a customer relationship. Named here so nobody discovers it from a customer.

7. **Split UI complexity on a phone.** The 7-column pop-out is a desktop layout.
   The phone build must degrade it to a stacked card per allocation rather than
   scrolling seven columns sideways — and must do so with mobile-only class names
   (see T41).
