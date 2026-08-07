import type { DerivedTask, RecurringDue } from './homeTasks'
/**
 * The owner's home board.
 *
 * One screen that answers the four questions somebody who owns this business
 * opens the app to ask: what did we make, what do we owe, what is owed to us,
 * and what is happening next. Everything on it already exists somewhere else in
 * the app — this is a vantage point, not a new source of truth, and every tile
 * is a door into the module that owns the number.
 *
 * ONE round trip. The board is the landing screen, so it cannot be six requests
 * that paint in at six different moments; it is assembled in main and arrives
 * whole. Anything the caller may not see comes back null rather than zero — a
 * zero is a claim about the business, and "you cannot see this" is not.
 */

/** A profit-and-loss snapshot over one window. */
export interface OwnerPnlWindow {
  label: string
  /** Days the window covers, for the subtitle. */
  days: number
  /**
   * What the buyers paid — the DERIVED gross, the same top line the Streaming
   * statement prints. Whatnot pays net, so `revenue + fees` is the figure that
   * actually landed in the account.
   */
  revenue: number
  /** Negative: Whatnot's commission and the card processing charge, already
   *  deducted by the platform before the ledger row was written. */
  fees: number
  cogs: number
  netProfit: number
  /** Days inside the window that carried any activity. */
  activeDays: number
}

/**
 * The Whatnot side: live shows.
 *
 * Sourced from the streaming finance view, so it is the same arithmetic the
 * P&L screen prints and cannot drift from it.
 */
export interface OwnerWhatnotPnl {
  today: OwnerPnlWindow
  week: OwnerPnlWindow
  month: OwnerPnlWindow
  /** The most recent day with any money on it, for "last show" context. */
  lastDay: string | null
  lastDayNet: number
  /** True when the underlying view failed its own reconciliation check. */
  unreconciled: boolean
  reconcileNote: string | null
}

/**
 * The off-stream side: sealed product sold outright rather than as break spots.
 *
 * This is what the app currently knows as "wholesale". It is deliberately fed
 * from the SAME ledger as the Whatnot figures rather than a second import,
 * because that is where the money actually appears — a marketplace order and a
 * break spot arrive in one file and are told apart by the classifier.
 */
export interface OwnerWholesalePnl {
  /** Today alone. Added because the owner's morning question is "did we make
   *  anything last night", and a 7-day window cannot answer it. */
  today: OwnerPnlWindow
  week: OwnerPnlWindow
  month: OwnerPnlWindow
  /** Distinct products sold outright this month. */
  productCount: number
  /** How many of those the app could not match to a catalog row. */
  unmatchedCount: number
  /** Best sellers this month, most revenue first. */
  top: Array<{ name: string; productId: string | null; units: number; revenue: number }>
}

/** Money leaving: a purchase order that has been placed but not paid. */
export interface OwnerPayable {
  id: string
  poNumber: string
  supplier: string | null
  total: number
  status: string
  placedAt: string | null
  /** Days since it was placed. Drives the "this is getting old" tone. */
  ageDays: number
}

/**
 * Money arriving.
 *
 * There is no accounts-receivable ledger in this app, and inventing one would
 * be worse than saying so. What IS real and unpaid is the Whatnot balance:
 * everything earned, less everything already transferred to the bank. That is a
 * genuine "waiting on money" figure and it comes straight from the ledger.
 */
export interface OwnerReceivables {
  /** Earned and not yet paid out. */
  awaitingPayout: number
  /** The most recent payout, for context on how often they land. */
  lastPayoutAt: string | null
  lastPayoutAmount: number
  /** Total transferred to the bank, all time. */
  paidOutAllTime: number
}

export interface OwnerScheduleItem {
  id: string
  title: string
  streamDate: string
  startedAt: string
  endedAt: string | null
  status: string
  live: boolean
}

export interface OwnerInventorySnapshot {
  /** What the shelves are worth at cost. */
  stockValue: number
  productCount: number
  lowStockCount: number
  /** Cases/boxes on their way in, not yet checked in. */
  incomingCount: number
  /** Supplies below their reorder point. */
  supplyLowCount: number
  /** Supplies sitting BELOW ZERO — a count somebody has to fix. */
  supplyNegativeCount: number
}

/**
 * A case or box on its way in.
 *
 * The owner's morning question is "what is arriving", not "what is the total
 * value of open purchase orders" — so this is the SHIPMENTS, soonest first, with
 * enough on each line to recognise it. The count lives in the inventory snapshot
 * already; this is the list the sketch asked for.
 */
export interface OwnerIncomingOrder {
  id: string
  /** A purchase order, or a shipment somebody logged by hand. */
  source: 'po' | 'manual'
  /** The PO number, or the product name for a hand-logged row. */
  title: string
  detail: string
  /** Distinct products still outstanding on it. */
  itemCount: number
  units: number
  /** What the outstanding units cost — the basis the lots will open at. */
  value: number
}

/**
 * A package still to leave the building.
 *
 * Named by the customer, because that is how the floor talks about them, and
 * counted by cards left so the owner can see whether it is nearly done or
 * untouched. Held packages are EXCLUDED: a lead stopping a package is a decision
 * that it is not tonight's work, and a morning list that includes it invites
 * somebody to work it anyway.
 */
export interface OwnerOrderToShip {
  customerId: string
  handle: string
  realName: string
  cardsLeft: number
  cardsTotal: number
}

/**
 * Somebody who is at work today, or due to be.
 *
 * TWO FACTS, kept apart because they are different kinds of thing and the card
 * is unreadable if they are merged. `onTheClock` comes from an open time entry
 * and is a physical fact: that person is standing in the building. `dueAt` comes
 * from the rota and is an intention somebody recorded.
 *
 * This card used to carry only the first, and said so — the app had no schedule
 * table, so "who is going to be in" was a question it could not answer and
 * refused to guess at. The `shifts` table (v49) is the answer, so the card now
 * lists both: who is here, and who is expected. `minutesToday` still tells a
 * person who came in and went home again apart from one who never arrived.
 */
export interface OwnerEmployeeToday {
  id: string
  name: string
  role: string
  onTheClock: boolean
  /** When they clocked in, for whoever is currently on. */
  since: string | null
  minutesToday: number
  /**
   * Local HH:MM they are rostered to start, or null when they are not on
   * today's rota at all. Somebody with a `dueAt` who has never clocked in is
   * expected and has not turned up yet; somebody with neither is here off the
   * rota, which is worth being able to see.
   */
  dueAt: string | null
  /** True when they are on today's rota, whatever time it says. */
  scheduled: boolean
}

export interface OwnerBoard {
  /** Null when the viewer cannot see the finance module. */
  whatnot: OwnerWhatnotPnl | null
  wholesale: OwnerWholesalePnl | null
  receivables: OwnerReceivables | null
  /** Null when the viewer cannot see invoicing. */
  payables: { items: OwnerPayable[]; total: number; count: number } | null
  /** Null when the viewer cannot see inventory. */
  inventory: OwnerInventorySnapshot | null
  /** Null when the viewer cannot see streaming. */
  schedule: OwnerScheduleItem[] | null
  /**
   * Stock on its way in. Purchase orders AND hand-logged shipments folded
   * together, because either one alone is a different question from the one the
   * owner is asking. Null when the viewer can see neither module.
   */
  incoming: { items: OwnerIncomingOrder[]; orderCount: number; units: number; value: number } | null
  /** Null when the viewer cannot see the fulfillment module. */
  toShip: { items: OwnerOrderToShip[]; remaining: number; imported: boolean } | null
  /** Null when the viewer cannot see the team's hours. */
  employeesToday: OwnerEmployeeToday[] | null
  /**
   * Jobs the app worked out on its own, for the caller.
   *
   * Never null: everybody has a list, and the two halves gate themselves —
   * `slips` is empty for somebody who cannot see the streaming module, and
   * `recurring` is per person by construction.
   */
  tasks: { slips: DerivedTask[]; recurring: RecurringDue[] }
  generatedAt: string
}

// ---------------------------------------------------------------------------
// Reminders — the one thing on this board that is not a view of something else
// ---------------------------------------------------------------------------

/**
 * A note somebody on the floor sends to the owner.
 *
 * Deliberately one-directional and deliberately tiny. The ask was "people
 * should be able to send him a message or a reminder so he can put it through
 * that way" — that is an inbox, not a chat product. No threads, no replies, no
 * read receipts: a line of text, who wrote it, and whether it has been dealt
 * with. Anything more becomes a messaging system nobody asked for and everybody
 * has to maintain.
 */
export type ReminderStatus = 'open' | 'done'

export interface Reminder {
  id: string
  body: string
  /** Who sent it. Null when the employee row is gone. */
  fromId: string | null
  fromName: string | null
  status: ReminderStatus
  /** Optional day the sender is flagging it for. */
  dueDate: string | null
  /** Sender's flag, not a priority queue — it just sorts first. */
  urgent: boolean
  createdAt: string
  doneAt: string | null
  doneBy: string | null
}

export interface NewReminder {
  body: string
  dueDate?: string | null
  urgent?: boolean
}

/** Longest a reminder may be. A paragraph is a conversation, not a reminder. */
export const REMINDER_MAX_LENGTH = 500

export function validateReminder(input: NewReminder): string | null {
  const body = (input.body ?? '').trim()
  if (!body) return 'Write the reminder first.'
  if (body.length > REMINDER_MAX_LENGTH) {
    return `Keep it under ${REMINDER_MAX_LENGTH} characters — this is ${body.length}.`
  }
  if (input.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) {
    return 'A due date has to be a real date.'
  }
  return null
}

/**
 * Open first, urgent above that, then oldest first.
 *
 * Oldest first is the deliberate part. A reminder that has sat for a week is
 * the one most likely to be forgotten, so it rises rather than sinking — the
 * opposite of a chat log, and the right way round for a list whose purpose is
 * that nothing falls off the bottom.
 */
export function sortReminders(list: Reminder[]): Reminder[] {
  return [...list].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1
    if (a.status === 'open' && a.urgent !== b.urgent) return a.urgent ? -1 : 1
    if (a.status === 'done') return (b.doneAt ?? '').localeCompare(a.doneAt ?? '')
    return a.createdAt.localeCompare(b.createdAt)
  })
}

// ---------------------------------------------------------------------------
// The to-do list — the other thing on this board nobody derived
// ---------------------------------------------------------------------------

/**
 * One line on somebody's own checklist.
 *
 * Deliberately NOT a Reminder, and the distinction is the whole design. A
 * reminder is an INBOX: the floor writes it, it carries who sent it, and the
 * owner's job is to deal with it. A to-do is what he told HIMSELF to do —
 * payroll, hire a breaker, call the supplier. Folding the two into one list
 * would produce a screen that cannot tell a request apart from a plan, and the
 * first thing anybody would ask of it is "who put this here".
 *
 * One list per person. A shared list would put "Payroll" in front of every
 * packer and a packer's own list in front of the owner; it also means each row
 * has exactly one author, which is what makes it safe to sync.
 */
export interface Todo {
  id: string
  body: string
  done: boolean
  createdAt: string
  doneAt: string | null
}

/** Longest a to-do may be. A paragraph is a project, not a line on a list. */
export const TODO_MAX_LENGTH = 200

export function validateTodo(body: string): string | null {
  const text = (body ?? '').trim()
  if (!text) return 'Write the task first.'
  if (text.length > TODO_MAX_LENGTH) {
    return `Keep it under ${TODO_MAX_LENGTH} characters — this is ${text.length}.`
  }
  return null
}

/**
 * Open first, then oldest first; done ones sink, most recently ticked at the top
 * of that group.
 *
 * The same rule the reminders use, and for the same reason: the thing that has
 * sat longest is the thing most likely to be forgotten, so it rises. A list
 * whose purpose is that nothing falls off the bottom must not be a stack.
 */
export function sortTodos(list: Todo[]): Todo[] {
  return [...list].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1
    if (a.done) return (b.doneAt ?? '').localeCompare(a.doneAt ?? '')
    return a.createdAt.localeCompare(b.createdAt)
  })
}
