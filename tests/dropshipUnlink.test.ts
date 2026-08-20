/**
 * A dropship link must not outlive the document at its other end.
 *
 * `invoices.source_po_id` and `purchase_orders.linked_invoice_id` are the two
 * halves of a dropship pair, and NEITHER has a foreign key behind it. So
 * deleting one document left the other pointing at a row that no longer existed.
 *
 * What is pinned here, and how each one fails if it is wrong:
 *
 *   1. THE BADGE OUTLIVES THE ORDER. `salesOrderKindOf` decides "Drop" and
 *      "Part drop" from sourcePoId, so a sale whose purchase order was deleted
 *      wore a dropship badge for ever, with nothing behind it to open. This is
 *      the defect the owner actually reported, one sales order at a time.
 *
 *   2. AND IT COULD NEVER BE REPAIRED FROM THE APP. `linkDropshipPair` refuses
 *      any document that already carries a pointer — "already came from another
 *      purchase order". A stale pointer therefore locked the sale out of ever
 *      being paired with the order raised to replace the deleted one. The only
 *      way out was editing the database by hand.
 *
 *   3. BOTH DIRECTIONS. Deleting the SALE left the purchase order claiming a
 *      buyer who no longer existed, which is the same trap facing the other way:
 *      that order could never be sold on to anybody else.
 *
 *   4. THE REPAIR ONLY TOUCHES ORPHANS. Databases already carry pointers broken
 *      by the old delete paths, so v80 clears them — and it is keyed on the
 *      target row being ABSENT, because a migration that cleared a LIVE pair
 *      would unlink real dropships across every machine that syncs.
 *
 * Every name here is invented.
 *
 * Run: npm run test:dropship-unlink
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/dropship-unlink-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const database = require('../src/main/db/database')
const poRepo = require('../src/main/db/purchaseOrders')
const inv = require('../src/main/db/invoices')
const { salesOrderKindOf } = require('../src/shared/invoices')

let db = database.getDb()

let pass = 0
let fail = 0
const ok = (c: boolean, n: string, e = ''): void => {
  if (c) {
    pass++
    console.log('  ok   ' + n)
  } else {
    fail++
    console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`)
  }
}

db.prepare(
  `INSERT INTO inventory_products (id, sku, name, category, unit_cost, created_at, updated_at)
   VALUES ('p_u', 'SKU-U', 'Unlink Hobby Box', 'Baseball', 40,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
).run()
require('../src/main/db/inventory').addStock('p_u', 'RM', 200, 40, null)

/** A purchase order shipping straight to a buyer — nothing lands on a shelf. */
const makePo = (destination: string): any =>
  poRepo.createPurchaseOrder(
    {
      supplier: 'Invented Distribution Co',
      location: destination,
      lines: [{ productId: 'p_u', quantity: 4, unitPrice: 40 }]
    },
    null
  )

/**
 * A sale off OUR OWN SHELF.
 *
 * Deliberately not a dropship line. This is the shape the owner reported: the
 * units come off RM, so the only thing that can make it read as a dropship is
 * `sourcePoId` — which is exactly the pointer under test. A sale with a genuine
 * dropship line would read as one whatever this pointer said, and would prove
 * nothing.
 */
const makeSo = (customer: string): any =>
  inv.saveInvoice(
    {
      customerName: customer,
      invoiceDate: '2026-05-02',
      location: 'RM',
      lines: [{ item: 'Unlink Hobby Box', productId: 'p_u', quantity: 4, rate: 90 }]
    },
    null
  )

const soKind = (id: string): string => {
  const so = inv.getInvoice(id)
  return salesOrderKindOf(so)
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. deleting the purchase order releases the sale ===')
// ---------------------------------------------------------------------------

const po1 = makePo('Fenwick Card Shop')
const so1 = makeSo('Fenwick Card Shop')
const linked = inv.linkDropshipPair(po1.id, so1.id, null)
const poId1 = po1.id
const soId1 = so1.id
ok(linked.ok, 'the pair links', linked.error ?? '')
ok(inv.getInvoice(soId1).sourcePoId === poId1, 'and the sale points at the order')
// "Part drop" — stock lines, plus a purchase order behind them. Exactly what
// the owner saw on 2337.
ok(soKind(soId1) === 'mixed', 'so it reads as PART DROP', soKind(soId1))

const del = poRepo.deletePurchaseOrder(poId1, null)
ok(del.ok, 'the purchase order deletes', del.error ?? '')
ok(
  inv.getInvoice(soId1).sourcePoId === null,
  'AND THE SALE LETS GO — no pointer to an order that is gone'
)
ok(
  soKind(soId1) === 'stock',
  'AND THE PART DROP BADGE GOES WITH IT, instead of outliving the order for ever',
  soKind(soId1)
)
// The whole reason the stale pointer mattered: it locked the sale out of the app.
const repair = inv.linkDropshipPair(makePo('Fenwick Card Shop').id, soId1, null)
ok(
  repair.ok,
  'AND THE SALE CAN BE PAIRED AGAIN — a stale pointer used to refuse this for ever',
  repair.error ?? ''
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. and the sale is only released when its OWN order goes ===')
// ---------------------------------------------------------------------------

const poKeep = makePo('Ridgeway Collectibles')
const soKeep = makeSo('Ridgeway Collectibles')
const poKeepId = poKeep.id
const soKeepId = soKeep.id
inv.linkDropshipPair(poKeepId, soKeepId, null)

const poOther = makePo('Somewhere Else Cards')
poRepo.deletePurchaseOrder(poOther.id, null)
ok(
  inv.getInvoice(soKeepId).sourcePoId === poKeepId,
  'deleting an UNRELATED order leaves this pair alone'
)

// ---------------------------------------------------------------------------
console.log('\n=== 3. deleting the sale releases the purchase order ===')
// ---------------------------------------------------------------------------

const linkOf = (poId: string): string | null =>
  (db.prepare(`SELECT linked_invoice_id AS v FROM purchase_orders WHERE id = ?`).get(poId) as
    | { v: string | null }
    | undefined)?.v ?? null

ok(linkOf(poKeepId) === soKeepId, 'the order points at the sale')
inv.deleteInvoice(soKeepId)
ok(
  linkOf(poKeepId) === null,
  'AND DELETING THE SALE MAKES THE ORDER LET GO — the mirror of section 1'
)
const resell = inv.linkDropshipPair(poKeepId, makeSo('New Buyer').id, null)
ok(resell.ok, 'so the order can be sold on to somebody else', resell.error ?? '')

// ---------------------------------------------------------------------------
console.log('\n=== 4. what happened is still on the record ===')
// ---------------------------------------------------------------------------

// The surviving document's own history is the ONLY place left that can say why
// its badge changed — the other document is gone, and so is its log.
const events = db
  .prepare(`SELECT detail FROM order_events WHERE order_kind = 'so' AND order_id = ?`)
  .all(soId1) as Array<{ detail: string }>
ok(
  events.some((e) => /link cleared/i.test(e.detail ?? '')),
  'the sale records that its link was cleared, and why',
  events.map((e) => e.detail).join(' | ')
)

// ---------------------------------------------------------------------------
console.log('\n=== 5. v80 repairs the pairs the old delete paths already broke ===')
// ---------------------------------------------------------------------------

const poLive = makePo('Still Here Cards')
const soLive = makeSo('Still Here Cards')
const poLiveId = poLive.id
const soLiveId = soLive.id
inv.linkDropshipPair(poLiveId, soLiveId, null)

// Exactly what the old code left behind: the row deleted, the pointer standing.
const soOrphan = makeSo('Orphaned Buyer')
const soOrphanId = soOrphan.id
db.prepare(`UPDATE invoices SET source_po_id = 'po_that_is_gone' WHERE id = ?`).run(soOrphanId)
db.prepare(`UPDATE purchase_orders SET linked_invoice_id = 'so_that_is_gone' WHERE id = ?`).run(
  makePo('Orphaned Shop').id
)
ok(
  inv.getInvoice(soOrphanId).sourcePoId === 'po_that_is_gone',
  'a stale pointer is in place, the way an older database carries one'
)

// Re-open with the marker cleared, which is what an older database looks like
// the first time it meets this version.
db.prepare(`DELETE FROM meta WHERE key = 'dropship_orphan_links_v80'`).run()
database.closeDb()
db = database.getDb()

ok(
  inv.getInvoice(soOrphanId).sourcePoId === null,
  'THE MIGRATION CLEARS IT — the badge comes off without anyone editing the database'
)
ok(
  (db.prepare(`SELECT COUNT(*) AS n FROM purchase_orders WHERE linked_invoice_id = 'so_that_is_gone'`).get() as {
    n: number
  }).n === 0,
  'and the other direction too'
)
ok(
  inv.getInvoice(soLiveId).sourcePoId === poLiveId,
  'WHILE A LIVE PAIR IS UNTOUCHED — a repair that unlinked real dropships would be far worse than the bug'
)
ok(
  (db.prepare(`SELECT linked_invoice_id AS v FROM purchase_orders WHERE id = ?`).get(poLiveId) as {
    v: string | null
  }).v === soLiveId,
  'in both directions'
)
ok(
  database.getMeta(db, 'schema_version') === '80',
  'and the schema says 80',
  String(database.getMeta(db, 'schema_version'))
)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
