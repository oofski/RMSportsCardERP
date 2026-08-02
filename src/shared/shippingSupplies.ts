/**
 * What a show costs in supplies.
 *
 * A night of breaking consumes consumables in fixed ratios to two numbers: how
 * many PACKS the show produced, and how many PACKAGES went out. Everything here
 * derives from those two, so the whole model is auditable by hand — somebody can
 * check the screen against a calculator and a slip, which is the only way a
 * number that moves real stock earns trust.
 *
 * ## The base unit is the SLATE, not what sold
 *
 * Ten MLB breaks is three hundred packs, whether or not every team sold. Every
 * team in a break gets pulled, sleeved and bagged; the ones nobody bought go to
 * the house rather than into a box. Counting sold cards would under-order every
 * consumable by exactly the number of unsold teams.
 *
 * Giveaways never add to the pack count. A promo rider is a card that already
 * exists — it was pulled from a break that has already been counted.
 *
 * ## Everything rounds UP
 *
 * 95% of 390 is 370.5, and there is no such thing as half a top sleeve. Up,
 * not nearest: running short mid-show costs a night, and over-reserving costs a
 * sleeve.
 *
 * This module is deliberately pure — no database, no clock, no IPC. It is the
 * one part of the supply chain that has to be provably right.
 */

/** The consumables a show burns. A supply row is linked to one of these. */
export type ShipSupplyRole =
  | 'break_label_2x1'
  | 'top_sleeve'
  | 'toploader'
  | 'team_bag'
  | 'shipping_label_4x6'
  | 'bubble_mailer'

export const SHIP_SUPPLY_ROLES: ShipSupplyRole[] = [
  'break_label_2x1',
  'top_sleeve',
  'toploader',
  'team_bag',
  'shipping_label_4x6',
  'bubble_mailer'
]

export const SHIP_SUPPLY_ROLE_LABELS: Record<ShipSupplyRole, string> = {
  break_label_2x1: '2×1 break labels',
  top_sleeve: 'Top sleeves',
  toploader: 'Toploaders',
  team_bag: 'Team bags',
  shipping_label_4x6: '4×6 shipping labels',
  bubble_mailer: 'Bubble mailers'
}

/** Share of packs that get a top sleeve. */
export const TOP_SLEEVE_RATE = 0.95
/** Share of packs that get top-loaded. */
export const TOPLOADER_RATE = 0.5
/** Spare team bags per show, for the ones that tear. */
export const TEAM_BAG_SPARES = 5
/** Bubble mailers for a package that contains at least one bought card. */
export const MAILERS_PER_CARDED_ORDER = 2
/** Bubble mailers for a package that is only giveaways. */
export const MAILERS_PER_GIVEAWAY_ORDER = 1

/** One break's contribution to the pack count. */
export interface SupplyBreakInput {
  /** The printed label, for the explanation only. */
  label: string
  /**
   * The league's full slate — 30 MLB/NBA, 32 NFL/NHL. NOT how many sold: every
   * team in the break is pulled and bagged regardless.
   */
  slateSize: number
}

/** One package's contribution to the per-order counts. */
export interface SupplyOrderInput {
  /** Every card in the package, giveaways included. */
  cardCount: number
  /** How many of those are giveaways. */
  giveawayCount: number
}

export interface ShipSupplyLine {
  role: ShipSupplyRole
  label: string
  quantity: number
  /** The arithmetic, in words, so the number can be checked by hand. */
  basis: string
}

export interface ShipSupplyPlan {
  /** breaks × slate. The base every pack-level consumable scales from. */
  packs: number
  breakCount: number
  /** Packages that went out — one 4×6 label each. */
  orderCount: number
  /** Packages holding at least one bought card. */
  cardedOrders: number
  /** Packages holding cards, all of them giveaways. */
  giveawayOnlyOrders: number
  /**
   * Packages with no cards at all. Rare and usually a data oddity, but they
   * still ship, so they still take a label and a mailer — and they are reported
   * separately rather than folded silently into one of the other two.
   */
  emptyOrders: number
  lines: ShipSupplyLine[]
}

/** Whole units, always up. See the note at the top of the file. */
function up(n: number): number {
  return Math.max(0, Math.ceil(n - 1e-9))
}

/**
 * The supply plan for one show.
 *
 * Pure: the same inputs always give the same answer, which is what makes it
 * safe to show somebody a number and then move stock by it.
 */
export function computeSupplyPlan(input: {
  breaks: SupplyBreakInput[]
  orders: SupplyOrderInput[]
}): ShipSupplyPlan {
  const breakCount = input.breaks.length
  const packs = input.breaks.reduce((n, b) => n + Math.max(0, Math.trunc(b.slateSize)), 0)

  let cardedOrders = 0
  let giveawayOnlyOrders = 0
  let emptyOrders = 0
  for (const o of input.orders) {
    const cards = Math.max(0, Math.trunc(o.cardCount))
    const giveaways = Math.min(cards, Math.max(0, Math.trunc(o.giveawayCount)))
    if (cards === 0) emptyOrders += 1
    else if (giveaways >= cards) giveawayOnlyOrders += 1
    else cardedOrders += 1
  }
  const orderCount = input.orders.length

  // An empty package still ships, so it takes a mailer — the single-mailer kind,
  // because there are no cards in it to protect twice.
  const mailers =
    cardedOrders * MAILERS_PER_CARDED_ORDER +
    (giveawayOnlyOrders + emptyOrders) * MAILERS_PER_GIVEAWAY_ORDER

  const pct = (rate: number): string => `${Math.round(rate * 100)}%`

  const lines: ShipSupplyLine[] = [
    {
      role: 'break_label_2x1',
      label: SHIP_SUPPLY_ROLE_LABELS.break_label_2x1,
      quantity: packs,
      basis: `one per pack · ${breakCount} break${breakCount === 1 ? '' : 's'} = ${packs} packs`
    },
    {
      role: 'top_sleeve',
      label: SHIP_SUPPLY_ROLE_LABELS.top_sleeve,
      quantity: up(packs * TOP_SLEEVE_RATE),
      basis: `${pct(TOP_SLEEVE_RATE)} of ${packs} packs, rounded up`
    },
    {
      role: 'toploader',
      label: SHIP_SUPPLY_ROLE_LABELS.toploader,
      quantity: up(packs * TOPLOADER_RATE),
      basis: `${pct(TOPLOADER_RATE)} of ${packs} packs, rounded up`
    },
    {
      role: 'team_bag',
      label: SHIP_SUPPLY_ROLE_LABELS.team_bag,
      quantity: packs > 0 ? packs + TEAM_BAG_SPARES : 0,
      basis: `${packs} packs + ${TEAM_BAG_SPARES} spare for tears`
    },
    {
      role: 'shipping_label_4x6',
      label: SHIP_SUPPLY_ROLE_LABELS.shipping_label_4x6,
      quantity: orderCount,
      basis: `one per package · ${orderCount} package${orderCount === 1 ? '' : 's'}`
    },
    {
      role: 'bubble_mailer',
      label: SHIP_SUPPLY_ROLE_LABELS.bubble_mailer,
      quantity: mailers,
      basis:
        `${MAILERS_PER_CARDED_ORDER} × ${cardedOrders} with cards` +
        ` + ${MAILERS_PER_GIVEAWAY_ORDER} × ${giveawayOnlyOrders + emptyOrders} giveaway-only`
    }
  ]

  return {
    packs,
    breakCount,
    orderCount,
    cardedOrders,
    giveawayOnlyOrders,
    emptyOrders,
    lines
  }
}

// ---------------------------------------------------------------------------
// Costed: the plan with real supply rows behind it
// ---------------------------------------------------------------------------

/**
 * A plan line once it has been matched to an actual row in the supplies list.
 *
 * `supplyId` is null when nobody has said which product plays this role yet.
 * That is a normal state on a fresh install, not an error — the quantity is
 * still correct and still worth showing; it just cannot be costed or deducted.
 */
export interface ShipSupplyLineCosted extends ShipSupplyLine {
  supplyId: string | null
  supplyName: string | null
  /** Items on hand right now. 0 when unmapped. */
  onHand: number
  /** Moving weighted-average cost per item. 0 when unmapped. */
  unitCost: number
  /** quantity × unitCost. 0 when unmapped — never a guess. */
  lineCost: number
  /** How many short the show would run. 0 when there is enough, or unmapped. */
  shortBy: number
}

export interface ShipSupplyPlanCosted extends Omit<ShipSupplyPlan, 'lines'> {
  lines: ShipSupplyLineCosted[]
  /** Sum of every costed line. Unmapped roles contribute nothing. */
  totalCost: number
  /** Roles with no supply behind them — what still needs linking. */
  unmappedRoles: ShipSupplyRole[]
  /** Roles the show would run short on, at current on-hand. */
  shortRoles: ShipSupplyRole[]
}

/** Round money the way the rest of the app does. */
function money(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100
}

/**
 * Attach real supplies to a plan.
 *
 * Pure, so the costing can be checked without a database: the caller looks the
 * rows up, this decides what they mean.
 */
export function costSupplyPlan(
  plan: ShipSupplyPlan,
  bySupplyRole: (role: ShipSupplyRole) => {
    id: string
    name: string
    quantity: number
    unitCost: number
  } | null
): ShipSupplyPlanCosted {
  const unmappedRoles: ShipSupplyRole[] = []
  const shortRoles: ShipSupplyRole[] = []
  let totalCost = 0

  const lines: ShipSupplyLineCosted[] = plan.lines.map((line) => {
    const supply = bySupplyRole(line.role)
    if (!supply) {
      unmappedRoles.push(line.role)
      return {
        ...line,
        supplyId: null,
        supplyName: null,
        onHand: 0,
        unitCost: 0,
        lineCost: 0,
        shortBy: 0
      }
    }
    const lineCost = money(line.quantity * supply.unitCost)
    totalCost += lineCost
    const shortBy = Math.max(0, line.quantity - supply.quantity)
    if (shortBy > 0) shortRoles.push(line.role)
    return {
      ...line,
      supplyId: supply.id,
      supplyName: supply.name,
      onHand: supply.quantity,
      unitCost: supply.unitCost,
      lineCost,
      shortBy
    }
  })

  return { ...plan, lines, totalCost: money(totalCost), unmappedRoles, shortRoles }
}
