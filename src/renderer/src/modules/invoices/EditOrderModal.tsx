import { useState } from 'react'
import type { InvoiceDetail, InvoiceLine } from '@shared/invoices'
import { invoiceTotal, lineAmount, money, qboTotalMismatch } from '@shared/invoices'
import { destinationHoldsStock } from '@shared/purchaseOrders'
import { api } from '../../lib/api'
import { Button, Field, Input, Modal } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { newDraftKey } from '../invoicing/helpers'
import { formatMoney } from '../../lib/format'

/**
 * EDIT A SALES ORDER THAT IS ALREADY IN QUICKBOOKS — quantity and money.
 *
 * The owner's words: "add an edit button on sales orders that I can edit the
 * price in the software — I know I would have to manually do that in
 * QuickBooks." Then: "can we also edit the quantity there, and if there are 2+
 * units, be able to set individual prices if we don't sell them at each."
 *
 * ## Why this is a separate screen and not the invoice form
 *
 * The invoice form rewrites the whole document — buyer, number, dates, terms,
 * class — and reaches QuickBooks, and it is refused the moment an invoice
 * posts, correctly: this app is not the system of record for a document
 * somebody has been billed against. That is an argument against rewriting the
 * document. It is not an argument for the app holding a figure it knows to be
 * wrong, and a price renegotiated after the invoice went out is ordinary trade
 * here.
 *
 * So this screen edits the LINES and nothing else exists on it to get wrong.
 *
 * ## Two prices for the same product is TWO LINES
 *
 * Four cases where two went at $900 and two at $850 is, on any invoice ever
 * written, two lines — so **Split** makes real lines rather than a list of
 * prices hanging off one. That is also the only version somebody can retype
 * into QuickBooks, which is the job this screen hands them.
 *
 * ## Changing a quantity moves stock, and the screen says so before it happens
 *
 * The one thing here with a consequence outside the document. Counted in units
 * and stated in the footer rather than discovered on the inventory screen
 * afterwards — the same courtesy RouteLinesModal pays for the same reason.
 *
 * ## And the QuickBooks half is said out loud, twice
 *
 * Once before the save, because it is the bargain the owner accepted, and once
 * after, on the card, where `qboTotalMismatch` keeps the gap visible until the
 * copy over there is squared.
 */

/**
 * ## WHAT THIS SCREEN BECAME
 *
 * The owner, looking at nine buttons on one card: "I just really need a way to
 * edit to sales order at any point, add in dimensions ... the edit button should
 * let me do a lot to the sales order too right that is all we need in that case".
 *
 * So three things changed. It opens on a DRAFT now — the gate that hid it there
 * was a line in the card, not a rule in the backend, and `setInvoiceLines`,
 * `setInvoiceDims` and `setInvoiceLineRouting` all sit behind `liveInvoiceOr`,
 * which refuses only gone and void. It carries the MEASUREMENTS, which until now
 * could be entered once from the fulfilment tick and then never corrected: once
 * an order is measured the tick disappears, so a wrong weight was unfixable from
 * the board even though the backend would have taken it. And it is the door to
 * the three screens that used to have buttons of their own on the card.
 *
 * ## THOSE THREE ARE HAND-OFFS, NOT SECTIONS, AND THAT IS DELIBERATE
 *
 * Routing, the attached purchases and re-taking the shelf each have their own
 * save and their own consequences, and `setInvoiceLines` CLEARS a line's
 * per-case sourcing whenever its quantity moves. Folding routing into this
 * screen's Save would mean one press where the order of two writes decides
 * whether somebody's allocations survive — and there is no ordering that is
 * right in both directions. A hand-off closes this screen and opens that one, so
 * each save stays one press about one thing.
 */

/** One part of a line, as typed. Strings, so a half-typed "12." is not a zero. */
type Part = { key: string; quantity: string; rate: string; amount: string; amountEdited: boolean }
/** A line's whole state on this screen. One part means it is not split. */
type Draft = { parts: Part[]; removed: boolean }

export function EditOrderModal({
  invoice,
  onClose,
  onDone,
  onRoute,
  onAttachPo,
  onBookStock
}: {
  invoice: InvoiceDetail
  onClose: () => void
  onDone: () => void | Promise<void>
  /** Hand off to the routing screen. See the header on why this is a hand-off. */
  onRoute?: () => void
  /** Hand off to the purchase-order attach screen. */
  onAttachPo?: () => void
  /** Re-take the shelf for this order. Resolves once the write has finished. */
  onBookStock?: () => Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  /** Line id -> what has been typed. Only the lines somebody touched. */
  const [edits, setEdits] = useState<Record<string, Draft>>({})
  /**
   * THE PARCEL, as typed. Strings for the same reason the line boxes are: a
   * half-typed "12." must not read as twelve, and an empty box must not read as
   * zero — `setInvoiceDims` treats all four blank as "un-measure this", which is
   * the way back for a parcel that was repacked.
   */
  const dimStr = (v: number | null): string => (v == null ? '' : String(v))
  const [weightLb, setWeightLb] = useState(dimStr(invoice.weightLb))
  const [lengthIn, setLengthIn] = useState(dimStr(invoice.lengthIn))
  const [widthIn, setWidthIn] = useState(dimStr(invoice.widthIn))
  const [heightIn, setHeightIn] = useState(dimStr(invoice.heightIn))
  const [booking, setBooking] = useState(false)

  const storedDraft = (l: InvoiceLine): Draft => ({
    parts: [
      {
        key: l.id,
        quantity: String(l.quantity),
        rate: String(l.rate),
        amount: String(l.amount),
        // True when the stored amount already is not quantity × rate — a price
        // that was agreed rather than calculated. Detected rather than stored,
        // so reopening this screen does not quietly recompute somebody's round
        // number back into arithmetic.
        amountEdited: money(l.amount) !== lineAmount(l.quantity, l.rate)
      }
    ],
    removed: false
  })
  const draftOf = (l: InvoiceLine): Draft => edits[l.id] ?? storedDraft(l)
  const setDraft = (l: InvoiceLine, next: Draft): void =>
    setEdits((prev) => ({ ...prev, [l.id]: next }))

  const patchPart = (l: InvoiceLine, key: string, next: Partial<Part>): void => {
    const d = draftOf(l)
    setDraft(l, {
      ...d,
      parts: d.parts.map((p) => {
        if (p.key !== key) return p
        const merged = { ...p, ...next }
        // TYPING A QUANTITY OR A PRICE RECOMPUTES THE AMOUNT, until somebody
        // takes the amount over. The same rule the invoice form keeps, and the
        // reason is the same: most lines are quantity × rate, and re-typing it
        // is a second chance to make the two disagree.
        if (('rate' in next || 'quantity' in next) && !merged.amountEdited) {
          merged.amount = String(
            lineAmount(parseFloat(merged.quantity) || 0, parseFloat(merged.rate) || 0)
          )
        }
        return merged
      })
    })
  }

  const num = (s: string): number => {
    const n = parseFloat(s)
    return Number.isFinite(n) ? money(n) : 0
  }

  /** Every part on the order that will still exist after saving. */
  const livingParts = (l: InvoiceLine): Part[] => {
    const d = draftOf(l)
    return d.removed ? [] : d.parts
  }

  const changedLines = invoice.lines.filter((l) => {
    const d = draftOf(l)
    if (d.removed) return true
    if (d.parts.length !== 1) return true
    const p = d.parts[0]
    return (
      num(p.quantity) !== l.quantity ||
      num(p.rate) !== money(l.rate) ||
      num(p.amount) !== money(l.amount)
    )
  })

  /**
   * WHY SAVE IS REFUSED, said before anybody presses it. A blank box is the
   * dangerous one: read as zero it would mark a line free, or empty, and the
   * save would look like it worked.
   */
  const problems: string[] = []
  for (const l of invoice.lines) {
    for (const p of livingParts(l)) {
      for (const [what, raw] of [
        ['quantity', p.quantity],
        ['price', p.rate],
        ['line total', p.amount]
      ] as const) {
        if (raw.trim() === '') problems.push(`${l.item}: the ${what} is blank.`)
        else if (!Number.isFinite(parseFloat(raw))) {
          problems.push(`${l.item}: that ${what} is not a number.`)
        }
      }
      if (p.quantity.trim() !== '' && num(p.quantity) <= 0) {
        problems.push(`${l.item}: a line has to sell at least something. Remove it instead.`)
      }
    }
  }
  if (invoice.lines.every((l) => livingParts(l).length === 0)) {
    problems.push('An order has to have at least one line. Void it instead of emptying it.')
  }

  const newTotal = invoiceTotal(
    invoice.lines.flatMap((l) => livingParts(l).map((p) => ({ amount: num(p.amount) })))
  )
  const delta = money(newTotal - money(invoice.total))

  /**
   * WHAT THE SHELF WILL DO, said before it happens rather than discovered
   * after. Counted in UNITS on the lines that actually draw one — a dropship
   * line's quantity can move all day without a box shifting anywhere.
   */
  let offTheShelf = 0
  let backToShelf = 0
  for (const l of invoice.lines) {
    if (!l.productId) continue
    if (!destinationHoldsStock(l.destination)) continue
    const was = l.quantity
    const now = livingParts(l).reduce((sum, p) => sum + num(p.quantity), 0)
    if (now > was) offTheShelf += now - was
    if (was > now) backToShelf += was - now
  }
  /** True once any line has been broken into parts that were not there before. */
  const splitting = invoice.lines.some((l) => !draftOf(l).removed && draftOf(l).parts.length > 1)
  /** Lines whose per-case sourcing this save will clear. See setInvoiceLines. */
  const losingSourcing = invoice.lines.filter((l) => {
    if (l.allocations.length === 0) return false
    const d = draftOf(l)
    if (d.removed || d.parts.length > 1) return true
    return num(d.parts[0].quantity) !== l.quantity
  })

  /**
   * THE MEASUREMENTS, and the one rule they have.
   *
   * All four or none. `hasDims` reads a partial set as unmeasured because a
   * carrier prices a case on dimensional weight, so three of the four buys
   * nothing — and a screen that let somebody save three would leave them
   * believing the parcel was done. The same rule DimsModal keeps; this is a
   * second door onto one whole-set overwrite, not a second half of it.
   */
  const dimNum = (v: string): number | null => {
    const n = parseFloat(v)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const dimFields = [weightLb, lengthIn, widthIn, heightIn]
  const dimsFilled = dimFields.filter((v) => dimNum(v) !== null).length
  const dimsChanged =
    dimNum(weightLb) !== invoice.weightLb ||
    dimNum(lengthIn) !== invoice.lengthIn ||
    dimNum(widthIn) !== invoice.widthIn ||
    dimNum(heightIn) !== invoice.heightIn
  if (dimsFilled > 0 && dimsFilled < 4) {
    problems.push('A parcel needs all four measurements, or none — a carrier prices on all of them.')
  }

  const gapNow = qboTotalMismatch(invoice)
  const gapAfter = qboTotalMismatch({ ...invoice, total: newTotal })

  /** Anything at all to save. Lines or the parcel — either alone is enough. */
  const touched = changedLines.length > 0 || dimsChanged

  const save = async (): Promise<void> => {
    if (!touched || problems.length > 0) return
    setBusy(true)
    try {
      // THE PARCEL FIRST, and only when it moved. It is the write with no
      // consequences beyond its own four columns, so getting it in before the
      // one that re-derives stock means a failure on the lines cannot leave a
      // measurement half-applied. An untouched parcel is not written at all —
      // sending it would stamp the order for nothing.
      if (dimsChanged) {
        const dims = await api.invoices.setDims(invoice.id, {
          weightLb: dimNum(weightLb),
          lengthIn: dimNum(lengthIn),
          widthIn: dimNum(widthIn),
          heightIn: dimNum(heightIn)
        })
        if (!dims.ok) {
          toast.error(dims.error ?? 'Could not save the measurements.')
          return
        }
      }
      if (changedLines.length === 0) {
        toast.success('Measurements saved.')
        await onDone()
        onClose()
        return
      }
      const res = await api.invoices.setLines(
        invoice.id,
        changedLines.map((l) => {
          const d = draftOf(l)
          if (d.removed) return { lineId: l.id, remove: true }
          if (d.parts.length > 1) {
            return {
              lineId: l.id,
              splitInto: d.parts.map((p) => ({
                quantity: num(p.quantity),
                rate: num(p.rate),
                amount: num(p.amount)
              }))
            }
          }
          const p = d.parts[0]
          return {
            lineId: l.id,
            quantity: num(p.quantity),
            rate: num(p.rate),
            // ALWAYS SENT, never left to follow the rate. This screen knows
            // whether the amount was taken over and the main process does not,
            // so sending the number on the screen is the only version where
            // what somebody typed is what gets stored.
            amount: num(p.amount)
          }
        })
      )
      if (!res.ok) {
        toast.error(res.error ?? 'Could not save those changes.')
        return
      }
      /**
       * ASK QUICKBOOKS WHERE IT STANDS, right now, before saying anything about
       * a gap.
       *
       * `qbo_total_amt` is what the sweep last READ, which on a busy order can
       * be days old — so without this the card would open a difference against
       * a stale figure and go on asserting it after the operator had already
       * corrected Intuit. One invoice, best effort: the save is already
       * committed, and a reading that fails never overwrites one that worked.
       */
      if (invoice.qboId) await api.invoices.syncQboStatus(invoice.id).catch(() => undefined)
      toast.success(
        `Order updated — total ${formatMoney(newTotal)}. Change it in QuickBooks too.`
      )
      await onDone()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Edit this order"
      subtitle={`${invoice.invoiceNumber ? `Sales order ${invoice.invoiceNumber}` : 'This sales order'}${
        invoice.status === 'draft' ? ' — still a draft' : ' — your copy only'
      }`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="Check"
            disabled={!touched || problems.length > 0 || busy}
            loading={busy}
            onClick={() => void save()}
          >
            {problems.length > 0
              ? 'Fix the boxes above'
              : !touched
                ? 'Nothing changed'
                : changedLines.length === 0
                  ? 'Save the measurements'
                  : `Save — total ${formatMoney(newTotal)}`}
          </Button>
        </>
      }
    >
      {/* THE BARGAIN, said before anything is typed. The owner already knows
          it — he said it himself asking for this — but he is not the only
          person who will ever open this screen. */}
      <p className="fin-confirm-lead">
        <b>This changes your copy, not QuickBooks.</b> There is no way to update an invoice that has
        already posted, so whatever you set here has to be changed in QuickBooks by hand as well. The
        card will keep showing the difference until the two agree.
      </p>
      <p className="fin-confirm-lead">
        Sold some at one price and the rest at another? <b>Split</b> the line — each part becomes its
        own line with its own quantity and price, which is how it would be written on the invoice
        anyway.
      </p>

      {gapNow !== null && (
        <p className="so-price-gap" role="status">
          <Icon name="AlertTriangle" size={14} />
          <span>
            QuickBooks already says <b>{formatMoney(money(invoice.qboTotalAmt ?? 0))}</b> for this
            order, {formatMoney(Math.abs(gapNow))} {gapNow > 0 ? 'less' : 'more'} than your copy.
          </span>
        </p>
      )}

      <table className="data po-lines-table">
        <thead>
          <tr>
            <th>Line</th>
            <th className="num">Qty</th>
            <th className="num">Price each</th>
            <th className="num">Line total</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((l) => {
            const d = draftOf(l)
            const split = d.parts.length > 1
            return d.parts.map((p, i) => (
              <tr key={p.key} className={d.removed ? 'so-line-removed' : undefined}>
                <td>
                  {i === 0 ? (
                    <>
                      <div className="po-line-name">{l.item}</div>
                      {l.sku && <div className="po-line-sub mono">{l.sku}</div>}
                      {/* WAS, in place, on the lines that moved. A total at the
                          bottom says the sale changed; this says which line did
                          and by how much, which is what somebody checking their
                          own work needs. */}
                      <div className="po-line-sub">
                        was {l.quantity} × {formatMoney(l.rate)} · {formatMoney(l.amount)}
                      </div>
                    </>
                  ) : (
                    <div className="po-line-sub so-line-part">
                      <Icon name="ChevronRight" size={12} /> {l.item} — part {i + 1}
                    </div>
                  )}
                </td>
                <td className="num" data-label="Qty">
                  <Input
                    value={p.quantity}
                    inputMode="decimal"
                    placeholder="0"
                    className="po-price-input"
                    disabled={d.removed}
                    aria-label={`Quantity for ${l.item}${split ? `, part ${i + 1}` : ''}`}
                    onChange={(e) => patchPart(l, p.key, { quantity: e.target.value })}
                  />
                </td>
                <td className="num" data-label="Price each">
                  <Input
                    value={p.rate}
                    inputMode="decimal"
                    placeholder="0.00"
                    className="po-price-input"
                    disabled={d.removed}
                    aria-label={`Price each for ${l.item}${split ? `, part ${i + 1}` : ''}`}
                    onChange={(e) => patchPart(l, p.key, { rate: e.target.value })}
                  />
                </td>
                <td className="num" data-label="Line total">
                  <Input
                    value={p.amount}
                    inputMode="decimal"
                    placeholder="0.00"
                    className="po-price-input"
                    disabled={d.removed}
                    aria-label={`Line total for ${l.item}${split ? `, part ${i + 1}` : ''}`}
                    title={
                      p.amountEdited
                        ? `Agreed price — quantity × price would be ${formatMoney(
                            lineAmount(num(p.quantity), num(p.rate))
                          )}`
                        : undefined
                    }
                    onChange={(e) => patchPart(l, p.key, { amount: e.target.value, amountEdited: true })}
                  />
                </td>
                <td className="so-line-acts">
                  {/* SPLIT IS OFFERED ONLY ON A LINE OF MORE THAN ONE UNIT.
                      Breaking a single case into two prices has no meaning it
                      could express. */}
                  {i === 0 && !d.removed && !split && num(p.quantity) > 1 && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      title="Sell some of these at a different price"
                      aria-label={`Split ${l.item} into two prices`}
                      onClick={() => {
                        const q = num(p.quantity)
                        const keep = Math.max(1, Math.floor(q) - 1)
                        setDraft(l, {
                          removed: false,
                          parts: [
                            { ...p, quantity: String(keep), amount: String(lineAmount(keep, num(p.rate))) },
                            {
                              key: newDraftKey(),
                              quantity: String(money(q - keep)),
                              rate: p.rate,
                              amount: String(lineAmount(q - keep, num(p.rate))),
                              amountEdited: false
                            }
                          ]
                        })
                      }}
                    >
                      <Icon name="Split" size={14} />
                    </button>
                  )}
                  {/* A PART CAN BE TAKEN BACK OFF, which is what makes a split
                      made by mistake recoverable. Without it the only repair
                      would be editing the database by hand. */}
                  {split && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      title="Remove this part"
                      aria-label={`Remove part ${i + 1} of ${l.item}`}
                      onClick={() =>
                        setDraft(l, {
                          ...d,
                          parts: d.parts.filter((r) => r.key !== p.key)
                        })
                      }
                    >
                      <Icon name="Trash2" size={14} />
                    </button>
                  )}
                  {i === 0 && !split && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      title={d.removed ? 'Put this line back' : 'Take this line off the order'}
                      aria-label={`${d.removed ? 'Restore' : 'Remove'} ${l.item}`}
                      onClick={() => setDraft(l, { ...d, removed: !d.removed })}
                    >
                      <Icon name={d.removed ? 'RotateCcw' : 'Trash2'} size={14} />
                    </button>
                  )}
                </td>
              </tr>
            ))
          })}
        </tbody>
      </table>

      {problems.length > 0 && (
        <p className="so-price-gap is-bad" role="status">
          <Icon name="AlertTriangle" size={14} />
          <span>{problems[0]}</span>
        </p>
      )}

      {(offTheShelf > 0 || backToShelf > 0) && (
        <p className="fin-confirm-lead">
          <b>Your stock will move.</b>
          {offTheShelf > 0 && (
            <>
              {' '}
              <b>{offTheShelf}</b> more unit{offTheShelf === 1 ? '' : 's'} come off the shelf.
            </>
          )}
          {backToShelf > 0 && (
            <>
              {' '}
              <b>{backToShelf}</b> unit{backToShelf === 1 ? '' : 's'} go back on the shelf.
            </>
          )}
        </p>
      )}

      {losingSourcing.length > 0 && (
        <p className="so-price-gap" role="status">
          <Icon name="AlertTriangle" size={14} />
          <span>
            {losingSourcing.map((l) => l.item).join(', ')} had its cases split across places on{' '}
            <b>Fulfilled from</b>. Those splits have to add up to the line, so changing the quantity
            clears them — set them again afterwards if you need to.
          </span>
        </p>
      )}

      <div className="so-price-total">
        <span>Order total</span>
        <b className="mono">{formatMoney(newTotal)}</b>
        {delta !== 0 && (
          <span className="so-price-delta">
            {delta > 0 ? '+' : '−'}
            {formatMoney(Math.abs(delta))} from {formatMoney(money(invoice.total))}
          </span>
        )}
      </div>

      {gapAfter !== null && changedLines.length > 0 && (
        <p className="so-price-gap" role="status">
          <Icon name="AlertTriangle" size={14} />
          <span>
            After saving, QuickBooks will be {formatMoney(Math.abs(gapAfter))}{' '}
            {gapAfter > 0 ? 'lower' : 'higher'} than this. Open the invoice in QuickBooks and set it
            to <b>{formatMoney(newTotal)}</b>
            {splitting ? ', with the lines split the same way.' : '.'}
          </span>
        </p>
      )}

      {/* THE PARCEL. Never on this screen before, and only enterable once
          anywhere else: the fulfilment tick offers "Measure" while an order is
          waiting for it, and the moment it is measured the tick goes. A weight
          typed wrong was therefore unfixable from the board, though the backend
          would have taken the correction all along. Saved by the same whole-set
          overwrite, so a second door cannot half-apply what the first stored. */}
      <div className="so-edit-section">
        <h4>Box and weight</h4>
        <p className="p-sub">
          What the carrier prices on. All four or none — leave them all empty to un-measure a parcel
          that has been repacked.
        </p>
        <div className="so-dims-grid">
          <Field label="Weight (lb)">
            <Input
              value={weightLb}
              inputMode="decimal"
              placeholder="0"
              onChange={(e) => setWeightLb(e.target.value)}
            />
          </Field>
          <Field label="Length (in)">
            <Input
              value={lengthIn}
              inputMode="decimal"
              placeholder="0"
              onChange={(e) => setLengthIn(e.target.value)}
            />
          </Field>
          <Field label="Width (in)">
            <Input
              value={widthIn}
              inputMode="decimal"
              placeholder="0"
              onChange={(e) => setWidthIn(e.target.value)}
            />
          </Field>
          <Field label="Height (in)">
            <Input
              value={heightIn}
              inputMode="decimal"
              placeholder="0"
              onChange={(e) => setHeightIn(e.target.value)}
            />
          </Field>
        </div>
      </div>

      {/* THE REST OF THE ORDER, handed off rather than absorbed. See the header:
          each of these has its own save and its own consequences, and folding
          them into this screen's one press would make the ORDER of two writes
          decide whether somebody's per-case sourcing survives.

          They are here because they used to be three more buttons on a card that
          had nine. Edit is the screen you open to change this order, so this is
          where the things that change it belong — one press further away than
          before, and off a card that is now readable. */}
      {(onRoute || onAttachPo || onBookStock) && (
        <div className="so-edit-section">
          <h4>The rest of this order</h4>
          <div className="so-edit-links">
            {onRoute && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  onClose()
                  onRoute()
                }}
              >
                <Icon name="Route" size={14} />
                Where these come from…
              </button>
            )}
            {onAttachPo && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  onClose()
                  onAttachPo()
                }}
              >
                <Icon name="Link" size={14} />
                {invoice.sourcePoCount === 0
                  ? 'Attach a purchase order…'
                  : invoice.sourcePoCount === 1
                    ? 'Purchase order · 1'
                    : `Purchase orders · ${invoice.sourcePoCount}`}
              </button>
            )}
            {/* NOT A HAND-OFF — there is no screen behind it, only a write. It
                stays on this one and reports what it did, because the whole
                point of it is an order whose stock ledger is empty and where
                "nothing was booked" is a different answer from "done". */}
            {onBookStock && invoice.status !== 'draft' && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={booking || busy}
                title="Take the stock for this order against today's shelf — for an order sold before its goods arrived"
                onClick={async () => {
                  setBooking(true)
                  try {
                    await onBookStock()
                  } finally {
                    setBooking(false)
                  }
                }}
              >
                <Icon name="PackageCheck" size={14} />
                {booking ? 'Booking…' : 'Take the stock again'}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
