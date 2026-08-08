import type { Carrier, PaymentTiming } from '@shared/freight'
import {
  CARRIERS,
  PAYMENT_TIMINGS,
  carrierLabel,
  detectCarrier,
  servicesFor,
  togglePayment,
  trackingUrl
} from '@shared/freight'
import type { ShipStatusCode } from '@shared/shippingTypes'
import { trackingLineTone, trackingSummary } from '@shared/tracking'
import { api } from '../lib/api'
import { Icon } from './Icon'
import { Button, Checkbox, Field, Input, Select } from './ui'

/**
 * How a card says where the box is: one line, in words.
 *
 * "USPS · Ground Advantage", and nothing else. The TRACKING NUMBER is
 * deliberately not here — a twenty-two digit string is the widest thing on a
 * board card and the least readable, it pushes the money and the item count out
 * of line, and nobody reads a tracking number off a board. It lives on the
 * order itself, where it is editable and has a Track button beside it.
 *
 * Clicking the line still opens the carrier's own live page, so the number
 * being absent costs nothing: the thing somebody wants when they look at this
 * is "where is it", and that is one click either way.
 *
 * Renders nothing when there is no carrier AND no service — a card that says
 * "no shipping" on every order is a card where nobody notices the ones that
 * have some.
 */
export function FreightLine({
  carrier,
  service,
  trackingNumber
}: {
  carrier: Carrier | null
  service?: string | null
  trackingNumber: string | null
}): JSX.Element | null {
  const tracking = (trackingNumber ?? '').trim()
  const who = [carrierLabel(carrier), service].filter(Boolean).join(' · ')
  if (!who && !tracking) return null
  const url = trackingUrl(carrier, tracking)

  // With a carrier but no service the carrier alone is still worth saying; with
  // neither but a number on file, say that a number exists rather than nothing.
  const label = who || 'Tracking on file'

  const body = (
    <>
      <Icon name="Truck" size={13} />
      <span>{label}</span>
    </>
  )

  return (
    <div className="freight-chip" title={tracking ? `${label} — ${tracking}` : label}>
      {url ? (
        // stopPropagation because the card is itself a button that opens the
        // order, and clicking here means "track", not "open".
        <a
          href={url}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            void api.email.openExternal(url)
          }}
        >
          {body}
        </a>
      ) : (
        body
      )}
    </div>
  )
}

/**
 * What the carrier last said, and how long ago it said it.
 *
 * ALWAYS RENDERED once an order has a tracking number, even before anything has
 * been read. It used to render nothing until a reading succeeded, and a blank
 * space where a status belongs cannot tell "nobody has checked yet" from "we
 * checked and the carrier refused" from "this build is too old to have the
 * feature". Those need three different reactions, and an empty gap gives no
 * clue which one you are looking at.
 *
 * The AGE is part of the sentence rather than a tooltip on it. This is scraped
 * from the carrier's own page on a schedule, not fetched from an API — pages
 * get restructured and reads get refused — so a status with no age invites
 * somebody to trust Tuesday's reading as this morning's. A status that HAS a
 * reading but whose latest check is failing says both: "In transit · checked
 * 2h ago · check failing".
 */
export function TrackingLine({
  status,
  checkedAt,
  detail,
  error,
  attemptedAt,
  /** No tracking number means nothing to track — then, and only then, silent. */
  hasTracking = true
}: {
  status: ShipStatusCode | null
  checkedAt: string | null
  /** The carrier's own sentence, shown on hover so the parse is checkable. */
  detail?: string | null
  error?: string | null
  attemptedAt?: string | null
  hasTracking?: boolean
}): JSX.Element | null {
  if (!hasTracking) return null
  return (
    <div
      className={`track-chip ${trackingLineTone(status, error)}`}
      // The carrier's own words when we have them; the failure when we do not.
      // Either way the hover explains what the line is based on.
      title={detail ?? error ?? undefined}
    >
      <span className="track-dot" aria-hidden="true" />
      <span>{trackingSummary(status, checkedAt, Date.now(), error, attemptedAt)}</span>
    </div>
  )
}

/**
 * How it ships, and when it gets paid for — one control, both sides of the money.
 *
 * A purchase order and an invoice each put a box on a truck and each settle at
 * some point, so they ask the same four questions. Two copies of this markup
 * would answer them differently within a month, which is the whole reason it is
 * a component rather than a block pasted into each modal.
 *
 * ## Tracking
 *
 * Typing a number that names its own carrier — a UPS `1Z...`, a 12-digit FedEx —
 * selects the carrier, so the usual case is one paste and nothing else. It only
 * fills a BLANK carrier: somebody who deliberately chose one is not overruled by
 * a pattern match. The Track button opens the carrier's own tracking page, which
 * is live and authoritative because it is theirs. See @shared/freight for why
 * that beats three carrier API integrations for fifteen packages a day.
 */
export function FreightFields({
  carrier,
  service,
  trackingNumber,
  paymentTiming,
  onChange,
  /** "Where it is going" for an invoice, "where it is coming from" for a PO. */
  hint
}: {
  carrier: Carrier | null
  service: string | null
  trackingNumber: string | null
  paymentTiming: PaymentTiming | null
  onChange: (patch: {
    carrier?: Carrier | null
    service?: string | null
    trackingNumber?: string | null
    paymentTiming?: PaymentTiming | null
  }) => void
  hint?: string
}): JSX.Element {
  const tracking = trackingNumber ?? ''
  const url = trackingUrl(carrier, tracking)

  /** A pasted number that identifies itself fills in a carrier nobody chose. */
  const typeTracking = (value: string): void => {
    const detected = carrier ? null : detectCarrier(value)
    onChange(detected ? { trackingNumber: value, carrier: detected } : { trackingNumber: value })
  }

  /**
   * Changing carrier drops a service the new carrier does not sell.
   *
   * "Next Day Air" is UPS's name for it; leaving it attached to a FedEx shipment
   * would put a service on the record that cannot be bought, and the PDF would
   * print it.
   */
  const pickCarrier = (value: string): void => {
    const next = (value || null) as Carrier | null
    const keeps = !service || servicesFor(next).includes(service)
    onChange({ carrier: next, ...(keeps ? {} : { service: null }) })
  }

  return (
    <>
      <div className="field-row">
        <Field label="Shipping company" hint={hint ?? 'Optional'}>
          <Select value={carrier ?? ''} onChange={(e) => pickCarrier(e.target.value)}>
            <option value="">—</option>
            {CARRIERS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Service" hint="Ground, Next Day Air…">
          <Select
            value={service ?? ''}
            onChange={(e) => onChange({ service: e.target.value || null })}
          >
            <option value="">—</option>
            {servicesFor(carrier).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Tracking number" hint="Paste it — the carrier fills itself in">
          <div className="freight-track">
            <Input
              value={tracking}
              onChange={(e) => typeTracking(e.target.value)}
              placeholder="1Z999AA10123456784"
              className="mono"
            />
            <Button
              variant="secondary"
              icon="ExternalLink"
              disabled={!url}
              title={
                url
                  ? 'Open live tracking on the carrier’s site'
                  : tracking
                    ? 'Pick the carrier to enable tracking'
                    : 'No tracking number yet'
              }
              onClick={() => {
                if (url) void api.email.openExternal(url)
              }}
            >
              Track
            </Button>
          </div>
        </Field>
      </div>

      {/* ---- Payment ------------------------------------------------------ */}
      <div className="freight-payment">
        <div className="freight-payment-label">Payment</div>
        <div className="freight-payment-boxes">
          {PAYMENT_TIMINGS.map((p) => (
            <Checkbox
              key={p.id}
              checked={paymentTiming === p.id}
              label={p.label}
              hint={p.hint}
              onChange={() => onChange({ paymentTiming: togglePayment(paymentTiming, p.id) })}
            />
          ))}
        </div>
      </div>
    </>
  )
}
