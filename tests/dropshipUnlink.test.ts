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
const { linkPurchaseRefusal, linkableOrder } = require('../src/shared/orders')

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
// The MARKER, not the version number. Asserting schema_version === '80' pinned
// the schema as it stood the day this was written, so the next migration broke
// a test about dropship links — which is noise, and the kind of noise that
// teaches people to edit assertions without reading them.
ok(
  database.getMeta(db, 'dropship_orphan_links_v80') === '1',
  'and the repair records that it ran, so it never runs twice',
  String(database.getMeta(db, 'dropship_orphan_links_v80'))
)
ok(
  Number(database.getMeta(db, 'schema_version')) >= 80,
  'on a schema at or past the version that introduced it',
  String(database.getMeta(db, 'schema_version'))
)

// ---------------------------------------------------------------------------
console.log('\n=== 6. a purchase order can see that its sale has nothing yet ===')
// ---------------------------------------------------------------------------
/**
 * `saleAwaitsItems` is a subquery, and a subquery is exactly the kind of thing
 * that reads plausibly and returns the wrong row. What it drives is the blue
 * stripe on the purchase board: when the sale on the other end has nothing in
 * hand, THIS is the order somebody has to chase.
 */
const chasePo = makePo('Chase Card Co')
const chaseSo = makeSo('Chase Card Co')
inv.linkDropshipPair(chasePo.id, chaseSo.id, null)
ok(
  poRepo.getPurchaseOrder(chasePo.id).saleAwaitsItems === true,
  'a linked sale with nothing in hand lights its purchase order up',
  String(poRepo.getPurchaseOrder(chasePo.id).saleAwaitsItems)
)
inv.setInvoiceItemsInHand(chaseSo.id, true, null)
ok(
  poRepo.getPurchaseOrder(chasePo.id).saleAwaitsItems === false,
  'AND GOES OUT THE MOMENT THE GOODS ARE CONFIRMED'
)
// Null, not false: "no sale behind this order" and "its sale has what it needs"
// are different facts, and folding them together would light up every ordinary
// purchase order on the board.
ok(
  poRepo.getPurchaseOrder(makePo('Nobody Linked').id).saleAwaitsItems === null,
  'A PURCHASE ORDER WITH NO SALE BEHIND IT READS NULL, not false — otherwise every ordinary order would be lit'
)
// And a voided sale is nobody's problem.
inv.setInvoiceItemsInHand(chaseSo.id, false, null)
inv.setInvoiceStatus(chaseSo.id, 'void', null)
ok(
  poRepo.getPurchaseOrder(chasePo.id).saleAwaitsItems === false,
  'a VOIDED sale stops asking for anything'
)

// ---------------------------------------------------------------------------
console.log('\n=== ATTACHING A PURCHASE ORDER TO A SALE THAT IS ALREADY WRITTEN ===')
// ---------------------------------------------------------------------------
/**
 * The owner's case, in his words: "made an invoice for a ton of stuff going to
 * one buyer, two of the cases are being drop shipped, I made a PO for the two
 * drop ship sources, didn't make any new SOs - can I make any changes on the SOs
 * page to show the two dropships without changing the invoice or invoicing
 * again?"
 *
 * He could not. `linkDropshipPair` does exactly this and has no status guard,
 * but its only two callers both fired in the moment after a brand-new document
 * was created - sell first and the app offers to write the purchase, buy first
 * and it offers to write the sale. Neither could be told the other half already
 * existed, and the modal's own footnote told people to choose "Not now" if the
 * goods were "bought already", which left the pair unrecorded.
 *
 * `linkablePurchaseOrders` is the read the picker needed. What it must get right
 * is WHAT IT DOES NOT DO: no line, no total, nothing in QuickBooks.
 */
{
  const buyer = 'Ryan Rubin'
  const sale = inv.saveInvoice(
    {
      id: null,
      customerName: buyer,
      invoiceNumber: 'SO-7700',
      invoiceDate: '2026-08-20',
      location: 'RM',
      lines: [{ item: 'Tribute Baseball Case', quantity: 10, rate: 900, amount: 9000 }]
    },
    null
  )
  // Already sent: this is the state the owner is actually in, and the state in
  // which nothing about the document may be touched.
  db.prepare(`UPDATE invoices SET status = 'sent', qbo_id = 'qbo-7700' WHERE id = ?`).run(sale.id)

  const supplierPo = poRepo.createPurchaseOrder(
    { supplier: 'Kestrel Cards', location: buyer, lines: [] },
    null
  )
  const shelfPo = poRepo.createPurchaseOrder(
    { supplier: 'Longwood Wax', location: 'RM', lines: [] },
    null
  )
  const deadPo = poRepo.createPurchaseOrder(
    { supplier: 'Gone Distributors', location: 'RM', lines: [] },
    null
  )
  poRepo.setPurchaseOrderStatus(deadPo.id, 'cancelled', null)

  const offered = inv.linkablePurchaseOrders(sale.id)
  const has = (id: string): boolean => offered.some((o: any) => o.poId === id)
  ok(has(supplierPo.id) && has(shelfPo.id), 'every live purchase order is offered')
  ok(
    !has(deadPo.id),
    'A CANCELLED ONE IS NOT - nothing on it is being bought',
    offered.map((o: any) => o.poNumber).join(',')
  )
  /**
   * NEWEST FIRST out of the read itself, not just out of the shared ranker. A
   * purchase raised for a sale is raised near it in time, and a picker that
   * opens on the oldest order in the company is one nobody scrolls to the end
   * of.
   */
  db.prepare(`UPDATE purchase_orders SET ordered_at = '2026-01-05T00:00:00.000Z' WHERE id = ?`).run(
    shelfPo.id
  )
  db.prepare(`UPDATE purchase_orders SET ordered_at = '2026-08-22T00:00:00.000Z' WHERE id = ?`).run(
    supplierPo.id
  )
  const byDate = inv.linkablePurchaseOrders(sale.id).filter((o: any) =>
    [supplierPo.id, shelfPo.id].includes(o.poId)
  )
  ok(
    byDate[0].poId === supplierPo.id && byDate[1].poId === shelfPo.id,
    'THE READ COMES BACK NEWEST FIRST',
    byDate.map((o: any) => `${o.poNumber}@${o.orderedOn}`).join(' , ')
  )
  ok(byDate[0].orderedOn === '2026-08-22', 'as a DAY, not a timestamp', String(byDate[0].orderedOn))

  const row = offered.find((o: any) => o.poId === supplierPo.id)
  ok(row.supplier === 'Kestrel Cards', 'the supplier comes across', String(row?.supplier))
  ok(row.destination === buyer, 'and where its goods were headed', String(row?.destination))
  ok(row.linkedHere === false, 'and it is not attached to this sale yet')
  ok(row.otherSales === 0, 'nor to any other')

  // THE ATTACH ITSELF. What matters is the four things it leaves alone.
  const before = inv.getInvoice(sale.id)
  const res = inv.linkDropshipPair(supplierPo.id, sale.id, null)
  ok(res.ok === true, 'a sale that has already been SENT can still be attached', String(res.error))

  const after = inv.getInvoice(sale.id)
  ok(after.sourcePoId === supplierPo.id, 'the sale now names the purchase order')
  ok(after.total === before.total, 'THE TOTAL IS UNTOUCHED', `${before.total} -> ${after.total}`)
  ok(after.lines.length === before.lines.length, 'and so is every line')
  ok(
    after.lines[0].quantity === before.lines[0].quantity &&
      after.lines[0].rate === before.lines[0].rate,
    'down to the quantity and the rate'
  )
  ok(after.qboId === before.qboId, 'and the QuickBooks copy is not even addressed')
  ok(after.status === 'sent', 'the sale stays exactly where it was on the board', after.status)

  /**
   * WHICH IS THE WHOLE POINT: the card now reads as a dropship even though every
   * line still comes off a shelf. salesOrderKindOf says so deliberately - the
   * link is a statement about the DEAL, not about the routing of the lines.
   */
  ok(salesOrderKindOf(after) === 'mixed', 'and the card reads Part drop', salesOrderKindOf(after))

  // It shows as attached on the next read, so the picker can say so.
  const again = inv.linkablePurchaseOrders(sale.id).find((o: any) => o.poId === supplierPo.id)
  ok(again.linkedHere === true, 'the picker reports it as already attached')

  // ONE PURCHASE MAY SUPPLY SEVERAL SALES - that is multi-shipment - so a second
  // sale attaching to the same order is allowed and is COUNTED, not refused.
  const second = inv.saveInvoice(
    {
      id: null,
      customerName: 'Ada Okonkwo',
      invoiceNumber: 'SO-7701',
      invoiceDate: '2026-08-20',
      location: 'RM',
      lines: [{ item: 'Tribute Baseball Case', quantity: 2, rate: 900, amount: 1800 }]
    },
    null
  )
  ok(
    inv.linkDropshipPair(supplierPo.id, second.id, null).ok === true,
    'a SECOND sale can be attached to the same purchase order'
  )
  const forSecond = inv
    .linkablePurchaseOrders(second.id)
    .find((o: any) => o.poId === supplierPo.id)
  ok(forSecond.otherSales === 1, 'and each is told how many others it already supplies', String(forSecond?.otherSales))

  // REPOINTING IS REFUSED. Moving a deal off the order it was recorded against
  // would rewrite both of their histories with nothing saying it happened.
  const moved = inv.linkDropshipPair(shelfPo.id, sale.id, null)
  ok(moved.ok === false, 'A SALE CANNOT BE MOVED TO A DIFFERENT PURCHASE ORDER')
  ok(/already came from another/i.test(moved.error ?? ''), 'and the refusal says why', String(moved.error))
  ok(
    inv.getInvoice(sale.id).sourcePoId === supplierPo.id,
    'with the original link left standing'
  )

  // Attaching the SAME one again is a no-op rather than an error - somebody
  // pressing twice must not be told they broke something.
  ok(
    inv.linkDropshipPair(supplierPo.id, sale.id, null).ok === true,
    'attaching the same order again is harmless'
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== WHICH ORDER THE PICKER PUTS FIRST, and what it refuses ===')
// ---------------------------------------------------------------------------
/**
 * Pure rules, tested without a database. The ranking is the difference between
 * a picker somebody can use and a list of forty order numbers.
 */
{
  const po = (over: any): any => ({
    poId: 'p1',
    poNumber: 'PO-0001',
    supplier: null,
    destination: null,
    status: 'ordered',
    orderedOn: '2026-08-01',
    total: 0,
    unitsOrdered: 0,
    linkedHere: false,
    otherSales: 0,
    ...over
  })

  const kestrel = po({ poId: 'a', poNumber: 'PO-0010', supplier: 'Kestrel Cards', orderedOn: '2026-08-01' })
  const longwood = po({ poId: 'b', poNumber: 'PO-0020', supplier: 'Longwood Wax', orderedOn: '2026-08-20' })
  const older = po({ poId: 'c', poNumber: 'PO-0005', supplier: 'Kestrel Cards', orderedOn: '2026-07-01' })

  const ranked = linkableOrder([longwood, older, kestrel], ['Kestrel Cards'])
  ok(
    ranked[0].poId === 'a' && ranked[1].poId === 'c',
    'THE SUPPLIER THE LINES NAME COMES FIRST, newest of those first',
    ranked.map((o: any) => o.poNumber).join(',')
  )
  ok(
    ranked[2].poId === 'b',
    'and everything else follows rather than being hidden',
    ranked.map((o: any) => o.poNumber).join(',')
  )

  /**
   * NOTHING IS HIDDEN ON A MISMATCH. A sale whose lines name no supplier is
   * exactly the one that sends somebody here, and filtering would hand it an
   * empty picker.
   */
  const blind = linkableOrder([longwood, older, kestrel], [])
  ok(blind.length === 3, 'a sale naming no supplier is still offered everything', String(blind.length))
  ok(
    blind[0].poId === 'b',
    'in newest-first order, which is the only thing left to go on',
    blind.map((o: any) => o.poNumber).join(',')
  )
  // "(not named)" is what dropshipSuppliersOf yields for a line with no
  // supplier. It must not be matched against as if it were a business.
  /**
   * "(not named)" is what dropshipSuppliersOf yields for a line carrying no
   * supplier. Matched as if it were a business it would drag a purchase order
   * whose supplier field happens to be blank-ish to the top of every picker —
   * so the fixture includes one called exactly that, and it must NOT lead.
   */
  const placeholder = po({ poId: 'd', poNumber: 'PO-0001', supplier: '(not named)', orderedOn: '2026-01-01' })
  const withBlank = linkableOrder([longwood, placeholder, kestrel], ['(not named)'])
  ok(
    withBlank[0].poId === 'b',
    'THE PLACEHOLDER SUPPLIER RANKS NOTHING — the newest still leads',
    withBlank.map((o: any) => o.poNumber).join(',')
  )
  ok(
    withBlank[withBlank.length - 1].poId === 'd',
    'and the one literally called "(not named)" sorts last on its date, not first on its name',
    withBlank.map((o: any) => o.poNumber).join(',')
  )

  // --- the refusals -------------------------------------------------------
  ok(linkPurchaseRefusal(kestrel, { sourcePoId: null }) === null, 'an unattached sale may attach')
  ok(
    linkPurchaseRefusal(kestrel, { sourcePoId: 'a' }) === null,
    'and re-attaching the SAME order is not a refusal'
  )
  const moved = linkPurchaseRefusal(kestrel, { sourcePoId: 'zzz', sourcePoNumber: 'PO-0099' })
  ok(!!moved && /PO-0099/.test(moved), 'A SALE ALREADY ON ANOTHER ORDER IS REFUSED, by name', String(moved))
  const dead = linkPurchaseRefusal(po({ status: 'cancelled', poNumber: 'PO-0077' }), { sourcePoId: null })
  ok(!!dead && /cancelled/i.test(dead), 'and a cancelled order is refused', String(dead))
  ok(linkPurchaseRefusal(null, { sourcePoId: null }) === null, 'nothing chosen is not a refusal')
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
