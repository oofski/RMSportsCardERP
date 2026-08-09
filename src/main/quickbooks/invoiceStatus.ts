/**
 * Reading an invoice's state back out of QuickBooks.
 *
 * READ-ONLY. Nothing in this file writes to anybody's books, which is what makes
 * it safe to run on a timer against a live company.
 *
 * ## The owner named five states. This API reports three of them.
 *
 * That is not a limitation of this code and it cannot be worked around, so it is
 * written down at both ends — here, and in @shared/invoices where the mapping
 * lives. Repeating it is deliberate: the next person to be asked "why doesn't it
 * say Viewed" will land on one of the two.
 *
 *   OPENED / OPEN   REAL. Balance against TotalAmt. There is no status string on
 *                   the Invoice entity to read instead; "Open" on their screen is
 *                   derived from exactly these two numbers.
 *   SENT            REAL. EmailStatus flips to 'EmailSent' and DeliveryInfo gains
 *                   a DeliveryTime when QuickBooks emails the invoice. It reports
 *                   mail QUICKBOOKS sent — an invoice printed and handed over
 *                   stays 'NotSet', which is right, not broken.
 *   VIEWED BY PAYER NOT AVAILABLE. The "Viewed" chip in the QuickBooks web UI is
 *                   an e-invoicing engagement signal. No field on the Invoice
 *                   entity in the Accounting API carries it: EmailStatus has
 *                   exactly three values (NotSet, NeedToSend, EmailSent) and none
 *                   of them means read, and DeliveryInfo records when we sent,
 *                   not when they opened. This app does not claim it. A stage
 *                   that silently never arrives is worse than one never offered.
 *   PAID            REAL. Balance falls to zero against a non-zero TotalAmt, and
 *                   LinkedTxn gains entries of TxnType 'Payment'. Partial payment
 *                   is visible and is deliberately NOT reported as paid.
 *   PAYOUT SENT     NOT AVAILABLE. Money moving from QuickBooks Payments into the
 *                   owner's bank is a Payments-API concept behind the
 *                   com.intuit.quickbooks.payment scope, which this app does not
 *                   request — see QBO_SCOPE, accounting only. The Accounting
 *                   API's Invoice has no link to a payout, and the Payment
 *                   entity's DepositToAccountRef is a bookkeeping destination
 *                   rather than a transfer that settled. Inferring it would be a
 *                   guess about somebody else's money.
 *
 * VOIDED is read too, and is only half-available: v3 has no status field for it.
 * The recognised signature is a zeroed invoice whose PrivateNote begins "Voided"
 * — a heuristic, labelled as one, and only ever allowed to move an invoice INTO
 * void.
 */
import type { QboInvoiceObservation } from '@shared/invoices'
import { looksVoidedInQbo } from '@shared/invoices'
import { qboRequest } from './client'

interface RawLinkedTxn {
  TxnId?: string
  TxnType?: string
}

interface RawInvoice {
  Id?: string
  DocNumber?: string
  EmailStatus?: string
  DeliveryInfo?: { DeliveryType?: string; DeliveryTime?: string }
  Balance?: number
  TotalAmt?: number
  PrivateNote?: string
  LinkedTxn?: RawLinkedTxn[]
}

interface QueryResponse {
  QueryResponse?: { Invoice?: RawInvoice[] }
}

function toObservation(raw: RawInvoice): QboInvoiceObservation | null {
  if (!raw.Id) return null
  return {
    qboId: String(raw.Id),
    docNumber: raw.DocNumber ?? null,
    emailStatus: raw.EmailStatus ?? null,
    deliveredAt: raw.DeliveryInfo?.DeliveryTime ?? null,
    // Explicitly null, never 0, when the field is absent. "QuickBooks says
    // nothing is owed" and "QuickBooks did not tell us" are different facts, and
    // a missing balance coerced to zero reads as paid in full.
    balance: typeof raw.Balance === 'number' ? raw.Balance : null,
    totalAmt: typeof raw.TotalAmt === 'number' ? raw.TotalAmt : null,
    linkedPayments: (raw.LinkedTxn ?? []).filter((t) => t.TxnType === 'Payment').length,
    // The heuristic lives in @shared with the rest of the mapping, so it can be
    // tested without a network. See looksVoidedInQbo for why both halves of the
    // signature are required.
    voided: looksVoidedInQbo({
      totalAmt: raw.TotalAmt,
      balance: raw.Balance,
      privateNote: raw.PrivateNote
    })
  }
}

/**
 * Read several invoices in one query.
 *
 * Batched because a status refresh asks about every open invoice at once and
 * QuickBooks throttles per app, not per invoice — a hundred single reads is a
 * hundred chances to be rate limited into a partial answer. The batch is capped
 * well under their query limit, and the ids are digits, so the IN list is built
 * by filtering rather than escaping: anything that is not a plain id is dropped
 * before it can become part of a query string.
 */
const BATCH = 50

export async function fetchQboInvoiceStatuses(
  qboIds: string[]
): Promise<Map<string, QboInvoiceObservation>> {
  const out = new Map<string, QboInvoiceObservation>()
  const clean = Array.from(new Set(qboIds.map((id) => String(id ?? '').trim()))).filter((id) =>
    /^[0-9]+$/.test(id)
  )

  for (let i = 0; i < clean.length; i += BATCH) {
    const chunk = clean.slice(i, i + BATCH)
    const list = chunk.map((id) => `'${id}'`).join(',')
    const body = await qboRequest<QueryResponse>({
      path: 'query',
      query: { query: `select * from Invoice where Id in (${list})` }
    })
    for (const raw of body.QueryResponse?.Invoice ?? []) {
      const observation = toObservation(raw)
      if (observation) out.set(observation.qboId, observation)
    }
  }
  return out
}

/** One invoice, for the "refresh just this card" gesture. */
export async function fetchQboInvoiceStatus(
  qboId: string
): Promise<QboInvoiceObservation | null> {
  const body = await qboRequest<{ Invoice?: RawInvoice }>({
    path: `invoice/${encodeURIComponent(qboId)}`
  })
  return body.Invoice ? toObservation(body.Invoice) : null
}
