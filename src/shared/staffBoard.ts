import type { Shift } from './schedule'

/**
 * The floor's home page.
 *
 * A different screen from the owner's board, on purpose. The owner opens the
 * app to ask how the business is doing; a packer opens it to ask three
 * questions and no others:
 *
 *   · What is waiting for me — how many orders need sorting, off how many
 *     breaks, from which night.
 *   · What have I earned this fortnight.
 *   · When am I next in.
 *
 * Everything else the owner's board carries — the P&L, the payables, the stock
 * valuation, who else is on the clock — is either none of their business or
 * nothing they can act on, and a landing screen full of numbers somebody cannot
 * act on teaches them not to read it.
 *
 * There are no quick actions here either. The sidebar is on screen at all
 * times and the two modules a packer can open are already in it; a row of
 * shortcuts to the same two places is furniture.
 */

/**
 * Tonight's pile, as the floor sees it.
 *
 * "Needs sorting" is one specific thing: a package whose cards have not all
 * been checked off yet. Not "not shipped" and not "not packed" — those are
 * later stages and belong to whoever does them. Held packages are excluded, the
 * same way they are on the owner's board: a lead putting a package on hold has
 * decided it is not tonight's work.
 */
export interface StaffSorting {
  /** True once any packing slip has been imported. */
  imported: boolean
  /** Packages with at least one card still to sort. */
  orders: number
  /** Individual cards still to check off across those packages. */
  cardsLeft: number
  cardsTotal: number
  /** Distinct breaks those outstanding cards come off. */
  breaks: number
  /** The event day the dataset says it is for, when it says. */
  eventDate: string | null
  eventName: string | null
  /** When the slip was uploaded — the honest answer to "when is this from". */
  importedAt: string | null
  importName: string | null
}

/** What the current payroll fortnight has come to, for the person asking. */
export interface StaffPeriodHours {
  start: string
  end: string
  /** The day payroll is RUN for this fortnight — four days after it closes. */
  runOn: string
  /** The day the money lands — two days after the run. */
  paidOn: string
  minutes: number
  /** Days inside the period they actually worked. */
  daysWorked: number
  /** True when they are on the clock right now. */
  onTheClock: boolean
  /** Minutes logged today, running clock included. */
  minutesToday: number
}

export interface StaffBoard {
  /** Null when the viewer cannot open the fulfilment module. */
  sorting: StaffSorting | null
  /** Never null for a signed-in caller — everybody has their own hours. */
  hours: StaffPeriodHours
  /**
   * Their own future shifts, soonest first, including today's.
   *
   * Today's counts as future: somebody opening the app at 9am wants to see the
   * 4pm they are in for, and dropping it at midnight would mean the one shift
   * they most need is the one the screen hides.
   */
  shifts: Shift[]
  /** Everything on the books, so the calendar can page backwards too. */
  allShifts: Shift[]
  generatedAt: string
}
