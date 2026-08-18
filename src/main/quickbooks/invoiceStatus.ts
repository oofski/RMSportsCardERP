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
 *   PAID            REAL, AND SO IS THE DATE. Balance falls to zero against a
 *                   non-zero TotalAmt, and LinkedTxn gains entries of TxnType
 *                   'Payment'. Partial payment is visible and is deliberately
 *                   NOT reported as paid.
 *
 *                   WHEN it was paid is one read further on. The Invoice entity
 *                   has no paid date on it — LinkedTxn is `{ TxnId, TxnType }`
 *                   and nothing else — so the date lives on the PAYMENT entity
 *                   that TxnId points at, as its TxnDate. This file used to read
 *                   that link and merely count it, which is exactly why the app
 *                   could say an invoice was paid and never when. It follows the
 *                   ids now; see fetchPaymentsFor.
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
import type {
  QboInvoiceMatch,
  QboInvoicePayment,
  QboInvoiceObservation
} from '@shared/invoices'
import { looksVoidedInQbo, money } from '@shared/invoices'
import { qboRequest } from './client'

interface RawLinkedTxn {
  TxnId?: string
  TxnType?: string
}

interface RawInvoice {
  Id?: string
  DocNumber?: string
  TxnDate?: string
  CustomerRef?: { value?: string; name?: string }
  EmailStatus?: string
  DeliveryInfo?: { DeliveryType?: string; DeliveryTime?: string }
  Balance?: number
  TotalAmt?: number
  PrivateNote?: string
  LinkedTxn?: RawLinkedTxn[]
}

/**
 * A Payment, as much of one as this app reads.
 *
 * `Line[].Amount` with `Line[].LinkedTxn` is the part that matters and the part
 * that is easy to get wrong: `TotalAmt` is what the buyer sent, which is not
 * what landed on any one invoice when the same transfer settles three of them.
 */
interface RawPaymentLine {
  Amount?: number
  LinkedTxn?: RawLinkedTxn[]
}

interface RawPayment {
  Id?: string
  /** A calendar day, `YYYY-MM-DD`. Their field, their format, kept as given. */
  TxnDate?: string
  TotalAmt?: number
  Line?: RawPaymentLine[]
}

interface QueryResponse {
  QueryResponse?: { Invoice?: RawInvoice[] }
}

interface PaymentQueryResponse {
  QueryResponse?: { Payment?: RawPayment[] }
}

function toObservation(
  raw: RawInvoice,
  payments: QboInvoicePayment[] = []
): QboInvoiceObservation | null {
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
    payments,
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
 * Split a batch of Payments across the invoices they settle.
 *
 * ONE PAYMENT IS NOT ONE INVOICE. A buyer clearing three cases with a single
 * transfer produces one Payment with three lines, and the share belonging to any
 * one invoice is that line's Amount — never the payment's TotalAmt, which would
 * credit each of the three with the whole transfer and report every one of them
 * overpaid.
 *
 * Lines are summed per invoice WITHIN a payment before being emitted, because a
 * payment may legitimately carry two lines against the same invoice, and two
 * entries with the same Payment id would then be counted as two payments.
 *
 * Exported for the tests: this is arithmetic about somebody's money, and it is
 * worth pinning without a network in front of it.
 */
export function paymentsByInvoice(raws: readonly RawPayment[]): Map<string, QboInvoicePayment[]> {
  const out = new Map<string, QboInvoicePayment[]>()
  for (const raw of raws) {
    const id = String(raw?.Id ?? '').trim()
    if (!id) continue
    const date = String(raw?.TxnDate ?? '').trim()

    const perInvoice = new Map<string, number>()
    for (const line of raw.Line ?? []) {
      const amount = typeof line?.Amount === 'number' ? line.Amount : 0
      for (const link of line?.LinkedTxn ?? []) {
        // Only Invoice links. A payment line can also point at a Deposit or a
        // CreditMemo, and adding those in would report money against an invoice
        // that never went to it.
        if (link?.TxnType !== 'Invoice') continue
        const target = String(link?.TxnId ?? '').trim()
        if (!target) continue
        perInvoice.set(target, (perInvoice.get(target) ?? 0) + amount)
      }
    }

    for (const [invoiceId, amount] of perInvoice) {
      const list = out.get(invoiceId) ?? []
      list.push({ id, date, amount: money(amount) })
      out.set(invoiceId, list)
    }
  }
  return out
}

/**
 * Follow every LinkedTxn of TxnType 'Payment' and read the payments behind them.
 *
 * ## Failure here must not cost the balances
 *
 * The balance reading is the fact the board runs on and it has already arrived
 * by the time this is called. A refused or throttled Payment query is a MISSING
 * DATE, not a failed refresh, so it degrades to an empty map and the caller
 * writes down what it does know. `linkedPayments` beside an empty `payments` is
 * what tells "we did not look" apart from "there are none" — see the note on
 * QboInvoiceObservation, and see recordQboObservation, which refuses to blank a
 * date it previously had on the strength of an answer it never got.
 *
 * Costs nothing on invoices nobody has paid: the id set comes from the links, so
 * a board full of open invoices issues no second query at all.
 */
async function fetchPaymentsFor(
  invoices: readonly RawInvoice[]
): Promise<Map<string, QboInvoicePayment[]>> {
  const ids = new Set<string>()
  for (const invoice of invoices) {
    for (const link of invoice.LinkedTxn ?? []) {
      if (link?.TxnType !== 'Payment') continue
      const id = String(link?.TxnId ?? '').trim()
      // Same filtering-not-escaping rule as the invoice query: anything that is
      // not a plain id is dropped before it can become part of a query string.
      if (/^[0-9]+$/.test(id)) ids.add(id)
    }
  }
  if (ids.size === 0) return new Map()

  const wanted = [...ids]
  const raws: RawPayment[] = []
  try {
    for (let i = 0; i < wanted.length; i += BATCH) {
      const list = wanted.slice(i, i + BATCH).map((id) => `'${id}'`).join(',')
      const body = await qboRequest<PaymentQueryResponse>({
        path: 'query',
        query: { query: `select * from Payment where Id in (${list})` }
      })
      raws.push(...(body.QueryResponse?.Payment ?? []))
    }
  } catch {
    // Deliberately swallowed. See the note above: a date we could not fetch must
    // not turn a successful balance read into a failed one.
    return new Map()
  }
  return paymentsByInvoice(raws)
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
  const clean = Array.from(new Set(qboIds.map((id) => String(id ?? '').trim()))).filter((id) =>
    /^[0-9]+$/.test(id)
  )

  // Collected before anything is mapped, because the payment lookup needs the
  // links off EVERY invoice in the refresh at once — asking per invoice would
  // turn one extra query into one per paid invoice.
  const raws: RawInvoice[] = []
  for (let i = 0; i < clean.length; i += BATCH) {
    const list = clean.slice(i, i + BATCH).map((id) => `'${id}'`).join(',')
    const body = await qboRequest<QueryResponse>({
      path: 'query',
      query: { query: `select * from Invoice where Id in (${list})` }
    })
    raws.push(...(body.QueryResponse?.Invoice ?? []))
  }

  const payments = await fetchPaymentsFor(raws)
  const out = new Map<string, QboInvoiceObservation>()
  for (const raw of raws) {
    const observation = toObservation(raw, payments.get(String(raw.Id ?? '')) ?? [])
    if (observation) out.set(observation.qboId, observation)
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
  if (!body.Invoice) return null
  const payments = await fetchPaymentsFor([body.Invoice])
  return toObservation(body.Invoice, payments.get(String(body.Invoice.Id ?? '')) ?? [])
}

/**
 * Find QuickBooks invoices by the number printed on them.
 *
 * The other direction from every other read in this file: those start with a
 * QuickBooks id this app already stored, and this starts with a number somebody
 * typed. It exists for the invoices that have no id to start from — the ones
 * raised in QuickBooks by hand, and the local orders written against the same
 * series (see INVOICE_NUMBER_START, which is set to the owner's next real number
 * precisely because the series did not begin in this app).
 *
 * RETURNS EVERY MATCH, including the several that come back when a company has
 * custom transaction numbers off and QuickBooks has allowed a duplicate. Picking
 * one here would hide the ambiguity from the only code equipped to refuse it —
 * see matchInvoiceByDocNumber, which does the deciding.
 *
 * DocNumbers are quoted into the query, so they are filtered to the characters
 * QuickBooks itself allows in one. Anything else is dropped rather than escaped:
 * a number carrying a quote is not a number this app issued.
 */
export async function findQboInvoicesByDocNumber(
  docNumbers: readonly string[]
): Promise<QboInvoiceMatch[]> {
  const clean = Array.from(
    new Set(
      docNumbers
        .map((n) => String(n ?? '').trim())
        .filter((n) => /^[A-Za-z0-9._-]{1,21}$/.test(n))
    )
  )
  const out: QboInvoiceMatch[] = []
  for (let i = 0; i < clean.length; i += BATCH) {
    const list = clean.slice(i, i + BATCH).map((n) => `'${n}'`).join(',')
    const body = await qboRequest<QueryResponse>({
      path: 'query',
      query: { query: `select * from Invoice where DocNumber in (${list})` }
    })
    for (const raw of body.QueryResponse?.Invoice ?? []) {
      if (!raw.Id) continue
      out.push({
        qboId: String(raw.Id),
        docNumber: raw.DocNumber ?? null,
        customerName: raw.CustomerRef?.name ?? null,
        txnDate: raw.TxnDate ?? null,
        totalAmt: typeof raw.TotalAmt === 'number' ? raw.TotalAmt : null,
        balance: typeof raw.Balance === 'number' ? raw.Balance : null,
        voided: looksVoidedInQbo({
          totalAmt: raw.TotalAmt,
          balance: raw.Balance,
          privateNote: raw.PrivateNote
        })
      })
    }
  }
  return out
}
