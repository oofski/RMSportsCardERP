/**
 * The BUSINESS timezone — the one clock the company's day is measured on.
 *
 * WHY THIS MODULE EXISTS
 *
 * Two kinds of time meet in this app, and CLAUDE.md already names the trap:
 * a show is a WALL CLOCK (a local day plus local HH:MM — an intention), while a
 * ledger row is an INSTANT (a physical event). Converting between them needs a
 * timezone, and until this module existed every conversion silently used
 * `new Date(y, m, d, h, …)` / `d.getHours()` — the RUNNING MACHINE's zone.
 *
 * That is correct for exactly one deployment: a desktop app on the owner's
 * laptop. It is wrong for the other one that ships from this same repo. The web
 * build runs the identical main-process code inside a Docker container on
 * Render, and `node:22-bookworm-slim` sets no TZ, so its local zone is UTC.
 *
 * The consequence was not subtle. A show's window is written by the BROWSER (on
 * the owner's laptop, in Central), while a ledger CSV uploaded through that same
 * browser is parsed by the SERVER, in UTC. Whatnot's export writes a naked wall
 * clock with no offset, so the server read "Aug 6, 2026, 6:20:00 PM" as 18:20
 * UTC when it meant 18:20 Central — 23:20 UTC. Every row landed five hours
 * before the show that earned it, and a three-hour evening show matched none of
 * its own sales. Sales on the same days imported from the desktop matched fine,
 * which is exactly why this looked like a web-only fault.
 *
 * So the zone is named here, ONCE, and every wall-clock conversion asks for it
 * rather than asking the machine. Desktop and server then agree by construction.
 *
 * WHY A NAMED ZONE AND NOT AN OFFSET
 *
 * America/Chicago is UTC-6 in winter and UTC-5 in summer. A stored offset would
 * be right for half the year and silently wrong for the other half, and would
 * break on exactly the two nights a year when it is hardest to notice. The IANA
 * name lets the platform apply the rule that was in force at that instant, which
 * is the only thing that is right all year — the same reasoning CLAUDE.md gives
 * for parsing date-only strings at UTC noon.
 */

/**
 * Where the business actually operates. RM runs on US Central.
 *
 * A DEFAULT, not a constant: `setBusinessTimeZone` overrides it, so a second
 * location later is a change of value rather than a change of code.
 */
export const DEFAULT_BUSINESS_TIME_ZONE = 'America/Chicago'

let currentZone = DEFAULT_BUSINESS_TIME_ZONE

/** The zone every wall-clock conversion in the app is measured against. */
export function businessTimeZone(): string {
  return currentZone
}

/**
 * Point the app at a different zone.
 *
 * Called once at boot from `RMOPS_BUSINESS_TZ` (see main/index.ts and
 * server/index.ts). An unusable value is REFUSED rather than accepted, because
 * the failure it would otherwise cause — every conversion silently falling back
 * to the machine's zone — is precisely the bug this module exists to end.
 * Returns whether the zone was taken.
 */
export function setBusinessTimeZone(zone: string): boolean {
  if (!isValidTimeZone(zone)) return false
  currentZone = zone
  return true
}

/** Does the platform know this IANA name? */
export function isValidTimeZone(zone: string): boolean {
  if (!zone || typeof zone !== 'string') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/**
 * One formatter per zone. `Intl.DateTimeFormat` construction is far more
 * expensive than formatting, and attribution calls this once per ledger row —
 * tens of thousands of times in a single import.
 */
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      // h23 rather than hour12:false — the latter renders midnight as "24" in
      // some ICU builds, which reads back as the wrong day.
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
    formatters.set(zone, f)
  }
  return f
}

/** A wall clock: what a clock on the wall in some zone reads. Month is 1-12. */
export interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/** What the clock in `zone` reads at this instant. */
export function wallClockOf(instantMs: number, zone: string = currentZone): WallClock | null {
  if (!Number.isFinite(instantMs)) return null
  const parts = formatterFor(zone).formatToParts(new Date(instantMs))
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type)
    return p ? Number(p.value) : NaN
  }
  const wc: WallClock = {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second')
  }
  for (const v of Object.values(wc)) if (!Number.isFinite(v)) return null
  return wc
}

/**
 * How far `zone` is ahead of UTC at this instant, in milliseconds.
 * Negative for the Americas (Central is -5h in summer, -6h in winter).
 */
export function zoneOffsetMs(instantMs: number, zone: string = currentZone): number {
  const wc = wallClockOf(instantMs, zone)
  if (!wc) return 0
  // The wall clock READ AS IF it were UTC, minus the real instant, is the offset.
  const asUtc = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second)
  // Millisecond remainder is not in the formatted parts; drop it from both sides.
  return asUtc - (instantMs - (((instantMs % 1000) + 1000) % 1000))
}

/**
 * The instant at which the clock in `zone` reads this wall clock.
 *
 * The inverse of `wallClockOf`, and it has to be solved rather than computed:
 * the offset to apply depends on the instant, which is what we are looking for.
 * Two passes converge everywhere — the first guess is at most an hour out (a DST
 * shift), and the second is evaluated with the offset in force at that guess.
 *
 * THE TWO DEGENERATE CASES, both real, both harmless here:
 *
 * - Spring forward: 02:30 does not exist on the morning the clocks jump. It
 *   resolves to 01:30, the same instant the hour before it names — measured, not
 *   assumed. No show and no ledger row can carry a wall clock that never
 *   happened, so nothing real reaches this branch.
 * - Fall back: 01:30 happens twice. This returns the FIRST (still on daylight
 *   time), which is the same choice `Date` makes for a local wall clock. Whatnot
 *   writes no offset, so no parser could do better; the rows are an hour apart
 *   at worst and stay inside the same show.
 */
export function instantFromWallClock(wc: WallClock, zone: string = currentZone): number {
  const naive = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second)
  if (!Number.isFinite(naive)) return NaN
  let guess = naive - zoneOffsetMs(naive, zone)
  guess = naive - zoneOffsetMs(guess, zone)
  return guess
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

/**
 * The BUSINESS calendar date of an instant, as YYYY-MM-DD.
 *
 * This is the business-day key the whole P&L groups on. Deliberately not the
 * machine's local date and never the UTC date: a show that starts at 9pm Central
 * is 02:00 UTC the next day, so a UTC key files every evening stream under
 * tomorrow — which is exactly what the Render container was doing.
 */
export function businessDayOf(iso: string, zone: string = currentZone): string {
  const ms = new Date(iso).getTime()
  if (Number.isNaN(ms)) return ''
  const wc = wallClockOf(ms, zone)
  if (!wc) return ''
  return `${pad(wc.year, 4)}-${pad(wc.month)}-${pad(wc.day)}`
}

/**
 * An instant reduced to its business wall-clock digits: YYYYMMDDHHMMSS.
 *
 * The identity half of a ledger row's fingerprint. Built from the wall clock
 * rather than the instant so that re-importing a file after a timezone change
 * recognises the rows it already has instead of doubling the archive.
 */
export function businessStamp(iso: string, zone: string = currentZone): string {
  const ms = new Date(iso).getTime()
  if (Number.isNaN(ms)) return ''
  const wc = wallClockOf(ms, zone)
  if (!wc) return ''
  return (
    pad(wc.year, 4) + pad(wc.month) + pad(wc.day) + pad(wc.hour) + pad(wc.minute) + pad(wc.second)
  )
}
