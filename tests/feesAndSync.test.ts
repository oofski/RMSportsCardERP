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
ok(
  (fees.note || '').includes('NOT REVENUE AND NOT A COST'),
  'and the section says what the tax is and is not',
  String(fees.note)
)
ok(
  Math.abs(whatnotLine.amount) !== Math.abs(stripeLine.amount),
  'the two cuts are separate lines with separate figures'
)
ok(
  (fees.note || '').includes('NET'),
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

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
