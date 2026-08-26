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

export type Carrier = 'fedex' | 'ups' | 'usps' | 'dhl' | 'local'

export interface CarrierDef {
  id: Carrier
  label: string
  /** Services this carrier actually sells, in the order they get chosen. */
  services: string[]
}

/**
 * The carriers this business uses, and every service each one sells.
 *
 * ## Names only, and the carrier's own name for it
 *
 * "3 Day Select", not "3 Day Select — day-definite delivery within 3 business
 * days across the contiguous U.S." The delivery promise belongs on the carrier's
 * rate page; what goes on a purchase order is the label somebody reads back to a
 * supplier over the phone, and it has to match what the carrier calls it exactly.
 *
 * ## Listed fastest first, deliberately
 *
 * Not alphabetically and not most-used-first. Somebody choosing a service is
 * deciding how fast this needs to arrive, so the list reads as a speed ladder
 * and the choice is a position on it. Ground sits near the bottom of each even
 * though it is the commonest, because scanning past four overnight options is
 * cheaper than picking the wrong tier.
 *
 * ## Each list is the carrier's OWN
 *
 * There is deliberately no shared pool. "Ground Advantage" is USPS's, "SurePost"
 * is UPS's, "Ground Economy" is FedEx's, and a service attached to the wrong
 * carrier is a line on a document that cannot be bought — which nobody notices
 * until the supplier rings back. Picking a carrier narrows the list to that
 * carrier and nothing else; see `servicesFor`.
 */
export const CARRIERS: CarrierDef[] = [
  {
    id: 'usps',
    label: 'USPS',
    services: ['Priority Mail Express', 'Priority Mail', 'Ground Advantage', 'First-Class Mail']
  },
  {
    id: 'fedex',
    label: 'FedEx',
    services: [
      'SameDay',
      'SameDay City',
      'First Overnight',
      'Priority Overnight',
      'Standard Overnight',
      '2Day A.M.',
      '2Day',
      'Express Saver',
      'Ground',
      'Home Delivery',
      'Ground Economy'
    ]
  },
  {
    id: 'ups',
    label: 'UPS',
    // Express Critical and SurePost are deliberately absent. UPS sells both;
    // this business does not use either, and a service nobody picks is a line in
    // a speed ladder somebody has to read past on every order. An order already
    // on disk that names one still shows it — see the fallback <option> in
    // FreightFields — so removing them from the list costs no history.
    services: [
      'Next Day Air Early',
      'Next Day Air',
      'Next Day Air Saver',
      '2nd Day Air A.M.',
      '2nd Day Air',
      '3 Day Select',
      'Ground'
    ]
  },
  {
    /**
     * DHL, and ONE SERVICE.
     *
     * DHL sells a shelf of them — eCommerce, Parcel, Global Mail, several
     * Express tiers. This business uses Express and the owner said so in those
     * words, so that is the whole list. A service nobody picks is a line in a
     * speed ladder somebody reads past on every order, which is the same
     * argument that keeps Express Critical and SurePost off the UPS list above.
     *
     * A one-entry list is not a special case for any of the machinery: the
     * service box narrows to it exactly as it narrows to eleven for FedEx, and
     * an order already on disk naming something else still shows it — see the
     * fallback <option> in FreightFields.
     */
    id: 'dhl',
    label: 'DHL',
    services: ['Express']
  },
  {
    /**
     * NOT A CARRIER, and it sits in this list anyway.
     *
     * Plenty of what leaves this building never goes near a carrier: a local
     * buyer collects, or somebody drops a box off on the way home. Before this
     * there was no way to say so — the shipping company was left blank, which
     * reads identically to "nobody has filled this in yet", and there is no
     * later moment when a tracking number turns up to resolve the ambiguity.
     *
     * Modelled as a carrier because the question it answers is the carrier
     * question — "how is this getting there" — and because doing so means the
     * service list, the fallback for old values and the two forms that render
     * all of it work unchanged. A separate boolean beside the carrier would have
     * been a second field that has to be kept consistent with the first.
     *
     * It sells no tracking, which the rest of the file already handles: there is
     * no pattern for it in `detectCarrier`, so a pasted number never guesses it,
     * and `trackingUrl` has no case for it, so the Track button stays dead.
     */
    id: 'local',
    label: 'Pickup / hand delivery',
    services: ['Customer pickup', 'Hand delivery']
  }
]

/**
 * Offered when no carrier has been chosen yet — which is NOTHING.
 *
 * It used to be a mixed handful (Ground, Next Day Air, 2nd Day Air) so the box
 * was never empty, and that was the wrong kindness: "Next Day Air" is UPS's
 * name, so picking it before naming a carrier wrote a UPS service onto a
 * shipment that might turn out to be FedEx. The service field is now simply not
 * answerable until the carrier is, which is the real order of the two questions.
 */
export const COMMON_SERVICES: string[] = []

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
 *   DHL   A 10-digit Express air waybill, or JJD/JD + digits. Ten digits
 *         collides with nothing above — FedEx starts at 12 — so it is safe to
 *         claim. The longer DHL eCommerce formats are deliberately absent: this
 *         business ships Express, and a number guessed onto the wrong DHL
 *         product opens the wrong tracking page.
 */
export function detectCarrier(tracking: string): Carrier | null {
  const t = (tracking ?? '').replace(/[\s-]/g, '').toUpperCase()
  if (!t) return null
  if (/^1Z[0-9A-Z]{16}$/.test(t)) return 'ups'
  // USPS numbers starting 94/93/92/95 are theirs regardless of length.
  if (/^(94|93|92|95)\d{18,20}$/.test(t)) return 'usps'
  if (/^\d{22}$/.test(t)) return 'usps'
  // BEFORE the FedEx lengths, and it cannot collide with them: 12 and 15 are
  // FedEx's shortest, and this is exactly 10.
  if (/^\d{10}$/.test(t)) return 'dhl'
  if (/^JJD\d{9,}$/.test(t) || /^JD\d{9,}$/.test(t)) return 'dhl'
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
    case 'dhl':
      return `https://www.dhl.com/us-en/home/tracking/tracking-express.html?submit=1&tracking-id=${n}`
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

/**
 * Validated against CARRIERS rather than a hand-written list.
 *
 * It used to name the three literally, which meant adding a fourth silently
 * nulled it at every write boundary — the value would round-trip through the
 * form, be saved as NULL, and come back blank with nothing erroring. Reading the
 * list is what makes the list the single place a carrier is declared.
 */
export function asCarrier(v: unknown): Carrier | null {
  return CARRIERS.some((c) => c.id === v) ? (v as Carrier) : null
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
