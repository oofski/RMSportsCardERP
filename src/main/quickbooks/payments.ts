/**
 * Recording a payment in QuickBooks for an invoice that was marked paid here.
 *
 * Ticking "paid" on the sales board has always been a local record. That is
 * right for the cash and the wires QuickBooks never sees, and wrong for the
 * invoices that ARE in QuickBooks and sit there owing money already banked —
 * the state the card had to apologise for in words: "Marked paid here —
 * QuickBooks still shows $28,000.00 owing."
 *
 * ## THE READING IS TAKEN HERE, IMMEDIATELY BEFORE POSTING
 *
 * Not read from the invoice row. The row's balance is an observation that can
 * be hours old, can have arrived from a machine that cannot refresh it, and is
 * exactly the number that was wrong when this feature was asked for. Money is
 * not moved on a remembered figure: this asks QuickBooks what is outstanding,
 * and posts that, and the two happen a few hundred milliseconds apart.
 *
 * A side effect worth naming: the fresh reading is WRITTEN BACK whatever
 * happens, including when it turns out nothing was owing. So a run that posts
 * nothing still leaves the card correct, which is the outcome the owner wanted
 * from "Check QuickBooks" anyway.
 *
 * ## WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not touch the local paid flag, ever, in either direction. Paid here is
 * the operator's record of what they banked; whether QuickBooks has caught up is
 * a different fact with its own columns. Letting a failed post un-tick paid
 * would let a network timeout rewrite the books.
 *
 * It does not retry itself. A retry that runs without a human is how a timeout
 * whose payment actually landed becomes two payments — and the interlock that
 * stops that (`qbo_payment_id`) is only written when a reply comes back, which
 * is the one thing a timeout does not give you. So a failure is recorded as a
 * state and a person presses the button again, having looked.
 */
import { paymentPayload, paymentPlan, type PaymentPlan } from '@shared/quickbooksPayment'
import { getInvoice, recordQboObservation, recordQboPayment, recordQboPaymentFailure } from '../db/invoices'
import { fetchQboInvoiceStatus } from './invoiceStatus'
import { qboRequest } from './client'

export interface PaymentOutcome {
  ok: boolean
  /** What was decided, and why — the sentence is fit for the screen. */
  plan: PaymentPlan
  /** QuickBooks' id for the payment, when one was created. */
  paymentId: string | null
  error: string | null
}

interface RawPaymentResponse {
  Payment?: { Id?: string }
}

/**
 * The date to stamp the payment with.
 *
 * The day the money was RECORDED as received here, not today, when they differ
 * — an invoice ticked paid on Friday and pushed on Monday belongs in Friday's
 * takings or the month it falls in is wrong. Falls back to today when the local
 * record has no date, which is the only honest answer left.
 *
 * Date-only, and sliced off an ISO instant rather than formatted from a local
 * calendar: QuickBooks wants YYYY-MM-DD, and a local formatter would move the
 * date across a midnight for anybody east or west of the machine that typed it.
 */
function txnDateFor(paidAt: string | null): string {
  const iso = (paidAt ?? '').trim()
  if (iso.length >= 10) {
    const day = iso.slice(0, 10)
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return day
  }
  return new Date().toISOString().slice(0, 10)
}

/**
 * Post a payment for one invoice, if one is due.
 *
 * Never throws for an ordinary refusal — "nothing owing", "not in QuickBooks",
 * "already posted" are answers, not faults, and a caller that has to catch them
 * ends up treating them all as failures. Only a real transport or API failure
 * comes back with ok false and an error.
 */
export async function postQboPaymentFor(invoiceId: string): Promise<PaymentOutcome> {
  const local = getInvoice(invoiceId)
  if (!local) {
    const plan: PaymentPlan = {
      action: 'not-in-quickbooks',
      amount: 0,
      retryable: false,
      sentence: 'That invoice is not on this machine.'
    }
    return { ok: false, plan, paymentId: null, error: 'No such invoice.' }
  }

  const subject = {
    paidHere: local.status === 'paid',
    qboId: local.qboId ?? null,
    qboPaymentId: local.qboPaymentId ?? null
  }

  // The cheap refusals first, BEFORE spending a round trip on a reading that
  // cannot change any of them. `paymentPlan` is given no reading here on
  // purpose: with none it returns 'stale-reading', which is the one answer that
  // means "go and look" — so anything else it says now is final.
  const early = paymentPlan(subject, null, Date.now())
  if (early.action !== 'stale-reading') {
    return { ok: true, plan: early, paymentId: null, error: null }
  }

  let observation
  try {
    observation = await fetchQboInvoiceStatus(String(subject.qboId))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    recordQboPaymentFailure(invoiceId, message)
    return {
      ok: false,
      plan: {
        action: 'stale-reading',
        amount: 0,
        retryable: true,
        sentence: 'QuickBooks could not be asked what is outstanding, so no payment was recorded.'
      },
      paymentId: null,
      error: message
    }
  }

  if (!observation) {
    const message =
      'QuickBooks does not have an invoice with that id any more — it may have been deleted there.'
    recordQboPaymentFailure(invoiceId, message)
    return {
      ok: false,
      plan: { action: 'not-in-quickbooks', amount: 0, retryable: false, sentence: message },
      paymentId: null,
      error: message
    }
  }

  // WRITE THE READING BACK WHATEVER HAPPENS NEXT. It is a fresh observation and
  // it is worth having even if nothing is posted against it — see the header.
  recordQboObservation(invoiceId, observation)

  const plan = paymentPlan(
    subject,
    {
      balance: observation.balance,
      totalAmt: observation.totalAmt,
      voided: observation.voided,
      // Just taken, by this function, a moment ago. Stating that rather than
      // re-reading the column keeps the freshness rule honest: the row's stamp
      // is what recordQboObservation just wrote, and reading our own write back
      // to prove freshness would prove nothing.
      checkedAt: new Date().toISOString()
    },
    Date.now()
  )
  if (plan.action !== 'post') {
    return { ok: true, plan, paymentId: null, error: null }
  }

  const customerId = observation.customerId
  if (!customerId) {
    const message =
      'QuickBooks did not say which customer this invoice belongs to, and a payment has to name one.'
    recordQboPaymentFailure(invoiceId, message)
    return { ok: false, plan, paymentId: null, error: message }
  }

  try {
    const res = await qboRequest<RawPaymentResponse>({
      method: 'POST',
      path: 'payment',
      body: paymentPayload({
        customerId,
        qboInvoiceId: String(subject.qboId),
        amount: plan.amount,
        txnDate: txnDateFor(local.paidAt ?? null),
        reference: local.paymentReference ?? null
      })
    })
    const paymentId = res.Payment?.Id ? String(res.Payment.Id) : null
    if (!paymentId) {
      // A payment that exists and cannot be named is the worst outcome here: the
      // interlock has nothing to hold, so the next attempt would post a second
      // one. Say so plainly rather than recording a success with no id.
      const message =
        'QuickBooks accepted the payment but did not say what it was called, so this app cannot ' +
        'be sure it will not send a second one. Check the invoice in QuickBooks before retrying.'
      recordQboPaymentFailure(invoiceId, message)
      return { ok: false, plan, paymentId: null, error: message }
    }
    recordQboPayment(invoiceId, paymentId)
    return { ok: true, plan, paymentId, error: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    recordQboPaymentFailure(invoiceId, message)
    return { ok: false, plan, paymentId: null, error: message }
  }
}
