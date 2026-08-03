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
  /** Negative: Whatnot's commission and Stripe's cut, already deducted by the
   *  platform before the ledger row was written. */
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
