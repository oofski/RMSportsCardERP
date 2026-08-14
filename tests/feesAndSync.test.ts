/**
 * Two things that decide numbers nobody can check by eye.
 *
 * PART A — the fee model, at the CONTRACT's edge: the constants, the shape of a
 * `FeeBreakdown`, and the fact that the statement still adds up once fees stop
 * being a subtraction from the ledger's own figure. The arithmetic itself, the
 * rate periods and the real ledger are `npm run test:fees`; what is here is what
 * the rest of the app imports.
 *
 * These assertions used to encode the OPPOSITE model — that the ledger's amount
 * was gross, that 8.9% came off it, and that there was no per-transaction
 * charge. Every one of those was wrong: the ledger pays net, so the old code
 * charged a fee that had already been taken and understated a ten-day export's
 * revenue by about $35,000.
 *
 * PART B — supplies on-hand across a sync. A count must never be arbitrated by
 * whoever wrote the row last. These cases are the ones a previous attempt at
 * this got wrong, so they are pinned here rather than trusted.
 *
 * Run: npm run test:fees-sync
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/fees-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const supplies = require('../src/main/db/supplies')
const sync = require('../src/main/db/sync')
const {
  computeFees,
  deriveSaleFee,
  DEFAULT_COMMISSION_RATE,
  DEFAULT_FEE_RATES,
  DEFAULT_PROCESSING_FLAT_CENTS,
  DEFAULT_PROCESSING_RATE,
  DEFAULT_TAX_RATE,
  buildPnl,
  pnlChecksum
} = require('../src/shared/financeStreaming')
getDb()

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
const near = (a: number, b: number, t = 0.005): boolean => Math.abs(a - b) < t

// ---------------------------------------------------------------------------
console.log('=== A1. the four terms, and the fact that all four are configurable ===')
// ---------------------------------------------------------------------------
ok(DEFAULT_COMMISSION_RATE === 0.08, 'Whatnot commission defaults to 8%', String(DEFAULT_COMMISSION_RATE))
ok(DEFAULT_TAX_RATE === 0.0518, 'sales tax defaults to 5.18%', String(DEFAULT_TAX_RATE))
ok(DEFAULT_PROCESSING_RATE === 0.029, 'card processing defaults to 2.9%', String(DEFAULT_PROCESSING_RATE))
ok(DEFAULT_PROCESSING_FLAT_CENTS === 30, 'plus a flat 30c per order', String(DEFAULT_PROCESSING_FLAT_CENTS))
ok(DEFAULT_FEE_RATES.shippingCents === 0, 'and no shipping inside a sale row')
// Three generations of wrong constants, and their absence is asserted because
// anything still importing one would be computing an old, wrong answer:
// TOTAL_FEE_RATE and WHATNOT_COMMISSION_RATE said the take was a fixed 8.9% of a
// gross the ledger never contained; STRIPE_PERCENT_RATE and STRIPE_FLAT_CENTS
// said the card terms were a published rate nobody could configure, which is
// exactly what the owner asked to be able to change.
const contract = require('../src/shared/financeStreaming') as Record<string, unknown>
ok(contract.TOTAL_FEE_RATE === undefined, 'the blended 8.9% constant is gone')
ok(contract.WHATNOT_COMMISSION_RATE === undefined, 'and the fixed 6% constant with it')
ok(contract.STRIPE_PERCENT_RATE === undefined, 'and the un-configurable card percentage')
ok(contract.STRIPE_FLAT_CENTS === undefined, 'and the un-configurable flat charge')

// ---------------------------------------------------------------------------
console.log('\n=== A2. the transaction count now DOES change the fee ===')
// ---------------------------------------------------------------------------
// The exact assertion this file used to make in reverse, and the reversal is the
// point. The flat 30c is real; what was wrong before was charging it ON TOP of a
// net figure rather than reverse-engineering it OUT of one. $10,000 of payout
// arriving as 2,000 spots means 2,000 slots were bought, so the buyers paid
// $600 more than if it had arrived as one order — and the net is $10,000 either
// way, which is why nothing here invents money.
const row = (netCents: number): Record<string, unknown> => ({
  netCents,
  rates: DEFAULT_FEE_RATES
})
const one = computeFees([row(1000000)])
const many = computeFees(Array.from({ length: 2000 }, () => row(500)))
ok(near(one.netSales, 10000), 'one order, $10,000 net', String(one.netSales))
ok(near(many.netSales, 10000), '2,000 spots, the same $10,000 net', String(many.netSales))
ok(
  Math.abs(many.totalFees) > Math.abs(one.totalFees),
  '2,000 slots cost more to process than one',
  `${many.totalFees} vs ${one.totalFees}`
)
// And the difference is 1,999 extra flat charges — but NOT 1,999 × 30c. The 30c
// is recovered out of a net figure, so each one is itself grossed up: the buyer
// bid 30c / (1 − 0.08 − 0.029 × 1.0518) = 33.7c higher to leave Whatnot 30c
// short. Tolerance is half a cent per row across 2,000 rows, which is the most
// the per-row rounding can ever be.
const flatEach =
  DEFAULT_PROCESSING_FLAT_CENTS /
  100 /
  (1 - DEFAULT_COMMISSION_RATE - DEFAULT_PROCESSING_RATE * (1 + DEFAULT_TAX_RATE))
const extra = Math.abs(many.totalFees) - Math.abs(one.totalFees)
ok(
  near(extra, 1999 * flatEach, 2000 * 0.005 + 0.01),
  'and the difference is 1,999 more 30c charges, grossed up',
  `${extra} vs ${(1999 * flatEach).toFixed(2)}`
)
ok(many.saleCount === 2000 && many.chargedCount === 2000, 'both counts are reported')

// ---------------------------------------------------------------------------
console.log('\n=== A3. gross is DERIVED, and it falls back to the net exactly ===')
// ---------------------------------------------------------------------------
for (const f of [one, many]) {
  ok(
    near(f.grossSales + f.totalFees, f.netSales, 0.0001),
    `gross ${f.grossSales} less fees lands on the net ${f.netSales}`,
    String(f.grossSales + f.totalFees)
  )
  ok(f.grossSales > f.netSales, 'and the gross is the LARGER number')
}
ok(computeFees([]).totalFees === 0, 'no sales, no fee')
ok(computeFees([row(100)]).totalFees < 0, 'a fee is negative')

// A refund and a $0.00 row are not purchases: face value, no fee, no 30c.
const refunded = computeFees([row(-5000), row(0)])
ok(refunded.totalFees === 0, 'a refund and a zero row are charged nothing')
ok(near(refunded.grossSales, -50), 'and pass through at face value', String(refunded.grossSales))
ok(refunded.chargedCount === 0, 'neither counts as a charged transaction')

// ---------------------------------------------------------------------------
console.log('\n=== A4. the statement still adds up ===')
// ---------------------------------------------------------------------------
const f = computeFees(Array.from({ length: 1029 }, () => row(1248)))
const day: Record<string, unknown> = {
  streamDate: '2026-08-01',
  sessionCount: 1,
  sessionTitles: ['Night'],
  minutes: 200,
  netSales: f.netSales,
  grossSales: f.grossSales,
  saleCount: 1029,
  feeSaleCount: f.chargedCount,
  tips: 0,
  bonuses: 0,
  totalRevenue: f.grossSales,
  salesTax: f.salesTax,
  whatnotFee: f.whatnotFee,
  processingFee: f.processingFee,
  totalFees: f.totalFees,
  netRevenue: f.grossSales + f.totalFees,
  shippingSubsidy: 0,
  shippingCharges: 0,
  giveawayShipping: 0,
  refundShipping: 0,
  netShipping: 0,
  showBoost: 0,
  reversals: 0,
  giveawayLoss: 0,
  netAfterCosts: f.grossSales + f.totalFees,
  breakCost: 0,
  giveawayCost: 0,
  cogs: 0,
  grossProfit: f.grossSales,
  netProfit: f.grossSales + f.totalFees,
  rowCount: 1029,
  carriedBackRows: 0,
  carriedBackAmount: 0
}
const sections = buildPnl(day)
ok(near(pnlChecksum(sections), day.netProfit as number), 'the sections sum to netProfit')
ok(
  near(sections.find((s: any) => s.key === 'revenue').subtotal, f.grossSales),
  'the top line is the DERIVED gross, not the ledger figure'
)
const fees = sections.find((s: any) => s.key === 'fees')
const stripeLine = fees.lines.find((l: any) => l.key === 'processingFee')
const whatnotLine = fees.lines.find((l: any) => l.key === 'whatnotFee')
// The 30c is back on the line, deliberately: the previous version of this test
// asserted it was absent, on a model where charging it invented money.
// A day built straight from `computeFees` carries no rate breakdown, so the
// processing line describes the shape of the charge rather than naming terms it
// was never told. What it must always state is the order count, because that is
// what the flat charge multiplies.
ok(stripeLine.detail.includes('1,029'), 'the processing line states the order count', stripeLine.detail)
ok(
  !stripeLine.detail.includes('2.9%'),
  'and names no percentage it was not given',
  stripeLine.detail
)
ok(whatnotLine.detail.includes('8%'), "Whatnot's line states the rate it charged", whatnotLine.detail)
// THE TAX IS NAMED AS A PASS-THROUGH AND AS NOTHING ELSE.
//
// It is said on the PROCESSING LINE'S HINT rather than in the section note now.
// The sentence only answers one question — why this charge is more than the card
// percentage of sales — and it is asked by whoever is already looking at this
// line, so it hangs off the detail's tooltip instead of standing under the
// section where every reader had to walk past it. The assertion follows it: what
// matters is that the app says it somewhere a reader can reach from the figure,
// not which element carries it.
ok(
  (stripeLine.detailHint || '').includes('not revenue and not a cost'),
  'and the processing line says what the tax is and is not',
  String(stripeLine.detailHint)
)
ok(
  (stripeLine.detailHint || '').includes('order total'),
  'and names the base it is charged on',
  String(stripeLine.detailHint)
)
ok(
  Math.abs(whatnotLine.amount) !== Math.abs(stripeLine.amount),
  'the two cuts are separate lines with separate figures'
)
ok(
  (fees.note || '').includes('Whatnot pays net'),
  'and the section says the ledger pays net',
  String(fees.note)
)

// A single $20.00 payout, taken apart by hand at the default terms — and chosen
// because it is a case where the closed form ALONE IS WRONG.
//
//   k    = 0.029 × 1.0518                       = 0.030502
//   item = (2000 + 30) / (1 − 0.08 − 0.030502)  = 2282.19c
//
// Round that to 2282 and the forward model pays out 1999c, not 2000c. The search
// around it finds 2283:
//
//   commission = round(2283 × 0.08)               =  183c
//   tax        = round(2283 × 0.0518)             =  118c   (the buyer's, not ours)
//   order      = 2283 + 118                       = 2401c
//   processing = round(2401 × 0.029 + 30)         =  100c
//   payout     = 2283 − 183 − 100                 = 2000c   exactly
//
// That correction is the whole reason the inverse checks itself against the
// forward model instead of trusting the algebra: one cent, on every row of a
// business that sells two thousand of them a night.
const spot = deriveSaleFee(2000, DEFAULT_FEE_RATES)
ok(spot.itemCents === 2283, 'a $20.00 payout was a $22.83 bid', String(spot.itemCents))
ok(spot.grossCents === 2283, 'and the gross is that bid', String(spot.grossCents))
ok(spot.whatnotFeeCents === -183, "Whatnot's 8% of the bid is $1.83", String(spot.whatnotFeeCents))
ok(spot.processingFeeCents === -100, 'card processing on the $24.01 order is $1.00', String(spot.processingFeeCents))
ok(spot.taxCents === 118, 'and the buyer paid $1.18 of tax on top', String(spot.taxCents))
// THE TIE, right next door. $19.99 is paid out by BOTH a $22.81 and a $22.82
// bid — a cent on the bid moves the payout by less than a cent, so about one
// payout in nine has two answers. The inverse takes the one nearest the
// unrounded solution, which makes it deterministic; what it can never do is
// return a bid that pays out something else.
const tie = deriveSaleFee(1999, DEFAULT_FEE_RATES)
ok(tie.itemCents === 2281, 'a $19.99 payout resolves to the nearer of its two bids', String(tie.itemCents))
ok(
  tie.grossCents + tie.whatnotFeeCents + tie.processingFeeCents === 1999,
  'and either way the row lands back on what was paid'
)
ok(
  spot.grossCents + spot.whatnotFeeCents + spot.processingFeeCents === 2000,
  'the three land back on the $20.00 exactly, with the tax in none of them'
)

// ---------------------------------------------------------------------------
console.log('\n=== B1. a peer cannot overwrite a local on-hand count ===')
// ---------------------------------------------------------------------------
// The failure this exists to stop: somebody renames a supply on another laptop
// while offline. Their row carries their stale `quantity`, and under a plain
// last-write-wins upsert it lands on top of a deduction made here — putting the
// stock back on a shelf it already left.
const s1 = supplies.createSupply(
  {
    name: 'Team bags',
    unit: 'each',
    unitCost: 0.02,
    itemsPerUnit: 1,
    reorderPoint: 0,
    recurring: true,
    notes: null,
    openingQuantity: 2000
  },
  null
)
supplies.useSupply(s1.id, { quantity: 65, note: 'tonight' }, null)
ok(supplies.getSupply(s1.id).quantity === 1935, 'locally 65 went out', String(supplies.getSupply(s1.id).quantity))

const stale = { ...getDb().prepare('SELECT * FROM supplies WHERE id = ?').get(s1.id) }
stale.quantity = 2000 // what the peer still thinks
stale.name = 'Team bags (bulk)' // the edit they actually made
sync.applyRows([
  { kind: 'supplies', id: s1.id, seq: 1, updated_at: new Date().toISOString(), deleted: 0, data: JSON.stringify(stale) }
])
ok(
  supplies.getSupply(s1.id).quantity === 1935,
  'the count survived the peer edit',
  String(supplies.getSupply(s1.id).quantity)
)
ok(supplies.getSupply(s1.id).name === 'Team bags (bulk)', 'while the rename landed')

// ---------------------------------------------------------------------------
console.log('\n=== B2. a supply we have never seen still arrives with its count ===')
// ---------------------------------------------------------------------------
// The other side of the same rule: on an INSERT there is no local number to
// protect, so the sender's is the best thing available.
const fresh = {
  id: 'sup_from_peer',
  name: 'Toploaders',
  unit: 'each',
  quantity: 750,
  unit_cost: 0.05,
  items_per_unit: 1,
  reorder_point: 0,
  recurring: 0,
  notes: null,
  reorder_url: null,
  image: null,
  ship_role: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
}
sync.applyRows([
  { kind: 'supplies', id: fresh.id, seq: 2, updated_at: fresh.updated_at, deleted: 0, data: JSON.stringify(fresh) }
])
ok(supplies.getSupply(fresh.id)?.quantity === 750, 'a brand-new supply keeps its count', String(supplies.getSupply(fresh.id)?.quantity))

// ---------------------------------------------------------------------------
console.log('\n=== B3. the rebuild recovers the count from the movements ===')
// ---------------------------------------------------------------------------
const before = supplies.getSupply(s1.id).quantity
sync.rebuildDerivedSupplyStock([s1.id])
ok(supplies.getSupply(s1.id).quantity === before, 'a healthy supply is left exactly alone', String(supplies.getSupply(s1.id).quantity))

// Corrupt it the way a stale peer row used to, then prove the rebuild repairs it.
getDb().prepare('UPDATE supplies SET quantity = 2000 WHERE id = ?').run(s1.id)
ok(sync.rebuildDerivedSupplyStock([s1.id]) === 1, 'a drifted count is reported as changed')
ok(supplies.getSupply(s1.id).quantity === 1935, 'and put back to the sum of its movements', String(supplies.getSupply(s1.id).quantity))

// A supply with NO movements is not the same as one holding zero.
ok(sync.rebuildDerivedSupplyStock([fresh.id]) === 0, 'a supply with no movements is skipped')
ok(supplies.getSupply(fresh.id).quantity === 750, 'and keeps its count', String(supplies.getSupply(fresh.id).quantity))

// ---------------------------------------------------------------------------
console.log('\n=== B4. a quarantined row is retried, not lost forever ===')
// ---------------------------------------------------------------------------
// Once a COUNT is derived from movement rows, one permanently-rejected movement
// is a permanently wrong number on the shelf. Most rejections are a child that
// beat its parent, so they come good on the next attempt.
const orphanTxn = {
  id: 'txn_orphan_1',
  supply_id: 'sup_not_here_yet',
  type: 'use',
  quantity_change: -10,
  unit_cost: null,
  total_cost: null,
  note: 'arrived early',
  actor_id: null,
  units: null,
  items_per_unit: null,
  created_at: new Date().toISOString()
}
let res = sync.applyRows([
  { kind: 'supply_transactions', id: orphanTxn.id, seq: 3, updated_at: orphanTxn.created_at, deleted: 0, data: JSON.stringify(orphanTxn) }
])
ok(res.rejected === 1, 'a movement whose supply is missing is quarantined', JSON.stringify(res))
ok(sync.rejectCount() === 1, 'and sits in the quarantine', String(sync.rejectCount()))

// Retrying while the parent is STILL missing must not lose the row.
sync.retryRejects()
ok(sync.rejectCount() === 1, 'a retry that cannot succeed keeps the row', String(sync.rejectCount()))

// The parent lands, and now the retry works.
const parent = { ...fresh, id: 'sup_not_here_yet', name: 'Late parent', quantity: 100 }
sync.applyRows([
  { kind: 'supplies', id: parent.id, seq: 4, updated_at: parent.updated_at, deleted: 0, data: JSON.stringify(parent) }
])
const recovered = sync.retryRejects()
ok(recovered.recovered === 1, 'the orphan lands once its parent exists', JSON.stringify(recovered))
ok(sync.rejectCount() === 0, 'and the quarantine is empty', String(sync.rejectCount()))
// Only now is it safe to derive the count.
sync.rebuildDerivedSupplyStock([parent.id])
ok(supplies.getSupply(parent.id).quantity === -10, 'the recovered movement is in the count', String(supplies.getSupply(parent.id).quantity))

// ---------------------------------------------------------------------------
console.log('\n=== B5. a lot that lands late still gets a quantity beside it ===')
// ---------------------------------------------------------------------------
// The failure this exists to stop, seen on the web server: 306 products, every
// cost layer present, and $63,900 of inventory where the desktop showed
// $426,700. The layers had arrived; the on-hand quantity that is DERIVED from
// them had not, so every shelf missing one was valued at zero — a shelf reading
// "0 counted, 11 in layers" on a screen whose totals follow the count.
//
// Two ways it happened, both here.
const db2 = getDb()
const now = new Date().toISOString()
const productRow = (id: string, name: string): Record<string, unknown> => ({
  id,
  sku: '',
  upc: null,
  name,
  category: 'Baseball',
  brand: '',
  set_name: '',
  year: '',
  unit_type: 'case',
  boxes_per_case: null,
  packs_per_box: null,
  giveaway_item: 0,
  unit_cost: 0,
  high_bid: null,
  sale_price: null,
  reorder_point: 0,
  notes: null,
  created_at: now,
  updated_at: now
})
const lotRow = (id: string, productId: string, qty: number, cost: number): Record<string, unknown> => ({
  id,
  product_id: productId,
  location: 'RM',
  qty_received: qty,
  qty_remaining: qty,
  unit_cost: cost,
  received_at: now,
  source: 'restock',
  note: null,
  created_at: now
})
const incoming = (kind: string, id: string, seq: number, data: Record<string, unknown>): any => ({
  kind,
  id,
  seq,
  updated_at: now,
  deleted: 0 as const,
  data: JSON.stringify(data)
})
const stockOf = (productId: string): number => {
  const r = db2
    .prepare(`SELECT COALESCE(SUM(quantity), 0) AS q FROM inventory_stock WHERE product_id = ?`)
    .get(productId) as { q: number }
  return r.q
}

// (i) THE ORDINARY PATH still works: product and lots in one batch.
sync.applyRows([
  incoming('inventory_products', 'prd_ok', 10, productRow('prd_ok', 'Arrived Together')),
  incoming('inventory_lots', 'lot_ok', 11, lotRow('lot_ok', 'prd_ok', 4, 100))
])
sync.rebuildDerivedStock(['prd_ok'])
ok(stockOf('prd_ok') === 4, 'a lot landing with its product produces a count', String(stockOf('prd_ok')))

// (ii) THE LOT ARRIVES ALONE. Its product is not here yet, so it is refused and
// quarantined — the ordinary shape of a first sync, where the relay orders rows
// by when they were last WRITTEN and a product edited yesterday sorts after lots
// received months ago.
const orphanLot = lotRow('lot_late', 'prd_late', 11, 250)
let r5 = sync.applyRows([incoming('inventory_lots', 'lot_late', 12, orphanLot)])
ok(r5.rejected === 1, 'a lot whose product is missing is quarantined', JSON.stringify(r5))

// The product arrives in the next batch, and the replay lands the lot.
sync.applyRows([
  incoming('inventory_products', 'prd_late', 13, productRow('prd_late', 'Arrived Late'))
])
const replay = sync.retryRejects()
ok(replay.recovered === 1, 'and the replay lands it once its product exists', JSON.stringify(replay))
// THIS is the assertion the bug was hiding behind. retryRejects used to return a
// count and nothing else, so the caller had no way to know a lot had landed and
// never rebuilt the shelf. The row was in the database; the quantity was not.
ok(
  replay.touchedProducts.includes('prd_late'),
  'and it REPORTS whose shelf it just changed',
  JSON.stringify(replay.touchedProducts)
)
ok(stockOf('prd_late') === 0, 'the count is still missing until something rebuilds it')
sync.rebuildDerivedStock(replay.touchedProducts)
ok(stockOf('prd_late') === 11, 'and the rebuild supplies it', String(stockOf('prd_late')))

// ---------------------------------------------------------------------------
console.log('\n=== B6. drift is reported for a shelf with NO stock row at all ===')
// ---------------------------------------------------------------------------
// The drift report used to walk inventory_stock, so a shelf holding layers and
// no stock row — precisely the damage above — was invisible to the one screen
// built to find it. It has to be driven off both tables.
db2.prepare(`DELETE FROM inventory_stock WHERE product_id = ?`).run('prd_late')
const gaps = sync.stockDrift() as Array<{ productId: string; name: string; stock: number; lots: number }>
const gap = gaps.find((g) => g.productId === 'prd_late')
ok(!!gap, 'a shelf with layers and no stock row is reported', JSON.stringify(gaps))
ok(gap?.stock === 0 && gap?.lots === 11, 'with both sides of the disagreement', JSON.stringify(gap))
ok(gap?.name === 'Arrived Late', 'and named, so somebody can go and look at it', String(gap?.name))

// And the repair puts it back. This is the button on the sync screen.
const repaired = sync.repairDerivedStock()
ok(repaired.shelves >= 1, 'the repair reports what it found', JSON.stringify(repaired))
ok(stockOf('prd_late') === 11, 'and the count is back on the shelf', String(stockOf('prd_late')))
ok(sync.stockDrift().length === 0, 'with nothing left disagreeing', JSON.stringify(sync.stockDrift()))
// A healthy database is left alone rather than churned.
ok(sync.repairDerivedStock().changed === 0, 'a second run changes nothing')

// ---------------------------------------------------------------------------
console.log('\n=== C1. a UNIQUE column that is not the id ===')
// ---------------------------------------------------------------------------
// EVERY ONE OF THESE USED TO BE A ROW THAT VANISHED.
//
// The upsert says `ON CONFLICT (id)`. A row whose id is new but whose UNIQUE
// column already belongs to somebody else raises a constraint that clause does
// not cover, so the batch died, the row-by-row replay died, and the record went
// to quarantine with the cursor already past it — present on one machine,
// missing on the other, and nothing on either screen to say so.
//
// Two shapes, and they need OPPOSITE treatment. Conflating them is how a fix
// here turns into data loss:
//
//   · The same real thing under two ids (a content hash, an idempotency token,
//     a relationship). De-duplicate: one row survives.
//   · The same LABEL on two different things (a PO number, a role). Keep BOTH:
//     the loser is relabelled.
const poRepo = require('../src/main/db/purchaseOrders')
const db3 = getDb()
const stamp = new Date().toISOString()

// A product to hang orders off.
sync.applyRows([incoming('inventory_products', 'prd_po', 40, productRow('prd_po', 'Order Fodder'))])

// -- the allocator no longer mints a number the table already holds -----------
// This is the source of the collision, and it is a per-machine counter in
// `meta` — a table that is deliberately NOT synced. So laptop A and laptop B
// both minted PO-0007 for two different orders.
const mine = poRepo.createPurchaseOrder(
  { supplier: 'Steel City', location: 'RM', lines: [{ productId: 'prd_po', quantity: 1, unitPrice: 10 }] },
  null
)
ok(/^PO-\d{4}$/.test(mine.poNumber), 'a purchase order gets a numbered label', mine.poNumber)

// Somebody else's order, numbered far ahead, lands over sync. The counter in
// meta knows nothing about it.
const peerNumber = 'PO-0900'
const peerPo = { ...(db3.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(mine.id) as any) }
peerPo.id = 'po_from_peer'
peerPo.po_number = peerNumber
const landedPeer = sync.applyRows([
  { kind: 'purchase_orders', id: peerPo.id, seq: 41, updated_at: stamp, deleted: 0, data: JSON.stringify(peerPo) }
])
ok(landedPeer.rejected === 0, 'a peer order with a free number just lands', JSON.stringify(landedPeer))

const next = poRepo.createPurchaseOrder(
  { supplier: 'Steel City', location: 'RM', lines: [{ productId: 'prd_po', quantity: 1, unitPrice: 10 }] },
  null
)
ok(
  next.poNumber === 'PO-0901',
  'THE NEXT NUMBER COMES OFF THE TABLE, not off the unsynced counter',
  next.poNumber
)

// -- a genuine clash: two machines, both offline, same number ----------------
// Nothing can prevent this one. What matters is that both orders survive it.
const clashing = { ...(db3.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(next.id) as any) }
// '0000…' sorts below every uuid: a uuid's first character is a hex digit, and
// no uuid is four zeros followed by an underscore. Picking 'aaa…' here was the
// mistake worth writing down — half of all uuids start with a DIGIT, which
// sorts below 'a', so that id lost the comparison it was meant to win.
clashing.id = '0000_incoming_wins'
clashing.po_number = next.poNumber
// Cleared so the assertion below measures what the APPLY queued, not the
// capture trigger that fired when this machine created the order.
db3.prepare(`DELETE FROM sync_outbox WHERE kind = 'purchase_orders'`).run()
const settled = sync.applyRows([
  { kind: 'purchase_orders', id: clashing.id, seq: 42, updated_at: stamp, deleted: 0, data: JSON.stringify(clashing) }
])
ok(settled.rejected === 0, 'A CLASHING PO NUMBER IS NOT QUARANTINED', JSON.stringify(settled))
ok(settled.applied === 1, 'the incoming order lands', JSON.stringify(settled))
const numbersNow = db3
  .prepare(`SELECT id, po_number FROM purchase_orders WHERE id IN (?, ?)`)
  .all(next.id, clashing.id) as Array<{ id: string; po_number: string }>
ok(numbersNow.length === 2, 'BOTH ORDERS STILL EXIST — neither was deleted to settle a label')
ok(
  numbersNow.find((r) => r.id === clashing.id)?.po_number === 'PO-0901',
  'the smaller id keeps the number',
  JSON.stringify(numbersNow)
)
ok(
  numbersNow.find((r) => r.id === next.id)?.po_number !== 'PO-0901',
  'and the local one was renumbered rather than lost',
  JSON.stringify(numbersNow)
)
ok(
  (db3.prepare(`SELECT COUNT(*) AS n FROM sync_outbox WHERE kind = 'purchase_orders' AND id = ?`).get(next.id) as any).n === 1,
  'the renumber is published, so everyone else converges on it'
)

// The other direction: the incoming row is the one with the larger id, so it
// lands renumbered and this machine says NOTHING about it — the machine that
// owns that order is reaching the same verdict and its version is the one that
// counts.
const keeper = db3.prepare('SELECT po_number FROM purchase_orders WHERE id = ?').get(next.id) as { po_number: string }
const loser = { ...(db3.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(next.id) as any) }
loser.id = 'zzz_incoming_loses'
loser.po_number = keeper.po_number
db3.prepare(`DELETE FROM sync_outbox WHERE kind = 'purchase_orders'`).run()
const settled2 = sync.applyRows([
  { kind: 'purchase_orders', id: loser.id, seq: 43, updated_at: stamp, deleted: 0, data: JSON.stringify(loser) }
])
ok(settled2.rejected === 0, 'the mirror case is not quarantined either', JSON.stringify(settled2))
ok(
  (db3.prepare('SELECT po_number FROM purchase_orders WHERE id = ?').get(next.id) as any).po_number === keeper.po_number,
  'the local order keeps its number'
)
const landedLoser = db3.prepare('SELECT po_number FROM purchase_orders WHERE id = ?').get(loser.id) as { po_number: string }
ok(!!landedLoser, 'and the incoming order still landed')
ok(landedLoser.po_number !== keeper.po_number, 'under a number of its own', landedLoser?.po_number)
ok(
  (db3.prepare(`SELECT COUNT(*) AS n FROM sync_outbox WHERE kind = 'purchase_orders' AND id = ?`).get(loser.id) as any).n === 0,
  'and this machine does not publish a guess about somebody else’s order'
)

// ---------------------------------------------------------------------------
console.log('\n=== C2. the same real thing under two ids ===')
// ---------------------------------------------------------------------------
// The opposite treatment, on tables where the UNIQUE column says what the row
// IS rather than what it is called.

// A ledger fingerprint is a content hash of one line of a Whatnot export. Two
// machines importing the same file both insert it. It is ONE sale, and counting
// it twice is a wrong revenue figure.
const importRow = {
  id: 'imp_c2',
  filename: 'invented-export.csv',
  rows_parsed: 1,
  rows_imported: 1,
  rows_duplicate: 0,
  rows_repaired: 0,
  rows_quarantined: 0,
  first_occurred_at: stamp,
  last_occurred_at: stamp,
  warnings_json: '[]',
  created_at: stamp,
  created_by: null
}
sync.applyRows([
  { kind: 'ledger_imports', id: importRow.id, seq: 50, updated_at: stamp, deleted: 0, data: JSON.stringify(importRow) }
])
const ledgerRow = (id: string): Record<string, unknown> => ({
  id,
  import_id: 'imp_c2',
  occurred_at: stamp,
  amount: 25,
  order_id: 'ord-invented-1',
  listing_id: null,
  message: 'One pack',
  txn_type: 'sale',
  bucket: 'sales',
  session_id: null,
  stream_date: '2026-08-09',
  attribution: 'unattributed',
  break_number: null,
  fingerprint: 'fp-invented-0001',
  repaired: 0,
  classifier_version: 1,
  created_at: stamp
})
const first = sync.applyRows([
  { kind: 'ledger_rows', id: 'zzz_local_ledger', seq: 51, updated_at: stamp, deleted: 0, data: JSON.stringify(ledgerRow('zzz_local_ledger')) }
])
ok(first.rejected === 0, 'the first copy of a sale lands', JSON.stringify(first))
const second = sync.applyRows([
  { kind: 'ledger_rows', id: 'aaa_peer_ledger', seq: 52, updated_at: stamp, deleted: 0, data: JSON.stringify(ledgerRow('aaa_peer_ledger')) }
])
ok(second.rejected === 0, 'THE SAME SALE FROM ANOTHER MACHINE IS NOT QUARANTINED', JSON.stringify(second))
ok(second.duplicates === 1, 'it is recognised as a duplicate', JSON.stringify(second))
ok(
  (db3.prepare(`SELECT COUNT(*) AS n FROM ledger_rows WHERE fingerprint = 'fp-invented-0001'`).get() as any).n === 1,
  'and the sale is counted exactly once'
)

// The QuickBooks push log. This table IS the double-post defence, so a row of it
// going to quarantine means the app forgets it has already sent somebody a bill.
const qboRow = (id: string): Record<string, unknown> => ({
  id,
  entity: 'purchase_order',
  local_id: 'po_shared',
  realm_id: '46200000000',
  qbo_type: 'Bill',
  qbo_id: '77',
  doc_number: '1041',
  amount: 250,
  status: 'ok',
  error: null,
  payload_hash: null,
  created_at: stamp,
  updated_at: stamp,
  synced_at: stamp
})
sync.applyRows([
  { kind: 'qbo_sync_log', id: 'zzz_local_qbo', seq: 53, updated_at: stamp, deleted: 0, data: JSON.stringify(qboRow('zzz_local_qbo')) }
])
const qboSecond = sync.applyRows([
  { kind: 'qbo_sync_log', id: 'aaa_peer_qbo', seq: 54, updated_at: stamp, deleted: 0, data: JSON.stringify(qboRow('aaa_peer_qbo')) }
])
ok(qboSecond.rejected === 0, 'a push log row from another machine is not quarantined', JSON.stringify(qboSecond))
ok(
  (db3.prepare(`SELECT COUNT(*) AS n FROM qbo_sync_log WHERE local_id = 'po_shared'`).get() as any).n === 1,
  'and one push is recorded once, so the double-post guard still works'
)

// A COMPOSITE key matches on ALL of its columns, and only all of them. Two
// benches assigning two DIFFERENT packers to the same break share half the key
// and are not the same assignment; de-duplicating on the half they share would
// throw one of the two people off the break.
const assign = (id: string, employee: string): Record<string, unknown> => ({
  id,
  break_id: 'brk_c2',
  break_number: 4,
  employee_id: employee,
  assigned_at: stamp,
  assigned_by: null,
  note: null
})
const twoPeople = sync.applyRows([
  { kind: 'ship_break_assignments', id: 'zzz_a', seq: 55, updated_at: stamp, deleted: 0, data: JSON.stringify(assign('zzz_a', 'emp_one')) },
  { kind: 'ship_break_assignments', id: 'aaa_b', seq: 56, updated_at: stamp, deleted: 0, data: JSON.stringify(assign('aaa_b', 'emp_two')) }
])
ok(twoPeople.rejected === 0, 'two people on one break both land', JSON.stringify(twoPeople))
ok(
  (db3.prepare(`SELECT COUNT(*) AS n FROM ship_break_assignments WHERE break_id = 'brk_c2'`).get() as any).n === 2,
  'and both stay on it — half a composite key is not the key'
)

// The same person, assigned on two benches at once. NOW it is one assignment.
const samePerson = sync.applyRows([
  { kind: 'ship_break_assignments', id: 'aaa_dup', seq: 57, updated_at: stamp, deleted: 0, data: JSON.stringify(assign('aaa_dup', 'emp_one')) }
])
ok(samePerson.rejected === 0, 'the same person assigned twice is not quarantined', JSON.stringify(samePerson))
ok(
  (db3.prepare(`SELECT COUNT(*) AS n FROM ship_break_assignments WHERE break_id = 'brk_c2' AND employee_id = 'emp_one'`).get() as any).n === 1,
  'and appears on the card once'
)

// ---------------------------------------------------------------------------
console.log('\n=== C3. a role only one supply can hold ===')
// ---------------------------------------------------------------------------
// Only one supply is "the team bags". Two machines naming different boxes for
// the role is a real disagreement — and the answer is to take the ROLE off the
// loser, never the supply: that box is stock with a count on it.
db3.prepare(`UPDATE supplies SET ship_role = 'team_bag' WHERE id = ?`).run(fresh.id)
const rival = { ...(db3.prepare('SELECT * FROM supplies WHERE id = ?').get(fresh.id) as any) }
rival.id = 'aaa_rival_bag'
rival.name = 'Rival team bags'
rival.ship_role = 'team_bag'
const roleResult = sync.applyRows([
  { kind: 'supplies', id: rival.id, seq: 60, updated_at: stamp, deleted: 0, data: JSON.stringify(rival) }
])
ok(roleResult.rejected === 0, 'a rival claim on the role is not quarantined', JSON.stringify(roleResult))
ok(
  (db3.prepare(`SELECT COUNT(*) AS n FROM supplies WHERE id IN (?, ?)`).get(fresh.id, rival.id) as any).n === 2,
  'BOTH SUPPLIES SURVIVE — a label dispute never deletes stock'
)
ok(
  (db3.prepare(`SELECT COUNT(*) AS n FROM supplies WHERE ship_role = 'team_bag'`).get() as any).n === 1,
  'and exactly one of them holds the role'
)
ok(
  (db3.prepare('SELECT ship_role AS r FROM supplies WHERE id = ?').get(rival.id) as any).r === 'team_bag',
  'the smaller id keeps it, the same rule as everywhere else'
)


console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
