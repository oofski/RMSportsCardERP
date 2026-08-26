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
const {
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
const opened = po.openRoadshowTab('Roadshow Dallas', 'RM', 'emp_owner')
ok(!opened.error, 'a tab opens with Roadshow Dallas', String(opened.error))
const tabId = opened.po.id
ok(!!opened.po.tabOpenedAt && !opened.po.tabClosedAt, 'and it is running')
ok(opened.po.lineCount === 0, 'EMPTY ON PURPOSE — a tab grows all week and starts with nothing on it')
ok(opened.po.status === 'ordered', 'it is an ordinary purchase order in Ordered, not a fifth status')

const again = po.openRoadshowTab('roadshow dallas', 'RM', 'emp_owner')
ok(
  again.po.id === tabId,
  'PRESSING THE BUTTON AGAIN FINDS THE SAME TAB, case and all — a second would split a week across two amounts owed',
  `${again.po.id} vs ${tabId}`
)
const other = po.openRoadshowTab('Roadshow Tulsa', 'RM', 'emp_owner')
ok(other.po.id !== tabId, 'a different shop gets its own tab')

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
  'both shops with a tab running are listed, oldest first',
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
const grouped = po.openRoadshowTab('Roadshow Amarillo', 'RM', 'emp_owner')
po.addPurchaseOrderLines(grouped.po.id, [{ productId: 'p_tue', quantity: 1, unitPrice: 110 }])
const groupedTicket = db
  .prepare(`SELECT id FROM deal_tickets WHERE document_kind = 'po' AND document_id = ?`)
  .get(grouped.po.id) as any
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
invoices.linkDropshipPair(grouped.po.id, offGrouped.id, 'emp_owner')
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

const wichita = po.openRoadshowTab('Roadshow Wichita', 'RM', 'emp_owner')
po.addPurchaseOrderLines(wichita.po.id, [{ productId: 'p_tue', quantity: 1, unitPrice: 150 }])
const stolen = invoices.linkDropshipPair(wichita.po.id, claimed.id, 'emp_owner')
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

const fresh = po.openRoadshowTab('Roadshow Dallas', 'RM', 'emp_owner')
ok(
  fresh.po.id !== tabId,
  'PRESSING THE BUTTON AGAIN NOW STARTS A NEW WEEK — find-or-create only ever finds an OPEN one',
  `${fresh.po.id} vs ${tabId}`
)

const noName = po.openRoadshowTab('  ', 'RM', 'emp_owner')
ok(!!noName.error, 'and a tab with nobody on the other side of it is refused')

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

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
