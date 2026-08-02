/**
 * Packing supplies in the day-by-day P&L.
 *
 * The figure comes from Supplies, not from Whatnot's ledger, and this module
 * reconciles every day against its rows. A non-ledger cost that is not stripped
 * from that check flags EVERY day unreconciled — which does not fail loudly, it
 * just teaches the operator to ignore the one flag that matters. That is what
 * these assertions exist to catch.
 *
 * Run: npm run test:pnl
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/pnl-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true })
const { getDb } = require('../src/main/db/database')
const ship = require('../src/main/db/shipping')
const domain = require('../src/main/db/shippingDomain')
const supplies = require('../src/main/db/supplies')
const fin = require('../src/main/db/financeStreaming')
const { buildPnl, pnlChecksum } = require('../src/shared/financeStreaming')
const { parsePages } = require('../src/main/shipping/parser')
getDb()

let pass = 0, fail = 0
const ok = (c: boolean, n: string, e = ''): void => {
  if (c) { pass++; console.log('  ok   ' + n) } else { fail++; console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`) }
}

// A show, assigned to a day.
const BOX = '1x 2026 FINEST BASEBALL HOBBY BOX- Break #'
const slip = (handle: string, tracking: string, lines: string[]): string =>
  [
    'Whatnot Packing Slip 1/1',
    `To: ${handle} From: rm_cardz`,
    'Buyer Name',
    '5 Oak Ave. Reno, NV. 89501. US',
    'QTY Name & Description Attributes Subtotal',
    ...lines,
    `${Math.ceil(lines.length / 2)} Items $0.00`,
    `USPS Ground Advantage #${tracking} 3.0 oz`
  ].join('\n')
// One MLB break (30 packs) and two packages: one with cards, one giveaway-only.
const PAGES = [
  slip('alpha', '9300120762602315706741', [
    '1 Boston Red Sox Order 6000000001 $20.00',
    BOX + '4'
  ]),
  slip('bravo', '9300120762602315706742', [
    '1 New York Yankees Order 6000000002 $0.00',
    'GIVEAWAY'
  ])
]
const ds = parsePages(PAGES, { sport: 'mlb', eventName: 'Finest Baseball', eventDate: '2026-07-12' })
ship.importDataset(ds, { filename: 'real.pdf' })
ship.setShipEvent('Finest Baseball', '2026-07-12')

console.log('=== with nothing linked ===')
let view = fin.streamingFinanceView()
ok(view.reconciled === true, 'the P&L reconciles before any packing cost', JSON.stringify(view.reconciled))
const dayOf = (v: any, d: string): any => v.days.find((x: any) => x.streamDate === d) ?? null
ok(dayOf(view, '2026-07-12') === null || dayOf(view, '2026-07-12').packingSupplies === 0,
   'and shows no packing when nothing is linked')

console.log('\n=== link three roles, priced ===')
const mk = (name: string, qty: number, cost: number, role: string): string => {
  const s = supplies.createSupply(
    { name, unit: 'each', unitCost: cost, itemsPerUnit: 1, reorderPoint: 0, recurring: true, notes: null, openingQuantity: qty },
    null
  )
  supplies.setSupplyShipRole(s.id, role)
  return s.id
}
// 1 carded + 1 giveaway-only = 3 mailers; 30 packs + 5 = 35 bags; 2 labels.
mk('Bubble mailers 6x9', 500, 0.30, 'bubble_mailer') //  3 × 0.30 = 0.90
mk('Team bags', 2000, 0.02, 'team_bag') //             35 × 0.02 = 0.70
mk('4x6 thermal labels', 1000, 0.5, 'shipping_label_4x6') // 2 × 0.50 = 1.00

const costed = domain.getSupplyPlanCosted()
console.log(`   plan total $${costed.totalCost.toFixed(2)}  unmapped ${costed.unmappedRoles.length}`)
ok(Math.abs(costed.totalCost - 2.6) < 0.005, 'the costed plan totals $2.60', String(costed.totalCost))

view = fin.streamingFinanceView()
const day = dayOf(view, '2026-07-12')
ok(!!day, 'the show day exists in the P&L', String(view.days.length))
ok(Math.abs(day.packingSupplies + 2.6) < 0.005,
   'packing lands NEGATIVE on the show day', String(day?.packingSupplies))

console.log('\n=== the reconciliation ===')
ok(view.reconciled === true,
   'the P&L STILL reconciles with a non-ledger cost in it', JSON.stringify(view.unreconciled ?? view.reconciled))

// The statement layout must agree with the bottom line, per the module's own contract.
const sections = buildPnl(day)
ok(Math.abs(pnlChecksum(sections) - day.netProfit) < 0.005,
   'the statement sections still sum to netProfit',
   `${pnlChecksum(sections)} vs ${day.netProfit}`)
const shipSec = sections.find((s: any) => s.key === 'shipping')
ok(!!shipSec.lines.find((l: any) => l.key === 'packingSupplies'),
   'and the shipping section carries a Packing supplies line')
ok(shipSec.subtotalLabel === 'Net shipping & packing', 'renamed to say what it now includes', shipSec.subtotalLabel)
ok(Math.abs(shipSec.subtotal - day.netShipping) < 0.005,
   'the section subtotal is netShipping', `${shipSec.subtotal} vs ${day.netShipping}`)

// An unassigned show has nowhere to book packing — and must not invent a day.
console.log('\n=== an unassigned show ===')
ship.setShipEvent('Finest Baseball', '')
const view2 = fin.streamingFinanceView()
ok(view2.reconciled === true, 'still reconciles with the day cleared')
ok(view2.days.every((d: any) => d.packingSupplies === 0),
   'and no day carries packing when the show has no day',
   JSON.stringify(view2.days.filter((d: any) => d.packingSupplies !== 0).map((d: any) => d.streamDate)))

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
