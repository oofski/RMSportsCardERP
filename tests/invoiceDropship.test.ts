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
   * THE ROADSHOW POINTER GOES WITH THE SHELF. `source_po_id` on a line says which
   * purchase order's cost layers to consume, which is meaningless on a line that
   * consumes none — and the chooser itself hides on a dropship line.
   */
  const eight = inv.getInvoice(posted.id).lines.find((l: any) => l.quantity === 8)
  db.prepare(`UPDATE invoice_lines SET source_po_id = 'po-roadshow' WHERE id = ?`).run(eight.id)
  inv.setInvoiceLineRouting(posted.id, [{ lineId: eight.id, destination: 'Kestrel Cards', supplier: null }], null)
  const cleared = db
    .prepare(`SELECT source_po_id FROM invoice_lines WHERE id = ?`)
    .get(eight.id) as { source_po_id: string | null }
  ok(
    cleared.source_po_id === null,
    'A LINE FLIPPED TO DROPSHIP DROPS ITS SOURCE PURCHASE ORDER — it consumes no layers',
    String(cleared.source_po_id)
  )
  // And put it back, so the assertions below start from a shelf again.
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

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
