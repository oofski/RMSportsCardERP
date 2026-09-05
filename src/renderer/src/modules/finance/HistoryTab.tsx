import { useEffect, useMemo, useState } from 'react'
import type { Invoice } from '@shared/invoices'
import type {
  HistorySource,
  OrderHistoryLine,
  PurchaseOrderHistoryRow,
  SalesOrderHistoryRow
} from '@shared/orderHistory'
import { Icon } from '../../components/Icon'
import { CenterLoader, EmptyState, Input } from '../../components/ui'
import { Money } from './bits'
import { finance } from './api'
import { DealTicketsTab } from './DealTicketsTab'
import { DeletedTab } from './DeletedTab'
import { AttachPurchaseOrderModal } from '../invoices/AttachPurchaseOrderModal'
import { api } from '../../lib/api'

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
type Side = 'purchase' | 'sales' | 'tickets' | 'deleted'

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
  /**
   * WHICH PURCHASE THE LEDGER IS NARROWED TO, or null for the whole year.
   *
   * The owner: "I can see where everything is coming from." Starting from a
   * buying trip rather than from an order is the other half of that — pick the
   * Kansas City roadshow and both tables show only what came out of it.
   *
   * A source REPLACES the year rather than narrowing inside it, because what was
   * bought in December is mostly sold in January. The year buttons go quiet
   * while one is picked, so nothing on screen implies a filter that is not being
   * applied. See listPurchaseOrderHistory.
   */
  const [sources, setSources] = useState<HistorySource[] | null>(null)
  const [source, setSource] = useState<string>('')

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

  /**
   * The purchases worth narrowing to, fetched once.
   *
   * Not year-scoped and not re-fetched per side: the list is the same question
   * whichever table is showing. It changes when somebody links a sale to a
   * purchase — which USED to be impossible while this screen was open, and is
   * now one of the things this screen does, so it re-reads on `reloadKey` like
   * the rows themselves.
   */
  /**
   * ATTACHING A PURCHASE ORDER FROM HERE.
   *
   * The owner: "I want to go into the finance history and attach POs to the
   * SOs." The Attach screen existed and was only reachable from the Sales
   * Orders board — which shows the CURRENT pipeline. An order settled months
   * ago has left that board, and History is where somebody goes looking for it,
   * so the one place you can see an old sale was the one place you could not
   * fix its provenance.
   *
   * The full invoice is fetched on the press rather than carried on every row:
   * the picker ranks its offers by the sale's own supplier, which a history row
   * does not carry, and one read on a button press is cheaper than widening
   * every row in the table to serve a button most of them will never use.
   */
  const [attaching, setAttaching] = useState<Invoice | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const openAttach = async (invoiceId: string): Promise<void> => {
    // Silent on a failed read: the row is still there and the panel is still
    // open, so nothing has been lost — pressing again is the whole recovery.
    const full = await api.invoices.get(invoiceId).catch(() => null)
    if (full) setAttaching(full)
  }

  useEffect(() => {
    void finance.historySources().then(setSources)
  }, [reloadKey])

  // Re-read on every (side, year, source) change. Both lists are kept so
  // flipping back and forth does not refetch, and both are cleared when either
  // moves.
  useEffect(() => {
    if (year === null) return
    // The register fetches its own rows from its own year — see DealTicketsTab.
    // Without this guard the sales branch below would fire a second, pointless
    // read of the whole sales ledger every time somebody opened the tickets tab.
    if (side === 'tickets' || side === 'deleted') return
    let alive = true
    void reloadKey
    if (side === 'purchase') {
      setPos(null)
      void finance.historyPurchaseOrders(year, source).then((r) => alive && setPos(r))
    } else {
      setSos(null)
      void finance.historySalesOrders(year, source).then((r) => alive && setSos(r))
    }
    return () => {
      alive = false
    }
  }, [side, year, source, reloadKey])

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
          {/* WHAT IS NO LONGER HERE, beside what is.

              The other three tabs list documents that exist. This one lists the
              ones that do not, which is the only question none of them could
              answer: a deleted order left a gap in the numbers and nothing
              else. It sits last because it is the exception, and it is on this
              screen rather than on a board because a board is a list of what
              exists by definition. */}
          <button
            className={`hist-side ${side === 'deleted' ? 'active' : ''}`}
            onClick={() => {
              setSide('deleted')
              setOpen(null)
            }}
          >
            <Icon name="Trash2" size={15} />
            Deleted
          </button>
        </div>

        <div className="hist-years">
          {yearsFor.map((y) => (
            <button
              key={y}
              className={`hist-year ${y === activeYear ? 'active' : ''}`}
              // DISABLED, NOT HIDDEN, while a source is picked. A source spans
              // every year, so the buttons genuinely do nothing — and removing
              // them would leave somebody unable to see that the year they were
              // on is still there to go back to.
              disabled={side === 'deleted' || (side !== 'tickets' && !!source)}
              title={
                side !== 'tickets' && source
                  ? 'Showing every year for the purchase order picked on the right'
                  : undefined
              }
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

        {/* WHERE IT CAME FROM, as a starting point rather than an answer.

            The rest of this screen answers "what was on order 2371". This
            answers the other direction — "what came out of the Kansas City
            trip" — which is the question the boards cannot ask at all, because
            a purchase and the five sales that drew on it live on two different
            screens. Absent on the deal-ticket view, which is already the same
            movements grouped a third way. */}
        {side !== 'tickets' && (sources?.length ?? 0) > 0 && (
          <label className="hist-source">
            <Icon name="Route" size={15} />
            <select
              className="select"
              aria-label="Show only what came from one purchase order"
              value={source}
              onChange={(e) => {
                setSource(e.target.value)
                setOpen(null)
              }}
            >
              <option value="">Any source</option>
              {(sources ?? []).map((o) => (
                <option key={o.poId} value={o.poId}>
                  {o.roadshow ? '★ ' : ''}
                  {o.poNumber}
                  {o.supplier ? ` · ${o.supplier}` : ''}
                  {o.orderedOn ? ` · ${o.orderedOn}` : ''} · {o.saleCount}{' '}
                  {o.saleCount === 1 ? 'sale' : 'sales'}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="hist-search">
          <Icon name="Search" size={15} />
          <Input
            placeholder={
              side === 'tickets'
                ? 'DT-000337, an order number, or a name…'
                : side === 'deleted'
                  ? 'A number, a supplier, or who deleted it…'
                  : 'Number, name or product…'
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {side === 'deleted' ? (
        <DeletedTab query={query} />
      ) : side === 'tickets' ? (
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
                    <SoRow
                      key={r.id}
                      row={r}
                      open={open === r.id}
                      onToggle={setOpen}
                      onAttach={openAttach}
                    />
                  )
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* THE SAME SCREEN THE SALES ORDERS BOARD OPENS, not a second one.
          Attaching is one act with one set of rules, and a History-only copy of
          it would be a second place for those rules to drift. On done the rows
          AND the source list are re-read, because both of them are answers to
          "which purchase supplied this" and this is now the screen that changes
          it. */}
      {attaching && (
        <AttachPurchaseOrderModal
          invoice={attaching}
          onClose={() => setAttaching(null)}
          onDone={() => setReloadKey((n) => n + 1)}
        />
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
              {/* WHERE ITS GOODS WENT. The half a purchase order could never
                  show: a $9,000 trip to a roadshow is only half a story, and
                  the other half is which sales came out of it. */}
              {row.suppliedSales.length > 0 && (
                <div className="hist-went">
                  <span className="hist-went-label">
                    <Icon name="ArrowRight" size={13} /> Sold on
                  </span>
                  <span className="hist-went-list">
                    {row.suppliedSales.map((s) => (
                      <span key={s.invoiceId} className="hist-went-one">
                        <b className="mono">{s.number}</b> {s.customerName}
                      </span>
                    ))}
                  </span>
                </div>
              )}
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
  onToggle,
  onAttach
}: {
  row: SalesOrderHistoryRow
  open: boolean
  onToggle: (id: string | null) => void
  /** Open the attach screen for this sale. See the note on `attaching`. */
  onAttach: (id: string) => void
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
              {/* THE DOCUMENT-LEVEL CLAIM, which is a different fact from what
                  any one line says about its own cases — and on a dropship it
                  is usually the only one there is, because the two documents
                  share no catalog product at all. */}
              {/* SUPPLIED BY, AND NOW EDITABLE FROM HERE.

                  It was read-only, and the button that changes it lived on the
                  Sales Orders board — which shows the CURRENT pipeline. A sale
                  settled months ago has left that board, so the one screen where
                  somebody can find an old order was the one screen where its
                  provenance could not be fixed.

                  ALWAYS SHOWN, not only when something is already attached: a
                  sale with no purchase behind it is precisely the one somebody
                  came here to correct, and a button that appeared only once the
                  job was done would be useless. */}
              <div className="hist-went">
                <span className="hist-went-label">
                  <Icon name="Link" size={13} /> Supplied by
                </span>
                <span className="hist-went-list">
                  {row.sourcePos.length > 0 ? (
                    row.sourcePos.map((p) => (
                      <span key={p.poId} className="hist-went-one">
                        <b className="mono">{p.poNumber}</b>
                        {p.supplier ? ` ${p.supplier}` : ''}
                      </span>
                    ))
                  ) : (
                    <span className="hist-went-none">nothing attached</span>
                  )}
                  <button
                    type="button"
                    className="hist-attach"
                    title="Attach or detach the purchase orders that supplied this sale"
                    onClick={(e) => {
                      // The row itself toggles open on click, so this must not
                      // bubble or pressing it would close the panel it sits in.
                      e.stopPropagation()
                      onAttach(row.id)
                    }}
                  >
                    <Icon name="Link" size={12} />
                    {row.sourcePos.length > 0 ? 'Change' : 'Attach a purchase order'}
                  </button>
                </span>
              </div>
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
            <td>
              {l.item}
              {/* WHERE THESE CAME FROM, under the name — the same place the
                  sales-order form and the routing screen put it, so the fact
                  lives in one position across the app.

                  A LIST, because a line can be split by case: "8 off RM, 2
                  shipped direct from Kestrel" is one line with two origins and
                  printing only the first would put the wrong story in the one
                  screen somebody reads a year later. Silent on an ordinary
                  line off our own shelf that names no purchase, which is most
                  of them — a "from RM" under every row would be noise nobody
                  reads, and then the one that says Kestrel reads as noise too. */}
              {l.sources.filter((o) => !o.fromShelf || o.poNumber).map((o, i) => (
                <div key={i} className="hist-origin">
                  <Icon name={o.fromShelf ? 'Package' : 'Truck'} size={11} />
                  {o.quantity < l.quantity && <b className="mono">{o.quantity}</b>}
                  {o.fromShelf ? `off ${o.where}` : `direct from ${o.where}`}
                  {o.poNumber && (
                    <>
                      {' · '}
                      <b className="mono">{o.poNumber}</b>
                      {o.supplier && o.supplier !== o.where ? ` ${o.supplier}` : ''}
                    </>
                  )}
                </div>
              ))}
            </td>
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
