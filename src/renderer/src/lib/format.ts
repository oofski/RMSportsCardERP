export function initials(first: string, last: string): string {
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase()
}

export function formatMoney(amount: number, opts?: { compact?: boolean }): string {
  if (opts?.compact && Math.abs(amount) >= 1000) {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'USD',
      notation: 'compact',
      maximumFractionDigits: 1
    }).format(amount)
  }
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount)
}

/**
 * A PER-UNIT money figure — a cost per box, an average, a lot's unit price.
 *
 * Two decimals when that is the whole number, and up to four when it is not.
 * Costs are stored at four places because a unit cost is a rate rather than a
 * total (see UNIT_DP in db/lots.ts), and a blended average of $15.7142… shown as
 * "$15.71" beside a total of $110.00 invites exactly the arithmetic that used to
 * be wrong: 7 × $15.71 is $109.97, and somebody will check. Ordinary cent-valued
 * costs are unaffected and still read like money.
 */
export function formatUnitMoney(amount: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4
  }).format(amount)
}

export function fullName(first: string, last: string): string {
  return `${first} ${last}`.trim()
}

/** "12h 30m" style label from a minute count. */
export function formatHours(minutes: number): string {
  if (!minutes || minutes <= 0) return '0h'
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

/** Convert a Date to the value expected by <input type="datetime-local">. */
export function toLocalInputValue(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`
}

/** Parse a datetime-local input value into an ISO string. */
export function fromLocalInputValue(value: string): string {
  return new Date(value).toISOString()
}
