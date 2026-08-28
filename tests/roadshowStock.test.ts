/**
 * A ROADSHOW TAB IS INVENTORY YOU OWN AND ARE NOT STANDING NEXT TO.
 *
 * The owner, on what the whole thing is for: "for the four roadshow shops ... I
 * create a PO and throughout the week I add what I am buying from them, and then
 * when I create sales orders I can pull inventory from both places, the POs from
 * the roadshow shops or the RM inventory. Say I have 4 of product A in RM but I
 * need 7 — I can add 3 to roadshow and pull from there. Roadshow is inventory
 * that I don't have but it is mine and I can pull from it."
 *
 * ## The bug this replaces, and why nothing worked before
 *
 * Tabs were being raised against MULTI_SHIPMENT — the sentinel for "a dropship
 * to several buyers nobody has named yet", which is DEFINED as holding no stock.
 * Every unit put on such a tab was unreceivable by design: no cost layer,
 * nothing on any shelf, and therefore nothing any sales order could ever draw.
 * A week of buying produced a bill and no inventory.
 *
 * ## The model that replaces it
 *
 * A tab's goods sit at the SHOP, and the shop is the SUPPLIER — the four shops
 * are already suppliers here, so deriving the place from the supplier means the
 * two can never drift and nothing has to be seeded by hand. A roadshow shop is
 * then an ordinary stock location that happens not to be this building, and
 * every existing mechanism works unchanged: receiving opens real FIFO layers,
 * supplyingOrders finds them, a sale consumes them at their real cost.
 *
 * THAT IS THE POINT WORTH BEING CAREFUL ABOUT: roadshow goods are NOT a dropship
 * in this app's accounting sense. A dropship has no stock and no cost of goods.
 * These were bought. They have both. What is "direct" about them is only the
 * shipping.
 *
 * What is pinned here:
 *
 *   1. Opening a tab registers its shop as a place stock can sit, and points the
 *      order there instead of at Multi-shipment.
 *   2. The same shop twice is ONE place, not two holding half the stock each.
 *   3. Receiving a tab line puts real, costed stock at the shop.
 *   4. THE 4 + 3 = 7 CASE: a sale can draw from RM and from the tab, and the
 *      cost comes from the layers each one actually consumed.
 *   5. A closed tab's routing is frozen — "once we close out a tab it is done".
 *
 * Every name here is invented.
 *
 * Run: npm run test:roadshow-stock
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/roadshow-stock-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const database = require('../src/main/db/database')
const poRepo = require('../src/main/db/purchaseOrders')
const invoices = require('../src/main/db/invoices')
const invStock = require('../src/main/db/inventory')
const provenance = require('../src/main/db/provenance')
const { destinationHoldsStock } = require('../src/shared/purchaseOrders')
const { isLocation } = require('../src/shared/inventory')
const { MULTI_SHIPMENT } = require('../src/shared/multiShipment')
const { tabLocation, tabRoutingLocked } = require('../src/shared/roadshowTab')

const db = database.getDb()

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

const SHOP = 'Roadshow Wichita'
db.prepare(
  `INSERT INTO inventory_products (id, sku, name, category, unit_cost, created_at, updated_at)
   VALUES ('p_r', 'SKU-R', 'Roadshow Hobby Box', 'Baseball', 400,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
).run()

const qtyAt = (loc: string): number => invStock.stockQty('p_r', loc)

console.log('\n=== 1. the shop becomes a place stock can sit ===')
// ---------------------------------------------------------------------------
{
  ok(
    !isLocation(SHOP),
    'the shop is not a stock location to begin with — nothing was seeded by hand'
  )
  ok(
    destinationHoldsStock(MULTI_SHIPMENT) === false,
    'AND MULTI-SHIPMENT HOLDS NO STOCK — which is why a tab raised against it could never be sold from, and is the whole defect being fixed'
  )

  const tab = poRepo.createPurchaseOrder(
    {
      supplier: SHOP,
      // Deliberately typed as the OLD, broken answer. Opening a tab has to
      // override it: somebody reaching for Multi-shipment is reaching for the
      // thing that used to be the only option.
      location: MULTI_SHIPMENT,
      ongoing: true,
      lines: [{ productId: 'p_r', quantity: 3, unitPrice: 400 }]
    },
    null
  )
  ok(
    isLocation(SHOP),
    'OPENING A TAB REGISTERS ITS SHOP AS A PLACE — no four names to seed before the feature works',
    String(isLocation(SHOP))
  )
  ok(
    destinationHoldsStock(SHOP) === true,
    'AND THAT PLACE HOLDS STOCK, which is the one property Multi-shipment deliberately lacks'
  )
  const stored = poRepo.getPurchaseOrder(tab.id)
  ok(
    stored.location === SHOP,
    'THE TAB POINTS AT THE SHOP, not at the Multi-shipment that was typed',
    String(stored.location)
  )

  // --- the same shop twice is one place ----------------------------------
  /**
   * The location id is written onto every stock row and every FIFO layer as a
   * plain string, so two spellings would be two shelves holding half the stock
   * each — and the second week's tab must not rename the first week's shelf out
   * from under the stock sitting on it.
   */
  const second = poRepo.createPurchaseOrder(
    {
      supplier: 'roadshow wichita',
      location: MULTI_SHIPMENT,
      ongoing: true,
      lines: [{ productId: 'p_r', quantity: 1, unitPrice: 400 }]
    },
    null
  )
  const places = db
    .prepare(`SELECT COUNT(*) AS n FROM stock_locations WHERE LOWER(id) = LOWER(?)`)
    .get(SHOP) as { n: number }
  ok(
    places.n === 1,
    'THE SAME SHOP TWICE IS ONE PLACE — case-insensitively, or the week would be split across two shelves',
    String(places.n)
  )
  ok(
    poRepo.getPurchaseOrder(second.id).location === SHOP,
    'AND THE EXISTING SPELLING WINS, so no stock row is dragged through a rename',
    String(poRepo.getPurchaseOrder(second.id).location)
  )
  /**
   * A TAB IS CANCELLED, NOT DELETED — a consequence of checking cases in as
   * they are typed, and the right one.
   *
   * Delete has always refused an order with units already on a shelf, because
   * removing the paperwork would leave that stock with no cost record behind
   * it. A tab now always has units on a shelf, from the moment it is opened, so
   * it always takes the Cancel road — which hands the cases back properly
   * instead of orphaning them.
   */
  const cannotDelete = poRepo.deletePurchaseOrder(second.id, null)
  ok(
    !cannotDelete.ok && /checked in/i.test(cannotDelete.error ?? ''),
    'DELETING A TAB WITH CASES ON IT IS REFUSED — the stock would be left with no cost record',
    String(cannotDelete.error)
  )
  poRepo.setPurchaseOrderStatus(second.id, 'cancelled', null)
  ok(
    qtyAt(SHOP) === 3,
    'AND CANCELLING HANDS THE CASE BACK — the shelf is left exactly as the mistake found it',
    String(qtyAt(SHOP))
  )

  /**
   * BUT AN EXPLICIT RM IS LEFT ALONE, and that is the owner's own rule: "unless
   * the destination is RM, then it is the RM inventory and the whole thing
   * flows." A tab whose cases are coming straight home is an ordinary week of
   * buying, and redirecting it to the shop would take away the one choice he
   * asked to keep. Only a destination that HOLDS NO STOCK is overridden,
   * because only that one makes the goods unsellable.
   */
  const homeward = poRepo.createPurchaseOrder(
    {
      supplier: SHOP,
      location: 'RM',
      ongoing: true,
      lines: [{ productId: 'p_r', quantity: 1, unitPrice: 400 }]
    },
    null
  )
  ok(
    poRepo.getPurchaseOrder(homeward.id).location === 'RM',
    'A TAB EXPLICITLY POINTED AT RM STAYS POINTED AT RM — coming straight home is a real answer, not a mistake to correct',
    String(poRepo.getPurchaseOrder(homeward.id).location)
  )
  ok(
    isLocation(SHOP),
    'and the shop is registered as a place anyway, so the next case that stays there has somewhere to go'
  )
  /**
   * AND IT IS NOT TAKEN IN, which is the other half of takeTabDelivery.
   *
   * A case bought at the shop and LEFT there is in hand the instant it is typed
   * — somebody is holding it. A case bought at the shop and sent HOME is on a
   * lorry, and it arrives on Thursday. Checking that one in now would put a box
   * on our shelf that nobody can find, so the split is by destination and the
   * homeward case waits for the ordinary Receive press like anything else.
   */
  ok(
    qtyAt('RM') === 0,
    'A TAB CASE POINTED HOME IS NOT TAKEN IN — it is on a lorry, and the gap between ordering and arriving is real for that one',
    String(qtyAt('RM'))
  )
  ok(
    poRepo.getPurchaseOrder(homeward.id).receivedUnits === 0,
    'so its receipt still says nothing has arrived',
    String(poRepo.getPurchaseOrder(homeward.id).receivedUnits)
  )
  // Nothing was checked in, so this one CAN still be deleted outright.
  ok(
    poRepo.deletePurchaseOrder(homeward.id, null).ok,
    'and with nothing on a shelf it can be deleted rather than cancelled'
  )

  // --- an ordinary order is untouched -------------------------------------
  const plain = poRepo.createPurchaseOrder(
    {
      supplier: 'Ordinary Distributors',
      location: 'RM',
      lines: [{ productId: 'p_r', quantity: 2, unitPrice: 400 }]
    },
    null
  )
  ok(
    poRepo.getPurchaseOrder(plain.id).location === 'RM',
    'AN ORDINARY PURCHASE ORDER IS UNTOUCHED — only the Roadshow tick redirects a destination'
  )
  ok(
    !isLocation('Ordinary Distributors'),
    'and an ordinary supplier does NOT become a shelf — every distributor in the book would otherwise turn into one'
  )

  /**
   * AND WITHOUT THE TICK, NOTHING IS TAKEN IN — even when it is bound for a shop.
   *
   * The narrowest and most missable case: an ordinary purchase from a
   * distributor who is shipping the cases straight to a roadshow shop. The
   * destination is a shelf of ours and the goods are still on a lorry, so this
   * is an ordinary order with an ordinary week-long gap, and the Roadshow tick
   * is the ONLY thing that says otherwise.
   *
   * Pinned because it is the exact difference a careless reading of
   * takeTabDelivery would erase: hang it off the destination rather than off
   * the tick and every distributor's shipment books itself onto a shelf the day
   * it is ordered.
   */
  const shippedToShop = poRepo.createPurchaseOrder(
    {
      supplier: 'Ordinary Distributors',
      location: SHOP,
      lines: [{ productId: 'p_r', quantity: 5, unitPrice: 400 }]
    },
    null
  )
  ok(
    poRepo.getPurchaseOrder(shippedToShop.id).receivedUnits === 0,
    'AN ORDINARY ORDER BOUND FOR THE SHOP TAKES IN NOTHING — the tick is what says the goods are already in hand, not the destination',
    String(poRepo.getPurchaseOrder(shippedToShop.id).receivedUnits)
  )
  ok(
    qtyAt(SHOP) === 3,
    'so the shop still holds only what the tab put there',
    String(qtyAt(SHOP))
  )
  poRepo.deletePurchaseOrder(shippedToShop.id, null)

  console.log('\n=== 2. putting a case on a tab IS taking delivery of it ===')
  // -------------------------------------------------------------------------
  /**
   * NOBODY PRESSES RECEIVE ON A TAB. The owner, on the step this removes:
   * "anything being added to these roadshow check-marked ones doesn't come to
   * us ... we just need to touch it and then basically it gets added and can
   * just make the sales order."
   *
   * An ordinary purchase order has two events because they happen on two days:
   * order Monday, open boxes Thursday, and the week between is real. A tab has
   * one — somebody is standing in the shop holding the case. Asking them to then
   * confirm it arrived is asking about something that was never in doubt, and
   * the cost of forgetting was total: no stock, no cost layers, and a sales
   * order that could draw nothing.
   */
  ok(
    qtyAt(SHOP) === 3,
    'THE CASES ARE AT THE SHOP THE MOMENT THE TAB IS OPENED — no second press, because there was no second event',
    String(qtyAt(SHOP))
  )
  /**
   * AND PRESSING RECEIVE AFTERWARDS ADDS NOTHING. The button still exists for
   * an ordinary order; on a tab it now has nothing left to do, and the thing
   * that must not happen is it booking a second copy of the same case.
   */
  const tabLine = poRepo.getPurchaseOrder(tab.id).lines[0]
  const already = poRepo.receivePurchaseOrderLines(tab.id, [{ lineId: tabLine.id, quantity: 3 }], null)
  ok(
    !!already.error && /already fully received/i.test(already.error ?? ''),
    'RECEIVING IT A SECOND TIME IS REFUSED BY NAME — one case bought is one case on the shelf',
    String(already.error)
  )
  ok(
    qtyAt(SHOP) === 3,
    'and the shop still holds exactly three, not six',
    String(qtyAt(SHOP))
  )
  const layers = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(l.qty_remaining), 0) AS q
         FROM inventory_lots l JOIN po_line_receipts r ON r.lot_id = l.id
        WHERE r.po_id = ? AND l.location = ?`
    )
    .get(tab.id, SHOP) as { n: number; q: number }
  ok(
    layers.n > 0 && layers.q === 3,
    'WITH REAL COST LAYERS BEHIND THEM — this is what makes it stock rather than a promise, and what gives the sale a cost of goods',
    `${layers.n} layers, ${layers.q} units`
  )
  /**
   * AND THE TAB IS STILL OPEN. An ordinary purchase order closes itself the
   * moment its last unit lands; a tab must not, or Wednesday's box would have
   * nowhere to go. This matters more now that checking in happens by itself: a
   * tab that closed the instant its first case was typed would be the original
   * bug arriving by a different road.
   */
  ok(
    poRepo.getPurchaseOrder(tab.id).status === 'ordered',
    'AND THE TAB IS STILL OPEN — taking the cases in does not end the week',
    String(poRepo.getPurchaseOrder(tab.id).status)
  )

  ok(
    provenance.supplyingOrders('p_r', SHOP).some((o: any) => o.poId === tab.id),
    'AND THE SALES-ORDER PICKER CAN NOW SEE IT — the read that was returning nothing for a tab'
  )

  console.log('\n=== 3. four in RM, three at the shop, seven sold ===')
  // -------------------------------------------------------------------------
  /**
   * THE CASE THE OWNER LED WITH, end to end: "say I have 4 of product A in RM
   * but I need 7 — I can add 3 to roadshow and pull from there."
   */
  invStock.addStock('p_r', 'RM', 4, 250, 'four on our own shelf', null, null)
  ok(qtyAt('RM') === 4 && qtyAt(SHOP) === 3, 'four here, three at the shop')

  const sale = invoices.saveInvoice(
    {
      customerName: 'Seven Case Buyer',
      invoiceNumber: 'SO-R100',
      invoiceDate: '2026-08-27',
      location: 'RM',
      lines: [{ item: 'Roadshow Hobby Box', productId: 'p_r', quantity: 7, rate: 900 }]
    },
    null
  )
  db.prepare(`UPDATE invoices SET status = 'sent', qbo_id = 'qbo-r100' WHERE id = ?`).run(sale.id)
  const lineId = invoices.getInvoice(sale.id).lines[0].id
  const routed = invoices.setInvoiceLineRouting(
    sale.id,
    [
      {
        lineId,
        destination: 'RM',
        supplier: null,
        allocations: [
          { quantity: 4, destination: 'RM', sourcePoId: null },
          { quantity: 3, destination: SHOP, sourcePoId: tab.id }
        ]
      }
    ],
    null
  )
  ok(!routed.error, 'A SALE MAY DRAW FROM BOTH PLACES AT ONCE', String(routed.error))
  ok(
    qtyAt('RM') === 0 && qtyAt(SHOP) === 0,
    'AND BOTH SHELVES GAVE UP THEIR CASES — four from ours, three from the shop',
    `RM ${qtyAt('RM')} / ${SHOP} ${qtyAt(SHOP)}`
  )
  /**
   * THE COST IS REAL, AND IT IS THE TWO DIFFERENT COSTS.
   *
   * Four at 250 off our shelf plus three at 400 from the shop is 2,200. A
   * dropship would have contributed nothing — which is exactly the wrong answer
   * for goods that were bought, and the reason this is modelled as stock rather
   * than as a dropship.
   */
  const cost = db
    .prepare(`SELECT COALESCE(SUM(cost_total), 0) AS c FROM invoice_stock_moves WHERE invoice_id = ?`)
    .get(sale.id) as { c: number }
  ok(
    Math.round(cost.c) === 2200,
    'AND THE COST OF GOODS IS 4 × $250 PLUS 3 × $400 — the roadshow cases carry their real cost, which a dropship never would',
    String(cost.c)
  )

  console.log('\n=== 4. a closed tab is settled, and stops moving ===')
  // -------------------------------------------------------------------------
  ok(
    !tabRoutingLocked({ tabOpenedAt: '2026-08-01T00:00:00.000Z', tabClosedAt: null }),
    'an OPEN tab may still be re-routed — that is the week being traded'
  )
  ok(
    tabRoutingLocked({ tabOpenedAt: '2026-08-01T00:00:00.000Z', tabClosedAt: '2026-08-07T00:00:00.000Z' }),
    'A CLOSED ONE MAY NOT — "once we close out a tab it is done, you cannot change where things are going"'
  )
  ok(
    !tabRoutingLocked({ tabOpenedAt: null, tabClosedAt: null }),
    'and an ordinary purchase order is not a tab, so this rule says nothing about it'
  )

  /**
   * ON ITS OWN TAB, with nothing checked in yet.
   *
   * A case that has ALREADY been checked in at the shop cannot be re-routed —
   * the existing per-line guard refuses it by name, and rightly: the box is
   * physically at the shop, so saying it is going to RM would be a claim about
   * the world rather than about the order. Bringing it home afterwards is a
   * stock move, not a routing edit. So the freeze being tested here is the one
   * that applies to cases still to come, which is the state a running week is
   * mostly in.
   */
  const freshTab = poRepo.createPurchaseOrder(
    {
      supplier: SHOP,
      location: 'RM',
      ongoing: true,
      lines: [{ productId: 'p_r', quantity: 2, unitPrice: 400 }]
    },
    null
  )
  const line = poRepo.getPurchaseOrder(freshTab.id).lines[0]
  ok(
    !poRepo.setPurchaseOrderRouting(freshTab.id, { lines: [{ lineId: line.id, destination: 'RM' }] })
      .error,
    'WHILE IT IS OPEN, A CASE STILL TO COME CAN BE TOLD TO COME HOME TO RM INSTEAD'
  )
  ok(
    poRepo.getPurchaseOrder(freshTab.id).lines[0].destination === 'RM',
    'and the line says so — this is the per-case routing the owner asked for',
    String(poRepo.getPurchaseOrder(freshTab.id).lines[0].destination)
  )
  db.prepare(`UPDATE purchase_orders SET tab_closed_at = ? WHERE id = ?`).run(
    '2026-08-30T00:00:00.000Z',
    freshTab.id
  )
  const frozen = poRepo.setPurchaseOrderRouting(freshTab.id, {
    lines: [{ lineId: line.id, destination: SHOP }]
  })
  ok(
    !!frozen.error && /closed out/i.test(frozen.error ?? ''),
    'AND ONCE CLOSED THE SAME CHANGE IS REFUSED, by name',
    String(frozen.error)
  )
  /**
   * A SEPARATE GUARD FROM THE `received` ONE, and it has to be: a tab spends its
   * whole life in `ordered` — that is the point of it — so the status check
   * cannot see a closed tab at all. Pinned by checking the status really is
   * still `ordered` while the refusal fires.
   */
  ok(
    poRepo.getPurchaseOrder(freshTab.id).status === 'ordered',
    'AND THE STATUS CHECK COULD NEVER HAVE CAUGHT IT — a tab is in `ordered` all its life, which is why the freeze is its own rule',
    String(poRepo.getPurchaseOrder(freshTab.id).status)
  )
}

console.log('\n=== 5. how many we have, and where ===')
// ---------------------------------------------------------------------------
/**
 * THE QUESTION THE OWNER LED WITH, as a rule rather than as a screen: "say I
 * have 4 of product A in RM but I need 7 ... when putting quantities of things I
 * need the RM inventory + roadshow open tabs."
 *
 * The sales-order line editor showed nothing at all — not a count, not a place,
 * not a warning — so the answer was found out later, when the shelf came up
 * short and the order sat in Awaiting items with nothing on it to say why.
 */
{
  const avail = require('../src/main/db/inventory').productAvailability
  const {
    availabilityNote,
    placesWorthNaming,
    unitsAway,
    unitsHere,
    unitsOwned
  } = require('../src/shared/availability')

  invStock.addStock('p_r', 'RM', 4, 250, 'four here', null, null)
  const shopTab = poRepo.createPurchaseOrder(
    {
      supplier: SHOP,
      ongoing: true,
      lines: [{ productId: 'p_r', quantity: 3, unitPrice: 400 }]
    },
    null
  )
  // No receive press: opening the tab took the cases in. See takeTabDelivery.

  const a = avail('p_r')
  ok(unitsHere(a) === 4, 'FOUR ON OUR OWN SHELVES', String(unitsHere(a)))
  ok(unitsAway(a) === 3, 'AND THREE AT THE SHOP — ours, and not in this building', String(unitsAway(a)))
  ok(unitsOwned(a) === 7, 'SEVEN OWNED IN TOTAL, which is the number that answers the question')
  /**
   * HOME SHELVES LEAD. Somebody reading this is deciding where boxes come from,
   * and the answer is nearly always the shelf downstairs — putting a shop first
   * because it happens to hold more would bury the ordinary case.
   */
  const places = placesWorthNaming(a)
  ok(places[0].location === 'RM' && places[0].here === true, 'our own shelf is named first')
  ok(
    places.some((p: any) => p.location === SHOP && p.here === false),
    'and the shop is named as somewhere else',
    JSON.stringify(places)
  )
  ok(
    !places.some((p: any) => p.quantity === 0),
    'EMPTY PLACES ARE DROPPED — "0 at AM" is a row that costs a glance and answers nothing'
  )

  // --- what it tells somebody who typed a number --------------------------
  ok(
    availabilityNote(a, 4) === null,
    'ASKING FOR FOUR SAYS NOTHING AT ALL — the shelf covers it, and a note under every line would be read past within a day'
  )
  const seven = availabilityNote(a, 7)
  ok(
    seven && seven.kind === 'away' && seven.here === 4 && seven.away === 3,
    'ASKING FOR SEVEN SAYS WHERE THE OTHER THREE ARE — this is the case the whole change was built for',
    JSON.stringify(seven)
  )
  const nine = availabilityNote(a, 9)
  ok(
    nine && nine.kind === 'short' && nine.short === 2,
    'AND ASKING FOR NINE SAYS HOW MANY ARE MISSING, counting the shop before it calls anything short',
    JSON.stringify(nine)
  )
  ok(
    availabilityNote(a, 0) === null && availabilityNote(null, 5) === null,
    'a blank quantity and an unknown product both say nothing rather than guessing'
  )
  /**
   * IT NEVER REFUSES ANYTHING. Selling more than is on hand is ordinary trade —
   * the case is in transit, the count is a day old — and `applyInvoiceStock`
   * already draws what it can and leaves the rest owed. A note, not a gate.
   */
  const overSell = invoices.saveInvoice(
    {
      customerName: 'Optimistic Buyer',
      invoiceNumber: 'SO-R200',
      invoiceDate: '2026-08-27',
      location: 'RM',
      lines: [{ item: 'Roadshow Hobby Box', productId: 'p_r', quantity: 99, rate: 900 }]
    },
    null
  )
  ok(
    !!overSell.id,
    'A LINE FOR MORE THAN EXISTS IS STILL WRITTEN — the note is advice, and an app that refused it is one people work around'
  )
  inv_setVoid(overSell.id)
}

console.log('\n=== 6. close is not the same act as pay ===')
// ---------------------------------------------------------------------------
/**
 * The owner, asked whether the two should be one button: "close should
 * basically move the PO into the unpaid tab section."
 *
 * They are two different acts and only one is about money. Stopping the week
 * has to be possible BEFORE every price has been chased — otherwise Thursday's
 * box lands on a week somebody thought was finished — while paying a bill
 * nobody can total stays refused, which is the guard the whole unknown-price
 * feature rests on.
 */
{
  const unpriced = poRepo.createPurchaseOrder(
    {
      supplier: SHOP,
      ongoing: true,
      lines: [{ productId: 'p_r', quantity: 2, unitPrice: 400 }]
    },
    null
  )
  const line = poRepo.getPurchaseOrder(unpriced.id).lines[0]
  poRepo.setPurchaseOrderLinePrice(unpriced.id, line.id, null, null)
  ok(
    poRepo.getPurchaseOrder(unpriced.id).lines[0].pricePending === true,
    'a case is on the tab at a price nobody knows yet'
  )

  const settle = poRepo.settleRoadshowTab(unpriced.id, null)
  ok(
    !!settle.error && /no price/i.test(settle.error ?? ''),
    'PAYING IS STILL REFUSED WHILE A PRICE IS MISSING — a total nobody can work out is not a bill anybody can pay',
    String(settle.error)
  )
  const closed = poRepo.closeRoadshowTab(unpriced.id, null)
  ok(
    !closed.error,
    'BUT CLOSING IS NOT — "we have stopped buying" is a fact about the shop, not about the bill',
    String(closed.error)
  )
  const after = poRepo.getPurchaseOrder(unpriced.id)
  ok(!!after.tabClosedAt, 'the tab is closed')
  ok(
    !after.paidAt,
    'AND THE BILL IS STILL UNPAID — closing moves it into the unpaid section, it does not settle it',
    String(after.paidAt)
  )
  ok(
    !!poRepo.closeRoadshowTab(unpriced.id, null).error,
    'closing a second time is refused rather than silently doing nothing'
  )
  /**
   * AND CLOSING IS WHAT FREEZES THE ROUTING. The two are one decision — "once
   * we close out a tab it is done, you cannot change where things are going" —
   * so the button that ends the week is the button that settles where every
   * case went.
   */
  ok(
    !!poRepo.setPurchaseOrderRouting(unpriced.id, {
      lines: [{ lineId: line.id, destination: 'RM' }]
    }).error,
    'AND THE ROUTING IS FROZEN BY THE SAME PRESS, which is what makes closing mean something'
  )
  ok(
    !!poRepo.closeRoadshowTab(
      poRepo.createPurchaseOrder(
        { supplier: 'Ordinary Distributors', location: 'RM', lines: [{ productId: 'p_r', quantity: 1, unitPrice: 1 }] },
        null
      ).id,
      null
    ).error,
    'AN ORDINARY PURCHASE ORDER CANNOT BE "CLOSED" — it is not a tab, and there is no week to end'
  )
}

console.log('\n=== 7. the card says where the box is coming from ===')
// ---------------------------------------------------------------------------
/**
 * The owner, asked whether a roadshow order should drop off the packing board
 * the way a dropship does: "SHOW IT, BUT MARKED AS SHIPPING FROM THE SHOP."
 *
 * ## The two states a card could describe, and the one it could not
 *
 *   ours and here      RM or AM. Real stock, real cost, we pack the box.
 *   theirs and direct  a dropship. No stock, no cost, somebody else ships it.
 *
 * A tab is neither: OURS, AND NOT HERE. Bought, costed, sitting in Wichita. The
 * card had no way to say that, so a roadshow order read as an ordinary dropship
 * and — worse — as one whose supplier nobody had bothered to type, because
 * there is no supplier to type.
 *
 * ## It changes no gate, deliberately
 *
 * `stock_units` counts RM and AM only, so these units are drop units to every
 * test on the fulfilment board and the order waits to be told the goods are in
 * hand, exactly as a dropship does — nothing here knows whether a shop has a
 * case on its counter. What is new is only what the card SAYS.
 *
 * ## A REGISTERED PLACE, not a name that looks like one
 *
 * The test is membership of `stock_locations`, the same question
 * `destinationHoldsStock` answers — so a destination that draws stock down is
 * exactly the one reported as away, and a supplier typed on a dropship line is
 * not. That equivalence is pinned below, because the two drifting is how a card
 * comes to call a distributor a shop of ours.
 */
{
  const { shipsFromAway, shelfShortfall } = require('../src/shared/fulfillment')

  db.prepare(
    `INSERT INTO inventory_products (id, sku, name, category, unit_cost, created_at, updated_at)
     VALUES ('p_card', 'SKU-CARD', 'Card Flag Box', 'Baseball', 400,
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run()

  /** Four here, three at the shop — the shape the whole change was built around. */
  invStock.addStock('p_card', 'RM', 4, 250, 'four here', null, null)
  const shopTab = poRepo.createPurchaseOrder(
    { supplier: SHOP, ongoing: true, lines: [{ productId: 'p_card', quantity: 3, unitPrice: 400 }] },
    null
  )
  // Three cases at the shop, taken in as the tab was opened.

  const mixed = invoices.saveInvoice(
    {
      customerName: 'Mixed Source Buyer',
      invoiceNumber: 'SO-R300',
      invoiceDate: '2026-08-27',
      location: 'RM',
      lines: [{ item: 'Card Flag Box', productId: 'p_card', quantity: 7, rate: 900 }]
    },
    null
  )
  invoices.setInvoiceLineRouting(
    mixed.id,
    [
      {
        lineId: invoices.getInvoice(mixed.id).lines[0].id,
        destination: 'RM',
        supplier: null,
        allocations: [
          { quantity: 4, destination: 'RM', sourcePoId: null },
          { quantity: 3, destination: SHOP, sourcePoId: null }
        ]
      }
    ],
    null
  )
  const m = invoices.getInvoice(mixed.id)
  ok(
    m.remoteUnits === 3,
    'THREE OF THE SEVEN ARE OURS AND NOT IN THIS BUILDING — the third number, which did not exist before tabs',
    String(m.remoteUnits)
  )
  ok(
    m.remoteFrom === SHOP && m.remotePlaceCount === 1,
    'AND THE CARD CAN NAME THE SHOP, because there is only one to name',
    `${m.remoteFrom} / ${m.remotePlaceCount}`
  )
  ok(shipsFromAway(m) === true, 'so the card says it ships from there')
  ok(
    m.stockUnits === 4 && m.dropshipUnits === 3,
    'THE GATES ARE UNCHANGED — the away units still count as drop units, so the order still waits to be told the goods are in hand',
    `${m.stockUnits} / ${m.dropshipUnits}`
  )

  /**
   * AN ORDINARY SALE SAYS NOTHING. The flag has to be silent on the case that
   * is almost every case, or it stops being read on the one that matters.
   */
  invStock.addStock('p_card', 'RM', 2, 250, 'two more here', null, null)
  const plain = invoices.saveInvoice(
    {
      customerName: 'Ordinary Buyer',
      invoiceNumber: 'SO-R301',
      invoiceDate: '2026-08-27',
      location: 'RM',
      lines: [{ item: 'Card Flag Box', productId: 'p_card', quantity: 2, rate: 900 }]
    },
    null
  )
  const p = invoices.getInvoice(plain.id)
  ok(
    p.remoteUnits === 0 && p.remoteFrom === null && p.remotePlaceCount === 0,
    'A SALE OFF OUR OWN SHELF SAYS NOTHING AT ALL — no count, no shop, no flag',
    `${p.remoteUnits} / ${p.remoteFrom} / ${p.remotePlaceCount}`
  )
  ok(shipsFromAway(p) === false, 'and the card draws no away line on it')

  /**
   * A DROPSHIP IS NOT A SHOP OF OURS. The supplier's name is a destination on
   * the line and it is not in `stock_locations`, so it must not be counted as
   * somewhere our stock is standing — which would tell a packer that goods we
   * never bought are ours and waiting in a building we cannot name.
   */
  const drop = invoices.saveInvoice(
    {
      customerName: 'Direct Buyer',
      invoiceNumber: 'SO-R302',
      invoiceDate: '2026-08-27',
      location: 'RM',
      lines: [
        {
          item: 'Card Flag Box',
          productId: 'p_card',
          quantity: 2,
          rate: 900,
          destination: 'Ordinary Distributors',
          supplier: 'Ordinary Distributors'
        }
      ]
    },
    null
  )
  const d = invoices.getInvoice(drop.id)
  ok(
    d.dropshipUnits === 2 && d.remoteUnits === 0,
    "A SUPPLIER'S NAME IS NOT ONE OF OUR SHELVES — those two units are a dropship and nothing of ours is away",
    `${d.dropshipUnits} / ${d.remoteUnits}`
  )
  ok(
    !destinationHoldsStock('Ordinary Distributors') && shipsFromAway(d) === false,
    'AND THE TWO TESTS AGREE — a destination that holds no stock is never reported as holding ours'
  )

  /**
   * TWO SHOPS ARE COUNTED, NOT NAMED. The same sole-answer-or-nothing rule
   * `dropSupplier` keeps: naming one of two would send somebody to the wrong
   * state, and a silent card would lose the fact that any of it is away.
   */
  const OTHER = 'Roadshow Dallas'
  const secondTab = poRepo.createPurchaseOrder(
    {
      supplier: OTHER,
      ongoing: true,
      lines: [{ productId: 'p_card', quantity: 2, unitPrice: 500 }]
    },
    null
  )
  const shopTab2 = poRepo.createPurchaseOrder(
    { supplier: SHOP, ongoing: true, lines: [{ productId: 'p_card', quantity: 2, unitPrice: 400 }] },
    null
  )
  const twoShops = invoices.saveInvoice(
    {
      customerName: 'Two Shop Buyer',
      invoiceNumber: 'SO-R303',
      invoiceDate: '2026-08-27',
      location: 'RM',
      lines: [{ item: 'Card Flag Box', productId: 'p_card', quantity: 4, rate: 900 }]
    },
    null
  )
  invoices.setInvoiceLineRouting(
    twoShops.id,
    [
      {
        lineId: invoices.getInvoice(twoShops.id).lines[0].id,
        destination: 'RM',
        supplier: null,
        allocations: [
          { quantity: 2, destination: SHOP, sourcePoId: null },
          { quantity: 2, destination: OTHER, sourcePoId: null }
        ]
      }
    ],
    null
  )
  const t = invoices.getInvoice(twoShops.id)
  ok(
    t.remoteUnits === 4 && t.remotePlaceCount === 2,
    'FOUR UNITS ACROSS TWO SHOPS, and the card says so',
    `${t.remoteUnits} / ${t.remotePlaceCount}`
  )
  ok(
    t.remoteFrom === null,
    'AND NEITHER IS NAMED — naming one of two would send somebody to the wrong state',
    String(t.remoteFrom)
  )

  /**
   * A SHOP'S CASES MUST NOT PAPER OVER AN EMPTY SHELF HERE.
   *
   * `shelfShortfall` subtracts what was drawn from what was asked of our own
   * shelves, so the two have to be counting the same shelves. Before this, a
   * roadshow draw counted towards the drawn side while the asked side counted
   * RM and AM alone — so an order that found two cases in Wichita reported no
   * shortfall for the two it could not find downstairs, and sat on the ready
   * pile with nothing to pack.
   */
  const shortSale = invoices.saveInvoice(
    {
      customerName: 'Short Shelf Buyer',
      invoiceNumber: 'SO-R304',
      invoiceDate: '2026-08-27',
      location: 'RM',
      lines: [{ item: 'Card Flag Box', productId: 'p_card', quantity: 5, rate: 900 }]
    },
    null
  )
  invStock.addStock('p_card', SHOP, 2, 400, 'two at the shop', null, null)
  invoices.setInvoiceLineRouting(
    shortSale.id,
    [
      {
        lineId: invoices.getInvoice(shortSale.id).lines[0].id,
        destination: 'RM',
        supplier: null,
        allocations: [
          { quantity: 3, destination: 'RM', sourcePoId: null },
          { quantity: 2, destination: SHOP, sourcePoId: null }
        ]
      }
    ],
    null
  )
  const s = invoices.getInvoice(shortSale.id)
  ok(
    invStock.stockQty('p_card', 'RM') === 0,
    'our own shelf is empty, and the order asked it for three',
    String(invStock.stockQty('p_card', 'RM'))
  )
  ok(
    s.stockUnits === 3 && s.drawnUnits === 0,
    'DRAWN COUNTS RM AND AM ONLY, to match the number it is subtracted from',
    `${s.stockUnits} asked / ${s.drawnUnits} drawn`
  )
  ok(
    shelfShortfall(s) === 3,
    'SO THE SHELF STILL OWES THREE — the two the shop gave up do not cancel out cases that are not here',
    String(shelfShortfall(s))
  )
}

console.log('\n=== 8. the whole week, exactly as somebody does it ===')
// ---------------------------------------------------------------------------
/**
 * THE TEST THAT WOULD HAVE CAUGHT THE ONE THING EVERY OTHER TEST HERE MISSED.
 *
 * Section 2 proves a tab line can be received and that the cases land at the
 * shop, and it is true, and the feature was still completely broken in the app:
 *
 *   Drop-0424 · Kentucky Roadshow
 *   "All 3 units drop-ship to Kentucky Roadshow. Nothing on this order
 *    arrives here, so it never completes on its own."
 *   0 of 3 received · sales order says "You have 0 in total — 3 short of 3"
 *
 * The receiving FUNCTION worked. The READ did not. `RECEIVABLE_UNITS_SQL` and
 * the header query are module-level template literals, so the stock-destination
 * predicate they embed was frozen at import — when the registry holds nothing
 * but RM and AM. A shop registered afterwards, which is every shop, since
 * opening the tab is what registers it, was a shelf to every function and a
 * supplier's address to every read. So the screen offered nothing to receive,
 * nothing was ever received, and the sale that was the entire point found an
 * empty shelf.
 *
 * Calling the write path directly stepped straight over the part that was
 * broken. So this section touches ONLY what the screens touch, in the order a
 * person does it, and asserts the numbers those screens actually print.
 */
{
  const KY = 'Kentucky Roadshow'
  db.prepare(
    `INSERT INTO inventory_products (id, sku, name, category, unit_cost, created_at, updated_at)
     VALUES ('p_ky', '10407-119', 'Chaos Rising Booster 6-Box Case', 'Pokemon', 0,
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run()

  // --- Monday: open the tab and put three cases on it ----------------------
  const ky = poRepo.createPurchaseOrder(
    { supplier: KY, ongoing: true, lines: [{ productId: 'p_ky', quantity: 3, unitPrice: 425 }] },
    null
  )
  const onScreen = poRepo.getPurchaseOrder(ky.id)
  ok(onScreen.location === KY, 'the tab points at the shop', String(onScreen.location))
  /**
   * THE THREE NUMBERS THE RECEIPT PRINTS, and all three were wrong.
   *
   * `orderKind` is what turns PO-0424 into "Drop-0424" through
   * displayOrderNumber, and what draws the yellow "nothing arrives here"
   * banner. `receivableUnits` is the "0 of 3". `dropshipUnits` is what the
   * banner counts. One frozen string produced all three.
   */
  ok(
    onScreen.receivableUnits === 3,
    'ALL THREE CASES ARE RECEIVABLE — this read said 0, which is why the screen offered nothing to check in',
    String(onScreen.receivableUnits)
  )
  ok(
    onScreen.dropshipUnits === 0,
    'AND NONE OF THEM IS A DROPSHIP — they are ours, bought, and standing at the shop',
    String(onScreen.dropshipUnits)
  )
  ok(
    onScreen.orderKind === 'stock',
    'SO IT IS NOT NUMBERED Drop-XXXX AND CARRIES NO "nothing arrives here" BANNER',
    String(onScreen.orderKind)
  )

  // --- and there is no Tuesday, because there is nothing to wait for -------
  /**
   * NOBODY PRESSES ANYTHING. The cases were bought over a counter and are in
   * the buyer's hands; the line IS the receipt. See takeTabDelivery.
   */
  ok(
    invStock.stockQty('p_ky', KY) === 3,
    'THE THREE CASES ARE ALREADY AT THE SHOP — typing them in was taking delivery of them',
    String(invStock.stockQty('p_ky', KY))
  )
  ok(
    poRepo.getPurchaseOrder(ky.id).receivedUnits === 3,
    'AND THE RECEIPT SAYS 3 OF 3 rather than 0 of 3',
    String(poRepo.getPurchaseOrder(ky.id).receivedUnits)
  )
  ok(
    poRepo.getPurchaseOrder(ky.id).status === 'ordered',
    'and the tab is still open for the rest of the week'
  )

  // --- straight to selling one ---------------------------------------------
  /**
   * THE SENTENCE UNDER THE SALES-ORDER LINE, which is where the owner saw this
   * fail: "You have 0 in total — 3 short of 3." Nothing was wrong with the
   * availability rule; there genuinely was no stock, because none had ever been
   * receivable. It reads the truth either way, which is exactly why it was
   * pointing at a bug three screens upstream.
   */
  const { availabilityNote, unitsOwned } = require('../src/shared/availability')
  const have = require('../src/main/db/inventory').productAvailability('p_ky')
  ok(unitsOwned(have) === 3, 'WE OWN THREE, and the sales order can see them', String(unitsOwned(have)))
  ok(
    availabilityNote(have, 3) && availabilityNote(have, 3).kind === 'away',
    'ASKING FOR THREE SAYS THEY ARE AT THE SHOP — not "3 short of 3"',
    JSON.stringify(availabilityNote(have, 3))
  )

  const kySale = invoices.saveInvoice(
    {
      customerName: 'Roadshow Case Buyer',
      invoiceNumber: 'SO-KY01',
      invoiceDate: '2026-08-27',
      location: 'RM',
      lines: [
        { item: 'Chaos Rising Booster 6-Box Case', productId: 'p_ky', quantity: 3, rate: 900, destination: KY }
      ]
    },
    null
  )
  ok(
    invStock.stockQty('p_ky', KY) === 0,
    'AND SELLING THEM DRAWS THE SHOP DOWN — the cases leave from where they are standing',
    String(invStock.stockQty('p_ky', KY))
  )
  const cogs = db
    .prepare(`SELECT COALESCE(SUM(cost_total), 0) AS c FROM invoice_stock_moves WHERE invoice_id = ?`)
    .get(kySale.id) as { c: number }
  ok(
    Math.round(cogs.c) === 1275,
    'WITH A REAL COST OF GOODS OF 3 × $425 — the thing a dropship could never have given us',
    String(cogs.c)
  )
  const sold = invoices.getInvoice(kySale.id)
  ok(
    sold.remoteUnits === 3 && sold.remoteFrom === KY,
    'and the sales order card says it ships from the shop',
    `${sold.remoteUnits} / ${sold.remoteFrom}`
  )

  // --- Thursday: buy two more against the same tab -------------------------
  /**
   * THE SENTENCE THE WHOLE FEATURE WAS ASKED FOR IN: "throughout the week I
   * just add what I am buying from them."
   *
   * This path had no test at all, which is how it went unnoticed that adding a
   * line and taking delivery of it were two acts. Each add is its own trip to
   * the counter, so each one checks in ITS OWN cases and leaves the earlier
   * ones alone — the failure to avoid is a second add re-receiving Monday's
   * three and putting six on a shelf that holds three.
   */
  const more = poRepo.addPurchaseOrderLines(
    ky.id,
    [{ productId: 'p_ky', quantity: 2, unitPrice: 450 }],
    null
  )
  ok(!more.error, 'a running tab keeps taking things all week', String(more.error))
  ok(
    invStock.stockQty('p_ky', KY) === 2,
    'THURSDAY’S TWO CASES ARE AT THE SHOP TOO, checked in by the act of typing them',
    String(invStock.stockQty('p_ky', KY))
  )
  const lines = poRepo.getPurchaseOrder(ky.id).lines
  ok(
    lines.length === 2 && lines[0].qtyReceived === 3 && lines[1].qtyReceived === 2,
    'AND MONDAY’S LINE WAS NOT RECEIVED A SECOND TIME — each add takes in only its own cases',
    JSON.stringify(lines.map((l: any) => l.qtyReceived))
  )
  ok(
    poRepo.getPurchaseOrder(ky.id).status === 'ordered' &&
      !poRepo.getPurchaseOrder(ky.id).tabClosedAt,
    'and the tab is still open, still one bill'
  )
}

console.log('\n=== 9. the four shops are a list, not something anybody types ===')
// ---------------------------------------------------------------------------
/**
 * "THE ROADSHOW LOGIC SHOULD NOT BE THIS HARD."
 *
 * It was not the model that was hard — the shops were already stock locations
 * and a tab was already an ordinary purchase order. It was the FRONT DOOR. A
 * tab's shop was whatever somebody typed into the supplier box, and that typed
 * string BECAME the shelf its stock stood on. So "KY Roadshow" one week and
 * "Kentucky Roadshow" the next were two shelves holding half the stock each,
 * with nothing on any screen saying so: the sales order simply came up short
 * and the rest was standing under a name nobody thought to look for.
 *
 * The owner's own reduction of what he wanted: "all I want is that I can put
 * products into each roadshow column and see what I have, and then create sales
 * orders using both my on-hand location and Kentucky."
 */
{
  const {
    ROADSHOW_SHOPS,
    isRoadshowShop,
    roadshowShopNamed
  } = require('../src/shared/roadshowTab')
  const { stockAtLocation } = require('../src/main/db/inventory')

  ok(ROADSHOW_SHOPS.length === 4, 'there are four shops', String(ROADSHOW_SHOPS.length))
  ok(
    ROADSHOW_SHOPS.every((shop: string) => isLocation(shop)),
    'AND ALL FOUR ARE PLACES STOCK CAN SIT, from the first time the app opens — nothing to seed by hand',
    JSON.stringify(ROADSHOW_SHOPS.filter((s: string) => !isLocation(s)))
  )
  ok(
    ROADSHOW_SHOPS.every((shop: string) => destinationHoldsStock(shop)),
    'and every one of them holds stock, so a sale routed there draws it down'
  )
  /**
   * THE SPELLING IS THE OWNER'S EXISTING ONE. "Kentucky Roadshow", state first,
   * because that is what his live data already says — and a tidier convention
   * would have meant renaming a shelf with stock standing on it.
   */
  ok(
    ROADSHOW_SHOPS.includes('Kentucky Roadshow'),
    'THE EXISTING KENTUCKY SPELLING IS THE ONE IN THE LIST — matching what exists beats matching a preference',
    JSON.stringify(ROADSHOW_SHOPS)
  )
  ok(
    isRoadshowShop('kentucky roadshow') && isRoadshowShop('  Texas Roadshow  '),
    'a shop is recognised whatever the case or the stray spaces'
  )
  ok(
    !isRoadshowShop('Ordinary Distributors') && !isRoadshowShop('') && !isRoadshowShop(null),
    'and a distributor, a blank and a null are not shops'
  )
  ok(
    roadshowShopNamed('KENTUCKY ROADSHOW') === 'Kentucky Roadshow',
    'THE LIST OWNS THE SPELLING — which is what stops a second shelf opening beside the first',
    String(roadshowShopNamed('KENTUCKY ROADSHOW'))
  )
  ok(roadshowShopNamed('Nowhere Roadshow') === null, 'and a name off the list resolves to nothing')

  /**
   * SEEDING TWICE DOES NOT MAKE EIGHT SHOPS. The seed runs on every open, so
   * this is the property that matters most: a database running for months and
   * one opened for the first time have to end up identical.
   */
  const before = db
    .prepare(`SELECT COUNT(*) AS n FROM stock_locations WHERE LOWER(id) = LOWER(?)`)
    .get('Kentucky Roadshow') as { n: number }
  ok(before.n === 1, 'each shop is registered exactly once', String(before.n))

  // --- what is on a shop's shelf ------------------------------------------
  /**
   * The board's whole read. It goes to the SHELF and not to the tab, and the
   * difference shows the moment anything sells: a case sold out of Kentucky is
   * still a line on the tab for ever.
   */
  db.prepare(
    `INSERT INTO inventory_products (id, sku, name, category, unit_cost, created_at, updated_at)
     VALUES ('p_col', 'SKU-COL', 'Column Board Case', 'Pokemon', 0,
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run()
  const KY = 'Kentucky Roadshow'
  /**
   * FILTERED TO THIS PRODUCT, because the shelf is not a fixture — section 8
   * left two cases of its own in Kentucky, and that is the realistic state: a
   * shop holds whatever the week has put there. A test that demanded an empty
   * shelf would be testing the fixture rather than the read.
   */
  const onShelf = (loc: string, productId: string): number =>
    stockAtLocation(loc).find((r: any) => r.productId === productId)?.quantity ?? 0
  ok(onShelf(KY, 'p_col') === 0, 'the column does not list a product nobody has bought yet')

  const kyTab = poRepo.createPurchaseOrder(
    { supplier: KY, ongoing: true, lines: [{ productId: 'p_col', quantity: 5, unitPrice: 300 }] },
    null
  )
  ok(
    onShelf(KY, 'p_col') === 5,
    'BUYING FIVE PUTS FIVE IN THE COLUMN — one press, no supplier typed, no destination chosen',
    String(onShelf(KY, 'p_col'))
  )
  ok(
    stockAtLocation(KY).some((r: any) => r.name === 'Column Board Case'),
    'and the column names the product, which is the whole ask — "just what products I have"'
  )
  ok(
    poRepo.getPurchaseOrder(kyTab.id).location === KY,
    'and the tab points at the shop without anybody saying so',
    String(poRepo.getPurchaseOrder(kyTab.id).location)
  )

  // --- selling from RM and the shop together -------------------------------
  invStock.addStock('p_col', 'RM', 2, 250, 'two here', null, null)
  const bothSale = invoices.saveInvoice(
    {
      customerName: 'Both Places Buyer',
      invoiceNumber: 'SO-COL1',
      invoiceDate: '2026-08-27',
      location: 'RM',
      lines: [{ item: 'Column Board Case', productId: 'p_col', quantity: 6, rate: 900 }]
    },
    null
  )
  invoices.setInvoiceLineRouting(
    bothSale.id,
    [
      {
        lineId: invoices.getInvoice(bothSale.id).lines[0].id,
        destination: 'RM',
        supplier: null,
        allocations: [
          { quantity: 2, destination: 'RM', sourcePoId: null },
          { quantity: 4, destination: KY, sourcePoId: null }
        ]
      }
    ],
    null
  )
  ok(
    invStock.stockQty('p_col', 'RM') === 0 && invStock.stockQty('p_col', KY) === 1,
    'A SALE DRAWS FROM BOTH — two off our own shelf and four out of Kentucky',
    `RM ${invStock.stockQty('p_col', 'RM')} / KY ${invStock.stockQty('p_col', KY)}`
  )
  /**
   * AND THE COLUMN FOLLOWS THE SHELF DOWN. This is why the board reads
   * inventory_stock rather than the tab's lines: the tab still says five,
   * because five is what was bought, and one is what is actually there to sell.
   */
  ok(
    onShelf(KY, 'p_col') === 1,
    'THE COLUMN SAYS ONE, not the five still written on the tab — the board and the sale read the same table',
    String(onShelf(KY, 'p_col'))
  )
  ok(
    poRepo.getPurchaseOrder(kyTab.id).lines[0].quantity === 5,
    'while the tab still owes the shop for all five, which is what settling up is about',
    String(poRepo.getPurchaseOrder(kyTab.id).lines[0].quantity)
  )
  /**
   * A SHOP NOBODY HAS BOUGHT AT IS EMPTY, not a list of zeroes for every product
   * in the catalog. The column has to be readable at a glance, and thirty zeroes
   * hide the four things actually standing there.
   */
  ok(
    stockAtLocation('New York Roadshow').length === 0,
    'A SHOP WITH NOTHING AT IT LISTS NOTHING',
    JSON.stringify(stockAtLocation('New York Roadshow'))
  )
  /**
   * AND A PRODUCT THAT RAN OUT DROPS OFF, which is the harder half.
   *
   * A shop nobody has bought at has no stock row at all, so it lists nothing
   * whatever the query says. The case that actually needs the filter is a
   * product that WAS there and sold out: the row stays behind at zero, and a
   * column listing it would grow a line for every product the shop ever held
   * until the four things actually standing there were unfindable.
   */
  invStock.bumpStock('p_col', KY, -1)
  ok(
    invStock.stockQty('p_col', KY) === 0,
    'the last case leaves the shop',
    String(invStock.stockQty('p_col', KY))
  )
  ok(
    !stockAtLocation(KY).some((r: any) => r.productId === 'p_col'),
    'AND THE COLUMN STOPS LISTING IT — a sold-out product is not something to look at',
    JSON.stringify(stockAtLocation(KY))
  )
}

console.log('\n=== 10. selling at a shop buys what the shop is short of ===')
// ---------------------------------------------------------------------------
/**
 * "IF I PUT PRODUCT A AS LOCATION TO ONE OF THE ROADSHOWS IT ADDS IT TO THE
 * ROADSHOW SHOP, AND THEN LATER WE CAN JUST EDIT THE PRICE."
 *
 * Somebody is at a counter in Kentucky. They buy a case and sell it to a buyer
 * in the same five minutes. That was two jobs in two places, and doing them in
 * the natural order — sale first — left the line short and the order sitting in
 * Awaiting items with nothing explaining why.
 *
 * ## THE MONEY BUG THIS SITS ON TOP OF, which had to be fixed first
 *
 * A case bought at an unknown price opens a cost layer of ZERO. Sell it before
 * the invoice turns up and the sale books a cost of goods of nothing — and
 * `setPurchaseOrderLinePrice` then REFUSED to correct it, because stock had
 * already gone out. So the zero was permanent and the app's own advice was a
 * stock adjustment, which never touches a sale's cost of goods.
 *
 * That was already live before this feature and would have made it a money bug
 * rather than a convenience: its whole premise is buying at a price nobody knows
 * and selling immediately. Both halves are pinned below.
 */
{
  const KY = 'Kentucky Roadshow'
  db.prepare(
    `INSERT INTO inventory_products (id, sku, name, category, unit_cost, created_at, updated_at)
     VALUES ('p_buy', 'SKU-BUY', 'Counter Sale Case', 'Pokemon', 0,
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run()
  const cogsOf = (invoiceId: string): number =>
    (
      db
        .prepare(`SELECT COALESCE(SUM(cost_total), 0) AS c FROM invoice_stock_moves WHERE invoice_id = ?`)
        .get(invoiceId) as { c: number }
    ).c

  // --- a price nobody knows survives being the FIRST line of a tab ---------
  /**
   * This was dropped on the floor. `addPurchaseOrderLines` honoured
   * pricePending and creation did not, so the first case of a week recorded as
   * priced at zero rather than as unpriced — and a tab that believes itself
   * fully priced can be settled with a case's cost missing from the bill.
   */
  const pendingTab = poRepo.createPurchaseOrder(
    {
      supplier: KY,
      ongoing: true,
      lines: [{ productId: 'p_buy', quantity: 1, unitPrice: 0, pricePending: true }]
    },
    null
  )
  ok(
    poRepo.getPurchaseOrder(pendingTab.id).lines[0].pricePending === true,
    'THE FIRST CASE OF A WEEK CAN BE UNPRICED — creation used to drop the flag and call it $0',
    String(poRepo.getPurchaseOrder(pendingTab.id).lines[0].pricePending)
  )
  ok(
    !!poRepo.settleRoadshowTab(pendingTab.id, null).error,
    'AND THE TAB REFUSES TO BE PAID while that price is missing, which it could not do before'
  )

  // --- sold before it was priced, then priced ------------------------------
  const early = invoices.saveInvoice(
    {
      customerName: 'Counter Buyer',
      invoiceNumber: 'SO-CTR1',
      invoiceDate: '2026-08-27',
      location: 'RM',
      lines: [{ item: 'Counter Sale Case', productId: 'p_buy', quantity: 1, rate: 900, destination: KY }]
    },
    null
  )
  ok(cogsOf(early.id) === 0, 'sold before anybody priced it, the sale books nothing', String(cogsOf(early.id)))
  const priced = poRepo.setPurchaseOrderLinePrice(
    pendingTab.id,
    poRepo.getPurchaseOrder(pendingTab.id).lines[0].id,
    400,
    null
  )
  ok(
    !priced.error,
    'PRICING IT AFTERWARDS IS ACCEPTED — refusing was the bug, and the case it broke is the ordinary one',
    String(priced.error)
  )
  ok(
    Math.round(cogsOf(early.id)) === 400,
    'AND THE SALE IS RE-COSTED TO $400 — a placeholder filled in, not a month rewritten',
    String(cogsOf(early.id))
  )
  const ledger = db
    .prepare(
      `SELECT COALESCE(SUM(t.cost_basis), 0) AS c
         FROM inventory_transactions t WHERE t.product_id = 'p_buy' AND t.type = 'sale'`
    )
    .get() as { c: number }
  ok(
    Math.round(ledger.c) === 400,
    'and the ledger row the P&L reads agrees with it — all three copies move together',
    String(ledger.c)
  )
  /**
   * A LINE THAT CARRIED A REAL PRICE IS STILL PROTECTED. That is the boundary
   * the whole change rests on: a stated figure that has been sold against is
   * history, and moving it would restate a closed month.
   */
  const realPrice = poRepo.createPurchaseOrder(
    { supplier: KY, ongoing: true, lines: [{ productId: 'p_buy', quantity: 1, unitPrice: 300 }] },
    null
  )
  invoices.saveInvoice(
    {
      customerName: 'Second Buyer',
      invoiceNumber: 'SO-CTR2',
      invoiceDate: '2026-08-27',
      location: 'RM',
      lines: [{ item: 'Counter Sale Case', productId: 'p_buy', quantity: 1, rate: 900, destination: KY }]
    },
    null
  )
  const refused = poRepo.setPurchaseOrderLinePrice(
    realPrice.id,
    poRepo.getPurchaseOrder(realPrice.id).lines[0].id,
    350,
    null
  )
  ok(
    !!refused.error && /already been broken or sold/i.test(refused.error ?? ''),
    'A STATED PRICE THAT HAS BEEN SOLD AGAINST IS STILL REFUSED — only a placeholder may be filled in',
    String(refused.error)
  )

  // --- the feature itself: selling short at a shop buys the difference -----
  const shelfBefore = invStock.stockQty('p_buy', KY)
  ok(shelfBefore === 0, 'the shop has none of it left', String(shelfBefore))
  const counterSale = invoices.saveInvoice(
    {
      customerName: 'Walk Up Buyer',
      invoiceNumber: 'SO-CTR3',
      invoiceDate: '2026-08-27',
      location: 'RM',
      lines: [{ item: 'Counter Sale Case', productId: 'p_buy', quantity: 3, rate: 900, destination: KY }]
    },
    null
  )
  const moved = db
    .prepare(`SELECT COALESCE(SUM(quantity), 0) AS q FROM invoice_stock_moves WHERE invoice_id = ?`)
    .get(counterSale.id) as { q: number }
  ok(
    moved.q === 3,
    'SELLING THREE THE SHOP DID NOT HAVE STILL SHIPS THREE — it bought them on the way past',
    String(moved.q)
  )
  ok(
    invStock.stockQty('p_buy', KY) === 0,
    'the shelf is level afterwards — bought three, sold three',
    String(invStock.stockQty('p_buy', KY))
  )
  /**
   * ON THE WEEK'S TAB, at no price. One bill per shop: opening a fresh order per
   * sale would leave several amounts owed to a shop expecting one payment.
   */
  const kyTabs = db
    .prepare(
      `SELECT id, po_number FROM purchase_orders
        WHERE LOWER(supplier) = LOWER(?) AND tab_opened_at IS NOT NULL AND tab_closed_at IS NULL
          AND status <> 'cancelled'`
    )
    .all(KY) as Array<{ id: string; po_number: string }>
  ok(kyTabs.length >= 1, 'the shop has an open tab', String(kyTabs.length))
  const bought = db
    .prepare(
      `SELECT COALESCE(SUM(l.quantity), 0) AS q,
              COALESCE(SUM(CASE WHEN l.price_pending = 1 THEN l.quantity ELSE 0 END), 0) AS pending
         FROM purchase_order_lines l
        WHERE l.po_id IN (${kyTabs.map(() => '?').join(', ')}) AND l.product_id = 'p_buy'`
    )
    .get(...kyTabs.map((t) => t.id)) as { q: number; pending: number }
  ok(
    bought.pending >= 3,
    'AND THE THREE ARE ON IT AT A PRICE STILL TO COME — which is what "edit the price later" means',
    JSON.stringify(bought)
  )
  /**
   * AND THE SALE SAYS SO. Buying creates a real liability as a side effect of
   * saving a sales order, and an effect like that must not be silent.
   */
  const events = require('../src/main/db/orderExtras').listOrderEvents('so', counterSale.id)
  ok(
    events.some((e: any) => /Bought 3 units at Kentucky Roadshow/i.test(e.detail ?? '')),
    'THE ORDER RECORDS WHAT IT BOUGHT — a liability created by a side effect is not allowed to be silent',
    JSON.stringify(events.map((e: any) => e.detail))
  )

  // --- and nowhere else -----------------------------------------------------
  /**
   * A SHORT RM SHELF IS A REAL SHORTFALL. The boxes are not in the building;
   * inventing a purchase would be inventing stock. This is the property that
   * keeps the feature safe, so it is pinned harder than the feature itself.
   */
  const poCount = (): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM purchase_orders`).get() as { n: number }).n
  const posBefore = poCount()
  const rmSale = invoices.saveInvoice(
    {
      customerName: 'Home Shelf Buyer',
      invoiceNumber: 'SO-CTR4',
      invoiceDate: '2026-08-27',
      location: 'RM',
      lines: [{ item: 'Counter Sale Case', productId: 'p_buy', quantity: 2, rate: 900 }]
    },
    null
  )
  const rmMoved = db
    .prepare(`SELECT COALESCE(SUM(quantity), 0) AS q FROM invoice_stock_moves WHERE invoice_id = ?`)
    .get(rmSale.id) as { q: number }
  ok(
    rmMoved.q === 0,
    'SELLING FROM AN EMPTY RM BUYS NOTHING AND SHIPS NOTHING — the line stays owed, as it always did',
    String(rmMoved.q)
  )
  ok(
    invStock.stockQty('p_buy', 'RM') === 0,
    'and no stock was conjured onto our own shelf',
    String(invStock.stockQty('p_buy', 'RM'))
  )
  /**
   * AND NO PURCHASE ORDER WAS INVENTED, which is the half that matters most.
   *
   * Checking only that no stock moved is too weak: a top-up aimed at RM would
   * fail to RECEIVE — takeTabDelivery leaves homeward cases alone — so the shelf
   * would look untouched while a phantom order sat on the board claiming we owed
   * somebody for goods nobody bought. The liability is the danger, not the
   * count.
   */
  ok(
    poCount() === posBefore,
    'AND NO PURCHASE ORDER WAS INVENTED — an unbought liability is the real danger, not the unit count',
    `${poCount()} vs ${posBefore}`
  )
  /**
   * A LINE THAT NAMES A PURCHASE ORDER BUYS NOTHING EITHER, and this is the
   * subtlest of the three limits.
   *
   * "Four of PO-0431's cases" is a claim about WHICH units. Topping the shop up
   * and letting the line fill itself would quietly turn that into "four, of
   * which three are cases I bought a moment ago" — the document would still say
   * four and would no longer mean what it said. consumeFromPo refuses a named
   * order that cannot cover its claim, and that refusal has to stay reachable.
   *
   * AT A SHOP WITH NO OTHER TAB OPEN, and with the line NAMING the order from
   * the start. Both matter: at Kentucky a top-up would land on that shop's
   * existing week rather than on the named order, and re-routing an already
   * saved line is refused by the allocation validator long before any of this —
   * so either shortcut produces a test that passes without exercising the rule.
   */
  const TX = 'Texas Roadshow'
  const namedTab = poRepo.createPurchaseOrder(
    { supplier: TX, ongoing: true, lines: [{ productId: 'p_buy', quantity: 1, unitPrice: 500 }] },
    null
  )
  const posBeforeNamed = poCount()
  let namedError = ''
  let namedMoved = -1
  try {
    const namedSale = invoices.saveInvoice(
      {
        customerName: 'Named Order Buyer',
        invoiceNumber: 'SO-CTR6',
        invoiceDate: '2026-08-27',
        location: 'RM',
        lines: [
          {
            item: 'Counter Sale Case',
            productId: 'p_buy',
            quantity: 4,
            rate: 900,
            destination: TX,
            // The claim: these four are THAT order's cases, and it holds one.
            sourcePoId: namedTab.id
          }
        ]
      },
      null
    )
    namedMoved = (
      db
        .prepare(`SELECT COALESCE(SUM(quantity), 0) AS q FROM invoice_stock_moves WHERE invoice_id = ?`)
        .get(namedSale.id) as { q: number }
    ).q
  } catch (err) {
    namedError = err instanceof Error ? err.message : String(err)
  }
  ok(
    !!namedError || namedMoved === 0,
    'ASKING FOR MORE OF A NAMED ORDER THAN IT HOLDS IS REFUSED — the top-up must not answer a claim about which units',
    namedError || `accepted and moved ${namedMoved}`
  )
  ok(
    poCount() === posBeforeNamed,
    'AND NOTHING WAS BOUGHT TO MAKE THAT CLAIM COME TRUE',
    `${poCount()} vs ${posBeforeNamed}`
  )

  /** A supplier destination is a dropship and buys nothing either. */
  const posBeforeDrop = poCount()
  const dropSale = invoices.saveInvoice(
    {
      customerName: 'Direct Buyer',
      invoiceNumber: 'SO-CTR5',
      invoiceDate: '2026-08-27',
      location: 'RM',
      lines: [
        {
          item: 'Counter Sale Case',
          productId: 'p_buy',
          quantity: 2,
          rate: 900,
          destination: 'Ordinary Distributors'
        }
      ]
    },
    null
  )
  const dropMoved = db
    .prepare(`SELECT COALESCE(SUM(quantity), 0) AS q FROM invoice_stock_moves WHERE invoice_id = ?`)
    .get(dropSale.id) as { q: number }
  ok(dropMoved.q === 0, 'A DROPSHIP BUYS NOTHING AT A SHOP EITHER', String(dropMoved.q))
  ok(
    poCount() === posBeforeDrop,
    'and raises no purchase order against the supplier either',
    `${poCount()} vs ${posBeforeDrop}`
  )
}

/** Hand the over-sell fixture's stock back, so nothing below inherits it. */
function inv_setVoid(id: string): void {
  invoices.setInvoiceStatus(id, 'void', null)
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
