/**
 * WHETHER TO RECORD A PAYMENT IN QUICKBOOKS, AND FOR HOW MUCH.
 *
 * Ticking "paid" in this app has always been a local record and nothing else.
 * That is right for the cash and the wires QuickBooks never sees, and wrong for
 * the invoices that ARE in QuickBooks and sit there owing money the owner has
 * already banked — which is the state the card had to apologise for in words:
 * "Marked paid here — QuickBooks still shows $28,000.00 owing."
 *
 * This decides. It is a pure function on purpose: posting a payment is the one
 * thing this app does that MOVES MONEY IN SOMEBODY ELSE'S BOOKS, and the rules
 * for when it may are worth reading in one place rather than inferring from the
 * order of some awaits.
 *
 * ## The five rules, and why each one exists
 *
 * 1. THE AMOUNT IS QUICKBOOKS' BALANCE, NEVER THIS APP'S TOTAL. If a buyer part
 *    paid and somebody recorded that in QuickBooks, the balance is what is left
 *    and the total is what it started as. Paying the total would post more money
 *    than is owed and leave a credit on the customer.
 *
 * 2. NOTHING OWING IS SUCCESS. A balance already at zero means somebody got
 *    there first — a payment entered by hand, a credit memo, a deposit. There is
 *    nothing to do and nothing wrong, and reporting it as a failure would train
 *    the owner to ignore a message that sometimes means the opposite.
 *
 * 3. AN INVOICE THAT IS NOT IN QUICKBOOKS GETS NOTHING. No id, nothing to pay
 *    against. This is the ordinary state of a roadshow sale and is not an error
 *    either.
 *
 * 4. IT POSTS ONCE. A payment id already recorded here means a payment already
 *    exists there. Retrying on a timeout is how the same $28,000 gets banked
 *    twice, and the second one is somebody's afternoon to find and unpick.
 *
 * 5. A STALE READING MAY NOT AUTHORISE A PAYMENT. The balance is an observation
 *    with a time on it, and this app can hold one taken hours ago on a machine
 *    that cannot refresh it — see FRESHER_ONLY in main/db/sync.ts. Deciding to
 *    move money off a reading nobody has checked recently is exactly the case
 *    where being cautious costs a click and being wrong costs a reconciliation.
 *    So the caller must pass a FRESH observation, and this refuses without one.
 *
 * The refusals are all named rather than folded into one false, because "there
 * is nothing owing" and "I do not trust what I know" want different words on
 * the screen and different behaviour from a retry.
 */

/** How stale a QuickBooks reading may be and still authorise a payment. */
export const PAYMENT_READING_MAX_AGE_MS = 5 * 60 * 1000

export type PaymentAction =
  /** Post a payment for `amount`. */
  | 'post'
  /** Already settled in QuickBooks. Nothing to do, nothing wrong. */
  | 'nothing-owing'
  /** Never reached QuickBooks, so there is nothing to pay against. */
  | 'not-in-quickbooks'
  /** This app already posted one. Posting again would double the money. */
  | 'already-posted'
  /** Not marked paid here, so nothing is being claimed. */
  | 'not-paid-here'
  /** Voided in QuickBooks. Paying a void is meaningless. */
  | 'voided'
  /** The reading is too old, or there is none, to move money on. */
  | 'stale-reading'

export interface PaymentPlan {
  action: PaymentAction
  /** Dollars to post. Zero for every action but 'post'. */
  amount: number
  /** Whether a retry could change this answer. */
  retryable: boolean
  /** One sentence, for the screen. */
  sentence: string
}

export interface PaymentSubject {
  /** Marked paid on this board. */
  paidHere: boolean
  /** The invoice's id in QuickBooks, or null if it never went. */
  qboId: string | null
  /** A payment this app has already posted, if any. */
  qboPaymentId: string | null
}

/**
 * What QuickBooks said, and WHEN.
 *
 * `checkedAt` is not decoration: rule 5 is the whole reason this shape carries a
 * time at all. A balance with no time attached is a number somebody remembers,
 * not a reading.
 */
export interface PaymentReading {
  balance: number | null
  totalAmt: number | null
  voided: boolean
  checkedAt: string | null
}

const money = (n: number): number => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0)

const fmt = (n: number): string =>
  `$${money(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Milliseconds between an ISO instant and `now`, or null if it is not one. */
function ageMs(iso: string | null, nowMs: number): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return nowMs - t
}

/**
 * The decision, in the order the rules have to be applied.
 *
 * ORDER MATTERS AND IS NOT ARBITRARY. "Already posted" is checked before the
 * balance, because a stale reading taken before this app's own payment landed
 * will still show money owing — and treating that as authority to post is
 * precisely how the double payment happens. Everything cheap and certain is
 * settled before anything that depends on a number that could be old.
 *
 * `nowMs` is passed in rather than read, so the staleness rule is testable and
 * so this stays pure.
 */
export function paymentPlan(
  subject: PaymentSubject,
  reading: PaymentReading | null,
  nowMs: number
): PaymentPlan {
  const no = (action: PaymentAction, sentence: string, retryable = false): PaymentPlan => ({
    action,
    amount: 0,
    retryable,
    sentence
  })

  if (!subject.paidHere) {
    return no('not-paid-here', 'This invoice is not marked paid here, so nothing is owed to QuickBooks yet.')
  }
  if (!subject.qboId) {
    return no(
      'not-in-quickbooks',
      'This invoice never went to QuickBooks, so there is nothing there to record a payment against.'
    )
  }
  // BEFORE the balance, deliberately. See the note above.
  if (subject.qboPaymentId) {
    return no(
      'already-posted',
      'A payment for this invoice has already been recorded in QuickBooks by this app.'
    )
  }
  if (!reading) {
    return no(
      'stale-reading',
      'Nobody has asked QuickBooks about this invoice yet. Check it first — a payment should ' +
        'not be posted against a balance this app is guessing at.',
      true
    )
  }
  if (reading.voided) {
    return no('voided', 'QuickBooks has this invoice voided, so a payment against it would mean nothing.')
  }

  const age = ageMs(reading.checkedAt, nowMs)
  if (age === null || age > PAYMENT_READING_MAX_AGE_MS || age < 0) {
    return no(
      'stale-reading',
      'The last reading from QuickBooks is too old to post money against. Check QuickBooks again ' +
        'and the payment will go with it.',
      true
    )
  }

  const balance = reading.balance === null ? null : money(reading.balance)
  if (balance === null) {
    return no(
      'stale-reading',
      'QuickBooks has not said what is outstanding on this invoice, so there is no amount to post.',
      true
    )
  }
  if (balance <= 0) {
    return no(
      'nothing-owing',
      'QuickBooks already shows this invoice settled, so there is nothing left to pay.'
    )
  }

  return {
    action: 'post',
    amount: balance,
    retryable: false,
    sentence: `Recording ${fmt(balance)} against this invoice in QuickBooks — the balance it still shows outstanding.`
  }
}

/** Did anything actually need doing? Used to keep quiet screens quiet. */
export function paymentWorthDoing(plan: PaymentPlan): boolean {
  return plan.action === 'post'
}

/**
 * The Payment entity, exactly as QuickBooks wants it.
 *
 * Built here rather than in the caller so the SHAPE is covered by the same
 * tests as the decision. Two details are easy to get wrong and both cost money:
 *
 *   - `Line[].LinkedTxn` is what attaches the payment to THIS invoice. Without
 *     it QuickBooks accepts the payment and leaves it floating as an unapplied
 *     credit on the customer, which looks like it worked and settles nothing.
 *   - `TotalAmt` and the line `Amount` must agree. QuickBooks will take a
 *     payment whose parts do not sum to its total and apply the difference
 *     nowhere.
 *
 * No DepositToAccountRef and no PaymentMethodRef: without them QuickBooks puts
 * the money in Undeposited Funds, which is where a payment whose banking nobody
 * has described belongs. Naming an account this app has guessed at would file
 * real money in the wrong place silently.
 */
export function paymentPayload(input: {
  customerId: string
  qboInvoiceId: string
  amount: number
  txnDate: string
  reference?: string | null
}): Record<string, unknown> {
  const amount = money(input.amount)
  const payload: Record<string, unknown> = {
    CustomerRef: { value: String(input.customerId) },
    TotalAmt: amount,
    TxnDate: input.txnDate,
    Line: [
      {
        Amount: amount,
        LinkedTxn: [{ TxnId: String(input.qboInvoiceId), TxnType: 'Invoice' }]
      }
    ]
  }
  const ref = (input.reference ?? '').trim()
  // QuickBooks caps this at 21 characters and rejects the whole payment if it is
  // longer — a payment refused because somebody typed a long note is not a
  // failure worth having.
  if (ref) payload.PaymentRefNum = ref.slice(0, 21)
  return payload
}
