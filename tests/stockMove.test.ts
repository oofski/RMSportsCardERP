/**
 * BRINGING A CASE HOME FROM A SHOP, WITH ITS COST.
 *
 * The owner: "sometimes I want to be able to take things that I buy from
 * roadshow and move them out of roadshow inventory and then move it to be with
 * us ... if we edit the PO and then it turns into something that we can put into
 * our inventory."
 *
 * ## The two things that already existed and were both wrong for this
 *
 * RE-ROUTING THE PURCHASE ORDER is refused, correctly: it says where units WILL
 * go, and `setPurchaseOrderRouting` turns it down the moment any are checked in.
 * A roadshow line is checked in the instant it is typed (buying at the shop IS
 * taking delivery), so that door is always already shut. Section 5 pins the
 * refusal, because a later change that quietly opened it would be a receiving
 * desk expecting a delivery that already happened.
 *
 * TWO HAND ADJUSTMENTS lose the money, and that is what section 2 is about.
 * Adjusting down consumes the shop's cost layer; adjusting up opens a fresh one
 * valued at what the destination shelf already carries. A $400 case landing on a
 * shelf averaging $150 becomes a $150 case for ever, and the $250 turns into
 * profit the next time it sells.
 *
 * ## So the LAYER moves
 *
 * What is pinned here:
 *
 *   1. The units land, and the shelves both add up.
 *   2. THE COST TRAVELS — this is the whole feature, and it is checked against a
 *      destination already holding stock at a different price, which is the only
 *      arrangement where a re-valuation would show.
 *   3. FIFO ORDER SURVIVES. The layer keeps its arrival date, so a March case is
 *      still consumed before a June one rather than jumping to the back.
 *   4. AN UNPRICED CASE CAN BE MOVED AND PRICED AFTERWARDS, and the price lands
 *      on the units at their new home. This is the roadshow case, and it is the
 *      one a naive implementation gets wrong.
 *   5. What is refused, and the purchase-order route that stays refused.
 *   6. The stock/lot invariant, and no money invented anywhere.
 *
 * Every name here is invented.
 *
 * Run: npm run test:stock-move
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/stock-move-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const { getDb } = require('../src/main/db/database')
const inv = require('../src/main/db/inventory')
const po = require('../src/main/db/purchaseOrders')
const invoices = require('../src/main/db/invoices')
const { assertStockLotsConsistent } = require('../src/main/db/lots')
const { saveStockLocation } = require('../src/main/db/stockLocations')
const { moveRefusal, moveNote } = require('../src/shared/stockMove')

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
const eq = (a: number, b: number): boolean => Math.abs(a - b) < 0.005

const SHOP = 'Roadshow Marlow'
saveStockLocation({ label: SHOP }, null)

const product = (id: string, sku: string, name: string): void => {
  db.prepare(
    `INSERT INTO inventory_products (id, sku, name, category, unit_cost, created_at, updated_at)
     VALUES (?, ?, ?, 'Baseball', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run(id, sku, name)
}
const qtyAt = (pid: string, loc: string): number => inv.stockQty(pid, loc)
const lotsAt = (pid: string, loc: string): any[] =>
  db
    .prepare(
      `SELECT id, qty_received, qty_remaining, unit_cost, received_at FROM inventory_lots
        WHERE product_id = ? AND location = ? ORDER BY received_at ASC, rowid ASC`
    )
    .all(pid, loc)
const shelfValue = (pid: string, loc: string): number =>
  lotsAt(pid, loc).reduce((n, l) => n + Number(l.qty_remaining) * Number(l.unit_cost), 0)

// ---------------------------------------------------------------------------
console.log('=== 1. the refusals, before any database is involved ===')
// ---------------------------------------------------------------------------
const REQ = { productId: 'p1', from: 'Roadshow Marlow', to: 'RM', quantity: 2 }
ok(moveRefusal(REQ, 5) === null, 'a move of two off a shelf holding five is fine')
ok(moveRefusal(REQ, 2) === null, 'and so is moving the whole of it')
ok(
  (moveRefusal(REQ, 1) ?? '').includes('only holding 1'),
  'MORE THAN IS THERE IS REFUSED, and the refusal names the count so somebody can go and look',
  String(moveRefusal(REQ, 1))
)
ok(
  (moveRefusal(REQ, 0) ?? '').includes('nothing at'),
  'an empty shelf says so rather than counting down from zero',
  String(moveRefusal(REQ, 0))
)
ok(
  moveRefusal({ ...REQ, to: 'roadshow marlow' }, 5) !== null,
  'THE SAME SHELF TWICE IS REFUSED, folded for case — nothing would move and the ledger would say something did'
)
ok(moveRefusal({ ...REQ, quantity: 0 }, 5) !== null, 'zero is not a move')
ok(moveRefusal({ ...REQ, quantity: -3 }, 5) !== null, 'and neither is a negative one')
ok(moveRefusal({ ...REQ, to: '' }, 5) !== null, 'a move with no destination is refused')
ok(
  moveNote('Roadshow Marlow', 'RM', 'drove them back').includes('drove them back') &&
    moveNote('Roadshow Marlow', 'RM', null) === 'Moved Roadshow Marlow → RM',
  'the note reads the same at both ends, with or without a reason'
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. THE COST TRAVELS WITH THE BOXES ===')
// ---------------------------------------------------------------------------
/**
 * The destination is deliberately already holding stock at a DIFFERENT price.
 * That is the only arrangement in which the bug shows: consume-and-recreate
 * values the arriving units at the destination's own basis, so a $400 case
 * landing beside $100 boxes would report as something between the two. With the
 * layer moved, RM ends up holding both layers at their own prices and the
 * shelf's value goes up by exactly what the case cost.
 */
product('p_cost', 'SKU-C', 'Marlow Hobby Case')
inv.addStock('p_cost', 'RM', 4, 100, 'ordinary stock at home', null)
inv.addStock('p_cost', SHOP, 2, 400, 'bought at the shop', null)

const homeBefore = shelfValue('p_cost', 'RM')
const shopBefore = shelfValue('p_cost', SHOP)
ok(eq(homeBefore, 400) && eq(shopBefore, 800), 'the two shelves start at $400 and $800', `${homeBefore} / ${shopBefore}`)

const moved = inv.moveStock({ productId: 'p_cost', from: SHOP, to: 'RM', quantity: 1 }, null)
ok(!moved.error, 'one case is driven home', String(moved.error))
ok(qtyAt('p_cost', SHOP) === 1 && qtyAt('p_cost', 'RM') === 5, 'the counts move', `${qtyAt('p_cost', SHOP)} / ${qtyAt('p_cost', 'RM')}`)
ok(
  eq(shelfValue('p_cost', 'RM'), homeBefore + 400),
  'THE ONE THAT MATTERS: home is worth exactly $400 more — the case arrived at ITS OWN cost, not at what RM was averaging',
  String(shelfValue('p_cost', 'RM') - homeBefore)
)
ok(
  eq(shelfValue('p_cost', SHOP), 400),
  'and the shop is worth exactly $400 less',
  String(shelfValue('p_cost', SHOP))
)
ok(
  eq(shelfValue('p_cost', 'RM') + shelfValue('p_cost', SHOP), homeBefore + shopBefore),
  'NO MONEY WAS INVENTED OR LOST — the two shelves together are worth what they were before'
)
const arrived = lotsAt('p_cost', 'RM').find((l: any) => eq(Number(l.unit_cost), 400))
ok(!!arrived && Number(arrived.qty_remaining) === 1, 'it is standing at RM as its own $400 layer, not blended into the $100 one')

// The ledger says it happened, twice, and says nothing was earned.
const rows = db
  .prepare(
    `SELECT location, quantity_change, cost_basis, type FROM inventory_transactions
      WHERE product_id = 'p_cost' AND note LIKE 'Moved%' ORDER BY location`
  )
  .all() as any[]
ok(rows.length === 2, 'both shelves get a ledger row — "where did those go" is asked of one shelf at a time', String(rows.length))
ok(
  rows.every((r: any) => r.type === 'adjustment'),
  'NEITHER IS A SALE OR A PURCHASE — carrying a box to another room earns nothing'
)
ok(
  rows.reduce((n: number, r: any) => n + Number(r.quantity_change), 0) === 0 &&
    eq(rows.reduce((n: number, r: any) => n + Number(r.cost_basis ?? 0), 0), 0),
  'and the pair sums to zero units and zero dollars, so the P&L cannot move'
)
assertStockLotsConsistent(db)
ok(true, 'the stock/lot invariant holds')

// ---------------------------------------------------------------------------
console.log('\n=== 3. it keeps its place in the FIFO queue ===')
// ---------------------------------------------------------------------------
/**
 * A layer opened at the destination TODAY would be consumed last. That is wrong
 * twice over: the case is older than the boxes already there, and the cost it
 * carries would then be the one left behind at the end of a season rather than
 * the one that priced the next sale. So the moved layer keeps its arrival date.
 */
/**
 * PART of the March layer, on purpose. Moving the whole of an untouched layer
 * only changes its address — its id and its date are untouched by definition,
 * so it could not detect a date being rewritten. A PARTIAL move is the path that
 * opens a new layer, and it is the one where "today" could quietly be stamped on
 * a case bought six months ago.
 */
product('p_fifo', 'SKU-F', 'Marlow FIFO Case')
inv.addStock('p_fifo', SHOP, 2, 500, 'two bought in March', null)
db.prepare(
  `UPDATE inventory_lots SET received_at = '2026-03-01T12:00:00.000Z'
    WHERE product_id = 'p_fifo' AND location = ?`
).run(SHOP)
inv.addStock('p_fifo', 'RM', 1, 900, 'bought in June', null)
db.prepare(
  `UPDATE inventory_lots SET received_at = '2026-06-01T12:00:00.000Z'
    WHERE product_id = 'p_fifo' AND location = 'RM'`
).run()

const f = inv.moveStock({ productId: 'p_fifo', from: SHOP, to: 'RM', quantity: 1 }, null)
ok(!f.error, 'one of the two March cases is driven home in September', String(f.error))
ok(
  String(lotsAt('p_fifo', 'RM').find((l: any) => Number(l.unit_cost) === 500)?.received_at).startsWith('2026-03'),
  'THE NEW LAYER CARRIES MARCH, not the day it was driven — a case does not become new by being moved',
  String(lotsAt('p_fifo', 'RM').find((l: any) => Number(l.unit_cost) === 500)?.received_at)
)
const order = lotsAt('p_fifo', 'RM').map((l: any) => Number(l.unit_cost))
ok(
  order[0] === 500 && order[1] === 900,
  'IT SITS IN FRONT OF THE JUNE BOXES — it kept its own arrival date rather than joining the back of the queue',
  JSON.stringify(order)
)
inv.recordSale('p_fifo', 'RM', 1, 1200, 'Buyer', 'first out', null)
const standing = lotsAt('p_fifo', 'RM').filter((l: any) => Number(l.qty_remaining) > 0)
ok(
  qtyAt('p_fifo', 'RM') === 1 &&
    standing.length === 1 &&
    Number(standing[0].unit_cost) === 900 &&
    eq(shelfValue('p_fifo', 'RM'), 900),
  'so the next sale consumes the MARCH case at $500 and leaves the June one — which is what FIFO means, and what the move would have broken by dating the layer today',
  JSON.stringify(lotsAt('p_fifo', 'RM'))
)

// ---------------------------------------------------------------------------
console.log('\n=== 4. AN UNPRICED CASE, MOVED HOME, PRICED AFTERWARDS ===')
// ---------------------------------------------------------------------------
/**
 * The roadshow case, and the one a naive implementation gets wrong. A tab checks
 * a case in at a placeholder zero; somebody drives it home on Thursday; the shop
 * says $325 on Friday. `setPurchaseOrderLinePrice` finds the layers a line
 * opened through `po_line_receipts`, so if the move had left that link behind,
 * the price would land on a layer holding nothing and the case at RM would stay
 * at zero for ever.
 */
product('p_pend', 'SKU-P', 'Marlow Unpriced Case')
const tab = po.createPurchaseOrder(
  {
    supplier: SHOP,
    location: '',
    ongoing: true,
    lines: [{ productId: 'p_pend', quantity: 2, unitPrice: 0, pricePending: true }]
  },
  null
)
ok(qtyAt('p_pend', SHOP) === 2, 'two unpriced cases are on the shop shelf')
ok(eq(shelfValue('p_pend', SHOP), 0), 'carried at nothing, which is what price-pending means')

const home = inv.moveStock({ productId: 'p_pend', from: SHOP, to: 'RM', quantity: 1 }, null)
ok(!home.error, 'one is driven home before anybody knows what it cost', String(home.error))
ok(qtyAt('p_pend', 'RM') === 1 && qtyAt('p_pend', SHOP) === 1, 'one at each end', `${qtyAt('p_pend', 'RM')} / ${qtyAt('p_pend', SHOP)}`)

const line = po.getPurchaseOrder(tab.id).lines[0]
const priced = po.setPurchaseOrderLinePrice(tab.id, line.id, 325, null)
ok(!priced.error, 'the shop finally says $325', String(priced.error))
ok(
  eq(shelfValue('p_pend', 'RM'), 325),
  'THE PRICE REACHES THE CASE AT ITS NEW HOME — the purchase order link travelled with it',
  String(shelfValue('p_pend', 'RM'))
)
ok(
  eq(shelfValue('p_pend', SHOP), 325),
  'and the one still at the shop is priced too',
  String(shelfValue('p_pend', SHOP))
)
ok(
  Number(
    (db
      .prepare(`SELECT COALESCE(SUM(quantity), 0) AS n FROM po_line_receipts WHERE po_line_id = ?`)
      .get(line.id) as any).n
  ) === 2,
  'AND THE LINE STILL SAYS TWO ARRIVED — the receipt was split, not duplicated, so provenance does not double-count'
)
assertStockLotsConsistent(db)
ok(true, 'the invariant survived a split layer')

// ---------------------------------------------------------------------------
console.log('\n=== 5. what is refused, and what stays refused ===')
// ---------------------------------------------------------------------------
const tooMany = inv.moveStock({ productId: 'p_pend', from: SHOP, to: 'RM', quantity: 9 }, null)
ok(!!tooMany.error, 'moving more than the shelf holds is refused', String(tooMany.error))
ok(qtyAt('p_pend', SHOP) === 1, 'and nothing moved — the refusal rolled the whole thing back')

const nowhere = inv.moveStock({ productId: 'p_pend', from: SHOP, to: SHOP, quantity: 1 }, null)
ok(!!nowhere.error, 'a move to the same shelf is refused')

const ghost = inv.moveStock({ productId: 'p_nope', from: SHOP, to: 'RM', quantity: 1 }, null)
ok(!!ghost.error, 'and so is a product that is not in the catalog')

/**
 * THE PURCHASE-ORDER ROUTE STAYS SHUT, and that is the point of this move
 * existing. A tab line is checked in the moment it is typed, so re-routing it
 * would be telling a receiving desk to expect a delivery that already happened.
 */
const reroute = po.setPurchaseOrderRouting(
  tab.id,
  { lines: [{ lineId: line.id, destination: 'RM' }] },
  null
)
ok(
  !!reroute.error && /checked in/.test(String(reroute.error)),
  'RE-ROUTING THE TAB IS STILL REFUSED, naming the units already on a shelf — the move is the answer, not this',
  String(reroute.error)
)

// ---------------------------------------------------------------------------
console.log('\n=== 6. a partly-sold layer moves what is LEFT, and says so ===')
// ---------------------------------------------------------------------------
/**
 * Five bought at the shop, two sold there, three driven home. The layer left
 * behind must read "2 received, 0 remaining" — true — rather than "5 received,
 * 0 remaining", which would say five were sold here and would tell
 * `setPurchaseOrderLinePrice` the line had been drawn down when it had not.
 */
product('p_part', 'SKU-PT', 'Marlow Partial Case')
inv.addStock('p_part', SHOP, 5, 200, 'a case of five', null)
inv.recordSale('p_part', SHOP, 2, 350, 'Buyer', 'two sold at the shop', null)
const part = inv.moveStock({ productId: 'p_part', from: SHOP, to: 'AM', quantity: 3 }, null)
ok(!part.error, 'the remaining three are moved', String(part.error))
ok(qtyAt('p_part', SHOP) === 0 && qtyAt('p_part', 'AM') === 3, 'the shop is empty and AM holds three')
const left = lotsAt('p_part', SHOP)[0]
ok(
  Number(left.qty_received) === 2 && Number(left.qty_remaining) === 0,
  'THE LAYER LEFT BEHIND SAYS TWO WERE RECEIVED AND SOLD HERE — not five, which would read as five sold',
  `${left.qty_received}/${left.qty_remaining}`
)
const landed = lotsAt('p_part', 'AM')[0]
ok(
  Number(landed.qty_received) === 3 && eq(Number(landed.unit_cost), 200),
  'and the three that travelled arrived at their own $200',
  `${landed.qty_received} @ ${landed.unit_cost}`
)
assertStockLotsConsistent(db)
ok(true, 'and the invariant holds over a partly-sold split')

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
