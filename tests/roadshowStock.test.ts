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

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
