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

import type { LotPick } from './costLots'
import type { StockUnit } from './units'

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
  /**
   * The stock this line took out, in the PRODUCT'S OWN stock unit — cases for a
   * case-stocked product, boxes for a box-stocked one. This is the number
   * inventory moved by, and it is what every cost figure is derived from.
   *
   * It may be fractional, but only for a product flagged `giveawayItem`: three
   * packs out of a twelve-pack box is a quarter of a box. See @shared/units.
   */
  quantity: number
  /**
   * What the operator actually TYPED, kept so a line reads back the way it was
   * entered rather than as the converted number.
   *
   * A break is entered as cases + loose boxes; a giveaway as boxes + loose
   * packs. All three are null on a line entered directly in stock units, and on
   * every line recorded before v25.
   *
   * On a RECONCILIATION exactly one of them is set — the product's own stock
   * unit — and that is also what says which unit `statedCasePrice` is per. See
   * `statedPriceUnit`.
   */
  enteredCases: number | null
  enteredBoxes: number | null
  enteredPacks: number | null
  location: string
  /** Cost of the exact FIFO layers this line consumed, per unit and in total. */
  unitCost: number
  costTotal: number
  /**
   * RECONCILIATION lines only: what ONE UNIT OF ENTRY was stated to have cost.
   *
   * The name is historical and the column behind it (`stream_items
   * .stated_case_price`) is deliberately unrenamed — stream_items syncs, and a
   * laptop that has not updated yet drops a column it does not recognise, which
   * would land a reconciliation with no price on it and let the removal path
   * hand back stock that never left. See statedPriceUnit for what the number
   * means on a given line.
   *
   * Null on every line that moved stock — those are valued at the layers they
   * actually took, and a second number here would be a disagreeing answer to
   * the same question.
   *
   * Its presence is what MAKES a line a reconciliation, and it changes what the
   * line is: no stock moved, no cost layer was consumed, and `costTotal` is
   * `the entered count × this` rather than the FIFO cost of anything.
   */
  statedCasePrice: number | null
  /**
   * Giveaways only. What ONE pack of this product cost, divided down from the
   * cost of the layers this line consumed. Null when a divisor is missing —
   * never a guess, because a zero here would understate the loss silently.
   */
  packCost: number | null
  /**
   * Giveaways only, POSITIVE. The value of the stock given away: packs × pack
   * cost when packs were entered, otherwise the FIFO cost of what was consumed.
   *
   * This is the P&L side and is NOT double counting against the FIFO
   * consumption: the consumption is the balance-sheet movement (stock left the
   * shelf), this is the cost of running the show. Zero on a break — a break is
   * stock opened to sell, not stock lost.
   */
  lossValue: number
  /**
   * The unit `quantity` is counted in, off the catalog row as it stands TODAY.
   *
   * Joined rather than snapshotted, and unlike `productName` that is right: this
   * is not a fact about the night, it is what the product IS, and it exists so a
   * price entered against this line afterwards can be labelled per the unit that
   * price would actually be per. Null when the catalog row has been deleted, and
   * for the products @shared/units has no case/box structure for (packs,
   * singles, other) — a form must then price the line as it stands rather than
   * name a case the product never had.
   *
   * `statedPriceUnit` answers a narrower question — which unit a RECONCILIATION
   * stated its price in — and reads it off the counts the line was typed with. A
   * live break can carry both a case count and a box count, so it cannot.
   */
  stockUnit: StockUnit | null
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
  /** Σ of the giveaway lines' `lossValue`. POSITIVE — the finance view is where
   *  it becomes a negative on the day's bottom line. */
  giveawayLoss: number
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

/**
 * A line being added to a show.
 *
 * TWO ways to say how much, and only one of them is the one operators use.
 *
 * `cases` + `boxes` (a break) or `boxes` + `packs` (a giveaway) is how the work
 * is actually described — "two cases and three boxes", "four packs to a
 * winner". Main converts those to the product's own stock unit through
 * `breakToStock` / `giveawayToStock` in @shared/units, which is also where a
 * missing boxes-per-case or packs-per-box is REFUSED rather than treated as
 * zero.
 *
 * `quantity` is the raw escape hatch: a number already in the product's stock
 * unit. It is used when no entered-unit field is supplied, which keeps every
 * pre-v25 caller working unchanged.
 */
export interface NewStreamItem {
  sessionId: string
  kind: StreamItemKind
  productId: string
  /** Already in the product's stock unit. Ignored when cases/boxes/packs are given. */
  quantity?: number
  /** Break entry: whole cases. */
  cases?: number | null
  /** Break entry: loose boxes. Giveaway entry: whole boxes. */
  boxes?: number | null
  /** Giveaway entry: loose packs. */
  packs?: number | null
  /**
   * RECONCILIATION entry: what ONE UNIT OF ENTRY cost. Accepted ONLY on a
   * past-dated session (see `isPastDatedSession`).
   *
   * WHICH unit is the product's own: a case-stocked product is counted in
   * `cases` at a price per case, a box-stocked one in `boxes` at a price per
   * box. A box-stocked product has nothing to convert — one box is one stock
   * unit — so demanding a case count of it would invent a division it does not
   * need and refuse the entry on a boxes-per-case it has no reason to carry.
   * Main refuses the field that does not match, rather than ignoring it.
   *
   * The name is the one the column has kept, for the reason given on
   * `StreamItem.statedCasePrice`. Per unit rather than a total, because the two
   * age differently: a total is silently wrong the moment the count is
   * corrected, while "what we paid for one" stays true however many are being
   * recorded.
   *
   * Typed as a number, validated as though it were not — it arrives from a text
   * field, so main parses it through `parseMoneyInput` and refuses anything
   * that is not a real, non-negative amount rather than storing a NaN.
   */
  casePrice?: number | null
  /**
   * Which cost layers this line takes its stock out of, as chosen in the picker.
   *
   * Absent means there was nothing to decide — one open layer, or several all at
   * the same unit cost — and the oldest are consumed, exactly as they always
   * were. A picker that was shown and CANCELLED never gets here: the form
   * abandons the whole add, because a line that books the oldest layer while the
   * operator believes they picked the $1,600 case is the precise failure this
   * exists to stop.
   *
   * REFUSED on a reconciliation. That line consumes no layer at all — it states
   * what a night cost, weeks after the stock left — so an allocation against it
   * would be a claim about layers it is not touching.
   */
  allocation?: LotPick[] | null
  location: string
  breakNumber?: number | null
  recipient?: string | null
  note?: string | null
}

/**
 * What a line already recorded turns out to have COST.
 *
 * The owner's ask: "give me the ability in the streaming or finance to enter the
 * price … since we might not always know in the moment." A box is broken on air,
 * the invoice is not to hand, and the line lands at zero — which the P&L now
 * prints as an uncosted row rather than hiding. This is what fills it in.
 *
 * `unitPrice` is per ONE of whatever the product is stocked in — per case for a
 * case-stocked product, per box for a box-stocked one — the same unit
 * `NewStreamItem.casePrice` is in, and the same unit `StreamItem.quantity`
 * counts. Decimals are real: 1.25 and 1.33 are prices somebody pays.
 *
 * IT CORRECTS THE RECORD, NOT THE STOCK. No FIFO layer is consumed, opened or
 * revalued and no average is re-based, whichever kind of line it lands on. See
 * `setItemCost` in db/streaming.ts for the full argument; the short form is that
 * the stock this describes has already moved, or was never going to.
 */
export interface SetStreamItemCost {
  itemId: string
  /** Per one stock unit of the product. Typed as a number, validated as though
   *  it were not — it comes off a text field and main parses it through
   *  `parseMoneyInput` rather than storing whatever `Number()` made of it. */
  unitPrice: number
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

/**
 * Is this session HISTORY — a show being RECONCILED rather than one being run?
 *
 * The owner's rule is "a date in the past", and both obvious readings of that
 * break on the way RM actually streams.
 *
 * `streamDate < today` flips at midnight — in the middle of a 9pm-to-2am show,
 * which is the one moment an operator is certainly still adding breaks to it.
 * The form would change under their hands mid-show. "It has ended" is no better
 * on its own: a show that finished ten minutes ago is over, but its stock came
 * off the shelf tonight and is costed at the layers it took, so there is nothing
 * to reconcile.
 *
 * So both, anchored on the END: a session is history once it has finished AND
 * the local day it finished on is already behind us. The mode can then only ever
 * change at a midnight with no show running and none just ended — which is what
 * stops it flickering while somebody is working.
 *
 * `streamDate` is checked as well, even though a valid session's business day
 * can never be later than the day it ended. A row written before start/end
 * validation existed could hold them the wrong way round, and for such a row the
 * conservative answer — both behind us, or it is not history — is the right one.
 */
export function isPastDatedSession(
  session: Pick<StreamSession, 'streamDate' | 'endedAt'>,
  now: Date = new Date()
): boolean {
  if (!session.endedAt) return false
  const today = streamDateOf(now.toISOString())
  const ended = streamDateOf(session.endedAt)
  if (!today || !ended) return false
  return ended < today && session.streamDate < today
}

/**
 * A money amount as a person types it → a number, or NaN when it is not one.
 *
 * Lives in the contract so the field on screen, the IPC boundary and the write
 * cannot disagree about what "2,400" means. Three deliberate refusals:
 *
 * - Blank is NaN, never 0. A reconciliation with no price is an unanswered
 *   question; zero is an answer, and it would book a case of Bowman at nothing.
 * - Only a plain decimal is accepted. `Number()` reads '0x10', '1e9' and
 *   'Infinity' quite happily, and none of those is a price anybody typed.
 * - A leading '-' parses, so the caller can refuse a negative in its own words
 *   instead of reporting a minus sign as gibberish.
 */
export function parseMoneyInput(raw: unknown): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN
  if (typeof raw !== 'string') return NaN
  const t = raw.trim().replace(/[$,\s]/g, '')
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(t)) return NaN
  return Number(t)
}

/**
 * Which unit a reconciliation line's stated price is PER.
 *
 * The price column is one number for two different units — a case-stocked
 * product is reconciled in cases at a price per case, a box-stocked one in
 * boxes at a price per box — so the row has to be able to say which, and it
 * does: a reconciliation sets exactly ONE of `enteredCases` / `enteredBoxes`,
 * the one it was counted in. That is not an extra flag invented for this; it is
 * the entry the line already carried so it could read back the way it was typed.
 *
 * Renaming or splitting the price column instead would strand every laptop that
 * has not updated: `stream_items` syncs whole rows, and the apply path keeps
 * only the columns the receiving database recognises. A row arriving with a
 * column that machine has never heard of lands with its price NULL — and a
 * reconciliation with no price is indistinguishable from a line that moved
 * stock, so removing it would put cases back on a shelf they never left.
 *
 * Defaults to 'case' for a line that says neither, which is not a guess: the
 * price column arrived at schema v40 and the entered units at v25, so every row
 * that has ever carried a stated price was counted in cases and recorded which
 * — and cases were the only thing a reconciliation could be entered in until
 * this rule changed.
 */
export function statedPriceUnit(line: Pick<StreamItem, 'enteredCases' | 'enteredBoxes'>): StockUnit {
  if (typeof line.enteredCases === 'number' && line.enteredCases > 0) return 'case'
  if (typeof line.enteredBoxes === 'number' && line.enteredBoxes > 0) return 'box'
  return 'case'
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
