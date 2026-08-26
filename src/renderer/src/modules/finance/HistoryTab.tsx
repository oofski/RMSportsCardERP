import { useEffect, useMemo, useState } from 'react'
import type {
  OrderHistoryLine,
  PurchaseOrderHistoryRow,
  SalesOrderHistoryRow
} from '@shared/orderHistory'
import { Icon } from '../../components/Icon'
import { CenterLoader, EmptyState, Input } from '../../components/ui'
import { Money } from './bits'
import { finance } from './api'
import { DealTicketsTab } from './DealTicketsTab'

/**
 * Finance → History: the year's ledger of orders, both sides.
 *
 * ## Why this exists
 *
 * A board is a place where work is done. A purchase order that has been paid for
 * AND received has no work left on it, so it spends a day in the board's
 * Completed column and then leaves — long enough for the short shipment that
 * turns up the next morning or the cancel somebody wants back, short enough that
 * finished orders stop crowding the ones that still need something. This is
 * where it goes.
 *
 * Nothing is deleted. Every line, date, price and tracking number is still on
 * the row, and the FIFO cost layers those receipts opened still point at it.
 *
 * ## It lists LIVE orders too
 *
 * It would read more tidily as "the board has the live work, this has the rest",
 * and it would be wrong the first time somebody looks up PO-0042 and cannot find
 * it because it happens to be in transit. A ledger of the year is a ledger of the
 * year; the stage is on the row, so a live order is visibly live and a settled
 * one says so.
 *
 * ## One table, two sides
 *
 * A purchase order and a sales order are mirror images — a party, some lines, a
 * total, some dates — so they are one component with different columns. The row
 * expands in place rather than opening anything: the question being asked is
 * "what was on it", and that is four lines of text, not a screen.
 */
/**
 * The third value is not a third KIND of order — it is the same movements read
 * by their deal ticket instead of by their document. It lives beside the other
 * two because that is where somebody goes looking for an order they can only
 * name by its ticket, and it renders its own component because it shares none of
 * the columns, expansion or totals the two document views share.
 */
type Side = 'purchase' | 'sales' | 'tickets'

export function HistoryTab(): JSX.Element {
  const [side, setSide] = useState<Side>('purchase')
  const [years, setYears] = useState<{ purchase: number[]; sales: number[] } | null>(null)
  const [year, setYear] = useState<number | null>(null)
  const [pos, setPos] = useState<PurchaseOrderHistoryRow[] | null>(null)
  const [sos, setSos] = useState<SalesOrderHistoryRow[] | null>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  /**
   * The register's own years, and its own selected year.
   *
   * SEPARATE from `year` on purpose. The register starts at DT-000337 with no
   * history behind it, so it covers a different — usually much shorter — set of
   * years than the order ledger does. Sharing one selection would open the
   * tickets view on a year it has nothing in and read as broken.
   */
  const [ticketYears, setTicketYears] = useState<{ years: number[]; next: string } | null>(null)
  const [ticketYear, setTicketYear] = useState<number | null>(null)

  useEffect(() => {
    void finance.historyYears().then((y) => {
      setYears(y)
      // Land on the newest year that HAS something, per side, rather than on
      // today — a January morning would otherwise open on an empty sheet.
      setYear((y.purchase[0] ?? y.sales[0]) ?? new Date().getFullYear())
    })
  }, [])

  /**
   * The register's years, fetched the first time the tab is opened.
   *
   * LAZY, unlike the order years above. Every visit to Finance → History pays
   * for that call; this one is only owed by somebody who actually asks for the
   * register, and the answer does not change while they are looking at it.
   */
  useEffect(() => {
    if (side !== 'tickets' || ticketYears !== null) return
    void finance.dealTicketYears().then((r) => {
      setTicketYears(r)
      // dealTicketYears always includes the current year, so this cannot leave
      // the view with nothing selected on a register that has issued nothing.
      setTicketYear(r.years[0] ?? new Date().getFullYear())
    })
  }, [side, ticketYears])

  // Re-read on every (side, year) change. Both lists are kept so flipping back
  // and forth does not refetch, and both are cleared when the year moves.
  useEffect(() => {
    if (year === null) return
    // The register fetches its own rows from its own year — see DealTicketsTab.
    // Without this guard the sales branch below would fire a second, pointless
    // read of the whole sales ledger every time somebody opened the tickets tab.
    if (side === 'tickets') return
    let alive = true
    if (side === 'purchase') {
      setPos(null)
      void finance.historyPurchaseOrders(year).then((r) => alive && setPos(r))
    } else {
      setSos(null)
      void finance.historySalesOrders(year).then((r) => alive && setSos(r))
    }
    return () => {
      alive = false
    }
  }, [side, year])

  const yearsFor =
    side === 'tickets'
      ? (ticketYears?.years ?? [])
      : side === 'purchase'
        ? (years?.purchase ?? [])
        : (years?.sales ?? [])
  const activeYear = side === 'tickets' ? ticketYear : year
  const rows: Array<PurchaseOrderHistoryRow | SalesOrderHistoryRow> | null =
    side === 'purchase' ? pos : sos

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!rows) return []
    if (!q) return rows
    return rows.filter((r) => {
      const party = 'supplier' in r ? (r.supplier ?? '') : r.customerName
      return (
        r.number.toLowerCase().includes(q) ||
        party.toLowerCase().includes(q) ||
        r.lines.some((l) => `${l.item} ${l.sku ?? ''}`.toLowerCase().includes(q))
      )
    })
  }, [rows, query])

  const totals = useMemo(() => {
    const value = shown.reduce((n, r) => n + r.total, 0)
    return { count: shown.length, value: Math.round(value * 100) / 100 }
  }, [shown])

  if (years === null || year === null) return <CenterLoader />

  return (
    <div className="hist">
      <div className="hist-bar">
        <div className="hist-sides">
          <button
            className={`hist-side ${side === 'purchase' ? 'active' : ''}`}
            onClick={() => {
              setSide('purchase')
              setOpen(null)
            }}
          >
            <Icon name="ClipboardList" size={15} />
            Purchase orders
          </button>
          <button
            className={`hist-side ${side === 'sales' ? 'active' : ''}`}
            onClick={() => {
              setSide('sales')
              setOpen(null)
            }}
          >
            <Icon name="ReceiptText" size={15} />
            Sales orders
          </button>
          <button
            className={`hist-side ${side === 'tickets' ? 'active' : ''}`}
            onClick={() => {
              setSide('tickets')
              setOpen(null)
            }}
          >
            <Icon name="Hash" size={15} />
            Deal tickets
          </button>
        </div>

        <div className="hist-years">
          {yearsFor.map((y) => (
            <button
              key={y}
              className={`hist-year ${y === activeYear ? 'active' : ''}`}
              onClick={() => {
                if (side === 'tickets') setTicketYear(y)
                else setYear(y)
                setOpen(null)
              }}
            >
              {y}
            </button>
          ))}
        </div>

        <div className="hist-search">
          <Icon name="Search" size={15} />
          <Input
            placeholder={
              side === 'tickets' ? 'DT-000337, an order number, or a name…' : 'Number, name or product…'
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {side === 'tickets' ? (
        ticketYear === null ? (
          <CenterLoader />
        ) : (
          <DealTicketsTab
            year={ticketYear}
            query={query}
            nextNumber={ticketYears?.next ?? ''}
          />
        )
      ) : rows === null ? (
        <CenterLoader />
      ) : shown.length === 0 ? (
        <EmptyState
          icon="ClipboardList"
          title={query ? 'Nothing matches that' : `No ${side === 'purchase' ? 'purchase' : 'sales'} orders in ${year}`}
          message={
            query
              ? 'Try the order number, the supplier or buyer, or a product on it.'
              : 'Orders are filed here by the date they were raised. Pick another year above.'
          }
        />
      ) : (
        <>
          <p className="hist-count">
            {totals.count} order{totals.count === 1 ? '' : 's'} · <Money value={totals.value} />{' '}
            {side === 'purchase' ? 'committed' : 'billed'}
          </p>
          <div className="table-wrap">
            <table className="data hist-table">
              <thead>
                {side === 'purchase' ? (
                  <tr>
                    <th className="hist-caret" />
                    <th>PO</th>
                    <th>Date</th>
                    <th>Supplier</th>
                    <th>To</th>
                    <th className="num">Units</th>
                    <th className="num">Total</th>
                    <th>Stage</th>
                  </tr>
                ) : (
                  <tr>
                    <th className="hist-caret" />
                    <th>Order</th>
                    <th>Date</th>
                    <th>Customer</th>
                    <th>Terms</th>
                    <th className="num">Units</th>
                    <th className="num">Total</th>
                    <th className="num">Margin</th>
                    <th>Stage</th>
                  </tr>
                )}
              </thead>
              <tbody>
                {shown.map((r) =>
                  'supplier' in r ? (
                    <PoRow key={r.id} row={r} open={open === r.id} onToggle={setOpen} />
                  ) : (
                    <SoRow key={r.id} row={r} open={open === r.id} onToggle={setOpen} />
                  )
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

function Caret({ open }: { open: boolean }): JSX.Element {
  return (
    <span className={`hist-chev ${open ? 'open' : ''}`}>
      <Icon name="ChevronRight" size={15} />
    </span>
  )
}

function PoRow({
  row,
  open,
  onToggle
}: {
  row: PurchaseOrderHistoryRow
  open: boolean
  onToggle: (id: string | null) => void
}): JSX.Element {
  return (
    <>
      <tr className="hist-row" onClick={() => onToggle(open ? null : row.id)}>
        <td className="hist-caret">
          <Caret open={open} />
        </td>
        <td className="hist-num">{row.number}</td>
        <td className="hist-date">{row.date}</td>
        <td>{row.supplier || '—'}</td>
        <td>{row.destination}</td>
        <td className="num">
          {row.unitsReceived}/{row.unitsOrdered}
        </td>
        <td className="num">
          <Money value={row.total} />
        </td>
        <td>
          <span className={`hist-stage st-${row.status}`}>{row.status}</span>
          {row.settled && <span className="hist-filed" title="Off the board, filed here">filed</span>}
        </td>
      </tr>
      {open && (
        <tr className="hist-detail-row">
          <td colSpan={8}>
            <div className="hist-detail">
              <Facts
                items={[
                  ['Ordered', stamp(row.orderedAt)],
                  ['Paid', stamp(row.paidAt)],
                  ['Received', stamp(row.receivedAt)],
                  ['Cancelled', stamp(row.cancelledAt)],
                  ['Carrier', row.carrier ?? '—'],
                  ['Tracking', row.trackingNumber ?? '—']
                ]}
              />
              <Lines lines={row.lines} settledLabel="Received" />
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function SoRow({
  row,
  open,
  onToggle
}: {
  row: SalesOrderHistoryRow
  open: boolean
  onToggle: (id: string | null) => void
}): JSX.Element {
  return (
    <>
      <tr className="hist-row" onClick={() => onToggle(open ? null : row.id)}>
        <td className="hist-caret">
          <Caret open={open} />
        </td>
        <td className="hist-num">{row.number}</td>
        <td className="hist-date">{row.date}</td>
        <td>{row.customerName || '—'}</td>
        <td>{row.terms}</td>
        <td className="num">
          {row.unitsOut}/{row.unitsSold}
        </td>
        <td className="num">
          <Money value={row.total} />
        </td>
        <td className="num">
          {/* A margin that cannot be recovered reads as ABSENT. Printing the
              whole total as profit is the one mistake a ledger must not make. */}
          {row.margin === null ? (
            <span className="hist-unknown" title="Nothing on this order has a recoverable cost">
              —
            </span>
          ) : (
            <Money value={row.margin} strong />
          )}
        </td>
        <td>
          <span className={`hist-stage st-${row.status}`}>{row.status}</span>
          {/* The same marker the purchase-order rows have carried all along.
              It could not be drawn here before, because nothing on the sell side
              ever left the board — see isSettledInvoice. */}
          {row.settled && (
            <span className="hist-filed" title="Off the board, filed here">
              filed
            </span>
          )}
        </td>
      </tr>
      {open && (
        <tr className="hist-detail-row">
          <td colSpan={9}>
            <div className="hist-detail">
              <Facts
                items={[
                  ['Due', row.dueDate ?? '—'],
                  ['Terms', row.terms],
                  ['QuickBooks', row.qboDocNumber ?? 'not posted'],
                  ['Cost of goods', row.cost > 0 ? money(row.cost) : '—']
                ]}
              />
              <Lines lines={row.lines} settledLabel="Out" />
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

/** A date, or an em dash. Timestamps are shown to the day: nobody looking a year
 *  back cares which minute a box was counted. */
function stamp(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—'
}

function money(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function Facts({ items }: { items: Array<[string, string]> }): JSX.Element {
  return (
    <dl className="hist-facts">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function Lines({
  lines,
  settledLabel
}: {
  lines: OrderHistoryLine[]
  settledLabel: string
}): JSX.Element {
  if (lines.length === 0) return <p className="hist-noline">This order has no lines on it.</p>
  return (
    <table className="data hist-lines">
      <thead>
        <tr>
          <th>Item</th>
          <th>SKU</th>
          <th className="num">Qty</th>
          <th className="num">{settledLabel}</th>
          <th className="num">Each</th>
          <th className="num">Amount</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.position}>
            <td>{l.item}</td>
            <td className="hist-sku">{l.sku || '—'}</td>
            <td className="num">{l.quantity}</td>
            <td className="num">{l.settledQty === null ? '—' : l.settledQty}</td>
            <td className="num">
              <Money value={l.unitPrice} />
            </td>
            <td className="num">
              <Money value={l.amount} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
