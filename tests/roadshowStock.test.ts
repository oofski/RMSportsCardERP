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
  poRepo.deletePurchaseOrder(second.id, null)

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
  poRepo.deletePurchaseOrder(homeward.id, null)

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

  console.log('\n=== 2. receiving a tab puts real stock at the shop ===')
  // -------------------------------------------------------------------------
  ok(qtyAt(SHOP) === 0, 'the shop holds nothing yet')
  /**
   * CHECKED IN LINE BY LINE, the way a tab actually takes goods.
   *
   * NOT `setPurchaseOrderStatus(..., 'received')`, which is the "the whole
   * delivery is here" button and forces the order closed. A tab is never
   * received that way — Tuesday's case is checked in on Tuesday and the order
   * stays open for Wednesday's — so using it here would have tested a path this
   * feature is specifically built to avoid.
   */
  const tabLine = poRepo.getPurchaseOrder(tab.id).lines[0]
  poRepo.receivePurchaseOrderLines(tab.id, [{ lineId: tabLine.id, quantity: 3 }], null)
  ok(
    qtyAt(SHOP) === 3,
    'RECEIVING A TAB LINE PUTS ITS CASES AT THE SHOP — bought, therefore owned, therefore stock',
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
   * nowhere to go. This is the rule roadshowTab was written for, checked here
   * because receiving is the act that would break it.
   */
  ok(
    poRepo.getPurchaseOrder(tab.id).status === 'ordered',
    'AND THE TAB IS STILL OPEN AFTER RECEIVING — it does not close itself, which is what lets the week keep going',
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
  poRepo.receivePurchaseOrderLines(
    shopTab.id,
    [{ lineId: poRepo.getPurchaseOrder(shopTab.id).lines[0].id, quantity: 3 }],
    null
  )

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
  poRepo.receivePurchaseOrderLines(
    shopTab.id,
    [{ lineId: poRepo.getPurchaseOrder(shopTab.id).lines[0].id, quantity: 3 }],
    null
  )

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
  poRepo.receivePurchaseOrderLines(
    secondTab.id,
    [{ lineId: poRepo.getPurchaseOrder(secondTab.id).lines[0].id, quantity: 2 }],
    null
  )
  const shopTab2 = poRepo.createPurchaseOrder(
    { supplier: SHOP, ongoing: true, lines: [{ productId: 'p_card', quantity: 2, unitPrice: 400 }] },
    null
  )
  poRepo.receivePurchaseOrderLines(
    shopTab2.id,
    [{ lineId: poRepo.getPurchaseOrder(shopTab2.id).lines[0].id, quantity: 2 }],
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

/** Hand the over-sell fixture's stock back, so nothing below inherits it. */
function inv_setVoid(id: string): void {
  invoices.setInvoiceStatus(id, 'void', null)
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
