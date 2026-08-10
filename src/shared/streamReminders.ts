/**
 * Scheduled streams, and the reminders that go out before them.
 *
 * ## Why this file exists at all
 *
 * Every other notification in this app is REACTIVE: somebody punches, a row
 * syncs, the relay reacts. A reminder is the opposite — it has to fire when
 * NOTHING has happened, at a moment nobody triggered. That is a Cloudflare Cron
 * Trigger calling `scheduled()` in cloud/worker.js, and a cron that re-examines
 * the same stream every few minutes will happily send the same reminder every
 * few minutes. A notification people mute is worse than no notification at all,
 * so the rules that decide WHICH reminder is due, and whether it has already
 * gone, live here — in one file, with no database and no network in it, so they
 * can actually be tested.
 *
 * cloud/worker.js carries a hand-copied mirror of the same rules, because that
 * file is PASTED into a dashboard and cannot import anything. tests/streamReminders
 * .test.ts runs the same table of cases through both copies and fails if they
 * ever disagree; that test is the only thing keeping the duplication honest.
 *
 * ## WALL CLOCK vs INSTANT — read this before changing anything here
 *
 * A scheduled stream is an INTENTION: "we go live at 9:00 PM on Friday." That is
 * a local calendar day plus a local HH:MM, exactly like a shift in
 * @shared/schedule, and it stays 9:00 PM across a daylight-saving boundary.
 *
 * "One hour before" is not an intention. It is an INSTANT — a physical moment
 * the Worker has to compare its own clock against.
 *
 * The conversion between the two happens EXACTLY ONCE, on the machine that
 * schedules the stream, where "9:00 PM" has an unambiguous meaning because the
 * operating system knows what zone that machine is in. The resulting instant is
 * stored beside the wall clock as `startsAt`, and it is the ONLY field the
 * relay ever reads.
 *
 * The relay must never redo that conversion. A Cloudflare Worker runs in UTC and
 * has no idea what timezone RM is in, so turning "21:00" into an instant there
 * would put every reminder out by the local UTC offset — four or five hours in
 * this business. And the symptom would be "the notifications are broken",
 * because nothing anywhere would name a date conversion.
 */

import { effectivePermissions, sanitizePermissions, type Role } from './permissions'

// ---------------------------------------------------------------------------
// The shape of a planned show
// ---------------------------------------------------------------------------

/**
 * 'planned'   — nobody has done anything to it yet. The only status that gets
 *               reminded about.
 * 'started'   — the show it was a plan for is on air; the record of the night is
 *               a `stream_sessions` row now, and this row is history.
 * 'cancelled' — called off. Kept rather than deleted so "we cancelled Friday" is
 *               still answerable next week; a delete works too and the relay
 *               stops seeing the row either way.
 */
export type ScheduledStreamStatus = 'planned' | 'started' | 'cancelled'

export interface ScheduledStream {
  id: string
  title: string
  /** The INTENTION, half one: local calendar day, YYYY-MM-DD. */
  streamDate: string
  /** The INTENTION, half two: local HH:MM, 24-hour. */
  startTime: string
  /**
   * The same moment as a UTC ISO instant, derived from the two fields above on
   * the machine that scheduled it. Everything that does arithmetic on time —
   * "one hour before", "has it started yet" — uses this and never the pair.
   */
  startsAt: string
  /** An employee id, or null. Resolved for display in `hostName`. */
  hostId: string | null
  hostName: string | null
  note: string | null
  status: ScheduledStreamStatus
  /** The `stream_sessions` row this plan became, once somebody started it. */
  sessionId: string | null
  createdAt: string
  updatedAt: string
  createdBy: string | null
}

export interface NewScheduledStream {
  title: string
  streamDate: string
  startTime: string
  /**
   * Computed by the CLIENT, never by main.
   *
   * Main runs on the laptop in Electron but on a server in the web build, and a
   * server in another zone would resolve "9:00 PM" to the wrong instant for the
   * person typing it. The browser is the only party that knows what the operator
   * meant, so it does the conversion and sends the answer. Main checks the
   * result is a plausible one (see `impliedZoneOffsetMinutes`) rather than
   * recomputing it from a zone it cannot see.
   */
  startsAt: string
  hostId: string | null
  note: string | null
}

export const SCHEDULED_TITLE_MAX = 80
export const SCHEDULED_NOTE_MAX = 200

// ---------------------------------------------------------------------------
// Wall clock ↔ instant
// ---------------------------------------------------------------------------

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_RE = /^(\d{2}):(\d{2})$/

export function isValidDayKey(day: unknown): boolean {
  const m = DAY_RE.exec(String(day ?? ''))
  if (!m) return false
  const month = Number(m[2])
  const date = Number(m[3])
  return month >= 1 && month <= 12 && date >= 1 && date <= 31
}

export function isValidLocalTime(time: unknown): boolean {
  const m = TIME_RE.exec(String(time ?? ''))
  if (!m) return false
  return Number(m[1]) <= 23 && Number(m[2]) <= 59
}

/**
 * How far the supplied instant sits from reading the wall clock as if it were
 * UTC — which is to say, the UTC offset the client must have been in.
 *
 * This is the only check main can make on a conversion it did not perform and
 * cannot repeat. It does not prove the instant is RIGHT: 0 is a perfectly real
 * offset, so an instant produced by parsing "2026-08-21T21:00" as UTC passes
 * this in London and is caught nowhere. What it does catch is the instant that
 * is not a conversion of this pair at all — a stale value left in a form, a
 * client sending the wrong field, a row that got its date edited and its instant
 * not. Those land as an offset of days, and a reminder computed from one would
 * fire at a time with no relationship to the show.
 *
 * Returns null when either half is malformed or the gap is not a real zone
 * offset. Real zones span UTC-12:00 to UTC+14:00; nothing outside that is a
 * timezone, it is a mistake.
 *
 * The SIGN follows `Date.prototype.getTimezoneOffset`, which is the convention
 * every other piece of date code in this project is written against: minutes to
 * ADD to local to get UTC. New York in summer is +240; Kathmandu is -345. A
 * function that quietly used the other sign would be right about the range and
 * wrong about every comparison anybody later wrote against it.
 */
export function impliedZoneOffsetMinutes(
  streamDate: string,
  startTime: string,
  startsAt: string
): number | null {
  if (!isValidDayKey(streamDate) || !isValidLocalTime(startTime)) return null
  const instant = Date.parse(startsAt)
  if (Number.isNaN(instant)) return null
  const asIfUtc = Date.parse(`${streamDate}T${startTime}:00.000Z`)
  if (Number.isNaN(asIfUtc)) return null
  const minutes = (instant - asIfUtc) / 60_000
  if (!Number.isInteger(minutes)) return null
  if (minutes < -14 * 60 || minutes > 12 * 60) return null
  return minutes
}

// ---------------------------------------------------------------------------
// When a reminder is due
// ---------------------------------------------------------------------------

/**
 * The owner asked for two: an hour out, and a quarter of an hour out.
 *
 * Ordered longest-first because that is the order they fire in, and because the
 * dedupe key includes the lead — so if this list ever grows, an added lead only
 * ever adds reminders and can never renumber the ones already sent.
 */
export const REMINDER_LEADS: readonly number[] = [60, 15]

/**
 * How often the cron trigger fires, in minutes.
 *
 * The matching cron expression is a five-minute step in the minute field; it is
 * written out in full in docs/CLOUDFLARE.md rather than here, because a step
 * expression contains the two characters that END a block comment and this file
 * has been broken by less. (See the backtick note in CLAUDE.md for the local
 * precedent.)
 *
 * THE TRADE-OFF, written down because the number is otherwise arbitrary:
 *
 * A cron cannot land exactly on T-60 or T-15, so a reminder is always a little
 * late and never early. With N=5 the hour reminder arrives somewhere in
 * T-60..T-55 and the quarter-hour one in T-15..T-10, both of which read as the
 * thing the owner asked for.
 *
 * N=1 would be exact to the minute and costs 1,440 cron invocations and 1,440
 * D1 queries a day to serve a handful of shows a week — paid for continuously,
 * to sharpen a reminder nobody is timing with a stopwatch.
 *
 * N=15 is the other end and is genuinely broken: the "fifteen minutes before"
 * reminder could land at T-1, by which point it is not a reminder, it is an
 * accusation.
 *
 * Five is the largest N that keeps the short reminder useful.
 */
export const REMINDER_CRON_MINUTES = 5

/**
 * How long after its nominal moment a reminder may still go out.
 *
 * Ten minutes: two cron ticks, so a single missed or failed invocation still
 * delivers. Past that the reminder is SUPPRESSED rather than sent late, because
 * an hour-before reminder arriving twenty minutes late is a false statement
 * about when the show starts — and the short reminder is still coming, on time,
 * to say the true thing.
 *
 * This is also what stops a relay that was asleep for an hour waking up and
 * firing a flurry of stale reminders at everybody at once.
 */
export const REMINDER_WINDOW_MINUTES = 10

/**
 * Is the reminder `lead` minutes before `startsAtMs` due at `nowMs`?
 *
 * The window is half-open: `[start - lead, start - lead + window)`. Half-open
 * because a closed one at both ends double-counts the boundary tick, and with a
 * cron that lands on exact multiples of five minutes that boundary is hit
 * constantly.
 *
 * The final clause — never once the show has started — is redundant today
 * (the shortest lead is 15 and the window is 10, so every window closes at least
 * five minutes before the start) and is here anyway. It is the actual rule the
 * owner cares about, and it stays true if somebody later adds a five-minute
 * lead and does not think about the window.
 */
export function reminderDue(nowMs: number, startsAtMs: number, lead: number): boolean {
  if (!Number.isFinite(nowMs) || !Number.isFinite(startsAtMs)) return false
  const dueAt = startsAtMs - lead * 60_000
  if (nowMs < dueAt) return false
  if (nowMs >= dueAt + REMINDER_WINDOW_MINUTES * 60_000) return false
  return nowMs < startsAtMs
}

/**
 * The key a sent reminder is recorded under, and the whole of the once-only
 * guarantee.
 *
 * THE START INSTANT IS PART OF THE KEY, deliberately. Keying on the plan and the
 * lead alone would mean a show moved from 9pm to 11pm never reminds again — the
 * row already has a "60 minutes before" against it, for a time that is no longer
 * true. Including the instant makes a rescheduled show a different reminder,
 * which is what it is, while a row that merely re-syncs (the common case: ten
 * laptops pulling the same edit) produces the identical key and is refused.
 *
 * The cost is paid honestly: nudging a start by one minute does re-arm both
 * reminders. Somebody who moves a show twice inside the hour before it gets two
 * buzzes. That is the right way round — the alternative is a show that moved and
 * a room that was never told.
 */
export function reminderKey(scheduleId: string, startsAt: string, lead: number): string {
  return `${scheduleId}|${startsAt}|${lead}`
}

/** The narrow row shape the relay reads out of its synced copy of the table. */
export interface ReminderCandidate {
  id: string
  title: string
  startsAt: string
  hostId: string | null
  status: string
}

export interface DueReminder {
  scheduleId: string
  title: string
  startsAt: string
  hostId: string | null
  lead: number
  key: string
}

/**
 * Which reminders are due right now, across every planned show the relay can
 * see.
 *
 * Four refusals, and each one is a way this feature could become the thing
 * everybody mutes:
 *
 *  · not 'planned' — a cancelled show must not be reminded about, and a show
 *    somebody already started must not be reminded about either. Both are
 *    status changes that reach the relay as ordinary synced rows.
 *  · an unparseable instant — never guess at a time; a reminder at a made-up
 *    moment is worse than a missing one.
 *  · outside the window — see `reminderDue`. Covers "already started" and
 *    "the cron has been down and is catching up" in one rule.
 *  · already sent — NOT decided here. This function is pure and cannot know;
 *    the caller claims each `key` in D1 before sending, which is what makes the
 *    guarantee hold even when two cron invocations overlap.
 *
 * Sorted by start time so a relay under a subrequest budget spends it on the
 * show that is closest to going live.
 */
export function dueReminders(rows: ReminderCandidate[], nowMs: number): DueReminder[] {
  const out: DueReminder[] = []
  for (const row of rows || []) {
    if (!row || String(row.status) !== 'planned') continue
    const startsAtMs = Date.parse(String(row.startsAt))
    if (Number.isNaN(startsAtMs)) continue
    for (const lead of REMINDER_LEADS) {
      if (!reminderDue(nowMs, startsAtMs, lead)) continue
      out.push({
        scheduleId: String(row.id),
        title: String(row.title || ''),
        startsAt: String(row.startsAt),
        hostId: row.hostId ? String(row.hostId) : null,
        lead,
        key: reminderKey(String(row.id), String(row.startsAt), lead)
      })
    }
  }
  out.sort((a, b) => (a.startsAt === b.startsAt ? b.lead - a.lead : a.startsAt < b.startsAt ? -1 : 1))
  return out
}

/**
 * How far ahead the relay has to look, in minutes.
 *
 * The longest lead plus the window: past that, no reminder for the show can be
 * due yet, and the query has no reason to carry the row. Everything nearer than
 * `now` is already started and is excluded by `reminderDue` regardless.
 */
export function reminderLookaheadMinutes(): number {
  return Math.max(...REMINDER_LEADS) + REMINDER_WINDOW_MINUTES
}

// ---------------------------------------------------------------------------
// Who hears about it
// ---------------------------------------------------------------------------

/**
 * Does this employee row have admin access?
 *
 * "Every admin" is the permission the app already gates its admin screens on,
 * not a new list somebody has to maintain in two places. Role grants first,
 * then the individual overrides on top — `permissions_json` is additive by
 * construction (see effectivePermissions), so a packer who was granted
 * admin.access by hand counts, which is the whole point of the override.
 *
 * cloud/worker.js has to answer this same question about the same synced rows
 * and cannot import this file. Its copy hard-codes the roles rather than the
 * permission table; the parity test walks every role in @shared/permissions
 * through both and fails the moment a role's admin access changes here and not
 * there.
 */
export function grantsAdminAccess(role: unknown, permissionsJson: unknown): boolean {
  let overrides: unknown = []
  if (typeof permissionsJson === 'string' && permissionsJson.trim()) {
    try {
      overrides = JSON.parse(permissionsJson)
    } catch {
      // A permissions blob that will not parse is not a grant. Falling back to
      // the role alone is the conservative reading and matches what the app
      // does with the same column.
      overrides = []
    }
  } else if (Array.isArray(permissionsJson)) {
    overrides = permissionsJson
  }
  return effectivePermissions(String(role ?? '') as Role, sanitizePermissions(overrides)).includes(
    'admin.access'
  )
}

/**
 * Every admin, plus the host if the host is not one of them.
 *
 * A Set, because the host usually IS an admin in this business and sending them
 * two notifications for one show is the fastest way to teach somebody that this
 * app buzzes twice for everything.
 *
 * Note what this returns: PEOPLE, not devices. A subscription is per device, so
 * one person with a phone and an iPad hears about it twice — correctly, once on
 * each thing they carry. The device fan-out happens against push_subscriptions
 * in the relay; it has no business being decided here.
 */
export function reminderRecipients(adminIds: string[], hostId: string | null): string[] {
  const set = new Set<string>()
  for (const id of adminIds || []) {
    const clean = String(id || '').trim()
    if (clean) set.add(clean)
  }
  const host = String(hostId || '').trim()
  if (host) set.add(host)
  return [...set]
}

// ---------------------------------------------------------------------------
// What the phone is told
// ---------------------------------------------------------------------------

export interface StreamReminderPayload {
  v: 1
  kind: 'stream'
  /**
   * The plan's id, carried so the phone can tag both reminders for one show
   * alike and have the second REPLACE the first. Tagging by title instead would
   * collide two different shows called "Monday Night Rip" into one notification.
   */
  id: string
  /** The show's name, already trimmed to something a lock screen can hold. */
  title: string
  /** The planned start, as a UTC ISO INSTANT. The phone formats it, not us. */
  at: string
  /** 60 or 15 — which reminder this is. Used for the wording, not the timing. */
  lead: number
}

/**
 * What travels to the phone.
 *
 * `at` is the start INSTANT and is passed through untouched, for the same reason
 * the clock notifications pass a punch through untouched: the relay has no idea
 * what timezone the person holding the phone is in and the phone knows exactly.
 * A wall-clock time computed on a guess is a wrong time on a lock screen, and
 * here it would be a wrong time for the show somebody is being told to start.
 *
 * The service worker computes "in 12 minutes" from `at` against the phone's own
 * clock at the moment it draws the notification, rather than trusting `lead`.
 * That matters: a reminder can sit in a push service's queue for minutes, and
 * "in 15 minutes" drawn ten minutes later is a lie the phone is in a position to
 * avoid telling. `lead` is carried anyway so the two reminders can be told apart
 * in a log and so the wording can be gentler for the hour one.
 *
 * The title is in the payload rather than looked up by the phone, because the
 * payload is encrypted for that device and the notification has to draw while
 * the device is asleep and the app is not running.
 */
export function buildStreamReminderPayload(input: {
  scheduleId: string
  title: string
  startsAt: string
  lead: number
}): StreamReminderPayload {
  const title = String(input?.title || '').trim() || 'Stream'
  return {
    v: 1,
    kind: 'stream',
    id: String(input?.scheduleId || ''),
    title: title.slice(0, SCHEDULED_TITLE_MAX),
    at: String(input?.startsAt || ''),
    lead: Number(input?.lead) || 0
  }
}
