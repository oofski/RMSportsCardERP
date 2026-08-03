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
  DEFAULT_WHATNOT_RATE,
  STRIPE_PERCENT_RATE,
  STRIPE_FLAT_CENTS,
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
console.log('=== A1. the two rates, and which of them is negotiable ===')
// ---------------------------------------------------------------------------
ok(STRIPE_PERCENT_RATE === 0.029, "Stripe's percentage is 2.9%", String(STRIPE_PERCENT_RATE))
ok(STRIPE_FLAT_CENTS === 30, 'and it carries a flat 30c per slot', String(STRIPE_FLAT_CENTS))
ok(DEFAULT_WHATNOT_RATE === 0.06, 'Whatnot defaults to 6%', String(DEFAULT_WHATNOT_RATE))
// The old contract exported a single blended TOTAL_FEE_RATE and a
// WHATNOT_COMMISSION_RATE constant, both of which said the take was a fixed
// 8.9% of a gross the ledger never contained. Anything still importing them
// would be computing the old, wrong answer, so their absence is asserted.
const contract = require('../src/shared/financeStreaming') as Record<string, unknown>
ok(contract.TOTAL_FEE_RATE === undefined, 'the blended 8.9% constant is gone')
ok(contract.WHATNOT_COMMISSION_RATE === undefined, 'and the fixed 6% constant with it')

// ---------------------------------------------------------------------------
console.log('\n=== A2. the transaction count now DOES change the fee ===')
// ---------------------------------------------------------------------------
// The exact assertion this file used to make in reverse, and the reversal is the
// point. The flat 30c is real; what was wrong before was charging it ON TOP of a
// net figure rather than reverse-engineering it OUT of one. $10,000 of payout
// arriving as 2,000 spots means 2,000 slots were bought, so the buyers paid
// $600 more than if it had arrived as one order — and the net is $10,000 either
// way, which is why nothing here invents money.
const row = (netCents: number): Record<string, number> => ({
  netCents,
  whatnotRate: DEFAULT_WHATNOT_RATE
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
// is reverse-engineered out of a net figure, so each one is itself grossed up:
// the buyer paid 30c / (1 − 0.06 − 0.029) = 32.9c to leave Whatnot 30c short.
// Tolerance is half a cent per row across 2,000 rows, which is the most the
// per-row rounding can ever be.
const flatEach = 0.3 / (1 - 0.06 - 0.029)
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
  whatnotFee: f.whatnotFee,
  processingFee: f.processingFee,
  totalFees: f.totalFees,
  netRevenue: f.grossSales + f.totalFees,
  shippingSubsidy: 0,
  shippingCharges: 0,
  giveawayShipping: 0,
  refundShipping: 0,
  packingSupplies: 0,
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
ok(stripeLine.detail.includes('30¢'), 'the processing line states the 30c again', stripeLine.detail)
ok(stripeLine.detail.includes('2.9%'), 'and the percentage', stripeLine.detail)
ok(stripeLine.detail.includes('1,029'), 'and the order count it multiplies', stripeLine.detail)
ok(whatnotLine.detail.includes('6%'), "Whatnot's line states the rate it charged", whatnotLine.detail)
ok(
  Math.abs(whatnotLine.amount) !== Math.abs(stripeLine.amount),
  'the two cuts are separate lines with separate figures'
)
ok(
  (fees.note || '').includes('NET'),
  'and the section says the ledger pays net',
  String(fees.note)
)

// A single $20 payout, taken apart by hand.
//
//   gross  = (2000 + 30) / (1 − 0.06 − 0.029) = 2228.32c
//   whatnot= round(2228.32 × 0.06)            =  134c
//   stripe = round(2228.32 × 0.029) + 30      =   95c
//   gross  = 2000 + 134 + 95                  = 2229c
//
// The reported gross is 2229 rather than the 2228 the division rounds to, and
// that is the rounding decision made deliberately: the two FEES are honest
// roundings of their own rates — which is what somebody checks against a
// statement — and the derived gross absorbs the half-cent, so the three always
// land back on the ledger's own net. Under the old model this same row was
// reported as $20.00 of revenue costing $1.78 in fees; it was a $22.29 purchase
// that had already cost $2.29.
const spot = deriveSaleFee(2000, 0.06)
ok(spot.grossCents === 2229, 'a $20.00 payout was a $22.29 purchase', String(spot.grossCents))
ok(spot.whatnotFeeCents === -134, "Whatnot's 6% of that is $1.34", String(spot.whatnotFeeCents))
ok(spot.stripeFeeCents === -95, "Stripe's 2.9% + 30c is $0.95", String(spot.stripeFeeCents))
ok(
  spot.grossCents + spot.whatnotFeeCents + spot.stripeFeeCents === 2000,
  'and the three land back on the $20.00 exactly'
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

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
