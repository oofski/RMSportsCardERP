/**
 * What a show costs in supplies.
 *
 * These numbers move real stock, so every one of them is checked against
 * arithmetic somebody could do on paper. The worked example is the real July
 * show — 13 MLB breaks, 122 packages, 29 break-less giveaways — so the figures
 * here can be held against an actual night.
 *
 * Run: npm run test:supplies
 */
import {
  computeSupplyPlan,
  MAILERS_PER_CARDED_ORDER,
  MAILERS_PER_GIVEAWAY_ORDER,
  SHIP_SUPPLY_ROLES,
  TEAM_BAG_SPARES,
  TOPLOADER_RATE,
  TOP_SLEEVE_RATE,
  type ShipSupplyPlan,
  type ShipSupplyRole
} from '../src/shared/shippingSupplies'

let pass = 0
let fail = 0
const ok = (c: boolean, name: string, extra = ''): void => {
  if (c) {
    pass++
    console.log('  ok   ' + name)
  } else {
    fail++
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`)
  }
}
const qty = (plan: ShipSupplyPlan, role: ShipSupplyRole): number =>
  plan.lines.find((l) => l.role === role)?.quantity ?? -1

const mlbBreaks = (n: number): { label: string; slateSize: number }[] =>
  Array.from({ length: n }, (_, i) => ({ label: String(i + 3), slateSize: 30 }))

// ---------------------------------------------------------------------------
// 1. The stated example: ten MLB breaks is three hundred packs
// ---------------------------------------------------------------------------
console.log('\n=== 1. the base unit ===')
const ten = computeSupplyPlan({ breaks: mlbBreaks(10), orders: [] })
ok(ten.packs === 300, 'ten MLB breaks = 300 packs', String(ten.packs))
ok(qty(ten, 'break_label_2x1') === 300, 'one 2×1 break label per pack', String(qty(ten, 'break_label_2x1')))
ok(qty(ten, 'top_sleeve') === 285, '95% get a top sleeve = 285', String(qty(ten, 'top_sleeve')))
ok(qty(ten, 'toploader') === 150, '50% get top-loaded = 150', String(qty(ten, 'toploader')))
ok(qty(ten, 'team_bag') === 305, 'team bags are packs + 5 spare', String(qty(ten, 'team_bag')))

// The slate, not what sold. This is the whole point of the base unit.
console.log('\n=== 2. the slate, not the sales ===')
const soldOut = computeSupplyPlan({
  breaks: [{ label: '4', slateSize: 30 }],
  orders: Array.from({ length: 30 }, () => ({ cardCount: 1, giveawayCount: 0 }))
})
const halfSold = computeSupplyPlan({
  breaks: [{ label: '4', slateSize: 30 }],
  orders: Array.from({ length: 12 }, () => ({ cardCount: 1, giveawayCount: 0 }))
})
ok(
  soldOut.packs === halfSold.packs && halfSold.packs === 30,
  'a break that sold 12 of 30 still costs 30 packs',
  `${soldOut.packs} vs ${halfSold.packs}`
)
ok(
  qty(soldOut, 'team_bag') === qty(halfSold, 'team_bag'),
  'so the bagging supplies do not move with sales'
)
// ...but the per-ORDER supplies absolutely do.
ok(
  qty(soldOut, 'shipping_label_4x6') === 30 && qty(halfSold, 'shipping_label_4x6') === 12,
  'while 4×6 labels follow the packages',
  `${qty(soldOut, 'shipping_label_4x6')} vs ${qty(halfSold, 'shipping_label_4x6')}`
)

// Giveaways never add a pack — the card was already pulled from a counted break.
const withGiveaways = computeSupplyPlan({
  breaks: [{ label: '4', slateSize: 30 }],
  orders: [
    { cardCount: 2, giveawayCount: 1 },
    { cardCount: 1, giveawayCount: 1 }
  ]
})
ok(withGiveaways.packs === 30, 'giveaways do not add packs', String(withGiveaways.packs))

// ---------------------------------------------------------------------------
// 3. Rounding is UP, because half a top sleeve does not exist
// ---------------------------------------------------------------------------
console.log('\n=== 3. rounding ===')
const thirteen = computeSupplyPlan({ breaks: mlbBreaks(13), orders: [] })
ok(thirteen.packs === 390, '13 MLB breaks = 390 packs', String(thirteen.packs))
// 390 × 0.95 = 370.5 exactly — the case that made rounding a decision.
ok(qty(thirteen, 'top_sleeve') === 371, '370.5 sleeves rounds UP to 371', String(qty(thirteen, 'top_sleeve')))
ok(qty(thirteen, 'toploader') === 195, '195 toploaders needs no rounding', String(qty(thirteen, 'toploader')))
// A rate that lands exactly on a whole number must NOT be bumped by the ceiling.
const twenty = computeSupplyPlan({ breaks: mlbBreaks(2), orders: [] })
ok(twenty.packs === 60 && qty(twenty, 'top_sleeve') === 57, 'an exact 57 stays 57, not 58',
  String(qty(twenty, 'top_sleeve')))
ok(qty(twenty, 'toploader') === 30, 'and an exact 30 stays 30', String(qty(twenty, 'toploader')))

// ---------------------------------------------------------------------------
// 4. Bubble mailers: two for cards, one for giveaways only
// ---------------------------------------------------------------------------
console.log('\n=== 4. mailers ===')
const mailers = computeSupplyPlan({
  breaks: [],
  orders: [
    { cardCount: 5, giveawayCount: 0 }, // bought cards
    { cardCount: 5, giveawayCount: 2 }, // mixed — still a carded order
    { cardCount: 3, giveawayCount: 3 }, // giveaway only
    { cardCount: 1, giveawayCount: 1 } // giveaway only
  ]
})
ok(mailers.cardedOrders === 2, 'a mixed package counts as carded', String(mailers.cardedOrders))
ok(mailers.giveawayOnlyOrders === 2, 'all-giveaway packages are their own kind', String(mailers.giveawayOnlyOrders))
ok(
  qty(mailers, 'bubble_mailer') === 2 * MAILERS_PER_CARDED_ORDER + 2 * MAILERS_PER_GIVEAWAY_ORDER,
  '2 mailers per carded order, 1 per giveaway-only = 6',
  String(qty(mailers, 'bubble_mailer'))
)
ok(qty(mailers, 'shipping_label_4x6') === 4, 'every package takes one 4×6 label')

// A package with nothing in it still ships, and is reported as its own case
// rather than folded silently into one of the others.
const empty = computeSupplyPlan({ breaks: [], orders: [{ cardCount: 0, giveawayCount: 0 }] })
ok(empty.emptyOrders === 1, 'an empty package is counted separately', String(empty.emptyOrders))
ok(empty.cardedOrders === 0 && empty.giveawayOnlyOrders === 0, 'and not as either other kind')
ok(qty(empty, 'bubble_mailer') === 1, 'it takes the single-mailer kind', String(qty(empty, 'bubble_mailer')))
ok(qty(empty, 'shipping_label_4x6') === 1, 'and still takes a label')

// ---------------------------------------------------------------------------
// 5. The real July show, end to end
// ---------------------------------------------------------------------------
console.log('\n=== 5. the July show ===')
// 13 breaks, 122 packages. 29 of the cards were break-less giveaways; for this
// check they sit in 20 packages that hold nothing else.
const july = computeSupplyPlan({
  breaks: mlbBreaks(13),
  orders: [
    ...Array.from({ length: 102 }, () => ({ cardCount: 3, giveawayCount: 0 })),
    ...Array.from({ length: 20 }, () => ({ cardCount: 1, giveawayCount: 1 }))
  ]
})
ok(july.packs === 390, '390 packs', String(july.packs))
ok(july.orderCount === 122, '122 packages', String(july.orderCount))
ok(qty(july, 'break_label_2x1') === 390, '390 break labels')
ok(qty(july, 'top_sleeve') === 371, '371 top sleeves')
ok(qty(july, 'toploader') === 195, '195 toploaders')
ok(qty(july, 'team_bag') === 395, '395 team bags')
ok(qty(july, 'shipping_label_4x6') === 122, '122 shipping labels')
ok(qty(july, 'bubble_mailer') === 224, '224 bubble mailers (102×2 + 20×1)', String(qty(july, 'bubble_mailer')))

// ---------------------------------------------------------------------------
// 6. Degenerate input never produces a nonsense order
// ---------------------------------------------------------------------------
console.log('\n=== 6. nothing in, nothing out ===')
const none = computeSupplyPlan({ breaks: [], orders: [] })
ok(none.packs === 0, 'no breaks, no packs')
ok(
  none.lines.every((l) => l.quantity === 0),
  'and every line is zero — including team bags, which must NOT be 5 spares of nothing',
  JSON.stringify(none.lines.map((l) => [l.role, l.quantity]))
)
ok(none.lines.length === SHIP_SUPPLY_ROLES.length, 'every role is still reported', String(none.lines.length))

const negative = computeSupplyPlan({
  breaks: [{ label: 'x', slateSize: -30 }],
  orders: [{ cardCount: -4, giveawayCount: -9 }]
})
ok(negative.packs === 0, 'a negative slate cannot make negative packs', String(negative.packs))
ok(
  negative.lines.every((l) => l.quantity >= 0),
  'and no line can go negative',
  JSON.stringify(negative.lines.map((l) => l.quantity))
)
// More giveaways than cards is nonsense input; it must not double-count.
const overGiveaway = computeSupplyPlan({ breaks: [], orders: [{ cardCount: 2, giveawayCount: 9 }] })
ok(
  overGiveaway.giveawayOnlyOrders === 1 && overGiveaway.cardedOrders === 0,
  'more giveaways than cards reads as giveaway-only, not as both'
)

// ---------------------------------------------------------------------------
// 7. Mixed leagues: each break costs its OWN slate
// ---------------------------------------------------------------------------
console.log('\n=== 7. mixed leagues ===')
const mixed = computeSupplyPlan({
  breaks: [
    { label: '1', slateSize: 30 }, // MLB
    { label: '2', slateSize: 32 } // NFL
  ],
  orders: []
})
ok(mixed.packs === 62, 'an MLB break and an NFL break are 62 packs, not 60 or 64', String(mixed.packs))
ok(qty(mixed, 'team_bag') === 67, 'and the spares are per show, not per break', String(qty(mixed, 'team_bag')))

// ---------------------------------------------------------------------------
// 8. The rates are the stated ones
// ---------------------------------------------------------------------------
console.log('\n=== 8. the constants ===')
ok(TOP_SLEEVE_RATE === 0.95, 'top sleeves are 95%')
ok(TOPLOADER_RATE === 0.5, 'toploaders are 50%')
ok(TEAM_BAG_SPARES === 5, 'five spare team bags')
ok(MAILERS_PER_CARDED_ORDER === 2 && MAILERS_PER_GIVEAWAY_ORDER === 1, 'mailers are 2 and 1')

// Every line explains itself — these numbers move stock, so somebody has to be
// able to check them without reading the source.
ok(
  july.lines.every((l) => l.basis.trim().length > 0),
  'every line states the arithmetic that produced it'
)

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
