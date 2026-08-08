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
import { api } from '../lib/api'
import { Icon } from './Icon'
import { Button, Checkbox, Field, Input, Select } from './ui'

/**
 * Carrier + tracking number on a board card, with the number as a live link.
 *
 * Renders nothing at all when there is no tracking number — a card that says
 * "no tracking" on every order is a card where nobody notices the ones that do
 * have it. `stopPropagation` because the cards are themselves buttons that open
 * the order, and clicking the link means "track", not "open".
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
  if (!tracking) return null
  const url = trackingUrl(carrier, tracking)
  const who = [carrierLabel(carrier), service].filter(Boolean).join(' ')

  return (
    <div className="freight-chip" title={`${who || 'Tracking'} ${tracking}`}>
      <Icon name="Truck" size={13} />
      {who && <span>{who}</span>}
      {url ? (
        <a
          href={url}
          className="mono"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            void api.email.openExternal(url)
          }}
        >
          {tracking}
        </a>
      ) : (
        <span className="mono">{tracking}</span>
      )}
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
