/**
 * Drilling into the P&L: what every statement line is made of.
 *
 * The statement in `buildPnl` is a column of figures. This is the other half of
 * being able to trust it — click a figure and land on the records that add up to
 * it, click one of those and see the record itself. QuickBooks Online has had
 * this for twenty years and it is the reason anybody believes a QBO P&L: a
 * number you cannot open is a number you have to take on faith.
 *
 * ## The mapping below IS the contract
 *
 * `PNL_DRILL_SOURCES` names, for every line id `buildPnl` can emit, where that
 * line's money physically lives. It is deliberately ONE table rather than a
 * switch in main and a second switch in the renderer: a P&L line added upstream
 * with no entry here is a dead click, and a dead click on a money figure teaches
 * an operator that the drill-down is decorative. `tests/pnlPacking.test.ts`
 * enumerates every id `buildPnl` produces and fails on any that resolves to
 * nothing, so the omission surfaces as a red test rather than as a number
 * nobody can open.
 *
 * ## Reconciliation is the whole point
 *
 * Every payload carries `total`, which is the sum of ALL the matching records —
 * not of the page of them that came back. The screen compares it to the figure
 * that was clicked and says so loudly when the two differ, because a detail
 * view that quietly disagrees with the line it came from is worse than no detail
 * view: it makes the statement look wrong when the drill is what is broken, or
 * hides a real skew behind a plausible list.
 *
 * ## Derived is not the same as empty
 *
 * Four of the sources list records. The fifth, `derived`, is for a figure that
 * has no records to list, and today exactly one line is in that position: the
 * cost-of-goods residual, which exists only when main and the renderer were built
 * from different versions and therefore has nothing behind it by construction.
 * The kind is not vestigial — the packaging block used it properly, drilling to
 * the cards, team slates and envelopes a night was priced on, because no row in
 * any table holds "$0.15 of sleeves" — and it is what a reinstated modelled cost
 * would land on again.
 */
import type { GeneralExpense, LedgerBucket, LedgerRow } from './financeStreaming'
import type { StockUnit } from './units'

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/**
 * One line, over the range the tab is currently reporting on.
 *
 * `start`/`end` are inclusive business-day keys, and BOTH NULL MEANS ALL TIME —
 * the same null the range control uses, carried through rather than translated
 * into a pair of sentinel dates that a reader would have to recognise.
 */
export interface PnlDrillRequest {
  lineId: string
  start: string | null
  end: string | null
}

// ---------------------------------------------------------------------------
// Where a line's money lives
// ---------------------------------------------------------------------------

/**
 * How a ledger row contributes to the line that named it.
 *
 * NOT ALWAYS THE ROW'S OWN AMOUNT, and this is the subtlety the whole feature
 * turns on. Whatnot pays NET: the amount stored on a sale row is what landed in
 * the bank, while the statement's top line is the DERIVED gross — that net with
 * the commission and the card charge added back. Listing the stored amounts
 * under the sales figure would produce a list that is short by exactly the fees,
 * every time, on a screen whose entire job is to reconcile. So the basis says
 * which figure to take off each row, and the fee lines take the other two halves
 * of the same derivation.
 */
export type PnlLedgerBasis =
  /** The stored ledger amount, signed as it sits in the table. */
  | 'amount'
  /** The derived gross — net plus both fees. Sales and marketplace. */
  | 'grossSales'
  /** Negative. Whatnot's commission on this row. */
  | 'whatnotFee'
  /** Negative. Card processing plus the flat per-order charge on this row. */
  | 'processingFee'

/** Which stream lines a cost-of-goods row is made of. */
export interface PnlStreamItemSelector {
  act: 'break' | 'giveaway'
  /**
   * Costed and uncosted lines for one product are two statement rows, never
   * one — see `mergeCogsItems`. A drill that ignored the split would answer the
   * costed row with the uncosted boxes in it, and the sum would not match.
   * `either` is only for the two fallback totals, which appear on a build that
   * itemises nothing.
   */
  costing: 'costed' | 'uncosted' | 'either'
  /** The product as the stream line named it. Null for the fallback totals. */
  product: string | null
}

/**
 * A modelled figure, named by what it is modelled FROM.
 *
 * A union of one, which is not a mistake and not an invitation to collapse it
 * into a boolean. Six `packaging:*` members sat here until `buildPnl` stopped
 * emitting the packaging section, and the shape is what lets the next modelled
 * cost — that one coming back, or another — be added as a member rather than as
 * a second kind of source.
 */
export type PnlDerivation = 'cogs:residual'

export type PnlDrillSource =
  | { kind: 'ledgerRows'; buckets: readonly LedgerBucket[]; basis: PnlLedgerBasis }
  | { kind: 'streamItems'; select: PnlStreamItemSelector }
  /** The cost-of-goods roll-up tail: every product past the statement's cap. */
  | { kind: 'streamItems'; select: 'rollup' }
  | { kind: 'expenses' }
  | { kind: 'derived'; derivation: PnlDerivation }

/**
 * EVERY FIXED LINE ID `buildPnl` CAN EMIT, AND WHERE IT COMES FROM.
 *
 * Read it beside the `return` at the end of `buildPnl` — the order is the
 * statement's own, top to bottom, so a line added there and forgotten here is
 * visible as a gap in a list rather than as a missing case in a switch.
 *
 * The cost-of-goods product lines are not here because their ids carry a product
 * name; `pnlDrillSource` parses those. Everything else is a literal.
 */
export const PNL_DRILL_SOURCES: Readonly<Record<string, PnlDrillSource>> = {
  // --- Revenue --------------------------------------------------------------
  // The two sales lines are the SAME derivation split by bucket, which is what
  // makes "break spots + marketplace = gross" exact rather than apportioned.
  sales: { kind: 'ledgerRows', buckets: ['sale'], basis: 'grossSales' },
  marketplace: { kind: 'ledgerRows', buckets: ['product_sale'], basis: 'grossSales' },
  tips: { kind: 'ledgerRows', buckets: ['tip'], basis: 'amount' },
  bonuses: { kind: 'ledgerRows', buckets: ['seller_bonus'], basis: 'amount' },
  unclassified: { kind: 'ledgerRows', buckets: ['unclassified'], basis: 'amount' },

  // --- Cost of goods --------------------------------------------------------
  // The two totals a build that itemises nothing prints. `either` because on
  // such a build there is no costed/uncosted split to honour.
  breakCost: { kind: 'streamItems', select: { act: 'break', costing: 'either', product: null } },
  giveawayCost: {
    kind: 'streamItems',
    select: { act: 'giveaway', costing: 'either', product: null }
  },
  cogsRest: { kind: 'streamItems', select: 'rollup' },
  // A residual that exists only when the itemised entries do not sum to the
  // stored cost of goods — i.e. when main and the renderer were built from
  // different versions. There is nothing behind it by construction; see
  // `pnlDetail` for what it says instead of listing nothing.
  cogsUnitemised: { kind: 'derived', derivation: 'cogs:residual' },

  // --- Platform fees --------------------------------------------------------
  // The same rows as the sales lines, read for the other two thirds of the
  // derivation. Both buckets, because a whole-product sale pays both cuts too.
  whatnotFee: {
    kind: 'ledgerRows',
    buckets: ['sale', 'product_sale'],
    basis: 'whatnotFee'
  },
  processingFee: {
    kind: 'ledgerRows',
    buckets: ['sale', 'product_sale'],
    basis: 'processingFee'
  },

  // --- Shipping -------------------------------------------------------------
  // NOTHING, because the statement prints no postage line to click. The four
  // that were here — subsidy, postage charged back, giveaway postage, refund
  // postage — went when `buildPnl` stopped emitting the shipping section, and
  // they went for the reason this list exists: it is meant to be read beside
  // that `return` as the same list in the same order, and a mapping for a line
  // nothing emits is dead weight that makes the enumeration test look satisfied
  // while covering one line fewer. The buckets are untouched and the rows are
  // still there; reinstating the section reinstates these four entries with it.

  // --- Packaging ------------------------------------------------------------
  // NOTHING, AND FOR THE SAME REASON AS THE POSTAGE ABOVE. Sleeves, top loaders,
  // team bags, shipping labels, team bag stickers and mailers were six `derived`
  // entries here — no table holds a sleeve — and they went when `buildPnl`
  // stopped emitting the packaging section. This list is meant to be read beside
  // that `return` as the same list in the same order, and a mapping for a line
  // nothing emits is dead weight that makes the enumeration test look satisfied
  // while covering one line fewer. The model in `packagingCosts.ts` still prices
  // every night; reinstating the section reinstates these six entries and the
  // resolver in main that priced them.

  // --- The rest -------------------------------------------------------------
  showBoost: { kind: 'ledgerRows', buckets: ['show_boost'], basis: 'amount' },
  generalExpenses: { kind: 'expenses' },
  reversals: { kind: 'ledgerRows', buckets: ['sale_reversal'], basis: 'amount' }
}

/**
 * The cost-of-goods line ids, which are the only ones that are not literals.
 *
 * `cogs:<act>:<product>` and `cogs:<act>:uncosted:<product>`, built in
 * `buildPnl`. A product name may itself contain a colon, so the name is
 * whatever is left after the prefix rather than the last segment of a split.
 *
 * The one shape this cannot tell apart is a COSTED product whose name literally
 * begins "uncosted:". That product's line drills to the uncosted lines of a
 * product named after the remainder, finds none, and reports a total of zero
 * against a non-zero figure — which the screen shows as a reconciliation
 * failure. Wrong, loudly, rather than wrong quietly; and the alternative (a
 * separator no name can contain) would change every line key on the statement
 * for a product nobody has ever stocked.
 */
const COGS_ID = /^cogs:(break|giveaway):(uncosted:)?([\s\S]+)$/

/**
 * Where this line's money is, or null when nothing claims it.
 *
 * NULL IS A BUG, not a state the statement is expected to be in. The screen
 * renders such a line as an amount that cannot be opened; the enumeration test
 * is what stops one ever shipping.
 */
export function pnlDrillSource(lineId: string): PnlDrillSource | null {
  const fixed = Object.prototype.hasOwnProperty.call(PNL_DRILL_SOURCES, lineId)
    ? PNL_DRILL_SOURCES[lineId]
    : undefined
  if (fixed) return fixed
  const m = COGS_ID.exec(lineId)
  if (!m) return null
  return {
    kind: 'streamItems',
    select: {
      act: m[1] === 'giveaway' ? 'giveaway' : 'break',
      costing: m[2] ? 'uncosted' : 'costed',
      product: m[3]
    }
  }
}

// ---------------------------------------------------------------------------
// What comes back
// ---------------------------------------------------------------------------

/**
 * One ledger row under a statement line, and what it contributed to it.
 *
 * `amount` is the contribution, `row.amount` is what the ledger stores. They are
 * the same number on every line but the two sales lines and the two fee lines,
 * where the contribution is derived — and `basis` is the sentence that explains
 * the difference on the row itself, so nobody has to know which lines those are.
 */
export interface PnlLedgerRecord {
  row: LedgerRow
  amount: number
  /** Present only where `amount` is not the row's own figure. */
  basis?: string
}

/** One stream line under a cost-of-goods row. */
export interface PnlStreamItemRecord {
  /** `stream_items.id` — what a backfilled cost is written to. */
  id: string
  kind: 'break' | 'giveaway'
  streamDate: string
  sessionTitle: string
  productName: string
  /** In the product's own stock unit. */
  quantity: number
  priceUnit: StockUnit | null
  /** This line moved no stock: a reconciliation of a show already history. */
  reconciled: boolean
  /** NEGATIVE, as it lands in cost of goods. Zero on an uncosted line. */
  amount: number
  breakNumber: number | null
  location: string
  note: string
  createdAt: string
}

/**
 * One term of a modelled figure — a night's counts times a rate.
 *
 * `amount` is signed money and the components sum to the payload's total, so a
 * derived line reconciles exactly the way a transaction list does. What it is
 * NOT is a list of records, and the screen says so.
 */
export interface PnlDerivedTerm {
  key: string
  label: string
  /** The arithmetic written out: "3 cards × 5¢". */
  detail: string
  amount: number
}

// A DERIVED PAYLOAD NO LONGER CARRIES A LIST OF NIGHTS IT COULD NOT MEASURE.
// `PnlUnknownNight` was that list: the packaging model counted envelopes off the
// packing slips, the shipping workspace holds one show's slips at a time, and a
// line reading "not known" that drilled to an empty table would have said the
// cost did not happen. Nothing on this statement is measured-and-lost any more —
// the two lines that were went with the packaging section — so the type, the
// field and the block that rendered it are gone rather than left to return an
// empty array on every click. A modelled cost that comes back with the same
// problem brings them back with it.

interface PnlDetailBase {
  lineId: string
  /** The line as the statement labels it, echoed back so a stale click cannot
   *  put one line's records under another line's heading. */
  label: string
  /**
   * The sum of EVERY matching record, not of the ones returned. This is the
   * figure the screen reconciles against the line that was clicked.
   */
  total: number
  /** Records beyond the page limit, and what they hold. Zero on almost every
   *  line; a month of break spots is the case it exists for. */
  omitted: { count: number; amount: number }
  /** Said on screen above the records. Why a figure is derived, what a range
   *  could not cover, what an empty list means. */
  note?: string
  /**
   * The note is a FAULT REPORT rather than a footnote, and has to be drawn as
   * one — the same danger banner the statement raises when its own sections do
   * not add up. Only the cost-of-goods residual sets it: that line exists at all
   * only because main and the renderer were built from different versions, so a
   * grey paragraph under the heading would put a build fault in the tone of a
   * caption. Absent everywhere else, where the note really is a footnote.
   */
  noteTone?: 'danger'
}

export type PnlDetail =
  | (PnlDetailBase & { kind: 'ledgerRows'; rows: PnlLedgerRecord[] })
  | (PnlDetailBase & { kind: 'streamItems'; items: PnlStreamItemRecord[] })
  | (PnlDetailBase & { kind: 'expenses'; entries: GeneralExpense[] })
  | (PnlDetailBase & { kind: 'derived'; terms: PnlDerivedTerm[] })

/** How many records one drill returns. Beyond this the total still covers
 *  everything and `omitted` says what was left out — the sum on screen is never
 *  allowed to be the sum of a page. */
export const PNL_DRILL_LIMIT = 1000

/** An empty payload of the right shape, so a caller without permission and a
 *  range with no records take the same path through the screen. */
export function emptyPnlDetail(lineId: string, label = ''): PnlDetail {
  return {
    kind: 'ledgerRows',
    lineId,
    label,
    total: 0,
    omitted: { count: 0, amount: 0 },
    rows: []
  }
}

/**
 * A drilled stream line, in the shape the cost-entry form already takes.
 *
 * The form exists, it is the one on the statement's uncosted rows, and a second
 * one reached from the drill-down would be a second chance to disagree about
 * which unit a price is per. So the record is narrowed to the fields that form
 * needs rather than the form being taught a new type.
 */
export function asUncostedStreamItem(rec: PnlStreamItemRecord): {
  id: string
  kind: 'break' | 'giveaway'
  streamDate: string
  sessionTitle: string
  quantity: number
  priceUnit: StockUnit | null
  reconciled: boolean
} {
  return {
    id: rec.id,
    kind: rec.kind,
    streamDate: rec.streamDate,
    sessionTitle: rec.sessionTitle,
    quantity: rec.quantity,
    priceUnit: rec.priceUnit,
    reconciled: rec.reconciled
  }
}

/** The records a payload holds, whatever kind it is — for the "N rows total $X"
 *  line, which has to say the same thing on all four. */
export function pnlDetailCount(detail: PnlDetail): number {
  switch (detail.kind) {
    case 'ledgerRows':
      return detail.rows.length
    case 'streamItems':
      return detail.items.length
    case 'expenses':
      return detail.entries.length
    case 'derived':
      return detail.terms.length
  }
}
