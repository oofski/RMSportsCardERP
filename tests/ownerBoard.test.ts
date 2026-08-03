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

const ALL = { finance: true, invoicing: true, inventory: true, streaming: true }
const NONE = { finance: false, invoicing: false, inventory: false, streaming: false }

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

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
