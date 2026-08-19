import type { NumberSeries, SeriesState } from '@shared/numbering'
import { NUMBER_SERIES, seriesFloor, validateSeriesStart } from '@shared/numbering'
import type { Result } from '@shared/types'
import { getDb, setMeta } from './database'
import { ceilingSeq, dealTicketIssued } from './dealTickets'
import { poCeiling, poIssued } from './purchaseOrders'
import { countRenumberedInvoices, invoiceIssued, invoiceStart } from './invoices'

/**
 * Reading and moving the three document counters.
 *
 * See @shared/numbering for why they live on one screen and why a start can only
 * ever move forward.
 *
 * ## Nothing in here mints a number
 *
 * Every read is a PEEK. `nextPoNumber` and `nextDealTicketSeq` both write their
 * counter back as they answer — that is what makes a number spent the moment it
 * is handed out — so calling either to display a value would burn a document
 * number every time somebody opened Admin. The peeks are separate functions for
 * exactly that reason.
 *
 * ## The stores disagree about what they hold, and that stops here
 *
 * `po_seq` and `deal_ticket_seq` hold the LAST number used. `invoice_number_start`
 * holds the NEXT one. That is an accident of three counters written at different
 * times, and it is converted on the way in and out of this module so no caller
 * and no screen ever has to know: everything crossing this boundary is the next
 * number that will be issued.
 */

/** The ceiling each series cannot be set at or below, and what it has issued. */
function readSeries(series: NumberSeries): SeriesState {
  const db = getDb()
  switch (series) {
    case 'deal_ticket': {
      // ceilingSeq already folds in the business floor of 336, so `next` here is
      // 337 on an untouched database — the number the register is documented to
      // start at.
      const ceiling = ceilingSeq(db)
      return {
        series,
        next: ceiling + 1,
        issued: dealTicketIssued(db),
        minimum: Math.max(ceiling + 1, seriesFloor(series))
      }
    }
    case 'purchase_order': {
      const ceiling = poCeiling(db)
      return {
        series,
        next: ceiling + 1,
        issued: poIssued(db),
        minimum: Math.max(ceiling + 1, seriesFloor(series))
      }
    }
    case 'invoice': {
      // The odd one out, and deliberately so. Its generator takes max(highest+1,
      // start) — the start is a FLOOR the series is pulled up to, not a counter
      // that climbs — so the next number is that same expression and the minimum
      // is whatever has actually been billed, plus one.
      const issued = invoiceIssued()
      const start = invoiceStart()
      return {
        series,
        next: Math.max(issued + 1, start),
        issued,
        minimum: Math.max(issued + 1, seriesFloor(series)),
        // Counted from posted invoices where what we sent and what came back
        // disagree. It costs one query and no API call, and it is the only
        // honest answer to "will the number I set here be the number my customer
        // sees" — the setting that decides it lives in QuickBooks, not here.
        renumbered: countRenumberedInvoices()
      }
    }
    default:
      return { series, next: 1, issued: 0, minimum: 1 }
  }
}

/** All three, for the numbering screen. */
export function readNumbering(): SeriesState[] {
  return NUMBER_SERIES.map(readSeries)
}

/**
 * Move where a series starts.
 *
 * `start` is the NEXT number to issue, in every case. Validated against a state
 * read fresh here rather than against anything the caller sent: the screen's copy
 * can be seconds old, and in those seconds somebody at another bench can have
 * raised the order that makes the requested start a duplicate.
 *
 * Refuses rather than clamping. A silent clamp would leave the operator looking
 * at a screen that says 400 while the app issues 351, and the whole reason this
 * screen exists is that a wrong document number is expensive to discover later.
 */
export function setSeriesStart(series: NumberSeries, start: number): Result<SeriesState[]> {
  const value = Math.trunc(Number(start))
  const state = readSeries(series)
  const problem = validateSeriesStart(state, value)
  if (problem) return { ok: false, error: problem }

  const db = getDb()
  switch (series) {
    case 'deal_ticket':
      // Stored as the last number SPENT, so the next issue is `value`.
      setMeta(db, 'deal_ticket_seq', String(value - 1))
      break
    case 'purchase_order':
      setMeta(db, 'po_seq', String(value - 1))
      break
    case 'invoice':
      // Stored as the next number directly — see invoiceStart().
      setMeta(db, 'invoice_number_start', String(value))
      break
    default:
      return { ok: false, error: 'That is not a numbering series.' }
  }
  // The whole set comes back, so a screen showing three series cannot end up
  // with two fresh values and one stale one after a save.
  return { ok: true, data: readNumbering() }
}
