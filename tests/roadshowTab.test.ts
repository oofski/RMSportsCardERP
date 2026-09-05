/**
 * BUYING FROM A ROADSHOW SHOP ALL WEEK AND SETTLING UP ONCE.
 *
 * The owner's words: "the roadshow shops are a little different — we buy things
 * from them throughout the week and then basically like pay once at the end and
 * sometimes we don't know the prices ... a button on a PO that for each of the 4
 * roadshows we can add what we buy from them for a purchase order throughout the
 * week, and then sales orders can be created from that ongoing purchase order,
 * and the deal ticket is just linked to the ongoing PO until the PO is paid out."
 *
 * ## The three assertions the whole feature rests on
 *
 * **Section 2 — IT DOES NOT CLOSE ITSELF.** Buy one case on Tuesday, carry it
 * home, check it in, and an ordinary purchase order SHUTS: `completePoIfFullyReceived`
 * exists so the receiving desk is not left chasing an order already in the
 * building. On a tab that is exactly wrong — Wednesday's box would have nowhere
 * to go and a week's trading would become five separate amounts owed to a shop
 * expecting one payment. If section 2 goes red, the feature is gone whatever
 * else still passes.
 *
 * **Section 4 — A PRICE FILLED IN LATER RE-COSTS THE STOCK.** The case comes
 * home on Tuesday and the shop says $400 on Friday. Without the re-cost the
 * cost layer sits at nothing, the shelf is under-valued by $400, and every break
 * and sale out of that case books pure profit while the purchase order's own
 * total says $400. This is the hole the "we don't know prices" idea would
 * otherwise leave.
 *
 * **Section 6 — IT CANNOT BE PAID WHILE A PRICE IS MISSING.** A total nobody can
 * work out is not a bill anybody can pay, and a tab settled with three unpriced
 * cases on it would under-report a week's cost of goods for ever.
 *
 * Every name here is invented.
 *
 * Run: npm run test:roadshow-tab
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/roadshow-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const { getDb } = require('../src/main/db/database')
const po = require('../src/main/db/purchaseOrders')
const invoices = require('../src/main/db/invoices')
const inventory = require('../src/main/db/inventory')
const dealTickets = require('../src/main/db/dealTickets')
const prov = require('../src/main/db/provenance')
const inv = require('../src/main/db/inventory')
const { assertStockLotsConsistent } = require('../src/main/db/lots')
const invoiceStock = require('../src/main/db/invoiceStock')
const orderExtras = require('../src/main/db/orderExtras')
const { saveStockLocation } = require('../src/main/db/stockLocations')
const { offerableOrders, soleSourceOrder, supplyRefusal } = require('../src/shared/poStock')
const { salesOrderKindOf } = require('../src/shared/invoices')
const {
  emptyShelfHeadline,
  unpricedTabWarning,
  isOpenTab,
  isRoadshowLocation,
  isTab,
  linePriced,
  pendingPriceCount,
  settleTabRefusal,
  tabAcceptsLines,
  tabKnownTotal,
  tabStatusLabel
} = require('../src/shared/roadshowTab')

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

const product = (id: string, sku: string, name: string): void => {
  db.prepare(
    `INSERT INTO inventory_products (id, sku, name, category, unit_cost, unit_type,
                                     boxes_per_case, packs_per_box, created_at, updated_at)
     VALUES (?, ?, ?, 'Baseball', 0, 'case', 12, 12,
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run(id, sku, name)
}
product('p_tue', 'RS-TUE', 'Tuesday Hobby Case')
product('p_wed', 'RS-WED', 'Wednesday Jumbo Case')
product('p_thu', 'RS-THU', 'Thursday Retail Case')

const lots = (productId: string): Array<{ qty: number; cost: number }> =>
  (
    db
      .prepare(
        `SELECT qty_remaining AS qty, unit_cost AS cost FROM inventory_lots
          WHERE product_id = ? ORDER BY received_at ASC, rowid ASC`
      )
      .all(productId) as any[]
  ).map((r) => ({ qty: Number(r.qty), cost: Number(r.cost) }))

const lineOf = (detail: any, productId: string): any =>
  detail.lines.find((l: any) => l.productId === productId)

// ---------------------------------------------------------------------------
console.log('=== 1. the shared rules, before any database is involved ===')
// ---------------------------------------------------------------------------
const OPEN = { tabOpenedAt: '2026-08-10T15:00:00.000Z', tabClosedAt: null }
const SHUT = { tabOpenedAt: '2026-08-10T15:00:00.000Z', tabClosedAt: '2026-08-15T22:00:00.000Z' }
const PLAIN = { tabOpenedAt: null, tabClosedAt: null }

ok(isTab(OPEN) && isTab(SHUT), 'both an open and a settled tab are tabs')
ok(!isTab(PLAIN), 'AND AN ORDINARY PURCHASE ORDER IS NOT ONE — the default costs nothing')
ok(isOpenTab(OPEN), 'the open one is still taking things')
ok(!isOpenTab(SHUT), 'the settled one is not')
ok(!isOpenTab(PLAIN), 'and neither is an ordinary order, which never was')
ok(tabStatusLabel(PLAIN) === null, 'an ordinary order has no tab label at all')
ok(tabStatusLabel(OPEN) === 'Open tab' && tabStatusLabel(SHUT) === 'Settled', 'the two read plainly')
ok(tabAcceptsLines(OPEN) && !tabAcceptsLines(SHUT), 'only a running tab keeps taking lines')

ok(
  linePriced({ unitPrice: 0, pricePending: false }),
  'ZERO IS A REAL PRICE — a roadshow throws a box in free and that is a fact, not a gap'
)
ok(
  !linePriced({ unitPrice: 0, pricePending: true }),
  'and "nobody has said" is the other thing entirely, which is why it is stored beside the number'
)

// THE PENDING LINE CARRIES A NUMBER, and that is the point of the fixture. The
// store writes 0 beside `pricePending`, so a version of tabKnownTotal that
// simply summed everything would give the same answer against real rows and the
// bug would ship. The contract is "the priced lines only" — not "the lines that
// happen to be zero" — so it is tested with a pending line whose number is not
// zero, which is the state the screen holds while somebody is mid-edit.
const MIXED = [
  { quantity: 2, unitPrice: 400, pricePending: false },
  { quantity: 1, unitPrice: 999, pricePending: true },
  { quantity: 3, unitPrice: 0, pricePending: false }
]
ok(tabKnownTotal(MIXED) === 800, 'the known total counts the priced lines only', String(tabKnownTotal(MIXED)))
ok(pendingPriceCount(MIXED) === 1, 'and says how many it left out')
ok(
  settleTabRefusal(OPEN, MIXED) !== null,
  'A TAB WITH AN UNPRICED LINE CANNOT BE SETTLED — a total nobody can work out is not a bill'
)
ok(
  (settleTabRefusal(OPEN, MIXED) as string).includes('1 line'),
  'and the refusal names the count',
  String(settleTabRefusal(OPEN, MIXED))
)
ok(settleTabRefusal(OPEN, []) !== null, 'an empty tab has nothing to settle')
ok(settleTabRefusal(SHUT, MIXED) === '' + settleTabRefusal(SHUT, MIXED), 'a settled tab says so')
ok(
  (settleTabRefusal(SHUT, MIXED) as string).includes('already been settled'),
  'in those words'
)
ok(
  settleTabRefusal(PLAIN, MIXED) === null,
  'AND AN ORDINARY PURCHASE ORDER IS NEVER REFUSED BY THIS — it is not a tab and this rule is not about it'
)
ok(
  settleTabRefusal(OPEN, [{ quantity: 1, unitPrice: 0, pricePending: false }]) === null,
  'a tab whose only line was free settles fine — zero is priced'
)
ok(
  isRoadshowLocation('Roadshow Dallas') && !isRoadshowLocation('RM'),
  'a roadshow is recognised by its name, the same test the picker uses'
)

// ---------------------------------------------------------------------------
console.log('=== 2. THE TAB DOES NOT CLOSE ITSELF ===')
// ---------------------------------------------------------------------------
// THE ROADSHOW TICK ON AN ORDINARY CREATE. There is no separate document and no
// separate screen: `ongoing` is one flag on the form somebody already uses to
// raise a purchase order.
const opened = po.createPurchaseOrder(
  { supplier: 'Roadshow Dallas', location: 'RM', ongoing: true, lines: [] },
  'emp_owner'
)
const tabId = opened.id
ok(!!opened.tabOpenedAt && !opened.tabClosedAt, 'a ticked order is open and running')
ok(opened.lineCount === 0, 'EMPTY ON PURPOSE — it grows all week and starts with nothing on it')
ok(opened.status === 'ordered', 'and it is an ordinary purchase order in Ordered, not a fifth status')

// UNTICKED IS UNCHANGED, which is the assertion that keeps every other purchase
// order in the app out of this feature.
const plainOne = po.createPurchaseOrder(
  { supplier: 'Cardinal Distribution', location: 'RM', lines: [] },
  'emp_owner'
)
ok(!plainOne.tabOpenedAt, 'AN UNTICKED ORDER IS NOT ONE — the flag costs nothing when it is off')

const other = po.createPurchaseOrder(
  { supplier: 'Roadshow Tulsa', location: 'RM', ongoing: true, lines: [] },
  'emp_owner'
)
ok(other.id !== tabId, 'a different shop gets its own order')

// Tuesday: one case, priced.
const tue = po.addPurchaseOrderLines(tabId, [{ productId: 'p_tue', quantity: 1, unitPrice: 400 }])
ok(!tue.error, "Tuesday's case goes on the tab", String(tue.error))

// Check it in — the whole tab is now fully received, which is what closes an
// ordinary purchase order.
const tueLine = lineOf(tue.po, 'p_tue')
const got = po.receivePurchaseOrderLines(
  tabId,
  [{ lineId: tueLine.id, quantity: 1 }],
  'emp_owner'
)
ok(!got.error, 'and it is carried home and checked in', String(got.error))
const afterReceipt = po.getPurchaseOrder(tabId)
ok(
  afterReceipt.status === 'ordered',
  'THE TAB IS STILL OPEN AFTER ITS LAST UNIT LANDED — an ordinary order would have closed itself here',
  afterReceipt.status
)
ok(isOpenTab(afterReceipt), 'and it still reads as a running tab')

// Wednesday: the case that would have had nowhere to go.
const wed = po.addPurchaseOrderLines(tabId, [
  { productId: 'p_wed', quantity: 2, unitPrice: 0, pricePending: true }
])
ok(
  !wed.error,
  "WEDNESDAY'S BOX GOES ON THE SAME TAB — the whole point, and impossible on a closed order",
  String(wed.error)
)
ok(pendingPriceCount(wed.po.lines) === 1, 'with no price on it yet')
ok(
  lineOf(wed.po, 'p_wed').pricePending === true,
  'and the line says so rather than saying it was free'
)

// ---------------------------------------------------------------------------
console.log('=== 3. the total is the priced lines, and it says how much it left out ===')
// ---------------------------------------------------------------------------
const running = po.getPurchaseOrder(tabId)
ok(running.total === 400, 'the tab is at $400 — the priced case only', String(running.total))
ok(
  tabKnownTotal(running.lines) === running.total,
  'and the shared figure agrees with the stored one, without either knowing about the other'
)
ok(
  running.pendingPriceCount === 1,
  'the count of unpriced lines travels with it, so the total is never read alone',
  String(running.pendingPriceCount)
)
const listed = po.listOpenRoadshowTabs().find((t: any) => t.id === tabId)
ok(!!listed, 'the tab is on the open-tabs list')
ok(listed.pendingPriceCount === 1, 'carrying the same count to the picker screen')
ok(
  po.listOpenRoadshowTabs().length === 2,
  'both shops with an order running are listed, oldest first',
  String(po.listOpenRoadshowTabs().length)
)

// ---------------------------------------------------------------------------
console.log('=== 4. A PRICE THAT ARRIVES LATE RE-COSTS THE STOCK ===')
// ---------------------------------------------------------------------------
// Thursday: a case bought with no price, carried home, checked in the same day.
const thu = po.addPurchaseOrderLines(tabId, [
  { productId: 'p_thu', quantity: 2, unitPrice: 0, pricePending: true }
])
const thuLine = lineOf(thu.po, 'p_thu')
po.receivePurchaseOrderLines(tabId, [{ lineId: thuLine.id, quantity: 2 }], 'emp_owner')
ok(
  lots('p_thu').reduce((n, l) => n + l.qty, 0) === 2,
  'two cases are on the shelf',
  JSON.stringify(lots('p_thu'))
)
ok(
  lots('p_thu').every((l) => l.cost === 0),
  'costed at nothing, because on Thursday nothing was known',
  JSON.stringify(lots('p_thu'))
)

const priced = po.setPurchaseOrderLinePrice(tabId, thuLine.id, 250, 'emp_owner')
ok(!priced.error, 'on Friday the shop says $250 each', String(priced.error))
ok(
  lots('p_thu').every((l) => l.cost === 250),
  'AND THE STOCK ON THE SHELF IS RE-COSTED TO MATCH — without this the shelf is under-valued and every break out of it books pure profit',
  JSON.stringify(lots('p_thu'))
)
const avg = db.prepare(`SELECT unit_cost FROM inventory_products WHERE id = 'p_thu'`).get() as any
ok(Number(avg.unit_cost) === 250, "and the product's average cost moved with it", String(avg.unit_cost))
ok(po.getPurchaseOrder(tabId).total === 900, 'the tab is now $400 + 2 × $250', String(po.getPurchaseOrder(tabId).total))
ok(
  lineOf(po.getPurchaseOrder(tabId), 'p_thu').pricePending === false,
  'and the line is no longer waiting'
)

// Back the other way: a price typed by mistake can be taken off again.
const unpriced = po.setPurchaseOrderLinePrice(tabId, thuLine.id, null, 'emp_owner')
ok(!unpriced.error, 'and it can be set back to "not known yet"', String(unpriced.error))
ok(lineOf(unpriced.po, 'p_thu').pricePending === true, 'which is a real answer, not a missing one')
ok(unpriced.po.total === 400, 'and the total drops back to what is actually known', String(unpriced.po.total))
po.setPurchaseOrderLinePrice(tabId, thuLine.id, 250, 'emp_owner')

// The refusal that keeps the re-cost honest.
const sold = inventory.adjustStock('p_thu', 'RM', -1, 'Broken on a stream', 'emp_owner')
ok(!sold?.error, 'one of those cases is then broken on a stream', String(sold?.error))
const tooLate = po.setPurchaseOrderLinePrice(tabId, thuLine.id, 275, 'emp_owner')
ok(
  !!tooLate.error,
  'A PRICE CANNOT MOVE ONCE ANY OF THE STOCK HAS LEFT — that case has already priced a break, in a month that may be closed',
  String(tooLate.error)
)
ok(
  (tooLate.error as string).includes('broken or sold'),
  'and the refusal says why in words somebody can act on',
  String(tooLate.error)
)
ok(
  lineOf(po.getPurchaseOrder(tabId), 'p_thu').unitPrice === 250,
  'the stored price is untouched by the refusal'
)

// ---------------------------------------------------------------------------
console.log('=== 5. a sale off the tab shares the tab\'s deal ticket ===')
// ---------------------------------------------------------------------------
const tabTicket = db
  .prepare(`SELECT id, number FROM deal_tickets WHERE document_kind = 'po' AND document_id = ?`)
  .get(tabId) as any
ok(!!tabTicket, 'the tab was struck a deal ticket when it was raised')

const sale = invoices.saveInvoice(
  {
    customerName: 'Halvorsen Sportscards',
    invoiceDate: '2026-08-14',
    location: 'RM',
    lines: [{ item: 'Tuesday Hobby Case', quantity: 1, rate: 900 }]
  },
  'emp_owner'
)
const linked = invoices.linkDropshipPair(tabId, sale.id, 'emp_owner')
ok(linked.ok, 'a sales order is raised off the running tab', String(linked.error))
const saleTicket = db
  .prepare(`SELECT id, number, merged_into FROM deal_tickets WHERE document_kind = 'so' AND document_id = ?`)
  .get(sale.id) as any
ok(!!saleTicket, "and it has a ticket of its own")
ok(
  saleTicket.merged_into === tabTicket.id,
  "WHICH POINTS AT THE TAB'S — one week with one shop is one deal, however many documents it took",
  `${saleTicket.merged_into} vs ${tabTicket.id}`
)
ok(
  saleTicket.number !== tabTicket.number,
  'NOTHING WAS RENUMBERED — the sale keeps the number it was struck with, which may already be on paperwork'
)
const shownOnSale = db
  .prepare(
    `SELECT COALESCE(root.number, t.number) AS n FROM deal_tickets t
       LEFT JOIN deal_tickets root ON root.id = t.merged_into
      WHERE t.document_kind = 'so' AND t.document_id = ?`
  )
  .get(sale.id) as any
ok(shownOnSale.n === tabTicket.number, "and the sale prints the GROUP's number, which is the one somebody writes down")

// A sale off an ORDINARY purchase order is untouched by any of this.
const plainPo = po.createPurchaseOrder(
  { supplier: 'Cardinal Distribution', location: 'RM', lines: [{ productId: 'p_tue', quantity: 1, unitPrice: 300 }] },
  'emp_owner'
)
const plainSale = invoices.saveInvoice(
  {
    customerName: 'Okonkwo Collectibles',
    invoiceDate: '2026-08-14',
    location: 'RM',
    lines: [{ item: 'Cardinal Hobby Case', quantity: 1, rate: 500 }]
  },
  'emp_owner'
)
invoices.linkDropshipPair(plainPo.id, plainSale.id, 'emp_owner')
const plainTicket = db
  .prepare(`SELECT merged_into FROM deal_tickets WHERE document_kind = 'so' AND document_id = ?`)
  .get(plainSale.id) as any
ok(
  plainTicket.merged_into === null,
  'AN ORDINARY DROPSHIP STILL KEEPS ITS OWN TICKET — the folding is the tab\'s behaviour, not everybody\'s'
)

// JOINING A TAB WHOSE OWN TICKET IS PART OF A GROUP JOINS THE GROUP.
//
// One level deep, always. Pointing the sale at the tab's own row would build a
// chain — sale → tab → root — and every read of "which deal is this" resolves
// exactly one hop, so the sale would print a number the register no longer
// lists on a line of its own.
const bigger = po.createPurchaseOrder(
  { supplier: 'Roadshow Wichita', location: 'RM', lines: [{ productId: 'p_tue', quantity: 1, unitPrice: 90 }] },
  'emp_owner'
)
const biggerTicket = db
  .prepare(`SELECT id FROM deal_tickets WHERE document_kind = 'po' AND document_id = ?`)
  .get(bigger.id) as any
const grouped = po.createPurchaseOrder(
  { supplier: 'Roadshow Amarillo', location: 'RM', ongoing: true, lines: [] },
  'emp_owner'
)
po.addPurchaseOrderLines(grouped.id, [{ productId: 'p_tue', quantity: 1, unitPrice: 110 }])
const groupedTicket = db
  .prepare(`SELECT id FROM deal_tickets WHERE document_kind = 'po' AND document_id = ?`)
  .get(grouped.id) as any
ok(
  dealTickets.mergeDealTickets(biggerTicket.id, [groupedTicket.id], 'emp_owner').ok,
  "the tab's own ticket is combined into a bigger deal"
)
const offGrouped = invoices.saveInvoice(
  {
    customerName: 'Petrosyan Sports',
    invoiceDate: '2026-08-14',
    location: 'RM',
    lines: [{ item: 'Amarillo Case', quantity: 1, rate: 400 }]
  },
  'emp_owner'
)
invoices.linkDropshipPair(grouped.id, offGrouped.id, 'emp_owner')
const chained = db
  .prepare(`SELECT merged_into FROM deal_tickets WHERE document_kind = 'so' AND document_id = ?`)
  .get(offGrouped.id) as any
ok(
  chained.merged_into === biggerTicket.id,
  'A SALE OFF IT POINTS AT THE ROOT, NOT AT THE TAB — one hop, or nothing can resolve the number in a single read',
  `${chained.merged_into} vs root ${biggerTicket.id} vs tab ${groupedTicket.id}`
)

// A TICKET THAT ANOTHER DEAL ALREADY CLAIMS IS NOT TAKEN OFF IT.
//
// Combining is one level deep and one owner: a document folded into deal A and
// then silently moved into deal B leaves deal A short a document nobody
// removed, and the register can no longer account for either. So the tab yields
// rather than steals — the operator's earlier combine wins.
const spoken = po.createPurchaseOrder(
  { supplier: 'Bellweather Cards', location: 'RM', lines: [{ productId: 'p_tue', quantity: 1, unitPrice: 120 }] },
  'emp_owner'
)
const spokenTicket = db
  .prepare(`SELECT id FROM deal_tickets WHERE document_kind = 'po' AND document_id = ?`)
  .get(spoken.id) as any
const claimed = invoices.saveInvoice(
  {
    customerName: 'Marchetti Cards',
    invoiceDate: '2026-08-14',
    location: 'RM',
    lines: [{ item: 'Wichita Case', quantity: 1, rate: 700 }]
  },
  'emp_owner'
)
const claimedTicket = db
  .prepare(`SELECT id FROM deal_tickets WHERE document_kind = 'so' AND document_id = ?`)
  .get(claimed.id) as any
const combined = dealTickets.mergeDealTickets(spokenTicket.id, [claimedTicket.id], 'emp_owner')
ok(combined.ok, 'a sale is combined into another deal by hand first', String(combined.error))

const wichita = po.createPurchaseOrder(
  { supplier: 'Roadshow Wichita', location: 'RM', ongoing: true, lines: [] },
  'emp_owner'
)
po.addPurchaseOrderLines(wichita.id, [{ productId: 'p_tue', quantity: 1, unitPrice: 150 }])
const stolen = invoices.linkDropshipPair(wichita.id, claimed.id, 'emp_owner')
ok(stolen.ok, 'and is then linked to a running tab', String(stolen.error))
const stillTheirs = db
  .prepare(`SELECT merged_into FROM deal_tickets WHERE document_kind = 'so' AND document_id = ?`)
  .get(claimed.id) as any
ok(
  stillTheirs.merged_into === spokenTicket.id,
  'THE TAB DOES NOT STEAL IT — a document already folded into another deal stays there, or that deal is quietly short one',
  `${stillTheirs.merged_into} vs ${spokenTicket.id}`
)

// ---------------------------------------------------------------------------
console.log('=== 6. IT CANNOT BE PAID WHILE A PRICE IS MISSING ===')
// ---------------------------------------------------------------------------
const stillOwed = po.settleRoadshowTab(tabId, 'emp_owner')
ok(
  !!stillOwed.error,
  "THE TAB REFUSES TO SETTLE — Wednesday's jumbo case still has no price on it",
  String(stillOwed.error)
)
ok(
  po.getPurchaseOrder(tabId).paidAt === null,
  'and nothing was paid — the refusal happens before the money, not after it'
)
ok(isOpenTab(po.getPurchaseOrder(tabId)), 'the tab is still open')

const wedLine = lineOf(po.getPurchaseOrder(tabId), 'p_wed')
po.setPurchaseOrderLinePrice(tabId, wedLine.id, 600, 'emp_owner')
ok(pendingPriceCount(po.getPurchaseOrder(tabId).lines) === 0, 'the last price comes in')

const settled = po.settleRoadshowTab(tabId, 'emp_owner')
ok(!settled.error, 'and now the week settles', String(settled.error))
const done = po.getPurchaseOrder(tabId)
ok(!!done.tabClosedAt, 'the tab is closed')
ok(!isOpenTab(done), 'and no longer takes anything')
ok(!!done.paidAt, 'AND IT IS PAID — settling and paying are one act, because a tab exists to be paid once at the end')
ok(done.total === 400 + 500 + 1200, 'for $400 + 2 × $250 + 2 × $600', String(done.total))
const cogs = db.prepare(`SELECT amount FROM finance_cogs WHERE po_id = ?`).get(tabId) as any
ok(
  Number(cogs.amount) === done.total,
  'and the ledger row moved with the total, so the P&L carries the whole week',
  String(cogs?.amount)
)

// AND IT DROPS OFF THE PICKER. The list is "what is still running" — a settled
// week left on it is a shop somebody would go on adding to, and a figure on a
// screen for money that has already been paid.
ok(
  !po.listOpenRoadshowTabs().some((t: any) => t.id === tabId),
  'THE SETTLED TAB IS NO LONGER ON THE OPEN LIST',
  JSON.stringify(po.listOpenRoadshowTabs().map((t: any) => t.poNumber))
)
ok(
  po.listOpenRoadshowTabs().every((t: any) => !t.tabClosedAt),
  'and nothing on that list has been settled'
)

// ---------------------------------------------------------------------------
console.log('=== 7. what a settled tab refuses ===')
// ---------------------------------------------------------------------------
const late = po.addPurchaseOrderLines(tabId, [{ productId: 'p_tue', quantity: 1, unitPrice: 100 }])
ok(
  !!late.error,
  'ANYTHING BOUGHT AFTER SETTLING NEEDS A NEW TAB — adding to it would change a bill that has been paid',
  String(late.error)
)
ok((late.error as string).includes('settled'), 'and it says so')
const twice = po.settleRoadshowTab(tabId, 'emp_owner')
ok(!!twice.error, 'and it cannot be settled twice')

// A NEW WEEK IS A NEW ORDER, raised the same way the first one was.
const fresh = po.createPurchaseOrder(
  { supplier: 'Roadshow Dallas', location: 'RM', ongoing: true, lines: [] },
  'emp_owner'
)
ok(fresh.id !== tabId, 'the next week is its own order, ticked the same way')
ok(!!fresh.tabOpenedAt && !fresh.tabClosedAt, 'and it is open')
ok(
  po.listOpenRoadshowTabs().some((t: any) => t.id === fresh.id),
  'THE CREATE FORM CAN SEE IT — which is what lets it warn before a third one is started'
)

// ---------------------------------------------------------------------------
console.log('=== 8. an ordinary purchase order is untouched by every bit of this ===')
// ---------------------------------------------------------------------------
const ord = po.createPurchaseOrder(
  { supplier: 'Cardinal Distribution', location: 'RM', lines: [{ productId: 'p_tue', quantity: 1, unitPrice: 300 }] },
  'emp_owner'
)
ok(!isTab(ord), 'it is not a tab')
ok(ord.pendingPriceCount === 0, 'nothing on it is waiting for a price')
ok(ord.lines.every((l: any) => l.pricePending === false), 'and no line claims to be')
const ordLine = ord.lines[0]
po.receivePurchaseOrderLines(ord.id, [{ lineId: ordLine.id, quantity: 1 }], 'emp_owner')
ok(
  po.getPurchaseOrder(ord.id).status === 'received',
  'AND IT STILL CLOSES ITSELF THE MOMENT ITS LAST UNIT LANDS — the behaviour every other order depends on',
  po.getPurchaseOrder(ord.id).status
)
const shut = po.addPurchaseOrderLines(ord.id, [{ productId: 'p_wed', quantity: 1, unitPrice: 50 }])
ok(!!shut.error, 'and it refuses a line once it is closed, exactly as it always has')

// ---------------------------------------------------------------------------
console.log('=== 9. freight survives a line being added ===')
// ---------------------------------------------------------------------------
// A tab has a line added every day of the week, which is how a long-standing
// bug in addPurchaseOrderLines finally surfaced: it summed the lines itself and
// forgot the freight, so adding anything wiped the shipping charge out of both
// the total and the ledger row.
const freighted = po.createPurchaseOrder(
  {
    supplier: 'Cardinal Distribution',
    location: 'RM',
    shippingCost: 75,
    lines: [{ productId: 'p_tue', quantity: 1, unitPrice: 300 }]
  },
  'emp_owner'
)
ok(freighted.total === 375, 'an order of $300 plus $75 freight comes to $375', String(freighted.total))
const grown = po.addPurchaseOrderLines(freighted.id, [
  { productId: 'p_wed', quantity: 1, unitPrice: 100 }
])
ok(
  grown.po.total === 475,
  'AND ADDING A $100 LINE MAKES IT $475, NOT $400 — the freight is still owed',
  String(grown.po.total)
)
const fcogs = db.prepare(`SELECT amount FROM finance_cogs WHERE po_id = ?`).get(freighted.id) as any
ok(Number(fcogs.amount) === 475, 'and the ledger row agrees', String(fcogs?.amount))

// ---------------------------------------------------------------------------
console.log('=== 10. SELLING THE CASES THIS ORDER BROUGHT IN ===')
// ---------------------------------------------------------------------------
/**
 * The owner's example, run: buy ten cases on a roadshow order, sell five of
 * them, and check the money.
 *
 * THE ASSERTION THAT MATTERS is the cost. There is a cheaper, older case of the
 * same product on the shelf from a distributor, and FIFO would take it — so a
 * tribSale that merely POINTED at the roadshow order while costing against March's
 * stock would look right on every screen and report a margin about somebody
 * else's inventory. The figure below is what proves the units followed the name.
 */
product('p_trib', 'RS-TRIB', 'Tribute Baseball Case')

// March, from a distributor: cheap, and OLDEST, so FIFO would reach for it.
const march = po.createPurchaseOrder(
  {
    supplier: 'Cardinal Distribution',
    location: 'RM',
    lines: [{ productId: 'p_trib', quantity: 4, unitPrice: 100 }]
  },
  'emp_owner'
)
po.receivePurchaseOrderLines(
  march.id,
  [{ lineId: march.lines[0].id, quantity: 4 }],
  'emp_owner'
)

// The roadshow week: ten cases at 300.
const week = po.createPurchaseOrder(
  {
    supplier: 'Roadshow Dallas',
    location: 'RM',
    ongoing: true,
    lines: [{ productId: 'p_trib', quantity: 10, unitPrice: 300 }]
  },
  'emp_owner'
)
po.receivePurchaseOrderLines(week.id, [{ lineId: week.lines[0].id, quantity: 10 }], 'emp_owner')
ok(inventory.stockQty('p_trib', 'RM') === 14, 'fourteen on the shelf — four old, ten from the roadshow')

/**
 * BOTH ORDERS ARE OFFERED, and this is the owner's actual case: "we buy 5 of
 * product A from a roadshow shop and then we buy 5 from someone else — I want to
 * select which PO these are coming from."
 *
 * The someone else is usually an ordinary distributor. Offering only roadshow
 * orders left the one scenario the chooser exists for as the one it could not
 * answer.
 */
const offered = prov.supplyingOrders('p_trib', 'RM')
ok(offered.length === 2, 'BOTH orders are offered on a sales order line', JSON.stringify(offered))
ok(
  offered[0].poId === week.id,
  'THE RUNNING ROADSHOW ONE LEADS — it is what the control was built for and what somebody reaches for most',
  JSON.stringify(offered.map((o: any) => o.poNumber))
)
ok(offered[0].unitsOnHand === 10, 'holding all ten', String(offered[0].unitsOnHand))
ok(
  offered.some((o: any) => o.poId === march.id && o.unitsOnHand === 4),
  "AND THE DISTRIBUTOR'S IS THERE TOO, with the four it still has — five roadshow cases beside five distributor cases on one shelf is exactly when it matters which five went out"
)

// WHAT THE CHOOSER WILL ACTUALLY DRAW, asked of the shared rule directly.
// Every row it keeps is a row somebody can pick; a row whose only outcome is a
// refusal is one more thing to read past on a line that mostly wants "any
// stock".
const OFFERS = [
  { poId: 'a', poNumber: 'PO-A', supplier: null, location: 'RM', unitsOnHand: 0, tabOpenedAt: 'x', tabClosedAt: null },
  { poId: 'b', poNumber: 'PO-B', supplier: null, location: 'RM', unitsOnHand: 4, tabOpenedAt: 'x', tabClosedAt: 'y' },
  { poId: 'c', poNumber: 'PO-C', supplier: null, location: 'RM', unitsOnHand: 2, tabOpenedAt: null, tabClosedAt: null },
  { poId: 'd', poNumber: 'PO-D', supplier: null, location: 'RM', unitsOnHand: 3, tabOpenedAt: 'x', tabClosedAt: null },
  { poId: 'e', poNumber: 'PO-E', supplier: null, location: 'RM', unitsOnHand: 9, tabOpenedAt: 'x', tabClosedAt: null }
]
const kept = offerableOrders(OFFERS).map((o: any) => o.poId)
ok(
  JSON.stringify(kept) === JSON.stringify(['e', 'd', 'b', 'c']),
  'THE EMPTY ONE IS DROPPED — a row reading "0 left" is a row whose only outcome is a refusal — AND THE RUNNING ROADSHOWS LEAD, then most-on-hand first',
  JSON.stringify(kept)
)
ok(
  !kept.includes('a'),
  'said plainly: an order holding nothing is never offered'
)
ok(
  kept.indexOf('d') < kept.indexOf('b') && kept.indexOf('d') < kept.indexOf('c'),
  'A RUNNING ROADSHOW HOLDING 3 STILL BEATS A SETTLED ONE HOLDING 4 — the lead is by kind, not by count',
  JSON.stringify(kept)
)

// The shared refusal, before anything is written.
ok(
  supplyRefusal(offered[0], 5, 'Tribute') === null,
  'five out of ten is fine'
)
ok(
  supplyRefusal(offered[0], 11, 'Tribute') !== null,
  'ELEVEN IS REFUSED rather than topped up from the older case — a line cannot be part one order and part another'
)
ok(
  (supplyRefusal(offered[0], 11, 'Tribute') as string).includes('10'),
  'and the refusal names what is actually there',
  String(supplyRefusal(offered[0], 11, 'Tribute'))
)
ok(supplyRefusal(null, 11) === null, 'a line naming NO order is never refused by this — it walks FIFO')

const tribSale = invoices.saveInvoice(
  {
    customerName: 'Ashgrove Cards',
    invoiceDate: '2026-08-19',
    location: 'RM',
    lines: [
      { item: 'Tribute Baseball Case', productId: 'p_trib', quantity: 5, rate: 900, sourcePoId: week.id }
    ]
  },
  'emp_owner'
)
ok(!!tribSale.id, 'five cases are sold out of the roadshow order')
ok(inventory.stockQty('p_trib', 'RM') === 9, 'the shelf is down to nine', String(inventory.stockQty('p_trib', 'RM')))

const soldCost = db
  .prepare(
    `SELECT SUM(cost_total) AS c FROM invoice_stock_moves WHERE invoice_id = ?`
  )
  .get(tribSale.id) as any
ok(
  Math.abs(Number(soldCost.c) - 1500) < 0.005,
  'AND IT COST 5 × $300, NOT 4 × $100 + 1 × $300 — the units followed the name instead of the FIFO walk',
  String(soldCost?.c)
)
ok(
  lots('p_trib').filter((l) => l.cost === 100).reduce((n, l) => n + l.qty, 0) === 4,
  "THE DISTRIBUTOR'S FOUR ARE UNTOUCHED, which is the other half of the same fact",
  JSON.stringify(lots('p_trib'))
)
ok(
  prov.supplyingOrders('p_trib', 'RM')[0].unitsOnHand === 5,
  'and the order now offers the five it has left',
  JSON.stringify(prov.supplyingOrders('p_trib', 'RM'))
)

// The line remembers, and the tribSale is on the order.
const tribSaleBack = invoices.getInvoice(tribSale.id)
ok(tribSaleBack.lines[0].sourcePoId === week.id, 'the line says which order it sold')
ok(tribSaleBack.lines[0].sourcePoNumber === week.poNumber, 'and prints its number rather than an id')
ok(
  invoices.salesFromPoStock(week.id).some((i: any) => i.id === tribSale.id),
  'THE ORDER CAN LIST WHO BOUGHT ITS CASES — the question a week with a shop is opened to ask'
)

// The deal ticket, folded — without the tribSale becoming a dropship.
const weekTicket = db
  .prepare(`SELECT id, number FROM deal_tickets WHERE document_kind = 'po' AND document_id = ?`)
  .get(week.id) as any
const saleTicketRow = db
  .prepare(`SELECT merged_into FROM deal_tickets WHERE document_kind = 'so' AND document_id = ?`)
  .get(tribSale.id) as any
ok(
  saleTicketRow.merged_into === weekTicket.id,
  "the tribSale joins the order's deal ticket — one week with one shop is one deal"
)
ok(
  tribSaleBack.sourcePoId === null,
  'AND THE SALE IS STILL NOT A DROPSHIP. invoices.source_po_id means one specific thing — this is the sell-half of a dropship — and setting it here would have an all-our-own-stock sale reporting as part drop-shipped'
)
ok(
  salesOrderKindOf(tribSaleBack) === 'stock',
  'which is exactly what the board reads it as',
  salesOrderKindOf(tribSaleBack)
)

// A SECOND SAVE MUST NOT DOUBLE ANYTHING. Editing a sales order re-runs the
// whole release-and-apply, and the fold runs with it.
const edited = invoices.saveInvoice(
  {
    id: tribSale.id,
    customerName: 'Ashgrove Cards',
    invoiceDate: '2026-08-19',
    location: 'RM',
    lines: [
      { item: 'Tribute Baseball Case', productId: 'p_trib', quantity: 5, rate: 950, sourcePoId: week.id }
    ]
  },
  'emp_owner'
)
ok(!!edited.id, 'the sale is edited — the rate changes')
ok(
  inventory.stockQty('p_trib', 'RM') === 9,
  'THE SHELF DOES NOT MOVE — release-and-apply put the same five back and took the same five again',
  String(inventory.stockQty('p_trib', 'RM'))
)
ok(
  Math.abs(
    Number(
      (db.prepare(`SELECT SUM(cost_total) AS c FROM invoice_stock_moves WHERE invoice_id = ?`)
        .get(tribSale.id) as any).c
    ) - 1500
  ) < 0.005,
  'and it still costs 1500 — the re-take found the same layers'
)
const joins = db
  .prepare(
    `SELECT COUNT(*) AS n FROM order_events
      WHERE order_id = ? AND detail LIKE 'Sold out of%'`
  )
  .get(tribSale.id) as any
ok(
  Number(joins.n) === 1,
  'AND THE LOG GAINED NOTHING — the fold reports whether it actually folded, which is what stops a line per keystroke',
  String(joins?.n)
)

// A line asking for more than the order has is refused by the STORE, not only
// by the screen. A screen is not a gate.
let refused = ''
try {
  invoices.saveInvoice(
    {
      customerName: 'Overreach Cards',
      invoiceDate: '2026-08-19',
      location: 'RM',
      lines: [
        { item: 'Tribute Baseball Case', productId: 'p_trib', quantity: 9, rate: 900, sourcePoId: week.id }
      ]
    },
    'emp_owner'
  )
} catch (err) {
  refused = String((err as Error).message)
}
ok(!!refused, 'NINE OUT OF AN ORDER HOLDING FIVE IS REFUSED IN THE STORE', refused)
ok(refused.includes(week.poNumber), 'and the refusal names the order', refused)
ok(
  inventory.stockQty('p_trib', 'RM') === 9,
  'AND NOTHING MOVED — the throw rolled the whole save back, shelf included',
  String(inventory.stockQty('p_trib', 'RM'))
)

/**
 * SELLING OUT OF AN ORDINARY PURCHASE ORDER — the other half of the owner's
 * case, and the half that decides whether the chooser is any use.
 *
 * The COST follows the name, exactly as it does for a roadshow: that is what
 * naming an order is for, and it is right whoever the order is with.
 *
 * The DEAL TICKET does not. A case bought from a distributor in March and sold
 * to somebody unrelated in August is two pieces of trade that happen to share a
 * box; folding their tickets together would put a purchase and a sale under one
 * number on the strength of a shelf. Only a roadshow week is one deal.
 */
product('p_mix', 'RS-MIX', 'Mixed Shelf Case')
const rsFive = po.createPurchaseOrder(
  {
    supplier: 'Roadshow Dallas',
    location: 'RM',
    ongoing: true,
    lines: [{ productId: 'p_mix', quantity: 5, unitPrice: 300 }]
  },
  'emp_owner'
)
const distFive = po.createPurchaseOrder(
  {
    supplier: 'Cardinal Distribution',
    location: 'RM',
    lines: [{ productId: 'p_mix', quantity: 5, unitPrice: 120 }]
  },
  'emp_owner'
)
po.receivePurchaseOrderLines(rsFive.id, [{ lineId: rsFive.lines[0].id, quantity: 5 }], 'emp_owner')
po.receivePurchaseOrderLines(distFive.id, [{ lineId: distFive.lines[0].id, quantity: 5 }], 'emp_owner')
ok(inventory.stockQty('p_mix', 'RM') === 10, 'ten on the shelf — five from each')

const bothOffered = prov.supplyingOrders('p_mix', 'RM')
ok(
  bothOffered.length === 2 && bothOffered[0].poId === rsFive.id,
  'both are offered, roadshow first',
  JSON.stringify(bothOffered.map((o: any) => `${o.poNumber}:${o.unitsOnHand}`))
)

// Sell the DISTRIBUTOR's five, with the roadshow's sitting right beside them.
const distSale = invoices.saveInvoice(
  {
    customerName: 'Thorne Collectibles',
    invoiceDate: '2026-08-23',
    location: 'RM',
    lines: [
      { item: 'Mixed Shelf Case', productId: 'p_mix', quantity: 5, rate: 400, sourcePoId: distFive.id }
    ]
  },
  'emp_owner'
)
const distCost = db
  .prepare(`SELECT SUM(cost_total) AS c FROM invoice_stock_moves WHERE invoice_id = ?`)
  .get(distSale.id) as any
ok(
  Math.abs(Number(distCost.c) - 600) < 0.005,
  "IT COST 5 × $120 — THE DISTRIBUTOR'S, not the roadshow's $300s and not a blend",
  String(distCost?.c)
)
ok(
  prov.supplyingOrders('p_mix', 'RM').length === 1,
  'and the distributor order drops off the list, having nothing left'
)
ok(
  prov.supplyingOrders('p_mix', 'RM')[0].poId === rsFive.id,
  "leaving the roadshow's five, untouched"
)

/**
 * A CANCELLED ORDER IS NEVER OFFERED, even while its layers are still there.
 *
 * Cancelling normally hands the stock back, which would empty the layers and
 * make the guard look redundant. The state it exists for is the one where the
 * two come apart — a row that arrived through sync, or a cancel that could not
 * reverse — and then its cost is out of the ledger while its cases are on the
 * shelf. Selling "out of" it would attribute units to a purchase the books say
 * never happened.
 *
 * Set directly, because reaching it through the ordinary path is the thing that
 * cannot happen.
 */
const stillHeld = prov.supplyingOrders('p_mix', 'RM').length
db.prepare(`UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?`).run(rsFive.id)
ok(
  prov.supplyingOrders('p_mix', 'RM').length === stillHeld - 1,
  'A CANCELLED ORDER DROPS OFF THE LIST while its cases are still on the shelf',
  JSON.stringify(prov.supplyingOrders('p_mix', 'RM').map((o: any) => o.poNumber))
)
ok(
  inventory.stockQty('p_mix', 'RM') > 0,
  'and the shelf still holds them — the guard is about the ORDER, not the stock',
  String(inventory.stockQty('p_mix', 'RM'))
)
db.prepare(`UPDATE purchase_orders SET status = 'received' WHERE id = ?`).run(rsFive.id)
ok(
  prov.supplyingOrders('p_mix', 'RM').length === stillHeld,
  'put back, it is offered again'
)

const distTicket = db
  .prepare(`SELECT merged_into FROM deal_tickets WHERE document_kind = 'so' AND document_id = ?`)
  .get(distSale.id) as any
ok(
  distTicket.merged_into === null,
  'AND THE SALE KEEPS ITS OWN DEAL TICKET — naming an ordinary order says where the cost came from, not that the two documents are one deal',
  String(distTicket?.merged_into)
)

// A SETTLED roadshow order is still selectable, and still does not fold. Its
// week is closed; the cases it brought in are on the shelf either way.
const settledSale = invoices.saveInvoice(
  {
    customerName: 'Thorne Collectibles',
    invoiceDate: '2026-08-23',
    location: 'RM',
    lines: [
      { item: 'Mixed Shelf Case', productId: 'p_mix', quantity: 1, rate: 400, sourcePoId: rsFive.id }
    ]
  },
  'emp_owner'
)
const openFold = db
  .prepare(`SELECT merged_into FROM deal_tickets WHERE document_kind = 'so' AND document_id = ?`)
  .get(settledSale.id) as any
ok(
  openFold.merged_into !== null,
  'A SALE OFF THE RUNNING ROADSHOW STILL JOINS ITS TICKET — the narrowing took nothing away from the case it was built for',
  String(openFold?.merged_into)
)

/**
 * TWO LINES NAMING TWO ORDERS FOLD INTO NEITHER.
 *
 * A deal ticket is a claim about ONE deal. A sale supplied half by Dallas and
 * half by Tulsa belongs to neither week, and picking one would put a figure on
 * the wrong shop's ticket — quietly, on the register somebody reconciles from.
 *
 * The COST still follows each line to its own order. Only the ticket abstains,
 * because only the ticket has to name a single deal.
 */
product('p_two', 'RS-TWO', 'Two-Shop Case')
const shopA = po.createPurchaseOrder(
  {
    supplier: 'Roadshow Dallas',
    location: 'RM',
    ongoing: true,
    lines: [{ productId: 'p_two', quantity: 2, unitPrice: 100 }]
  },
  'emp_owner'
)
const shopB = po.createPurchaseOrder(
  {
    supplier: 'Roadshow Tulsa',
    location: 'RM',
    ongoing: true,
    lines: [{ productId: 'p_two', quantity: 2, unitPrice: 400 }]
  },
  'emp_owner'
)
po.receivePurchaseOrderLines(shopA.id, [{ lineId: shopA.lines[0].id, quantity: 2 }], 'emp_owner')
po.receivePurchaseOrderLines(shopB.id, [{ lineId: shopB.lines[0].id, quantity: 2 }], 'emp_owner')

ok(
  soleSourceOrder([{ sourcePoId: shopA.id }, { sourcePoId: shopA.id }]) === shopA.id,
  'two lines naming the SAME order agree on it'
)
ok(
  soleSourceOrder([{ sourcePoId: shopA.id }, { sourcePoId: shopB.id }]) === null,
  'TWO LINES NAMING TWO ORDERS AGREE ON NOTHING — naming one of them would put a week on the wrong shop'
)
ok(
  soleSourceOrder([{ sourcePoId: shopA.id }, { sourcePoId: null }]) === shopA.id,
  'and a line naming NOTHING is not a disagreement — a roadshow sale plus a T-shirt is still that roadshow\'s sale'
)

const split = invoices.saveInvoice(
  {
    customerName: 'Nakamura Cards',
    invoiceDate: '2026-08-22',
    location: 'RM',
    lines: [
      { item: 'Two-Shop Case', productId: 'p_two', quantity: 1, rate: 700, sourcePoId: shopA.id },
      { item: 'Two-Shop Case', productId: 'p_two', quantity: 1, rate: 700, sourcePoId: shopB.id }
    ]
  },
  'emp_owner'
)
const splitTicket = db
  .prepare(`SELECT merged_into FROM deal_tickets WHERE document_kind = 'so' AND document_id = ?`)
  .get(split.id) as any
ok(
  splitTicket.merged_into === null,
  'A SALE OFF TWO ORDERS KEEPS ITS OWN TICKET rather than joining one of them',
  String(splitTicket?.merged_into)
)
// But the money still went to the right layers, per line.
const splitCost = db
  .prepare(`SELECT SUM(cost_total) AS c FROM invoice_stock_moves WHERE invoice_id = ?`)
  .get(split.id) as any
ok(
  Math.abs(Number(splitCost.c) - 500) < 0.005,
  'AND EACH LINE STILL COST ITS OWN ORDER — $100 from Dallas and $400 from Tulsa, not $200 of the cheaper one',
  String(splitCost?.c)
)

/**
 * A NAMED LINE IS NOT QUIETLY TRIMMED TO WHAT IS THERE.
 *
 * The ordinary path clamps: a sale of six against a shelf holding four books
 * four, deliberately, because the operator asked for stock and the shelf is the
 * answer. That leniency is WRONG on a line that names an order — "six of
 * PO-0042's cases" is a claim about which units, and booking four of them would
 * leave the document saying six while two were never sold and nothing said so.
 *
 * Needs a product whose ONLY stock is the order's, or the clamp and the refusal
 * land on the same number and the difference cannot be seen. That is exactly why
 * this case exists: the first version of this test could not tell them apart.
 */
product('p_only', 'RS-ONLY', 'Only-From-Roadshow Case')
const onlyPo = po.createPurchaseOrder(
  {
    supplier: 'Roadshow Dallas',
    location: 'RM',
    ongoing: true,
    lines: [{ productId: 'p_only', quantity: 3, unitPrice: 200 }]
  },
  'emp_owner'
)
po.receivePurchaseOrderLines(onlyPo.id, [{ lineId: onlyPo.lines[0].id, quantity: 3 }], 'emp_owner')
ok(inventory.stockQty('p_only', 'RM') === 3, 'three on the shelf, all from the one order')

let overAsk = ''
try {
  invoices.saveInvoice(
    {
      customerName: 'Bekele Sportscards',
      invoiceDate: '2026-08-21',
      location: 'RM',
      lines: [
        { item: 'Only-From-Roadshow Case', productId: 'p_only', quantity: 8, rate: 500, sourcePoId: onlyPo.id }
      ]
    },
    'emp_owner'
  )
} catch (err) {
  overAsk = String((err as Error).message)
}
ok(
  !!overAsk,
  'EIGHT AGAINST AN ORDER HOLDING THREE IS REFUSED — not booked as three on a line that says eight',
  overAsk
)
ok(
  inventory.stockQty('p_only', 'RM') === 3,
  'and the three are still on the shelf',
  String(inventory.stockQty('p_only', 'RM'))
)
// The same over-ask WITHOUT naming the order is the ordinary path, and it still
// takes what is there — the leniency is not removed, it is scoped.
const lenient = invoices.saveInvoice(
  {
    customerName: 'Bekele Sportscards',
    invoiceDate: '2026-08-21',
    location: 'RM',
    lines: [{ item: 'Only-From-Roadshow Case', productId: 'p_only', quantity: 8, rate: 500 }]
  },
  'emp_owner'
)
ok(!!lenient.id, 'AN UNNAMED LINE OVER-ASKING IS STILL ACCEPTED — an order written the day before the pallet lands is a real thing')
ok(
  inventory.stockQty('p_only', 'RM') === 0,
  'taking the three that were there',
  String(inventory.stockQty('p_only', 'RM'))
)

/**
 * DELETING THE ORDER TAKES THE LABEL OFF THE LINE, NOT THE SALE.
 *
 * On its own order, because deleting `week` is refused — it has stock checked in
 * against it, which is a different and correct refusal. This is the unlink, and
 * it is asserted rather than wrapped in an `if`: a conditional around a check is
 * how a test goes green while proving nothing.
 */
product('p_del', 'RS-DEL', 'Deletable Case')
const doomed = po.createPurchaseOrder(
  {
    supplier: 'Roadshow Amarillo',
    location: 'RM',
    ongoing: true,
    lines: [{ productId: 'p_del', quantity: 2, unitPrice: 50 }]
  },
  'emp_owner'
)
po.receivePurchaseOrderLines(doomed.id, [{ lineId: doomed.lines[0].id, quantity: 2 }], 'emp_owner')
const offDoomed = invoices.saveInvoice(
  {
    customerName: 'Lindqvist Cards',
    invoiceDate: '2026-08-20',
    location: 'RM',
    lines: [{ item: 'Deletable Case', productId: 'p_del', quantity: 1, rate: 200, sourcePoId: doomed.id }]
  },
  'emp_owner'
)
ok(
  invoices.getInvoice(offDoomed.id).lines[0].sourcePoId === doomed.id,
  'a sale names the order it sold out of'
)
const forced = po.forceDeletePurchaseOrder(doomed.id, false, 'emp_owner')
ok(!forced.error, 'the order is deleted, stock left where it is', String(forced.error))
ok(!po.getPurchaseOrder(doomed.id), 'and it is gone')
const orphan = invoices.getInvoice(offDoomed.id)
ok(!!orphan, 'THE SALE SURVIVES — the units are still sold, whatever happened to the paperwork behind them')
ok(
  orphan.lines[0].sourcePoId === null,
  'AND THE LINE STOPS CLAIMING A PROVENANCE NOTHING CAN OPEN — the label is what goes, not the line',
  String(orphan.lines[0].sourcePoId)
)

console.log('\n=== 9. an empty shop column says WHY it is empty ===')
// ---------------------------------------------------------------------------
/**
 * The owner, looking at New York on the roadshow board: the column said 0 and
 * "Nothing here yet", and the footer directly underneath it said
 * "PO-0452 · $0.00 · 1 unpriced". His words: "why is the roadshow tab not
 * showing the product ... that doesn't make sense."
 *
 * BOTH HALVES WERE TRUE. The column reads the SHELF and the footer reads the
 * TAB, deliberately — a case bought at a shop and sold out of it the same
 * afternoon leaves the shelf at zero and stays on the week's tab for ever. So
 * the defect was the SENTENCE: "Nothing here yet. Add what you buy" asserts
 * nothing was ever added, which is false while a tab is running and false in the
 * expensive direction — it invites somebody to add the case a second time.
 *
 * Sections 9a and 9b pin the sentence; 9c drives the whole thing through the
 * real store, because a note derived from figures no purchase order actually
 * produces would pass its own test and still be wrong on the screen.
 */
{
  ok(
    /Nothing here yet/.test(emptyShelfHeadline(null)) && unpricedTabWarning(null, 3) === null,
    '9a — NO TAB IS STILL "nothing here yet": the week has not started and there is nothing else to say'
  )
  ok(
    /Nothing here yet/.test(
      emptyShelfHeadline({ poNumber: 'PO-9001', orderedUnits: 0, receivedUnits: 0, pendingPriceCount: 0 })
    ),
    'a tab opened and not yet bought against reads the same — to the person looking at the column it IS the same state'
  )

  const SOLD_TAB = {
    poNumber: 'PO-0452',
    orderedUnits: 1,
    receivedUnits: 1,
    pendingPriceCount: 1
  }
  const sold = emptyShelfHeadline(SOLD_TAB)
  ok(
    !/Nothing here yet/.test(sold) && /has been sold/.test(sold) && sold.includes('PO-0452'),
    '9b — THE ONE THAT WAS WRONG: everything bought here has been sold, and the sentence names the tab holding it',
    sold
  )
  ok(
    /1 unit\b/.test(sold) && !/1 units/.test(sold),
    'singular reads as one unit, not "1 units"',
    sold
  )
  ok(
    unpricedTabWarning(SOLD_TAB, 0) === null,
    'AND A SHOP WHOSE CASE HAS SOLD IS NOT WARNED — the money is spent and the sale is booked; Wholesale reports that, and this board can only prevent the NEXT one',
    String(unpricedTabWarning(SOLD_TAB, 0))
  )
  ok(
    unpricedTabWarning({ poNumber: 'PO-0452', orderedUnits: 2, receivedUnits: 2, pendingPriceCount: 0 }, 0) === null,
    'a fully priced tab has nothing left to warn about'
  )

  const home = emptyShelfHeadline({
    poNumber: 'PO-0453',
    orderedUnits: 3,
    receivedUnits: 0,
    pendingPriceCount: 0
  })
  ok(
    /coming home/.test(home) && !/been sold/.test(home),
    'UNITS ROUTED HOME ARE NOT "SOLD" — they are on a lorry, and saying sold would send somebody looking for money that was never taken',
    home
  )
  const both = emptyShelfHeadline({
    poNumber: 'PO-0454',
    orderedUnits: 5,
    receivedUnits: 2,
    pendingPriceCount: 0
  })
  ok(
    /2 units bought here have been sold/.test(both) && /3 units more are coming home/.test(both),
    'and a week that did both says both, with the right count on each side',
    both
  )
  const impossible = emptyShelfHeadline({
    poNumber: 'PO-0455',
    orderedUnits: 1,
    receivedUnits: 9,
    pendingPriceCount: 0
  })
  ok(
    /the 1 unit bought here has been sold/.test(impossible) && !/coming home/.test(impossible),
    'RECEIVED IS CAPPED AT ORDERED: a column reading "9 sold and −8 coming home" is worse than merely wrong',
    impossible
  )
}

// --- 9c. the same thing, driven through the store ---------------------------
{
  const SHOP9 = 'Roadshow Ashford'
  db.prepare(
    `INSERT INTO inventory_products (id, sku, name, category, unit_cost, created_at, updated_at)
     VALUES ('p_shelf9', 'SKU-S9', 'Ashford Hobby Box', 'Baseball', 0,
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run()

  // The Add-what-you-bought path exactly: ongoing, no destination typed, price
  // left blank because the shop has not said yet.
  const tab9opened = po.createPurchaseOrder(
    {
      supplier: SHOP9,
      location: '',
      ongoing: true,
      lines: [{ productId: 'p_shelf9', quantity: 1, unitPrice: 0, pricePending: true }]
    },
    'emp_owner'
  )
  const tabId = tab9opened.id
  ok(
    inventory.stockAtLocation(SHOP9).length === 1,
    'the case is on the shop shelf the moment it is typed — buying at a shop IS taking delivery'
  )

  const off = invoices.saveInvoice(
    {
      customerName: 'Ashford Buyer',
      invoiceNumber: 'SO-R900',
      invoiceDate: '2026-08-27',
      location: SHOP9,
      lines: [{ item: 'Ashford Hobby Box', productId: 'p_shelf9', quantity: 1, rate: 500 }]
    },
    'emp_owner'
  )
  ok(!!off.id, 'and it is sold straight out of the shop')

  const shelf = inventory.stockAtLocation(SHOP9)
  const tab9 = po.listOpenRoadshowTabs().find((t: any) => t.id === tabId)
  ok(
    shelf.length === 0 && !!tab9 && tab9.lineCount === 1,
    'THE EXACT CONTRADICTION REPRODUCED: the shelf is bare and the tab still holds the line',
    `${shelf.length} on shelf, ${tab9 ? tab9.lineCount : 'no'} lines`
  )
  ok(
    tab9.total === 0 && tab9.pendingPriceCount === 1,
    'reading $0.00 and 1 unpriced, which is what the footer showed',
    `${tab9.total} / ${tab9.pendingPriceCount}`
  )
  const standing9 = {
    poNumber: tab9.poNumber,
    orderedUnits: tab9.orderedUnits,
    receivedUnits: tab9.receivedUnits,
    pendingPriceCount: tab9.pendingPriceCount ?? 0
  }
  const note = emptyShelfHeadline(standing9)
  ok(
    !/Nothing here yet/.test(note) &&
      /has been sold/.test(note) &&
      note.includes(tab9.poNumber),
    'AND THE COLUMN NOW SAYS SO, off figures a real purchase order produced',
    note
  )
  ok(
    unpricedTabWarning(standing9, 0) === null,
    'and NOT warned about, because its case has already gone — nothing on this shelf can be saved by shouting'
  )

  // And the fix the warning asks for actually works from here.
  const line9 = po.getPurchaseOrder(tabId).lines[0]
  const priced = po.setPurchaseOrderLinePrice(tabId, line9.id, 220, 'emp_owner')
  ok(!priced.error, 'pricing the line is accepted even though its case has gone', String(priced.error))
  const after = po.listOpenRoadshowTabs().find((t: any) => t.id === tabId)
  ok(
    (after.pendingPriceCount ?? 0) === 0 &&
      unpricedTabWarning(
        {
          poNumber: after.poNumber,
          orderedUnits: after.orderedUnits,
          receivedUnits: after.receivedUnits,
          pendingPriceCount: after.pendingPriceCount ?? 0
        },
        0
      ) === null,
    'and the warning goes away once it is done — a nag that does not clear is one people stop reading'
  )
}


console.log('\n=== 10. pricing a tab line updates the RIGHT product on Wholesale ===')
// ---------------------------------------------------------------------------
/**
 * The owner: "make sure in the wholesale financial tab that the right products
 * when we price are getting updated."
 *
 * The chain being pinned runs the whole width of the app and has four links, and
 * a break in any one of them is silent: `setPurchaseOrderLinePrice` re-costs the
 * layers ITS OWN line opened → `restateConsumedCost` walks the slices those
 * layers gave out and moves `invoice_stock_moves.cost_total` by the delta →
 * `listWholesaleSales` reports that column. Nothing is recomputed on the way, so
 * what this screen says and what the ledger holds are the same number.
 *
 * TWO PRODUCTS ON ONE TAB, priced one at a time, is the fixture that matters. A
 * version that re-costed everything the tab touched would pass with one product
 * on it and quietly restate the other's margin in real use — which is precisely
 * the failure the ask names.
 *
 * ## And the zero in between is now SAID
 *
 * Between the sale and the pricing, the row's cost really is nothing: the layer
 * opened at a placeholder because the shop had not given a figure. That is a
 * third state — not the legacy "the layers are gone" and not a real cost — and
 * it used to print as $0.00 and a 100% margin. `costPending` marks it and names
 * the tab to go and price, and it clears itself when somebody does.
 */
{
  const SHOP10 = 'Roadshow Bexley'
  product('p_wsA', 'RS-WSA', 'Bexley Alpha Case')
  product('p_wsB', 'RS-WSB', 'Bexley Beta Case')

  const tab10 = po.createPurchaseOrder(
    {
      supplier: SHOP10,
      location: '',
      ongoing: true,
      lines: [
        { productId: 'p_wsA', quantity: 1, unitPrice: 0, pricePending: true },
        { productId: 'p_wsB', quantity: 1, unitPrice: 0, pricePending: true }
      ]
    },
    'emp_owner'
  )
  const sale10 = invoices.saveInvoice(
    {
      customerName: 'Bexley Buyer',
      invoiceNumber: 'SO-R950',
      invoiceDate: '2026-08-28',
      location: SHOP10,
      lines: [
        { item: 'Bexley Alpha Case', productId: 'p_wsA', quantity: 1, rate: 900 },
        { item: 'Bexley Beta Case', productId: 'p_wsB', quantity: 1, rate: 700 }
      ]
    },
    'emp_owner'
  )
  const wsRow = (productId: string): any =>
    invoiceStock
      .listWholesaleSales(db)
      .find((r: any) => r.invoiceId === sale10.id && r.productId === productId)

  const a0 = wsRow('p_wsA')
  const b0 = wsRow('p_wsB')
  ok(!!a0 && !!b0, 'both lines reach the Wholesale report the moment the order is saved')
  ok(
    a0.costKnown === true && a0.costPending === true && a0.cost === 0,
    'AND THE COST IS MARKED AS STILL TO COME — the layer is there, the figure is not',
    `known ${a0.costKnown} / pending ${a0.costPending} / cost ${a0.cost}`
  )
  ok(
    a0.pendingPoNumber === tab10.poNumber,
    'naming the tab to go and price, rather than leaving somebody to find it',
    String(a0.pendingPoNumber)
  )

  // -- the assertion the ask is actually about -------------------------------
  const detail10 = po.getPurchaseOrder(tab10.id)
  const lineA = detail10.lines.find((l: any) => l.productId === 'p_wsA')
  const lineB = detail10.lines.find((l: any) => l.productId === 'p_wsB')
  const pricedA = po.setPurchaseOrderLinePrice(tab10.id, lineA.id, 400, 'emp_owner')
  ok(!pricedA.error, 'the shop finally says the Alpha case was $400', String(pricedA.error))

  const a1 = wsRow('p_wsA')
  const b1 = wsRow('p_wsB')
  ok(
    a1.costPending === false && a1.cost === 400 && a1.margin === 500,
    'THE PRICED PRODUCT PICKS THE FIGURE UP — cost 400 against 900 sold, margin 500',
    `pending ${a1.costPending} / cost ${a1.cost} / margin ${a1.margin}`
  )
  ok(
    b1.costPending === true && b1.cost === 0 && b1.margin === 700,
    'AND THE OTHER ONE DOES NOT MOVE — pricing Alpha must not restate Beta, which is the whole ask',
    `pending ${b1.costPending} / cost ${b1.cost} / margin ${b1.margin}`
  )

  po.setPurchaseOrderLinePrice(tab10.id, lineB.id, 250, 'emp_owner')
  const a2 = wsRow('p_wsA')
  const b2 = wsRow('p_wsB')
  ok(
    b2.cost === 250 && b2.margin === 450 && b2.costPending === false,
    'pricing Beta then lands on Beta',
    `cost ${b2.cost} / margin ${b2.margin}`
  )
  ok(
    a2.cost === 400 && a2.margin === 500,
    'and Alpha is exactly where it was — the second pricing did not touch the first',
    `cost ${a2.cost} / margin ${a2.margin}`
  )

  // -- and the flag does not latch onto ordinary stock -----------------------
  product('p_wsC', 'RS-WSC', 'Ordinary Priced Case')
  const plain10 = po.createPurchaseOrder(
    {
      supplier: 'Cardinal Distribution',
      location: 'RM',
      lines: [{ productId: 'p_wsC', quantity: 1, unitPrice: 300 }]
    },
    'emp_owner'
  )
  po.setPurchaseOrderStatus(plain10.id, 'received', 'emp_owner')
  const plainSale = invoices.saveInvoice(
    {
      customerName: 'Ordinary Buyer',
      invoiceNumber: 'SO-R951',
      invoiceDate: '2026-08-28',
      location: 'RM',
      lines: [{ item: 'Ordinary Priced Case', productId: 'p_wsC', quantity: 1, rate: 500 }]
    },
    'emp_owner'
  )
  const plainRow = invoiceStock
    .listWholesaleSales(db)
    .find((r: any) => r.invoiceId === plainSale.id)
  ok(
    !!plainRow && plainRow.costPending === false && plainRow.pendingPoNumber === null,
    'A CASE BOUGHT AT A KNOWN PRICE IS NEVER MARKED — the flag is about the tab, not about roadshows in general',
    plainRow ? `pending ${plainRow.costPending} / ${plainRow.pendingPoNumber}` : 'no row'
  )
  ok(
    plainRow.cost === 300 && plainRow.margin === 200,
    'and it reports its real cost and margin as it always did',
    `cost ${plainRow.cost} / margin ${plainRow.margin}`
  )
}


console.log('\n=== 11. the warning is about stock STILL HERE, and nothing else ===')
// ---------------------------------------------------------------------------
/**
 * Two owner corrections, in order.
 *
 * FIRST: the warning shipped inside the empty-column branch, so the only shops
 * that said anything were the ones with nothing left to lose, and a shop holding
 * four unpriced cases was silent. "Why can not everything is showing like that,
 * it should be the same."
 *
 * THEN, once it showed everywhere: it was keyed on the TAB'S UNPRICED LINE
 * COUNT, so a shop whose only case had been bought and sold in one afternoon got
 * four lines of warning about a case that was gone. "Can you like not do the
 * warnings for anything that was sold, but rather let me click on it if it was
 * sold and then it tells me which PO and SO it was attached to."
 *
 * That is the right split. An unpriced case that has SOLD is money spent and a
 * sale booked; the board cannot undo either, and Wholesale is the screen that
 * reports it — holding those rows out of its margin totals and naming the tab.
 * What a shop board can prevent is the NEXT wrong sale, which is only ever about
 * stock still on the shelf. So the count is UNITS STANDING HERE at no price.
 */
{
  const TAB = { poNumber: 'PO-0451', orderedUnits: 4, receivedUnits: 4, pendingPriceCount: 4 }

  const held = unpricedTabWarning(TAB, 4)
  ok(
    !!held && held.includes('PO-0451') && /4 units standing here/.test(held),
    'A SHOP STILL HOLDING UNPRICED CASES IS WARNED, and the count is UNITS ON THE SHELF',
    String(held)
  )
  ok(
    !!held && /before they are sold/.test(held),
    'so the instruction is the one thing the board can still prevent',
    String(held)
  )
  ok(
    !!held && !/sold from/.test(held) && !/already made/.test(held),
    'IT NEVER CLAIMS A SALE — two cases moved to RM empty a column too',
    String(held)
  )

  ok(
    unpricedTabWarning(TAB, 0) === null,
    'THE CORRECTION: a tab whose unpriced cases have all gone says NOTHING, however many lines it still has',
    String(unpricedTabWarning(TAB, 0))
  )
  ok(
    unpricedTabWarning({ ...TAB, pendingPriceCount: 0 }, 0) === null,
    'and a fully priced week says nothing either'
  )
  ok(unpricedTabWarning(null, 5) === null, 'a shop with no tab has nothing to warn about')

  const one = unpricedTabWarning(TAB, 1)
  ok(
    !!one && /1 unit standing here has no price/.test(one) && /before it is sold/.test(one),
    'singular reads as one unit throughout',
    String(one)
  )

  // UNITS, NOT LINES. A line of six that has sold five leaves one problem, and a
  // line count would report the whole line long after most of it stopped being
  // one.
  ok(
    /1 unit/.test(String(unpricedTabWarning({ ...TAB, pendingPriceCount: 1 }, 1))),
    'the number said is the units left, not the lines on the tab',
    String(unpricedTabWarning({ ...TAB, pendingPriceCount: 1 }, 1))
  )

  ok(
    !/no price/.test(emptyShelfHeadline(TAB)),
    'THE HEADLINE SAYS NOTHING ABOUT PRICING — one answers "why is this empty" and the other "what still owes a number"',
    emptyShelfHeadline(TAB)
  )
}

console.log('\n=== 12. a tab the APP opened says so, on the tab ===')
// ---------------------------------------------------------------------------
/**
 * The owner, looking at a roadshow board where two shops he had never bought
 * anything at each held a tab with one unpriced line on it: "why are there
 * inventory items showing in California but nowhere else, that doesn't make
 * sense?"
 *
 * ## Nothing was wrong with the board. Something was missing from the record
 *
 * Writing a sales order that draws from a shop with an empty shelf BUYS the
 * shortfall onto that shop's tab and sells it in the same transaction — see
 * buyShortfallAtShop, which exists because at a counter "short" means "I bought
 * it a minute ago and have not written it down". So a tab appears, holding one
 * unpriced line, with nothing standing on the shelf, for a shop nobody
 * deliberately bought at.
 *
 * That is a REAL LIABILITY created as a side effect, and applyInvoiceStock has
 * always said so — on the SALES ORDER. Which is the wrong document: the sale is
 * the thing somebody has just written and already understands, and the
 * unexplained line turns up on the tab, a week later, when they are working out
 * what a shop is owed. Its own comment names the failure — "the first anybody
 * knows of it is an unexplained line on a week's bill" — and that is exactly
 * what happened.
 *
 * Both documents now carry it, each naming the other.
 */
{
  /**
   * ONE OF THE FOUR REAL SHOPS, and it has to be. `roadshowShopNamed` gates the
   * automatic purchase on ROADSHOW_SHOPS, so an invented name would buy nothing
   * and this section would pass by testing the wrong thing entirely — which is
   * also the reason it never fires at RM or at a supplier's address.
   *
   * Registered as a shelf first, because a sale only reaches this path when its
   * destination is a place stock can sit; opening a tab normally does that, and
   * here there is no tab yet.
   */
  const SHOP12 = 'Texas Roadshow'
  saveStockLocation({ label: SHOP12 }, 'emp_owner')
  product('p_auto', 'RS-AUT', 'Kendal Auto Case')

  const before = po.listOpenRoadshowTabs().length
  const sale12 = invoices.saveInvoice(
    {
      customerName: 'Kendal Buyer',
      invoiceNumber: 'SO-R980',
      invoiceDate: '2026-08-31',
      location: SHOP12,
      lines: [{ item: 'Kendal Auto Case', productId: 'p_auto', quantity: 2, rate: 800 }]
    },
    'emp_owner'
  )
  ok(!!sale12.id, 'a sale is written against a shop holding nothing')

  const tabs12 = po.listOpenRoadshowTabs()
  const auto = tabs12.find((t: any) => (t.supplier ?? '').toLowerCase() === SHOP12.toLowerCase())
  ok(
    tabs12.length === before + 1 && !!auto,
    'THE APP OPENED A TAB BY ITSELF — this is the shape that made no sense on the board',
    `${before} → ${tabs12.length}`
  )
  ok(
    auto.lineCount === 1 && (auto.pendingPriceCount ?? 0) === 1 && auto.total === 0,
    'one unpriced line, nothing owed yet — exactly what the card showed',
    `${auto.lineCount} / ${auto.pendingPriceCount} / ${auto.total}`
  )
  ok(
    inventory.stockAtLocation(SHOP12).length === 0,
    'and nothing is standing at the shop, because the sale consumed it in the same breath'
  )

  const poLog = orderExtras.listOrderEvents('po', auto.id).map((e: any) => String(e.detail ?? ''))
  const said = poLog.find((d: string) => /added automatically/.test(d))
  ok(
    !!said,
    'THE FIX: THE TAB ITSELF EXPLAINS WHERE ITS LINE CAME FROM — this is the document somebody opens to settle a week',
    JSON.stringify(poLog)
  )
  ok(
    !!said && said.includes('SO-R980') && said.includes(SHOP12) && /2 units/.test(said),
    'naming the sale that caused it, the shop, and how many',
    String(said)
  )
  ok(
    !!said && /price still to be entered/.test(said),
    'and saying the price is still owed, which is the thing that has to be chased'
  )

  const soLog = orderExtras.listOrderEvents('so', sale12.id).map((e: any) => String(e.detail ?? ''))
  const mirror = soLog.find((d: string) => /to fill this order/.test(d))
  ok(
    !!mirror && mirror.includes(auto.poNumber),
    'AND THE SALE STILL SAYS IT TOO, now naming the tab — either document can be read on its own',
    JSON.stringify(soLog)
  )

  // A sale off a shelf that HAS the stock buys nothing and says nothing.
  inventory.addStock('p_auto', SHOP12, 3, 250, 'bought properly this time', 'emp_owner')
  const quiet = invoices.saveInvoice(
    {
      customerName: 'Kendal Buyer',
      invoiceNumber: 'SO-R981',
      invoiceDate: '2026-08-31',
      location: SHOP12,
      lines: [{ item: 'Kendal Auto Case', productId: 'p_auto', quantity: 1, rate: 800 }]
    },
    'emp_owner'
  )
  ok(
    !orderExtras
      .listOrderEvents('so', quiet.id)
      .some((e: any) => /to fill this order/.test(String(e.detail ?? ''))),
    'A SALE THE SHELF COULD COVER SAYS NOTHING — the note marks an automatic purchase, not every roadshow sale'
  )
}


console.log('\n=== 13. taking something back off a tab, and the shop’s whole story ===')
// ---------------------------------------------------------------------------
/**
 * Two asks, one screen. The owner: "need a delete button for items added on the
 * thing" and "anything that is sold from the roadshow shops should still show up
 * on the list ... it shows me what is sold and what is what's stuck."
 *
 * ## Why there was no delete button to add
 *
 * `removePurchaseOrderLine` refuses the moment any unit has been checked in —
 * correctly, for an ordinary purchase. But a tab line is checked in the instant
 * it is typed, so that refusal fired on every line the roadshow board could
 * create and its advice was to cancel a week's trading over one wrong box.
 * `removeTabLine` reverses the receipt and removes the line together, and the
 * guard is `reverseLotReceipt` throwing on anything drawn down — a case that has
 * been SOLD cannot be un-bought, because the sale is real and its cost of goods
 * came out of that layer.
 *
 * ## Why the column could not show what sold
 *
 * It listed what was STANDING. A case bought and sold the same afternoon never
 * appeared, so a shop that had traded all day read as empty. `shopShelf` counts
 * three things from three tables — bought off the receipts, here off the shelf,
 * sold off the invoice moves — rather than one number and two subtractions,
 * because stock leaves a shelf three ways and a subtraction cannot tell a sale
 * from a case driven home.
 */
{
  const SHOP13 = 'Kentucky Roadshow'
  saveStockLocation({ label: SHOP13 }, 'emp_owner')
  product('p_keep', 'RS-KEP', 'Kentucky Keeper Case')
  product('p_oops', 'RS-OOP', 'Kentucky Mistake Case')
  product('p_gone', 'RS-GON', 'Kentucky Sold Case')

  const tab13 = po.createPurchaseOrder(
    {
      supplier: SHOP13,
      location: '',
      ongoing: true,
      lines: [
        { productId: 'p_keep', quantity: 2, unitPrice: 300 },
        { productId: 'p_oops', quantity: 1, unitPrice: 400 },
        { productId: 'p_gone', quantity: 3, unitPrice: 500 }
      ]
    },
    'emp_owner'
  )
  invoices.saveInvoice(
    {
      customerName: 'Kentucky Buyer',
      invoiceNumber: 'SO-R990',
      invoiceDate: '2026-08-31',
      location: SHOP13,
      lines: [{ item: 'Kentucky Sold Case', productId: 'p_gone', quantity: 3, rate: 900 }]
    },
    'emp_owner'
  )

  // --- the list: everything the shop dealt in, not just what is left ---------
  const shelf = prov.shopShelf(SHOP13)
  const row = (id: string): any => shelf.find((r: any) => r.productId === id)
  ok(shelf.length === 3, 'ALL THREE PRODUCTS ARE LISTED, including the one wholly sold', String(shelf.length))
  ok(
    !!row('p_gone') && row('p_gone').bought === 3 && row('p_gone').here === 0 && row('p_gone').sold === 3,
    'THE ASK: a case bought and sold at the shop still shows, and says it sold — it used to vanish entirely',
    JSON.stringify(row('p_gone'))
  )
  ok(
    row('p_keep').bought === 2 && row('p_keep').here === 2 && row('p_keep').sold === 0,
    'something untouched reads as bought and still here',
    JSON.stringify(row('p_keep'))
  )
  ok(
    shelf.every((r: any) => r.movedOn === 0),
    'and nothing is reported as having moved on, because nothing did'
  )

  // A case driven home is NOT reported as sold — the reason sold is counted.
  const drove = inv.moveStock({ productId: 'p_keep', from: SHOP13, to: 'RM', quantity: 1 }, 'emp_owner')
  ok(!drove.error, 'one keeper is driven home', String(drove.error))
  const after13 = prov.shopShelf(SHOP13).find((r: any) => r.productId === 'p_keep')
  ok(
    after13.bought === 2 && after13.here === 1 && after13.sold === 0 && after13.movedOn === 1,
    'IT COUNTS AS MOVED ON, NOT SOLD — a subtraction would have called it a sale and sent somebody looking for the money',
    JSON.stringify(after13)
  )

  // --- the delete: what can go, and what cannot ------------------------------
  const detail13 = po.getPurchaseOrder(tab13.id)
  const oopsLine = detail13.lines.find((l: any) => l.productId === 'p_oops')
  const goneLine = detail13.lines.find((l: any) => l.productId === 'p_gone')

  ok(
    !!po.removePurchaseOrderLine(tab13.id, oopsLine.id).error,
    'THE OLD DELETE STILL REFUSES IT — a tab line is always already checked in, which is why there was no button'
  )

  const removed = po.removeTabLine(tab13.id, oopsLine.id, 'emp_owner')
  ok(!removed.error, 'THE NEW ONE TAKES IT BACK', String(removed.error))
  ok(
    inv.stockQty('p_oops', SHOP13) === 0,
    'AND THE SHELF GOES BACK AS IT WAS — the receipt was reversed, not just the paperwork deleted',
    String(inv.stockQty('p_oops', SHOP13))
  )
  ok(
    !prov.shopShelf(SHOP13).some((r: any) => r.productId === 'p_oops'),
    'so it leaves the shop’s list entirely — it was never bought'
  )
  ok(
    !po.getPurchaseOrder(tab13.id).lines.some((l: any) => l.id === oopsLine.id),
    'and the line is off the tab'
  )
  ok(
    po.getPurchaseOrder(tab13.id).total === 2 * 300 + 3 * 500,
    'the tab’s total drops by exactly what that line was worth',
    String(po.getPurchaseOrder(tab13.id).total)
  )

  const sold13 = po.removeTabLine(tab13.id, goneLine.id, 'emp_owner')
  ok(
    !!sold13.error && /already been sold/.test(String(sold13.error)),
    'A LINE WHOSE CASES ARE SOLD IS REFUSED — the sale is real and its cost came out of that layer',
    String(sold13.error)
  )
  ok(
    po.getPurchaseOrder(tab13.id).lines.some((l: any) => l.id === goneLine.id),
    'and the refusal changed nothing'
  )
  assertStockLotsConsistent(db)
  ok(true, 'the stock/lot invariant survived the removal')

  // A settled week is history.
  const keepLine = po.getPurchaseOrder(tab13.id).lines.find((l: any) => l.productId === 'p_keep')
  po.setPurchaseOrderLinePrice(tab13.id, keepLine.id, 300, 'emp_owner')
  po.closeRoadshowTab(tab13.id, 'emp_owner')
  const shut = po.removeTabLine(tab13.id, keepLine.id, 'emp_owner')
  ok(
    !!shut.error && /settled/.test(String(shut.error)),
    'AND A SETTLED TAB REFUSES TOO — the bill was paid on the strength of what was on it',
    String(shut.error)
  )
}


console.log('\n=== 14. click a sold case and it names the PO and the SO ===')
// ---------------------------------------------------------------------------
/**
 * The owner: "let me click on it if it was sold and then it tells me which PO
 * and SO it was attached to."
 *
 * The panel could already say which purchase order a case came IN on and had
 * nothing at all about where it went — so the ordinary roadshow case, bought and
 * sold in one afternoon, left two documents and no way to get from the shelf to
 * either. `shopSales` is the other half.
 *
 * Also pins `unpricedHere`, which is what the column's warning now counts. It
 * comes off the LAYERS rather than the tab's lines, because a line of six that
 * has sold five leaves one unpriced unit standing and a line count cannot say
 * so.
 */
{
  const SHOP14 = 'California Roadshow'
  saveStockLocation({ label: SHOP14 }, 'emp_owner')
  product('p_trail', 'RS-TRL', 'California Trail Case')

  const tab14 = po.createPurchaseOrder(
    {
      supplier: SHOP14,
      location: '',
      ongoing: true,
      lines: [{ productId: 'p_trail', quantity: 6, unitPrice: 0, pricePending: true }]
    },
    'emp_owner'
  )
  const before14 = prov.shopShelf(SHOP14).find((r: any) => r.productId === 'p_trail')
  ok(
    before14.unpricedHere === 6,
    'six unpriced cases are standing at the shop, and the shelf count knows it',
    JSON.stringify(before14)
  )
  ok(
    prov.shopSales(SHOP14, 'p_trail').length === 0,
    'and nothing has been sold from it yet'
  )

  const sale14 = invoices.saveInvoice(
    {
      customerName: 'Trail Buyer',
      invoiceNumber: 'SO-R995',
      invoiceDate: '2026-09-01',
      location: SHOP14,
      lines: [{ item: 'California Trail Case', productId: 'p_trail', quantity: 5, rate: 800 }]
    },
    'emp_owner'
  )

  const went = prov.shopSales(SHOP14, 'p_trail')
  ok(went.length === 1, 'THE SALE IS FOUND from the shelf', JSON.stringify(went))
  ok(
    went[0].invoiceNumber === 'SO-R995' &&
      went[0].customerName === 'Trail Buyer' &&
      went[0].quantity === 5,
    'naming the sales order, the buyer and how many THIS shop supplied',
    JSON.stringify(went[0])
  )
  const buys14 = prov.shopBuys(SHOP14, 'p_trail')
  ok(
    buys14.length === 1 && buys14[0].poNumber === po.getPurchaseOrder(tab14.id).poNumber,
    'AND THE PURCHASE ORDER IS STILL THERE BESIDE IT — both ends of the case, from one click',
    JSON.stringify(buys14.map((b: any) => b.poNumber))
  )

  // UNITS, NOT LINES: one line, five sold, ONE still unpriced on the shelf.
  const after14 = prov.shopShelf(SHOP14).find((r: any) => r.productId === 'p_trail')
  ok(
    after14.unpricedHere === 1 && after14.here === 1 && after14.sold === 5,
    'ONE unpriced unit is left standing, not "one unpriced line" covering six — that is why the warning counts layers',
    JSON.stringify(after14)
  )
  ok(
    /1 unit standing here/.test(
      String(
        unpricedTabWarning(
          { poNumber: 'PO-X', orderedUnits: 6, receivedUnits: 6, pendingPriceCount: 1 },
          after14.unpricedHere
        )
      )
    ),
    'so the column warns about the one, not the six'
  )

  // A PRICED CASE STANDING BESIDE AN UNPRICED ONE IS NOT A PROBLEM, and this is
  // the only arrangement that proves the filter is doing anything: without the
  // price-pending test, unpricedHere would simply be "what is on the shelf" and
  // the column would nag about stock whose cost is perfectly well known.
  product('p_known', 'RS-KNW', 'California Known Case')
  po.createPurchaseOrder(
    {
      supplier: SHOP14,
      location: '',
      ongoing: true,
      lines: [{ productId: 'p_known', quantity: 3, unitPrice: 275 }]
    },
    'emp_owner'
  )
  const known = prov.shopShelf(SHOP14).find((r: any) => r.productId === 'p_known')
  ok(
    known.here === 3 && known.unpricedHere === 0,
    'THREE CASES AT A KNOWN PRICE COUNT AS NONE UNPRICED — the filter is on the line’s price, not on the shelf',
    JSON.stringify(known)
  )
  const mixed = prov
    .shopShelf(SHOP14)
    .reduce((n: number, r: any) => n + r.unpricedHere, 0)
  ok(
    mixed === 1,
    'so a shop holding one unpriced case and three priced ones warns about ONE',
    String(mixed)
  )
  ok(
    /1 unit standing here/.test(
      String(
        unpricedTabWarning(
          { poNumber: 'PO-X', orderedUnits: 9, receivedUnits: 9, pendingPriceCount: 1 },
          mixed
        )
      )
    ),
    'and says so in those words'
  )

  // A SALE FROM ANOTHER SHELF IS NOT THIS SHOP'S. The move puts a case at RM;
  // selling it there must not appear on the shop's trail.
  inv.moveStock({ productId: 'p_trail', from: SHOP14, to: 'RM', quantity: 1 }, 'emp_owner')
  invoices.saveInvoice(
    {
      customerName: 'Home Buyer',
      invoiceNumber: 'SO-R996',
      invoiceDate: '2026-09-01',
      location: 'RM',
      lines: [{ item: 'California Trail Case', productId: 'p_trail', quantity: 1, rate: 800 }]
    },
    'emp_owner'
  )
  const still = prov.shopSales(SHOP14, 'p_trail')
  ok(
    still.length === 1 && still.every((x: any) => x.invoiceNumber !== 'SO-R996'),
    'A CASE DRIVEN HOME AND SOLD FROM RM IS NOT ON THE SHOP’S TRAIL — the move row is keyed on the shelf it actually left from',
    JSON.stringify(still.map((x: any) => x.invoiceNumber))
  )
  const end14 = prov.shopShelf(SHOP14).find((r: any) => r.productId === 'p_trail')
  ok(
    end14.sold === 5 && end14.movedOn === 1 && end14.here === 0,
    'and the shop’s own row reads five sold, one moved on, none left',
    JSON.stringify(end14)
  )
  ok(
    unpricedTabWarning(
      { poNumber: 'PO-X', orderedUnits: 6, receivedUnits: 6, pendingPriceCount: 1 },
      end14.unpricedHere
    ) === null,
    'AND THE COLUMN FALLS SILENT — nothing unpriced is standing there any more, whatever the tab still says'
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
