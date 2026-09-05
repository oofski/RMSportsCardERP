/**
 * The stock audit: does it find what came untied, and does it stay QUIET
 * otherwise.
 *
 * The owner's words: "just want to make sure that inventory is being properly
 * managed ... it just is a big question of everything needing to be allocated
 * and just making sure things are being tied correctly".
 *
 * The fault this exists for is real and already happened. Orders 2366 and 2367
 * were marked sold before their goods landed; `applyInvoiceStock` clamps a line
 * to what the shelf can give and skips it at zero, so they wrote no stock move
 * at all — and inventory, the wholesale history and the P&L all read from
 * `invoice_stock_moves`. They were absent from three screens at once and nothing
 * said so. Section 1 reproduces exactly that and asserts the audit names it.
 *
 * ## THE HALF THAT MATTERS MORE
 *
 * Section 2. A dropship legitimately books no stock, and an audit that reported
 * every dropship would be switched off inside a day — and then the one time it
 * was right about a real 2366 it would be ignored too. A checker nobody trusts
 * is worse than no checker, so silence on the normal case is tested as hard as
 * the finding is.
 *
 * Every name here is invented.
 *
 * Run: npm run test:stock-audit
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/stockaudit-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const { getDb } = require('../src/main/db/database')
const inv = require('../src/main/db/invoices')
const invStock = require('../src/main/db/inventory')
const { auditStock } = require('../src/main/db/stockAudit')
const { summariseStockAudit, rankFindings } = require('../src/shared/stockAudit')
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

const mkProduct = (id: string, name: string): void => {
  db.prepare(
    `INSERT INTO inventory_products (id, sku, name, category, unit_cost, created_at, updated_at)
     VALUES (?, ?, ?, 'Basketball', 100, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run(id, `SKU-${id}`, name)
}
mkProduct('p_a', 'Invented Prizm Hobby Box')
mkProduct('p_b', 'Invented Optic Hobby Box')

const sell = (opts: {
  qty: number
  productId?: string
  destination?: string | null
  supplier?: string | null
}): any =>
  inv.saveInvoice(
    {
      customerName: 'Invented Wholesale Co',
      invoiceDate: '2026-05-01',
      location: 'RM',
      lines: [
        {
          item: 'Invented Prizm Hobby Box',
          productId: opts.productId ?? 'p_a',
          quantity: opts.qty,
          rate: 200,
          destination: opts.destination ?? null,
          supplier: opts.supplier ?? null
        }
      ]
    },
    null
  )

const findingFor = (invoiceId: string): any =>
  auditStock().findings.find((f: any) => f.invoiceId === invoiceId)

// ---------------------------------------------------------------------------
console.log('=== 1. AN ORDER SOLD BEFORE ITS STOCK ARRIVED — the 2366 case ===')
// ---------------------------------------------------------------------------
// Nothing on the shelf. The sale saves anyway — that leniency is deliberate and
// is not what is being fixed — and writes no stock move.
const early = sell({ qty: 6 })
const moves = (id: string): number =>
  (db
    .prepare(`SELECT COALESCE(SUM(quantity),0) AS n FROM invoice_stock_moves WHERE invoice_id = ?`)
    .get(id) as { n: number }).n

ok(moves(early.id) === 0, 'the order booked nothing, because the shelf was empty', String(moves(early.id)))

const found = findingFor(early.id)
ok(!!found, 'THE AUDIT FINDS IT — which is the whole point; nothing else ever said so')
ok(found?.kind === 'sold-not-booked', 'and names it as sold with nothing booked', String(found?.kind))
ok(found?.units === 6, 'counting all six units as at stake', String(found?.units))
ok(
  /missing from inventory/i.test(found?.sentence ?? ''),
  'and says out loud that it is missing from inventory, history and the P&L',
  found?.sentence
)
ok((found?.remedy ?? '').length > 0, 'with something a person can actually press', found?.remedy)

// AND IT GOES QUIET ONCE REPAIRED. An audit that keeps reporting a thing you
// fixed is one you stop reading.
invStock.addStock('p_a', 'RM', 10, 100, null)
const rebooked = inv.rebookInvoiceStock(early.id, null)
ok(!rebooked.error, 'the existing repair books it against the shelf', String(rebooked.error))
ok(moves(early.id) === 6, 'all six now come off the shelf', String(moves(early.id)))
ok(!findingFor(early.id), 'AND THE AUDIT FALLS SILENT ON IT')

// ---------------------------------------------------------------------------
console.log('\n=== 2. THE NORMAL CASE STAYS SILENT — no crying wolf ===')
// ---------------------------------------------------------------------------
// A dropship books no stock and is CORRECT. Reporting it would be reporting the
// app working, and a report full of those is a report nobody opens.
const drop = sell({ qty: 4, destination: 'Fenwick Distribution', supplier: 'Invented Supply Co' })
ok(moves(drop.id) === 0, 'a dropship books no stock, as it should', String(moves(drop.id)))
ok(!findingFor(drop.id), 'AND THE AUDIT SAYS NOTHING ABOUT IT')

// An ordinary sale off a stocked shelf.
const ordinary = sell({ qty: 2 })
ok(moves(ordinary.id) === 2, 'an ordinary sale takes its units', String(moves(ordinary.id)))
ok(!findingFor(ordinary.id), 'and is not reported either')

// A VOID HANDED ITS STOCK BACK ON PURPOSE, so having no moves is it working.
// Drafts are deliberately NOT skipped: this app books stock on a draft save, so
// a draft sold before its goods landed is untied exactly like 2366 was. An
// earlier cut of the audit skipped them and would have hidden the whole fault.
const voided = sell({ qty: 5, productId: 'p_a' })
inv.setInvoiceStatus(voided.id, 'void', null)
ok(!findingFor(voided.id), 'a voided order is not reported — it gave its stock back')

// ---------------------------------------------------------------------------
console.log('\n=== 3. A PART DELIVERY — the same fault, halfway ===')
// ---------------------------------------------------------------------------
// Four on the shelf against a sale of ten: six were never taken. Worse than
// none in one way — it looks present on every screen and is simply short.
db.prepare(`DELETE FROM inventory_stock WHERE product_id = 'p_b'`).run()
invStock.addStock('p_b', 'RM', 4, 100, null)
const partial = inv.saveInvoice(
  {
    customerName: 'Invented Wholesale Co',
    invoiceDate: '2026-05-03',
    location: 'RM',
    lines: [{ item: 'Invented Optic Hobby Box', productId: 'p_b', quantity: 10, rate: 200 }]
  },
  null
)
ok(moves(partial.id) === 4, 'only the four on the shelf were taken', String(moves(partial.id)))
const half = findingFor(partial.id)
ok(half?.kind === 'sold-part-booked', 'the audit names it as part booked', String(half?.kind))
ok(half?.units === 6, 'and counts the six that were never taken', String(half?.units))

// ---------------------------------------------------------------------------
console.log('\n=== 4. the shelf and its cost layers must describe the same stock ===')
// ---------------------------------------------------------------------------
// Forced apart directly, because there is no supported way to do it — which is
// exactly why it needs finding if it ever happens.
db.prepare(`UPDATE inventory_stock SET quantity = quantity + 5 WHERE product_id='p_b' AND location='RM'`).run()
const drift = auditStock().findings.find((f: any) => f.kind === 'shelf-vs-layers')
ok(!!drift, 'A SHELF THAT DISAGREES WITH ITS OWN COST LAYERS IS FOUND')
ok(drift?.units === 5, 'by exactly how far apart they are', String(drift?.units))
ok(
  /margin/i.test(drift?.sentence ?? ''),
  'and says why it matters — the margin on this shelf is wrong',
  drift?.sentence
)

// Negative stock is never a fact about a building.
db.prepare(`UPDATE inventory_stock SET quantity = -3 WHERE product_id='p_b' AND location='RM'`).run()
const neg = auditStock().findings.find((f: any) => f.kind === 'negative-shelf')
ok(!!neg, 'a shelf below zero is found')

// ---------------------------------------------------------------------------
console.log('\n=== 5. the ordering, and the sentence at the top ===')
// ---------------------------------------------------------------------------
// BIGGEST FIRST, NOT GROUPED BY TYPE. A hundred units missing from the P&L
// matters more than a rounding drift, and grouping would bury it under whichever
// category happened to sort first.
const ranked = rankFindings([
  { kind: 'shelf-vs-layers', subject: 'b', units: 1, sentence: '', remedy: '', invoiceId: null, productId: null, location: null },
  { kind: 'sold-not-booked', subject: 'a', units: 99, sentence: '', remedy: '', invoiceId: null, productId: null, location: null }
])
ok(ranked[0].units === 99, 'the biggest problem is first', String(ranked[0].units))

// AN ALL-CLEAR NOBODY EARNED. Run on a company with no orders yet this said
// "Everything ties out. 0 orders and 36 shelf lines checked" — claiming the
// orders were verified when there were none. Found by running the real app.
const noOrders = summariseStockAudit({ findings: [], ordersChecked: 0, shelvesChecked: 36, checkedAt: '' })
ok(!/0 orders/.test(noOrders), 'NEVER CLAIMS TO HAVE CHECKED ORDERS THAT DO NOT EXIST', noOrders)
ok(/36 shelf lines/.test(noOrders), 'but still says what it did check', noOrders)
const nothing = summariseStockAudit({ findings: [], ordersChecked: 0, shelvesChecked: 0, checkedAt: '' })
ok(/nothing to check yet/i.test(nothing), 'and an empty company is told there is nothing to check', nothing)

const clean = summariseStockAudit({ findings: [], ordersChecked: 12, shelvesChecked: 30, checkedAt: '' })
ok(/ties out/i.test(clean), 'a clean result says everything ties out', clean)
ok(/12 orders/.test(clean), 'and how much was checked, so it is believable', clean)
// "0 problems" reads as a thing that failed to load. See summariseStockAudit.
ok(!/\b0\b/.test(clean), 'AND NEVER PRINTS A ZERO NEXT TO A WORD LIKE ERRORS', clean)

const dirty = summariseStockAudit({
  findings: [{ kind: 'sold-not-booked', subject: 'x', units: 6, sentence: '', remedy: '', invoiceId: 'i', productId: null, location: null }],
  ordersChecked: 12,
  shelvesChecked: 30,
  checkedAt: ''
})
ok(/P&L/.test(dirty), 'and a dirty one leads with the money', dirty)

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
