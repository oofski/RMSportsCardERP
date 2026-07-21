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
  'Combat',
  'Entertainment',
  'Pokemon'
]
