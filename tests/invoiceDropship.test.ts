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

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
