import { DEAL_TICKET_FIRST, formatDealTicket } from './dealTickets'

/**
 * Where each document series starts counting.
 *
 * ## Why this is one screen and not three settings
 *
 * The app mints three independent sequences — deal tickets, invoice numbers and
 * purchase order numbers — and each one has the same problem at the same moment:
 * the business already had a numbering scheme before this app existed, and the
 * app has to be told where to pick it up. Getting that wrong is not a cosmetic
 * error. An invoice number below what the business has already billed under is a
 * duplicate in QuickBooks, which either refuses it or accepts it and leaves two
 * documents claiming one number.
 *
 * So the three live together, they are stated the same way, and they are guarded
 * the same way.
 *
 * ## "Start at" means the NEXT number, always
 *
 * Underneath, two of these store the LAST number used and one stores the next.
 * That is an implementation detail of three counters written at different times,
 * and exposing it would mean an operator typing 337 into one box and 336 into
 * another to get the same outcome. Every number crossing this contract is the
 * next number that WILL be issued, and each store converts on the way in.
 *
 * ## A start can only ever move forward
 *
 * Every counter here is a FLOOR combined with the highest number actually
 * issued — that is what stops a deleted document handing its number out twice.
 * A start below that ceiling is therefore not "rejected policy", it is a value
 * the generator would silently ignore, which is far worse than being told no.
 * `validateSeriesStart` refuses it and names the number it must clear.
 */

export type NumberSeries = 'deal_ticket' | 'invoice' | 'purchase_order'

export const NUMBER_SERIES: readonly NumberSeries[] = [
  'deal_ticket',
  'invoice',
  'purchase_order'
]

/** The prefix and padding each series is printed with. */
export function formatSeriesNumber(series: NumberSeries, value: number): string {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n) || n < 0) return '—'
  switch (series) {
    case 'deal_ticket':
      return formatDealTicket(n)
    case 'purchase_order':
      // Four digits, matching nextPoNumber. Past 9999 it widens rather than
      // truncating, for the reason the ticket format gives.
      return 'PO-' + String(n).padStart(4, '0')
    case 'invoice':
      // DELIBERATELY BARE. An invoice number goes to QuickBooks as typed and the
      // owner's existing series is plain digits; decorating it here would send a
      // different string than the one this screen shows.
      return String(n)
    default:
      return String(n)
  }
}

export function seriesLabel(series: NumberSeries): string {
  switch (series) {
    case 'deal_ticket':
      return 'Deal tickets'
    case 'invoice':
      return 'Invoice numbers'
    case 'purchase_order':
      return 'Purchase orders'
    default:
      return series
  }
}

/** What each series is FOR, in the operator's terms. */
export function seriesHint(series: NumberSeries): string {
  switch (series) {
    case 'deal_ticket':
      return 'Struck automatically on every purchase order, sales order and dropship.'
    case 'invoice':
      return 'Suggested on a new sales order. This is the number QuickBooks receives.'
    case 'purchase_order':
      return 'Given to a purchase order when it is raised.'
    default:
      return ''
  }
}

/** The lowest start each series will ever accept, before anything is issued. */
export function seriesFloor(series: NumberSeries): number {
  // Deal tickets alone carry a business floor: the register was kept by hand up
  // to 336, so the app must never issue below 337 even on an empty database.
  return series === 'deal_ticket' ? DEAL_TICKET_FIRST : 1
}

/** One series, as the screen needs it. */
export interface SeriesState {
  series: NumberSeries
  /** The number the next document will get, as things stand. */
  next: number
  /**
   * The highest number this series has actually issued, or 0 for none.
   *
   * Reported separately from `next` because they answer different questions and
   * the gap between them is the whole point: `next` can be far above `issued`
   * when a start has been set forward, and an operator needs to see that the
   * jump was deliberate rather than a counter that has run away.
   */
  issued: number
  /** The lowest value `setSeriesStart` will accept right now. */
  minimum: number
}

/**
 * Is this a start the series can actually take?
 *
 * Returns the reason it cannot, or null when it can. Written to be shown as-is:
 * every branch names the number that would have to be cleared, because "invalid"
 * on a numbering screen is the least useful thing a form can say.
 */
export function validateSeriesStart(state: SeriesState, value: number): string | null {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return 'That has to be a whole number.'
  }
  if (value < 1) return 'A number has to be at least 1.'
  const floor = seriesFloor(state.series)
  if (value < floor) {
    return `${seriesLabel(state.series)} cannot start below ${formatSeriesNumber(
      state.series,
      floor
    )}.`
  }
  if (value < state.minimum) {
    // The two reasons a minimum exists read very differently to somebody looking
    // at the screen, so they are told apart rather than sharing one message.
    return state.issued > 0
      ? `${formatSeriesNumber(state.series, state.issued)} has already been issued, so the next ` +
          `one has to be ${formatSeriesNumber(state.series, state.minimum)} or higher.`
      : `That has to be ${formatSeriesNumber(state.series, state.minimum)} or higher.`
  }
  return null
}

/** True when setting this start would actually change anything. */
export function seriesStartChanges(state: SeriesState, value: number): boolean {
  return Number.isInteger(value) && value !== state.next
}
