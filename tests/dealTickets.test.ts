/**
 * Deal tickets — one number per commercial movement, struck automatically.
 *
 * What is pinned here, and how each one fails if it is wrong:
 *
 *   1. THE FIRST NUMBER IS DT-000337. The business has been keeping this
 *      register by hand and has reached 336. Off by one in either direction and
 *      the app's register either duplicates a number the operator's own book has
 *      already spent, or skips one and can never explain the gap.
 *
 *   2. HISTORY IS NOT BACKFILLED. Orders that existed before the register did
 *      get nothing. Backfilling would mint DT-000337 onto a purchase order the
 *      operator's book already calls something else, producing two registers
 *      over the same period that disagree.
 *
 *   3. ONE TICKET PER DOCUMENT, FOR EVER. `saveInvoice` is one INSERT ... ON
 *      CONFLICT statement that runs on every keystroke-save of a draft. If issue
 *      were not idempotent, a draft edited five times would burn five numbers
 *      and the same deal would answer to five names.
 *
 *   4. THE NUMBER SURVIVES BEING PAIRED. Linking a purchase order to a sales
 *      order as a dropship changes both tickets' KIND and nothing else.
 *      Re-issuing would move a number that may already be written on paperwork.
 *
 *   5. THE COUNTER IS A FLOOR, NOT A COUNT. Deleting the newest ticket must not
 *      let the next issue hand its number out again — that is the one failure
 *      that puts two different deals under one name with nothing to detect it.
 *
 *   6. A TICKET OUTLIVES ITS DOCUMENT. Deleting the order leaves the ticket, and
 *      the register reports the document as gone rather than dropping the row —
 *      a sequence with an unexplained hole is worse than a spent number.
 *
 *   7. A PURCHASE ORDER IS NEVER FAILED BY THE REGISTER. Issuing swallows, so a
 *      broken numbering table costs a ticket and not somebody's ability to buy
 *      stock.
 *
 * Run: npm run test:deal-tickets
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/deal-tickets-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb, getMeta } = require('../src/main/db/database')
const poRepo = require('../src/main/db/purchaseOrders')
const invRepo = require('../src/main/db/invoices')
const tickets = require('../src/main/db/dealTickets')
const {
  DEAL_TICKET_FIRST,
  DEAL_TICKET_FLOOR,
  dealTicketMatches,
  dealTicketSide,
  describeDealTicketKind,
  dropshipKindFor,
  formatDealTicket,
  isDropshipKind,
  parseDealTicketSeq,
  summariseDealTickets
} = require('../src/shared/dealTickets')

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

const ACTOR = 'emp_owner'

const mkProduct = (id: string, name: string, sku: string): void => {
  db.prepare(
    `INSERT INTO inventory_products (id, name, sku, category, unit_cost, created_at, updated_at)
     VALUES (?, ?, ?, 'Baseball', 0, '2026-03-01T12:00:00.000Z', '2026-03-01T12:00:00.000Z')`
  ).run(id, name, sku)
}
mkProduct('p_dt1', 'Ticket Case One', 'DTK-001')
mkProduct('p_dt2', 'Ticket Case Two', 'DTK-002')

const ticketFor = (kind: 'po' | 'so', id: string): Record<string, unknown> | undefined =>
  db.prepare(`SELECT * FROM deal_tickets WHERE document_kind = ? AND document_id = ?`).get(kind, id)

const ticketCount = (): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM deal_tickets`).get() as { n: number }).n

const makePo = (supplier: string, qty = 2, price = 100): string =>
  poRepo.createPurchaseOrder(
    {
      supplier,
      location: 'RM',
      lines: [{ productId: 'p_dt1', item: 'Ticket Case One', quantity: qty, unitPrice: price }]
    },
    ACTOR
  ).id

const makeSo = (customer: string, qty = 1, rate = 500): string =>
  invRepo.saveInvoice(
    {
      customerName: customer,
      invoiceDate: '2026-08-19',
      lines: [
        { item: 'Ticket Case Two', productId: 'p_dt2', quantity: qty, rate, destination: 'RM' }
      ]
    },
    ACTOR
  ).id

// ---------------------------------------------------------------------------
console.log('\n=== 1. the format, and the number the register starts at ===')
// ---------------------------------------------------------------------------

ok(DEAL_TICKET_FIRST === 337, 'the first number the app issues is 337')
ok(DEAL_TICKET_FLOOR === 336, 'so the counter believes 336 are already spent')
ok(formatDealTicket(337) === 'DT-000337', 'formatted as DT-000337', formatDealTicket(337))
ok(formatDealTicket(1) === 'DT-000001', 'padded to six digits', formatDealTicket(1))
ok(formatDealTicket(1000000) === 'DT-1000000', 'and past a million it widens rather than truncating')
ok(parseDealTicketSeq('DT-000337') === 337, 'parsed back to the integer')
ok(parseDealTicketSeq('  dt-000412 ') === 412, 'case and space tolerant, for a pasted number')
ok(parseDealTicketSeq('337') === null, 'a bare number is NOT a ticket — it is far more likely a PO')
ok(parseDealTicketSeq('PO-0042') === null, 'and neither is a purchase order number')

// The padding is what makes a string sort a numeric sort, which is what the
// register's ORDER BY relies on. Asserted rather than assumed.
const sorted = [337, 1000, 99999, 340].map(formatDealTicket).sort()
ok(
  sorted.join(',') === 'DT-000337,DT-000340,DT-001000,DT-099999',
  'zero-padding makes the string order the numeric order',
  sorted.join(',')
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. the register starts empty — history is not backfilled ===')
// ---------------------------------------------------------------------------

ok(ticketCount() === 0, 'a fresh database has issued nothing', String(ticketCount()))
ok(
  getMeta(db, 'deal_ticket_seq') === String(DEAL_TICKET_FLOOR),
  'and the counter is seeded at the floor',
  String(getMeta(db, 'deal_ticket_seq'))
)
ok(tickets.peekNextDealTicket() === 'DT-000337', 'so the next one will be DT-000337')
ok(
  tickets.peekNextDealTicket() === 'DT-000337',
  'and peeking twice does not advance it — a peek must not spend a number'
)

// ---------------------------------------------------------------------------
console.log('\n=== 3. a purchase order strikes one, in its own transaction ===')
// ---------------------------------------------------------------------------

const po1 = makePo('Steel City')
const t1 = ticketFor('po', po1)
ok(!!t1, 'raising a purchase order issued a ticket')
ok(t1?.number === 'DT-000337', 'and it is the first one', String(t1?.number))
ok(t1?.kind === 'purchase_order', 'kind names the movement', String(t1?.kind))
ok(t1?.party === 'Steel City', 'the supplier is snapshotted onto it', String(t1?.party))
ok(Number(t1?.amount) === 200, 'so is the total', String(t1?.amount))
ok(t1?.document_kind === 'po' && t1?.document_id === po1, 'and it points at the order')

const poRow = db.prepare(`SELECT po_number FROM purchase_orders WHERE id = ?`).get(po1) as {
  po_number: string
}
ok(
  t1?.document_number === poRow.po_number,
  'the PO number is snapshotted too, so a sync relabel cannot rewrite history',
  `${t1?.document_number} vs ${poRow.po_number}`
)

// ---------------------------------------------------------------------------
console.log('\n=== 4. a sales order strikes the next one, on FIRST save only ===')
// ---------------------------------------------------------------------------

const so1 = makeSo('Fenwick Cards')
const t2 = ticketFor('so', so1)
ok(!!t2, 'raising a sales order issued a ticket')
ok(t2?.number === 'DT-000338', 'the sequence is shared across both sides', String(t2?.number))
ok(t2?.kind === 'sales_order', 'and the kind says which side it was', String(t2?.kind))
ok(t2?.party === 'Fenwick Cards', 'the buyer is snapshotted', String(t2?.party))

// THE ONE THAT MATTERS. saveInvoice runs on every save of a draft.
invRepo.saveInvoice(
  {
    id: so1,
    customerName: 'Fenwick Cards',
    invoiceDate: '2026-08-19',
    lines: [
      { item: 'Ticket Case Two', productId: 'p_dt2', quantity: 3, rate: 500, destination: 'RM' }
    ]
  },
  ACTOR
)
const t2again = ticketFor('so', so1)
ok(ticketCount() === 2, 're-saving the draft did NOT strike a second ticket', String(ticketCount()))
ok(t2again?.number === 'DT-000338', 'and the number it already had is unchanged')
ok(
  tickets.peekNextDealTicket() === 'DT-000339',
  'so the next number is still 339, not 340 — no number was burned',
  tickets.peekNextDealTicket()
)

// Calling the issuer directly a second time is the same guarantee from below.
const direct = tickets.issueDealTicket(db, {
  kind: 'sales_order',
  documentKind: 'so',
  documentId: so1,
  party: 'Someone Else'
})
ok(direct?.number === 'DT-000338', 'issuing again hands back the existing ticket', String(direct?.number))
ok(ticketCount() === 2, 'and writes nothing', String(ticketCount()))

// ---------------------------------------------------------------------------
console.log('\n=== 5. the two halves of a dropship keep their numbers ===')
// ---------------------------------------------------------------------------

const po2 = makePo('Wholesale Partner')
const so2 = makeSo('Corner Card Shop')
const beforeBuy = ticketFor('po', po2)?.number
const beforeSell = ticketFor('so', so2)?.number
ok(beforeBuy === 'DT-000339' && beforeSell === 'DT-000340', 'both were struck as ordinary movements')

const linked = invRepo.linkDropshipPair(po2, so2, ACTOR)
ok(linked.ok === true, 'the two documents linked', linked.error ?? '')

const buy = ticketFor('po', po2)
const sell = ticketFor('so', so2)
ok(buy?.number === beforeBuy, 'the purchase ticket kept its number', String(buy?.number))
ok(sell?.number === beforeSell, 'and so did the sales ticket', String(sell?.number))
ok(buy?.kind === 'dropship_purchase', 'the buy half is now a dropship', String(buy?.kind))
ok(sell?.kind === 'dropship_sale', 'and so is the sell half', String(sell?.kind))
ok(buy?.paired_ticket_id === sell?.id, 'they point at each other')
ok(sell?.paired_ticket_id === buy?.id, 'from both sides')
ok(ticketCount() === 4, 'and pairing minted nothing new', String(ticketCount()))

// Idempotent: linking is a fact, not an event.
invRepo.linkDropshipPair(po2, so2, ACTOR)
ok(ticketCount() === 4, 're-linking changes nothing', String(ticketCount()))
ok(ticketFor('po', po2)?.number === beforeBuy, 'and still nothing about the number')

ok(dropshipKindFor('purchase_order') === 'dropship_purchase', 'the kind mapping, buy side')
ok(dropshipKindFor('sales_order') === 'dropship_sale', 'the kind mapping, sell side')
ok(dropshipKindFor('dropship_sale') === 'dropship_sale', 'and it is idempotent')

// ---------------------------------------------------------------------------
console.log('\n=== 6. which way the goods moved ===')
// ---------------------------------------------------------------------------

ok(dealTicketSide('purchase_order') === 'in', 'a purchase brings goods in')
ok(dealTicketSide('dropship_purchase') === 'in', 'so does the buy half of a dropship')
ok(dealTicketSide('sales_order') === 'out', 'a sale sends them out')
ok(dealTicketSide('dropship_sale') === 'out', 'so does the sell half')
ok(isDropshipKind('dropship_purchase') && isDropshipKind('dropship_sale'), 'both halves read as dropship')
ok(!isDropshipKind('purchase_order') && !isDropshipKind('sales_order'), 'the plain kinds do not')
ok(describeDealTicketKind('dropship_sale') === 'Dropship — sold', 'and each kind has a label')

// ---------------------------------------------------------------------------
console.log('\n=== 7. the counter is a FLOOR — a deleted ticket does not come back ===')
// ---------------------------------------------------------------------------

const highest = tickets.peekNextDealTicket()
ok(highest === 'DT-000341', 'four issued, so the next is 341', highest)

// Delete the newest outright. A naive MAX() would now hand 341 back out twice.
db.prepare(`DELETE FROM deal_tickets WHERE number = 'DT-000340'`).run()
ok(ticketCount() === 3, 'one ticket removed', String(ticketCount()))
ok(
  tickets.peekNextDealTicket() === 'DT-000341',
  'the next number is STILL 341 — the counter, not the table, is the floor',
  tickets.peekNextDealTicket()
)

const po3 = makePo('After The Delete')
ok(
  ticketFor('po', po3)?.number === 'DT-000341',
  'and the order raised next got 341, not a reused number',
  String(ticketFor('po', po3)?.number)
)

// The other direction: a row arriving from ANOTHER machine through sync advances
// the ceiling without touching this machine's counter, and the next issue must
// land above it.
db.prepare(
  `INSERT INTO deal_tickets
     (id, number, kind, document_kind, document_id, document_number, party, amount,
      paired_ticket_id, issued_at, issued_by, created_at, updated_at)
   VALUES ('dt_from_elsewhere', 'DT-000900', 'purchase_order', 'po', 'po_elsewhere',
           'PO-9000', 'Other Laptop', 10, NULL,
           '2026-08-19T12:00:00.000Z', NULL, '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:00.000Z')`
).run()
ok(
  tickets.peekNextDealTicket() === 'DT-000901',
  'a ticket synced in from another machine raises the ceiling',
  tickets.peekNextDealTicket()
)
const po4 = makePo('After The Sync')
ok(
  ticketFor('po', po4)?.number === 'DT-000901',
  'so the next issue lands above it rather than colliding',
  String(ticketFor('po', po4)?.number)
)

// ---------------------------------------------------------------------------
console.log('\n=== 8. a ticket outlives the document it names ===')
// ---------------------------------------------------------------------------

const doomed = makePo('Cancelled Deal')
const doomedTicket = ticketFor('po', doomed)?.number
ok(!!doomedTicket, 'the order was raised with a ticket')

poRepo.deletePurchaseOrder(doomed, ACTOR)
const orderGone =
  db.prepare(`SELECT COUNT(*) AS n FROM purchase_orders WHERE id = ?`).get(doomed).n === 0
ok(orderGone, 'the purchase order was deleted')
ok(!!ticketFor('po', doomed), 'the ticket is STILL there — a spent number stays spent')

const listed = tickets.listDealTickets(2026)
const orphan = listed.find((r: Record<string, unknown>) => r.number === doomedTicket)
ok(!!orphan, 'and the register still lists it')
ok(orphan?.documentMissing === true, 'flagged as a document that is gone')
ok(orphan?.liveNumber === null, 'with no live number to show')
ok(orphan?.liveStatus === null, 'and no live stage')
ok(
  orphan?.amount > 0,
  'but the snapshot amount survives, so the row still says what the deal was worth',
  String(orphan?.amount)
)

// A live order reads the other way round.
const live = listed.find((r: Record<string, unknown>) => r.documentId === po1)
ok(live?.documentMissing === false, 'a live order is not flagged missing')
ok(!!live?.liveNumber, 'and its current number is joined in', String(live?.liveNumber))
ok(live?.liveStatus === 'ordered', 'along with its current stage', String(live?.liveStatus))

// An unposted sales order carries a NULL invoice_number. That is a present
// document with no number yet — not a deleted one, and the two must not be
// confused. This is the assertion that pins the difference.
const unposted = listed.find((r: Record<string, unknown>) => r.documentId === so1)
ok(!!unposted, 'the draft sales order is in the register')
ok(
  unposted?.documentMissing === false,
  'a draft with no invoice number is NOT reported as deleted',
  String(unposted?.documentMissing)
)

// ---------------------------------------------------------------------------
console.log('\n=== 9. the register reads newest first, and totals both ways ===')
// ---------------------------------------------------------------------------

const all = tickets.listDealTickets(null)
const seqs = all.map((r: { seq: number }) => r.seq)
const descending = seqs.every((s: number, i: number) => i === 0 || seqs[i - 1] >= s)
ok(descending, 'newest ticket first', seqs.join(','))
ok(
  all.every((r: { seq: number; number: string }) => formatDealTicket(r.seq) === r.number),
  'and every row s seq agrees with its own label'
)

const sum = summariseDealTickets(all)
ok(sum.count === all.length, 'the summary counts what it was given')
ok(sum.first === formatDealTicket(Math.min(...seqs)), 'and names the lowest', String(sum.first))
ok(sum.last === formatDealTicket(Math.max(...seqs)), 'and the highest', String(sum.last))
ok(sum.inbound > 0 && sum.outbound > 0, 'with money split by direction', `${sum.inbound}/${sum.outbound}`)

// The split must follow the KIND, not the table the row came from — which is
// the whole point of the dropship kinds existing.
const onlySell = summariseDealTickets(
  all.filter((r: { kind: string }) => dealTicketSide(r.kind) === 'out')
)
ok(onlySell.inbound === 0, 'sell-side rows contribute nothing inbound', String(onlySell.inbound))

// ---------------------------------------------------------------------------
console.log('\n=== 10. searching the register ===')
// ---------------------------------------------------------------------------

const row = all.find((r: { documentId: string }) => r.documentId === po1)
ok(dealTicketMatches(row, ''), 'an empty query matches everything')
ok(dealTicketMatches(row, 'DT-000337'), 'found by its ticket number')
ok(dealTicketMatches(row, 'dt-000337'), 'case insensitively')
ok(dealTicketMatches(row, 'steel'), 'found by the party')
ok(dealTicketMatches(row, row.liveNumber ?? ''), 'and by the order number')
ok(!dealTicketMatches(row, 'nothing like this'), 'and not found by something else')

// ---------------------------------------------------------------------------
console.log('\n=== 11. the register can never fail a purchase ===')
// ---------------------------------------------------------------------------

// Hand the issuer a document id it cannot use. It must decline rather than throw
// — the caller is inside the transaction that is creating a real order.
let threw = false
let out: unknown = 'not called'
try {
  out = tickets.issueDealTicket(db, {
    kind: 'purchase_order',
    documentKind: 'po',
    documentId: '   '
  })
} catch {
  threw = true
}
ok(!threw, 'a blank document id does not throw')
ok(out === null, 'it reports nothing issued', String(out))

// And the real proof: break the table underneath it and raise an order anyway.
db.exec(`ALTER TABLE deal_tickets RENAME TO deal_tickets_hidden`)
let poDespite: string | null = null
let brokeTheBuy = false
try {
  poDespite = makePo('Register Is Broken')
} catch {
  brokeTheBuy = true
}
db.exec(`ALTER TABLE deal_tickets_hidden RENAME TO deal_tickets`)
ok(!brokeTheBuy, 'a broken register did NOT stop a purchase order being raised')
ok(
  !!poDespite &&
    db.prepare(`SELECT COUNT(*) AS n FROM purchase_orders WHERE id = ?`).get(poDespite).n === 1,
  'and the order is really there'
)
ok(!ticketFor('po', poDespite as string), 'it simply has no ticket, which is the cheaper loss')

// markDropshipPair is held to the same standard.
let pairThrew = false
try {
  tickets.markDropshipPair(db, 'no_such_po', 'no_such_invoice')
} catch {
  pairThrew = true
}
ok(!pairThrew, 'pairing two documents that have no tickets does not throw')

// ---------------------------------------------------------------------------
console.log('\n=== 12. the year filter ===')
// ---------------------------------------------------------------------------

const years = tickets.dealTicketYears()
ok(years.includes(2026), 'the year the tickets were issued in is listed', years.join(','))
ok(
  years.includes(new Date().getFullYear()),
  'and the current year is always listed, so the tab opens on something'
)
ok(
  years.every((y: number, i: number) => i === 0 || years[i - 1] >= y),
  'newest year first',
  years.join(',')
)
ok(tickets.listDealTickets(1999).length === 0, 'a year with nothing in it is empty')
ok(tickets.listDealTickets(null).length >= 4, 'and null means the whole register')

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
