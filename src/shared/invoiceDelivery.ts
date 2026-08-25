/**
 * GETTING THE INVOICE IN FRONT OF THE BUYER, WITH THE BANK DETAILS ON IT.
 *
 * ## The gap this closes
 *
 * `sendQboInvoice` — POST invoice/{id}/send — has been in this codebase since
 * the QuickBooks integration was written, and nothing has ever called it. The
 * button that used to was taken off the card on purpose (see the note in the
 * card footer: "Send" beside an invoice already in QuickBooks read as "send it
 * TO QuickBooks"), and the owner has been opening each invoice in QuickBooks and
 * pressing Send there ever since. That is one browser trip per sale.
 *
 * And every one of those invoices then has to say HOW TO PAY IT. A wire needs a
 * bank, a routing number and an account number; the buyer cannot act on an
 * invoice that does not carry them, so they were typed into the message box by
 * hand, per invoice, or left off and asked for by text afterwards.
 *
 * Both are settings, not per-invoice decisions, so both live here.
 *
 * ## Why the instructions are a SETTING and not a constant
 *
 * They are bank details. THIS REPOSITORY IS PUBLIC. Nothing in this file holds a
 * value — it holds the shape and the rules — and the value itself is typed into
 * the running app by the operator and kept in `meta`, which is one of the four
 * tables deliberately left out of sync (see syncTables). It never reaches the
 * relay, never reaches another machine, and never reaches a commit.
 *
 * That is the same treatment the SMTP password and the QuickBooks client secret
 * get, and it is treatment these details deserve slightly less: they are printed
 * on every invoice the business sends, so they are not a credential. What makes
 * them worth keeping out of the repo is that they identify a real bank account,
 * and a public repository is a strange place for one.
 *
 * ## Why auto-send is off until somebody turns it on
 *
 * It emails a customer. An invoice that goes out the instant it is posted cannot
 * be unsent, and the mistyped price is found by the person reading it. The
 * owner's flow today has a look-at-it step in the middle — the browser opens on
 * the invoice — and switching that off is their decision to make, once, in a
 * place that says what it does.
 */

/** The two answers, as one record. */
export interface InvoiceDelivery {
  /**
   * How to pay it, in the buyer's words. Wire details, a Zelle handle, terms.
   *
   * Appended to the invoice's own message, so it lands in QuickBooks'
   * `CustomerMemo` — the block the BUYER reads, not the internal `PrivateNote`.
   * See toQboInvoice, where those two are the wrong way round from how they
   * read.
   */
  paymentInstructions: string
  /**
   * Email it to the buyer the moment it is created in QuickBooks.
   *
   * Off by default, and the default is the feature — see the note above.
   */
  autoSend: boolean
}

export const DEFAULT_INVOICE_DELIVERY: InvoiceDelivery = {
  paymentInstructions: '',
  autoSend: false
}

/**
 * Intuit's limit on CustomerMemo, and the reason this is capped at all.
 *
 * 1000 characters. A memo over it is not truncated by QuickBooks — the whole
 * invoice is REFUSED — so an operator who pastes four paragraphs of terms would
 * find out by having every invoice from then on fail to post, with an error
 * about a field they have forgotten they filled in. Refused here, once, while
 * they are looking at the box.
 */
export const CUSTOMER_MEMO_MAX = 1000

/** Leaving room for the invoice's own message beside it. */
export const PAYMENT_INSTRUCTIONS_MAX = 700

export function validateInvoiceDelivery(input: {
  paymentInstructions?: string | null
}): string | null {
  const text = String(input?.paymentInstructions ?? '')
  if (text.length > PAYMENT_INSTRUCTIONS_MAX) {
    return `Payment instructions are limited to ${PAYMENT_INSTRUCTIONS_MAX} characters — QuickBooks refuses an invoice whose message runs past ${CUSTOMER_MEMO_MAX}.`
  }
  return null
}

/**
 * The message the buyer reads: what was typed on this invoice, then how to pay.
 *
 * ## Three rules, each of which is a bug that would otherwise happen
 *
 * NOTHING IS INVENTED. An invoice with no message and no instructions comes back
 * empty, so `toQboInvoice` omits CustomerMemo entirely rather than sending a
 * blank one. Sending an empty string is not the same as sending nothing —
 * QuickBooks stores it, and it overwrites whatever the customer's default memo
 * would have supplied.
 *
 * THE INSTRUCTIONS ARE NOT ADDED TWICE. An operator who has been pasting the
 * wire details into the message box by hand for months will keep doing it for a
 * while after this exists, and their invoice would carry the account number
 * twice. Compared on collapsed whitespace, because a paste picks up line endings
 * that nobody can see and a character-for-character test would call two
 * identical blocks different.
 *
 * IT IS CLAMPED. Over the limit QuickBooks refuses the whole invoice, and losing
 * the tail of a payment note is better than losing the invoice — but the
 * INSTRUCTIONS survive and the message is what gives way, because an invoice
 * that cannot be paid is worse than one whose covering note stops early.
 */
export function composeCustomerMemo(
  message: string | null | undefined,
  instructions: string | null | undefined
): string {
  const note = String(message ?? '').trim()
  const pay = String(instructions ?? '').trim()
  if (!pay) return note.slice(0, CUSTOMER_MEMO_MAX)
  if (!note) return pay.slice(0, CUSTOMER_MEMO_MAX)
  if (flatten(note).includes(flatten(pay))) return note.slice(0, CUSTOMER_MEMO_MAX)

  const joiner = '\n\n'
  const room = CUSTOMER_MEMO_MAX - pay.length - joiner.length
  // No room for both: the instructions go alone. A covering note is courtesy,
  // and a routing number is the thing the invoice exists to carry.
  if (room <= 0) return pay.slice(0, CUSTOMER_MEMO_MAX)
  return `${note.slice(0, room)}${joiner}${pay}`
}

/** Whitespace-insensitive, for the "already pasted it in" comparison. */
function flatten(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Should this invoice be emailed now, and what to say if it should not be?
 *
 * ONE FUNCTION RATHER THAN A BOOLEAN AND A REASON, so the two can never
 * disagree: a caller that checked the switch itself and then asked separately
 * why not would have two ways to reach "send it" and only one of them tested.
 *
 * A note is a note and never a failure. By the time this is asked the invoice is
 * on Intuit's books; turning "we could not email it" into a failed operation
 * would invite a retry that posts the invoice a second time. The money is right
 * and something optional did not happen, which is the same weight this codebase
 * already gives an unmatched payment term.
 *
 * Switched OFF produces no note at all. Somebody who has not asked for automatic
 * emails does not need to be told, on every invoice, that none was sent.
 */
export function autoSendPlan(
  settings: InvoiceDelivery,
  invoice: { email?: string | null }
): { send: boolean; note: string | null } {
  if (!settings.autoSend) return { send: false, note: null }
  if (!String(invoice?.email ?? '').trim()) {
    return {
      send: false,
      note: 'Not emailed — this buyer has no email address on file. Add one and send it from QuickBooks.'
    }
  }
  return { send: true, note: null }
}
