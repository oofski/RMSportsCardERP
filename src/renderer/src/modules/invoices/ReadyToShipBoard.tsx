import { useCallback, useEffect, useState } from 'react'
import type { InvoiceDetail } from '@shared/invoices'
import {
  FULFILLMENT_COLUMNS,
  FULFILLMENT_STAGE_TONE,
  describeDims,
  fulfillmentColumnOf,
  fulfillmentNextStep,
  fulfillmentNextStepDetail,
  fulfillmentStageOf,
  fulfillmentTickLabel,
  fulfillmentTickShort,
  hasDims,
  shelfShortfall,
  type FulfillmentColumn,
  type FulfillmentStage
} from '@shared/fulfillment'
import { api } from '../../lib/api'
import { Button, CenterLoader, EmptyState, Field, Input, Modal } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { formatDate, formatMoney } from '../../lib/format'

/**
 * Getting sold orders out of the door.
 *
 * ## Two columns, three states
 *
 * `fulfillmentStageOf` answers with three — awaiting items, awaiting dims,
 * ready — and the first two share the Ordered column, told apart by the colour
 * of a chip. See FULFILLMENT_COLUMNS for why: the work differs while the
 * situation does not, and a card crossing a column for a change that has not
 * happened reads as progress that was not made.
 *
 * ## Nothing here is stored
 *
 * A card's column is derived on every draw from facts that live elsewhere —
 * whether the shelf covered it, whether somebody confirmed a supplier has it,
 * whether the box has been measured, whether payment cleared. There is no
 * fulfilment status column to drift out of step with those, which is the same
 * decision `orderKindOf` and `salesOrderKindOf` already make on the two order
 * boards.
 *
 * ## Orders that are NOT here
 *
 * An up-front order nobody has paid for is not the packing floor's problem and
 * is deliberately absent. That is the one question this board will generate, so
 * the footer says so and says what to do about it.
 */
export function ReadyToShipBoard(): JSX.Element {
  const toast = useToast()
  const [rows, setRows] = useState<InvoiceDetail[] | null>(null)
  const [measuring, setMeasuring] = useState<InvoiceDetail | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setRows(await api.invoices.fulfillment())
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (rows === null) return <CenterLoader />

  /** Only orders the gates actually admit. A null stage is not on this board. */
  const staged = rows
    .map((inv) => ({ inv, stage: fulfillmentStageOf(inv) }))
    .filter((r): r is { inv: InvoiceDetail; stage: FulfillmentStage } => r.stage !== null)

  const held = rows.length - staged.length

  const inColumn = (column: FulfillmentColumn): typeof staged =>
    staged.filter((r) => fulfillmentColumnOf(r.stage) === column)

  const confirmItems = async (inv: InvoiceDetail): Promise<void> => {
    setBusy(inv.id)
    try {
      const res = await api.invoices.setItemsInHand(inv.id, true)
      if (!res.ok) {
        toast.error(res.error ?? 'Could not mark the goods in hand.')
        return
      }
      await load()
    } finally {
      setBusy(null)
    }
  }

  const sendAnyway = async (inv: InvoiceDetail): Promise<void> => {
    setBusy(inv.id)
    try {
      const res = await api.invoices.setForceReady(inv.id, true)
      if (!res.ok) {
        toast.error(res.error ?? 'Could not move it.')
        return
      }
      toast.success('Moved to Ready to ship.')
      await load()
    } finally {
      setBusy(null)
    }
  }

  /**
   * THE CHECK MARK. One control whose meaning follows the chip beside it — see
   * fulfillmentTickLabel. On a card waiting for goods it confirms they arrived;
   * on one waiting for measurements it opens the box for them.
   */
  const tick = (inv: InvoiceDetail, stage: FulfillmentStage): void => {
    if (stage === 'awaiting_items') void confirmItems(inv)
    else setMeasuring(inv)
  }

  return (
    <>
      <div className="po-board fx-board">
        {FULFILLMENT_COLUMNS.map((column) => {
          const cards = inColumn(column.id)
          return (
            <div key={column.id} className="po-col">
              <div className="po-col-head" title={column.hint}>
                <span className="po-col-title">
                  <Icon name={column.icon} size={15} />
                  {column.label}
                </span>
                <span className="po-col-count">{cards.length}</span>
              </div>
              <div className="po-col-body">
              

              {cards.length === 0 ? (
                <div className="po-col-empty">Nothing here.</div>
              ) : (
                cards.map(({ inv, stage }) => (
                  <FulfillmentCard
                    key={inv.id}
                    invoice={inv}
                    stage={stage}
                    busy={busy === inv.id}
                    onTick={() => tick(inv, stage)}
                    onMeasure={() => setMeasuring(inv)}
                    onSendAnyway={() => void sendAnyway(inv)}
                  />
                ))
              )}
              </div>
            </div>
          )
        })}
      </div>

      {/* THE QUESTION THIS BOARD WILL GENERATE, answered before it is asked.
          An order held back by payment is invisible here, and "where is my
          order" has no answer on a board that does not contain it. */}
      {held > 0 && (
        <p className="fx-held">
          <Icon name="Info" size={14} />
          <span>
            <b>
              {held} order{held === 1 ? '' : 's'}
            </b>{' '}
            {held === 1 ? 'is' : 'are'} not shown — the buyer pays up front and has not paid yet.
            Record the payment under <b>Sales Orders</b>, and {held === 1 ? 'it' : 'they'} will
            appear here.
          </span>
        </p>
      )}

      {measuring && (
        <DimsModal
          invoice={measuring}
          onClose={() => setMeasuring(null)}
          onSaved={async () => {
            setMeasuring(null)
            await load()
          }}
        />
      )}
    </>
  )
}

function FulfillmentCard({
  invoice,
  stage,
  busy,
  onTick,
  onMeasure,
  onSendAnyway
}: {
  invoice: InvoiceDetail
  stage: FulfillmentStage
  busy: boolean
  onTick: () => void
  onMeasure: () => void
  onSendAnyway: () => void
}): JSX.Element {
  const tone = FULFILLMENT_STAGE_TONE[stage]
  const next = fulfillmentNextStep(invoice)
  const why = fulfillmentNextStepDetail(invoice)
  const dims = describeDims(invoice)
  const short = shelfShortfall(invoice)

  return (
    <div className={`po-card fx-card fx-card-${tone}`}>
      <div className="po-card-top">
        <span className="po-card-num mono">{invoice.invoiceNumber || 'No number'}</span>
        {/* THE CHIP IS THE WHOLE POINT of one column holding two states, so it
            carries its own explanation on hover rather than relying on somebody
            learning what blue means. */}
        <span className="fx-chips">
          <span
            className={`fx-chip fx-chip-${tone}`}
            title={why ?? 'Cleared — buy the label and send it'}
          >
            {stage === 'awaiting_items'
              ? 'Awaiting items'
              : stage === 'awaiting_dims'
                ? 'Awaiting dims'
                : 'Ready'}
          </span>
          {invoice.forceReadyAt && (
            <span className="fx-chip fx-chip-forced" title="Moved here by hand, ahead of the gates">
              By hand
            </span>
          )}
        </span>
      </div>

      <div className="po-card-supplier">{invoice.customerName}</div>
      <div className="po-card-figs">
        <span className="po-card-total mono">{formatMoney(invoice.total)}</span>
        <span className="po-card-meta">
          {invoice.paymentTiming === 'delivery' ? 'Pays on delivery' : 'Pays up front'}
          {invoice.status === 'paid' ? ' · paid' : ''}
        </span>
      </div>

      {next && (
        <div className={`fx-next fx-next-${tone}`} title={why ?? undefined}>
          <Icon name={stage === 'awaiting_items' ? 'Truck' : 'Ruler'} size={13} />
          <span>{next}</span>
        </div>
      )}

      {/* A READY CARD WITH NO MEASUREMENTS is only possible by hand, and it is
          worth saying: the label cannot be bought without them, and finding
          that out at the counter is worse than being told here. */}
      {stage === 'ready' && !hasDims(invoice) && (
        <div className="fx-next fx-next-dims">
          <Icon name="Ruler" size={13} />
          <span>Not measured — a label cannot be bought until it is.</span>
        </div>
      )}

      {/* The shortfall used to print twice — "2 short on the shelf" and then
          "0 of 2 off the shelf" underneath, which is the same fact said again
          in weaker words. The sentence above keeps it; this line only appears
          when part of the order DID come off the shelf, which the sentence
          does not say. */}
      {dims && <div className="fx-dims mono">{dims}</div>}
      {short > 0 && invoice.drawnUnits > 0 && (
        <div className="fx-dims">
          {invoice.drawnUnits} of {invoice.stockUnits} already off the shelf
        </div>
      )}

      <div className="po-card-foot">
        <span className="fx-date">{formatDate(invoice.invoiceDate)}</span>
        <div className="row" style={{ gap: 6 }}>
          {stage === 'ready' ? (
            <Button variant="ghost" size="sm" icon="Ruler" onClick={onMeasure}>
              {hasDims(invoice) ? 'Re-measure' : 'Measure'}
            </Button>
          ) : (
            <>
              {/* Bullet five: an up-front buyer whose package is going out
                  regardless. Offered on any card still in Ordered, because the
                  reason to override is not always the payment gate.

                  No icon, and the short label on the tick beside it: the two
                  together have a column a third of a board wide to live in, and
                  the full sentences wrapped them onto three lines each. Both
                  carry their long form as a tooltip. */}
              <Button
                variant="ghost"
                size="sm"
                title="Move it to Ready to ship now, ahead of the usual gates"
                onClick={onSendAnyway}
              >
                Send anyway
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon="Check"
                loading={busy}
                title={fulfillmentTickLabel(stage)}
                onClick={onTick}
              >
                {fulfillmentTickShort(stage)}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Weigh it and measure it.
 *
 * All four fields together, because `hasDims` reads a partial set as unmeasured
 * — a carrier prices a case on dimensional weight, so three of the four buys
 * nothing. Saving with the boxes empty clears the measurements, which is the way
 * back for a parcel that was repacked.
 */
function DimsModal({
  invoice,
  onClose,
  onSaved
}: {
  invoice: InvoiceDetail
  onClose: () => void
  onSaved: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const str = (v: number | null): string => (v == null ? '' : String(v))
  const [weightLb, setWeightLb] = useState(str(invoice.weightLb))
  const [lengthIn, setLengthIn] = useState(str(invoice.lengthIn))
  const [widthIn, setWidthIn] = useState(str(invoice.widthIn))
  const [heightIn, setHeightIn] = useState(str(invoice.heightIn))
  const [busy, setBusy] = useState(false)

  const num = (v: string): number | null => {
    const n = parseFloat(v)
    return Number.isFinite(n) && n > 0 ? n : null
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await api.invoices.setDims(invoice.id, {
        weightLb: num(weightLb),
        lengthIn: num(lengthIn),
        widthIn: num(widthIn),
        heightIn: num(heightIn)
      })
      if (!res.ok) {
        toast.error(res.error ?? 'Could not save the measurements.')
        return
      }
      await onSaved()
    } finally {
      setBusy(false)
    }
  }

  const complete =
    !!num(weightLb) && !!num(lengthIn) && !!num(widthIn) && !!num(heightIn)

  return (
    <Modal
      title="Weigh and measure"
      subtitle={`${invoice.invoiceNumber || 'This order'} — ${invoice.customerName}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="Check" loading={busy} onClick={save}>
            {complete ? 'Save and mark ready' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="field-row">
        <Field label="Weight" hint="Pounds">
          <Input
            value={weightLb}
            inputMode="decimal"
            placeholder="6.5"
            autoFocus
            onChange={(e) => setWeightLb(e.target.value)}
          />
        </Field>
        <Field label="Length" hint="Inches">
          <Input
            value={lengthIn}
            inputMode="decimal"
            placeholder="12"
            onChange={(e) => setLengthIn(e.target.value)}
          />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Width" hint="Inches">
          <Input
            value={widthIn}
            inputMode="decimal"
            placeholder="9"
            onChange={(e) => setWidthIn(e.target.value)}
          />
        </Field>
        <Field label="Height" hint="Inches">
          <Input
            value={heightIn}
            inputMode="decimal"
            placeholder="4"
            onChange={(e) => setHeightIn(e.target.value)}
          />
        </Field>
      </div>
      {/* SAID PLAINLY, because a partial answer looks saved and does nothing.
          The card would keep its amber chip with numbers printed under it,
          which reads as the board being broken rather than as a field missing. */}
      <p className="sync-note">
        {complete
          ? 'All four are in, so this order moves to Ready to ship.'
          : 'A carrier prices a case on all four, so the order stays in Awaiting dims until every box has a number. Clearing them all is how a repacked parcel gets measured again.'}
      </p>
    </Modal>
  )
}

/** Nothing to pack. Kept out of the board so an empty state is not four empties. */
export function FulfillmentEmpty(): JSX.Element {
  return <EmptyState icon="PackageCheck" title="Nothing waiting to go out" />
}
