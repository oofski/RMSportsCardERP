/**
 * The owner's board, and the inbox that feeds it.
 *
 * The board reads six subsystems and owns none of them, so the thing worth
 * testing is not the arithmetic — each module already has that — but the
 * seams: that a section the caller cannot see comes back NULL rather than
 * zero, that the figures agree with the module they are summarising, and that
 * the inbox is asymmetric in the direction it is supposed to be.
 *
 * Run: npm run test:owner
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/owner-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const owner = require('../src/main/db/ownerDashboard')
const reminders = require('../src/main/db/reminders')
const todos = require('../src/main/db/todos')
const { sortReminders, validateReminder, REMINDER_MAX_LENGTH } = require('../src/shared/ownerDashboard')
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

const ALL = {
  finance: true,
  invoicing: true,
  inventory: true,
  streaming: true,
  fulfillment: true,
  hours: true
}
const NONE = {
  finance: false,
  invoicing: false,
  inventory: false,
  streaming: false,
  fulfillment: false,
  hours: false
}

// ---------------------------------------------------------------------------
console.log('=== 1. permissions decide what exists, not what is zero ===')
// ---------------------------------------------------------------------------
// A zero is a claim about the business. "You cannot see this" is not, and the
// two must never render the same.
const blind = owner.getOwnerBoard(NONE)
ok(blind.whatnot === null, 'no finance -> no Whatnot section')
ok(blind.wholesale === null, 'no finance -> no wholesale section')
ok(blind.receivables === null, 'no finance -> no money-in section')
ok(blind.payables === null, 'no invoicing -> no payables')
ok(blind.inventory === null, 'no inventory -> no stock')
ok(blind.schedule === null, 'no streaming -> no shows')
ok(typeof blind.generatedAt === 'string' && blind.generatedAt.length > 0, 'but it still says when')

const full = owner.getOwnerBoard(ALL)
ok(full.payables !== null, 'with invoicing, payables exist')
ok(full.inventory !== null, 'with inventory, stock exists')
ok(full.schedule !== null, 'with streaming, shows exist')

// ---------------------------------------------------------------------------
console.log('\n=== 2. an empty install reads as empty, not as broken ===')
// ---------------------------------------------------------------------------
ok(full.payables.count === 0, 'nothing to pay', String(full.payables?.count))
ok(full.payables.total === 0, 'and nothing owed', String(full.payables?.total))
ok(Array.isArray(full.schedule) && full.schedule.length === 0, 'no shows scheduled')
ok(full.inventory !== null && full.inventory.stockValue >= 0, 'stock value is a number')
ok(
  full.inventory !== null && full.inventory.supplyNegativeCount === 0,
  'and nothing is below zero yet'
)

// ---------------------------------------------------------------------------
console.log('\n=== 3. payables are real purchase orders, oldest first ===')
// ---------------------------------------------------------------------------
const po = require('../src/main/db/purchaseOrders')
const inventory = require('../src/main/db/inventory')
let sku = 0
const product = inventory.createProduct(
  {
    name: 'Owner Board Test Box',
    category: 'Baseball',
    sku: `OB${++sku}`,
    upc: null,
    brand: '',
    setName: '',
    year: '',
    unitType: 'box',
    boxesPerCase: null,
    packsPerBox: null,
    giveawayItem: false,
    unitCost: 100,
    highBid: null,
    salePrice: 0,
    reorderPoint: 0,
    notes: null
  },
  null
)
const made = po.createPurchaseOrder(
  {
    supplier: 'Test Distributor',
    notes: null,
    location: 'RM',
    lines: [{ productId: product.id, quantity: 2, unitPrice: 250 }]
  },
  null
)
ok(!!made?.id, 'a purchase order was created', JSON.stringify(Object.keys(made ?? {})))

const withPo = owner.getOwnerBoard(ALL)
ok(withPo.payables.count === 1, 'it shows as one payable', String(withPo.payables?.count))
ok(withPo.payables.total === 500, 'at its real total', String(withPo.payables?.total))
ok(
  withPo.payables.items[0].supplier === 'Test Distributor',
  'naming the supplier',
  String(withPo.payables?.items?.[0]?.supplier)
)
ok(withPo.payables.items[0].ageDays >= 0, 'with an age to chase it by')

// Paying it takes it off the list — the board must follow the module.
po.setPurchaseOrderStatus(made.id, 'paid', null)
const paid = owner.getOwnerBoard(ALL)
ok(paid.payables.count === 0, 'paying it clears the payable', String(paid.payables?.count))

// ---------------------------------------------------------------------------
console.log('\n=== 4. a supply below zero is flagged, not counted as low ===')
// ---------------------------------------------------------------------------
// Below zero only happens because the shipping checklist deducts past empty on
// purpose, so it is a count somebody has to fix rather than a reorder prompt.
const supplies = require('../src/main/db/supplies')
const s = supplies.createSupply(
  {
    name: 'Owner board sleeves',
    unit: 'each',
    unitCost: 0.01,
    itemsPerUnit: 1,
    reorderPoint: 0,
    recurring: false,
    notes: null,
    openingQuantity: 10
  },
  null
)
getDb().prepare('UPDATE supplies SET quantity = -5 WHERE id = ?').run(s.id)
const neg = owner.getOwnerBoard(ALL)
ok(neg.inventory.supplyNegativeCount === 1, 'the negative supply is counted', String(neg.inventory?.supplyNegativeCount))

// ---------------------------------------------------------------------------
console.log('\n=== 5. the inbox ===')
// ---------------------------------------------------------------------------
ok(validateReminder({ body: '' }) !== null, 'an empty reminder is refused')
ok(validateReminder({ body: '   ' }) !== null, 'and so is whitespace')
ok(validateReminder({ body: 'x'.repeat(REMINDER_MAX_LENGTH + 1) }) !== null, 'and an essay')
ok(validateReminder({ body: 'Order more sleeves' }) === null, 'a real one is accepted')
ok(validateReminder({ body: 'ok', dueDate: 'Friday' }) !== null, 'a due date must be a real date')
ok(validateReminder({ body: 'ok', dueDate: '2026-09-01' }) === null, 'an ISO due date is fine')

const r1 = reminders.createReminder({ body: 'Order more team bags' }, null)
ok(!!r1.reminder, 'a reminder can be sent', JSON.stringify(r1.error))
ok(r1.reminder.status === 'open', 'and lands open')
const r2 = reminders.createReminder({ body: 'Printer is jammed', urgent: true }, null)
ok(r2.reminder.urgent === true, 'urgent survives the round trip')

ok(reminders.countOpenReminders().open === 2, 'two open', String(reminders.countOpenReminders().open))
ok(reminders.countOpenReminders().urgent === 1, 'one of them urgent')

// Ticking one off is reversible — somebody who clears the wrong one has to be
// able to put it back, which is also why done reminders linger in the list.
reminders.setReminderStatus(r1.reminder.id, 'done', null)
ok(reminders.getReminder(r1.reminder.id).status === 'done', 'it can be ticked off')
ok(reminders.countOpenReminders().open === 1, 'and the open count drops')
ok(reminders.listReminders().length === 2, 'while still being visible')
reminders.setReminderStatus(r1.reminder.id, 'open', null)
ok(reminders.getReminder(r1.reminder.id).status === 'open', 'and put back again')

// ---------------------------------------------------------------------------
console.log('\n=== 6. the order the inbox reads in ===')
// ---------------------------------------------------------------------------
// Oldest first, so nothing falls off the bottom — the opposite of a chat log.
const now = new Date('2026-08-01T12:00:00Z').getTime()
const mkR = (id: string, over: Record<string, unknown>): Record<string, unknown> => ({
  id,
  body: id,
  fromId: null,
  fromName: null,
  status: 'open',
  dueDate: null,
  urgent: false,
  createdAt: new Date(now).toISOString(),
  doneAt: null,
  doneBy: null,
  ...over
})
const sorted = sortReminders([
  mkR('new', { createdAt: new Date(now).toISOString() }),
  mkR('done', { status: 'done', doneAt: new Date(now).toISOString() }),
  mkR('old', { createdAt: new Date(now - 86400000 * 5).toISOString() }),
  mkR('urgent', { urgent: true, createdAt: new Date(now).toISOString() })
])
ok(sorted[0].id === 'urgent', 'urgent first', sorted.map((x: any) => x.id).join(','))
ok(sorted[1].id === 'old', 'then the oldest open one', sorted.map((x: any) => x.id).join(','))
ok(sorted[2].id === 'new', 'then the newer one')
ok(sorted[3].id === 'done', 'and done ones sink', sorted.map((x: any) => x.id).join(','))

// ---------------------------------------------------------------------------
console.log('\n=== 7. the board agrees with the module it summarises ===')
// ---------------------------------------------------------------------------
const stats = inventory.inventoryStats()
const board = owner.getOwnerBoard(ALL)
ok(
  board.inventory.productCount === stats.skuCount,
  'product count matches Inventory',
  `${board.inventory?.productCount} vs ${stats.skuCount}`
)
ok(
  Math.abs(board.inventory.stockValue - Math.round(stats.totalCost * 100) / 100) < 0.005,
  'and so does the value at cost',
  `${board.inventory?.stockValue} vs ${stats.totalCost}`
)


// ---------------------------------------------------------------------------
console.log('\n=== 8. the new cards on the home board ===')
// ---------------------------------------------------------------------------
// The sketch asked for six cards. Three of them read data that was already on
// the board; three needed adding, and each has to obey the rule the rest of the
// board obeys — null when the caller may not see it, never zero.
const blank = owner.getOwnerBoard(NONE)
ok(blank.incoming === null, 'no inventory permission, no incoming list', JSON.stringify(blank.incoming))
ok(blank.toShip === null, 'no fulfillment permission, no orders to ship', JSON.stringify(blank.toShip))
ok(blank.employeesToday === null, 'and no hours permission, no team list', JSON.stringify(blank.employeesToday))
// A zero here would be a claim about the business. These are three different
// statements and the board must not collapse them into one.
const board8 = owner.getOwnerBoard(ALL)
ok(
  board8.incoming !== null && Array.isArray(board8.incoming.items),
  'with permission it is a list, even an empty one',
  JSON.stringify(board8.incoming)
)
// Purchase orders AND hand-logged shipments, folded. Either one alone answers a
// different question from the one the owner is asking.
ok(
  owner.getOwnerBoard({ ...NONE, invoicing: true }).incoming !== null,
  'invoicing alone still sees the purchase orders coming in'
)
ok(
  owner.getOwnerBoard({ ...NONE, inventory: true }).incoming !== null,
  'and inventory alone still sees the hand-logged ones'
)
ok(board8.toShip !== null && typeof board8.toShip.remaining === 'number', 'to-ship carries the room total')
ok(Array.isArray(board8.employeesToday), 'and the team list is a list')

// Wholesale gained a TODAY window, because "did we make anything last night" is
// not answerable from a seven-day figure.
ok(board8.wholesale === null || !!board8.wholesale.today, 'wholesale has a daily window')
if (board8.wholesale) {
  ok(board8.wholesale.today.days === 1, 'covering one day', String(board8.wholesale.today.days))
  ok(board8.wholesale.today.label === 'Today', 'and saying so', board8.wholesale.today.label)
}

// ---------------------------------------------------------------------------
console.log('\n=== 9. who is in today ===')
// ---------------------------------------------------------------------------
// Written straight in rather than through insertEmployee: this test is about
// who is IN today, and a password hash is not part of that question.
const workerId = 'emp_dana'
const madeAt = new Date().toISOString()
getDb()
  .prepare(
    `INSERT INTO employees
       (id, company_id, first_name, last_name, email, role, status, created_at, updated_at)
     VALUES (?, 'RM-DANA', 'Dana', 'Brooks', 'dana@none.invalid', 'staff', 'active', ?, ?)`
  )
  .run(workerId, madeAt, madeAt)
ok(!!getDb().prepare('SELECT 1 FROM employees WHERE id = ?').get(workerId), 'an employee to clock in')

const noneYet = owner.getOwnerBoard(ALL).employeesToday
ok(
  !noneYet.some((e: any) => e.id === workerId),
  'somebody who has not clocked in is not "in today"'
)

// THE TIMEZONE CASE, pinned because it is invisible for most of the day.
// Clock times are stored as UTC ISO strings, so matching their first ten
// characters against a LOCAL date is right until the evening and then wrong —
// in Chicago a 7:30pm clock-in stores as tomorrow's UTC date and would drop off
// tonight's card. The warehouse works evenings.
const eveningIso = (() => {
  const d = new Date()
  d.setHours(19, 30, 0, 0)
  return d.toISOString()
})()
getDb()
  .prepare(
    `INSERT INTO time_entries (id, employee_id, clock_in, clock_out, note, source, created_at)
     VALUES ('te_evening', ?, ?, NULL, NULL, 'clock', ?)`
  )
  .run(workerId, eveningIso, eveningIso)
ok(
  owner.getOwnerBoard(ALL).employeesToday.some((e: any) => e.id === workerId),
  'somebody who clocked in this evening is in today, whatever UTC calls it',
  eveningIso
)
getDb().prepare(`DELETE FROM time_entries WHERE id = 'te_evening'`).run()


// THE ROTA HALF. Somebody due in who has not arrived has NO time entry at all,
// so nothing built from the clock could ever have produced them — which is
// exactly why this card used to answer only "who is here". A rostered no-show is
// the one line on it there is anything to do about.
const schedule = require('../src/main/db/schedule')
const todayKey = (() => {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
})()
schedule.createShift({ employeeId: workerId, day: todayKey, startTime: '16:00' }, 'emp_me')
const rostered = owner.getOwnerBoard(ALL).employeesToday
const due = rostered.find((e: any) => e.id === workerId)
ok(!!due, 'somebody on today’s rota appears without ever clocking in')
ok(due?.scheduled === true, 'marked as rostered')
ok(due?.dueAt === '16:00', 'with the time they are due', String(due?.dueAt))
ok(due?.onTheClock === false, 'and NOT claimed to be on the clock')
ok(due?.minutesToday === 0, 'having logged nothing', String(due?.minutesToday))
// Tomorrow's rota is not today's card.
schedule.createShift(
  { employeeId: workerId, day: '2099-01-01', startTime: '09:00' },
  'emp_me'
)
ok(
  owner.getOwnerBoard(ALL).employeesToday.filter((e: any) => e.id === workerId).length === 1,
  'a shift on another day does not add a second row'
)

// An OPEN entry — clocked in, still here. This is the half of the card that
// matters at 8am, and it is a fact from the clock rather than an intention from
// the rota. Somebody rostered who then ARRIVES must merge into one row carrying
// both, not appear twice.
const nowIso = new Date().toISOString()
getDb()
  .prepare(
    `INSERT INTO time_entries (id, employee_id, clock_in, clock_out, note, source, created_at)
     VALUES ('te_open_1', ?, ?, NULL, NULL, 'clock', ?)`
  )
  .run(workerId, nowIso, nowIso)
const withOpen = owner.getOwnerBoard(ALL).employeesToday
const dana = withOpen.find((e: any) => e.id === workerId)
ok(!!dana, 'they appear once clocked in', JSON.stringify(withOpen))
ok(dana?.onTheClock === true, 'and are marked on the clock')
ok(dana?.since === nowIso, 'with the time they started', String(dana?.since))
ok(dana?.name === 'Dana Brooks', 'under their own name', String(dana?.name))
ok(withOpen[0]?.id === workerId, 'and sort first, because they are standing here')
// ONE row, carrying both facts. Rostered AND arrived is one person, and the
// rota row must not survive as a duplicate beside the clock row.
ok(
  withOpen.filter((e: any) => e.id === workerId).length === 1,
  'rostered and arrived is one person, not two rows'
)
ok(dana?.scheduled === true, 'still known to be on the rota')
ok(dana?.dueAt === '16:00', 'and still carrying when they were due', String(dana?.dueAt))

// A CLOSED entry the same day adds to the total rather than creating a second
// person — somebody who clocks out for lunch is still one person.
// ANCHORED TO LOCAL MIDNIGHT, not to "three hours ago".
//
// `employeesToday` counts entries whose clock_in falls on the local day, so a
// pair placed three hours back stops being today's for the first three hours
// after midnight — and this suite now runs on the business's Central clock,
// where that window is a real time of night somebody might run the tests. The
// assertion was not wrong, it was only true for 21 hours a day.
//
// 01:00 to 03:00 local is inside today at every hour of every day. The clock_out
// is in the future when the suite runs before 3am, which the board handles: a
// closed entry is scored by subtracting its two stored instants, never against
// the wall clock.
const midnight = new Date()
midnight.setHours(0, 0, 0, 0)
const inIso = new Date(midnight.getTime() + 60 * 60 * 1000).toISOString()
const outIso = new Date(midnight.getTime() + 3 * 60 * 60 * 1000).toISOString()
getDb()
  .prepare(
    `INSERT INTO time_entries (id, employee_id, clock_in, clock_out, note, source, created_at)
     VALUES ('te_closed_1', ?, ?, ?, NULL, 'clock', ?)`
  )
  .run(workerId, inIso, outIso, inIso)
const merged = owner.getOwnerBoard(ALL).employeesToday.filter((e: any) => e.id === workerId)
ok(merged.length === 1, 'two entries, one person', String(merged.length))
ok(merged[0].minutesToday >= 120, 'and the day adds up', String(merged[0].minutesToday))

// ---------------------------------------------------------------------------
console.log('\n=== 10. the to-do list is per person and never named in a call ===')
// ---------------------------------------------------------------------------
// A to-do is NOT a reminder. A reminder is the floor writing to the owner and
// carries who sent it; a to-do is what somebody told themselves to do. Keeping
// them apart is what stops a screen that cannot tell a request from a plan.
const mine = todos.createTodo('emp_me', 'Payroll')
todos.createTodo('emp_me', 'Upload packing slips')
todos.createTodo('emp_someone_else', 'Not yours')

const list = todos.listTodos('emp_me')
ok(list.length === 2, 'my list holds mine', String(list.length))
ok(
  !list.some((t: any) => t.body === 'Not yours'),
  "and nobody else's"
)
ok(list[0].body === 'Payroll', 'oldest first, so nothing falls off the bottom', list[0].body)

ok(todos.setTodoDone('emp_me', mine.id, true)?.done === true, 'ticking works')
const ticked = todos.listTodos('emp_me')
ok(ticked[ticked.length - 1].id === mine.id, 'and a ticked line sinks')
ok(ticked[ticked.length - 1].doneAt !== null, 'carrying when it was ticked')
// Un-ticking must clear the timestamp: "when was this finished" has no answer
// for something that is not finished, and a stale one sorts it among the done.
ok(todos.setTodoDone('emp_me', mine.id, false)?.doneAt === null, 'un-ticking clears the time')

// THE ONE THAT MATTERS. Every operation is scoped to the caller, so somebody
// else's id cannot reach my row even with the right todo id in hand.
ok(todos.setTodoDone('emp_someone_else', mine.id, true) === null, 'another person cannot tick my task')
ok(todos.deleteTodo('emp_someone_else', mine.id) === false, 'nor delete it')
ok(todos.listTodos('emp_me').some((t: any) => t.id === mine.id), 'and it is still on my list')

ok(todos.deleteTodo('emp_me', mine.id) === true, 'but I can delete it')
ok(todos.listTodos('emp_me').length === 1, 'leaving the rest', String(todos.listTodos('emp_me').length))

// Both tables travel now. Reminders did NOT, which meant a note written at the
// bench never reached the laptop it was written for.
const { SYNCED_BY_TABLE } = require('../src/main/db/syncTables')
ok(SYNCED_BY_TABLE.has('reminders'), 'reminders sync, so the inbox actually arrives')
ok(SYNCED_BY_TABLE.has('todos'), 'and a list follows the person between machines')

// ---------------------------------------------------------------------------
console.log('\n=== 11. the board is built for the person looking at it ===')
// ---------------------------------------------------------------------------
// A packer on the Shipping role carries module.fulfillment and nothing else on
// this board. Main built their "orders to ship" card and sent it down — and the
// screen threw it away, because the render gate listed four sections and was
// written before three more existed. The one card their job depends on, gone.
const packer = owner.getOwnerBoard({ ...NONE, fulfillment: true })
ok(packer.toShip !== null, 'a packer gets the card their job needs', JSON.stringify(packer.toShip))
ok(packer.whatnot === null, 'and none of the money')
ok(packer.employeesToday === null, 'and not the team list either')

// The purchase-order half of "incoming" follows the gate on poIncomingBoxes,
// which is inventory OR invoicing — an inventory user WATCHES these land, which
// is the whole reason that operation is open to them. Gating it on invoicing
// alone told a Staff account "nothing on the way" while the Inventory screen
// two clicks away listed the same purchase orders arriving.
const staffish = owner.getOwnerBoard({ ...NONE, inventory: true })
ok(staffish.incoming !== null, 'inventory alone still gets the incoming card')
const invoicingOnly = owner.getOwnerBoard({ ...NONE, invoicing: true })
ok(invoicingOnly.incoming !== null, 'and so does invoicing alone')

// An empty shipping table is "nobody has imported a slip", not "the floor is
// clear" — and the second is reassurance the data does not support.
ok(
  typeof packer.toShip?.imported === 'boolean',
  'the card can tell an empty night from a finished one',
  JSON.stringify(packer.toShip)
)


// ---------------------------------------------------------------------------
console.log('\n=== 13. every money window states the dates it actually covers ===')
// ---------------------------------------------------------------------------
/**
 * THE MISTAKE THIS PREVENTS, which cost a fortnight of reconciling.
 *
 * Every window on this board ROLLS. "Last 30 days" is the thirty days ending
 * today; it is not June, it is not July, and it never was. That is the right
 * shape for a board somebody glances at each morning — and the wrong shape for
 * checking against a platform statement, which closes on its own calendar.
 *
 * The label alone could not tell the two apart, so the owner compared a rolling
 * tile against a Whatnot month and found twenty-odd thousand dollars that were
 * never missing. The dates are now on the card, and these assertions are what
 * keep them there and keep them honest.
 */
{
  const b: any = owner.getOwnerBoard(ALL)
  const windowsOf = (card: any): any[] => (card ? [card.today, card.week, card.month] : [])
  const every = [...windowsOf(b.whatnot), ...windowsOf(b.wholesale)]
  ok(every.length > 0, 'there are money windows to check', String(every.length))

  const isDay = (v: any): boolean => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  ok(
    every.every((w) => isDay(w.from) && isDay(w.to)),
    'EVERY WINDOW CARRIES A REAL FROM AND TO, so a reader can see which days it covers',
    JSON.stringify(every.map((w) => [w.label, w.from, w.to]))
  )
  ok(
    every.every((w) => w.from <= w.to),
    'and none of them runs backwards',
    JSON.stringify(every.map((w) => [w.from, w.to]))
  )

  /**
   * THE SPAN MATCHES THE PROMISE. "Last 7 days" covering four days would be a
   * label lying about a number, which is the whole failure being fixed —
   * inclusive of both ends, so 7 days is a 6-day difference.
   */
  const daysBetween = (a: string, z: string): number =>
    Math.round((Date.parse(`${z}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000) + 1
  for (const w of every) {
    ok(
      daysBetween(w.from, w.to) === w.days,
      `${w.label} spans exactly the ${w.days} day${w.days === 1 ? '' : 's'} it claims`,
      `${w.from}..${w.to} = ${daysBetween(w.from, w.to)}`
    )
  }

  /**
   * AND THE WINDOWS ARE NESTED, which is what makes them a rolling set rather
   * than three unrelated periods: today sits inside the week, the week inside
   * the month, and all three end on the same day.
   */
  for (const card of [b.whatnot, b.wholesale]) {
    if (!card) continue
    ok(
      card.today.to === card.week.to && card.week.to === card.month.to,
      'all three windows on a card end on the same day — they roll, they do not tile',
      `${card.today.to} / ${card.week.to} / ${card.month.to}`
    )
    ok(
      card.month.from <= card.week.from && card.week.from <= card.today.from,
      'and each is contained by the next one out'
    )
  }
}


// ---------------------------------------------------------------------------
console.log('\n=== N. what we owe is counted off the MONEY, not off the column ===')
// ---------------------------------------------------------------------------
/**
 * The owner: "the unpaid amount should be accurate, all unpaid, regardless of
 * what stage they are in."
 *
 * It was not. `payables()` filtered on `status === 'ordered'`, and because
 * `setPurchaseOrderPaid` records a payment as a DATE and deliberately leaves
 * the card where it is — arriving and being settled happen in either order —
 * that one filter reported two lies at once, in opposite directions:
 *
 *   · AN ORDER ALREADY PAID still sat in Ordered, so the board kept asking the
 *     owner to chase a bill that was settled.
 *   · AN ORDER THAT HAD ARRIVED and had not been paid for was dropped
 *     entirely, which is the single most important row a payables list has.
 *     The card on the board wears an "Unpaid" chip in exactly that case, so
 *     the total disagreed with the cards underneath it.
 *
 * Different amounts on the three orders below, deliberately: with equal ones
 * the two errors cancel in the TOTAL and only the list is visibly wrong, which
 * is how a bug like this survives being looked at.
 */
const owedProduct = inventory.createProduct(
  {
    name: 'Payables Test Box',
    category: 'Baseball',
    sku: `OB${++sku}`,
    upc: null,
    brand: '',
    setName: '',
    year: '',
    unitType: 'box',
    boxesPerCase: null,
    packsPerBox: null,
    giveawayItem: false,
    unitCost: 10,
    highBid: null,
    salePrice: 0,
    reorderPoint: 0,
    notes: null
  },
  null
)
const mkOrder = (supplier: string, unitPrice: number): any =>
  po.createPurchaseOrder(
    {
      supplier,
      notes: null,
      location: 'RM',
      lines: [{ productId: owedProduct.id, quantity: 1, unitPrice }]
    },
    null
  )

// Three orders, three amounts, three states.
const stillOwed = mkOrder('Owed Supply Co', 100)
const alreadyPaid = mkOrder('Settled Supply Co', 200)
const hereUnpaid = mkOrder('Arrived Supply Co', 400)

// PAID WITHOUT MOVING. This is the call the "Mark paid" button makes, and the
// one that used to leave an order sitting in the payables list.
po.setPurchaseOrderPaid(alreadyPaid.id, true, null)
// ARRIVED WITHOUT BEING PAID. The boxes are on the shelf and the bill is open.
po.receivePurchaseOrderLines(
  hereUnpaid.id,
  [{ lineId: hereUnpaid.lines[0].id, quantity: 1 }],
  null
)

ok(
  po.getPurchaseOrder(alreadyPaid.id).status === 'ordered',
  'the paid order is STILL in the Ordered column — paying does not move a card',
  po.getPurchaseOrder(alreadyPaid.id).status
)
ok(
  po.getPurchaseOrder(hereUnpaid.id).status === 'received',
  'and the unpaid one has left it, because its boxes turned up',
  po.getPurchaseOrder(hereUnpaid.id).status
)

const owedBoard = owner.getOwnerBoard(ALL)
const owedNames = owedBoard.payables.items.map((i: any) => i.supplier).sort()

ok(
  owedBoard.payables.total === 500,
  'WHAT WE OWE IS 100 + 400 — the unpaid order that arrived is counted, and the ' +
    'paid one that never moved is not',
  String(owedBoard.payables.total)
)
ok(owedBoard.payables.count === 2, 'two orders, not two columns', String(owedBoard.payables.count))
ok(
  owedNames.join(', ') === 'Arrived Supply Co, Owed Supply Co',
  'AND IT IS THE RIGHT TWO. The old filter returned the other pair entirely: it ' +
    'chased a settled supplier and was blind to an open bill on stock already here',
  owedNames.join(', ')
)
ok(
  !owedNames.includes('Settled Supply Co'),
  'nobody is chased for a bill they have been paid'
)

// A cancelled order is unpaid forever and owed by nobody — calling one off is
// how you stop owing for it, which is why the rule is not "not paid".
const calledOff = mkOrder('Called Off Supply Co', 800)
po.setPurchaseOrderStatus(calledOff.id, 'cancelled', null)
const afterCancel = owner.getOwnerBoard(ALL)
ok(
  afterCancel.payables.total === 500,
  'CANCELLING AN ORDER TAKES IT OFF WHAT WE OWE, though nobody ever paid it',
  String(afterCancel.payables.total)
)
ok(
  !afterCancel.payables.items.some((i: any) => i.supplier === 'Called Off Supply Co'),
  'and off the list to chase'
)

// The shared rule, read directly. The board and the card chips must agree, and
// they only can if there is one function to disagree with.
const { isPurchaseOrderPaid, purchaseOrderIsOwed } = require('../src/shared/purchaseOrders')
ok(
  isPurchaseOrderPaid({ paidAt: '2026-01-01T00:00:00.000Z' }) === true &&
    isPurchaseOrderPaid({ paidAt: null }) === false,
  'paid is the DATE and nothing else'
)
ok(
  purchaseOrderIsOwed({ status: 'received', paidAt: null }) === true,
  'received and unpaid is owed'
)
ok(
  purchaseOrderIsOwed({ status: 'ordered', paidAt: '2026-01-01T00:00:00.000Z' }) === false,
  'ordered and paid is not'
)
ok(
  purchaseOrderIsOwed({ status: 'cancelled', paidAt: null }) === false,
  'and cancelled is not, however unpaid it is'
)


// ---------------------------------------------------------------------------
console.log('\n=== N+1. the Open / Unpaid tile on the purchase board ===')
// ---------------------------------------------------------------------------
/**
 * The owner, looking straight at the board: "the number that is unpaid is not
 * reflective — on the PO side it should reflect the amount of money that is
 * left open regardless of what deal stage this is."
 *
 * The header tile filtered on the STAGE — `status === 'ordered' || 'paid'` —
 * and was wrong in both directions at once, visibly, on one screen:
 *
 *   · RECEIVED WAS MISSING. Six orders sat in the Received column, every card
 *     wearing an "Unpaid" chip, and the tile above them left all six out. The
 *     screen contradicted itself in a single glance.
 *   · 'PAID' WAS COUNTED IN. That column means the supplier has been settled
 *     with, so counting it says the business owes what it has already paid.
 *
 * This reproduces the owner's actual board — six ordered, six received and
 * unpaid, one paid — and pins the figure the tile must show. Fixing
 * `payables()` on the owner's home board did NOT fix this one; they were two
 * copies of the same filter, which is why both now read `purchaseOrderIsOwed`.
 */
const tileProduct = inventory.createProduct(
  {
    name: 'Board Tile Test Box',
    category: 'Baseball',
    sku: `OB${++sku}`,
    upc: null,
    brand: '',
    setName: '',
    year: '',
    unitType: 'box',
    boxesPerCase: null,
    packsPerBox: null,
    giveawayItem: false,
    unitCost: 10,
    highBid: null,
    salePrice: 0,
    reorderPoint: 0,
    notes: null
  },
  null
)
const tileOrder = (supplier: string, price: number): any =>
  po.createPurchaseOrder(
    {
      supplier,
      notes: null,
      location: 'RM',
      lines: [{ productId: tileProduct.id, quantity: 1, unitPrice: price }]
    },
    null
  )

// Wipe the slate so the arithmetic below is the owner's board and nothing else.
for (const existing of po.listPurchaseOrders()) {
  po.forceDeletePurchaseOrder(existing.id, null)
}

// The ORDERED column, from the screenshot.
const orderedAmounts = [46992, 25000, 7815, 33650, 15630, 16570]
orderedAmounts.forEach((amount, i) => tileOrder(`Ordered Supply ${i}`, amount))

// The RECEIVED column — every card marked Unpaid.
const receivedAmounts = [20475, 40750, 23410, 4733.4, 9690, 19910]
for (const [i, amount] of receivedAmounts.entries()) {
  const made = tileOrder(`Received Supply ${i}`, amount)
  po.receivePurchaseOrderLines(made.id, [{ lineId: made.lines[0].id, quantity: 1 }], null)
}

// And one genuinely settled, which must NOT count however it is staged.
const settledOrder = tileOrder('Settled Supply', 99999)
po.setPurchaseOrderPaid(settledOrder.id, true, null)

/**
 * The tile's own arithmetic, lifted from InvoicingModule so the assertion is
 * about the rule and not about React. If these two ever drift the board is
 * wrong again — which is exactly what happened the first time.
 */
const boardPos = po.listPurchaseOrders()
const openOnBoard = boardPos.filter((p: any) => purchaseOrderIsOwed(p))
const unpaidOnBoard = openOnBoard.reduce((n: number, p: any) => n + p.total, 0)

ok(
  openOnBoard.length === 12,
  'THE OPEN COUNT IS 12, not 6 — the six received-and-unpaid orders are open money too',
  String(openOnBoard.length)
)
ok(
  Math.abs(unpaidOnBoard - 264625.4) < 0.005,
  'AND THE FIGURE IS $264,625.40. The tile showed $145,657 — the Ordered column ' +
    'alone — hiding $118,968.40 of bills on stock already sitting on the shelf',
  String(unpaidOnBoard)
)
ok(
  !openOnBoard.some((p: any) => p.supplier === 'Settled Supply'),
  'and the settled order is out of both, though nothing moved its card'
)

// The old rule, kept here as the thing that must never come back.
const byOldRule = boardPos.filter((p: any) => p.status === 'ordered' || p.status === 'paid')
ok(
  byOldRule.reduce((n: number, p: any) => n + p.total, 0) > unpaidOnBoard - 118968.4 - 1 &&
    byOldRule.length === 7,
  'THE OLD STAGE FILTER RETURNS A DIFFERENT SET — 7 orders including the paid one, ' +
    'which is what made the tile disagree with the chips on the cards beneath it',
  `${byOldRule.length} orders`
)

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
