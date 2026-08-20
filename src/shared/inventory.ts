/**
 * A place this business holds stock.
 *
 * Was the literal union 'RM' | 'AM'. It is a string now because the two shelves
 * this app was built around are no longer the only ones: a Roadshow shop that
 * keeps product between events is OUR inventory sitting somewhere else, not a
 * dropship, and the old model had no way to say that.
 */
export type Location = string

/** One place, as the registry holds it. */
export interface StockLocation {
  id: string
  label: string
  /** Kept near the top of every picker. */
  pinned: boolean
  /**
   * No longer used, but never forgotten.
   *
   * A retired place STILL HOLDS STOCK as far as `destinationHoldsStock` is
   * concerned, and that is the whole point of retiring rather than deleting:
   * every sales order ever fulfilled from it was priced and costed on the
   * understanding that its units came off a shelf. Drop it from the set and
   * every one of those documents silently reclassifies as a dropship — the stock
   * math of closed months changes underneath somebody. It simply stops being
   * offered.
   */
  retired: boolean
}

/**
 * THE TWO THAT CANNOT BE REMOVED.
 *
 * Every migration, backfill and default in this app resolves a blank
 * destination to RM, and AM is the other original shelf. They are the floor of
 * the registry rather than rows that happen to be seeded, so a database whose
 * `stock_locations` table is empty, unmigrated or unreadable still behaves
 * exactly as this app always has.
 */
export const BUILTIN_LOCATION_IDS: readonly string[] = ['RM', 'AM']

/**
 * Every place stock can sit, including retired ones.
 *
 * A module-level registry rather than a constant, because the set is now data.
 * It is HYDRATED — main from the database as it opens, the renderer from a read
 * at start-up — and it always contains the two built-ins, so an unhydrated copy
 * is the old behaviour rather than an empty world.
 *
 * ## The main process is the authority, and that is what makes this safe
 *
 * Every decision that MOVES STOCK — saveInvoice choosing which lines draw down,
 * the receiving paths, the FIFO engine — runs in main against a registry
 * hydrated synchronously from the table. The renderer's copy decorates screens.
 * So a renderer that has not hydrated yet can draw the wrong chip; it cannot
 * cost a box wrongly.
 */
let knownLocations: StockLocation[] = BUILTIN_LOCATION_IDS.map((id) => ({
  id,
  label: id,
  pinned: false,
  retired: false
}))

/**
 * Replace the registry. Called by main after reading the table, and by the
 * renderer after fetching it.
 *
 * The built-ins are re-added if the caller omits them, so no read — however
 * partial, however stale — can take RM or AM out of the world.
 */
export function setKnownLocations(rows: readonly StockLocation[]): void {
  const byId = new Map<string, StockLocation>()
  for (const id of BUILTIN_LOCATION_IDS) {
    byId.set(id.toLowerCase(), { id, label: id, pinned: false, retired: false })
  }
  for (const r of rows) {
    const id = String(r.id ?? '').trim()
    if (!id) continue
    byId.set(id.toLowerCase(), {
      id,
      label: String(r.label ?? '').trim() || id,
      pinned: !!r.pinned,
      // A built-in can never be retired, whatever a row says.
      retired: BUILTIN_LOCATION_IDS.some((b) => b.toLowerCase() === id.toLowerCase())
        ? false
        : !!r.retired
    })
  }
  knownLocations = [...byId.values()]
  refreshExports()
}

/** Every place, retired included. */
export function allLocations(): StockLocation[] {
  return knownLocations
}

/**
 * The places worth offering — pinned first, then the rest, retired dropped.
 *
 * `LOCATIONS` and `LOCATION_IDS` are `let` rather than `const` because an ES
 * module exports a live BINDING: every importer sees the reassignment, so the
 * thirty-odd call sites that already read these arrays keep working unchanged
 * and simply start seeing the whole list. Rewriting them all to call a function
 * would have been the same behaviour with thirty more chances to miss one.
 */
export let LOCATIONS: { id: Location; label: string }[] = BUILTIN_LOCATION_IDS.map((id) => ({
  id,
  label: id
}))

export let LOCATION_IDS: Location[] = [...BUILTIN_LOCATION_IDS]

function refreshExports(): void {
  const active = activeLocations()
  LOCATIONS = active.map((l) => ({ id: l.id, label: l.label }))
  LOCATION_IDS = active.map((l) => l.id)
}

export function activeLocations(): StockLocation[] {
  return knownLocations
    .filter((l) => !l.retired)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      const ai = BUILTIN_LOCATION_IDS.indexOf(a.id)
      const bi = BUILTIN_LOCATION_IDS.indexOf(b.id)
      if (ai !== bi) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
      return a.label.localeCompare(b.label)
    })
}

/** The ids of everywhere still in use. What a picker lists. */
export function locationIds(): string[] {
  return activeLocations().map((l) => l.id)
}

/**
 * Is this the name of a place we hold stock?
 *
 * RETIRED PLACES COUNT. See StockLocation.retired — a closed month must not
 * re-cost itself because a shelf was later put beyond use.
 */
export function isLocation(value: unknown): value is Location {
  const v = String(value ?? '').trim().toLowerCase()
  if (!v) return false
  return knownLocations.some((l) => l.id.toLowerCase() === v)
}

/** Preferred display order for category cards on the dashboard. */
export const CATEGORY_ORDER = [
  'Baseball',
  'Basketball',
  'Football',
  'Soccer',
  'Hockey',
  'UFC',
  'Racing',
  'Tennis',
  'Entertainment',
  'Pokemon'
]

/**
 * A distinct highlight color per category — used purely for colorway across the
 * logos, chips, category cards and chart bars. Tuned to read cleanly on both the
 * light and dark surfaces (mid-tone hues that tint and darken/lighten well).
 */
export const CATEGORY_COLORS: Record<string, string> = {
  Baseball: '#d94a4a',
  Basketball: '#e0842f',
  Football: '#96693a',
  Soccer: '#33a06f',
  Hockey: '#3f83c9',
  UFC: '#8258c9',
  Racing: '#c9432f',
  Tennis: '#8fae35',
  Entertainment: '#cf4d93',
  Pokemon: '#e0a52e'
}

/** Highlight color for a category, falling back to a neutral slate. */
export function categoryColor(category: string): string {
  return CATEGORY_COLORS[category] ?? '#64748b'
}
