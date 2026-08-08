/**
 * How a thing travels, and when it gets paid for.
 *
 * Shared by BOTH sides of the money — a purchase order and an invoice each ship
 * a box and each settle at some point — because they are the same four facts
 * and two copies would drift the first time a carrier was added.
 *
 * ## On "live tracking"
 *
 * The owner asked for live status on ten to fifteen packages a day, and
 * suggested "a query search or something". That instinct is right, and it is
 * worth being explicit about why it is the whole feature rather than a
 * stopgap:
 *
 * REAL status — "left Memphis 4:02am, out for delivery" — comes from the
 * carriers' own APIs. Each of FedEx, UPS and USPS wants a developer account,
 * its own OAuth dance, its own credentials on every machine that syncs, and its
 * own rate limits and outage modes. Three integrations, three sets of secrets
 * in a PUBLIC repository's build, and three things to fix at 11pm when a
 * carrier rotates an endpoint — to save a click on fifteen packages.
 *
 * So this stores the three facts that matter (carrier, service, number),
 * DETECTS the carrier from the number so nobody has to pick it, and opens the
 * carrier's own tracking page — which is live, authoritative, and always
 * current, because it is theirs. The status lives one click away instead of
 * being copied into a database that can be wrong.
 *
 * If per-package status inside the app ever earns its keep, it goes behind this
 * same shape: `carrier` and `trackingNumber` are already the only two inputs an
 * API integration would need.
 */

export type Carrier = 'fedex' | 'ups' | 'usps'

export interface CarrierDef {
  id: Carrier
  label: string
  /** Services this carrier actually sells, in the order they get chosen. */
  services: string[]
}

/**
 * The three carriers this business uses, and the services worth naming.
 *
 * Deliberately short. A dropdown listing every service each carrier publishes
 * is a dropdown somebody has to read; these are the ones that get used, and the
 * field accepts anything typed if a fourth is ever needed.
 */
export const CARRIERS: CarrierDef[] = [
  {
    id: 'fedex',
    label: 'FedEx',
    services: ['Ground', 'Home Delivery', '2Day', 'Standard Overnight', 'Priority Overnight']
  },
  {
    id: 'ups',
    label: 'UPS',
    services: ['Ground', '3 Day Select', '2nd Day Air', 'Next Day Air', 'Next Day Air Saver']
  },
  {
    id: 'usps',
    label: 'USPS',
    services: ['Ground Advantage', 'Priority Mail', 'Priority Mail Express', 'First-Class']
  }
]

/** The services somebody asked for, offered whatever the carrier. */
export const COMMON_SERVICES = ['Ground', 'Next Day Air', '2nd Day Air']

export function carrierLabel(id: string | null | undefined): string {
  return CARRIERS.find((c) => c.id === id)?.label ?? ''
}

export function servicesFor(carrier: string | null | undefined): string[] {
  return CARRIERS.find((c) => c.id === carrier)?.services ?? COMMON_SERVICES
}

/**
 * Work out the carrier from the tracking number.
 *
 * Worth doing because the number is the thing somebody has — pasted out of an
 * email — and the carrier is a fact ABOUT it, not a second thing to remember.
 * Getting it wrong costs nothing (the field stays editable and the link is one
 * click), so the patterns are the well-known ones and anything ambiguous
 * returns null rather than guessing.
 *
 *   UPS   1Z + 16 alphanumerics. Unmistakable.
 *   FedEx 12 digits, or 15 (Ground/SmartPost), or 20.
 *   USPS  20 or 22 digits, and 22 is theirs alone. A bare 20-digit number is
 *         ambiguous with FedEx SmartPost, so it is left for a human.
 */
export function detectCarrier(tracking: string): Carrier | null {
  const t = (tracking ?? '').replace(/[\s-]/g, '').toUpperCase()
  if (!t) return null
  if (/^1Z[0-9A-Z]{16}$/.test(t)) return 'ups'
  // USPS numbers starting 94/93/92/95 are theirs regardless of length.
  if (/^(94|93|92|95)\d{18,20}$/.test(t)) return 'usps'
  if (/^\d{22}$/.test(t)) return 'usps'
  if (/^\d{12}$/.test(t) || /^\d{15}$/.test(t)) return 'fedex'
  // 20 digits is FedEx SmartPost AND a USPS format. Ambiguous, so say nothing.
  return null
}

/**
 * Where to send a browser to see where the package is.
 *
 * Returns null rather than a guessed URL when the carrier is unknown — a link
 * to the wrong carrier's "not found" page is worse than no link, because it
 * reads as "the package does not exist".
 */
export function trackingUrl(carrier: string | null | undefined, tracking: string): string | null {
  const t = (tracking ?? '').trim()
  if (!t) return null
  const id = carrier || detectCarrier(t)
  const n = encodeURIComponent(t)
  // Locale and country are pinned on purpose. Left off, these sites guess from
  // the browser and can answer in another language or bounce through a country
  // chooser — which is fine for a person clicking Track, and fatal for a reader
  // matching English phrases.
  switch (id) {
    case 'fedex':
      return `https://www.fedex.com/fedextrack/?trknbr=${n}&locale=en_US&cntry_code=us`
    case 'ups':
      return `https://www.ups.com/track?loc=en_US&requester=ST&tracknum=${n}`
    case 'usps':
      return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`
    default:
      return null
  }
}

/** Loose sanity check. Deliberately permissive — a refused real number is worse
 *  than an accepted typo, which the tracking page will report anyway. */
export function looksLikeTracking(tracking: string): boolean {
  const t = (tracking ?? '').replace(/[\s-]/g, '')
  return t.length >= 8 && /^[0-9A-Za-z]+$/.test(t)
}

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

/**
 * When the money changes hands.
 *
 * Two states plus "not said". The owner asked for two checkboxes — Front or
 * Upon Delivery — and they are a CHOICE rather than two independent flags:
 * a thing paid up front is not also paid on delivery. So ticking one clears
 * the other, and ticking the ticked one clears both, which is how a pair of
 * boxes has to behave when only one can be true.
 *
 * Null is a real third state and stays distinct: plenty of orders are placed
 * before anybody has decided, and defaulting to either answer would put a claim
 * on the record that nobody made.
 */
export type PaymentTiming = 'front' | 'delivery'

export const PAYMENT_TIMINGS: Array<{ id: PaymentTiming; label: string; hint: string }> = [
  { id: 'front', label: 'Front', hint: 'Paid before it ships' },
  { id: 'delivery', label: 'Upon delivery', hint: 'Paid when it arrives' }
]

export function paymentLabel(timing: string | null | undefined): string {
  return PAYMENT_TIMINGS.find((p) => p.id === timing)?.label ?? ''
}

/** Ticking a box: the same one clears it, the other one replaces it. */
export function togglePayment(
  current: PaymentTiming | null,
  clicked: PaymentTiming
): PaymentTiming | null {
  return current === clicked ? null : clicked
}

/** Anything unrecognised reads as "not said" rather than as a guess. */
export function asPaymentTiming(v: unknown): PaymentTiming | null {
  return v === 'front' || v === 'delivery' ? v : null
}

export function asCarrier(v: unknown): Carrier | null {
  return v === 'fedex' || v === 'ups' || v === 'usps' ? v : null
}

/** The four facts, as they travel together on both sides of the money. */
export interface Freight {
  carrier: Carrier | null
  service: string | null
  trackingNumber: string | null
  paymentTiming: PaymentTiming | null
}

/**
 * A partial edit of those four facts.
 *
 * `undefined` means "leave it as it is" and null means "clear it" — the
 * distinction matters because a screen that only knows the tracking number must
 * not blank out a payment choice somebody else recorded.
 */
export type FreightPatch = Partial<Freight>
