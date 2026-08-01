/**
 * Shipping parser regressions.
 *
 * parsePages is pure — no I/O, no clock, no state — so it can be driven with
 * synthetic slip text. Both cases below were real defects that lost money
 * without saying anything, which is precisely why they are pinned here.
 *
 * Run: npm run test:parser
 */
import { parsePages } from '../src/main/shipping/parser'

let pass = 0, fail = 0
const ok = (c: boolean, label: string, extra = ''): void => {
  if (c) { pass++; console.log('  ok   ' + label) }
  else { fail++; console.log(`  FAIL ${label}${extra ? ' — ' + extra : ''}`) }
}

// --- 1. A paid card must survive an unrelated $0 giveaway of the same team ---
// Buyer wins the Cowboys in break #3 for $50, and separately receives a $0
// Cowboys giveaway with no break number.
const packing = [
  'Whatnot Packing Slip 1/1',
  'To: bigbuyer From: rm_cardz',
  'Buyer Name',
  '12 Main St. Dallas, TX. 75201. US',
  'QTY Name & Description Attributes Subtotal',
  '1 Dallas Cowboys Order 1111111111 $50.00',
  '1x 2025 PRIZM FOOTBALL HOBBY BOX- Break #3',
  '1 Dallas Cowboys Order 2222222222 $0.00',
  'GIVEAWAY',
  '2 Items $50.00',
  'USPS Ground Advantage #9300120762602315706745 7.0 oz'
].join('\n')

const res = parsePages([packing], { sport: 'nfl' })
const cowboys = res.teamSlots.filter((s) => s.teamName === 'Dallas Cowboys')
ok(cowboys.length === 2, 'both Cowboys cards exist', `got ${cowboys.length}`)
const paid = cowboys.filter((s) => s.price === 50 && !s.isGiveaway)
const free = cowboys.filter((s) => s.price === 0 && s.isGiveaway)
ok(paid.length === 1, 'the $50 card is still paid and still pickable',
   `paid=${paid.length} ` + JSON.stringify(cowboys.map(c => ({ p: c.price, g: c.isGiveaway }))))
ok(free.length === 1, 'the giveaway is still a giveaway', `free=${free.length}`)
ok(res.teamSlots.reduce((a, s) => a + s.price, 0) === 50, 'total revenue is $50, not $0')

// --- 2. A lettered break label must not vanish quietly --------------------
const lettered = [
  'Whatnot Packing Slip 1/1',
  'To: someone From: rm_cardz',
  'Person Name',
  '5 Oak Ave. Reno, NV. 89501. US',
  'QTY Name & Description Attributes Subtotal',
  '1 Boston Red Sox Order 3333333333 $20.00',
  '1x 2026 FINEST BASEBALL HOBBY BOX (NEW RELEASE!)- Break #11A',
  '1 Item $20.00',
  'USPS Ground Advantage #9300120762602315706746 3.0 oz'
].join('\n')
const res2 = parsePages([lettered], { sport: 'mlb' })
const warned = res2.warnings.filter((w) => /11A/.test(w.message))
ok(warned.length >= 1, 'a lettered break label raises a warning',
   JSON.stringify(res2.warnings.map(w => w.message).slice(0, 3)))
ok(res2.teamSlots.length === 1 && res2.teamSlots[0].breakNumber === 11,
   'the card still lands in break 11 rather than being dropped')

// --- 3. control: an ordinary break is untouched ---------------------------
const plain = lettered.replace('Break #11A', 'Break #12')
const res3 = parsePages([plain], { sport: 'mlb' })
ok(res3.warnings.filter((w) => /is dropped/.test(w.message)).length === 0,
   'a normal label raises no suffix warning')
ok(res3.teamSlots[0]?.breakNumber === 12, 'and parses as break 12')

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
