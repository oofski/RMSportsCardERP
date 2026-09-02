/**
 * WHICH HOP IS BROKEN — the question three "fixes" in a row could not answer.
 *
 * A QuickBooks call crosses three boundaries and every failure anywhere along
 * it arrived as one word: aborted. That word is this app giving up waiting; it
 * says nothing about what it was waiting for. So the next move was a guess, and
 * several guesses in a row is what this exists to stop.
 *
 * Run: npm run test:relay-diagnosis
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { describeRelayDiagnosis, firstFailedHop, HOP_SLOW_MS } = require('../src/shared/relayDiagnosis')

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

const hop = (key: string, ok_: boolean, ms: number, over = {}): Record<string, unknown> => ({
  key,
  label:
    key === 'relay'
      ? 'the relay'
      : key === 'quickbooks-tables'
        ? "the relay's QuickBooks side"
        : 'the call out to Intuit',
  ok: ok_,
  ms,
  timedOut: false,
  error: null,
  ...over
})

const chain = (a: boolean, b: boolean, c: boolean, ms = [50, 60, 70]) => [
  hop('relay', a, ms[0], a ? {} : { timedOut: true }),
  hop('quickbooks-tables', b, ms[1], b ? {} : { timedOut: true }),
  hop('intuit', c, ms[2], c ? {} : { timedOut: true })
]

// ---------------------------------------------------------------------------
console.log('\n=== 1. THE FIRST FAILURE IS THE FINDING, the rest are consequences ===')
// ---------------------------------------------------------------------------
{
  ok(firstFailedHop(chain(true, true, true)) === null, 'a healthy chain names no culprit')
  ok(firstFailedHop(chain(false, false, false)) === 'relay', 'all three down blames the relay')
  ok(
    firstFailedHop(chain(true, false, false)) === 'quickbooks-tables',
    'AND NOT INTUIT, when the QuickBooks side failed first — reporting both as equal problems ' +
      'is how somebody re-pastes a Worker because Intuit was slow'
  )
  ok(firstFailedHop(chain(true, true, false)) === 'intuit', 'and Intuit when only Intuit failed')
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. each verdict sends somebody to the right place ===')
// ---------------------------------------------------------------------------
{
  const dead = describeRelayDiagnosis(chain(false, false, false), null)
  ok(/RELAY ITSELF DID NOT ANSWER/.test(dead), 'a dead relay says so first', dead.slice(0, 60))
  ok(/cloud sync will be failing too/i.test(dead), 'and points out sync must be broken as well')

  const stale = describeRelayDiagnosis(chain(true, false, false), null)
  ok(
    /older copy of cloud\/worker\.js|missing a secret/i.test(stale),
    'a relay that answers but has no QuickBooks side is an old Worker or a missing secret',
    stale.slice(0, 80)
  )
  ok(!/Intuit/i.test(stale.split('.')[0]), 'and Intuit is not blamed for it')

  const intuit = describeRelayDiagnosis(chain(true, true, false), null)
  ok(
    /THE STEP THAT FAILED IS THE WORKER CALLING INTUIT/.test(intuit),
    'and when only the last hop fails, THAT is named — the one case re-pasting cannot fix'
  )
  ok(
    /no deadline of its own/.test(intuit),
    'saying why nothing comes back at all: the Worker calls Intuit with no timeout'
  )
  ok(
    /Cloudflare/.test(intuit),
    'and where the remaining answer is'
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. SLOW IS A FINDING TOO, and "ok" hides it ===')
// ---------------------------------------------------------------------------
{
  // Everything passed, but one step took 25 seconds. Under load that is the
  // call that gets abandoned, and a green tick beside it says nothing.
  const slow = describeRelayDiagnosis(chain(true, true, true, [40, 60, 25_000]), null)
  ok(
    /nothing is broken right now/.test(slow) && /25\.0s/.test(slow),
    'a passing but slow chain is reported as passing AND slow, with the number',
    slow.slice(0, 100)
  )
  ok(
    /fail under load/.test(slow),
    'and says why a green tick is not the end of it'
  )
  ok(
    HOP_SLOW_MS > 1000 && HOP_SLOW_MS < 30_000,
    'the slow line is drawn somewhere a human would draw it',
    String(HOP_SLOW_MS)
  )

  const fine = describeRelayDiagnosis(chain(true, true, true, [40, 60, 70]), null)
  ok(!/fail under load/.test(fine), 'a genuinely fast chain is not accused of being slow')
  ok(
    /intermittent/.test(fine),
    'AND A HEALTHY RESULT SAYS THE FAULT MAY BE INTERMITTENT rather than "all fine" — the ' +
      'diagnosis runs after the failure, not during it, and that is the trap'
  )
}

// ---------------------------------------------------------------------------
console.log("\n=== 4. the relay's own record is carried through ===")
// ---------------------------------------------------------------------------
{
  // A call that failed INSIDE the Worker leaves a note there even when nothing
  // useful came back down the wire. It is a second witness, and a different one.
  const said = describeRelayDiagnosis(chain(true, true, false), 'QuickBooks: AuthenticationFailed')
  ok(
    /AuthenticationFailed/.test(said),
    "the relay's own last error is quoted — a second witness to what this machine saw",
    said.slice(-90)
  )
  const healthy = describeRelayDiagnosis(chain(true, true, true), 'QuickBooks: AuthenticationFailed')
  ok(
    /AuthenticationFailed/.test(healthy),
    'AND IT IS SHOWN EVEN WHEN EVERY HOP PASSES — the chain being healthy now does not mean ' +
      'the last real failure is not still the answer'
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
