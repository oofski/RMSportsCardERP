import { useEffect, useMemo, useState } from 'react'
import type { WholesaleSaleRow } from '@shared/invoices'
import { Icon } from '../../components/Icon'
import { CenterLoader, EmptyState, Input } from '../../components/ui'
import { Money } from './bits'
import { finance } from './api'

/**
 * Finance → Wholesale: what went out on sales orders, and what it cost us.
 *
 * ## Why this can exist now, and could not before
 *
 * The tab said "not built yet" for five releases, and the reason was honest: a
 * sales order was paperwork. It named products and quantities and moved nothing,
 * so there was no cost attached to anything sold off-stream and any margin on
 * this page would have been invented.
 *
 * Saving an order now consumes FIFO layers — the oldest boxes first, exactly as
 * a counter sale does — and records which layers it took. So every row below is
 * a subtraction between two numbers the app actually holds: what the buyer was
 * charged, and what those specific boxes cost when they were bought.
 *
 * ## One row per LINE
 *
 * Not per order. An order may list the same box twice at two prices — three at
 * trade, three at retail — and rolling those together would report one margin
 * that is neither of theirs. The line is the finest grain the app records and
 * every total on this page is a sum of these rows, so nothing here is derived
 * twice.
 *
 * ## The quantity is what LEFT, not what was ordered
 *
 * An order for ten against a shelf of six takes six; the other four go out when
 * the stock lands. Reporting the ordered quantity against the cost of six would
 * show a margin nobody earned. The four appear here on the day they leave.
 *
 * ## Rows whose cost is not knowable
 *
 * Anything shipped before this became a sale — a line a picker scanned out under
 * the old fulfilment model — has no record of which layers it took. Those rows
 * are shown with their cost struck out and are EXCLUDED from the totals, rather
 * than counted at zero cost. Counting them would overstate the month's profit by
 * their entire revenue, which is the one failure a finance screen must not have.
 *
 * ## AND ROWS NOBODY HAS PRICED YET, which look identical and are not
 *
 * A roadshow case is bought on a tab at a price the shop has not given and can
 * be sold the same afternoon. Its layer sits at zero, so the sale arrived here
 * reporting the entire sale price as margin — and unlike a legacy row it was not
 * marked, because from the report's side both are simply a cost of nothing.
 *
 * They are held out of the margin totals on exactly the reasoning above, and
 * named: the row says which tab is still owing a price, because this is the one
 * of the two that somebody can go and fix. Pricing that line re-costs the layer
 * AND this sale with it, and the row rejoins the totals with a real margin.
 */
export function WholesaleTab(): JSX.Element {
  const [rows, setRows] = useState<WholesaleSaleRow[] | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let alive = true
    void finance.wholesale().then((r) => {
      if (alive) setRows(r)
    })
    return () => {
      alive = false
    }
  }, [])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q || !rows) return rows ?? []
    return rows.filter((r) =>
      [r.productName, r.sku, r.customerName, r.invoiceNumber].some((v) =>
        (v ?? '').toLowerCase().includes(q)
      )
    )
  }, [rows, query])

  // Totals follow WHAT IS ON SCREEN, so a search narrows the summary with the
  // table. A header that kept reporting the whole file while the rows below it
  // showed one customer is a number nobody can reconcile against anything.
  const totals = useMemo(() => {
    // TWO REASONS A COST CAN BE MISSING, and both are held out of the margin.
    // They are counted separately because only one of them is a job: a legacy
    // row will never have a figure, and an unpriced tab line is waiting for one.
    const priced = shown.filter((r) => r.costKnown && !r.costPending)
    const pending = shown.filter((r) => r.costKnown && r.costPending)
    const sum = (list: WholesaleSaleRow[], pick: (r: WholesaleSaleRow) => number): number =>
      Math.round(list.reduce((n, r) => n + pick(r), 0) * 100) / 100
    const tabs = [...new Set(pending.map((r) => r.pendingPoNumber ?? '').filter(Boolean))].sort()
    return {
      units: shown.reduce((n, r) => n + r.quantity, 0),
      revenue: sum(shown, (r) => r.revenue),
      pricedRevenue: sum(priced, (r) => r.revenue),
      cost: sum(priced, (r) => r.cost),
      margin: sum(priced, (r) => r.margin),
      unpriced: shown.filter((r) => !r.costKnown).length,
      pending: pending.length,
      pendingRevenue: sum(pending, (r) => r.revenue),
      pendingTabs: tabs
    }
  }, [shown])

  if (rows === null) return <CenterLoader />

  if (rows.length === 0) {
    return (
      <EmptyState
        icon="Boxes"
        title="Nothing has been sold wholesale yet"
        message="Every product line on a sales order appears here the moment the order is saved, with what those exact boxes cost."
      />
    )
  }

  const pct = totals.pricedRevenue > 0 ? (totals.margin / totals.pricedRevenue) * 100 : null

  return (
    <div className="wsale">
      <div className="wsale-tiles">
        <Tile label="Units out" value={String(totals.units)} />
        <Tile label="Sold for" value={<Money value={totals.revenue} />} />
        <Tile label="Cost of those boxes" value={<Money value={totals.cost} cost />} />
        <Tile
          label="Margin"
          value={<Money value={totals.margin} strong />}
          sub={pct === null ? undefined : `${pct.toFixed(1)}% of what was charged`}
        />
      </div>

      {/* THE ONE THAT IS A JOB, said first and said in money. Pricing the tab
          re-costs these sales, so this is a number that comes back rather than a
          number that is lost — the opposite of the note below it. */}
      {totals.pending > 0 && (
        <p className="wsale-note is-todo">
          <Icon name="Clock" size={14} />
          <Money value={totals.pendingRevenue} /> of this was sold out of a roadshow tab the shop
          has not priced yet, over {totals.pending} line{totals.pending === 1 ? '' : 's'}. Until
          {totals.pendingTabs.length > 0
            ? ` ${totals.pendingTabs.join(', ')} ${totals.pendingTabs.length === 1 ? 'is' : 'are'} priced`
            : ' those lines are priced'}
          , their cost of goods is nothing — so they are listed but left out of the cost and margin
          above. Filling the price in on the tab corrects both the shelf and these sales.
        </p>
      )}

      {totals.unpriced > 0 && (
        <p className="wsale-note">
          <Icon name="AlertTriangle" size={14} />
          {totals.unpriced} line{totals.unpriced === 1 ? '' : 's'} shipped before orders took their
          own stock, so the boxes behind {totals.unpriced === 1 ? 'it' : 'them'} cannot be priced.
          Those rows are listed but left out of every total above.
        </p>
      )}

      <div className="wsale-search">
        <Icon name="Search" size={15} />
        <Input
          placeholder="Product, SKU, customer or order number…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="table-wrap">
        <table className="data wsale-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Order</th>
              <th>Customer</th>
              <th>Product</th>
              <th className="num">Qty</th>
              <th className="num">Sold at</th>
              <th className="num">Sold for</th>
              <th className="num">Cost</th>
              <th className="num">Margin</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={`${r.invoiceId}-${r.productId}-${i}`}>
                <td className="wsale-date">{r.invoiceDate}</td>
                <td>{r.invoiceNumber || '—'}</td>
                <td>{r.customerName || '—'}</td>
                <td>
                  <span className="wsale-prod">{r.productName}</span>
                  {r.sku && <span className="wsale-sku">{r.sku}</span>}
                </td>
                <td className="num">{r.quantity}</td>
                <td className="num">
                  <Money value={r.unitPrice} />
                </td>
                <td className="num">
                  <Money value={r.revenue} />
                </td>
                <td className="num">
                  {!r.costKnown ? (
                    <span className="wsale-unknown" title="Shipped before orders took their own stock">
                      not recorded
                    </span>
                  ) : r.costPending ? (
                    /* NOT "$0.00". The layer is real and the figure is coming;
                       printing a zero here is what made a roadshow case read as
                       pure profit on the one screen that reports margin. */
                    <span
                      className="wsale-toprice"
                      title={`Bought on ${r.pendingPoNumber ?? 'a roadshow tab'} at a price the shop has not given yet. Price that line and this cost fills itself in.`}
                    >
                      {r.pendingPoNumber ? `on ${r.pendingPoNumber}` : 'to come'}
                    </span>
                  ) : (
                    <Money value={r.cost} cost />
                  )}
                </td>
                <td className="num">
                  {r.costKnown && !r.costPending ? (
                    <Money value={r.margin} strong />
                  ) : (
                    <span className="wsale-unknown">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Tile({
  label,
  value,
  sub
}: {
  label: string
  value: JSX.Element | string
  sub?: string
}): JSX.Element {
  return (
    <div className="wsale-tile">
      <div className="wsale-tile-label">{label}</div>
      <div className="wsale-tile-value">{value}</div>
      {sub && <div className="wsale-tile-sub">{sub}</div>}
    </div>
  )
}
