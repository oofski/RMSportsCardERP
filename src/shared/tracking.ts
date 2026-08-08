/**
 * Where a package has got to, read off the carrier's own page.
 *
 * ## Why this shape, and what it honestly is
 *
 * The owner wants live status on every active purchase order and invoice, and
 * does not want another service in the middle — no aggregator, no account, no
 * key. That rules out the carriers' APIs too, because every one of them wants a
 * developer account and an OAuth dance.
 *
 * What is left is the page the Track button already opens. The desktop app
 * carries a real browser, so it can load that page, let it run, and read the
 * status out of it. Nothing is signed up for and nothing is paid for.
 *
 * BE CLEAR ABOUT WHAT THAT COSTS. Carriers change their pages, and they push
 * back on automated reads. So:
 *
 *   - A read that fails NEVER overwrites a status that worked. Stale-but-true
 *     beats fresh-and-wrong when the question is whether a customer's cards
 *     arrived.
 *   - Every status carries WHEN IT WAS READ, and the screen shows it. A status
 *     with no timestamp invites people to trust it indefinitely.
 *   - Anything unrecognised is `null`, never a guess. Reporting "delivered" for
 *     a page that actually said something else is the one outcome worth any
 *     amount of caution.
 *
 * The status vocabulary is `ShipStatusCode` from @shared/shippingTypes, already
 * used by the shipping tracker — the same seven words the owner listed. A
 * second parallel vocabulary would need translating at every boundary.
 */
import type { ShipStatusCode } from './shippingTypes'
import { SHIP_STATUS_RANK } from './shippingTypes'

/**
 * Turn what the page says into one of our seven words.
 *
 * ORDER MATTERS. "Out for delivery" contains neither "delivered" nor
 * "delivery" as a whole word by accident — but "delivered" is a substring of
 * nothing else, while a page reading "Out for Delivery" also carries the word
 * "delivery" in half a dozen navigation links. So the most specific phrases are
 * tested first and the loosest last, and each pattern is anchored on wording
 * carriers actually print rather than on a single word.
 *
 * Returns null when nothing matches, which the caller must treat as "could not
 * read" — not as "no movement".
 */
export function parseTrackingStatus(pageText: string): ShipStatusCode | null {
  const t = (pageText ?? '').toLowerCase().replace(/\s+/g, ' ')
  if (!t.trim()) return null

  // Terminal and unambiguous first.
  if (/\breturn(ed|ing)? to sender\b/.test(t)) return 'returned'
  if (/\bdelivered\b/.test(t) || /\byour item was delivered\b/.test(t)) return 'delivered'

  // "Out for delivery" must beat the generic in-transit patterns below it.
  if (/\bout for delivery\b/.test(t)) return 'out_for_delivery'

  // Trouble. Checked before in-transit because an exception page still shows
  // movement history, and the exception is the thing somebody has to act on.
  if (
    /\bdelivery exception\b/.test(t) ||
    /\bexception\b/.test(t) ||
    /\bundeliverable\b/.test(t) ||
    /\balert\b/.test(t) ||
    /\bheld at\b/.test(t) ||
    /\baction (?:needed|required)\b/.test(t)
  ) {
    return 'exception'
  }

  if (
    /\bin transit\b/.test(t) ||
    /\bon the way\b/.test(t) ||
    /\barrived at\b/.test(t) ||
    /\bdeparted\b/.test(t) ||
    /\bmoving through\b/.test(t) ||
    /\bin possession of\b/.test(t)
  ) {
    return 'in_transit'
  }

  // The label exists and nothing has happened yet. Deliberately last: these
  // phrases also appear on pages that have since moved on.
  if (
    /\bshipping label created\b/.test(t) ||
    /\blabel created\b/.test(t) ||
    /\bpre-?shipment\b/.test(t) ||
    /\border processed\b/.test(t) ||
    /\bawaiting item\b/.test(t) ||
    /\bready for (?:usps|ups|fedex)\b/.test(t)
  ) {
    return 'label_created'
  }

  // A page that loaded but says nothing we know. NOT a status.
  return null
}

/**
 * Phrases that mean the page did not actually show a package.
 *
 * Worth detecting separately from "no match": a blocked or not-found page is a
 * reason to say so plainly, and to leave the previous status alone rather than
 * looking like the package stopped moving.
 */
export function looksUnreadable(pageText: string): boolean {
  const t = (pageText ?? '').toLowerCase().replace(/\s+/g, ' ')
  if (t.trim().length < 40) return true
  return (
    /could not (?:be )?(?:locate|find)/.test(t) ||
    /no (?:record|information|results) (?:found|available)/.test(t) ||
    /not found/.test(t) ||
    /enable javascript/.test(t) ||
    /access denied/.test(t) ||
    /are you a (?:human|robot)/.test(t) ||
    /verify you are/.test(t) ||
    /unusual activity/.test(t) ||
    /captcha/.test(t)
  )
}

/**
 * Should a newly read status replace the one on file?
 *
 * Forward only, on the same rank the shipping tracker already uses. A carrier
 * page briefly showing an earlier scan — they do, when a facility posts late —
 * must not walk a delivered package back to in-transit, because somebody is
 * using that word to decide whether to open a claim.
 *
 * Equal rank still writes: it refreshes the timestamp without changing the
 * claim, which is how "checked just now, still in transit" is recorded.
 */
export function shouldAdvance(
  current: ShipStatusCode | null,
  next: ShipStatusCode | null
): boolean {
  if (!next) return false
  if (!current) return true
  return SHIP_STATUS_RANK[next] >= SHIP_STATUS_RANK[current]
}

/**
 * Is this order still worth asking about?
 *
 * Delivered and returned are the end of the story — polling them forever would
 * spend every hour re-reading pages that cannot change, and carriers notice
 * that long before they notice fifteen real lookups. An order with no tracking
 * number is not askable at all.
 */
export function isTrackable(
  trackingNumber: string | null | undefined,
  status: ShipStatusCode | null
): boolean {
  if (!(trackingNumber ?? '').trim()) return false
  return status !== 'delivered' && status !== 'returned'
}

/** How long a reading stays fresh before the poller asks again. */
export const TRACKING_INTERVAL_MS = 60 * 60 * 1000

export function isStale(checkedAt: string | null | undefined, nowMs: number): boolean {
  if (!checkedAt) return true
  const t = Date.parse(checkedAt)
  if (!Number.isFinite(t)) return true
  return nowMs - t >= TRACKING_INTERVAL_MS
}

/**
 * The orders an hourly sweep should actually fetch.
 *
 * Pure, so the scheduling rule is testable without a browser, a clock or a
 * network. Everything that makes the decision is an argument.
 */
export interface TrackableOrder {
  id: string
  trackingNumber: string | null
  status: ShipStatusCode | null
  checkedAt: string | null
}

export function dueForCheck<T extends TrackableOrder>(
  orders: T[],
  nowMs: number,
  /** A forced check ignores freshness but still skips finished packages. */
  force = false
): T[] {
  return orders.filter(
    (o) => isTrackable(o.trackingNumber, o.status) && (force || isStale(o.checkedAt, nowMs))
  )
}

// ---------------------------------------------------------------------------
// How it reads on screen
// ---------------------------------------------------------------------------

export const TRACKING_LABELS: Record<ShipStatusCode, string> = {
  not_shipped: 'Not shipped',
  label_created: 'Label created',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  exception: 'Exception',
  returned: 'Returned'
}

/** Tone for the status pill: green when it arrived, amber when it needs a look. */
export function trackingTone(status: ShipStatusCode | null): 'ok' | 'warn' | 'live' | 'idle' {
  if (status === 'delivered') return 'ok'
  if (status === 'exception' || status === 'returned') return 'warn'
  if (status === 'in_transit' || status === 'out_for_delivery') return 'live'
  return 'idle'
}

/**
 * "In transit · checked 12 min ago", or why there is nothing to show.
 *
 * The age is part of the status rather than a tooltip on it: a reading with no
 * age invites somebody to trust a page that was last read on Tuesday.
 */
export function trackingSummary(
  status: ShipStatusCode | null,
  checkedAt: string | null,
  nowMs: number
): string {
  const label = status ? TRACKING_LABELS[status] : 'Not checked yet'
  if (!checkedAt) return label
  const ms = nowMs - Date.parse(checkedAt)
  if (!Number.isFinite(ms) || ms < 0) return label
  return `${label} · checked ${humanAge(ms)}`
}

export function humanAge(ms: number): string {
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** Anything unrecognised reads as "not known", never as a guessed status. */
export function asShipStatus(v: unknown): ShipStatusCode | null {
  return typeof v === 'string' && v in TRACKING_LABELS ? (v as ShipStatusCode) : null
}
