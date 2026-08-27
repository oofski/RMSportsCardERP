import { useState } from 'react'
import type { InvoiceDetail, InvoiceLine } from '@shared/invoices'
import { invoiceTotal, lineAmount, money, qboTotalMismatch } from '@shared/invoices'
import { api } from '../../lib/api'
import { Button, Input, Modal } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { formatMoney } from '../../lib/format'

/**
 * CORRECT THE MONEY ON A SALE THAT IS ALREADY IN QUICKBOOKS.
 *
 * The owner's words: "add an edit button on sales orders that I can edit the
 * price in the software — I know I would have to manually do that in
 * QuickBooks."
 *
 * ## Why this is a separate screen and not the invoice form
 *
 * The invoice form rewrites the whole document — buyer, number, dates, terms,
 * lines added and removed — and is refused the moment an invoice posts,
 * correctly: this app is not the system of record for a document somebody has
 * been billed against. That is an argument against rewriting the document. It
 * is not an argument for the app holding a figure it knows to be wrong, and a
 * price renegotiated after the invoice went out is ordinary trade here.
 *
 * So this screen writes two numbers per line and the total that follows from
 * them, and nothing else exists on it to get wrong.
 *
 * ## It changes no quantity, so it moves no stock
 *
 * The quantity column is deliberately read-only. Selling fewer cases is a
 * different act with different consequences — the shelf, the picking record,
 * the purchase order the cases came out of — and it belongs to the
 * "Fulfilled from" screen, not here. Somebody correcting a price should not be
 * one keystroke away from silently moving inventory.
 *
 * ## The QuickBooks half is said out loud, twice
 *
 * Once before the save, because it is the whole bargain the owner accepted, and
 * once after, on the card, where `qboTotalMismatch` keeps the gap visible until
 * the copy over there is squared. A local edit nobody could see afterwards
 * would be worse than no edit at all.
 */

/** One line's money, as typed. Strings, so a half-typed "12." is not a zero. */
type Draft = { rate: string; amount: string; amountEdited: boolean }

export function EditPricesModal({
  invoice,
  onClose,
  onDone
}: {
  invoice: InvoiceDetail
  onClose: () => void
  onDone: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  /** Line id -> what has been typed. Only the lines somebody touched. */
  const [edits, setEdits] = useState<Record<string, Draft>>({})

  const draftOf = (l: InvoiceLine): Draft =>
    edits[l.id] ?? {
      rate: String(l.rate),
      amount: String(l.amount),
      // True when the stored amount already is not quantity × rate — a price
      // that was agreed rather than calculated. Detected rather than stored, so
      // reopening this screen does not quietly recompute somebody's round
      // number back into arithmetic.
      amountEdited: money(l.amount) !== lineAmount(l.quantity, l.rate)
    }

  const patch = (l: InvoiceLine, next: Partial<Draft>): void =>
    setEdits((prev) => {
      const merged = { ...draftOf(l), ...prev[l.id], ...next }
      // TYPING A RATE RECOMPUTES THE AMOUNT, until somebody takes the amount
      // over. The same rule the invoice form keeps, and the reason is the same:
      // most lines are quantity × rate and re-typing it is a second chance to
      // make them disagree.
      if ('rate' in next && !merged.amountEdited) {
        merged.amount = String(lineAmount(l.quantity, parseFloat(merged.rate) || 0))
      }
      return { ...prev, [l.id]: merged }
    })

  const numOf = (s: string): number => {
    const n = parseFloat(s)
    return Number.isFinite(n) ? money(n) : 0
  }
  /** What a line would be worth if this were saved. */
  const amountOf = (l: InvoiceLine): number => numOf(draftOf(l).amount)

  const changedLines = invoice.lines.filter((l) => {
    const d = draftOf(l)
    return numOf(d.rate) !== money(l.rate) || numOf(d.amount) !== money(l.amount)
  })

  /**
   * WHY SAVE IS REFUSED, said before anybody presses it. A blank or unparseable
   * box is the dangerous one: read as zero it would mark a line free, and the
   * save would look like it worked.
   */
  const problems = invoice.lines
    .map((l) => {
      const d = draftOf(l)
      for (const [what, raw] of [
        ['price', d.rate],
        ['amount', d.amount]
      ] as const) {
        if (raw.trim() === '') return `${l.item}: the ${what} is blank.`
        if (!Number.isFinite(parseFloat(raw))) return `${l.item}: that ${what} is not a number.`
      }
      return null
    })
    .filter((p): p is string => p !== null)

  const newTotal = invoiceTotal(invoice.lines.map((l) => ({ amount: amountOf(l) })))
  const delta = money(newTotal - money(invoice.total))
  /**
   * WHERE QUICKBOOKS ALREADY STANDS, and where it will stand after this.
   *
   * Read before the edit as well as projected after it, because an order can
   * already be out of step — somebody may have corrected Intuit's copy first —
   * and a screen that only ever showed the gap it was about to open would be
   * hiding the one that is already there.
   */
  const gapNow = qboTotalMismatch(invoice)
  const gapAfter = qboTotalMismatch({ ...invoice, total: newTotal })

  const save = async (): Promise<void> => {
    if (changedLines.length === 0 || problems.length > 0) return
    setBusy(true)
    try {
      const res = await api.invoices.setPricing(
        invoice.id,
        changedLines.map((l) => ({
          lineId: l.id,
          rate: numOf(draftOf(l).rate),
          // ALWAYS SENT, never left to follow the rate. This screen knows
          // whether the amount was taken over and the main process does not, so
          // sending the number on the screen is the only version where what
          // somebody typed is what gets stored.
          amount: numOf(draftOf(l).amount)
        }))
      )
      if (!res.ok) {
        toast.error(res.error ?? 'Could not change those prices.')
        return
      }
      toast.success(
        `Prices corrected — order total ${formatMoney(newTotal)}. Change it in QuickBooks too.`
      )
      await onDone()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Edit prices"
      subtitle={`${invoice.invoiceNumber ? `Sales order ${invoice.invoiceNumber}` : 'This sales order'} — your copy only`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="Check"
            disabled={changedLines.length === 0 || problems.length > 0 || busy}
            loading={busy}
            onClick={() => void save()}
          >
            {problems.length > 0
              ? 'Fix the boxes above'
              : changedLines.length === 0
                ? 'Nothing changed'
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
        Quantities are not editable here — changing what a line SELLS moves your stock, and that
        lives on <b>Fulfilled from</b>. This screen only changes money.
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
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((l) => {
            const d = draftOf(l)
            const moved = numOf(d.rate) !== money(l.rate) || numOf(d.amount) !== money(l.amount)
            return (
              <tr key={l.id}>
                <td>
                  <div className="po-line-name">{l.item}</div>
                  {l.sku && <div className="po-line-sub mono">{l.sku}</div>}
                  {/* WAS, in place, on the lines that moved. A total at the
                      bottom says the sale changed; this says which line did
                      and by how much, which is what somebody checking their
                      own work needs. */}
                  {moved && (
                    <div className="po-line-sub">
                      was {formatMoney(l.rate)} each · {formatMoney(l.amount)}
                    </div>
                  )}
                </td>
                <td className="num mono">{l.quantity}</td>
                <td className="num" data-label="Price each">
                  <Input
                    value={d.rate}
                    inputMode="decimal"
                    placeholder="0.00"
                    className="po-price-input"
                    aria-label={`Price each for ${l.item}`}
                    onChange={(e) => patch(l, { rate: e.target.value })}
                  />
                </td>
                <td className="num" data-label="Line total">
                  <Input
                    value={d.amount}
                    inputMode="decimal"
                    placeholder="0.00"
                    className="po-price-input"
                    aria-label={`Line total for ${l.item}`}
                    title={
                      d.amountEdited
                        ? `Agreed price — quantity × price would be ${formatMoney(
                            lineAmount(l.quantity, numOf(d.rate))
                          )}`
                        : undefined
                    }
                    onChange={(e) => patch(l, { amount: e.target.value, amountEdited: true })}
                  />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {problems.length > 0 && (
        <p className="so-price-gap is-bad" role="status">
          <Icon name="AlertTriangle" size={14} />
          <span>{problems[0]}</span>
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
            to <b>{formatMoney(newTotal)}</b>.
          </span>
        </p>
      )}
    </Modal>
  )
}
