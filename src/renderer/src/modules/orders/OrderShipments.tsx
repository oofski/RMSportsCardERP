import { useCallback, useEffect, useState } from 'react'
import type { OrderShipment, OrderSide } from '@shared/orders'
import { shipmentsMissingCost, totalLabelCost, TRACKING_NUMBER_MAX } from '@shared/orders'
import type { Carrier } from '@shared/freight'
import { CARRIERS, carrierLabel, servicesFor, trackingUrl } from '@shared/freight'
import { api } from '../../lib/api'
import { Button, Input, Select } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { formatMoney } from '../../lib/format'

/**
 * The parcels an order ships in — several of them, each on its own carrier.
 *
 * ## The shape of the request, and why it is the right shape
 *
 * "Provide multiple tracking numbers with different carriers, and the carrier
 * and service populates only after adding something."
 *
 * So the entry point is ONE BOX: paste a tracking number, press Add. The carrier
 * is then guessed from the number's own shape — `detectCarrier` already knows
 * how, and a 1Z… identifies itself — and only once the parcel exists do a
 * carrier and a service appear on it, filled in and correctable.
 *
 * That ordering is the whole ergonomic point. Asking for a carrier first means
 * choosing from a list before typing the thing that already says which carrier
 * it is; and a service list rendered before a carrier is chosen is a control
 * with nothing in it, which reads as broken.
 *
 * ## One line per parcel, not a form per parcel
 *
 * A night's shipping is three or four of these in a row. Every field is inline
 * and every change saves on blur, so adding four parcels is four pastes rather
 * than four dialogs.
 */
export function OrderShipments({
  side,
  orderId,
  lines,
  canEdit
}: {
  side: OrderSide
  orderId: string
  /** The order's own line items, for saying which are in which parcel. */
  lines: Array<{ id: string; label: string; quantity: number }>
  canEdit: boolean
}): JSX.Element {
  const toast = useToast()
  const [shipments, setShipments] = useState<OrderShipment[]>([])
  const [adding, setAdding] = useState('')
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = useCallback(async () => {
    setShipments(await api.orders.shipments(side, orderId))
  }, [side, orderId])

  useEffect(() => {
    let active = true
    void (async () => {
      const rows = await api.orders.shipments(side, orderId)
      if (active) setShipments(rows)
    })()
    return () => {
      active = false
    }
  }, [side, orderId])

  const save = async (
    shipment: Parameters<typeof api.orders.saveShipment>[2]
  ): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const res = await api.orders.saveShipment(side, orderId, shipment)
      if (!res.ok) {
        toast.error(res.error ?? 'Could not save that parcel.')
        return
      }
      await load()
    } finally {
      setBusy(false)
    }
  }

  const add = async (): Promise<void> => {
    const tracking = adding.trim()
    if (!tracking) return
    setAdding('')
    await save({ trackingNumber: tracking })
  }

  const remove = async (id: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const res = await api.orders.deleteShipment(id)
      if (!res.ok) toast.error(res.error ?? 'Could not remove that parcel.')
      await load()
    } finally {
      setBusy(false)
    }
  }

  const postage = totalLabelCost(shipments)
  const missing = shipmentsMissingCost(shipments)

  return (
    <div className="ord-ship">
      <div className="ord-ship-head">
        <Icon name="Truck" size={15} />
        <b>Parcels</b>
        {shipments.length > 0 && (
          <span className="ord-ship-sum">
            {shipments.length} · postage {formatMoney(postage)}
            {/* SAID OUT LOUD, because the total is only as complete as what has
                been filled in. A figure that silently omits three unpriced
                labels is one somebody quotes in a margin conversation. */}
            {missing > 0 && (
              <em title={`${missing} parcel${missing === 1 ? '' : 's'} with no cost filled in`}>
                {' '}
                ({missing} not costed)
              </em>
            )}
          </span>
        )}
      </div>

      {shipments.length === 0 && (
        <p className="ord-ship-empty">
          Nothing has shipped yet. Paste a tracking number below and the carrier fills itself in.
        </p>
      )}

      {shipments.map((shipment) => {
        const services = shipment.carrier ? servicesFor(shipment.carrier) : []
        const url = shipment.carrier && shipment.trackingNumber
          ? trackingUrl(shipment.carrier, shipment.trackingNumber)
          : null
        const assigned = new Map(shipment.lines.map((l) => [l.lineId, l.quantity]))
        return (
          <div key={shipment.id} className="ord-ship-row">
            <div className="ord-ship-main">
              <span className="ord-ship-n">{shipment.position + 1}</span>
              <Input
                className="ord-ship-track mono"
                defaultValue={shipment.trackingNumber ?? ''}
                maxLength={TRACKING_NUMBER_MAX}
                placeholder="Tracking number"
                disabled={!canEdit}
                aria-label="Tracking number"
                onBlur={(e) => {
                  const next = e.target.value.trim()
                  if (next !== (shipment.trackingNumber ?? '')) {
                    void save({ id: shipment.id, trackingNumber: next || null })
                  }
                }}
              />

              {/* CARRIER AND SERVICE APPEAR ONLY ONCE THE PARCEL EXISTS, which
                  is the request. Before that there is nothing to attach them to
                  and a service list with no carrier chosen has nothing in it. */}
              <Select
                className="ord-ship-carrier"
                value={shipment.carrier ?? ''}
                disabled={!canEdit}
                aria-label="Carrier"
                onChange={(e) =>
                  void save({
                    id: shipment.id,
                    carrier: (e.target.value || null) as Carrier | null,
                    // Explicitly cleared rather than left to the merge, so the
                    // screen and the repository agree about what changing a
                    // carrier does to its service.
                    service: null
                  })
                }
              >
                <option value="">Carrier…</option>
                {CARRIERS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </Select>

              <Select
                className="ord-ship-service"
                value={shipment.service ?? ''}
                disabled={!canEdit || !shipment.carrier}
                aria-label="Service"
                title={shipment.carrier ? undefined : 'Pick a carrier first'}
                onChange={(e) => void save({ id: shipment.id, service: e.target.value || null })}
              >
                <option value="">{shipment.carrier ? 'Service…' : '—'}</option>
                {services.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>

              {/* WHAT THE LABEL COST. Left blank means nobody has said, which is
                  not the same as free — see the note on labelCost. */}
              <Input
                className="ord-ship-cost mono"
                type="number"
                step="0.01"
                min="0"
                defaultValue={shipment.labelCost === null ? '' : String(shipment.labelCost)}
                placeholder="Label $"
                disabled={!canEdit}
                aria-label="What the label cost"
                onBlur={(e) => {
                  const raw = e.target.value.trim()
                  const next = raw === '' ? null : Number(raw)
                  if (next !== shipment.labelCost) void save({ id: shipment.id, labelCost: next })
                }}
              />

              {url && (
                <a
                  className="ord-ship-link"
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  title={`Track ${shipment.trackingNumber} with ${carrierLabel(shipment.carrier)}`}
                >
                  <Icon name="ExternalLink" size={14} />
                </a>
              )}
              {canEdit && (
                <button
                  type="button"
                  className="ord-ship-x"
                  title="Remove this parcel"
                  disabled={busy}
                  onClick={() => void remove(shipment.id)}
                >
                  <Icon name="X" size={13} />
                </button>
              )}
            </div>

            {shipment.status && (
              <div className="ord-ship-status">
                <Icon name="MapPin" size={12} />
                {shipment.statusDetail ?? shipment.status}
              </div>
            )}

            {/* WHICH LINES ARE IN THIS PARCEL. Behind a toggle because most
                orders ship in one box and saying so is unnecessary work; the
                moment there are two parcels it is the only way to answer "which
                one has the Bowman in it". */}
            {lines.length > 0 && canEdit && (
              <div className="ord-ship-lines">
                <button
                  type="button"
                  className="ord-ship-lines-toggle"
                  onClick={() => setExpanded(expanded === shipment.id ? null : shipment.id)}
                >
                  <Icon name={expanded === shipment.id ? 'ChevronDown' : 'ChevronRight'} size={12} />
                  {shipment.lines.length > 0
                    ? `${shipment.lines.length} of ${lines.length} items in this parcel`
                    : 'Say what is in this parcel'}
                </button>
                {expanded === shipment.id && (
                  <ul className="ord-ship-line-list">
                    {lines.map((line) => {
                      const qty = assigned.get(line.id) ?? 0
                      return (
                        <li key={line.id}>
                          <label>
                            <input
                              type="checkbox"
                              checked={qty > 0}
                              onChange={(e) => {
                                const next = lines
                                  .map((l) => ({
                                    lineId: l.id,
                                    quantity:
                                      l.id === line.id
                                        ? e.target.checked
                                          ? l.quantity
                                          : 0
                                        : (assigned.get(l.id) ?? 0)
                                  }))
                                  .filter((l) => l.quantity > 0)
                                void save({ id: shipment.id, lines: next })
                              }}
                            />
                            {line.label}
                          </label>
                          <span className="mono">{line.quantity}</span>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            )}
          </div>
        )
      })}

      {canEdit && (
        <div className="ord-ship-add">
          <Input
            value={adding}
            placeholder="Paste a tracking number"
            maxLength={TRACKING_NUMBER_MAX}
            aria-label="Add a tracking number"
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void add()
              }
            }}
          />
          <Button size="sm" icon="Plus" disabled={busy || !adding.trim()} onClick={() => void add()}>
            Add parcel
          </Button>
          {/* A parcel with no number is legitimate — a hand delivery, a label
              bought before the number is known — so the second door exists and
              is quieter than the first. */}
          <button
            type="button"
            className="ord-ship-blank"
            disabled={busy}
            onClick={() => void save({ carrier: 'local' })}
          >
            or add one without a number
          </button>
        </div>
      )}
    </div>
  )
}
