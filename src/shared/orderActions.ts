/**
 * WHAT THE BUTTONS ON A SALES ORDER CARD SAY, AND WHAT PRESSING ONE DOES.
 *
 * The owner, looking at nine buttons on one card: "I just really need a way to
 * edit to sales order at any point, add in dimensions, have a quickbooks button
 * just one that tells me the status and moves it into quickbooks if needed, mark
 * it as paid, like dont need 2 buttons there because if something is set as
 * marked as paid in the begingin marking it paid would mark it paid according to
 * the terms".
 *
 * Four of those nine were about QuickBooks — To QuickBooks, Retry QuickBooks,
 * Record payment in QuickBooks, Open in QuickBooks — plus a fifth, Check now, on
 * the banner above them. Two were about money: Mark paid and Paid up front…,
 * which is the SECOND time two controls on this card have shared one word (see
 * the comment on "To payment" in InvoicesBoard, where the last pair was pulled
 * apart). Six controls answering two questions.
 *
 * ## Why this is a pure function in shared/ and not a chain of ternaries
 *
 * Because the bug the owner is reporting is not "too many buttons". It is that
 * the card had no single place that decided WHICH act an order needs, so each
 * button decided for itself out of a gate written months apart from the others —
 * and gates written separately overlap. One function returning ONE action makes
 * the overlap unrepresentable: there is no arrangement of the fields below that
 * yields two QuickBooks buttons, because there is only one return.
 *
 * `paymentPlan` in ./quickbooksPayment is the model this follows deliberately —
 * a ladder where the first match wins, every refusal named separately, and no
 * clock or locale of its own.
 *
 * ## No dates, no money, no clock
 *
 * Every sentence this file produces is assembled from values handed in, and the
 * two things a person actually reads — an amount and a day — are formatted by
 * the CALLER and passed in as `OrderTextFormats`. Three reasons, all of them
 * paid for in this repo already: money formatting belongs to the renderer's
 * locale, a date-only string parsed here would be parsed at local midnight (see
 * CLAUDE.md), and this file's test suite is built without the timezone banner,
 * so a `new Date()` in here would pass on the bench and be wrong in Chicago.
 */
import { isInvoicePaid, qboTotalState } from './invoices'
import type { InvoicePushState, InvoiceStatus } from './invoices'

/**
 * Formatting the card already owns, lent to this file for the length of a call.
 *
 * `money` is the renderer's `formatMoney`; `day` turns an ISO instant into
 * something like "Sep 2, 2026". Neither is implemented here — see the header.
 */
export interface OrderTextFormats {
  money: (n: number) => string
  day: (iso: string) => string
}

// ---------------------------------------------------------------------------
// The one QuickBooks button
// ---------------------------------------------------------------------------

/**
 * What pressing the QuickBooks button does.
 *
 * `push-again` is deliberately NOT the same id as `push`, even though both end
 * in the same call. A push whose previous attempt was interrupted may already
 * have landed in the operator's real books, so it is the one press on this card
 * that can create a second invoice for a five-figure case — it gets its own id
 * so it can carry its own warning and its own confirm, and so no future edit can
 * accidentally fold it back into the harmless one.
 */
export type QboActionId =
  | 'push'
  | 'push-again'
  | 'retry'
  | 'check'
  | 'record-payment'
  | 'open'
  | 'none'

export interface QboAction {
  id: QboActionId
  /** The face of the button. Names the ACT, not the state. */
  label: string
  /**
   * The tooltip, and the reason this button can replace four.
   *
   * It opens with where the order stands in QuickBooks — "In QuickBooks as
   * invoice 1043, $6,900.00 owing" — and only then says what the press does.
   * That first clause is the "tells me the status" half of the owner's ask; the
   * label alone could never carry it.
   */
  title: string
  /** Amber, for the two presses that touch real books in an uncertain state. */
  warn: boolean
  /** Ask before doing it. Only where a press can duplicate a document or money. */
  confirm: boolean
}

export interface QboActionFacts {
  status: InvoiceStatus
  qboId: string | null
  qboDocNumber: string | null
  qboPushState: InvoicePushState
  qboPushError: string | null
  qboVoided: boolean
  qboBalance: number | null
  qboTotalAmt: number | null
  qboPaidAt: string | null
  qboPaymentId: string | null
  qboPaymentPostedAt: string | null
  qboStatusCheckedAt: string | null
  qboStatusAttemptedAt: string | null
  qboStatusError: string | null
  totalChangedAt: string | null
  total: number
  /**
   * Read for the WORDING only, never for the gate.
   *
   * The gate below is the stage — `status === 'paid'` — because that is what
   * `paymentPlan` calls `paidHere`, and gating on anything else would offer a
   * press the main process answers with `not-paid-here`. But the two come apart:
   * dragging a card into the Payment column without ticking anything leaves the
   * stage saying paid and this saying null, and the first draft of this file
   * then told the operator "Marked paid here" about an order nobody had marked.
   */
  paidAt: string | null
}

/** "invoice 1043", or just "it" on one that has no number over there yet. */
function docPhrase(facts: QboActionFacts): string {
  const n = (facts.qboDocNumber ?? '').trim()
  return n ? `invoice ${n}` : 'it'
}

/**
 * A FAILED READ IS APPENDED, NEVER SUBSTITUTED.
 *
 * `qboStatusError` is the stored reason the last status pull did not land. Today
 * it is written on every failure and shown nowhere outside the toast that has
 * long since gone, so an operator pressing Check and seeing nothing change has
 * no way to learn why. It is appended to whatever sentence the ladder produced
 * rather than replacing it, because the last GOOD reading is still the truth
 * about the invoice — a read that failed did not make the balance unknown, it
 * made it old.
 */
function withReadFailure(title: string, facts: QboActionFacts): string {
  const err = (facts.qboStatusError ?? '').trim()
  if (!err) return title
  const attempted = facts.qboStatusAttemptedAt
  const checked = facts.qboStatusCheckedAt
  // Only when the FAILURE is the most recent thing that happened. An error left
  // over from before a later successful read is history, not news.
  if (attempted && checked && attempted <= checked) return title
  return `${title} The last read failed: ${err}`
}

/**
 * The one QuickBooks control, as a ladder. FIRST MATCH WINS.
 *
 * Two orderings are load-bearing and must not be swapped.
 *
 * **The totals gap is checked before offering to pay.** Never offer to post
 * money against a balance already known to disagree with our own total: "fix
 * the figure, then pay it" is the sequence the gap banner has always asked for,
 * and paying first banks a number somebody is about to change.
 *
 * **`qboPaymentId` is checked before any balance.** It is the double-post
 * interlock, and the balance sitting on this card straight after our own post is
 * a reading taken BEFORE that payment landed — treating it as authority is
 * exactly how an invoice gets paid twice in real books. `paymentPlan` orders its
 * refusals the same way for the same reason.
 *
 * ## The push is still gated on DRAFT, and that is not timidity
 *
 * `markPosted` writes `status = 'created'` unconditionally, so offering the push
 * on an order that has already reached Ready to ship would drag its card
 * backwards two columns as a side effect of putting it on the books. Plenty of
 * orders here are settled in cash and never go near QuickBooks; the honest thing
 * to tell somebody looking at one is that it is not over there, which is what
 * `none` says. It is the only state with no useful press, and it renders
 * DISABLED rather than hidden — a control that vanishes reads as a bug, and this
 * card carries no other explanation.
 */
export function quickBooksAction(facts: QboActionFacts, fmt: OrderTextFormats): QboAction {
  const doc = docPhrase(facts)
  const act = (id: QboActionId, label: string, title: string, warn = false, confirm = false): QboAction => ({
    id,
    label,
    title: withReadFailure(title, facts),
    warn,
    confirm
  })

  if (facts.qboVoided) {
    return act('open', 'Voided in QuickBooks', `Voided in QuickBooks. Opens ${doc} in the browser.`)
  }

  if (!facts.qboId) {
    if (facts.qboPushState === 'pending') {
      return act(
        'push-again',
        'Send to QuickBooks',
        'A previous attempt was interrupted, so this may already be in QuickBooks. Look there first — pressing this can create a second invoice.',
        true,
        true
      )
    }
    if (facts.qboPushState === 'failed') {
      const why = (facts.qboPushError ?? '').trim()
      return act(
        'retry',
        'Retry QuickBooks',
        why
          ? `QuickBooks refused it: ${why} Fix that, then press to try again.`
          : 'QuickBooks refused this invoice. Press to try again.',
        true
      )
    }
    if (facts.status === 'draft') {
      return act('push', 'Send to QuickBooks', 'Not in QuickBooks yet. Posts this invoice and opens it there.')
    }
    return act(
      'none',
      'Not in QuickBooks',
      'This order was never posted to QuickBooks. Orders settled in cash often are not — match it to an invoice over there from the QuickBooks tab if it should be.'
    )
  }

  const owing = Number(facts.qboBalance ?? 0)

  if (facts.qboStatusCheckedAt === null) {
    return act('check', 'Check QuickBooks', `In QuickBooks as ${doc}. Nobody has read its status yet — press to read it.`)
  }

  const totals = qboTotalState(facts)
  if (totals.kind === 'unverified') {
    return act('check', 'Check QuickBooks', `In QuickBooks as ${doc}, but not read since you edited this order. Press to read it again.`)
  }
  if (totals.kind === 'differs') {
    const side = totals.gap > 0 ? 'lower' : 'higher'
    return act(
      'check',
      'Check QuickBooks',
      `In QuickBooks as ${doc}, ${fmt.money(Math.abs(totals.gap))} ${side} than this order. Change it over there, then press to re-read.`
    )
  }

  if (facts.qboPaymentId && owing > 0) {
    const when = facts.qboPaymentPostedAt ? ` on ${fmt.day(facts.qboPaymentPostedAt)}` : ''
    return act(
      'check',
      'Check QuickBooks',
      `Payment already posted to QuickBooks${when}; the balance shown here was read before that. Press to read it again.`
    )
  }

  if (facts.status === 'paid' && !facts.qboPaymentId && owing > 0) {
    return act(
      'record-payment',
      'Record payment',
      facts.paidAt
        ? `Marked paid here, and QuickBooks still shows ${fmt.money(owing)} owing on ${doc}. Posts that payment there.`
        : `Settling up here, and QuickBooks still shows ${fmt.money(owing)} owing on ${doc}. Posts a payment there for whatever it says is outstanding.`,
      false,
      true
    )
  }

  if (facts.qboPaidAt) {
    return act('open', 'Open in QuickBooks', `Paid in QuickBooks on ${fmt.day(facts.qboPaidAt)}. Opens ${doc} in the browser.`)
  }
  if (owing > 0) {
    return act('open', 'Open in QuickBooks', `In QuickBooks as ${doc}, ${fmt.money(owing)} owing. Opens it in the browser.`)
  }
  return act('open', 'Open in QuickBooks', `In QuickBooks as ${doc}, nothing owing. Opens it in the browser.`)
}

// ---------------------------------------------------------------------------
// The one money button
// ---------------------------------------------------------------------------

/**
 * When the money was meant to change hands. Mirrors `PaymentTiming` in ./freight
 * without importing it, so this file stays readable on its own; `null` is a real
 * third answer and means nobody has said.
 */
export type OrderPaymentTiming = 'front' | 'delivery' | null

export type PaidActionId = 'record' | 'withdraw' | 'none'

export interface PaidAction {
  id: PaidActionId
  label: string
  title: string
  /**
   * WHAT THE DIALOG SAYS UNDER ITS TITLE — the "according to the terms" half.
   * Empty for the withdraw and none cases, which have nothing to explain.
   */
  detail: string
  /**
   * Does this payment count as having arrived BEFORE anything shipped?
   *
   * Written straight through to `paid_up_front`, whose own doc comment is "the
   * money arrived before anything shipped". An order the buyer pays ON DELIVERY
   * is the one case where that is plainly false, and until this existed the
   * dialog wrote the flag unconditionally — so recording an on-delivery payment
   * stated something nobody had claimed. It is not read anywhere except under
   * `paymentTiming === 'front'`, so no screen changes; the point is that the
   * column stops holding a fact that is not true.
   */
  upFront: boolean
}

export interface PaidActionFacts {
  status: InvoiceStatus
  paidAt: string | null
  qboPaidAt: string | null
  qboVoided: boolean
  paymentTiming: OrderPaymentTiming
  total: number
}

/**
 * The one money control. FIRST MATCH WINS.
 *
 * ## Why one button can serve both flows
 *
 * Because `recordInvoicePayment` is a strict superset of `setInvoicePaid`: it
 * stamps `paid_at` exactly the same way and ALSO records how the money arrived,
 * optionally releases the order to the packing floor, and optionally moves the
 * card. Everything the plain tick did, the dialog does with its defaults left
 * alone — so merging the two costs nothing and gains the method and reference on
 * every payment instead of only the ones somebody remembered to enter twice.
 *
 * The press count does not change either, which is the thing to check before
 * calling a dialog "more friction": the plain tick already opened a confirm, so
 * both paths were press-then-press and both still are.
 *
 * ## What the terms actually change
 *
 * Only the words and the up-front flag. An up-front order is being HELD by this
 * — nothing ships until the money is in — so its sentence says that pressing is
 * what releases it. An on-delivery order is not being held by anything, so its
 * sentence says the release is just a statement that it is ready to pick. Both
 * dialogs offer the same controls, because a deposit against a case order is a
 * real thing on either terms and hiding the boxes would be deciding for somebody.
 *
 * ## QUICKBOOKS OWNS THE FACT WHERE IT SPEAKS
 *
 * `qboPaidAt` is Intuit's own record that a payment was applied. Where it is
 * set, this returns `none` — there is no button, because there is nothing this
 * app may honestly offer to do about a payment in somebody's books. Unchanged
 * from the gate that has always been on Mark paid.
 */
export function paidAction(facts: PaidActionFacts): PaidAction {
  const none = (title: string): PaidAction => ({ id: 'none', label: '', title, detail: '', upFront: false })

  if (facts.status === 'void' || facts.qboVoided) {
    return none('This order was voided, so it can neither owe nor be paid.')
  }
  if (facts.qboPaidAt) {
    return none('QuickBooks has a payment applied to this invoice, and the books are the record for money.')
  }
  if (isInvoicePaid(facts)) {
    return {
      id: 'withdraw',
      label: 'Mark not paid',
      title:
        'Withdraws the payment recorded here. Nothing is refunded — it only changes what the board says. The order keeps its place on the packing list.',
      detail: '',
      upFront: false
    }
  }

  const upFront = facts.paymentTiming !== 'delivery'
  return {
    id: 'record',
    label: 'Mark paid…',
    title:
      facts.paymentTiming === 'front'
        ? 'This buyer pays up front and nothing is recorded yet. Records the money and releases it to the packing list.'
        : 'Records that the money arrived, with how it was paid.',
    detail:
      facts.paymentTiming === 'front'
        ? 'This buyer pays up front, so recording the money is what lets it be picked.'
        : facts.paymentTiming === 'delivery'
          ? 'This buyer pays on delivery, so it was never held for the money.'
          : 'Nobody has said whether this buyer pays up front or on delivery.',
    upFront
  }
}
