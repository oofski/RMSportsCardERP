/**
 * Drop-shipping on the SELL side, and the carrier list both sides share.
 *
 * The owner's words: "The drop shipping logic needs to be created in the sales
 * order tab as well ... make sure the location right supplier and shipping is
 * the same", plus "remove surepost and express critical", "each shipping
 * company has there set of services", and "add an option to put a pick up or
 * hand delivery option ... into both PO and sales orders".
 *
 * ## The mirror, and the one thing that flips
 *
 * A purchase order line's destination is where the goods GO: RM or AM puts them
 * on a shelf here, anyone else is a dropship. A sales order's goods always go to
 * the buyer, so the same column answers where they COME FROM — our shelf, or a
 * supplier shipping direct.
 *
 * ## The assertion this whole thing rests on
 *
 * A DROPSHIPPED LINE MOVES NO STOCK. Sales orders draw inventory down at save;
 * a line for goods this business never held must not, or it invents a sale out
 * of stock that was never there — and on a product we DO carry it would quietly
 * consume somebody else's boxes. Section 2.
 *
 * Every name here is invented.
 *
 * Run: npm run test:invoice-dropship
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/invdrop-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const { getDb } = require('../src/main/db/database')
const inv = require('../src/main/db/invoices')
const invStock = require('../src/main/db/inventory')
const { CARRIERS, servicesFor, asCarrier, trackingUrl, detectCarrier } = require('../src/shared/freight')
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

db.prepare(
  `INSERT INTO inventory_products (id, sku, name, category, unit_cost, created_at, updated_at)
   VALUES ('p_d', 'SKU-D', 'Dropship Hobby Box', 'Baseball', 50,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
).run()
invStock.addStock('p_d', 'RM', 10, 50, null)

const qtyAt = (loc: string): number =>
  (db
    .prepare(`SELECT COALESCE(SUM(quantity),0) AS q FROM inventory_stock WHERE product_id='p_d' AND location=?`)
    .get(loc) as { q: number }).q

const sell = (destination: string | null, supplier: string | null, qty = 3): any =>
  inv.saveInvoice(
    {
      customerName: 'Invented Buyer',
      invoiceDate: '2026-04-01',
      location: 'RM',
      lines: [
        {
          item: 'Dropship Hobby Box',
          productId: 'p_d',
          quantity: qty,
          rate: 120,
          destination,
          supplier
        }
      ]
    },
    null
  )

// ---------------------------------------------------------------------------
console.log('=== 1. an ordinary line still comes off the shelf ===')
// ---------------------------------------------------------------------------
const before = qtyAt('RM')
ok(before === 10, 'ten on the RM shelf to begin with', String(before))

const normal = sell(null, null)
ok(!!normal && !!normal.id, 'a plain sales order saves', JSON.stringify(normal).slice(0, 80))
ok(qtyAt('RM') === before - 3, 'AND TAKES ITS THREE OFF THE SHELF', String(qtyAt('RM')))

const normalLine = inv.getInvoice(normal.id).lines[0]
ok(normalLine.destination === 'RM', 'the line reads back as fulfilled from RM', normalLine.destination)
ok(normalLine.dropship === false, 'and is not a dropship')
ok(normalLine.supplier === null, 'with no supplier — it came off our own shelf')
ok(normalLine.qtyFulfilled === 3, 'and counts as fulfilled', String(normalLine.qtyFulfilled))

// Naming our own location explicitly is the SAME as inheriting it. Otherwise a
// line stops following the header for a reason nobody could see.
const explicit = sell('RM', null, 1)
ok(qtyAt('RM') === before - 4, 'naming RM explicitly still takes stock', String(qtyAt('RM')))
ok(
  inv.getInvoice(explicit.id).lines[0].dropship === false,
  'and is still not a dropship'
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. A DROPSHIPPED LINE MOVES NO STOCK ===')
// ---------------------------------------------------------------------------
const held = qtyAt('RM')
const drop = sell('Fenwick Distribution', 'Steel City', 4)
ok(!!drop && !!drop.id, 'a drop-shipped sales order saves', JSON.stringify(drop).slice(0, 80))
ok(
  qtyAt('RM') === held,
  'AND THE SHELF IS UNTOUCHED — we never held these units',
  `${qtyAt('RM')} vs ${held}`
)

const dropLine = inv.getInvoice(drop.id).lines[0]
ok(dropLine.destination === 'Fenwick Distribution', 'the line names where it came from', dropLine.destination)
ok(dropLine.dropship === true, 'and reads as a dropship')
ok(dropLine.supplier === 'Steel City', 'carrying who shipped it', String(dropLine.supplier))
ok(
  dropLine.qtyFulfilled === 0,
  'nothing is recorded as fulfilled from here, because nothing left here',
  String(dropLine.qtyFulfilled)
)

// The money is unaffected: it is still a sale, still billed, still on the total.
ok(drop.total === 480, 'the buyer is still billed 4 × 120', String(drop.total))

// A MIXED order — one line off the shelf, one drop-shipped — takes only the
// first. This is the case a whole-order flag would have got wrong.
const mixed = inv.saveInvoice(
  {
    customerName: 'Invented Buyer',
    invoiceDate: '2026-04-02',
    location: 'RM',
    lines: [
      { item: 'Dropship Hobby Box', productId: 'p_d', quantity: 2, rate: 120 },
      {
        item: 'Dropship Hobby Box',
        productId: 'p_d',
        quantity: 5,
        rate: 120,
        destination: 'Fenwick Distribution',
        supplier: 'Steel City'
      }
    ]
  },
  null
)
const mixedBefore = held
ok(!!mixed.id, 'a mixed order saves')
ok(
  qtyAt('RM') === mixedBefore - 2,
  'ONLY THE SHELF LINE IS DRAWN DOWN — two, not seven',
  `${qtyAt('RM')} vs ${mixedBefore - 2}`
)
const mixedLines = inv.getInvoice(mixed.id).lines
ok(mixedLines[0].dropship === false && mixedLines[1].dropship === true, 'and the two lines differ')

// ---------------------------------------------------------------------------
console.log('\n=== 3. inheritance is stored, not copied ===')
// ---------------------------------------------------------------------------
// The same rule a purchase order line follows. A line that merely agrees with
// the header stores NULL, so changing the header later carries it along.
const rows = db
  .prepare('SELECT destination FROM invoice_lines WHERE invoice_id = ?')
  .all(explicit.id) as Array<{ destination: string | null }>
ok(
  rows[0].destination === null,
  'a line naming the order’s own location stores NULL — it INHERITS',
  String(rows[0].destination)
)
const dropRows = db
  .prepare('SELECT destination FROM invoice_lines WHERE invoice_id = ?')
  .all(drop.id) as Array<{ destination: string | null }>
ok(
  dropRows[0].destination === 'Fenwick Distribution',
  'while a real override is stored as itself',
  String(dropRows[0].destination)
)
// And it reads back resolved, so no screen has to know the rule.
ok(
  inv.getInvoice(explicit.id).lines[0].destination === 'RM',
  'an inherited line still READS as the order’s location'
)

// The predicate is the shared one, so the two sides cannot drift.
ok(destinationHoldsStock('RM') === true, 'RM holds stock')
ok(destinationHoldsStock('AM') === true, 'so does AM')
ok(destinationHoldsStock('Fenwick Distribution') === false, 'and a third party does not')

// ---------------------------------------------------------------------------
console.log('\n=== 4. the carrier list both documents share ===')
// ---------------------------------------------------------------------------
const ups = CARRIERS.find((c: any) => c.id === 'ups')
ok(!!ups, 'UPS is still a carrier')
ok(!ups.services.includes('SurePost'), 'SUREPOST IS GONE', ups.services.join(', '))
ok(!ups.services.includes('Express Critical'), 'AND SO IS EXPRESS CRITICAL')
ok(ups.services.includes('Ground'), 'while the ones actually used remain')
ok(ups.services.includes('Next Day Air'), 'including the overnight tiers')

// Every service still belongs to exactly one carrier — the property that stops a
// UPS service being written onto a FedEx shipment.
for (const c of CARRIERS) {
  ok(
    servicesFor(c.id).length === c.services.length,
    `servicesFor(${c.id}) returns that carrier's own list`,
    String(servicesFor(c.id).length)
  )
}
ok(servicesFor(null).length === 0, 'and no carrier offers no services')
ok(servicesFor('nonsense').length === 0, 'as does an unknown one')

// ---------------------------------------------------------------------------
console.log('\n=== 5. pickup and hand delivery, on both documents ===')
// ---------------------------------------------------------------------------
const local = CARRIERS.find((c: any) => c.id === 'local')
ok(!!local, 'THERE IS A PICKUP / HAND DELIVERY OPTION')
ok(local.label === 'Pickup / hand delivery', 'labelled for what it is', local?.label)
ok(
  local.services.join(',') === 'Customer pickup,Hand delivery',
  'offering both, as its services',
  local?.services.join(',')
)

// It is a carrier as far as every other part of the file is concerned, which is
// what makes it work on both documents with no branching.
ok(asCarrier('local') === 'local', 'IT SURVIVES A WRITE — asCarrier accepts it')
ok(asCarrier('fedex') === 'fedex', 'and the real carriers still do')
ok(asCarrier('surepost') === null, 'while nonsense is still refused')

// No tracking, ever. Nothing to follow and nowhere to follow it.
ok(trackingUrl('local', '1Z999AA10123456784') === null, 'a pickup has no tracking page')
ok(detectCarrier('1Z999AA10123456784') === 'ups', 'and a pasted number never guesses pickup')

// It really is on both documents: the shared component is what both render.
const freightSrc = require('node:fs').readFileSync(
  join(process.cwd(), 'src/renderer/src/components/FreightFields.tsx'),
  'utf8'
)
ok(freightSrc.includes("carrier === 'local'"), 'and the shared form knows not to ask for a number')
for (const f of [
  'src/renderer/src/modules/invoicing/CreatePurchaseOrderModal.tsx',
  'src/renderer/src/modules/invoices/CreateInvoiceModal.tsx'
]) {
  ok(
    require('node:fs').readFileSync(join(process.cwd(), f), 'utf8').includes('FreightFields'),
    `${f.split('/').pop()} renders the shared shipping form`
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. the two forms are the same shape ===')
// ---------------------------------------------------------------------------
const poSrc = require('node:fs').readFileSync(
  join(process.cwd(), 'src/renderer/src/modules/invoicing/CreatePurchaseOrderModal.tsx'),
  'utf8'
)
const invSrc = require('node:fs').readFileSync(
  join(process.cwd(), 'src/renderer/src/modules/invoices/CreateInvoiceModal.tsx'),
  'utf8'
)
ok(poSrc.includes('modal-xl'), 'the purchase order form is the wide one')
ok(
  invSrc.includes('modal-xl'),
  'AND THE SALES ORDER FORM IS NOW THE SAME WIDTH — at 620px the money columns were three characters wide'
)
for (const col of ['po-col-qty', 'po-col-price', 'po-col-total', 'po-col-supplier', 'po-col-dest', 'po-col-remove']) {
  ok(invSrc.includes(col), `the sales order table declares ${col}, exactly as the PO does`)
}
ok(
  invSrc.includes('po-lines-routed'),
  'and uses the routed layout, so the columns line up between the two'
)


// ---------------------------------------------------------------------------
console.log('\n=== 5. adding your own stock to a dropship order ===')
// ---------------------------------------------------------------------------
/**
 * THE SCREEN'S HALF OF SECTION 2.
 *
 * The backend has always billed a mixed order correctly. The picker could not
 * express one: picking a product already on the order bumped whatever line held
 * it, so on a dropship-prefilled order the only way to add two off the shelf was
 * to turn three dropshipped cases into five. That invoices the buyer for the
 * right money by accident while drawing NO stock at all, and leaves the shelf up
 * for units that have been sold.
 *
 * `stockLineForProduct` is the rule the picker now asks. It is tested here
 * rather than beside the component because it is the same question `saveInvoice`
 * answers per line, and the two must never diverge.
 */
const { stockLineForProduct } = require('../src/shared/invoices')

const dropLineDraft = { key: 'pre_0', productId: 'p_d', destination: 'Fenwick Distribution' }
const shelfLineDraft = { key: 'k1', productId: 'p_d', destination: '' }
const otherShelfDraft = { key: 'k2', productId: 'p_other', destination: 'RM' }

// The case the owner described: three cases dropshipped, then two off our shelf.
ok(
  stockLineForProduct([dropLineDraft], 'p_d', '') === undefined,
  'a DROPSHIP line is never merged into — so the shelf sale becomes its own line'
)
ok(
  stockLineForProduct([shelfLineDraft], 'p_d', '') === shelfLineDraft,
  'but a shelf line for the same product IS merged into'
)
ok(
  stockLineForProduct([dropLineDraft, shelfLineDraft], 'p_d', '') === shelfLineDraft,
  'and with both present the pick finds the shelf one, not the dropship'
)
ok(
  stockLineForProduct([otherShelfDraft], 'p_d', '') === undefined,
  'a different product is never merged into'
)
ok(
  stockLineForProduct([{ key: 'k3', productId: '', destination: '' }], '', '') === undefined,
  'and a freehand line with no product never absorbs a pick'
)

// An explicit 'RM' and an inherited blank are the same shelf, so both merge.
ok(
  stockLineForProduct([{ key: 'k4', productId: 'p_d', destination: 'RM' }], 'p_d', '') !== undefined,
  'an explicitly RM line merges too — it is the same shelf as inheriting'
)
// Inheritance follows the ORDER's location, so a blank line on a dropship-headed
// order is itself a dropship and must not absorb a shelf pick.
ok(
  stockLineForProduct([shelfLineDraft], 'p_d', 'Fenwick Distribution') === undefined,
  'a blank line inherits the ORDER location, so on a dropship-headed order it is not a shelf line'
)
// Only ONE line comes back. The rule this replaced mapped across every match, so
// an order legitimately holding two lines of a product got both incremented.
const twoShelf = [
  { key: 'a', productId: 'p_d', destination: '' },
  { key: 'b', productId: 'p_d', destination: 'RM' }
]
ok(stockLineForProduct(twoShelf, 'p_d', '') === twoShelf[0], 'exactly one line is returned, the first')

/**
 * END TO END: the order the owner described, saved.
 *
 * Three dropshipped from the supplier plus two off our own shelf, SAME product,
 * one buyer, one order. The buyer is billed for five; the shelf gives up two.
 */
const shelfBefore = qtyAt('RM')
const combined = inv.saveInvoice(
  {
    customerName: 'Invented Buyer',
    invoiceDate: '2026-04-03',
    location: 'RM',
    lines: [
      {
        item: 'Dropship Hobby Box',
        productId: 'p_d',
        quantity: 3,
        rate: 200,
        destination: 'Fenwick Distribution',
        supplier: 'Steel City'
      },
      { item: 'Dropship Hobby Box', productId: 'p_d', quantity: 2, rate: 200 }
    ]
  },
  null
)
const combinedLines = inv.getInvoice(combined.id).lines
ok(combined.total === 1000, 'the buyer is billed for all five units', String(combined.total))
ok(
  qtyAt('RM') === shelfBefore - 2,
  'but only the two off the shelf are drawn down',
  `${qtyAt('RM')} vs ${shelfBefore - 2}`
)
ok(combinedLines[0].dropship === true, 'the supplier-shipped line reads as a dropship')
ok(combinedLines[1].dropship === false, 'and the shelf line does not')
ok(
  combinedLines[0].qtyFulfilled === 0 && combinedLines[1].qtyFulfilled === 2,
  'only the shelf line counts as fulfilled from stock',
  `${combinedLines[0].qtyFulfilled}/${combinedLines[1].qtyFulfilled}`
)


// ---------------------------------------------------------------------------
console.log('\n=== 7. the board can SEE a dropship sale ===')
// ---------------------------------------------------------------------------
/**
 * The owner's words: "if a sales order is part of a drop ship ... it is also
 * highlighted in yellow on the sales order tab".
 *
 * A dropship is one deal with two documents, and only the purchase order looked
 * like one. The Sales Orders board had no way to show that an order's boxes
 * never touch a shelf here — which is the fact that decides whether the packing
 * floor should expect it at all.
 *
 * The colour is a class, so what is pinned here is the DATA the class is derived
 * from: the unit split has to reach the board row, and the rule has to answer
 * the same three ways the buy side does.
 */
const { salesOrderKindOf, isDropshipSale } = require('../src/shared/invoices')

const listed = (id: string): any => inv.listInvoices(500).find((r: any) => r.id === id)

// The plain sale from section 1 — every unit off our own shelf.
ok(listed(normal.id).dropshipUnits === 0, 'a shelf sale reports no dropshipped units')
ok(listed(normal.id).stockUnits === 3, 'and reports its shelf units', String(listed(normal.id).stockUnits))
ok(salesOrderKindOf(listed(normal.id)) === 'stock', 'so it reads as ordinary stock')
ok(isDropshipSale(listed(normal.id)) === false, 'and is not a dropship')

// The wholly-dropshipped sale from section 2.
ok(listed(drop.id).stockUnits === 0, 'a full dropship reports no shelf units')
ok(listed(drop.id).dropshipUnits === 4, 'and reports all four as dropshipped', String(listed(drop.id).dropshipUnits))
ok(salesOrderKindOf(listed(drop.id)) === 'drop', 'THE WHOLE ORDER READS AS A DROPSHIP')
ok(isDropshipSale(listed(drop.id)) === true, 'and is one')

// The mixed order from section 5 — three from the supplier, two off the shelf.
ok(listed(combined.id).stockUnits === 2, 'a mixed order reports its shelf units', String(listed(combined.id).stockUnits))
ok(listed(combined.id).dropshipUnits === 3, 'and its dropshipped units', String(listed(combined.id).dropshipUnits))
ok(
  salesOrderKindOf(listed(combined.id)) === 'mixed',
  'AND READS AS MIXED — part of a dropship without being one',
  salesOrderKindOf(listed(combined.id))
)
ok(isDropshipSale(listed(combined.id)) === true, 'which still counts as a dropship for the board')

// A LINKED sale counts even with nothing routed to a supplier. source_po_id is
// somebody declaring the pair, and an order whose lines were later re-pointed at
// a shelf is still the sale that purchase was raised for.
db.prepare(`UPDATE invoices SET source_po_id = 'po_somewhere' WHERE id = ?`).run(normal.id)
ok(
  salesOrderKindOf(listed(normal.id)) === 'mixed',
  'a linked sale with only shelf units still shows on the board',
  salesOrderKindOf(listed(normal.id))
)
db.prepare(`UPDATE invoices SET source_po_id = NULL WHERE id = ?`).run(normal.id)
ok(salesOrderKindOf(listed(normal.id)) === 'stock', 'and goes back to plain when unlinked')

// An order with no lines yet derives from the link alone rather than reading as
// a dropship the moment it is created.
ok(
  salesOrderKindOf({ stockUnits: 0, dropshipUnits: 0, sourcePoId: null }) === 'stock',
  'an empty draft is not a dropship'
)
ok(
  salesOrderKindOf({ stockUnits: 0, dropshipUnits: 0, sourcePoId: 'po_1' }) === 'drop',
  'unless it was raised from one'
)

// The board applies the SAME classes the purchase order board uses, so the two
// colours cannot drift apart.
const boardSrc = require('node:fs').readFileSync(
  join(process.cwd(), 'src/renderer/src/modules/invoices/InvoicesBoard.tsx'),
  'utf8'
)
ok(boardSrc.includes('po-card-drop'), 'the sales board uses the buy side dropship class')
ok(boardSrc.includes('po-card-mixed'), 'and its mixed one')
ok(boardSrc.includes('salesOrderKindOf'), 'derived, never stored')


// ---------------------------------------------------------------------------
console.log('\n=== 8. whether the buyer may pay by card ===')
// ---------------------------------------------------------------------------
/**
 * The owner's words: "there should be around the payment section a check mark
 * that says allow for credit card, if that is not checked paying with a credit
 * card should not be an option in quickbooks when the person sees it".
 *
 * Card fees are a percentage, so they scale with the invoice — noise on a single
 * box, real money on a wholesale case order. It is sent to Intuit as
 * AllowOnlineCreditCardPayment.
 *
 * The field is ALWAYS sent, both ways. Omitting it when true would hand the
 * decision back to the QuickBooks company default, so an invoice deliberately
 * marked no-card could still show a Pay-by-card button while this app's screen
 * said otherwise. That is the failure worth a test.
 */
const { toQboInvoice } = require('../src/shared/invoices')
const cardRefs = new Map<string, any>([['dropship hobby box', { id: '77', name: 'Dropship Hobby Box' }]])
const payloadFor = (id: string): any =>
  toQboInvoice(inv.getInvoice(id), { id: '1', name: 'Invented Buyer' }, cardRefs, {})

// Omitted means allowed, so nothing that predates the box changes behaviour.
ok(inv.getInvoice(normal.id).allowCreditCard === true, 'an order raised without the box allows card')
ok(
  payloadFor(normal.id).AllowOnlineCreditCardPayment === true,
  'and says so explicitly to QuickBooks rather than staying silent',
  String(payloadFor(normal.id).AllowOnlineCreditCardPayment)
)

const noCard = inv.saveInvoice(
  {
    customerName: 'Invented Buyer',
    invoiceDate: '2026-04-04',
    location: 'RM',
    allowCreditCard: false,
    lines: [{ item: 'Dropship Hobby Box', productId: 'p_d', quantity: 1, rate: 400 }]
  },
  null
)
ok(inv.getInvoice(noCard.id).allowCreditCard === false, 'unticking it is stored')
ok(
  payloadFor(noCard.id).AllowOnlineCreditCardPayment === false,
  'AND QUICKBOOKS IS TOLD NOT TO OFFER A CARD',
  String(payloadFor(noCard.id).AllowOnlineCreditCardPayment)
)

// It survives an edit, and can be turned back on.
inv.saveInvoice(
  {
    id: noCard.id,
    customerName: 'Invented Buyer',
    invoiceDate: '2026-04-04',
    location: 'RM',
    allowCreditCard: false,
    lines: [{ item: 'Dropship Hobby Box', productId: 'p_d', quantity: 2, rate: 400 }]
  },
  null
)
ok(inv.getInvoice(noCard.id).allowCreditCard === false, 'and survives an edit')
inv.saveInvoice(
  {
    id: noCard.id,
    customerName: 'Invented Buyer',
    invoiceDate: '2026-04-04',
    location: 'RM',
    allowCreditCard: true,
    lines: [{ item: 'Dropship Hobby Box', productId: 'p_d', quantity: 2, rate: 400 }]
  },
  null
)
ok(inv.getInvoice(noCard.id).allowCreditCard === true, 'and can be turned back on')

// A DROPSHIP IS BILLED THE SAME WAY. The goods coming from a supplier says
// nothing about how the buyer may pay, and quietly changing it would be a
// decision nobody made.
const dropNoCard = inv.saveInvoice(
  {
    customerName: 'Invented Buyer',
    invoiceDate: '2026-04-05',
    location: 'RM',
    allowCreditCard: false,
    lines: [
      {
        item: 'Dropship Hobby Box',
        productId: 'p_d',
        quantity: 2,
        rate: 400,
        destination: 'Fenwick Distribution',
        supplier: 'Steel City'
      }
    ]
  },
  null
)
ok(
  inv.getInvoice(dropNoCard.id).allowCreditCard === false,
  'a dropship sales order carries the same choice'
)
ok(
  payloadFor(dropNoCard.id).AllowOnlineCreditCardPayment === false,
  'and sends it the same way'
)
ok(
  salesOrderKindOf(listed(dropNoCard.id)) === 'drop',
  'while still reading as a dropship for the board'
)

// The form offers it, and the receipt says so when it was withheld.
const modalSrc = require('node:fs').readFileSync(
  join(process.cwd(), 'src/renderer/src/modules/invoices/CreateInvoiceModal.tsx'),
  'utf8'
)
ok(/Allow payment by credit card/i.test(modalSrc), 'the sales order form offers the choice')
ok(modalSrc.includes('allowCreditCard'), 'and sends it with the order')
ok(
  modalSrc.includes('invoice.allowCreditCard === false'),
  'a posted invoice says when card was withheld — it is read-only, so this is the only place to find out'
)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
