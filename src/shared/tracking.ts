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
 * What each carrier actually prints, in its own words.
 *
 * The three of them describe the same journey with different vocabulary, and a
 * single generic pattern set gets the edges wrong. FedEx says "On the way" and
 * "Shipment information sent to FedEx"; UPS says "Shipment Ready for UPS" and
 * "Out For Delivery Today"; USPS says "Moving Through Network" and puts a bare
 * "Alert" above a problem. None of those match the others' wording.
 *
 * Checked BEFORE the generic list, so a carrier's own phrasing always wins over
 * a loose match. Order within each list matters for the same reason it does
 * below: the most specific phrase first.
 */
const CARRIER_PHRASES: Record<string, Array<[RegExp, ShipStatusCode]>> = {
  fedex: [
    [/\breturn(?:ed|ing)? to (?:sender|shipper)\b/, 'returned'],
    [/\bdelivered\b/, 'delivered'],
    [/\bon fedex vehicle for delivery\b/, 'out_for_delivery'],
    [/\bout for delivery\b/, 'out_for_delivery'],
    [/\bdelivery exception\b/, 'exception'],
    [/\bwe(?:'| a)?re holding\b/, 'exception'],
    [/\bshipment exception\b/, 'exception'],
    [/\bon the way\b/, 'in_transit'],
    [/\bin transit\b/, 'in_transit'],
    [/\b(?:arrived at|departed) fedex\b/, 'in_transit'],
    [/\bat local fedex facility\b/, 'in_transit'],
    [/\bpicked up\b/, 'in_transit'],
    // FedEx's wording for "we know about it, we do not have it yet".
    [/\bshipment information sent to fedex\b/, 'label_created'],
    [/\blabel created\b/, 'label_created'],
    [/\border processed\b/, 'label_created']
  ],
  ups: [
    [/\breturn(?:ed|ing)? to sender\b/, 'returned'],
    [/\bdelivered\b/, 'delivered'],
    [/\bout for delivery(?: today)?\b/, 'out_for_delivery'],
    [/\bexception\b/, 'exception'],
    [/\baction (?:needed|required)\b/, 'exception'],
    [/\bin transit\b/, 'in_transit'],
    [/\bon the way\b/, 'in_transit'],
    [/\b(?:arrived at|departed from) facility\b/, 'in_transit'],
    [/\borigin scan\b/, 'in_transit'],
    // UPS's two ways of saying the label exists and the parcel does not.
    [/\bshipment ready for ups\b/, 'label_created'],
    [/\blabel created\b/, 'label_created'],
    [/\border processed[:,]? ready for ups\b/, 'label_created']
  ],
  usps: [
    [/\breturn to sender\b/, 'returned'],
    [/\bdelivered\b/, 'delivered'],
    [/\bout for delivery\b/, 'out_for_delivery'],
    // USPS heads a problem with a bare "Alert", so it is matched at the START
    // of a line only — the word turns up in cookie banners otherwise.
    [/^alert\b/, 'exception'],
    [/\bdelivery exception\b/, 'exception'],
    [/\baction needed\b/, 'exception'],
    [/\bin transit(?: to next facility)?\b/, 'in_transit'],
    [/\bmoving through network\b/, 'in_transit'],
    [/\barrived at (?:usps|post office|facility)\b/, 'in_transit'],
    [/\bdeparted (?:usps|post office)\b/, 'in_transit'],
    [/\baccepted at\b/, 'in_transit'],
    [/\bshipping label created,? usps awaiting item\b/, 'label_created'],
    [/\bpre-?shipment\b/, 'label_created'],
    [/\blabel created\b/, 'label_created']
  ],
  /**
   * DHL EXPRESS, whose wording is its own.
   *
   * "With delivery courier" is the phrase that matters and it is nobody else's
   * — GENERIC_PHRASES has no rule for it, so without this list a package out on
   * a van would read as unreadable and the board would go on showing yesterday.
   *
   * "Shipment picked up" and "Clearance processing" are the other two DHL says
   * that the generic list does not. Everything else it prints — delivered, in
   * transit — the fallback already handles, and repeating those here would be a
   * second copy to keep in step.
   */
  dhl: [
    [/\breturn(?:ed|ing)? to shipper\b/, 'returned'],
    [/\bdelivered\b/, 'delivered'],
    [/\bwith delivery courier\b/, 'out_for_delivery'],
    [/\bout for delivery\b/, 'out_for_delivery'],
    [/\bdelivery attempted\b/, 'exception'],
    [/\bcustoms status updated\b/, 'exception'],
    [/\bshipment on hold\b/, 'exception'],
    [/\bclearance (?:event|processing|delay)\b/, 'in_transit'],
    [/\bprocessed at\b/, 'in_transit'],
    [/\bdeparted facility\b/, 'in_transit'],
    [/\barrived at (?:dhl|sort|delivery) facility\b/, 'in_transit'],
    [/\bshipment picked up\b/, 'in_transit'],
    [/\bin transit\b/, 'in_transit'],
    // DHL's wording for "we have been told about it and do not have it".
    [/\bshipment information received\b/, 'label_created'],
    [/\belectronic shipment details? (?:sent|received)\b/, 'label_created'],
    [/\blabel created\b/, 'label_created']
  ]
}

/** Wording common to every carrier, and the fallback when none is known. */
const GENERIC_PHRASES: Array<[RegExp, ShipStatusCode]> = [
  [/\breturn(?:ed|ing)? to (?:sender|shipper)\b/, 'returned'],
  [/\bdelivered\b/, 'delivered'],
  [/\bout for delivery\b/, 'out_for_delivery'],
  [/\bdelivery exception\b/, 'exception'],
  [/\bundeliverable\b/, 'exception'],
  [/\bexception\b/, 'exception'],
  [/\bheld at\b/, 'exception'],
  [/\baction (?:needed|required)\b/, 'exception'],
  [/^alert\b/, 'exception'],
  [/\bin transit\b/, 'in_transit'],
  [/\bon the way\b/, 'in_transit'],
  [/\barrived at\b/, 'in_transit'],
  [/\bdeparted\b/, 'in_transit'],
  [/\bmoving through\b/, 'in_transit'],
  [/\bin possession of\b/, 'in_transit'],
  [/\bshipping label created\b/, 'label_created'],
  [/\bshipment information sent\b/, 'label_created'],
  [/\bshipment ready for\b/, 'label_created'],
  [/\blabel created\b/, 'label_created'],
  [/\bpre-?shipment\b/, 'label_created'],
  [/\border processed\b/, 'label_created'],
  [/\bawaiting item\b/, 'label_created']
]

/**
 * Flatten the typography carriers actually publish.
 *
 * They set their copy with real punctuation — "We\u2019re holding your package"
 * carries a curly apostrophe, not the ASCII one a pattern is written with, and
 * a non-breaking space between words looks identical on screen and matches
 * nothing. Both silently turned a real status into "could not read". Normalised
 * once here so every pattern below can be written the obvious way.
 */
function normalize(line: string): string {
  return (line ?? '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** One line's worth of meaning, carrier's own vocabulary first. */
export function statusFromLine(line: string, carrier?: string | null): ShipStatusCode | null {
  const t = normalize(line)
  if (!t) return null
  const lists = carrier && CARRIER_PHRASES[carrier] ? [CARRIER_PHRASES[carrier]] : []
  lists.push(GENERIC_PHRASES)
  for (const list of lists) {
    for (const [re, status] of list) {
      if (re.test(t)) return status
    }
  }
  return null
}

/**
 * Turn what the page says into one of our seven words.
 *
 * LINE BY LINE, FROM THE TOP — not one match against the whole blob. All three
 * carriers put the current status at the top of the page and the history,
 * navigation and marketing below it, so the first line that means anything is
 * the current state. Matching the whole page at once let a phrase from a footer
 * or a "Delivery Manager" advert decide the status of a real package.
 *
 * Within a line the most specific phrase wins, which is what keeps "Out for
 * delivery" from reading as "delivered" — they share a word and mean opposite
 * things to whoever is waiting for the box.
 *
 * Returns null when nothing matches, which the caller must treat as "could not
 * read" — never as "no movement".
 */
export function parseTrackingStatus(
  pageText: string,
  carrier?: string | null
): ShipStatusCode | null {
  const raw = pageText ?? ''
  if (!raw.trim()) return null

  for (const line of raw.split('\n')) {
    const hit = statusFromLine(line, carrier)
    if (hit) return hit
  }

  // Nothing line-by-line. Try the page as one string, for a layout that runs
  // the status into a single unbroken block.
  return statusFromLine(raw.replace(/\n/g, ' '), carrier)
}

/**
 * Phrases that mean the page did not actually show a package.
 *
 * Worth detecting separately from "no match": a blocked or not-found page is a
 * reason to say so plainly, and to leave the previous status alone rather than
 * looking like the package stopped moving.
 */
export function looksUnreadable(pageText: string): boolean {
  const t = normalize(pageText)
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
  nowMs: number,
  /** Set when the LAST attempt failed, even if an older reading succeeded. */
  error?: string | null,
  attemptedAt?: string | null,
  /** False on a client that cannot read carrier pages at all — see the note
   *  at the bottom of this function. Undefined means "do not know yet". */
  canRead?: boolean | null
): string {
  const label = status ? TRACKING_LABELS[status] : null

  // A status we actually have, whether or not the newest attempt failed. Said
  // first because it is the useful fact; the failure is appended as a caveat
  // rather than replacing it.
  if (label && checkedAt) {
    const age = ageOf(checkedAt, nowMs)
    const base = age ? `${label} · checked ${age}` : label
    // A stale reading with a failing check behind it must SAY so — otherwise
    // the age quietly stops advancing and nobody notices for a week.
    return error ? `${base} · check failing` : base
  }
  if (label) return label

  // Nothing has ever been read. Distinguish "not tried" from "tried and could
  // not": one is waiting, the other is broken, and they need different people.
  if (error) {
    const age = ageOf(attemptedAt ?? null, nowMs)
    return age ? `Could not read the carrier page · tried ${age}` : 'Could not read the carrier page'
  }
  // On a client that cannot read — the web app has no browser window to read
  // WITH — "Not checked yet" is a lie of implication: it reads as "press
  // something", and nothing anybody presses in a browser will help. Say where
  // the checking happens instead.
  return canRead === false ? 'Checked on the desktop app' : 'Not checked yet'
}

function ageOf(iso: string | null, nowMs: number): string | null {
  if (!iso) return null
  const ms = nowMs - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return null
  return humanAge(ms)
}

/**
 * The tone for a line that has never produced a reading.
 *
 * A failing check is amber, not grey: it is a thing somebody has to look at,
 * and rendering it the same as "not checked yet" is how a broken feature sits
 * unnoticed behind a quiet-looking card.
 */
export function trackingLineTone(
  status: ShipStatusCode | null,
  error: string | null | undefined
): 'ok' | 'warn' | 'live' | 'idle' {
  if (!status && error) return 'warn'
  return trackingTone(status)
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
