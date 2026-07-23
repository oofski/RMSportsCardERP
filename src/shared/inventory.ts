/** Stock locations. Two to begin with. */
export type Location = 'RM' | 'AM'

export const LOCATIONS: { id: Location; label: string }[] = [
  { id: 'RM', label: 'RM' },
  { id: 'AM', label: 'AM' }
]

export const LOCATION_IDS: Location[] = LOCATIONS.map((l) => l.id)

export function isLocation(value: unknown): value is Location {
  return value === 'RM' || value === 'AM'
}

/** Preferred display order for category cards on the dashboard. */
export const CATEGORY_ORDER = [
  'Baseball',
  'Basketball',
  'Football',
  'Soccer',
  'Hockey',
  'UFC',
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
  Entertainment: '#cf4d93',
  Pokemon: '#e0a52e'
}

/** Highlight color for a category, falling back to a neutral slate. */
export function categoryColor(category: string): string {
  return CATEGORY_COLORS[category] ?? '#64748b'
}
