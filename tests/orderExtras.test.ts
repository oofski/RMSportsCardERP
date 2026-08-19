/**
 * What a purchase order and a sales order both have: a history, parcels,
 * paperwork — and, on the sell side, money that arrived before anything shipped.
 *
 * ## The four things here that fail silently if they are wrong
 *
 *   1. A PURCHASE ORDER'S STAGE CHANGES IN THREE PLACES, and only one of them is
 *      setPurchaseOrderStatus. It also closes itself when the last box is
 *      scanned in, and reopens when that scan is undone. A log hooked into one
 *      function shows an order sitting in Ordered while the board says Received
 *      — which is the exact disagreement somebody opens a log to resolve.
 *
 *   2. A DROPSHIPPED SALES-ORDER LINE MUST NOT BE PICKABLE. Its qty_fulfilled
 *      stays 0 for ever precisely because nothing left this building, which made
 *      it look permanently outstanding — so it was offered to the scanner, and
 *      scanning it took real boxes off a real shelf for units nobody ever held.
 *      Rare while these were hand-typed; routine now they are raised by a flow.
 *
 *   3. THE GENERATED SALE MUST WRITE A DESTINATION ON EVERY LINE. A sales
 *      order's header cannot express a dropship — the stock code collapses any
 *      header location that is not a real shelf back to RM — so a sale that sets
 *      only the header draws every line off RM at save time, silently.
 *
 *   4. A DOCUMENT WITHOUT ITS SLICES IS A FILE ONLY THE UPLOADER CAN EVER OPEN.
 *      That is the failure the packing slip already had once: the metadata
 *      synced, the bytes did not, and everybody else saw "no document on this
 *      machine" while the app insisted one existed.
 *
 * Run: npm run test:order-extras
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/order-extras-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const { getDb } = require('../src/main/db/database')
const employees = require('../src/main/db/employees')
const po = require('../src/main/db/purchaseOrders')
const inv = require('../src/main/db/invoices')
const invStock = require('../src/main/db/invoiceStock')
const inventory = require('../src/main/db/inventory')
const extras = require('../src/main/db/orderExtras')
const {
  composeLabelEmail,
  dropshipSaleFromPurchase,
  shipmentsMissingCost,
  totalLabelCost,
  validateShipment,
  validateOrderDocument,
  ORDER_DOCUMENT_MAX_BYTES
} = require('../src/shared/orders')
const { validateInvoicePayment, awaitingShipment } = require('../src/shared/invoices')
const { destinationHoldsStock } = require('../src/shared/purchaseOrders')
const db = getDb()

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

const PASSWORD = 'a-long-enough-password'
const hire = (first: string, companyId: string, role = 'operations'): string =>
  employees.insertEmployee(
    {
      firstName: first,
      lastName: 'Invented',
      companyId,
      title: 'Lead',
      email: `${companyId.toLowerCase()}@example.invalid`,
      role,
      status: 'active'
    },
    null,
    PASSWORD,
    false
  ).employee.id

const OWEN = hire('Owen', 'RM-001', 'owner')
const ADA = hire('Ada', 'RM-100')

// Written straight in, the way tests/dropship.test.ts does it: the catalog
// importer is a different subject and this suite is not about it.
const product = (id: string, name: string, sku: string): string => {
  db.prepare(
    `INSERT INTO inventory_products (id, name, sku, category, unit_cost, created_at, updated_at)
     VALUES (?, ?, ?, 'Baseball', 10, '2026-08-01T12:00:00.000Z', '2026-08-01T12:00:00.000Z')`
  ).run(id, name, sku)
  return id
}
const WIDGET = product('p_widget', 'Invented Widget Box', 'INV-W1')
const GADGET = product('p_gadget', 'Invented Gadget Case', 'INV-G1')

const events = (side: string, id: string): any[] => extras.listOrderEvents(side, id)
const kinds = (side: string, id: string): string => events(side, id).map((e: any) => e.kind).join(',')

// ---------------------------------------------------------------------------
console.log('=== 1. a purchase order writes its own history ===')
// ---------------------------------------------------------------------------
const buy = po.createPurchaseOrder(
  {
    supplier: 'Fenwick Distribution',
    location: 'RM',
    lines: [{ productId: WIDGET, quantity: 4, unitPrice: 100 }]
  },
  OWEN
)
let log = events('po', buy.id)
ok(log.length === 1, 'creating an order writes one entry', String(log.length))
ok(log[0].kind === 'created', 'and it says created', log[0].kind)
ok(log[0].toStage === 'ordered', 'naming the stage it opened in', String(log[0].toStage))
ok(log[0].actorId === OWEN, 'carrying who did it', String(log[0].actorId))
ok(
  log[0].actorName === 'Owen Invented',
  'AND THEIR NAME, SNAPSHOTTED — a log still has to read after somebody leaves',
  String(log[0].actorName)
)

po.setPurchaseOrderStatus(buy.id, 'paid', ADA)
log = events('po', buy.id)
ok(log.length === 2, 'a stage move writes another', String(log.length))
ok(log[0].kind === 'stage', 'of kind stage')
ok(log[0].fromStage === 'ordered' && log[0].toStage === 'paid', 'saying BOTH ends of the move', `${log[0].fromStage}->${log[0].toStage}`)
ok(log[0].actorName === 'Ada Invented', 'and who moved it', String(log[0].actorName))
ok(
  log[0].createdAt >= log[1].createdAt,
  'NEWEST FIRST — the log is opened when something looks wrong, and that is the most recent thing'
)

// Payment is its own fact on the buy side, so it gets its own entry — asserted
// on a FRESH order, because setPurchaseOrderStatus('paid') above already
// stamped paid_at and setPurchaseOrderPaid is correctly idempotent about that.
const cashBuy = po.createPurchaseOrder(
  { supplier: 'Fenwick Distribution', location: 'RM', lines: [{ productId: WIDGET, quantity: 1, unitPrice: 10 }] },
  OWEN
)
po.setPurchaseOrderPaid(cashBuy.id, true, ADA)
const paidEntry = events('po', cashBuy.id).find((e: any) => e.kind === 'paid')
ok(!!paidEntry, 'marking a purchase order paid is its own entry, NOT a stage move')
ok(paidEntry?.actorName === 'Ada Invented', 'and it names who ticked it — the handler used to discard that', String(paidEntry?.actorName))
ok(
  po.getPurchaseOrder(cashBuy.id).status === 'ordered',
  'while the order stays where it was — a received-but-unpaid order must not be dragged backwards to say the money arrived',
  po.getPurchaseOrder(cashBuy.id).status
)

po.setPurchaseOrderStatus(buy.id, 'cancelled', OWEN)
ok(
  events('po', buy.id)[0].toStage === 'cancelled',
  'cancelling is logged',
  String(events('po', buy.id)[0].toStage)
)
po.setPurchaseOrderStatus(buy.id, 'ordered', OWEN)
const reverted = events('po', buy.id)[0]
ok(
  reverted.fromStage === 'cancelled' && reverted.toStage === 'ordered',
  'AND SO IS UN-CANCELLING — a different code path with its own UPDATE, and the one a log would quietly miss',
  `${reverted.fromStage}->${reverted.toStage}`
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. the paths that move a stage WITHOUT anybody clicking ===')
// ---------------------------------------------------------------------------
// completePoIfFullyReceived writes status directly. A log hooked only into
// setPurchaseOrderStatus shows an order in Ordered while the board says
// Received.
const auto = po.createPurchaseOrder(
  { supplier: 'Fenwick Distribution', location: 'RM', lines: [{ productId: GADGET, quantity: 2, unitPrice: 50 }] },
  OWEN
)
const autoLine = po.getPurchaseOrder(auto.id).lines[0]
po.receivePoLine(db, autoLine.id, 2, null, ADA)
// The per-line receive does not close the order by itself — the caller does,
// which is exactly why this path is the one a log forgets. Calling it here is
// what the scan and the delivery form both do.
po.completePoIfFullyReceived(db, auto.id)
const closed = po.getPurchaseOrder(auto.id)
ok(closed.status === 'received', 'receiving every unit closes the order', closed.status)
const autoLog = events('po', auto.id)
ok(
  autoLog.some((e: any) => e.kind === 'stage' && e.toStage === 'received'),
  'AND THE LOG SAYS SO — this is the path that does not go through setPurchaseOrderStatus'
)
const autoEntry = autoLog.find((e: any) => e.kind === 'stage' && e.toStage === 'received')
ok(
  autoEntry.actorId === null,
  'with NOBODY credited — the last box being scanned in is what did it, and naming the scanner would credit a decision they did not make',
  String(autoEntry.actorId)
)
ok(
  (autoEntry.detail ?? '').toLowerCase().includes('automatically'),
  'and it says it closed itself',
  String(autoEntry.detail)
)

// ---------------------------------------------------------------------------
console.log('\n=== 3. a sales order writes its own history too ===')
// ---------------------------------------------------------------------------
const buyer = inv.saveCustomer({ name: 'Steel City Cards', email: 'buyer@example.invalid' })
const sale = inv.saveInvoice(
  {
    invoiceNumber: '5001',
    customerId: buyer.id,
    customerName: 'Steel City Cards',
    invoiceDate: '2026-08-20',
    location: 'RM',
    lines: [{ item: 'Widget Box', productId: WIDGET, quantity: 1, rate: 200 }]
  },
  OWEN
)
ok(kinds('so', sale.id) === 'created', 'a new sales order logs its creation', kinds('so', sale.id))
inv.saveInvoice({ ...sale, id: sale.id, lines: [{ item: 'Widget Box', productId: WIDGET, quantity: 1, rate: 210 }] }, OWEN)
ok(
  events('so', sale.id).filter((e: any) => e.kind === 'created').length === 1,
  'EDITING A DRAFT IS NOT A SECOND CREATION — otherwise every keystroke fills the history with one sentence'
)
inv.setInvoiceStatus(sale.id, 'sent', ADA)
ok(events('so', sale.id)[0].fromStage === 'draft', 'and a stage move records where it came from', String(events('so', sale.id)[0].fromStage))

// ---------------------------------------------------------------------------
console.log('\n=== 4. PAID UP FRONT, and the packing queue it releases ===')
// ---------------------------------------------------------------------------
const upfront = inv.saveInvoice(
  {
    invoiceNumber: '5002',
    customerId: buyer.id,
    customerName: 'Steel City Cards',
    invoiceDate: '2026-08-20',
    location: 'RM',
    lines: [{ item: 'Gadget Case', productId: GADGET, quantity: 1, rate: 400 }]
  },
  OWEN
)
ok(upfront.readyToShipAt === null, 'a fresh order is not on the packing list')
ok(upfront.paidUpFront === false, 'and nobody has paid for it')

const paid = inv.recordInvoicePayment(
  upfront.id,
  { amount: 400, method: 'Zelle', reference: 'ZL-99', readyToShip: true, markPaid: true },
  ADA
)
ok(!paid.error, 'recording the payment works', String(paid.error))
ok(paid.invoice.paidUpFront === true, 'the order says it was paid up front')
ok(paid.invoice.paymentMethod === 'Zelle', 'carrying how', String(paid.invoice.paymentMethod))
ok(paid.invoice.paymentReference === 'ZL-99', 'and the reference', String(paid.invoice.paymentReference))
ok(!!paid.invoice.paidAt, 'stamping when the money landed')
ok(!!paid.invoice.readyToShipAt, 'AND RELEASING IT TO BE PICKED')
ok(paid.invoice.status === 'paid', 'and moving the card', paid.invoice.status)
ok(awaitingShipment(paid.invoice) === true, 'so it reads as awaiting shipment')
ok(
  inv.listAwaitingShipment().some((i: any) => i.id === upfront.id),
  'and it is on the packing queue'
)

const paidLog = events('so', upfront.id)
ok(paidLog.some((e: any) => e.kind === 'paid'), 'the payment is in the log')
ok(paidLog.some((e: any) => e.kind === 'ready'), 'and so is the release')
ok(
  paidLog.some((e: any) => e.kind === 'stage' && e.toStage === 'paid'),
  'and the stage move went through the ordinary machinery rather than being written straight in'
)

// PAYMENT AND READINESS COME APART, which is the whole reason they are two
// columns. A deposit is money with no release; a trusted buyer on terms is a
// release with no money.
const deposit = inv.saveInvoice(
  { invoiceNumber: '5003', customerName: 'Steel City Cards', invoiceDate: '2026-08-20', location: 'RM',
    lines: [{ item: 'Gadget Case', productId: GADGET, quantity: 1, rate: 400 }] },
  OWEN
)
const dep = inv.recordInvoicePayment(deposit.id, { amount: 100, method: 'Cash', readyToShip: false, markPaid: false }, ADA)
ok(dep.invoice.paidUpFront === true, 'a deposit is still money up front')
ok(dep.invoice.readyToShipAt === null, 'BUT RELEASES NOTHING', String(dep.invoice.readyToShipAt))
ok(dep.invoice.status === 'draft', 'and moves no card', dep.invoice.status)

const onTerms = inv.setInvoiceReadyToShip(deposit.id, true, ADA)
ok(!!onTerms.invoice.readyToShipAt, 'and readiness can be granted on its own')
inv.setInvoiceReadyToShip(deposit.id, false, ADA)
ok(inv.getInvoice(deposit.id).readyToShipAt === null, 'and taken back off')

// Voiding un-readies. An order whose stock has just gone back on the shelf is
// not waiting to be picked.
inv.setInvoiceReadyToShip(deposit.id, true, ADA)
inv.setInvoiceStatus(deposit.id, 'void', OWEN)
ok(
  inv.getInvoice(deposit.id).readyToShipAt === null,
  'VOIDING TAKES IT OFF THE PACKING LIST — its boxes are back on the shelf'
)
const voided = inv.recordInvoicePayment(deposit.id, { amount: 10 }, ADA)
ok(!!voided.error, 'and a voided order refuses a payment', String(voided.error))

ok(validateInvoicePayment({ amount: 0 }, 100) !== null, 'a payment of nothing is refused')
ok(validateInvoicePayment({ amount: -5 }, 100) !== null, 'and so is a negative one')
ok(validateInvoicePayment({ amount: 500 }, 100) !== null, 'more than the order comes to is refused — overpayment should be deliberate')
ok(validateInvoicePayment({ amount: 100 }, 100) === null, 'exactly the total is fine')
ok(
  validateInvoicePayment({ amount: 100.004 }, 100) === null,
  'and a cent of tolerance, because the total is itself rounded'
)

// ---------------------------------------------------------------------------
console.log('\n=== 5. PARCELS — several, each with its own carrier ===')
// ---------------------------------------------------------------------------
ok(validateShipment({}) !== null, 'a parcel with nothing on it is refused')
ok(validateShipment({ trackingNumber: '1Z999' }) === null, 'a number alone is a parcel')
ok(validateShipment({ carrier: 'usps' }) === null, 'so is a carrier alone')
ok(validateShipment({ labelCost: 8.5 }) === null, 'and so is a cost alone')
ok(validateShipment({ labelCost: -1 }) !== null, 'a label cannot cost less than nothing')

const one = extras.saveShipment('po', buy.id, { trackingNumber: '1Z999AA10123456784' }, OWEN)
ok(
  one.carrier === 'ups',
  'THE CARRIER IS GUESSED FROM THE NUMBER — paste it and be done',
  String(one.carrier)
)
ok(one.position === 0, 'the first parcel is position 0', String(one.position))

const two = extras.saveShipment('po', buy.id, { trackingNumber: '9400111899223197428490', labelCost: 8.45 }, OWEN)
ok(two.carrier === 'usps', 'a second parcel can be a different carrier', String(two.carrier))
ok(two.position === 1, 'and takes the next position', String(two.position))
ok(extras.listShipments('po', buy.id).length === 2, 'both are on the order')

// An explicit carrier beats the guess, and stays beaten — a screen that
// re-guesses on every keystroke is one you cannot override.
const corrected = extras.saveShipment('po', buy.id, { id: one.id, carrier: 'fedex', service: 'Ground' }, OWEN)
ok(corrected.carrier === 'fedex', 'a hand-set carrier wins over the guess', String(corrected.carrier))
const again = extras.saveShipment('po', buy.id, { id: one.id, trackingNumber: '1Z999AA10123456784' }, OWEN)
ok(again.carrier === 'fedex', 'AND SURVIVES THE NUMBER BEING RETYPED', String(again.carrier))

const swapped = extras.saveShipment('po', buy.id, { id: one.id, carrier: 'usps' }, OWEN)
ok(
  swapped.service === null,
  'CHANGING THE CARRIER CLEARS THE SERVICE — a FedEx service on a USPS parcel has no option to render and reads as wiped',
  String(swapped.service)
)

// The legacy columns on the order itself are a MIRROR of the first parcel, so
// everything that read them before this table existed still reads correctly.
const mirrored = po.getPurchaseOrder(buy.id)
ok(
  mirrored.trackingNumber === '1Z999AA10123456784',
  'the order mirrors its FIRST parcel, so every old reader still works',
  String(mirrored.trackingNumber)
)
extras.deleteShipment(one.id)
const after = po.getPurchaseOrder(buy.id)
ok(
  after.trackingNumber === '9400111899223197428490',
  'and re-mirrors when that parcel is deleted',
  String(after.trackingNumber)
)
ok(extras.listShipments('po', buy.id)[0].position === 0, 'positions repack with no gaps')

// ---------------------------------------------------------------------------
console.log('\n=== 6. WHAT THE LABEL COST ===')
// ---------------------------------------------------------------------------
const costed = extras.listShipments('po', buy.id)
ok(totalLabelCost(costed) === 8.45, 'the order knows what its postage cost', String(totalLabelCost(costed)))
const third = extras.saveShipment('po', buy.id, { trackingNumber: '794600000000' }, OWEN)
ok(third.labelCost === null, 'A PARCEL WITH NO COST IS NULL, NOT ZERO — "free" and "nobody has said" are different facts')
ok(
  totalLabelCost(extras.listShipments('po', buy.id)) === 8.45,
  'so an unfilled cost adds nothing rather than pretending to be free',
  String(totalLabelCost(extras.listShipments('po', buy.id)))
)
ok(
  shipmentsMissingCost(extras.listShipments('po', buy.id)) === 1,
  'and the screen can say how many are missing',
  String(shipmentsMissingCost(extras.listShipments('po', buy.id)))
)
const priced = extras.saveShipment('po', buy.id, { id: third.id, labelCost: 0 }, OWEN)
ok(priced.labelCost === 0, 'a label that really was free can say zero', String(priced.labelCost))
ok(shipmentsMissingCost(extras.listShipments('po', buy.id)) === 0, 'and then nothing is missing')

// ---------------------------------------------------------------------------
console.log('\n=== 7. line items assigned to a parcel ===')
// ---------------------------------------------------------------------------
const poLines = po.getPurchaseOrder(buy.id).lines
const assigned = extras.saveShipment(
  'po',
  buy.id,
  { id: two.id, lines: [{ lineId: poLines[0].id, quantity: 3 }] },
  OWEN
)
ok(assigned.lines.length === 1, 'a parcel can say which lines are in it', String(assigned.lines.length))
ok(assigned.lines[0].quantity === 3, 'and how many of each', String(assigned.lines[0].quantity))
const reassigned = extras.saveShipment('po', buy.id, { id: two.id, lines: [] }, OWEN)
ok(
  reassigned.lines.length === 0,
  'ASSIGNMENTS ARE REPLACED WHOLESALE — merging two sets is how a line ends up in two parcels with nothing to say which is right'
)

// ---------------------------------------------------------------------------
console.log('\n=== 8. PAPERWORK, and the slices that carry it ===')
// ---------------------------------------------------------------------------
ok(validateOrderDocument({ name: 'l.pdf', mimeType: 'application/pdf', byteSize: 0 }) !== null, 'an empty file is refused')
ok(validateOrderDocument({ name: 'l.exe', mimeType: 'application/x-msdownload', byteSize: 10 }) !== null, 'and so is something that is not a label')
ok(
  validateOrderDocument({ name: 'l.pdf', mimeType: 'application/pdf', byteSize: ORDER_DOCUMENT_MAX_BYTES + 1 }) !== null,
  'and one that is too big'
)
ok(validateOrderDocument({ name: 'l.pdf', mimeType: 'application/pdf', byteSize: 5000 }) === null, 'an ordinary label is fine')

// Deliberately over one slice, so the cutting is actually exercised rather than
// asserted against a file that happens to fit in one.
const big = Buffer.alloc(600 * 1024, 7)
const doc = extras.saveOrderDocument('po', buy.id, { name: 'label.pdf', mimeType: 'application/pdf', bytes: big }, OWEN)
ok(doc.byteSize === big.byteLength, 'the label is stored whole', String(doc.byteSize))
ok(doc.present === true, 'and is on this machine')
const parts = db.prepare(`SELECT COUNT(*) AS n, MAX(total) AS t FROM order_document_parts WHERE document_id = ?`).get(doc.id) as any
ok(parts.n === 2, 'AND IS CUT INTO SLICES THAT TRAVEL — 600KB is two', String(parts.n))
ok(parts.t === 2, 'each knowing how many there are', String(parts.t))
const read = extras.getOrderDocumentBytes(doc.id)
ok(read.bytes.byteLength === big.byteLength, 'and it reads back byte for byte', String(read.bytes.byteLength))
ok(read.bytes.equals(big), 'identically')

// What another laptop sees: the slices arrive, the whole file does not.
db.prepare(`DELETE FROM order_documents WHERE id = ?`).run(doc.id)
const remote = extras.listOrderDocuments('po', buy.id)
ok(remote.length === 1, 'a machine with only the slices still knows the label exists', String(remote.length))
ok(
  remote[0].present === false,
  'AND SAYS IT IS NOT HERE YET — "no label" and "still arriving" are the same blank pane and different situations'
)
ok(extras.getOrderDocumentBytes(doc.id) === null, 'and cannot hand out bytes it does not have')
ok(extras.rebuildOrderDocuments() === 1, 'rebuilding from the slices restores it')
ok(extras.getOrderDocumentBytes(doc.id).bytes.equals(big), 'byte for byte')
ok(extras.rebuildOrderDocuments() === 0, 'and rebuilding again does nothing — it must not churn the file every four seconds')

// A short slice must never be assembled into a file somebody prints and sticks
// on a box.
db.prepare(`DELETE FROM order_documents WHERE id = ?`).run(doc.id)
db.prepare(`UPDATE order_document_parts SET data = 'AAAA' WHERE document_id = ? AND seq = 1`).run(doc.id)
ok(
  extras.rebuildOrderDocuments() === 0,
  'A TRUNCATED SLICE IS REFUSED — a corrupt label opens to a blank page and gets handed to a courier'
)

extras.deleteOrderDocument(doc.id)
ok(
  (db.prepare(`SELECT COUNT(*) AS n FROM order_document_parts WHERE document_id = ?`).get(doc.id) as any).n === 0,
  'DELETING TAKES THE SLICES TOO — otherwise the next sync rebuilds it and the delete reads as broken'
)

// ---------------------------------------------------------------------------
console.log('\n=== 9. the two halves of a dropship ===')
// ---------------------------------------------------------------------------
const dropPo = po.createPurchaseOrder(
  {
    supplier: 'Fenwick Distribution',
    location: 'Steel City Cards',
    lines: [{ productId: WIDGET, quantity: 6, unitPrice: 90 }]
  },
  OWEN
)
ok(destinationHoldsStock('Steel City Cards') === false, 'the destination is not a shelf, so this is a dropship')

const draft = dropshipSaleFromPurchase({
  supplier: 'Fenwick Distribution',
  destination: 'Steel City Cards',
  invoiceDate: '2026-08-21',
  lines: [{ item: 'Invented Widget Box', productId: WIDGET, quantity: 6 }]
})
ok(draft.customerName === 'Steel City Cards', 'the sale is billed to whoever the goods went to', draft.customerName)
ok(
  draft.lines.every((l: any) => l.destination === 'Fenwick Distribution'),
  'EVERY LINE CARRIES A DESTINATION — the header cannot express a dropship, and a sale that set only the header would draw every line off the RM shelf'
)
ok(draft.lines.every((l: any) => l.supplier === 'Fenwick Distribution'), 'and says who shipped it')
ok(
  draft.lines.every((l: any) => l.rate === 0),
  'PRICES ARE NOT CARRIED OVER — price A is what we pay and price B is what they pay, and a zero-margin invoice must not be one Enter away'
)

const shelfBefore = inventory.stockQty(WIDGET, 'RM')
const dropSale = inv.saveInvoice(
  { ...draft, invoiceNumber: '5010', lines: draft.lines.map((l: any) => ({ ...l, rate: 150 })) },
  OWEN
)
ok(inventory.stockQty(WIDGET, 'RM') === shelfBefore, 'AND SAVING IT MOVES NO STOCK — we never held these units')
ok(inv.getInvoice(dropSale.id).lines[0].dropship === true, 'the line reads as a dropship')

const linked = inv.linkDropshipPair(dropPo.id, dropSale.id, OWEN)
ok(linked.ok === true, 'the two halves link', String(linked.error))
ok(po.getPurchaseOrder(dropPo.id).linkedInvoiceId === dropSale.id, 'the purchase points at the sale')
ok(inv.getInvoice(dropSale.id).sourcePoId === dropPo.id, 'and the sale points back')
ok(
  events('po', dropPo.id).some((e: any) => e.kind === 'link' && (e.detail ?? '').includes('Steel City')),
  'THE PURCHASE ORDER LOG SAYS WHAT IT WAS SOLD AS'
)
ok(
  events('so', dropSale.id).some((e: any) => e.kind === 'link' && (e.detail ?? '').includes('Fenwick')),
  'AND THE SALES ORDER LOG SAYS WHAT IT WAS BOUGHT AS — two records, each reading correctly on its own'
)

const otherSale = inv.saveInvoice(
  { invoiceNumber: '5011', customerName: 'Steel City Cards', invoiceDate: '2026-08-21', location: 'RM',
    lines: [{ item: 'Widget Box', productId: WIDGET, quantity: 1, rate: 10 }] },
  OWEN
)
ok(
  inv.linkDropshipPair(dropPo.id, otherSale.id, OWEN).ok === false,
  'A PAIRED PURCHASE ORDER REFUSES A SECOND SALE — re-running the flow would otherwise orphan the first silently'
)
ok(inv.linkDropshipPair(dropPo.id, dropSale.id, OWEN).ok === true, 'while re-linking the same pair is harmless')

// ---------------------------------------------------------------------------
console.log('\n=== 10. A DROPSHIPPED LINE IS NOT PICKABLE ===')
// ---------------------------------------------------------------------------
// Its qty_fulfilled stays 0 for ever because nothing left this building, so it
// looked permanently outstanding and was offered to the scanner — which took
// real boxes off a real shelf for units nobody ever held.
const queue = inv.outstandingSalesLinesForProduct(WIDGET)
ok(
  !queue.some((c: any) => c.invoiceId === dropSale.id),
  'THE DROPSHIP IS NOT IN THE SCAN-OUT QUEUE',
  queue.map((c: any) => c.invoiceNumber).join(',')
)
ok(
  queue.some((c: any) => c.invoiceId === otherSale.id),
  'while an ordinary shelf sale still is',
  queue.map((c: any) => c.invoiceNumber).join(',')
)

// ---------------------------------------------------------------------------
console.log('\n=== 11. the message that goes out with a label ===')
// ---------------------------------------------------------------------------
const mail = composeLabelEmail({
  side: 'po',
  orderNumber: 'PO-0007',
  shipTo: 'Steel City Cards',
  senderName: 'Owen Invented',
  companyName: 'RM Cardz',
  lines: [{ description: 'Invented Widget Box', quantity: 6 }],
  shipments: [{ carrier: 'ups', service: 'Ground', trackingNumber: '1Z999' }],
  note: 'Please ship by Friday.',
  labelName: 'label.pdf'
})
ok(mail.subject.includes('PO-0007'), 'the subject names the order', mail.subject)
ok(mail.body.includes('attached'), 'the body says the label is attached when there is one')
ok(mail.body.includes('6 × Invented Widget Box'), 'it lists what to ship', mail.body.slice(0, 120))
ok(mail.body.includes('1Z999'), 'and the tracking')
ok(mail.body.includes('Please ship by Friday.'), 'and whatever note was typed')
const noLabel = composeLabelEmail({ ...({} as any), side: 'so', orderNumber: '5001', shipTo: null,
  senderName: 'Owen', companyName: 'RM Cardz', lines: [], shipments: [], note: null, labelName: null })
ok(
  !noLabel.body.includes('attached'),
  'AND DOES NOT CLAIM AN ATTACHMENT WHEN THERE IS NONE — an email somebody believes has a label on it is worse than no email',
  noLabel.body.slice(0, 90)
)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
