/**
 * RECORDING A PAYMENT IN QUICKBOOKS: when, for how much, and when NOT.
 *
 * Ticking "paid" here has always been a local record, which is right for the
 * cash and wires QuickBooks never sees and wrong for the invoices that ARE in
 * QuickBooks and sit there owing money already banked. The card had to
 * apologise for it in words: "Marked paid here — QuickBooks still shows
 * $28,000.00 owing."
 *
 * This is the only thing the app does that MOVES MONEY IN SOMEBODY ELSE'S
 * BOOKS, so the rules are tested harder than the feature. The failure that
 * matters is not "it did not post" — that is a button press away — it is
 * "it posted twice", which is somebody's afternoon with a reconciliation.
 *
 * Run: npm run test:qbo-payment
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const {
  paymentPlan,
  paymentPayload,
  paymentWorthDoing,
  PAYMENT_READING_MAX_AGE_MS
} = require('../src/shared/quickbooksPayment')

let pass = 0
let fail = 0
const ok = (cond: boolean, what: string, detail?: string): void => {
  if (cond) {
    pass += 1
    console.log(`  ok   ${what}`)
  } else {
    fail += 1
    console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ''}`)
  }
}

const NOW = Date.parse('2026-09-01T18:00:00.000Z')
const fresh = (iso = '2026-09-01T17:59:00.000Z') => iso

const paid = { paidHere: true, qboId: '2389', qboPaymentId: null }
const reading = (over: Record<string, unknown> = {}) => ({
  balance: 28_000,
  totalAmt: 28_000,
  voided: false,
  checkedAt: fresh(),
  ...over
})

// ---------------------------------------------------------------------------
console.log('\n=== 1. the ordinary case: paid here, owing there ===')
// ---------------------------------------------------------------------------
{
  const plan = paymentPlan(paid, reading(), NOW)
  ok(plan.action === 'post', 'it posts', plan.action)
  ok(plan.amount === 28_000, 'for the full outstanding balance', String(plan.amount))
  ok(paymentWorthDoing(plan), 'and reports itself as work worth doing')
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. THE AMOUNT IS THE BALANCE, NEVER THE TOTAL ===')
// ---------------------------------------------------------------------------
{
  // A buyer part paid and somebody recorded it in QuickBooks. The total is what
  // the invoice started as; the balance is what is left. Paying the total would
  // post $28,000 against $6,000 owed and leave a credit on the customer.
  const plan = paymentPlan(paid, reading({ balance: 6_000, totalAmt: 28_000 }), NOW)
  ok(plan.action === 'post', 'a part-paid invoice still posts')
  ok(
    plan.amount === 6_000,
    'FOR WHAT IS LEFT, NOT WHAT IT STARTED AS — the other way round overpays by the part ' +
      'already banked and leaves a credit to unpick',
    String(plan.amount)
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. the refusals, each named and each for its own reason ===')
// ---------------------------------------------------------------------------
{
  ok(
    paymentPlan({ ...paid, paidHere: false }, reading(), NOW).action === 'not-paid-here',
    'not marked paid here — nothing is being claimed, so nothing is posted'
  )
  ok(
    paymentPlan({ ...paid, qboId: null }, reading(), NOW).action === 'not-in-quickbooks',
    'never went to QuickBooks — there is nothing there to pay against'
  )
  const settled = paymentPlan(paid, reading({ balance: 0 }), NOW)
  ok(
    settled.action === 'nothing-owing' && settled.amount === 0,
    'ALREADY SETTLED IS A SUCCESS, NOT A FAULT — somebody got there first, by hand or by ' +
      'credit memo, and calling that a failure trains people to ignore the word',
    settled.action
  )
  ok(
    paymentPlan(paid, reading({ balance: -50 }), NOW).action === 'nothing-owing',
    'and an overpaid invoice is not topped up further'
  )
  ok(
    paymentPlan(paid, reading({ voided: true }), NOW).action === 'voided',
    'a voided invoice takes no payment — there is nothing left to settle'
  )
  ok(
    paymentPlan(paid, reading({ balance: null }), NOW).action === 'stale-reading',
    'AND A BALANCE QUICKBOOKS DID NOT STATE IS NOT ZERO — no amount, no payment',
    paymentPlan(paid, reading({ balance: null }), NOW).action
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. IT POSTS ONCE. The rule the whole feature turns on ===')
// ---------------------------------------------------------------------------
{
  const already = paymentPlan({ ...paid, qboPaymentId: 'PAY-1' }, reading(), NOW)
  ok(already.action === 'already-posted', 'a payment already recorded blocks a second', already.action)
  ok(already.amount === 0, 'and no amount comes back with it')

  // THE ORDER OF THE CHECKS IS THE POINT. A reading taken BEFORE this app's own
  // payment landed still shows the money owing — so if the balance were consulted
  // first, the app would look at $28,000 outstanding, decide to post, and bank it
  // twice. "Already posted" is settled before anything that could be old.
  const staleShowsOwing = paymentPlan(
    { ...paid, qboPaymentId: 'PAY-1' },
    reading({ balance: 28_000, checkedAt: '2026-09-01T17:00:00.000Z' }),
    NOW
  )
  ok(
    staleShowsOwing.action === 'already-posted',
    'AND IT WINS OVER A STALE READING THAT STILL SHOWS MONEY OWING — which is exactly the ' +
      'shape a retry after a relay timeout has, and exactly how the same money gets banked twice',
    staleShowsOwing.action
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. a stale reading may not authorise money ===')
// ---------------------------------------------------------------------------
{
  const old = paymentPlan(
    paid,
    reading({ checkedAt: new Date(NOW - PAYMENT_READING_MAX_AGE_MS - 1000).toISOString() }),
    NOW
  )
  ok(old.action === 'stale-reading', 'a reading past the age limit refuses', old.action)
  ok(old.retryable === true, 'and says a retry could fix it — check QuickBooks and go again')

  const justInside = paymentPlan(
    paid,
    reading({ checkedAt: new Date(NOW - PAYMENT_READING_MAX_AGE_MS + 1000).toISOString() }),
    NOW
  )
  ok(justInside.action === 'post', 'one just inside the limit is good enough to act on')

  ok(paymentPlan(paid, null, NOW).action === 'stale-reading', 'and no reading at all refuses too')
  ok(
    paymentPlan(paid, reading({ checkedAt: null }), NOW).action === 'stale-reading',
    'A BALANCE WITH NO TIME ON IT IS A NUMBER SOMEBODY REMEMBERS, NOT A READING'
  )
  ok(
    paymentPlan(paid, reading({ checkedAt: 'not a date' }), NOW).action === 'stale-reading',
    'and an unparseable stamp is treated as no stamp rather than as the epoch'
  )
  // A clock skewed forward on another machine must not read as infinitely fresh.
  ok(
    paymentPlan(paid, reading({ checkedAt: '2026-09-02T18:00:00.000Z' }), NOW).action ===
      'stale-reading',
    'and a reading stamped in the FUTURE is refused rather than trusted — a skewed clock is ' +
      'not evidence'
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. the payload, where two mistakes cost real money ===')
// ---------------------------------------------------------------------------
{
  const body = paymentPayload({
    customerId: '58',
    qboInvoiceId: '2389',
    amount: 28_000,
    txnDate: '2026-09-01'
  }) as any
  ok(body.CustomerRef?.value === '58', 'it names the customer, which QuickBooks requires')
  ok(body.TotalAmt === 28_000 && body.TxnDate === '2026-09-01', 'the amount and the date are set')
  const line = body.Line?.[0]
  ok(
    line?.LinkedTxn?.[0]?.TxnId === '2389' && line.LinkedTxn[0].TxnType === 'Invoice',
    'AND IT IS LINKED TO THE INVOICE — without this QuickBooks takes the money and leaves it ' +
      'floating as an unapplied credit, which looks like it worked and settles nothing'
  )
  ok(
    line?.Amount === body.TotalAmt,
    'the line and the total agree — parts that do not sum leave the difference applied nowhere',
    `${line?.Amount} vs ${body.TotalAmt}`
  )
  ok(
    body.DepositToAccountRef === undefined && body.PaymentMethodRef === undefined,
    'and no account is guessed at — unnamed, QuickBooks uses Undeposited Funds, which is where ' +
      'money whose banking nobody described belongs'
  )

  const long = paymentPayload({
    customerId: '58',
    qboInvoiceId: '2389',
    amount: 10,
    txnDate: '2026-09-01',
    reference: 'wire from the buyer on the first of September, second attempt'
  }) as any
  ok(
    typeof long.PaymentRefNum === 'string' && long.PaymentRefNum.length <= 21,
    'a long reference is cut to what QuickBooks accepts rather than failing the whole payment',
    long.PaymentRefNum
  )
  ok(
    (paymentPayload({ customerId: '58', qboInvoiceId: '1', amount: 1, txnDate: '2026-09-01', reference: '  ' }) as any)
      .PaymentRefNum === undefined,
    'and a blank one is left off entirely'
  )
  ok(
    (paymentPayload({ customerId: '58', qboInvoiceId: '1', amount: 10.005, txnDate: '2026-09-01' }) as any)
      .TotalAmt === 10.01,
    'the amount is rounded to cents — a fraction of a cent is a payment QuickBooks refuses'
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
