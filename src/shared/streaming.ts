/**
 * Streaming — live show sessions, what was broken on them, and what was given
 * away.
 *
 * WHY THIS MODULE EXISTS
 *
 * The Whatnot P&L is only trustworthy if revenue can be attributed to the show
 * that produced it. Whatnot's ledger stamps every sale with an instant, not a
 * show, and RM's streams routinely run past midnight — a Monday-night show that
 * ends at 2am produces sales dated Tuesday. Bucketing those by calendar date
 * splits one show across two days and makes both wrong.
 *
 * A session is therefore an absolute time WINDOW, and every session also
 * carries the local calendar date it STARTED on (`streamDate`) as its business
 * day. A show running 9pm Monday to 2am Tuesday is one session, entirely
 * Monday's. That single decision is what makes the P&L add up, and it is why
 * sessions may not overlap: an overlap would make a sale's owning show
 * ambiguous, and there would be no correct way to resolve it later.
 */

export type StreamStatus = 'live' | 'ended'

/**
 * How the session got here. 'live' was clocked with Start stream; 'manual' was
 * typed in afterwards because nobody remembered to. Both are equally valid for
 * the P&L — the distinction exists so the operator can see which times were
 * measured and which were recalled.
 */
export type StreamSource = 'live' | 'manual'

/** A break consumes stock to open it; a giveaway consumes stock to give away. */
export type StreamItemKind = 'break' | 'giveaway'

export interface StreamSession {
  id: string
  title: string
  /** ISO instant the show went live. */
  startedAt: string
  /** ISO instant it ended. null while still live. */
  endedAt: string | null
  /**
   * The LOCAL calendar date (YYYY-MM-DD) the show started on — its business
   * day. Stored rather than derived so the calendar groups without redoing
   * timezone maths on every query, and so a session stays on its own day even
   * if the machine's timezone later changes.
   */
  streamDate: string
  status: StreamStatus
  source: StreamSource
  hostId: string | null
  /** Resolved for display; null when the employee record is gone. */
  hostName: string | null
  note: string | null
  /** Whole minutes, null while live. */
  durationMinutes: number | null
  createdAt: string
  updatedAt: string
  createdBy: string | null
}

/**
 * One thing consumed on a show. Breaks and giveaways share a shape because they
 * are the same operation against inventory — pull N units of a product out of a
 * location at their real FIFO cost — and differ only in what the cost is FOR.
 * One shape means one stock path and, crucially, one reversal path.
 */
export interface StreamItem {
  id: string
  sessionId: string
  kind: StreamItemKind
  /** null only when the catalog product was later deleted. */
  productId: string | null
  /** Denormalised so the line survives a product delete. */
  productName: string
  sku: string
  category: string
  /** Thumbnail data/file URL, resolved for display. */
  image: string | null
  /** Matches "Break #N" in the Whatnot ledger. Breaks only. */
  breakNumber: number | null
  /** Who received it. Giveaways only. */
  recipient: string | null
  quantity: number
  location: string
  /** Cost of the exact FIFO layers this line consumed, per unit and in total. */
  unitCost: number
  costTotal: number
  note: string | null
  createdAt: string
  createdBy: string | null
}

export interface StreamTotals {
  breakLines: number
  breakUnits: number
  breakCost: number
  giveawayLines: number
  giveawayUnits: number
  giveawayCost: number
  totalCost: number
}

export interface StreamSessionDetail {
  session: StreamSession
  items: StreamItem[]
  totals: StreamTotals
}

/** One cell of the calendar. Keyed by the session's streamDate, never by the
 *  date a session happened to end on. */
export interface StreamCalendarDay {
  date: string
  sessionCount: number
  liveCount: number
  minutes: number
  breakUnits: number
  giveawayUnits: number
  cost: number
}

export interface StreamCalendarMonth {
  /** YYYY-MM */
  month: string
  days: StreamCalendarDay[]
  totals: StreamTotals & { sessionCount: number; minutes: number }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface NewStreamSession {
  title: string
  startedAt: string
  endedAt: string | null
  hostId: string | null
  note: string | null
}

export interface UpdateStreamSession {
  id: string
  title?: string
  startedAt?: string
  endedAt?: string | null
  hostId?: string | null
  note?: string | null
}

export interface NewStreamItem {
  sessionId: string
  kind: StreamItemKind
  productId: string
  quantity: number
  location: string
  breakNumber?: number | null
  recipient?: string | null
  note?: string | null
}

// ---------------------------------------------------------------------------
// Time helpers — shared so main and renderer can never disagree about which
// day a session belongs to.
// ---------------------------------------------------------------------------

/**
 * The LOCAL calendar date of an instant, as YYYY-MM-DD.
 *
 * Deliberately local rather than UTC. A show that starts at 9pm Eastern is
 * dated 02:00 UTC the NEXT day, so a UTC key would file every evening stream
 * under tomorrow — precisely the bug this module exists to avoid.
 */
export function streamDateOf(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Whole minutes between two instants; null when either is missing/invalid. */
export function durationMinutes(startedAt: string, endedAt: string | null): number | null {
  if (!endedAt) return null
  const a = new Date(startedAt).getTime()
  const b = new Date(endedAt).getTime()
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null
  return Math.round((b - a) / 60000)
}

/**
 * Do two sessions share any instant? Half-open [start, end) so a show ending at
 * exactly 02:00 and the next starting at 02:00 do NOT collide — that is a clean
 * handover, not a conflict.
 *
 * A live session (no end) is treated as running to the end of time, because it
 * is: nothing else may be scheduled while a show is still on air.
 */
export function sessionsOverlap(
  aStart: string,
  aEnd: string | null,
  bStart: string,
  bEnd: string | null
): boolean {
  const as = new Date(aStart).getTime()
  const ae = aEnd ? new Date(aEnd).getTime() : Number.POSITIVE_INFINITY
  const bs = new Date(bStart).getTime()
  const be = bEnd ? new Date(bEnd).getTime() : Number.POSITIVE_INFINITY
  if (Number.isNaN(as) || Number.isNaN(bs)) return false
  return as < be && bs < ae
}

/**
 * A show longer than this is almost certainly a forgotten "End stream" rather
 * than a real marathon. Not enforced as an error — the operator may genuinely
 * have run long — but surfaced so a session that would swallow a whole week of
 * ledger rows gets noticed before it corrupts the P&L.
 */
export const STREAM_LONG_HOURS = 12

export function isSuspiciouslyLong(session: StreamSession, now = Date.now()): boolean {
  const start = new Date(session.startedAt).getTime()
  if (Number.isNaN(start)) return false
  const end = session.endedAt ? new Date(session.endedAt).getTime() : now
  return end - start > STREAM_LONG_HOURS * 3600_000
}

/** Format minutes as "3h 42m" / "42m". */
export function formatDuration(minutes: number | null): string {
  if (minutes === null) return '—'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}
