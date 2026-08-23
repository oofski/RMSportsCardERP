import { useMemo, useState } from 'react'
import type { ShipmentRow, ShipmentSource } from '@shared/multiShipment'
import {
  newShipmentRowKey,
  buyerShares,
  salesOrdersFromShipment,
  shipmentProblem,
  shipmentRowsFrom,
  unassignedUnits
} from '@shared/multiShipment'
import { api } from '../../lib/api'
import { Button, Modal } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { BuyerSelect } from './PartySelect'

/**
 * Who is getting what, on a purchase that ships out to several people.
 *
 * ## The screen this replaces was a refusal
 *
 * `DropshipSaleStep` used to look at a purchase order going to more than one
 * place and say: that is N separate sales to N separate people, so it cannot be
 * billed as one order — raise each one from the Sales Orders board. Which was
 * true, and left the operator to retype the same line items N times against a
 * purchase order they then had to find and link by hand N times. The refusal was
 * correct about the documents and wrong about whose job it was.
 *
 * ## It is one screen because it is one decision
 *
 * Assigning ten boxes to five people is one act of dividing, and doing it row by
 * row across five separate forms means holding the running remainder in your
 * head. Here the arithmetic is on screen — see the guard rail at the foot, which
 * is the same one the purchase order's own split editor uses, worded the same
 * way, because it is the same sum.
 *
 * ## Prices are NOT here
 *
 * There is no rate column, deliberately. Every order comes out at zero and is
 * priced when it is opened, which is exactly what the single-buyer dropship flow
 * already does and for the reason spelled out in `dropshipSaleFromPurchase`: what
 * we paid the distributor is not what any of these five people pay us, and a
 * price defaulted from the buy side is a zero-margin invoice one Enter away —
 * five times over here rather than once.
 *
 * The orders are created as DRAFTS. Nothing reaches QuickBooks from this button.
 */
export function MultiShipmentSplit({
  poId,
  poNumber,
  supplier,
  sources,
  onClose,
  onDone
}: {
  poId: string
  poNumber: string
  /** Who we bought from — the party that ships every one of these. */
  supplier: string | null
  /** The drop half of the purchase order, one entry per slice. */
  sources: ShipmentSource[]
  onClose: () => void
  onDone: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [rows, setRows] = useState<ShipmentRow[]>(() => shipmentRowsFrom(sources))
  const [saving, setSaving] = useState(false)

  const problem = useMemo(() => shipmentProblem(rows, sources), [rows, sources])
  const shares = useMemo(() => buyerShares(rows, sources), [rows, sources])
  const totalUnits = sources.reduce((n, s) => n + s.quantity, 0)
  const assigned = rows.reduce((n, r) => n + Math.max(0, Math.round(r.quantity) || 0), 0)

  const patch = (key: string, next: Partial<ShipmentRow>): void => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...next } : r)))
  }

  /**
   * Split a slice: add a second row for the same product, sized to whatever is
   * left over.
   *
   * Offering the REMAINDER rather than 1 is what makes the common gesture one
   * click. Ten boxes, four to the first buyer, press split and the second row
   * already says six.
   */
  const splitRow = (row: ShipmentRow): void => {
    const source = sources.find((s) => s.key === row.sourceKey)
    if (!source) return
    const left = unassignedUnits(rows, source)
    setRows((rs) => {
      const at = rs.findIndex((r) => r.key === row.key)
      if (at === -1) return rs
      /**
       * A ROW HOLDING ONE UNIT CANNOT BE SPLIT, and refusing is the only honest
       * answer.
       *
       * With nothing left over, the new row has to come out of this one. That
       * works down to a row of two; at one there is nothing to give, and the
       * previous `Math.max(1, quantity - 1)` quietly left the row AT one and
       * added another beside it — so the slice summed to one more than the order
       * bought, and `shipmentProblem` blocked the save with a message about
       * over-assignment that the operator had not caused. Splitting one box
       * between two people is not a thing; the button says so instead.
       */
      if (left <= 0 && rs[at].quantity <= 1) return rs
      const added: ShipmentRow = {
        key: newShipmentRowKey(),
        sourceKey: row.sourceKey,
        buyer: '',
        // A split with nothing left over takes one unit OFF the row it came from
        // rather than opening at zero, which shipmentProblem would refuse and
        // which reads as the button being broken.
        quantity: left > 0 ? left : 1
      }
      const next = [...rs]
      if (left <= 0) next[at] = { ...next[at], quantity: next[at].quantity - 1 }
      next.splice(at + 1, 0, added)
      return next
    })
  }

  /** Is there anything to give a new row? See splitRow. */
  const canSplit = (row: ShipmentRow): boolean => {
    const source = sources.find((s) => s.key === row.sourceKey)
    if (!source) return false
    return unassignedUnits(rows, source) > 0 || row.quantity > 1
  }

  const removeRow = (row: ShipmentRow): void => {
    setRows((rs) => {
      const siblings = rs.filter((r) => r.sourceKey === row.sourceKey)
      // THE LAST ROW OF A SLICE IS NOT REMOVABLE. Those units are bought and
      // shipping; a slice with no rows is boxes addressed to nobody, and
      // shipmentProblem would block the save with a message about a row somebody
      // deliberately deleted. Its buyer is cleared instead, which is the thing
      // they were probably trying to undo.
      if (siblings.length <= 1) return rs.map((r) => (r.key === row.key ? { ...r, buyer: '' } : r))
      return rs.filter((r) => r.key !== row.key)
    })
  }

  const create = async (): Promise<void> => {
    if (problem) return
    setSaving(true)
    try {
      // Fetched now rather than held, for the same reason the single-buyer flow
      // fetches it when the form opens: it is a SUGGESTION computed from what
      // exists at this moment, and saveInvoice moves each one up if it is taken.
      const firstNumber = await api.invoices.nextNumber()
      const orders = salesOrdersFromShipment({
        supplier,
        invoiceDate: new Date().toISOString().slice(0, 10),
        firstNumber,
        rows,
        sources
      })
      const res = await api.orders.splitDropship(poId, orders)
      if (!res.ok || !res.data) {
        toast.error((!res.ok && res.error) || 'Could not raise the sales orders.')
        setSaving(false)
        return
      }
      const made = res.data.created
      toast.success(
        `${made.length} sales order${made.length === 1 ? '' : 's'} raised from ${poNumber} — ` +
          `open each one to set the price.`
      )
      /**
       * THE WRITE IS DONE AND NOTHING AFTER IT MAY LOOK LIKE A FAILURE.
       *
       * `onDone` is the board's `reload` — a refetch, not part of the save. It
       * used to be awaited inside the try above, so a refetch that rejected
       * (a dropped connection, a signed-out session) was caught by the same
       * handler as the write, reported as "Could not raise the sales orders",
       * and re-enabled the button — on a batch that had ALREADY committed. The
       * next press wrote every buyer a second invoice.
       *
       * So it is awaited outside, its failure is swallowed to a stale board
       * rather than a wrong sentence, and the modal closes either way. The
       * server refuses a second batch too — see splitDropshipSales — because
       * this is not the only way back to that button.
       */
      onClose()
      try {
        await onDone()
      } catch {
        // A stale board is a refresh away. Saying the save failed is not.
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not raise the sales orders.')
      setSaving(false)
    }
  }

  return (
    <Modal
      title="Who is getting what?"
      subtitle={`${poNumber} ships out to several buyers — say which units go to whom`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Not now
          </Button>
          <Button
            variant="primary"
            icon="ReceiptText"
            disabled={!!problem || saving || shares.length === 0}
            title={problem ?? `Writes ${shares.length} draft sales orders`}
            onClick={() => void create()}
          >
            {saving
              ? 'Writing…'
              : `Create ${shares.length} sales order${shares.length === 1 ? '' : 's'}`}
          </Button>
        </>
      }
    >
      <p className="fin-confirm-lead">
        <b>{poNumber}</b> buys <b>{totalUnits}</b> unit{totalUnits === 1 ? '' : 's'} from{' '}
        <b>{supplier ?? 'a supplier'}</b> that go straight out and never touch a shelf here. Each
        buyer below gets <b>their own sales order</b> with only their own goods on it.
      </p>

      <div className="po-ld-rows ms-rows">
        {sources.map((source) => {
          const own = rows.filter((r) => r.sourceKey === source.key)
          return (
            <div className="ms-source" key={source.key}>
              <div className="ms-source-head">
                <span className="ms-source-name">{source.item}</span>
                {source.sku && <span className="ms-source-sku mono">{source.sku}</span>}
                <span className="ms-source-qty mono">
                  {source.quantity} unit{source.quantity === 1 ? '' : 's'}
                </span>
              </div>

              {own.map((row, i) => (
                <div className="po-ld-splitrow is-drop ms-row" key={row.key}>
                  <span className="po-ld-splitn">{i + 1}</span>

                  <span className="po-ld-step">
                    <button
                      type="button"
                      className="po-deliv-btn"
                      aria-label={`One fewer for buyer ${i + 1} of ${source.item}`}
                      disabled={row.quantity <= 1}
                      onClick={() => patch(row.key, { quantity: row.quantity - 1 })}
                    >
                      <Icon name="Minus" size={14} />
                    </button>
                    <input
                      className="po-deliv-num mono"
                      inputMode="numeric"
                      aria-label={`Units for buyer ${i + 1} of ${source.item}`}
                      value={String(row.quantity)}
                      onChange={(e) =>
                        patch(row.key, {
                          quantity: Math.max(
                            0,
                            parseInt(e.target.value.replace(/\D+/g, ''), 10) || 0
                          )
                        })
                      }
                    />
                    <button
                      type="button"
                      className="po-deliv-btn"
                      aria-label={`One more for buyer ${i + 1} of ${source.item}`}
                      onClick={() => patch(row.key, { quantity: row.quantity + 1 })}
                    >
                      <Icon name="Plus" size={14} />
                    </button>
                  </span>

                  <BuyerSelect
                    className="po-ld-splitfield ms-buyer"
                    ariaLabel={`Buyer ${i + 1} for ${source.item}`}
                    value={row.buyer || null}
                    onChange={(name) => patch(row.key, { buyer: name ?? '' })}
                  />

                  <button
                    type="button"
                    className="btn btn-ghost btn-sm ms-split"
                    disabled={!canSplit(row)}
                    title={
                      canSplit(row)
                        ? `Send some of these ${source.item} to somebody else too`
                        : 'Nothing left to give — one box cannot go to two people'
                    }
                    aria-label={`Split ${source.item} between more buyers`}
                    onClick={() => splitRow(row)}
                  >
                    <Icon name="Split" size={15} />
                    {/* HIDDEN AT EVERY DESKTOP WIDTH — see .ms-btn-label. On a
                        wide row the two icon buttons sit at the end of a line
                        and their position is what says what they do; the phone
                        layer stacks that row, and a lone centred glyph on a line
                        of its own reads as decoration rather than a control. */}
                    <span className="ms-btn-label">Split</span>
                  </button>

                  <button
                    type="button"
                    className="btn btn-ghost btn-sm po-ld-splitdrop"
                    aria-label={`Remove buyer ${i + 1} for ${source.item}`}
                    title={
                      own.length <= 1
                        ? 'Clears the buyer — these units are bought and shipping, so they cannot be assigned to nobody'
                        : 'Remove this buyer'
                    }
                    onClick={() => removeRow(row)}
                  >
                    <Icon name="Trash2" size={15} />
                    <span className="ms-btn-label">{own.length <= 1 ? 'Clear' : 'Remove'}</span>
                  </button>
                </div>
              ))}
            </div>
          )
        })}
      </div>

      {/* THE GUARD RAIL, the same one the purchase order's split editor uses and
          worded the same way, because it is the same sum. Live and above the
          button it governs: the operator is making two numbers match, so both
          numbers stay on screen while they type. */}
      <div className={`po-ld-guard${problem ? ' is-bad' : ''}`} role="status">
        <Icon name={problem ? 'AlertTriangle' : 'Check'} size={14} />
        <span>
          <b className="mono">{assigned}</b> of <b className="mono">{totalUnits}</b> units assigned
          {problem
            ? ` — ${problem}`
            : ` — ${shares.length} buyer${shares.length === 1 ? '' : 's'}, ${shares.length} sales order${
                shares.length === 1 ? '' : 's'
              }.`}
        </span>
      </div>

      {/* Who gets what, added up, before anything is written. The rows above are
          per PRODUCT and a buyer taking two off one line and three off another
          appears twice in them — this is the one place that says what each
          person's invoice will actually total in units. */}
      {shares.length > 0 && !problem && (
        <div className="ms-preview">
          {shares.map((s) => (
            <div className="ms-preview-row" key={s.buyer}>
              <span className="ms-preview-buyer">{s.buyer}</span>
              <span className="ms-preview-detail">
                {s.units} unit{s.units === 1 ? '' : 's'} · {s.lines.length}{' '}
                {s.lines.length === 1 ? 'line' : 'lines'}
              </span>
            </div>
          ))}
        </div>
      )}

      <p className="ds-note">
        <Icon name="Info" size={14} />
        <span>
          Every order is written as a <b>draft at zero</b> and linked to {poNumber}. Open each one
          from the Sales Orders board to set <b>that buyer's price</b>, then push it to QuickBooks
          the usual way — nothing goes to QuickBooks from this button.
        </span>
      </p>
    </Modal>
  )
}
