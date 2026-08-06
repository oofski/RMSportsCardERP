/**
 * What a night costs in packaging, modelled from what it sold.
 *
 * ## The six lines
 *
 *   1. Sleeves            cards × 5¢                      every card gets one
 *   2. Top loaders        cards × 50% × 5¢
 *   3. Team bags          Σ over breaks of slate × 3¢
 *   4. Shipping labels    packages × 2¢
 *   5. Team bag stickers  Σ over breaks of slate × 1¢
 *   6. Mailers            paid packages × 48¢ + everything else × 24¢
 *
 * Three different bases — a card, a team in a break's slate, an envelope — and
 * they are not interchangeable. Cards and slates come from the ledger; envelopes
 * come from the shipping module, because one ledger order id is one SPOT and a
 * buyer who took six teams gets six order ids and one envelope.
 *
 * ## Still the only packaging cost the app has, and no statement reads it
 *
 * The P&L printed these six as a section until the owner took the cost off it,
 * to account for it another way. There is no packaging section now and no
 * packaging term in net profit — see the note where that section used to be in
 * `buildPnl` — so everything below is a DORMANT MODEL: it still runs for every
 * business day the ledger covers, its output is still stored on the day and
 * still rolled up, and nothing on screen states a cent of it.
 *
 * NOBODY MAY DELETE IT BECAUSE NOTHING READS IT. The owner intends to bring this
 * cost back in another shape, the rates below are the ones they stated, and
 * these figures are the per-night record waiting for that treatment.
 * `StreamDayFinance` carries the full argument.
 *
 * ## Pure
 *
 * No database, no clock. The inputs are counts somebody could read off a
 * packing slip, and the arithmetic below is meant to be reproducible with a
 * calculator — which is the only way a cost model earns the right to sit on a
 * statement.
 */

// ---------------------------------------------------------------------------
// The rates. EVERY per-unit price is here and nowhere else, so changing what a
// sleeve costs is one edit rather than a search. Nothing in this codebase may
// write one of these numbers as a literal.
// ---------------------------------------------------------------------------

/** A penny sleeve, per card. 100% of cards get one — every card that leaves the
 *  building is sleeved before anything else touches it. */
export const PACKAGING_SLEEVE_COST = 0.05

/** A top loader, per card that gets one. */
export const PACKAGING_TOP_LOADER_COST = 0.05
/**
 * Share of cards that get a top loader. Half of them: the base and the hits go
 * in rigid, the rest travel in the sleeve alone.
 *
 * The one line in this model whose multiplier is not 1, which is also the one
 * that lands on a fraction of a cent — 7 cards at 2.5¢ is 17.5¢. See `cost`
 * below for where that fraction goes and why it goes there exactly once.
 */
export const PACKAGING_TOP_LOADER_SHARE = 0.5

/** A team bag, per team in a break's slate. Charged on the SLATE and not on
 *  what sold: every team is pulled and bagged, and the ones nobody bought go to
 *  the house rather than back in the box. */
export const PACKAGING_TEAM_BAG_COST = 0.03

/** A 4×6 thermal shipping label, per package. One per envelope, giveaway or
 *  not — the carrier does not care what is inside. */
export const PACKAGING_SHIPPING_LABEL_COST = 0.02

/**
 * The sticker that names the team on its bag, per team in a break's slate.
 *
 * Charged on the same base as the team bag above and never on a different one:
 * a bag without a sticker is an unlabelled bag, so there is exactly one of these
 * per bag. They are two lines rather than one 4¢ line because the owner buys
 * them separately and one of the two prices can move without the other.
 */
export const PACKAGING_TEAM_BAG_STICKER_COST = 0.01

/**
 * A mailer for a package holding at least one PAID card.
 *
 * Twice the giveaway rate because a bought card travels double-mailered — one
 * inside the other — and a card somebody paid for is the one that must not
 * arrive bent.
 */
export const PACKAGING_PAID_MAILER_COST = 0.48
/** A mailer for a package that is giveaways only. One mailer, half the cost. */
export const PACKAGING_GIVEAWAY_MAILER_COST = 0.24

/** One business day's counts, which is everything the model runs on. */
export interface PackagingDayInput {
  /**
   * Break spots sold — one ledger `sale` row is one spot is one card.
   *
   * Whole-product sales are deliberately NOT in here: a sealed box sold outright
   * is not a card that gets sleeved, and counting it would put a sleeve, half a
   * toploader and a bag against a box that shipped in its own shrink wrap.
   */
  cards: number
  /**
   * Σ over the day's breaks of that break's full slate — 32 NFL/NHL, 30 MLB/NBA.
   *
   * Already summed, and already excluding any break whose league could not be
   * identified, because the caller is the only thing that can decide a break's
   * league and this module refuses to guess one. A break skipped upstream
   * contributes zero here and is reported as skipped rather than billed.
   */
  slateTeams: number
  /**
   * Physical envelopes shipped, or NULL when nothing can say.
   *
   * NULL IS NOT ZERO. Zero means the night shipped nothing; null means the app
   * has no packing record for it, which is the ordinary state of every day but
   * the one currently loaded in the shipping workspace. The two lines priced per
   * package come back at zero either way — a money field cannot hold "unknown" —
   * so `packagesKnown` on the result is what the statement reads to decide
   * whether to print a figure or the words.
   */
  packages: number | null
  /**
   * Of those, the ones holding at least one PAID card. Null exactly when
   * `packages` is.
   *
   * Everything left over — `packages - paidPackages` — is charged at the
   * giveaway rate. That remainder deliberately includes the odd package holding
   * no cards at all, which is rare but real and still ships: it takes the SINGLE
   * mailer, because there is nothing bought inside it to protect twice. Same
   * rule the supply plan already applies to an empty order, and stated here
   * rather than left to be inferred from the subtraction.
   */
  paidPackages: number | null
}

/** The six lines, as SIGNED money — negative, like every other cost in the P&L,
 *  so a caller adds rather than remembering which way to apply it. */
export interface PackagingDayCosts {
  sleeves: number
  topLoaders: number
  teamBags: number
  shippingLabels: number
  teamBagStickers: number
  mailers: number
  /**
   * FALSE when the two per-package lines are zero because nobody knows rather
   * than because nothing shipped.
   *
   * It is a separate flag rather than a null amount because these figures land
   * in `StreamDayFinance` money fields, which are summed across ranges in
   * integer cents — a null there would poison a month's arithmetic to protect a
   * disclosure. The disclosure is carried by counting days instead: see
   * `packagingDaysUnknown` on the day.
   */
  packagesKnown: boolean
}

/**
 * Round to the cent EXACTLY ONCE, per line, and negate.
 *
 * The rates are sub-cent and the multipliers are integers, so most lines land on
 * a fraction of a cent — 7 cards of toploader at 2.5¢ is 17.5¢. Rounding here
 * and only here means the printed lines add up to the printed subtotal, which is
 * the property a reader checks first. The alternative, carrying fractions into
 * the subtotal, produces a total that is a cent away from its own lines with
 * nothing on screen to explain it.
 */
const cost = (dollars: number): number => -Math.round(dollars * 100) / 100

/** A count that arrived as rubbish contributes nothing rather than NaN — one
 *  NaN in a money field poisons every rollup above it. */
const n = (v: number): number => (Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0)

/**
 * The six packaging lines for one day, from its counts.
 *
 * Every figure is negative. Nothing here reads a database, so the same call with
 * the same numbers is the same answer on any machine — which is what lets the
 * test check it against arithmetic done by hand.
 */
export function computePackagingCosts(input: PackagingDayInput): PackagingDayCosts {
  const cards = n(input.cards)
  const slateTeams = n(input.slateTeams)
  // A null package count is unknown; anything else is a count, including zero.
  // The check is on null rather than on falsiness precisely so that a genuine
  // zero — a day whose dataset really did hold no packages — stays a zero.
  const packagesKnown = input.packages !== null && input.packages !== undefined
  const packages = packagesKnown ? n(input.packages as number) : 0
  // Bounded to the package count. A paid figure larger than the total would
  // otherwise make the giveaway remainder negative and quietly REFUND mailers —
  // a cost line that grows the profit is the one kind of arithmetic error nobody
  // goes looking for.
  const paidPackages = Math.min(packages, packagesKnown ? n(input.paidPackages as number) : 0)
  const giveawayPackages = Math.max(0, packages - paidPackages)
  return {
    sleeves: cost(cards * PACKAGING_SLEEVE_COST),
    // NOT ROUNDED UP TO WHOLE TOP LOADERS. The supply PLAN rounds up, because it
    // is ordering physical objects and half a top loader cannot be put on a
    // shelf. This is a cost model over a period, where half a top loader on
    // Monday and half on Tuesday is one top loader — rounding each night up
    // would overstate a month by roughly one loader per show, systematically and
    // always in the same direction.
    topLoaders: cost(cards * PACKAGING_TOP_LOADER_SHARE * PACKAGING_TOP_LOADER_COST),
    teamBags: cost(slateTeams * PACKAGING_TEAM_BAG_COST),
    // Zero when unknown, and the flag above is the only thing that tells the two
    // apart. Every reader of this figure has to consult it.
    shippingLabels: cost(packages * PACKAGING_SHIPPING_LABEL_COST),
    // The SAME base as the team bags, deliberately — one sticker per bag. A
    // future edit that gives one of these two lines a different unit count has
    // broken the model, not refined it.
    teamBagStickers: cost(slateTeams * PACKAGING_TEAM_BAG_STICKER_COST),
    // TWO RATES, ONE LINE. They are added before rounding rather than rounded
    // apart and summed, because the line is one figure on the statement and the
    // detail beside it writes out both halves — rounding twice would make the
    // written-out sum a cent away from the figure it explains.
    mailers: cost(
      paidPackages * PACKAGING_PAID_MAILER_COST +
        giveawayPackages * PACKAGING_GIVEAWAY_MAILER_COST
    ),
    packagesKnown
  }
}
