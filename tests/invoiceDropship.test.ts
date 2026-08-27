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
/**
 * THE SAME COLUMNS EXCEPT ONE, and the exception is the point.
 *
 * `po-col-supplier` is gone from the sales order. On a PURCHASE order the
 * supplier and the destination are different parties answering different
 * questions — who we buy from, and where the goods go. On a SALES order the
 * goods always go to the buyer, so "Fulfilled from" naming anything but a shelf
 * is ALREADY saying which party ships it, and a Supplier column beside it asked
 * the same question twice and got the same answer twice.
 *
 * The stored FIELD survives — see the multi-shipment suite, which pins that the
 * form still derives it, because `dropshipSuppliersOf` reads it to work out who
 * to raise a purchase order against.
 */
for (const col of ['po-col-qty', 'po-col-price', 'po-col-total', 'po-col-dest', 'po-col-remove']) {
  ok(invSrc.includes(col), `the sales order table declares ${col}, exactly as the PO does`)
}
ok(
  !invSrc.includes('po-col-supplier'),
  'BUT NOT po-col-supplier — on a sales order that column asked the same question as Fulfilled from'
)
ok(
  poSrc.includes('po-col-supplier'),
  'while the purchase order keeps it, where the two are genuinely different parties'
)
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

/**
 * OFF UNLESS SOMEBODY SAYS OTHERWISE.
 *
 * This default started as TRUE, so that nothing changed for callers written
 * before the box existed. The owner then asked for the opposite — "lets make
 * the credit card box off by default" — because the fee is a percentage, so
 * offering a card is the decision worth taking deliberately.
 *
 * Pinned in saveInvoice and not only in the form. A default that lives in one
 * screen is not a default: the next caller to omit the field would quietly
 * start offering cards again, and nothing would say so.
 */
ok(
  inv.getInvoice(normal.id).allowCreditCard === false,
  'AN ORDER RAISED WITHOUT THE BOX DOES NOT OFFER A CARD'
)
ok(
  payloadFor(normal.id).AllowOnlineCreditCardPayment === false,
  'and says so explicitly to QuickBooks rather than staying silent and letting the company default decide',
  String(payloadFor(normal.id).AllowOnlineCreditCardPayment)
)

// Ticking it is what turns it on, and it still travels all the way to Intuit.
const withCard = inv.saveInvoice(
  {
    customerName: 'Invented Buyer',
    invoiceDate: '2026-04-03',
    location: 'RM',
    allowCreditCard: true,
    lines: [{ item: 'Dropship Hobby Box', productId: 'p_d', quantity: 1, rate: 400 }]
  },
  null
)
ok(inv.getInvoice(withCard.id).allowCreditCard === true, 'ticking it is stored')
ok(
  payloadFor(withCard.id).AllowOnlineCreditCardPayment === true,
  'and QuickBooks is told to offer one',
  String(payloadFor(withCard.id).AllowOnlineCreditCardPayment)
)

/**
 * AN EDIT THAT SAYS NOTHING CHANGES NOTHING.
 *
 * saveInvoice is an upsert and rewrites this column on every save. If the new
 * default applied to edits as well as to new orders, changing an address on an
 * order raised last month would withdraw a card button its buyer has already
 * been shown — and the only sign would be the buyer failing to pay.
 */
inv.saveInvoice(
  {
    id: withCard.id,
    customerName: 'Invented Buyer',
    invoiceDate: '2026-04-03',
    location: 'RM',
    lines: [{ item: 'Dropship Hobby Box', productId: 'p_d', quantity: 3, rate: 400 }]
  },
  null
)
ok(
  inv.getInvoice(withCard.id).allowCreditCard === true,
  'EDITING AN ORDER WITHOUT MENTIONING THE BOX LEAVES ITS OWN ANSWER ALONE',
  String(inv.getInvoice(withCard.id).allowCreditCard)
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

// ...and an edit that says nothing does not take it away again either.
inv.saveInvoice(
  {
    id: noCard.id,
    customerName: 'Invented Buyer',
    invoiceDate: '2026-04-04',
    location: 'RM',
    lines: [{ item: 'Dropship Hobby Box', productId: 'p_d', quantity: 2, rate: 400 }]
  },
  null
)
ok(
  inv.getInvoice(noCard.id).allowCreditCard === true,
  'and a later silent edit does not undo that'
)

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

// The form offers it, and the receipt says so on the exceptional case.
const modalSrc = require('node:fs').readFileSync(
  join(process.cwd(), 'src/renderer/src/modules/invoices/CreateInvoiceModal.tsx'),
  'utf8'
)
ok(/Allow payment by credit card/i.test(modalSrc), 'the sales order form offers the choice')
ok(modalSrc.includes('allowCreditCard'), 'and sends it with the order')
ok(
  /useState\(invoice\?\.allowCreditCard \?\? false\)/.test(modalSrc),
  'A NEW ORDER OPENS WITH THE BOX UNTICKED'
)
ok(
  !/useState\(invoice\?\.allowCreditCard \?\? true\)/.test(modalSrc),
  'and nothing is left defaulting it back on'
)
/**
 * The receipt prints the RARE answer, and the two answers have swapped places.
 * A posted invoice is read-only, so it is the only place to find out how a
 * buyer was asked to pay — but a warning reading "no card button" on almost
 * every receipt would be crying wolf about the normal case. It flags the
 * offer instead, which is also what explains a card fee on any invoice raised
 * back when cards were the default.
 */
ok(
  modalSrc.includes('invoice.allowCreditCard === true'),
  'a posted invoice says when card WAS offered'
)
ok(
  !/inv-nocard/.test(modalSrc),
  'and no longer warns about the case that is now ordinary'
)


// ---------------------------------------------------------------------------
console.log('\n=== 9. two sales orders cannot share a number ===')
// ---------------------------------------------------------------------------
/**
 * THE BUG THE OWNER SAW: 2337 in the Draft column and 2337 in In QuickBooks,
 * two different orders under one number.
 *
 * `suggestInvoiceNumber` is a READ that reserves nothing, and two places call it
 * independently — the board holds one from its last refresh, and the dropship
 * step fetches its own when that flow begins. With nothing saved in between,
 * both are handed the same number. `saveInvoice` then stored whatever the form
 * sent, on a column with no UNIQUE constraint, so the collision was silent on
 * both sides — and both orders post to QuickBooks under the same DocNumber.
 *
 * The number is now claimed inside the save transaction. It MOVES rather than
 * being refused: the operator filled in a form the app pre-filled, and failing
 * their save to protect a label would lose the order.
 */
const first = inv.saveInvoice(
  {
    invoiceNumber: '9100',
    customerName: 'Invented Buyer',
    invoiceDate: '2026-05-01',
    location: 'RM',
    lines: [{ item: 'Dropship Hobby Box', productId: 'p_d', quantity: 1, rate: 100 }]
  },
  null
)
ok(first.invoiceNumber === '9100', 'the first order takes the number it asked for', String(first.invoiceNumber))

// The exact race: a second form still holding the same suggestion.
const second = inv.saveInvoice(
  {
    invoiceNumber: '9100',
    customerName: 'Invented Buyer',
    invoiceDate: '2026-05-02',
    location: 'RM',
    lines: [{ item: 'Dropship Hobby Box', productId: 'p_d', quantity: 1, rate: 100 }]
  },
  null
)
ok(second.id !== first.id, 'the second order is a different order')
ok(second.invoiceNumber !== '9100', 'AND IT DOES NOT GET 9100', String(second.invoiceNumber))
ok(second.invoiceNumber === '9101', 'it moves up to the next free number', String(second.invoiceNumber))
ok(
  inv.getInvoice(first.id).invoiceNumber === '9100',
  'the order that had it KEEPS it — the newer one moves'
)

// The move is on the order's own history, so the gap is explainable later.
const events = require('../src/main/db/orderExtras').listOrderEvents('so', second.id)
ok(
  events.some((e: any) => /9100 was already taken/i.test(e.detail ?? '')),
  'and the renumber is recorded on the order',
  events.map((e: any) => e.detail).join(' | ')
)

// It walks PAST a taken number rather than colliding with the next one too.
const third = inv.saveInvoice(
  {
    invoiceNumber: '9100',
    customerName: 'Invented Buyer',
    invoiceDate: '2026-05-03',
    location: 'RM',
    lines: [{ item: 'Dropship Hobby Box', productId: 'p_d', quantity: 1, rate: 100 }]
  },
  null
)
ok(third.invoiceNumber === '9102', 'a third walks past both', String(third.invoiceNumber))

// EDITING AN ORDER KEEPS ITS OWN NUMBER. The clash check excludes the row being
// saved, or every edit would push the order up by one.
inv.saveInvoice(
  {
    id: first.id,
    invoiceNumber: '9100',
    customerName: 'Invented Buyer',
    invoiceDate: '2026-05-01',
    location: 'RM',
    lines: [{ item: 'Dropship Hobby Box', productId: 'p_d', quantity: 2, rate: 100 }]
  },
  null
)
ok(
  inv.getInvoice(first.id).invoiceNumber === '9100',
  'editing an order does not renumber it',
  String(inv.getInvoice(first.id).invoiceNumber)
)

// A DRAFT WITH NO NUMBER IS FINE, and several at once are fine — the unique
// index is partial for exactly this reason.
const d1 = inv.saveInvoice(
  { customerName: 'Invented Buyer', invoiceDate: '2026-05-04', location: 'RM',
    lines: [{ item: 'Dropship Hobby Box', productId: 'p_d', quantity: 1, rate: 10 }] },
  null
)
const d2 = inv.saveInvoice(
  { customerName: 'Invented Buyer', invoiceDate: '2026-05-05', location: 'RM',
    lines: [{ item: 'Dropship Hobby Box', productId: 'p_d', quantity: 1, rate: 10 }] },
  null
)
ok(!!d1.id && !!d2.id, 'two unnumbered drafts both save')
ok(!inv.getInvoice(d1.id).invoiceNumber, 'and stay unnumbered')

// The database itself refuses a duplicate now, which is the backstop under all
// of the above.
let indexHeld = false
try {
  db.prepare(`UPDATE invoices SET invoice_number = '9100' WHERE id = ?`).run(third.id)
} catch {
  indexHeld = true
}
ok(indexHeld, 'THE UNIQUE INDEX REFUSES A DUPLICATE even by raw SQL')

// ---------------------------------------------------------------------------
console.log('\n=== N. the fulfilment gates, against a real database ===')
// ---------------------------------------------------------------------------
/**
 * The stage machine is tested on its own in tests/fulfillment.ts. What is
 * proved HERE is the half that only a database can prove: that the numbers the
 * rules read are the numbers the database actually holds.
 *
 * `drawnUnits` is the one that matters. applyInvoiceStock takes MIN(asked, on
 * hand), so a short order draws what it can and quietly owes the rest — and the
 * only way to know is to compare what was asked against what invoice_stock_moves
 * recorded. Get that subquery wrong and Awaiting items silently never fires for
 * a stock order, which is the failure this whole board exists to prevent.
 */
const { fulfillmentStageOf } = require('../src/shared/fulfillment')

const onShelf = qtyAt('RM')
// Deliberately more than the shelf holds.
const short = inv.saveInvoice(
  {
    customerName: 'Invented Buyer',
    invoiceDate: '2026-04-10',
    location: 'RM',
    paymentTiming: 'delivery',
    lines: [
      { item: 'Dropship Hobby Box', productId: 'p_d', quantity: onShelf + 5, rate: 100 }
    ]
  },
  null
)
const shortRead = inv.getInvoice(short.id)
ok(
  shortRead.stockUnits === onShelf + 5,
  'the order asks for more than the shelf holds',
  String(shortRead.stockUnits)
)
ok(
  shortRead.drawnUnits === onShelf,
  'AND DRAWN UNITS REPORTS WHAT THE SHELF ACTUALLY GAVE — not what was asked for',
  `${shortRead.drawnUnits} of ${shortRead.stockUnits}`
)
ok(
  fulfillmentStageOf(shortRead) === 'awaiting_items',
  'so the order sits in Awaiting items',
  String(fulfillmentStageOf(shortRead))
)

// Measure it — it must NOT jump the items gate.
const measured = inv.setInvoiceDims(
  short.id,
  { weightLb: 6.5, lengthIn: 12, widthIn: 9, heightIn: 4 },
  null
)
ok(measured.invoice?.weightLb === 6.5, 'the measurements round-trip', String(measured.invoice?.weightLb))
ok(
  fulfillmentStageOf(inv.getInvoice(short.id)) === 'awaiting_items',
  'MEASURING A BOX THAT HAS NOT ARRIVED DOES NOT MOVE IT — the gates are asked in order'
)

// A covered order, on delivery terms, unmeasured.
const covered = inv.saveInvoice(
  {
    customerName: 'Invented Buyer',
    invoiceDate: '2026-04-11',
    location: 'RM',
    paymentTiming: 'delivery',
    lines: [{ item: 'Dropship Hobby Box', productId: 'p_d', quantity: 1, rate: 100 }]
  },
  null
)
invStock.addStock('p_d', 'RM', 50, 50, null)
const covered2 = inv.saveInvoice(
  {
    customerName: 'Invented Buyer',
    invoiceDate: '2026-04-12',
    location: 'RM',
    paymentTiming: 'delivery',
    lines: [{ item: 'Dropship Hobby Box', productId: 'p_d', quantity: 2, rate: 100 }]
  },
  null
)
ok(
  fulfillmentStageOf(inv.getInvoice(covered2.id)) === 'awaiting_dims',
  'a covered order on delivery terms is awaiting dims',
  String(fulfillmentStageOf(inv.getInvoice(covered2.id)))
)
inv.setInvoiceDims(covered2.id, { weightLb: 2, lengthIn: 8, widthIn: 6, heightIn: 4 }, null)
ok(
  fulfillmentStageOf(inv.getInvoice(covered2.id)) === 'ready',
  'AND MEASURING IT MOVES IT TO READY TO SHIP'
)
// Clearing them puts it back, which is how a repacked parcel is re-measured.
inv.setInvoiceDims(covered2.id, { weightLb: null, lengthIn: null, widthIn: null, heightIn: null }, null)
ok(
  fulfillmentStageOf(inv.getInvoice(covered2.id)) === 'awaiting_dims',
  'and clearing them puts it back, for a parcel that was repacked'
)

// The dropship half: it cannot answer for itself.
const dropWait = inv.saveInvoice(
  {
    customerName: 'Invented Buyer',
    invoiceDate: '2026-04-13',
    location: 'RM',
    paymentTiming: 'delivery',
    lines: [
      {
        item: 'Dropship Hobby Box',
        productId: 'p_d',
        quantity: 3,
        rate: 100,
        destination: 'Fenwick Distribution',
        supplier: 'Steel City'
      }
    ]
  },
  null
)
ok(
  fulfillmentStageOf(inv.getInvoice(dropWait.id)) === 'awaiting_items',
  'a dropship waits to be told the goods exist'
)
inv.setInvoiceItemsInHand(dropWait.id, true, null)
ok(
  !!inv.getInvoice(dropWait.id).itemsInHandAt,
  'confirming it is stored with a timestamp'
)
ok(
  fulfillmentStageOf(inv.getInvoice(dropWait.id)) === 'awaiting_dims',
  'AND MOVES IT ON — to dims, not to ready, because nobody has measured it'
)

// Sending it anyway, which is the only way an unpaid up-front order gets there.
const upfront = inv.saveInvoice(
  {
    customerName: 'Invented Buyer',
    invoiceDate: '2026-04-14',
    location: 'RM',
    paymentTiming: 'front',
    lines: [{ item: 'Dropship Hobby Box', productId: 'p_d', quantity: 1, rate: 100 }]
  },
  null
)
ok(
  fulfillmentStageOf(inv.getInvoice(upfront.id)) === null,
  'an unpaid up-front order is not on the board at all'
)
inv.setInvoiceForceReady(upfront.id, true, null)
const forcedRead = inv.getInvoice(upfront.id)
ok(!!forcedRead.forceReadyAt, 'the override is stored as its own fact')
ok(
  fulfillmentStageOf(forcedRead) === 'ready',
  'AND PUTS IT STRAIGHT INTO READY TO SHIP — the case the owner asked for by name'
)
ok(
  forcedRead.status !== 'paid',
  'WITHOUT FAKING A PAYMENT — the money has not arrived and the order must not claim it has'
)
const forcedEvents = db
  .prepare(`SELECT detail FROM order_events WHERE order_kind = 'so' AND order_id = ?`)
  .all(upfront.id) as Array<{ detail: string }>
ok(
  forcedEvents.some((e) => /by hand/i.test(e.detail ?? '')),
  'and the order says a person decided it, six months from now',
  forcedEvents.map((e) => e.detail).join(' | ')
)
inv.setInvoiceForceReady(upfront.id, false, null)
ok(
  fulfillmentStageOf(inv.getInvoice(upfront.id)) === null,
  'withdrawing it puts the order back behind the gates'
)

// A void is never packable, whoever said otherwise.
inv.setInvoiceForceReady(covered.id, true, null)
inv.setInvoiceStatus(covered.id, 'void', null)
ok(
  fulfillmentStageOf(inv.getInvoice(covered.id)) === null,
  'AND A VOID IS OFF THE BOARD EVEN WHEN IT WAS FORCED ONTO IT'
)

// ---------------------------------------------------------------------------
console.log('\n=== N+1. reaching Payment is not being paid ===')
// ---------------------------------------------------------------------------
/**
 * The last bucket used to be called Paid and moving a card into it stamped
 * paid_at — one gesture doing two jobs, so the app had no way to say "this is at
 * the settling-up step and nobody has paid". The column is Payment now and the
 * money is its own fact, marked inside it or read from QuickBooks.
 *
 * The other half matters just as much: moving BACKWARDS used to wipe paid_at,
 * silently, on a drag. A real payment date is not something a card position
 * should be able to erase.
 */
const { isInvoicePaid } = require('../src/shared/invoices')

const payIt = inv.saveInvoice(
  {
    customerName: 'Invented Buyer',
    invoiceDate: '2026-04-20',
    location: 'RM',
    lines: [{ item: 'Dropship Hobby Box', productId: 'p_d', quantity: 1, rate: 500 }]
  },
  null
)
inv.setInvoiceStatus(payIt.id, 'paid', null)
const atPayment = inv.getInvoice(payIt.id)
ok(atPayment.status === 'paid', 'the order reaches the Payment stage')
ok(
  atPayment.paidAt === null,
  'AND IS NOT PAID BY ARRIVING THERE — the column is a step, not a receipt',
  String(atPayment.paidAt)
)
ok(!isInvoicePaid(atPayment), 'so it reads as unpaid')

const marked = inv.setInvoicePaid(payIt.id, true, null)
ok(!!marked.invoice?.paidAt, 'marking it paid stamps the date')
ok(isInvoicePaid(inv.getInvoice(payIt.id)), 'and it reads as paid')
ok(
  inv.getInvoice(payIt.id).status === 'paid',
  'WITHOUT MOVING IT — a tick is not the app deciding where the card should sit'
)

// Backwards off Payment must not erase a real payment date.
inv.setInvoiceStatus(payIt.id, 'sent', null)
ok(
  isInvoicePaid(inv.getInvoice(payIt.id)),
  'MOVING IT BACK DOES NOT WIPE THE PAYMENT — a drag must not erase a date somebody recorded'
)

// Un-marking is available and says what it is.
inv.setInvoicePaid(payIt.id, false, null)
ok(!isInvoicePaid(inv.getInvoice(payIt.id)), 'and it can be withdrawn')
const paidEvents = db
  .prepare(`SELECT detail FROM order_events WHERE order_kind = 'so' AND order_id = ?`)
  .all(payIt.id) as Array<{ detail: string }>
ok(
  paidEvents.some((e) => /Marked paid/i.test(e.detail ?? '')) &&
    paidEvents.some((e) => /not paid/i.test(e.detail ?? '')),
  'both are on the record',
  paidEvents.map((e) => e.detail).join(' | ')
)

// A void owes nothing and is owed nothing.
const voided = inv.saveInvoice(
  {
    customerName: 'Invented Buyer',
    invoiceDate: '2026-04-21',
    location: 'RM',
    lines: [{ item: 'Dropship Hobby Box', productId: 'p_d', quantity: 1, rate: 100 }]
  },
  null
)
inv.setInvoicePaid(voided.id, true, null)
inv.setInvoiceStatus(voided.id, 'void', null)
ok(
  !isInvoicePaid(inv.getInvoice(voided.id)),
  'VOIDING CLEARS THE PAYMENT — an order that was cancelled has not been paid'
)
ok(
  inv.setInvoicePaid(voided.id, true, null).error !== undefined,
  'and a void refuses to be marked paid'
)

// ---------------------------------------------------------------------------
console.log('\n=== who ships it, and who it is for ===')
// ---------------------------------------------------------------------------
/**
 * THE TWO NAMES NEITHER BOARD COULD SAY.
 *
 * A dropship sales order has always known it WAS a dropship — salesOrderKindOf
 * reads sourcePoId and the unit split — and had no way to name the supplier who
 * has the boxes. A dropship purchase order has always known where its units go
 * — a shelf name, or "Multi-shipment" — and never who is on the other end.
 *
 * So chasing a late case, or sending a label, meant opening the sale, reading
 * the purchase order's number, and going to find it on the other board.
 */
const poRepo = require('../src/main/db/purchaseOrders')

const supplyPo = poRepo.createPurchaseOrder(
  {
    supplier: 'Steel City Collectibles',
    location: 'Fenwick Card Shop',
    lines: [{ productId: 'p_d', quantity: 4, unitPrice: 90 }]
  },
  null
)

// A sale off our own shelf, bound to that purchase. NOTHING on its lines names
// a supplier, which is exactly what dropshipSaleFromPurchase leaves behind —
// so the source purchase order is the only thing that can answer.
const inherited = inv.saveInvoice(
  {
    customerName: 'Fenwick Card Shop',
    invoiceDate: '2026-06-01',
    location: 'RM',
    lines: [{ item: 'Dropship Hobby Box', productId: 'p_d', quantity: 4, rate: 140 }]
  },
  null
)
inv.linkDropshipPair(supplyPo.id, inherited.id, null)
const inheritedBack = inv.getInvoice(inherited.id)
ok(
  inheritedBack.dropSupplier === 'Steel City Collectibles',
  'A SALE WITH NO SUPPLIER ON ITS LINES FALLS BACK TO THE PURCHASE ORDER’S — which is every sale the dropship flow raises',
  String(inheritedBack.dropSupplier)
)
ok(
  inheritedBack.sourcePoNumber === supplyPo.poNumber,
  'and it names the order, so somebody can find it on the other board',
  String(inheritedBack.sourcePoNumber)
)

// A line that names its own supplier WINS over the order's — that is the point
// of the column, and the case where the two disagree is a real one.
const ownSupplier = inv.saveInvoice(
  {
    customerName: 'Invented Buyer',
    invoiceDate: '2026-06-02',
    location: 'RM',
    lines: [
      {
        item: 'Dropship Hobby Box',
        productId: 'p_d',
        quantity: 2,
        rate: 140,
        destination: 'Fenwick Card Shop',
        supplier: 'Harborline Distribution'
      }
    ]
  },
  null
)
ok(
  inv.getInvoice(ownSupplier.id).dropSupplier === 'Harborline Distribution',
  'a line that names its own supplier is read off the line',
  String(inv.getInvoice(ownSupplier.id).dropSupplier)
)

/**
 * AND IT WINS WHEN THE TWO DISAGREE, which is the case the order of the
 * fallback chain exists for. This sale is bound to supplyPo — whose supplier is
 * Steel City Collectibles — while its own line says Harborline shipped it. The
 * line is the more specific fact and the more recent one: somebody typed it on
 * THIS order, about THESE units.
 *
 * Without this pairing the chain is untestable: a sale with a line supplier and
 * no purchase order behind it passes whichever way round the two are read.
 */
const otherPo = poRepo.createPurchaseOrder(
  {
    supplier: 'Steel City Collectibles',
    location: 'Fenwick Card Shop',
    lines: [{ productId: 'p_d', quantity: 2, unitPrice: 90 }]
  },
  null
)
inv.linkDropshipPair(otherPo.id, ownSupplier.id, null)
const disagreeing = inv.getInvoice(ownSupplier.id)
ok(
  disagreeing.sourcePoNumber === otherPo.poNumber,
  'the sale is bound to a purchase order naming somebody else',
  String(disagreeing.sourcePoNumber)
)
ok(
  disagreeing.dropSupplier === 'Harborline Distribution',
  'AND THE LINE STILL WINS — it is the more specific answer, typed about these units',
  String(disagreeing.dropSupplier)
)

/**
 * TWO SUPPLIERS ON ONE SALE NAMES NEITHER.
 *
 * A mixed order can have two halves from two places, and printing one of them
 * would send a label to the wrong building — the same rule the provenance read
 * keeps about destinations. The COUNT is what tells this null apart from
 * "nobody said".
 */
const twoWays = inv.saveInvoice(
  {
    customerName: 'Invented Buyer',
    invoiceDate: '2026-06-03',
    location: 'RM',
    lines: [
      { item: 'Dropship Hobby Box', productId: 'p_d', quantity: 1, rate: 140,
        destination: 'Fenwick Card Shop', supplier: 'Harborline Distribution' },
      { item: 'Dropship Hobby Box', productId: 'p_d', quantity: 1, rate: 140,
        destination: 'Fenwick Card Shop', supplier: 'Steel City Collectibles' }
    ]
  },
  null
)
const splitBack = inv.getInvoice(twoWays.id)
ok(splitBack.dropSupplierCount === 2, 'two suppliers are counted', String(splitBack.dropSupplierCount))
ok(
  splitBack.dropSupplier === null,
  'AND NEITHER IS NAMED — naming one of two sends a label to the wrong building',
  String(splitBack.dropSupplier)
)

// An ordinary sale answers null to both, which is what makes the card draw
// nothing rather than a line saying "from nobody".
const plain = inv.saveInvoice(
  {
    customerName: 'Invented Buyer',
    invoiceDate: '2026-06-04',
    location: 'RM',
    lines: [{ item: 'Dropship Hobby Box', productId: 'p_d', quantity: 1, rate: 140 }]
  },
  null
)
ok(inv.getInvoice(plain.id).dropSupplier === null, 'a sale off our own shelf names no supplier')
ok(inv.getInvoice(plain.id).sourcePoNumber === null, 'and no source order')

// ---- and the same question from the buy side ------------------------------
const supplyRow = poRepo.listPurchaseOrders().find((p: any) => p.id === supplyPo.id)
ok(supplyRow.saleBuyerCount === 1, 'the purchase knows it has one buyer behind it', String(supplyRow.saleBuyerCount))
ok(
  supplyRow.saleBuyer === 'Fenwick Card Shop',
  'AND NAMES THEM — the arrow says where the boxes go, this says whose they are',
  String(listed.saleBuyer)
)

// A second buyer against the same purchase: counted, not named.
const secondBuyer = inv.saveInvoice(
  {
    customerName: 'Coastline Cards',
    invoiceDate: '2026-06-05',
    location: 'RM',
    lines: [{ item: 'Dropship Hobby Box', productId: 'p_d', quantity: 1, rate: 140 }]
  },
  null
)
inv.linkDropshipPair(supplyPo.id, secondBuyer.id, null)
const twoBuyers = poRepo.listPurchaseOrders().find((p: any) => p.id === supplyPo.id)
ok(twoBuyers.saleBuyerCount === 2, 'two buyers are counted', String(twoBuyers.saleBuyerCount))

// VOIDS DROP OUT. A cancelled sale is not somebody waiting on boxes, and
// leaving it in would have the card naming a buyer who fell through.
inv.setInvoiceStatus(secondBuyer.id, 'void', null)
const afterVoid = poRepo.listPurchaseOrders().find((p: any) => p.id === supplyPo.id)
ok(afterVoid.saleBuyerCount === 1, 'VOIDING A SALE TAKES ITS BUYER OFF THE PURCHASE', String(afterVoid.saleBuyerCount))
ok(afterVoid.saleBuyer === 'Fenwick Card Shop', 'leaving the one who is still waiting')

// An ordinary purchase has no sale behind it at all — a third state, and the
// reason the count travels with the name.
const plainPo = poRepo.createPurchaseOrder(
  { supplier: 'Invented Distribution Co', location: 'RM',
    lines: [{ productId: 'p_d', quantity: 2, unitPrice: 90 }] },
  null
)
const plainBack = poRepo.listPurchaseOrders().find((p: any) => p.id === plainPo.id)
ok(plainBack.saleBuyerCount === 0, 'an ordinary purchase has no buyer behind it')
ok(plainBack.saleBuyer === null, 'and names none')

// ---- has it shipped? ------------------------------------------------------
// THE HEADER IS ONLY HALF THE ANSWER. A split shipment lives in
// order_shipments and can leave the header column empty, so a board reading
// only the header reports a fully shipped order as not shipped.
const extras = require('../src/main/db/orderExtras')
ok(inv.getInvoice(plain.id).trackedParcels === 0, 'a sale with no parcels counts none')
extras.saveShipment('so', plain.id, { trackingNumber: '1Z999AA10123456784' }, null)
ok(
  inv.getInvoice(plain.id).trackedParcels === 1,
  'ADDING A PARCEL WITH A NUMBER COUNTS IT, even with nothing on the header',
  String(inv.getInvoice(plain.id).trackedParcels)
)

/**
 * A PARCEL IS NOT A TRACKING NUMBER. A row can be opened to record what a label
 * cost before the number exists — validateShipment accepts a cost alone — and
 * counting those would report an order as shipped on the strength of somebody
 * typing $8.50 into a box.
 */
extras.saveShipment('so', plain.id, { labelCost: 8.5 }, null)
ok(
  inv.getInvoice(plain.id).trackedParcels === 1,
  'BUT A PARCEL WITH NO NUMBER IS NOT COUNTED — a cost is not a shipment',
  String(inv.getInvoice(plain.id).trackedParcels)
)

// ---------------------------------------------------------------------------
console.log('\n=== RE-ROUTING A LINE ON AN ORDER THAT IS ALREADY IN QUICKBOOKS ===')
// ---------------------------------------------------------------------------
/**
 * The owner's words: "on a sales order that is posted into QuickBooks I want the
 * ability to change the destination and supplier if needed, for our own purposes
 * and inventory - not the QuickBooks."
 *
 * He could not. `saveInvoice` throws on anything that is not a draft, correctly:
 * it rewrites every column including the total, and once a document is on
 * somebody's books this app is not its system of record. But where the goods come
 * FROM is not part of that document - "ten cases at $900" is what the buyer
 * agreed, and "two of them ship direct from a supplier" is a fact about this
 * business's inventory, usually discovered afterwards.
 *
 * So `setInvoiceLineRouting` is a separate, narrow write, and the narrowness is
 * the safety. These assertions are mostly about what it must NOT do.
 */
{
  invStock.addStock('p_d', 'RM', 20, 50, null)
  const shelfBefore = qtyAt('RM')

  const posted = inv.saveInvoice(
    {
      customerName: 'Ryan Rubin',
      invoiceNumber: 'SO-8800',
      invoiceDate: '2026-08-20',
      location: 'RM',
      lines: [
        { item: 'Dropship Hobby Box', productId: 'p_d', quantity: 8, rate: 900 },
        { item: 'Dropship Hobby Box', productId: 'p_d', quantity: 2, rate: 900 },
        { item: 'Grading fee', productId: null, quantity: 1, rate: 25 }
      ]
    },
    null
  )
  ok(qtyAt('RM') === shelfBefore - 10, 'ten units came off the shelf', String(qtyAt('RM')))

  // Posted and sent - the state the owner is actually in, and the one in which
  // saveInvoice refuses to touch anything.
  db.prepare(`UPDATE invoices SET status = 'sent', qbo_id = 'qbo-8800' WHERE id = ?`).run(posted.id)
  let threw = ''
  try {
    inv.saveInvoice({ ...posted, id: posted.id, lines: posted.lines }, null)
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err)
  }
  ok(/no longer be edited/i.test(threw), 'saveInvoice still refuses the whole document', threw)

  const before = inv.getInvoice(posted.id)
  const twoCases = before.lines.find((l: any) => l.quantity === 2)

  const res = inv.setInvoiceLineRouting(
    posted.id,
    [{ lineId: twoCases.id, destination: 'Kestrel Cards', supplier: null }],
    null
  )
  ok(!res.error, 'BUT THE ROUTING CAN STILL BE CHANGED', String(res.error))

  const after = inv.getInvoice(posted.id)
  // --- what it must NOT have touched --------------------------------------
  ok(after.total === before.total, 'THE TOTAL IS UNTOUCHED', `${before.total} -> ${after.total}`)
  ok(after.lines.length === 3, 'every line is still there', String(after.lines.length))
  ok(
    after.lines.every((l: any, i: number) => l.quantity === before.lines[i].quantity && l.rate === before.lines[i].rate),
    'with every quantity and every rate exactly as billed'
  )
  ok(after.qboId === 'qbo-8800', 'the QuickBooks id is not even addressed')
  ok(after.status === 'sent', 'and the card has not moved', after.status)

  // --- what it DID do -----------------------------------------------------
  const routed = after.lines.find((l: any) => l.id === twoCases.id)
  ok(routed.destination === 'Kestrel Cards', 'the line is fulfilled from the supplier now', String(routed?.destination))
  ok(routed.dropship === true, 'so it reads as a dropship')
  ok(
    routed.supplier === 'Kestrel Cards',
    'AND THE SUPPLIER IS DERIVED FROM IT - there is no second question to ask',
    String(routed?.supplier)
  )
  ok(after.dropshipUnits === 2 && after.stockUnits === 9, 'two units are a dropship, the rest are stock', `${after.dropshipUnits}/${after.stockUnits}`)
  ok(
    qtyAt('RM') === shelfBefore - 8,
    'AND THE TWO CASES ARE BACK ON THE SHELF - this business never held them',
    String(qtyAt('RM'))
  )
  ok(routed.qtyFulfilled === 0, 'the picking claim on that line is withdrawn with the draw', String(routed?.qtyFulfilled))
  ok(
    after.lines.find((l: any) => l.quantity === 8).qtyFulfilled === 8,
    'while the line that still draws the shelf keeps its eight'
  )

  // --- and back again -----------------------------------------------------
  ok(
    !inv.setInvoiceLineRouting(posted.id, [{ lineId: twoCases.id, destination: 'RM', supplier: null }], null)
      .error,
    'it goes back the other way too'
  )
  const back = inv.getInvoice(posted.id)
  ok(qtyAt('RM') === shelfBefore - 10, 'the two come off the shelf again', String(qtyAt('RM')))
  ok(back.dropshipUnits === 0, 'and nothing is a dropship any more', String(back.dropshipUnits))
  ok(
    back.lines.find((l: any) => l.id === twoCases.id).destination === 'RM',
    'the line names the shelf'
  )
  ok(
    back.lines.find((l: any) => l.id === twoCases.id).supplier === null,
    'AND THE SUPPLIER IS CLEARED - a shelf line has none'
  )
  ok(back.total === before.total, 'the total STILL has not moved', String(back.total))

  /**
   * A NON-INHERITING SHELF still clears the supplier. Routing back to the
   * ORDER's own shelf stores NULL and would hide a supplier that was never
   * cleared; naming the other shelf is the case that catches it.
   */
  ok(
    !inv.setInvoiceLineRouting(posted.id, [{ lineId: twoCases.id, destination: 'AM', supplier: null }], null)
      .error,
    'a line can be moved to the other shelf'
  )
  const onAm = inv.getInvoice(posted.id).lines.find((l: any) => l.id === twoCases.id)
  ok(onAm.destination === 'AM', 'it names AM', String(onAm?.destination))
  ok(onAm.dropship === false, 'which is still a shelf, not a dropship')
  ok(
    onAm.supplier === null,
    'AND CARRIES NO SUPPLIER — a shelf line has none, whichever shelf it is',
    String(onAm?.supplier)
  )

  /**
   * THE STORED DESTINATION INHERITS rather than being a copy. Read back through
   * toLine both look like "RM", so this asks the column directly: a copy would
   * stop following the header the first time the order's location moved.
   */
  inv.setInvoiceLineRouting(posted.id, [{ lineId: twoCases.id, destination: 'RM', supplier: null }], null)
  const raw = db
    .prepare(`SELECT destination FROM invoice_lines WHERE id = ?`)
    .get(twoCases.id) as { destination: string | null }
  ok(
    raw.destination === null,
    'ROUTING TO THE ORDER\u2019S OWN SHELF STORES NULL, so the line keeps following the header',
    String(raw.destination)
  )

  /**
   * A LINE WITH NO CATALOG PRODUCT NEVER MOVES STOCK. The grading fee is on this
   * order precisely so that the filter has something to refuse.
   */
  const fee = inv.getInvoice(posted.id).lines.find((l: any) => !l.productId)
  const feeMoves = db
    .prepare(
      `SELECT COUNT(*) AS n FROM invoice_stock_moves WHERE invoice_id = ? AND line_position = ?`
    )
    .get(posted.id, fee.position) as { n: number }
  ok(feeMoves.n === 0, 'a service line has no stock move behind it', String(feeMoves.n))
  /**
   * AND IT IS THE PRODUCT TEST THAT DOES IT, not the shelf running out.
   *
   * A line with no product falls out of stockDrawingLines on `!productId`. Drop
   * that half and an ordinary service line still moves nothing — the shelf has
   * none of a null product — so the guard looks redundant right up until a line
   * carries a source purchase order, where the quantity is NOT clamped to the
   * shelf and the consumption is asked for outright. Written straight into the
   * column, because no screen can produce it and sync or an import can.
   */
  db.prepare(`UPDATE invoice_lines SET source_po_id = 'po-ghost' WHERE id = ?`).run(fee.id)
  let feeThrew = ''
  try {
    inv.setInvoiceLineRouting(posted.id, [{ lineId: twoCases.id, destination: 'RM', supplier: null }], null)
  } catch (err) {
    feeThrew = err instanceof Error ? err.message : String(err)
  }
  ok(feeThrew === '', 'A SERVICE LINE NAMING A PURCHASE ORDER STILL MOVES NOTHING', feeThrew)
  db.prepare(`UPDATE invoice_lines SET source_po_id = NULL WHERE id = ?`).run(fee.id)

  /**
   * THE ROADSHOW POINTER SURVIVES THE FLIP TO DROPSHIP — as a RECORD.
   *
   * This used to assert the opposite, and the reasoning was half right:
   * `source_po_id` says which cost layers to consume, and a line consuming none
   * cannot say whose. True of the COST. But the owner's case is exactly the
   * line that consumes nothing — "we need to know where products are coming
   * from, and those are open tabs" — a case bought on a roadshow tab and
   * shipped straight to the buyer, which never reaches a shelf here and under
   * the old rule had nowhere to record where it came from either.
   *
   * So the column now answers "where did these goods come from" on any line,
   * and `holdsStock` beside it says which of the two things that means. The
   * safety is structural rather than a clear-on-write: `effectiveSlices` is the
   * cost view and blanks the order on a slice that draws no shelf, and
   * everything that spends money asks `effectiveSlices` — which the next
   * assertion is here to prove.
   */
  const eight = inv.getInvoice(posted.id).lines.find((l: any) => l.quantity === 8)
  db.prepare(`UPDATE invoice_lines SET source_po_id = 'po-roadshow' WHERE id = ?`).run(eight.id)
  inv.setInvoiceLineRouting(posted.id, [{ lineId: eight.id, destination: 'Kestrel Cards', supplier: null }], null)
  const kept = db
    .prepare(`SELECT source_po_id FROM invoice_lines WHERE id = ?`)
    .get(eight.id) as { source_po_id: string | null }
  ok(
    kept.source_po_id === 'po-roadshow',
    'A LINE FLIPPED TO DROPSHIP KEEPS ITS PURCHASE ORDER — that is where the goods came from, and it is the only place a dropship can say so',
    String(kept.source_po_id)
  )
  /**
   * AND IT SPENDS NOTHING. 'po-roadshow' is not a row in this database at all,
   * so if the value had reached the coverage check or `consumeFromPo` the write
   * above would have been refused with "that purchase order is gone" — and if it
   * had reached the shelf it would have taken eight cases off a purchase order
   * that does not exist. Neither happened, because `stockDrawingLines` filters
   * on `holdsStock` before it ever reads the column.
   */
  const dropMoves = db
    .prepare(
      `SELECT COUNT(*) AS n FROM invoice_stock_moves WHERE invoice_id = ? AND line_position = ?`
    )
    .get(posted.id, eight.position) as { n: number }
  ok(
    dropMoves.n === 0,
    'AND MOVES NO STOCK AGAINST IT — the record is a record, and nothing that costs money can see it',
    String(dropMoves.n)
  )
  // Cleared by hand before flipping back, because on a shelf the SAME column is
  // a claim on cost layers and 'po-roadshow' holds none — the routing back would
  // be refused, correctly, by the coverage check.
  db.prepare(`UPDATE invoice_lines SET source_po_id = NULL WHERE id = ?`).run(eight.id)
  inv.setInvoiceLineRouting(posted.id, [{ lineId: eight.id, destination: 'RM', supplier: null }], null)

  // --- refusals -----------------------------------------------------------
  ok(
    !!inv.setInvoiceLineRouting(posted.id, [{ lineId: 'not-a-line', destination: 'RM', supplier: null }], null)
      .error,
    'a line that is not on this order is refused'
  )
  ok(
    inv.getInvoice(posted.id).lines.length === 3,
    'and the refusal changes nothing - the whole thing is one transaction'
  )
  ok(
    !inv.setInvoiceLineRouting(posted.id, [], null).error,
    'changing nothing is not an error'
  )

  // A VOID order has already handed its stock back. Re-applying would take it a
  // second time, off a shelf that has no claim on it.
  inv.setInvoiceStatus(posted.id, 'void', null)
  const onVoid = inv.setInvoiceLineRouting(
    posted.id,
    [{ lineId: twoCases.id, destination: 'Kestrel Cards', supplier: null }],
    null
  )
  ok(!!onVoid.error && /void/i.test(onVoid.error), 'A VOID ORDER IS REFUSED', String(onVoid.error))
  ok(qtyAt('RM') === shelfBefore, 'with every unit back on the shelf and none taken twice', String(qtyAt('RM')))
}

// ---------------------------------------------------------------------------
console.log('\n=== WHOSE CASES A POSTED LINE TAKES, and both histories saying so ===')
// ---------------------------------------------------------------------------
/**
 * The owner's requirement, in his words: "if we change where a case is coming
 * from for our own inventory and PO and SO history that it is reflective of
 * that."
 *
 * Two questions, deliberately separate. WHERE a line comes from — a shelf or a
 * supplier — was the first half. WHOSE cases it takes when it comes off a shelf
 * is this one: it decides where the COST comes from, and it was previously
 * settable only while the order was still a draft.
 *
 * The half that is easy to forget is the purchase order's own log. A line moving
 * onto an order changes what that ORDER supplied, and a sale's history alone
 * would leave the purchase silently different from what its history says.
 */
{
  const poRepo = require('../src/main/db/purchaseOrders')
  const extrasRepo = require('../src/main/db/orderExtras')

  // A purchase order that actually BRINGS IN stock, so its cases are on a shelf
  // and can be sold out of.
  const roadshow = poRepo.createPurchaseOrder(
    {
      supplier: 'Roadshow Dallas',
      location: 'RM',
      ongoing: true,
      lines: [{ productId: 'p_d', item: 'Dropship Hobby Box', quantity: 20, unitPrice: 400 }]
    },
    null
  )
  poRepo.setPurchaseOrderStatus(roadshow.id, 'received', null)

  const sale = inv.saveInvoice(
    {
      customerName: 'Cost Basis Buyer',
      invoiceNumber: 'SO-8900',
      invoiceDate: '2026-08-21',
      location: 'RM',
      lines: [{ item: 'Dropship Hobby Box', productId: 'p_d', quantity: 2, rate: 900 }]
    },
    null
  )
  db.prepare(`UPDATE invoices SET status = 'sent', qbo_id = 'qbo-8900' WHERE id = ?`).run(sale.id)
  const line = inv.getInvoice(sale.id).lines[0]
  ok(line.sourcePoId === null, 'the line names no purchase order to begin with')

  const poEvents = (poId: string): string[] =>
    extrasRepo.listOrderEvents('po', poId).map((e: any) => e.detail ?? '')

  // --- naming one --------------------------------------------------------
  const named = inv.setInvoiceLineRouting(
    sale.id,
    [{ lineId: line.id, destination: 'RM', supplier: null, sourcePoId: roadshow.id }],
    null
  )
  ok(!named.error, 'A POSTED LINE CAN NOW SAY WHOSE CASES IT TAKES', String(named.error))
  ok(
    inv.getInvoice(sale.id).lines[0].sourcePoId === roadshow.id,
    'the line names the purchase order'
  )
  ok(
    poEvents(roadshow.id).some((d: string) => /now come out of this order/i.test(d)),
    'AND THE PURCHASE ORDER\u2019S OWN HISTORY SAYS SO',
    poEvents(roadshow.id).join(' | ')
  )
  ok(
    extrasRepo
      .listOrderEvents('so', sale.id)
      .some((e: any) => /Re-routed/i.test(e.detail ?? '')),
    'and the sale\u2019s history does too'
  )
  ok(inv.getInvoice(sale.id).total === sale.total, 'with the total still untouched')

  /**
   * AND THE DEAL TICKET FOLDS, because naming a RUNNING roadshow order on a
   * posted sale means exactly what naming it on a draft did: a week of buying
   * from one shop and everything sold out of it is one deal under one number.
   * Same rule, same function — see foldRoadshowTicket.
   */
  const folded = db
    .prepare(`SELECT merged_into FROM deal_tickets WHERE document_kind = 'so' AND document_id = ?`)
    .get(sale.id) as any
  ok(
    !!folded?.merged_into,
    'THE SALE JOINS THE ROADSHOW\u2019S DEAL TICKET, the same as it would on a draft',
    String(folded?.merged_into)
  )

  // --- taking it off again ------------------------------------------------
  ok(
    !inv.setInvoiceLineRouting(
      sale.id,
      [{ lineId: line.id, destination: 'RM', supplier: null, sourcePoId: null }],
      null
    ).error,
    'and it can be taken off again'
  )
  ok(inv.getInvoice(sale.id).lines[0].sourcePoId === null, 'the line names nobody')
  ok(
    poEvents(roadshow.id).some((d: string) => /no longer come out of this order/i.test(d)),
    'AND THE PURCHASE ORDER IS TOLD IT LOST THEM — a log that only ever gains claims is a wrong log',
    poEvents(roadshow.id).join(' | ')
  )

  // --- absence means LEAVE IT ALONE ---------------------------------------
  /**
   * `undefined` and `null` are different answers. A caller changing only the
   * destination must not silently drop a pointer somebody set last week.
   *
   * PINNED THROUGH A REFUSAL, which is a stronger statement than a success
   * would be. This roadshow's cases came in on RM, so moving the line to AM
   * while it still claims them is a contradiction — "these two come off the AM
   * shelf, out of an order whose stock is on RM" — and it is refused by name.
   * Had `undefined` been flattened to null the pointer would be gone, the line
   * would claim nothing, and moving it to AM would sail straight through. The
   * refusal IS the evidence the pointer survived the crossing.
   *
   * It used to be asserted the other way round, as "a route-only change is
   * allowed", and it passed for the wrong reason: applyInvoiceStock drew every
   * line from the ORDER's shelf and ignored the line's own, so a line saying AM
   * quietly took two cases off RM. A split line can name two shelves at once,
   * so that shortcut had to go — see stockDrawingLines.
   */
  inv.setInvoiceLineRouting(
    sale.id,
    [{ lineId: line.id, destination: 'RM', supplier: null, sourcePoId: roadshow.id }],
    null
  )
  const wrongShelf = inv.setInvoiceLineRouting(
    sale.id,
    [{ lineId: line.id, destination: 'AM', supplier: null }],
    null
  )
  ok(
    !!wrongShelf.error,
    'A LINE CANNOT TAKE AN ORDER’S CASES OFF A SHELF THEY ARE NOT ON',
    String(wrongShelf.error)
  )
  ok(/AM shelf/i.test(wrongShelf.error ?? ''), 'and the refusal names the shelf', String(wrongShelf.error))
  ok(
    inv.getInvoice(sale.id).lines[0].sourcePoId === roadshow.id,
    'AND LEAVES THE PURCHASE ORDER POINTER EXACTLY WHERE IT WAS',
    String(inv.getInvoice(sale.id).lines[0].sourcePoId)
  )
  ok(
    (inv.getInvoice(sale.id).lines[0].destination ?? 'RM') === 'RM',
    'and the refused destination was never written — one transaction, all or nothing'
  )
  /**
   * AND WRITES NOTHING ON THE PURCHASE ORDER, because nothing about that order
   * changed. A log that gains a line every time somebody adjusts a shelf is a
   * log nobody reads, and "these lines now come out of this order" said three
   * times in a row is three claims where one thing happened.
   */
  const quietBefore = poEvents(roadshow.id).length
  inv.setInvoiceLineRouting(sale.id, [{ lineId: line.id, destination: 'RM', supplier: null }], null)
  ok(
    poEvents(roadshow.id).length === quietBefore,
    'A CHANGE THAT MOVES NO LINE ONTO OR OFF AN ORDER LEAVES ITS LOG ALONE',
    `${quietBefore} -> ${poEvents(roadshow.id).length}`
  )
  // Put it back on the shelf the cases are actually on.
  inv.setInvoiceLineRouting(sale.id, [{ lineId: line.id, destination: 'RM', supplier: null }], null)

  // --- an order that cannot cover it is REFUSED, by name ------------------
  /**
   * `consumeFromPo` throws rather than topping up from elsewhere when an order
   * is short — the right behaviour, and a thrown transaction is a worse message
   * than a sentence naming both numbers.
   */
  const thin = poRepo.createPurchaseOrder(
    {
      supplier: 'One Case Only',
      location: 'RM',
      lines: [{ productId: 'p_d', item: 'Dropship Hobby Box', quantity: 1, unitPrice: 400 }]
    },
    null
  )
  poRepo.setPurchaseOrderStatus(thin.id, 'received', null)
  const short = inv.setInvoiceLineRouting(
    sale.id,
    [{ lineId: line.id, destination: 'RM', supplier: null, sourcePoId: thin.id }],
    null
  )
  ok(!!short.error, 'AN ORDER THAT CANNOT COVER THE LINE IS REFUSED')
  ok(
    /has 1 of/i.test(short.error ?? '') && /2 more/i.test(short.error ?? ''),
    'naming both numbers — what the order has left, and what this is asking it for',
    String(short.error)
  )
  ok(
    inv.getInvoice(sale.id).lines[0].sourcePoId === roadshow.id,
    'and the line is left on the order it had'
  )

  // --- a dropship line NAMES ONE, and it is a record ----------------------
  /**
   * THE OWNER'S CASE, and the one the old rule made unrecordable: "we need to
   * know where products are coming from, and those are open tabs — so if we
   * attach the roadshow open PO the correct products just have to be attached in
   * the sales order."
   *
   * A case bought on a roadshow tab and shipped straight from the ballroom to
   * the buyer never reaches a shelf here. It has no cost layers to consume, so
   * `source_po_id` cannot be a claim on them — and until this changed it was
   * therefore forced to null, which left the ONE kind of line whose provenance
   * nobody can reconstruct from stock as the one kind of line that could not
   * write it down.
   *
   * So the column records where the goods came from, on any line, and
   * `holdsStock` says whether that is also a claim on cost.
   */
  const onHandBefore = (
    db
      .prepare(
        `SELECT COALESCE(SUM(l.qty_remaining), 0) AS n
           FROM inventory_lots l
           JOIN po_line_receipts r ON r.lot_id = l.id
          WHERE r.po_id = ? AND l.product_id = 'p_d'`
      )
      .get(roadshow.id) as { n: number }
  ).n
  inv.setInvoiceLineRouting(
    sale.id,
    [{ lineId: line.id, destination: 'Kestrel Cards', supplier: null, sourcePoId: roadshow.id }],
    null
  )
  const dropped = inv.getInvoice(sale.id).lines[0]
  ok(dropped.dropship === true, 'the line is a dropship now')
  ok(
    dropped.sourcePoId === roadshow.id,
    'AND IT STILL NAMES THE ROADSHOW ORDER — a dropship off an open tab is exactly where "where did this come from" has to be written down, because no shelf here will ever answer it',
    String(dropped.sourcePoId)
  )
  /**
   * AND THE TAB GAVE UP NOTHING. This is the assertion that makes the record
   * safe: `stockDrawingLines` filters on `holdsStock` BEFORE it reads the
   * column, so there is no path from a dropship line's purchase order to
   * `consumeFromPo`. Counted on the shelf rather than trusted from a flag — the
   * cases the roadshow brought in are still all there.
   */
  const onHandAfter = (
    db
      .prepare(
        `SELECT COALESCE(SUM(l.qty_remaining), 0) AS n
           FROM inventory_lots l
           JOIN po_line_receipts r ON r.lot_id = l.id
          WHERE r.po_id = ? AND l.product_id = 'p_d'`
      )
      .get(roadshow.id) as { n: number }
  ).n
  ok(
    onHandAfter === onHandBefore + 2,
    'AND THE TWO CASES CAME BACK ONTO THE SHELF — the line stopped drawing it, and naming the order did not start again',
    `${onHandBefore} -> ${onHandAfter}`
  )
  /**
   * AND THE PURCHASE ORDER'S OWN LOG SAYS THE RIGHT THING — supplied, shipped
   * direct, NOT "come out of this order's stock". Two claims, and only one of
   * them is about money; a roadshow tab's history claiming a draw on stock it
   * never held is the sort of half-truth that costs somebody an afternoon a year
   * later.
   */
  ok(
    poEvents(roadshow.id).some((d: string) => /supplied by this order, shipped direct/i.test(d)),
    'AND THE PURCHASE ORDER IS TOLD IT SUPPLIED THEM DIRECT, in its own words',
    poEvents(roadshow.id).join(' | ')
  )
  ok(
    !poEvents(roadshow.id).some(
      (d: string) => /come out of this order.s stock/i.test(d) && /shipped direct/i.test(d)
    ),
    'and never in the stock sentence — the two are separate passes precisely so neither can borrow the other’s claim'
  )
}

console.log('\n=== ONE LINE, SPLIT BY CASE, EACH CASE FROM ITS OWN PLACE ===')
// ---------------------------------------------------------------------------
/**
 * The owner's words: "for each item in any sales order we can go in and for each
 * individual case adjust where it is coming from, and then basically it
 * corresponds back to inventory or the right dropship PO."
 *
 * Ten cases on one line: eight off the shelf, two shipped direct by a supplier.
 * The line stays a line of ten at one price — nothing here writes a quantity, a
 * rate or an amount, which is the whole reason it is safe on a posted order.
 *
 * What is being pinned:
 *   · the split moves only the units it names, not the line
 *   · the document is untouched — quantity, rate, amount, total
 *   · the board counts UNITS on each side, not lines
 *   · a split that does not add up is refused, and the refusal changes nothing
 *   · "not split" is reachable again, and stores ZERO rows getting there
 *   · two slices of one line can name two different purchase orders
 */
{
  const poRepo = require('../src/main/db/purchaseOrders')
  const extrasRepo = require('../src/main/db/orderExtras')
  const qtyAt = (loc: string): number => invStock.stockQty('p_d', loc)

  // Two purchase orders of the same box on the same shelf, so a split line can
  // take some cases from each — which is the case a whole-line pointer could
  // never express.
  const first = poRepo.createPurchaseOrder(
    {
      supplier: 'Roadshow Austin',
      location: 'RM',
      ongoing: true,
      lines: [{ productId: 'p_d', item: 'Dropship Hobby Box', quantity: 6, unitPrice: 300 }]
    },
    null
  )
  poRepo.setPurchaseOrderStatus(first.id, 'received', null)
  const second = poRepo.createPurchaseOrder(
    {
      supplier: 'Nimbus Distribution',
      location: 'RM',
      lines: [{ productId: 'p_d', item: 'Dropship Hobby Box', quantity: 6, unitPrice: 500 }]
    },
    null
  )
  poRepo.setPurchaseOrderStatus(second.id, 'received', null)

  const shelfBefore = qtyAt('RM')
  const sale = inv.saveInvoice(
    {
      customerName: 'Split Line Buyer',
      invoiceNumber: 'SO-9100',
      invoiceDate: '2026-08-22',
      location: 'RM',
      lines: [{ item: 'Dropship Hobby Box', productId: 'p_d', quantity: 10, rate: 900 }]
    },
    null
  )
  db.prepare(`UPDATE invoices SET status = 'sent', qbo_id = 'qbo-9100' WHERE id = ?`).run(sale.id)
  const lineId = inv.getInvoice(sale.id).lines[0].id

  ok(
    inv.getInvoice(sale.id).lines[0].allocations.length === 0,
    'A LINE STARTS WITH NO SPLITS AT ALL — zero rows, which is what every sale ever written has',
    String(inv.getInvoice(sale.id).lines[0].allocations.length)
  )

  // --- eight off the shelf, two shipped direct ---------------------------
  const split = inv.setInvoiceLineRouting(
    sale.id,
    [
      {
        lineId,
        destination: 'RM',
        supplier: null,
        allocations: [
          { quantity: 8, destination: 'RM', sourcePoId: null },
          { quantity: 2, destination: 'Kestrel Cards', sourcePoId: null }
        ]
      }
    ],
    null
  )
  ok(!split.error, 'A LINE OF TEN CAN BE SPLIT EIGHT AND TWO', String(split.error))

  const afterSplit = inv.getInvoice(sale.id)
  const splitLine = afterSplit.lines[0]
  ok(splitLine.allocations.length === 2, 'the line carries two splits', String(splitLine.allocations.length))
  ok(splitLine.quantity === 10, 'AND IS STILL A LINE OF TEN', String(splitLine.quantity))
  ok(splitLine.rate === 900 && splitLine.amount === 9000, 'at the price it was sold at')
  ok(afterSplit.total === sale.total, 'with the order total untouched', `${afterSplit.total} vs ${sale.total}`)

  /**
   * THE SHELF MOVED BY EIGHT, NOT BY TEN AND NOT BY NOTHING.
   *
   * This is the assertion the whole feature rests on. Before splits a line was
   * all one thing, so two dropship cases on a line of ten meant the shelf gave
   * up either all ten or none of them — one of which invents stock and the
   * other of which sells stock this business never held.
   */
  ok(
    qtyAt('RM') === shelfBefore - 8,
    'THE SHELF GAVE EIGHT — the two dropship cases never touched it',
    `${shelfBefore} -> ${qtyAt('RM')}`
  )
  ok(
    afterSplit.stockUnits === 8 && afterSplit.dropshipUnits === 2,
    'AND THE BOARD COUNTS UNITS ON EACH SIDE, not the whole line on one',
    `${afterSplit.stockUnits} stock / ${afterSplit.dropshipUnits} drop`
  )
  ok(
    splitLine.qtyFulfilled === 8,
    'and the line is eight fulfilled of ten — summed across the splits, not read off one',
    String(splitLine.qtyFulfilled)
  )

  // --- the splits can name two different purchase orders -----------------
  const twoOrders = inv.setInvoiceLineRouting(
    sale.id,
    [
      {
        lineId,
        destination: 'RM',
        supplier: null,
        allocations: [
          { quantity: 6, destination: 'RM', sourcePoId: first.id },
          { quantity: 4, destination: 'RM', sourcePoId: second.id }
        ]
      }
    ],
    null
  )
  ok(!twoOrders.error, 'SIX CASES FROM ONE ORDER AND FOUR FROM ANOTHER', String(twoOrders.error))
  const mixed = inv.getInvoice(sale.id).lines[0]
  ok(
    mixed.allocations.map((a: any) => a.sourcePoId).join() === `${first.id},${second.id}`,
    'each split names its own order',
    mixed.allocations.map((a: any) => a.sourcePoNumber).join(' / ')
  )
  ok(qtyAt('RM') === shelfBefore - 10, 'and all ten now come off the shelf', String(qtyAt('RM')))
  /**
   * TWO STOCK SLICES OF ONE LINE, WHICH IS WHERE A MAP KEYED ON THE LINE BREAKS.
   *
   * `qty_fulfilled` is a per-LINE number and both slices write a move at the
   * same line position, so it has to be the SUM. Indexed instead of summed it
   * keeps whichever move came last, the line reads four fulfilled of ten, and
   * the scan queue offers six units that are already in a box on a van. See
   * movedByPosition.
   */
  ok(
    mixed.qtyFulfilled === 10,
    'AND THE LINE IS TEN FULFILLED — both slices counted, not the last one only',
    String(mixed.qtyFulfilled)
  )
  const poDetail = (poId: string): string =>
    extrasRepo
      .listOrderEvents('po', poId)
      .map((e: any) => e.detail ?? '')
      .join(' | ')
  ok(
    /6 × Dropship Hobby Box/.test(poDetail(first.id)),
    'AND EACH PURCHASE ORDER’S HISTORY NAMES THE NUMBER OF CASES IT SUPPLIED',
    poDetail(first.id)
  )
  ok(/4 × Dropship Hobby Box/.test(poDetail(second.id)), 'both of them', poDetail(second.id))
  /**
   * AND SAVING THE SAME SPLITS AGAIN IS NOT REFUSED.
   *
   * The coverage check has to compare against the INCREASE, not the total. These
   * six cases have already left the shelf and are not in the order's on-hand any
   * more, so a check that read the whole claim would compare six against the
   * nought that is left and refuse a change that takes nothing — which is every
   * second press of Save on a line somebody is adjusting.
   */
  ok(
    !inv.setInvoiceLineRouting(
      sale.id,
      [
        {
          lineId,
          destination: 'RM',
          supplier: null,
          allocations: [
            { quantity: 6, destination: 'RM', sourcePoId: first.id },
            { quantity: 4, destination: 'RM', sourcePoId: second.id }
          ]
        }
      ],
      null
    ).error,
    'SAVING THE SAME SPLITS TWICE IS NOT REFUSED — the check is against the increase, not the total'
  )
  /**
   * AND NO DEAL TICKET FOLDS. `soleSourceOrder` sees two purchase orders and
   * declines — a deal ticket is a claim about ONE deal, and folding this sale
   * into the roadshow would put a week's figure on a shop that supplied four of
   * its ten cases.
   */
  const ticket = db
    .prepare(`SELECT merged_into FROM deal_tickets WHERE document_kind = 'so' AND document_id = ?`)
    .get(sale.id) as any
  ok(
    !ticket?.merged_into,
    'AND THE SALE JOINS NEITHER ORDER’S DEAL TICKET — two suppliers is not one deal',
    String(ticket?.merged_into)
  )

  // --- two shelves on one line -------------------------------------------
  /**
   * FIVE OFF RM AND FIVE OFF AM, which is the case that made the stock engine's
   * old shortcut untenable.
   *
   * `applyInvoiceStock` used to take a single shelf for the whole order and hand
   * it to every line, so a line whose destination said AM quietly drew ten cases
   * off RM: the count on the screen said one thing and the boxes on the racks
   * said another, and nothing anywhere reported a problem. A split line can name
   * two shelves at once, so the shelf is now read PER SLICE — see
   * stockDrawingLines and InvoiceStockLine.location.
   */
  const am = poRepo.createPurchaseOrder(
    {
      supplier: 'Second Room Supply',
      location: 'AM',
      lines: [{ productId: 'p_d', item: 'Dropship Hobby Box', quantity: 5, unitPrice: 450 }]
    },
    null
  )
  poRepo.setPurchaseOrderStatus(am.id, 'received', null)
  const rmBeforeShelves = qtyAt('RM')
  const amBeforeShelves = qtyAt('AM')
  const twoShelves = inv.setInvoiceLineRouting(
    sale.id,
    [
      {
        lineId,
        destination: 'RM',
        supplier: null,
        allocations: [
          { quantity: 5, destination: 'RM', sourcePoId: null },
          { quantity: 5, destination: 'AM', sourcePoId: null }
        ]
      }
    ],
    null
  )
  ok(!twoShelves.error, 'FIVE FROM ONE ROOM AND FIVE FROM THE OTHER', String(twoShelves.error))
  ok(
    qtyAt('AM') === amBeforeShelves - 5,
    'AND THE AM SHELF GAVE FIVE — a slice draws the shelf IT names, not the order’s',
    `${amBeforeShelves} -> ${qtyAt('AM')}`
  )
  ok(
    qtyAt('RM') === rmBeforeShelves + 5,
    'while RM is five better off than it was holding all ten',
    `${rmBeforeShelves} -> ${qtyAt('RM')}`
  )

  // --- a split that does not add up is refused ---------------------------
  const shelfNow = qtyAt('RM')
  const short = inv.setInvoiceLineRouting(
    sale.id,
    [
      {
        lineId,
        destination: 'RM',
        supplier: null,
        allocations: [
          { quantity: 6, destination: 'RM', sourcePoId: null },
          { quantity: 3, destination: 'Kestrel Cards', sourcePoId: null }
        ]
      }
    ],
    null
  )
  ok(!!short.error, 'NINE SPLITS ON A LINE OF TEN IS REFUSED', String(short.error))
  ok(/not accounted for/i.test(short.error ?? ''), 'naming the case that comes from nowhere', String(short.error))
  ok(
    inv.getInvoice(sale.id).lines[0].allocations.length === 2 && qtyAt('RM') === shelfNow,
    'and the refusal changed nothing — one transaction, all or nothing'
  )
  const over = inv.setInvoiceLineRouting(
    sale.id,
    [
      {
        lineId,
        destination: 'RM',
        supplier: null,
        allocations: [
          { quantity: 8, destination: 'RM', sourcePoId: null },
          { quantity: 8, destination: 'Kestrel Cards', sourcePoId: null }
        ]
      }
    ],
    null
  )
  ok(!!over.error, 'AND SO IS SIXTEEN ON A LINE OF TEN', String(over.error))
  /**
   * A ZERO-UNIT SPLIT IS REFUSED even though the arithmetic works out.
   *
   * Ten and nothing sums to ten, so I1 alone would let it through — and it would
   * store a row that claims nothing, appears on the screen as a split somebody
   * has to look at, and means less than deleting it would. I5 says a split is at
   * least one unit.
   */
  const empty = inv.setInvoiceLineRouting(
    sale.id,
    [
      {
        lineId,
        destination: 'RM',
        supplier: null,
        allocations: [
          { quantity: 10, destination: 'RM', sourcePoId: null },
          { quantity: 0, destination: 'Kestrel Cards', sourcePoId: null }
        ]
      }
    ],
    null
  )
  ok(!!empty.error, 'A SPLIT OF NOTHING IS REFUSED, even though ten and nought is ten', String(empty.error))
  ok(/at least one unit/i.test(empty.error ?? ''), 'saying so plainly', String(empty.error))
  /**
   * AND ONE SPLIT OF THE WHOLE LINE IS NOT A SPLIT. Storing it would be a second
   * way to say what the line already says, and the two could then disagree — the
   * line's column pointing one way and its only allocation the other, with
   * nothing to arbitrate.
   */
  const solo = inv.setInvoiceLineRouting(
    sale.id,
    [
      {
        lineId,
        destination: 'RM',
        supplier: null,
        allocations: [{ quantity: 10, destination: 'RM', sourcePoId: null }]
      }
    ],
    null
  )
  ok(!!solo.error, 'ONE SPLIT COVERING THE WHOLE LINE IS REFUSED', String(solo.error))

  // --- a split with no destination of its own takes the LINE's -------------
  /**
   * ONE STEP OF INHERITANCE, and it is the LINE's destination, not the order's.
   *
   * A slice that says nothing is a slice going wherever the line goes, which on
   * a line routed to a supplier is that supplier — falling all the way through
   * to the order's shelf instead would put cases back on a shelf the operator
   * had just said they never touch.
   */
  const inherited = inv.setInvoiceLineRouting(
    sale.id,
    [
      {
        lineId,
        destination: 'Kestrel Cards',
        supplier: null,
        allocations: [
          { quantity: 4, destination: null, sourcePoId: null },
          { quantity: 6, destination: 'RM', sourcePoId: null }
        ]
      }
    ],
    null
  )
  ok(!inherited.error, 'a split can leave its destination blank', String(inherited.error))
  const inheritLine = inv.getInvoice(sale.id).lines[0]
  ok(
    inheritLine.allocations[0].destination === 'Kestrel Cards',
    'A BLANK SPLIT TAKES THE LINE’S DESTINATION, not the order’s shelf',
    String(inheritLine.allocations[0].destination)
  )
  ok(
    inv.getInvoice(sale.id).stockUnits === 6 && inv.getInvoice(sale.id).dropshipUnits === 4,
    'and the board counts six on the shelf and four shipping direct',
    `${inv.getInvoice(sale.id).stockUnits} / ${inv.getInvoice(sale.id).dropshipUnits}`
  )

  // --- "not split" is reachable again, and stores nothing -----------------
  const collapsed = inv.setInvoiceLineRouting(
    sale.id,
    [{ lineId, destination: 'RM', supplier: null, sourcePoId: null, allocations: [] }],
    null
  )
  ok(!collapsed.error, 'A SPLIT LINE CAN BE PUT BACK TOGETHER', String(collapsed.error))
  ok(
    inv.getInvoice(sale.id).lines[0].allocations.length === 0,
    'AND STORES ZERO ROWS GETTING THERE, not one covering the whole quantity — ' +
      'the two behave alike and only one leaves an ordinary sale stored as sales have always been',
    String(inv.getInvoice(sale.id).lines[0].allocations.length)
  )
  ok(
    db
      .prepare(`SELECT COUNT(*) AS n FROM invoice_line_allocations WHERE invoice_line_id = ?`)
      .get(lineId).n === 0,
    'and the table agrees'
  )
  ok(qtyAt('RM') === shelfBefore - 10, 'with the whole line back on ordinary stock', String(qtyAt('RM')))

  // --- absence still means LEAVE THE SPLITS ALONE ------------------------
  inv.setInvoiceLineRouting(
    sale.id,
    [
      {
        lineId,
        destination: 'RM',
        supplier: null,
        // The DROPSHIP slice deliberately first, because the line's own columns
        // describe the first slice and the assertion below is about them.
        allocations: [
          { quantity: 3, destination: 'Kestrel Cards', sourcePoId: null },
          { quantity: 7, destination: 'RM', sourcePoId: null }
        ]
      }
    ],
    null
  )
  const splitHead = inv.getInvoice(sale.id).lines[0]
  /**
   * A SPLIT LINE'S OWN COLUMNS DESCRIBE ITS FIRST SLICE.
   *
   * They govern nothing any more — the slices do — but they are what every
   * reader written before splits existed looks at, and left stale they would
   * have a line saying RM while three of its cases ship direct from a supplier.
   */
  ok(
    splitHead.destination === 'Kestrel Cards' && splitHead.dropship === true,
    'A SPLIT LINE’S OWN COLUMNS DESCRIBE ITS FIRST SLICE, so no reader sees a stale answer',
    `${splitHead.destination} / dropship=${splitHead.dropship}`
  )
  const keptIds = splitHead.allocations.map((a: any) => a.id).join()
  inv.setInvoiceLineRouting(sale.id, [{ lineId, destination: 'RM', supplier: null }], null)
  const stillThere = inv.getInvoice(sale.id).lines[0]
  ok(
    stillThere.allocations.map((a: any) => a.id).join() === keptIds,
    'A CHANGE THAT DOES NOT MENTION THE SPLITS LEAVES THEM EXACTLY WHERE THEY WERE — ' +
      'ids included, so nothing churns through sync for nothing',
    stillThere.allocations.length + ' rows'
  )
  ok(
    stillThere.destination === 'Kestrel Cards',
    'AND THE LINE GOES ON DESCRIBING THEM — a destination sent alongside splits it does not ' +
      'mention is not an answer to anything, and writing it would contradict the slices',
    String(stillThere.destination)
  )
  ok(qtyAt('RM') === shelfBefore - 7, 'and the shelf still stands at seven taken', String(qtyAt('RM')))

  // --- a dropship slice RECORDS one, and still spends nothing --------------
  /**
   * TWO QUESTIONS, TWO ANSWERS, off one column.
   *
   * A slice that goes supplier-to-buyer consumes no cost layers, so it cannot
   * say whose it consumed. That used to be enforced by blanking the column on
   * read — which also threw away the only place a dropship can say WHERE ITS
   * GOODS CAME FROM, and the owner's open tabs are almost all dropship.
   *
   * So the read returns the row as stored, and the blanking moved into
   * `effectiveSlices` — the COST view, which is what `stockDrawingLines`,
   * `claimsOf` and the purchase-order history all ask. Provenance survives;
   * nothing that spends money can see it. Both halves are pinned below, because
   * one without the other is either a lost record or a dropship quietly costed
   * against somebody's cases.
   */
  db.prepare(
    `UPDATE invoice_line_allocations SET source_po_id = ?
      WHERE invoice_line_id = ? AND destination = 'Kestrel Cards'`
  ).run(first.id, lineId)
  const dropSlice = inv.getInvoice(sale.id).lines[0].allocations[0]
  ok(
    dropSlice.sourcePoId === first.id,
    'A DROPSHIP SPLIT RECORDS WHERE ITS CASES CAME FROM — the read hands back what the row says',
    String(dropSlice.sourcePoId)
  )
  const allocRules = require('../src/shared/invoiceAllocations')
  const costView = allocRules.effectiveSlices(
    { quantity: 10, destination: 'RM', allocations: inv.getInvoice(sale.id).lines[0].allocations },
    'RM'
  )
  ok(
    costView[0].holdsStock === false && costView[0].sourcePoId === null,
    'AND THE COST VIEW BLANKS IT, so nothing that spends money can charge a dropship against that order’s layers',
    `${costView[0].holdsStock} / ${costView[0].sourcePoId}`
  )
  ok(
    qtyAt('RM') === shelfBefore - 7,
    'and the shelf is still exactly the seven the stock slice took',
    String(qtyAt('RM'))
  )

  // --- voiding hands back exactly what the splits took --------------------
  inv.setInvoiceStatus(sale.id, 'void', null)
  ok(
    qtyAt('RM') === shelfBefore,
    'VOIDING A SPLIT ORDER HANDS BACK THE SEVEN IT TOOK AND NOT THE TEN IT SOLD',
    `${qtyAt('RM')} vs ${shelfBefore}`
  )
}


console.log('\n=== SEVERAL PURCHASE ORDERS SUPPLYING ONE SALE ===')
// ---------------------------------------------------------------------------
/**
 * The owner's three asks, in his words: "allow for multiple POs to be added to
 * one sales order in terms of matching products"; "it should still be able to
 * handle not having an associated PO, where the order is being fulfilled
 * in-house"; and "a way to link POs to SOs that are in history or active, in
 * case of drop shipping."
 *
 * Then, on what actually matters: "what we have to make sure is just that
 * inventory is being updated as well — that is kind of the point."
 *
 * ## THE LOAD-BEARING ASSERTION IS THAT LINKING MOVES NO STOCK
 *
 * Three different questions, and they stay three different answers:
 *
 *   sale_purchase_links        WHICH PURCHASES supplied this sale. A claim a
 *                              person makes. Moves nothing.
 *   invoice_lines.source_po_id which purchase THIS LINE's units came out of, so
 *                              the cost is that order's layers. Moves stock.
 *   invoice_line_allocations   the same, per slice. Moves stock.
 *
 * Keeping them apart is what lets a sale be linked to a purchase whose stock it
 * never drew — the dropship case, which is the whole reason for the ask. If
 * linking ever moved a unit, a bookkeeping note would be silently re-costing
 * goods, so the shelf is measured across every link and unlink below.
 */
{
  const poRepo = require('../src/main/db/purchaseOrders')
  const links = require('../src/main/db/salePurchaseLinks')
  const extrasRepo = require('../src/main/db/orderExtras')
  const qtyAt = (loc: string): number => invStock.stockQty('p_d', loc)

  const mkPo = (supplier: string, qty: number): any => {
    const po = poRepo.createPurchaseOrder(
      {
        supplier,
        location: 'RM',
        lines: [{ productId: 'p_d', item: 'Dropship Hobby Box', quantity: qty, unitPrice: 400 }]
      },
      null
    )
    poRepo.setPurchaseOrderStatus(po.id, 'received', null)
    return po
  }
  const alpha = mkPo('Alpha Supply', 3)
  const bravo = mkPo('Bravo Supply', 3)
  const charlie = mkPo('Charlie Supply', 3)

  const shelfBefore = qtyAt('RM')
  const sale = inv.saveInvoice(
    {
      customerName: 'Three Source Buyer',
      invoiceNumber: 'SO-9300',
      invoiceDate: '2026-08-24',
      location: 'RM',
      lines: [{ item: 'Dropship Hobby Box', productId: 'p_d', quantity: 2, rate: 900 }]
    },
    null
  )
  db.prepare(`UPDATE invoices SET status = 'sent', qbo_id = 'qbo-9300' WHERE id = ?`).run(sale.id)
  const shelfAfterSale = qtyAt('RM')
  ok(shelfAfterSale === shelfBefore - 2, 'the sale drew its two cases off the shelf', String(shelfAfterSale))

  // --- 1. NO PURCHASE ORDER AT ALL is the ordinary case -------------------
  ok(
    inv.getInvoice(sale.id).sourcePos.length === 0,
    'A SALE STARTS LINKED TO NOTHING — an in-house sale off the shelf claims nothing about ' +
      'where its cases came from, and that is most sales'
  )
  ok(inv.getInvoice(sale.id).sourcePoId === null, 'and names no purchase order')

  // --- 2. SEVERAL PURCHASE ORDERS ON ONE SALE ------------------------------
  ok(inv.linkDropshipPair(alpha.id, sale.id, null).ok, 'the first purchase attaches')
  ok(
    inv.getInvoice(sale.id).sourcePoId === alpha.id,
    'ONE LINK, so the header column names it — every reader written before this goes on working',
    String(inv.getInvoice(sale.id).sourcePoId)
  )

  const second = inv.linkDropshipPair(bravo.id, sale.id, null)
  ok(
    second.ok,
    'A SECOND PURCHASE ATTACHES TOO — this is the refusal that used to say ' +
      '"that sales order already came from another purchase order"',
    String(second.error)
  )
  ok(inv.linkDropshipPair(charlie.id, sale.id, null).ok, 'and a third')
  const three = inv.getInvoice(sale.id)
  ok(three.sourcePos.length === 3, 'all three are on the sale', String(three.sourcePos.length))
  ok(
    three.sourcePos.map((p: any) => p.poNumber).join() ===
      [alpha, bravo, charlie].map((p: any) => p.poNumber).join(),
    'in the order they were attached',
    three.sourcePos.map((p: any) => p.poNumber).join()
  )
  /**
   * AND THE HEADER COLUMN GOES NULL RATHER THAN NAMING ONE OF THREE.
   *
   * A half-truth in a column that drives the dropship gate and the deal-ticket
   * fold is worse than an absence: the absence is visible and sends a reader to
   * the real list. Same rule `soleSourceOrder` applies to a sale's lines.
   */
  ok(
    three.sourcePoId === null,
    'THE SOLE-PURCHASE COLUMN GOES NULL WITH THREE ATTACHED, rather than naming one as if it ' +
      'were the only one',
    String(three.sourcePoId)
  )
  ok(three.sourcePoCount === 3, 'while the count says three, so a card can tell three from none', String(three.sourcePoCount))

  // --- 3. NONE OF THAT MOVED A SINGLE UNIT ---------------------------------
  ok(
    qtyAt('RM') === shelfAfterSale,
    'THREE PURCHASES ATTACHED AND THE SHELF HAS NOT MOVED — linking is a claim about which ' +
      'purchases supplied the sale, not about which layers its cost came from',
    `${shelfAfterSale} -> ${qtyAt('RM')}`
  )
  ok(
    inv.getInvoice(sale.id).lines[0].sourcePoId === null,
    'AND THE LINE STILL NAMES NO ORDER, so its cost still walks ordinary FIFO — the two ' +
      'questions stay two answers'
  )
  ok(
    inv.getInvoice(sale.id).total === sale.total,
    'with the total untouched, so nothing a buyer was billed has changed'
  )

  // --- 4. BOTH HISTORIES SAY SO -------------------------------------------
  const poDetail = (poId: string): string =>
    extrasRepo.listOrderEvents('po', poId).map((e: any) => e.detail ?? '').join(' | ')
  ok(
    /Sold on to|Supplies/i.test(poDetail(bravo.id)),
    'the second purchase’s own history records that it supplies this sale',
    poDetail(bravo.id)
  )

  // --- 5. DETACHING ONE, and it is possible at all -------------------------
  /**
   * With one column there was nothing to detach FROM — only a value to
   * overwrite — so the first mistaken attach was permanent.
   */
  ok(inv.getInvoice(sale.id).sourcePos.length === 3, 'three before detaching')
  ok(links.unlinkSaleFromPurchase(sale.id, bravo.id, null).ok, 'the middle one detaches')
  const two = inv.getInvoice(sale.id)
  ok(two.sourcePos.length === 2, 'two are left', String(two.sourcePos.length))
  ok(
    !two.sourcePos.some((p: any) => p.poId === bravo.id),
    'and it is the right one that went'
  )
  ok(two.sourcePoId === null, 'the column stays null at two')
  ok(
    /No longer supplies/i.test(poDetail(bravo.id)),
    'AND ITS HISTORY SAYS IT LOST THEM — a log that only ever gains claims is a wrong log',
    poDetail(bravo.id)
  )
  ok(links.unlinkSaleFromPurchase(sale.id, charlie.id, null).ok, 'another detaches')
  ok(
    inv.getInvoice(sale.id).sourcePoId === alpha.id,
    'AND BACK AT ONE THE COLUMN NAMES IT AGAIN — a state the single column could never reach',
    String(inv.getInvoice(sale.id).sourcePoId)
  )
  ok(
    qtyAt('RM') === shelfAfterSale,
    'AND DETACHING MOVED NO UNIT EITHER',
    `${shelfAfterSale} -> ${qtyAt('RM')}`
  )

  // --- 6. attaching twice is not an error ---------------------------------
  /**
   * Two people on two benches attaching the same purchase is a race, not a
   * mistake, and the second being told off for it would be the app inventing a
   * problem.
   */
  const before = extrasRepo.listOrderEvents('po', alpha.id).length
  ok(inv.linkDropshipPair(alpha.id, sale.id, null).ok, 'ATTACHING THE SAME PURCHASE AGAIN IS NOT AN ERROR')
  ok(
    inv.getInvoice(sale.id).sourcePos.length === 1,
    'and does not add a second row',
    String(inv.getInvoice(sale.id).sourcePos.length)
  )
  ok(
    extrasRepo.listOrderEvents('po', alpha.id).length === before,
    'nor a second history line — a log cannot gain an entry for a no-op'
  )

  // --- 7. HISTORY AND ACTIVE ALIKE ----------------------------------------
  /**
   * "A way to link POs to SOs that are in history or active." A received,
   * long-closed purchase is exactly what a dropship gets attached to after the
   * fact, so status is not a filter — only cancelled is refused, because nothing
   * on a cancelled order is being bought.
   */
  const offers = inv.linkablePurchaseOrders(sale.id, 200)
  ok(
    offers.some((o: any) => o.poId === charlie.id && o.status === 'received'),
    'A RECEIVED, CLOSED PURCHASE IS STILL OFFERED — history is linkable, which is the whole ' +
      'point of attaching a dropship after the fact'
  )
  const dead = mkPo('Cancelled Supply', 1)
  poRepo.setPurchaseOrderStatus(dead.id, 'cancelled', null)
  ok(
    !inv.linkablePurchaseOrders(sale.id, 200).some((o: any) => o.poId === dead.id),
    'but a CANCELLED one is not — nothing on it is being bought'
  )
  ok(
    !links.linkSaleToPurchase(sale.id, dead.id, null).ok,
    'and the write refuses it too, not just the picker'
  )

  // --- 8. MATCHING PRODUCTS is what makes the list a shortlist -------------
  ok(
    inv.linkablePurchaseOrders(sale.id, 200).find((o: any) => o.poId === alpha.id)
      .matchingProducts === 1,
    'A PURCHASE CARRYING THE PRODUCT BEING SOLD SAYS SO — "in terms of matching products"',
    String(inv.linkablePurchaseOrders(sale.id, 200).find((o: any) => o.poId === alpha.id)?.matchingProducts)
  )
  // A DIFFERENT PRODUCT, not a blank one: purchase_order_lines.product_id is NOT
  // NULL, so "shares nothing with the sale" has to be expressed as another real
  // catalog item rather than as an absent one.
  db.prepare(
    `INSERT INTO inventory_products (id, sku, name, category, unit_cost, created_at, updated_at)
     VALUES ('p_other', 'SKU-OTHER', 'Unrelated Supplies', 'Supplies', 2,
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run()
  const unrelated = poRepo.createPurchaseOrder(
    {
      supplier: 'Nothing In Common',
      location: 'RM',
      lines: [{ productId: 'p_other', item: 'Unrelated Supplies', quantity: 5, unitPrice: 2 }]
    },
    null
  )
  const un = inv.linkablePurchaseOrders(sale.id, 200).find((o: any) => o.poId === unrelated.id)
  ok(!!un && un.matchingProducts === 0, 'one sharing nothing says zero', String(un?.matchingProducts))
  ok(
    !!un,
    'AND IS STILL OFFERED — a dropship is exactly the case where the two documents share no ' +
      'catalog product at all, so a filter here would break the scenario this exists for'
  )

  // --- 9. deleting a purchase takes its links and re-derives the column ----
  /**
   * A PURCHASE THAT CAN ACTUALLY BE DELETED.
   *
   * `deletePurchaseOrder` refuses a received order holding stock, correctly —
   * there is a cost record to protect. So the one used here is raised and never
   * received, which is the shape somebody deletes: a purchase typed by mistake,
   * attached to the wrong sale, and taken back off.
   */
  const mistake = poRepo.createPurchaseOrder(
    {
      supplier: 'Typed By Mistake',
      location: 'RM',
      lines: [{ productId: 'p_d', item: 'Dropship Hobby Box', quantity: 1, unitPrice: 400 }]
    },
    null
  )
  ok(inv.linkDropshipPair(mistake.id, sale.id, null).ok, 'two attached again')
  ok(inv.getInvoice(sale.id).sourcePoId === null, 'so the column is null')
  const gone = poRepo.deletePurchaseOrder(mistake.id, null)
  ok(gone.ok, 'the mistaken purchase is deleted', String(gone.error))
  const afterDelete = inv.getInvoice(sale.id)
  ok(
    afterDelete.sourcePos.length === 1 && afterDelete.sourcePos[0].poId === alpha.id,
    'A DELETED PURCHASE TAKES ITS LINK AND LEAVES THE OTHERS',
    String(afterDelete.sourcePos.length)
  )
  ok(
    afterDelete.sourcePoId === alpha.id,
    'AND THE COLUMN IS RE-DERIVED — back to one, so it names it again rather than staying null',
    String(afterDelete.sourcePoId)
  )
  ok(qtyAt('RM') === shelfAfterSale, 'and the shelf is still untouched by any of it', String(qtyAt('RM')))
}

console.log('\n=== A ROADSHOW OPEN TAB: OURS, AT THE SHOP, SHIPPED STRAIGHT OUT ===')
// ---------------------------------------------------------------------------
/**
 * The owner's ask, in his words: "we need to know where products are coming from
 * and that is important, and those are open tabs — so if we attach the roadshow
 * open PO the correct products just have to be attached in the sales order."
 * And, earlier, on what actually matters: "what we have to make sure is just
 * that inventory is being updated as well, that is kind of the point."
 *
 * ## THIS SECTION USED TO SAY THE OPPOSITE, AND IT WAS WRONG
 *
 * It was written as "a dropship off a tab moves no unit" — the case bought in a
 * ballroom and shipped straight out, never in this building, no receipt, no lot,
 * nothing for inventory to know about. That was the best available reading while
 * a tab lived on MULTI_SHIPMENT, which holds no stock by design.
 *
 * The owner then said what a tab actually is: "roadshow is inventory that I
 * don't have but it is mine and I can pull from it ... when putting quantities
 * of things I need RM inventory + roadshow open tabs." Bought, therefore OWNED,
 * therefore stock — just stock standing in somebody else's shop. A tab's goods
 * now sit at a real location named for the shop (see tabLocation), they are
 * checked in there, and they carry real cost layers.
 *
 * So a sale off a tab is NOT a dropship in this app's accounting sense. A
 * dropship has no stock and no cost of goods; these have both. What is "direct"
 * about them is only the shipping.
 *
 * ## What is being pinned now
 *
 *   · a line off a tab draws the SHOP's stock, and RM is untouched
 *   · it carries real cost, which a dropship never would
 *   · the provenance still records which tab, which was the original point
 *   · the sale joins the tab's deal ticket, off the line alone
 *   · two lines naming two different tabs decline to fold, rather than picking
 *   · taking it off says so in the log
 */
{
  const poRepo = require('../src/main/db/purchaseOrders')
  const extrasRepo = require('../src/main/db/orderExtras')
  const qtyAt = (loc: string): number => invStock.stockQty('p_d', loc)
  const poEvents = (poId: string): string[] =>
    extrasRepo.listOrderEvents('po', poId).map((e: any) => e.detail ?? '')

  /**
   * AN OPEN TAB, CHECKED IN AT THE SHOP.
   *
   * The location is not given: opening a tab sends it to the shop's own place,
   * registered from the supplier — see the note on createPurchaseOrder. The
   * cases are then checked in there, line by line, the way a week of buying
   * actually goes. That is what makes them sellable, and it is the whole of the
   * change this section was rewritten for.
   */
  const SHOP = 'Roadshow Kansas City'
  const tab = poRepo.createPurchaseOrder(
    {
      supplier: SHOP,
      ongoing: true,
      lines: [{ productId: 'p_d', item: 'Dropship Hobby Box', quantity: 30, unitPrice: 400 }]
    },
    null
  )
  ok(
    poRepo.getPurchaseOrder(tab.id).location === SHOP,
    'the tab sits at the shop, not on a shelf here and not on Multi-shipment',
    String(poRepo.getPurchaseOrder(tab.id).location)
  )
  poRepo.receivePurchaseOrderLines(
    tab.id,
    [{ lineId: poRepo.getPurchaseOrder(tab.id).lines[0].id, quantity: 30 }],
    null
  )
  ok(qtyAt(SHOP) === 30, 'and its cases are checked in there', String(qtyAt(SHOP)))

  const shelfBefore = qtyAt('RM')
  const shopBefore = qtyAt(SHOP)
  const sale = inv.saveInvoice(
    {
      customerName: 'Ballroom Buyer',
      invoiceNumber: 'SO-9400',
      invoiceDate: '2026-08-26',
      location: 'RM',
      lines: [
        {
          item: 'Dropship Hobby Box',
          productId: 'p_d',
          quantity: 2,
          rate: 900,
          destination: 'Roadshow Kansas City'
        }
      ]
    },
    null
  )
  db.prepare(`UPDATE invoices SET status = 'sent', qbo_id = 'qbo-9400' WHERE id = ?`).run(sale.id)
  /**
   * THE SALE DREW THE SHOP'S CASES, not ours.
   *
   * The line's destination IS the shop, and the shop is a place that holds
   * stock — so this is an ordinary stock sale that happens to be picked three
   * states away. Under the old model it drew nothing at all, which is what made
   * a week of roadshow buying invisible to inventory.
   */
  ok(
    qtyAt('RM') === shelfBefore,
    'OUR OWN SHELF IS UNTOUCHED — the cases came from the shop, not from here',
    `${shelfBefore} -> ${qtyAt('RM')}`
  )
  ok(
    qtyAt(SHOP) === shopBefore - 2,
    'AND THE SHOP GAVE UP TWO — bought, owned, and now sold',
    `${shopBefore} -> ${qtyAt(SHOP)}`
  )
  const line = inv.getInvoice(sale.id).lines[0]
  ok(
    line.dropship === false,
    'THE LINE IS NOT A DROPSHIP — a dropship has no stock and no cost of goods, and these have both. Only the SHIPPING is direct.',
    String(line.dropship)
  )
  ok(line.sourcePoId === null, 'and it names no purchase order yet')

  // --- attach the tab, then say which line came off it --------------------
  ok(inv.linkDropshipPair(tab.id, sale.id, null).ok, 'the open tab attaches to the sale')
  ok(
    inv.getInvoice(sale.id).sourcePos.some((p: any) => p.poId === tab.id),
    'so the routing screen has something to offer — SuppliedByPicker reads exactly this list'
  )

  const routed = inv.setInvoiceLineRouting(
    sale.id,
    [{ lineId: line.id, destination: 'Roadshow Kansas City', supplier: null, sourcePoId: tab.id }],
    null
  )
  ok(!routed.error, 'A DROPSHIP LINE MAY NAME THE TAB ITS CASES CAME OFF', String(routed.error))
  ok(
    inv.getInvoice(sale.id).lines[0].sourcePoId === tab.id,
    'and it is stored — the one place this fact can live',
    String(inv.getInvoice(sale.id).lines[0].sourcePoId)
  )
  /**
   * THE LOAD-BEARING ONE, AND IT NOW POINTS THE OTHER WAY.
   *
   * Naming the tab must cost the tab's cases at the tab's price — that is the
   * whole reason a roadshow week is modelled as stock rather than as a dropship.
   * A dropship would have contributed no cost of goods at all, which is exactly
   * the wrong answer for something that was bought.
   */
  ok(
    qtyAt('RM') === shelfBefore,
    'OUR SHELF IS STILL UNTOUCHED after naming the tab',
    `${shelfBefore} -> ${qtyAt('RM')}`
  )
  const moves = db
    .prepare(
      `SELECT COALESCE(SUM(quantity), 0) AS q, COALESCE(SUM(cost_total), 0) AS c
         FROM invoice_stock_moves WHERE invoice_id = ?`
    )
    .get(sale.id) as { q: number; c: number }
  ok(
    moves.q === 2 && Math.round(moves.c) === 800,
    'AND THE TWO CASES COST WHAT THE SHOP CHARGED — 2 × $400, which a dropship would have reported as nothing',
    `${moves.q} units, ${moves.c}`
  )

  ok(
    poEvents(tab.id).some((d: string) => /come out of this order.s stock/i.test(d)),
    'THE TAB’S OWN LOG SAYS ITS STOCK WAS DRAWN — which is now the true sentence, because it had stock to draw',
    poEvents(tab.id).join(' | ')
  )

  /**
   * AND THE SALE JOINS THE TAB'S DEAL TICKET — OFF THE LINE, with nothing
   * attached at the document level.
   *
   * "The deal ticket is just linked to the ongoing PO until the PO is paid out."
   * A case bought on the tab and shipped straight to the buyer IS sold out of
   * that tab — it just never touched a shelf on the way — and a deal ticket
   * groups DOCUMENTS rather than spending anything, so `foldRoadshowTicket` gets
   * the raw provenance and not the cost view. `saveInvoice` has always folded off
   * the raw line, so reading the cost view here would put a draft and the
   * identical posted order on two different tickets.
   *
   * ON ITS OWN SALE, and that is the whole point of the extra fixture:
   * `linkDropshipPair` folds the ticket ITSELF when a purchase is attached, so
   * asserting this on the sale above would have proved the attach screen works
   * and said nothing whatever about the routing. This one is attached to nothing
   * and stays attached to nothing, so the line naming the tab is the only thing
   * that can have folded it.
   */
  const unattached = inv.saveInvoice(
    {
      customerName: 'Ticket Fold Buyer',
      invoiceNumber: 'SO-9403',
      invoiceDate: '2026-08-26',
      location: 'RM',
      lines: [
        {
          item: 'Dropship Hobby Box',
          productId: 'p_d',
          quantity: 1,
          rate: 900,
          destination: 'Roadshow Kansas City'
        }
      ]
    },
    null
  )
  db.prepare(`UPDATE invoices SET status = 'sent', qbo_id = 'qbo-9403' WHERE id = ?`).run(unattached.id)
  const ticketOf = (invoiceId: string): string | null => {
    const row = db
      .prepare(`SELECT merged_into FROM deal_tickets WHERE document_kind = 'so' AND document_id = ?`)
      .get(invoiceId) as any
    return row?.merged_into ?? null
  }
  ok(ticketOf(unattached.id) === null, 'it starts on its own ticket, folded into nothing')
  ok(
    !inv.setInvoiceLineRouting(
      unattached.id,
      [
        {
          lineId: inv.getInvoice(unattached.id).lines[0].id,
          destination: 'Roadshow Kansas City',
          supplier: null,
          sourcePoId: tab.id
        }
      ],
      null
    ).error,
    'the line names the running tab'
  )
  ok(
    inv.getInvoice(unattached.id).sourcePos.length === 0,
    'and nothing was attached at the document level — this is the LINE talking'
  )
  ok(
    !!ticketOf(unattached.id),
    'A DROPSHIP OFF A RUNNING TAB JOINS THAT TAB’S DEAL TICKET, the same as a sale off its shelf',
    String(ticketOf(unattached.id))
  )
  ok(qtyAt('RM') === shelfBefore, 'and folding a ticket moved no unit either', String(qtyAt('RM')))

  // --- two tabs on one sale decline to fold -------------------------------
  /**
   * `soleSourceOrder` yields null when two lines name two orders, and that rule
   * had to survive the switch to raw provenance: a deal ticket is a claim about
   * ONE deal, and folding a sale into one of the two shops that supplied it puts
   * a week's figure on the wrong one.
   */
  const OTHER = 'Roadshow Tulsa'
  const otherTab = poRepo.createPurchaseOrder(
    {
      supplier: OTHER,
      ongoing: true,
      lines: [{ productId: 'p_d', item: 'Dropship Hobby Box', quantity: 20, unitPrice: 400 }]
    },
    null
  )
  // Checked in at ITS shop, so the two tabs are two separate shelves and a sale
  // naming both really does draw from two different places.
  poRepo.receivePurchaseOrderLines(
    otherTab.id,
    [{ lineId: poRepo.getPurchaseOrder(otherTab.id).lines[0].id, quantity: 20 }],
    null
  )
  ok(qtyAt(OTHER) === 20, 'the second shop has its own', String(qtyAt(OTHER)))
  const twoTabs = inv.saveInvoice(
    {
      customerName: 'Two Ballrooms Buyer',
      invoiceNumber: 'SO-9401',
      invoiceDate: '2026-08-26',
      location: 'RM',
      lines: [
        {
          item: 'Dropship Hobby Box',
          productId: 'p_d',
          quantity: 1,
          rate: 900,
          destination: 'Roadshow Kansas City'
        },
        {
          item: 'Dropship Hobby Box',
          productId: 'p_d',
          quantity: 1,
          rate: 900,
          destination: 'Roadshow Tulsa'
        }
      ]
    },
    null
  )
  db.prepare(`UPDATE invoices SET status = 'sent', qbo_id = 'qbo-9401' WHERE id = ?`).run(twoTabs.id)
  const both = inv.getInvoice(twoTabs.id).lines
  ok(
    !inv.setInvoiceLineRouting(
      twoTabs.id,
      [
        {
          lineId: both[0].id,
          destination: 'Roadshow Kansas City',
          supplier: null,
          sourcePoId: tab.id
        },
        { lineId: both[1].id, destination: 'Roadshow Tulsa', supplier: null, sourcePoId: otherTab.id }
      ],
      null
    ).error,
    'two lines may name two different tabs'
  )
  const twoLines = inv.getInvoice(twoTabs.id).lines
  ok(
    twoLines[0].sourcePoId === tab.id && twoLines[1].sourcePoId === otherTab.id,
    'AND EACH KEEPS ITS OWN ANSWER — "the correct products just have to be attached"',
    `${twoLines[0].sourcePoId} / ${twoLines[1].sourcePoId}`
  )
  const notFolded = db
    .prepare(`SELECT merged_into FROM deal_tickets WHERE document_kind = 'so' AND document_id = ?`)
    .get(twoTabs.id) as any
  ok(
    !notFolded?.merged_into,
    'AND THE SALE FOLDS INTO NEITHER TICKET, rather than picking one of the two shops',
    String(notFolded?.merged_into)
  )
  ok(qtyAt('RM') === shelfBefore, 'the shelf has still not moved for any of it', String(qtyAt('RM')))

  // --- one line, five cases, two ballrooms --------------------------------
  /**
   * SPLIT BY CASE AND EVERY SLICE A DROPSHIP. Five cases on one line at one
   * price, three off the Kansas City tab and two off Tulsa, none of them ever
   * here. The slice is where "the correct products just have to be attached"
   * becomes exact: the answer is per case, not per document.
   */
  const splitSale = inv.saveInvoice(
    {
      customerName: 'Five Case Buyer',
      invoiceNumber: 'SO-9402',
      invoiceDate: '2026-08-26',
      location: 'RM',
      lines: [
        {
          item: 'Dropship Hobby Box',
          productId: 'p_d',
          quantity: 5,
          rate: 900,
          destination: 'Roadshow Kansas City'
        }
      ]
    },
    null
  )
  db.prepare(`UPDATE invoices SET status = 'sent', qbo_id = 'qbo-9402' WHERE id = ?`).run(splitSale.id)
  const splitLineId = inv.getInvoice(splitSale.id).lines[0].id
  const splitRes = inv.setInvoiceLineRouting(
    splitSale.id,
    [
      {
        lineId: splitLineId,
        destination: 'Roadshow Kansas City',
        supplier: null,
        allocations: [
          { quantity: 3, destination: 'Roadshow Kansas City', sourcePoId: tab.id },
          { quantity: 2, destination: 'Roadshow Tulsa', sourcePoId: otherTab.id }
        ]
      }
    ],
    null
  )
  ok(!splitRes.error, 'A SPLIT OF DROPSHIP SLICES IS ACCEPTED', String(splitRes.error))
  const sliced = inv.getInvoice(splitSale.id).lines[0].allocations
  ok(
    sliced.length === 2 &&
      sliced[0].sourcePoId === tab.id &&
      sliced[1].sourcePoId === otherTab.id,
    'AND EACH SLICE REMEMBERS ITS OWN BALLROOM — written through the ordinary write path, not ' +
      'poked into the column',
    sliced.map((a: any) => `${a.quantity}:${a.sourcePoId}`).join(' ')
  )
  /**
   * BOTH SLICES HOLD STOCK, and that is the corrected claim.
   *
   * This asserted the opposite while a roadshow shop was a dropship
   * destination. The shops are shelves now, so a slice pointed at one draws
   * real cases at a real cost — which is the whole reason a week's buying is
   * worth recording. Only the SHIPPING is direct, and that is a fact about
   * logistics rather than about the ledger.
   */
  ok(
    sliced.every((a: any) => a.holdsStock === true),
    'BOTH SLICES DRAW REAL STOCK — one shop each, and each at its own cost',
    sliced.map((a: any) => `${a.destination}:${a.holdsStock}`).join(' ')
  )
  ok(qtyAt('RM') === shelfBefore, 'and five cases moved no shelf', String(qtyAt('RM')))
  ok(
    inv.getInvoice(splitSale.id).lines[0].sourcePoId === tab.id,
    'THE LINE’S OWN COLUMN DESCRIBES ITS FIRST SLICE, so a reader written before splits existed ' +
      'still sees a true answer rather than a blank',
    String(inv.getInvoice(splitSale.id).lines[0].sourcePoId)
  )
  /**
   * AND A CHANGE THAT DOES NOT MENTION THE SPLITS LEAVES THAT COLUMN ALONE.
   *
   * The head columns are copied off the first slice, and the slices are read
   * back through `effectiveSlices` — the COST view, which blanks the purchase
   * order on anything that draws no shelf. Copying that blank into the line
   * would erase the record while the allocation row it is supposed to describe
   * still holds it, so the raw row is what the column takes.
   */
  ok(
    !inv.setInvoiceLineRouting(
      splitSale.id,
      [{ lineId: splitLineId, destination: 'Roadshow Kansas City', supplier: null }],
      null
    ).error,
    'a route-only change on a split line is accepted'
  )
  ok(
    inv.getInvoice(splitSale.id).lines[0].sourcePoId === tab.id,
    'AND THE COLUMN STILL NAMES THE FIRST SLICE’S TAB — not blanked by the cost view on the way ' +
      'through',
    String(inv.getInvoice(splitSale.id).lines[0].sourcePoId)
  )
  ok(
    inv.getInvoice(splitSale.id).lines[0].allocations.length === 2,
    'and the slices are all still there'
  )

  // --- and taking it back off says so -------------------------------------
  ok(
    !inv.setInvoiceLineRouting(
      sale.id,
      [{ lineId: line.id, destination: 'Roadshow Kansas City', supplier: null, sourcePoId: null }],
      null
    ).error,
    'the record can be taken back off'
  )
  ok(inv.getInvoice(sale.id).lines[0].sourcePoId === null, 'and the line names nobody again')
  ok(
    poEvents(tab.id).some((d: string) => /no longer come out of this order.s stock/i.test(d)),
    'AND THE TAB IS TOLD IT LOST THEM — a log that only ever gains claims is a wrong log, and the sentence is the STOCK one now that its cases really are stock',
    poEvents(tab.id).join(' | ')
  )
  /**
   * THE DOCUMENT-LEVEL LINK IS UNTOUCHED BY ANY OF IT. Two different claims:
   * which purchases supplied this sale (`sale_purchase_links`, made by a person
   * on the attach screen) and which one THIS LINE's goods came off. Clearing the
   * second must not quietly retract the first.
   */
  ok(
    inv.getInvoice(sale.id).sourcePos.some((p: any) => p.poId === tab.id),
    'AND THE TAB IS STILL ATTACHED TO THE SALE — clearing a line’s provenance is not detaching ' +
      'the purchase order'
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
