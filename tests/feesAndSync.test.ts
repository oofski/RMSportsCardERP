/**
 * Two things that decide numbers nobody can check by eye.
 *
 * PART A — the fee model. RM's processing rate is a flat 2.9%; there is no
 * per-transaction charge. The old model added 30c per sale row, which on shows
 * that sell hundreds of small break spots invented fees that were never taken.
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
  WHATNOT_COMMISSION_RATE,
  PROCESSING_RATE,
  TOTAL_FEE_RATE,
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
console.log('=== A1. the rate is a flat percentage ===')
// ---------------------------------------------------------------------------
ok(PROCESSING_RATE === 0.029, 'processing is 2.9%', String(PROCESSING_RATE))
ok(WHATNOT_COMMISSION_RATE === 0.06, 'commission is 6%', String(WHATNOT_COMMISSION_RATE))
ok(near(TOTAL_FEE_RATE, 0.089, 1e-9), 'so the whole take is 8.9%', String(TOTAL_FEE_RATE))
ok(
  (require('../src/shared/financeStreaming') as Record<string, unknown>)
    .PROCESSING_PER_TRANSACTION === undefined,
  'and the per-transaction fee is gone from the contract'
)

// ---------------------------------------------------------------------------
console.log('\n=== A2. the transaction COUNT cannot change the fee ===')
// ---------------------------------------------------------------------------
// The whole point. $10,000 of sales costs the same whether it arrived as one
// order or as two thousand break spots — which is exactly what the old flat 30c
// got wrong, and it got it wrong worst on RM's biggest shows.
const one = computeFees(10000, 1)
const many = computeFees(10000, 2000)
ok(near(one.totalFees, many.totalFees), 'one sale and 2,000 sales cost the same', `${one.totalFees} vs ${many.totalFees}`)
ok(near(one.totalFees, -890), '8.9% of $10,000 is $890', String(one.totalFees))
ok(near(one.whatnotFee, -600), 'commission $600', String(one.whatnotFee))
ok(near(one.processingFee, -290), 'processing $290', String(one.processingFee))
// Under the old model the 2,000-sale case would have been $600 heavier.
ok(
  near(many.processingFee, -290),
  'the 2,000-spot show is not charged an extra $600',
  String(many.processingFee)
)
ok(many.saleCount === 2000, 'the count is still reported', String(many.saleCount))

// ---------------------------------------------------------------------------
console.log('\n=== A3. fees are negative, and only on sales ===')
// ---------------------------------------------------------------------------
ok(computeFees(0, 0).totalFees === 0, 'no sales, no fee')
ok(computeFees(1, 1).totalFees < 0, 'a fee is negative')
const small = computeFees(20, 1)
ok(near(small.totalFees, -1.78), 'a single $20 spot costs $1.78, not $2.08', String(small.totalFees))

// ---------------------------------------------------------------------------
console.log('\n=== A4. the statement still adds up ===')
// ---------------------------------------------------------------------------
const f = computeFees(12840.55, 1029)
const day: Record<string, unknown> = {
  streamDate: '2026-08-01',
  sessionCount: 1,
  sessionTitles: ['Night'],
  minutes: 200,
  sales: 12840.55,
  saleCount: 1029,
  tips: 0,
  bonuses: 0,
  totalRevenue: 12840.55,
  whatnotFee: f.whatnotFee,
  processingFee: f.processingFee,
  totalFees: f.totalFees,
  netRevenue: 12840.55 + f.totalFees,
  shippingSubsidy: 0,
  shippingCharges: 0,
  giveawayShipping: 0,
  refundShipping: 0,
  packingSupplies: 0,
  netShipping: 0,
  showBoost: 0,
  reversals: 0,
  giveawayLoss: 0,
  netAfterCosts: 12840.55 + f.totalFees,
  breakCost: 0,
  giveawayCost: 0,
  cogs: 0,
  grossProfit: 12840.55 + f.totalFees,
  netProfit: 12840.55 + f.totalFees,
  rowCount: 1029,
  carriedBackRows: 0,
  carriedBackAmount: 0
}
const sections = buildPnl(day)
ok(near(pnlChecksum(sections), day.netProfit as number), 'the sections sum to netProfit')
const feeLine = sections
  .find((s: any) => s.key === 'fees')
  .lines.find((l: any) => l.key === 'processingFee')
ok(!feeLine.detail.includes('30'), 'the fee line no longer advertises 30c', feeLine.detail)
ok(feeLine.detail.includes('2.9%'), 'it still says the rate', feeLine.detail)
ok(feeLine.detail.includes('1,029'), 'and still shows the order count for checking', feeLine.detail)

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
