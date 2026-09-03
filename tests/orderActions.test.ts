/**
 * ONE BUTTON PER QUESTION, AND IT SAYS WHERE THE ORDER STANDS.
 *
 * The owner, looking at a sales-order card carrying nine buttons: "have a
 * quickbooks button just one that tells me the status and moves it into
 * quickbooks if needed, mark it as paid, like dont need 2 buttons there because
 * if something is set as marked as paid in the begingin marking it paid would
 * mark it paid according to the terms".
 *
 * Five of the nine were about QuickBooks and two were about money. They were not
 * five and two because anybody decided that; each was gated on a different field
 * in a different month, and gates written separately overlap. "Mark paid" and
 * "Paid up front…" sat side by side both claiming the same word — the SECOND
 * time that has happened on this card.
 *
 * ## What this suite is actually protecting
 *
 * Section 2 is the whole reason the decision moved out of the renderer. It walks
 * a large cross-product of the QuickBooks fields and asserts that EVERY state
 * yields exactly one action with a non-empty face and a tooltip that opens with
 * the status. Not "the states I thought of" — the product, so a field
 * combination nobody imagined still gets a button that says something, and no
 * combination can produce two.
 *
 * Section 3 pins the two orderings that a careless edit would swap and that both
 * cost real money in a real company's books.
 *
 * Every name and number here is invented.
 *
 * Run: npm run test:order-actions
 */
import {
  paidAction,
  quickBooksAction,
  type OrderPaymentTiming,
  type PaidActionFacts,
  type QboActionFacts
} from '../src/shared/orderActions'
import type { InvoicePushState, InvoiceStatus } from '../src/shared/invoices'

let pass = 0
let fail = 0
const ok = (c: boolean, n: string, e = ''): void => {
  if (c) {
    pass++
    console.log('  ok   ' + n)
  } else {
    fail++
    console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`)
  }
}

/** The formatters the card lends the helper. Fixed, so assertions can match. */
const FMT = {
  money: (n: number): string => `$${n.toFixed(2)}`,
  day: (iso: string): string => iso.slice(0, 10)
}

const qb = (over: Partial<QboActionFacts> = {}): QboActionFacts => ({
  status: 'created',
  qboId: 'QB-1',
  qboDocNumber: '1043',
  qboPushState: 'ok',
  qboPushError: null,
  qboVoided: false,
  qboBalance: 0,
  qboTotalAmt: 500,
  qboPaidAt: null,
  qboPaymentId: null,
  qboPaymentPostedAt: null,
  qboStatusCheckedAt: '2026-09-01T00:00:00.000Z',
  qboStatusAttemptedAt: '2026-09-01T00:00:00.000Z',
  qboStatusError: null,
  totalChangedAt: null,
  total: 500,
  paidAt: null,
  ...over
})

const pf = (over: Partial<PaidActionFacts> = {}): PaidActionFacts => ({
  status: 'sent',
  paidAt: null,
  qboPaidAt: null,
  qboVoided: false,
  paymentTiming: null,
  total: 500,
  ...over
})

// ---------------------------------------------------------------------------
console.log('\n=== 1. the QuickBooks button names the act and states the status ===')
// ---------------------------------------------------------------------------
{
  const draft = quickBooksAction(qb({ status: 'draft', qboId: null, qboDocNumber: null }), FMT)
  ok(draft.id === 'push', 'a draft that is not over there offers to send it', draft.id)
  ok(draft.label === 'Send to QuickBooks', 'and says so on its face', draft.label)
  ok(/not in quickbooks yet/i.test(draft.title), 'and the tooltip opens with the status', draft.title)

  const owing = quickBooksAction(qb({ qboBalance: 6900 }), FMT)
  ok(owing.id === 'open', 'a posted, read, agreeing order rests on Open', owing.id)
  ok(
    owing.title.includes('invoice 1043') && owing.title.includes('$6900.00 owing'),
    'THE STATUS IS THE FIRST THING THE TOOLTIP SAYS — the number and what is outstanding',
    owing.title
  )

  const failed = quickBooksAction(
    qb({ qboId: null, qboPushState: 'failed', qboPushError: 'Item not found.' }),
    FMT
  )
  ok(failed.id === 'retry' && failed.warn, 'a refused push offers a retry, in the warn tone')
  ok(failed.title.includes('Item not found.'), 'quoting what QuickBooks said', failed.title)

  const gap = quickBooksAction(qb({ total: 620, qboTotalAmt: 500 }), FMT)
  ok(gap.id === 'check', 'a totals disagreement asks for a re-read', gap.id)
  ok(gap.title.includes('$120.00 lower'), 'and names the gap and which way', gap.title)

  const stale = quickBooksAction(
    qb({ totalChangedAt: '2026-09-02T00:00:00.000Z' }),
    FMT
  )
  ok(stale.id === 'check', 'so does an order edited since the last read', stale.id)
  ok(/not read since you edited/i.test(stale.title), 'and says why', stale.title)

  const record = quickBooksAction(
    qb({ status: 'paid', qboBalance: 6900, paidAt: '2026-09-01T00:00:00.000Z' }),
    FMT
  )
  ok(record.id === 'record-payment', 'paid here and owing there offers to bank it', record.id)
  ok(record.confirm, 'AND ASKS FIRST — it moves money in somebody else’s books')
  ok(/marked paid here/i.test(record.title), 'and says so, because somebody did', record.title)

  // THE STAGE AND THE TICK COME APART, and the wording has to follow the tick.
  // Dragging a card into Payment without ticking anything leaves the stage
  // saying paid and `paidAt` null — found by running the board, not by reading
  // the code, on a card whose money chip read Unpaid beside a button claiming
  // it had been marked paid.
  const columnOnly = quickBooksAction(qb({ status: 'paid', qboBalance: 6900, paidAt: null }), FMT)
  ok(columnOnly.id === 'record-payment', 'the OFFER still follows the stage, which is what the backend gates on')
  ok(
    !/marked paid here/i.test(columnOnly.title) && /settling up here/i.test(columnOnly.title),
    'but it does not claim somebody ticked a box nobody ticked',
    columnOnly.title
  )

  // A BALANCE NOBODY REPORTED IS NOT A BALANCE OF ZERO.
  //
  // `toObservation` writes null, never 0, when Intuit omits the Balance field —
  // "QuickBooks says nothing is owed" and "QuickBooks did not tell us" are
  // different facts. The first draft of the ladder read it as `?? 0`, which made
  // this state fall through to Open with the sentence "nothing owing", AND
  // withdrew the only control in the app that posts the payment, because the
  // record-payment rung requires owing > 0. Found by an adversarial review, not
  // by the cross-product below, which had no assertion about what the sentence
  // may CLAIM.
  const unknownBalance = quickBooksAction(
    qb({ status: 'paid', qboBalance: null, paidAt: '2026-09-01T00:00:00.000Z' }),
    FMT
  )
  ok(
    unknownBalance.id === 'check',
    'an unreported balance asks for a re-read — the same answer paymentPlan gives it',
    unknownBalance.id
  )
  ok(
    !/nothing owing/i.test(unknownBalance.title) && /did not say what is outstanding/i.test(unknownBalance.title),
    'and never claims nothing is owing on a figure nobody has',
    unknownBalance.title
  )

  const voided = quickBooksAction(qb({ qboVoided: true }), FMT)
  ok(voided.id === 'open' && voided.label === 'Voided in QuickBooks', 'a void says so', voided.label)
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. EVERY state yields exactly one action, with words on it ===')
// ---------------------------------------------------------------------------
// The point of the helper is that two buttons can no longer claim one job. That
// is only true if every reachable combination returns something — a state that
// fell through to nothing would put a blank button on the card, which is the
// same defect wearing different clothes.
{
  const STATUSES: InvoiceStatus[] = ['draft', 'created', 'sent', 'paid', 'void']
  const PUSH: InvoicePushState[] = ['none', 'pending', 'ok', 'failed']
  let n = 0
  const bad: string[] = []
  const seenIds = new Set<string>()

  for (const status of STATUSES) {
    for (const qboId of [null, 'QB-1']) {
      for (const qboPushState of PUSH) {
        for (const qboVoided of [false, true]) {
          for (const qboBalance of [null, 0, 250]) {
            for (const qboPaidAt of [null, '2026-08-30T00:00:00.000Z']) {
              for (const qboPaymentId of [null, 'PAY-9']) {
                for (const checked of [null, '2026-09-01T00:00:00.000Z']) {
                  for (const changed of [null, '2026-09-02T00:00:00.000Z']) {
                    for (const total of [500, 620]) {
                      for (const paidAt of [null, '2026-09-01T00:00:00.000Z']) {
                      n++
                      const a = quickBooksAction(
                        qb({
                          status,
                          qboId,
                          qboPushState,
                          qboVoided,
                          qboBalance,
                          qboPaidAt,
                          qboPaymentId,
                          qboStatusCheckedAt: checked,
                          totalChangedAt: changed,
                          total,
                          paidAt
                        }),
                        FMT
                      )
                      seenIds.add(a.id)
                      if (!a.label.trim()) bad.push(`${status}/${qboId}/${qboPushState}: blank label`)
                      if (a.title.trim().length < 20) {
                        bad.push(`${status}/${qboId}/${qboPushState}: title says nothing`)
                      }
                      // A confirm is only ever attached to a press that can
                      // duplicate a document or a payment. Anywhere else it is
                      // friction that teaches people to click through dialogs.
                      if (a.confirm && a.id !== 'push-again' && a.id !== 'record-payment') {
                        bad.push(`${a.id}: confirms for no reason`)
                      }
                      if (a.id === 'none' && !a.title.includes('never posted')) {
                        bad.push('the dead end does not explain itself')
                      }
                      // Never claim a tick nobody made. See the wording note above.
                      if (/marked paid here/i.test(a.title) && !paidAt) {
                        bad.push('claimed "marked paid here" with no paidAt')
                      }
                      // Never claim a balance nobody reported. The assertion the
                      // first draft was missing, which is why the `?? 0` slipped
                      // through a 15,360-state walk.
                      if (/nothing owing/i.test(a.title) && qboBalance === null) {
                        bad.push('claimed "nothing owing" on an unreported balance')
                      }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  ok(n === 5 * 2 * 4 * 2 * 3 * 2 * 2 * 2 * 2 * 2 * 2, `walked the whole product — ${n} states`, String(n))
  ok(bad.length === 0, 'every one of them produced one usable button', bad.slice(0, 3).join(' | '))
  // Not a coverage metric for its own sake: an id nobody can reach is a branch
  // that will rot, and 'none' in particular is the one somebody would be tempted
  // to delete as unreachable.
  ok(
    seenIds.size === 7,
    'and all seven acts are reachable from real field combinations',
    [...seenIds].sort().join(',')
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. the two orderings that cost money if swapped ===')
// ---------------------------------------------------------------------------
{
  // NEVER PAY AGAINST A FIGURE WE KNOW DISAGREES. Fix it over there first — the
  // gap banner has always asked for that sequence, and paying first banks a
  // number somebody is about to change.
  const gapAndOwing = quickBooksAction(
    qb({ status: 'paid', total: 620, qboTotalAmt: 500, qboBalance: 500 }),
    FMT
  )
  ok(
    gapAndOwing.id === 'check',
    'a totals gap is answered BEFORE the offer to pay, not after',
    gapAndOwing.id
  )

  // THE DOUBLE-POST INTERLOCK BEATS THE BALANCE. The balance on the card right
  // after our own post is a reading taken before that payment landed; treating
  // it as authority is exactly how an invoice gets paid twice.
  const alreadyPosted = quickBooksAction(
    qb({
      status: 'paid',
      qboBalance: 6900,
      qboPaymentId: 'PAY-9',
      qboPaymentPostedAt: '2026-09-02T10:00:00.000Z'
    }),
    FMT
  )
  ok(
    alreadyPosted.id === 'check',
    'a payment we already posted is never offered a second time, however stale the balance looks',
    alreadyPosted.id
  )
  ok(
    alreadyPosted.title.includes('2026-09-02'),
    'and the tooltip says when we posted it, so the stale balance is explained',
    alreadyPosted.title
  )

  // THE PUSH IS GATED ON DRAFT. markPosted writes status='created'
  // unconditionally, so offering it on an order already at Ready to ship would
  // drag its card two columns backwards as a side effect of posting.
  const settledInCash = quickBooksAction(qb({ status: 'paid', qboId: null, qboPushState: 'none' }), FMT)
  ok(
    settledInCash.id === 'none',
    'an order settled without QuickBooks is NOT offered a push that would drag it backwards',
    settledInCash.id
  )
  ok(
    settledInCash.label === 'Not in QuickBooks',
    'it says where it stands instead of vanishing',
    settledInCash.label
  )

  // An interrupted push is the one press that can put a second five-figure
  // invoice in real books. It is not the same act as a first push.
  const interrupted = quickBooksAction(
    qb({ status: 'draft', qboId: null, qboPushState: 'pending' }),
    FMT
  )
  ok(interrupted.id === 'push-again', 'an interrupted push is its own act', interrupted.id)
  ok(interrupted.confirm && interrupted.warn, 'warned and confirmed')
  ok(
    /may already be in quickbooks/i.test(interrupted.title),
    'and says the thing that makes it dangerous',
    interrupted.title
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. a failed read is appended, never substituted ===')
// ---------------------------------------------------------------------------
{
  const failedRead = quickBooksAction(
    qb({
      qboBalance: 300,
      qboStatusError: 'Token expired.',
      qboStatusCheckedAt: '2026-09-01T00:00:00.000Z',
      qboStatusAttemptedAt: '2026-09-02T00:00:00.000Z'
    }),
    FMT
  )
  ok(
    failedRead.title.includes('$300.00 owing') && failedRead.title.includes('Token expired.'),
    'THE LAST GOOD READING SURVIVES — a read that failed made the balance old, not unknown',
    failedRead.title
  )

  const oldError = quickBooksAction(
    qb({
      qboBalance: 300,
      qboStatusError: 'Token expired.',
      qboStatusCheckedAt: '2026-09-03T00:00:00.000Z',
      qboStatusAttemptedAt: '2026-09-02T00:00:00.000Z'
    }),
    FMT
  )
  ok(
    !oldError.title.includes('Token expired.'),
    'and an error from before a later successful read is history, not news',
    oldError.title
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. one money button, following the order’s own terms ===')
// ---------------------------------------------------------------------------
{
  const front = paidAction(pf({ paymentTiming: 'front' }))
  ok(front.id === 'record' && front.label === 'Mark paid…', 'an unpaid order offers to record it')
  ok(
    /releases it to the packing list/i.test(front.title),
    'and an up-front order is told this press is what releases it',
    front.title
  )
  ok(front.upFront, 'the money counts as having arrived up front')

  const delivery = paidAction(pf({ paymentTiming: 'delivery' }))
  ok(delivery.id === 'record', 'so does an on-delivery order — same button')
  ok(
    delivery.upFront === false,
    'BUT IT IS NOT PAID UP FRONT. The flag used to be written unconditionally, so recording an on-delivery payment stated something nobody claimed'
  )
  ok(
    delivery.detail !== front.detail,
    'and the dialog says something different under its title',
    delivery.detail
  )

  const unsaid = paidAction(pf({ paymentTiming: null }))
  ok(unsaid.id === 'record', 'terms not set still gets the button')
  ok(unsaid.upFront, 'and keeps the old behaviour — only "on delivery" is the case that is plainly not up front')

  const paidHere = paidAction(pf({ paidAt: '2026-09-01T00:00:00.000Z' }))
  ok(paidHere.id === 'withdraw' && paidHere.label === 'Mark not paid', 'an order paid here can be taken back')
  ok(
    /nothing is refunded/i.test(paidHere.title),
    'and the button says what withdrawing does NOT do',
    paidHere.title
  )

  const paidThere = paidAction(pf({ qboPaidAt: '2026-09-01T00:00:00.000Z' }))
  ok(
    paidThere.id === 'none',
    'QUICKBOOKS OWNS THE FACT WHERE IT SPEAKS — a payment applied over there is not this app’s to withdraw',
    paidThere.id
  )
  const voided = paidAction(pf({ status: 'void' }))
  ok(voided.id === 'none', 'and a void neither owes nor is owed')

  // The reach is the other half of the merge, and it only ever widens: before,
  // recording was Payment-column-only on one button and any-column on the other,
  // so which one somebody got depended on where the card was standing.
  const everywhere = (['draft', 'created', 'sent', 'paid'] as InvoiceStatus[]).every(
    (status) => paidAction(pf({ status })).id === 'record'
  )
  ok(everywhere, 'an unpaid order can be recorded from ANY column, not just Payment')
  const withdrawEverywhere = (['created', 'sent', 'paid'] as InvoiceStatus[]).every(
    (status) => paidAction(pf({ status, paidAt: '2026-09-01T00:00:00.000Z' })).id === 'withdraw'
  )
  ok(withdrawEverywhere, 'and one paid in error can be withdrawn from any column too')
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. the money button covers its own whole product ===')
// ---------------------------------------------------------------------------
{
  const TIMINGS: OrderPaymentTiming[] = ['front', 'delivery', null]
  const bad: string[] = []
  let n = 0
  for (const status of ['draft', 'created', 'sent', 'paid', 'void'] as InvoiceStatus[]) {
    for (const paidAt of [null, '2026-09-01T00:00:00.000Z']) {
      for (const qboPaidAt of [null, '2026-09-01T00:00:00.000Z']) {
        for (const qboVoided of [false, true]) {
          for (const paymentTiming of TIMINGS) {
            n++
            const a = paidAction(pf({ status, paidAt, qboPaidAt, qboVoided, paymentTiming }))
            if (a.id === 'none' && a.label !== '') bad.push('a hidden button still carries a face')
            if (a.id !== 'none' && !a.label.trim()) bad.push(`${status}: blank label`)
            // The one that would be a real defect: offering to record money on
            // an order QuickBooks has already been paid for.
            if (a.id === 'record' && qboPaidAt) bad.push('offered to record over a QuickBooks payment')
            // Or offering to withdraw one this app never recorded.
            if (a.id === 'withdraw' && !paidAt) bad.push('offered to withdraw a payment nobody made here')
            if (a.upFront && paymentTiming === 'delivery') bad.push('flagged an on-delivery payment as up front')
          }
        }
      }
    }
  }
  ok(n === 5 * 2 * 2 * 2 * 3, `walked the whole product — ${n} states`, String(n))
  ok(bad.length === 0, 'and none of them offers a press that would be wrong', bad.slice(0, 3).join(' | '))
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
