import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject
} from 'react'
import type {
  CategorySummary,
  IncomingShipment,
  InventoryProduct,
  InventoryStats,
  PurchaseOrderDetail,
  PurchaseOrderStatus
} from '@shared/types'
import { CATEGORY_ORDER, LOCATIONS, categoryColor } from '@shared/inventory'
import {
  defaultInventorySort,
  firstSortDir,
  locationSortKey,
  nextSortState,
  sortInventoryRows,
  type InventorySortRow,
  type SortState
} from '@shared/inventorySort'
import { countIdentifierGaps } from '@shared/identifiers'
import { destinationSummary } from '@shared/purchaseOrders'
import { receivableProgressOf } from '@shared/receiving'
import { BarList } from '../../components/charts'
import { Icon } from '../../components/Icon'
import { ReceiveBar } from '../../components/ReceiveProgress'
import { Button, CenterLoader, EmptyState } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { api } from '../../lib/api'
import { formatDate, formatMoney, formatUnitMoney } from '../../lib/format'
import { formatUnitCount } from '../../lib/productUnits'
import { UnitBadge, productMetrics, type ProductMetrics } from './helpers'
import { EditField } from './ProductsTab'
import { CategoryLogo } from './CategoryLogo'
import { GAP_META, MissingIdentifiers } from './MissingIdentifiers'
import { IncomingModal } from './IncomingModal'
import { ProductHoverCard, type ProductCardData } from './ProductCases'
import {
  PO_STAGE_META,
  dropDestinations,
  lineIsWhollyDrop,
  receivableOutstanding
} from '../invoicing/helpers'
import { DeliveryPanel } from '../invoicing/DeliveryPanel'

type MetricKind = 'value' | 'cost' | 'spread' | 'cases' | 'skus'
type Detail =
  | { kind: 'category'; category: string; label: string }
  | { kind: MetricKind; label: string }
  // A VIEW across the categories, not one of them — see @shared/identifiers for
  // why a data gap must never become a stored category.
  | { kind: 'identifiers'; label: string }

export function InventoryOverview({
  stats,
  categories,
  products,
  canManage,
  onChanged,
  onScan,
  onOpenProduct,
  refreshKey = 0
}: {
  stats: InventoryStats
  categories: CategorySummary[]
  /** The whole catalog, already loaded by the module for the Catalog tab. The
   *  missing-identifier tile counts from THIS array rather than from a second
   *  query, so its number and the list it opens are the same derivation. */
  products: InventoryProduct[]
  canManage: boolean
  onChanged: () => Promise<void>
  /** Opens the scan station (owned by InventoryModule). */
  onScan?: () => void
  /** Jump to the Catalog filtered to this product, so a zero-cost item named in
   *  the banner is one click from the field that fixes it. */
  onOpenProduct: (name: string) => void
  /** Bumped on every module reload so panels holding their OWN data (the
   * Incoming panel, the drill-down table) re-read too. */
  refreshKey?: number
}): JSX.Element {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
  const overviewToast = useToast()

  const rebuildFromLayers = useCallback(async (): Promise<void> => {
    setRebuilding(true)
    try {
      const result = await api.sync.repairStock()
      if (!result.ok) {
        overviewToast.error(result.error ?? 'Could not rebuild the counts.')
        return
      }
      const changed = result.data?.changed ?? 0
      overviewToast.success(
        changed === 0
          ? 'Nothing to rebuild — every count already matches its layers.'
          : `${changed} shelf count${changed === 1 ? '' : 's'} rebuilt from the cost layers.`
      )
      await onChanged()
    } finally {
      setRebuilding(false)
    }
  }, [onChanged, overviewToast])

  // Incoming stock is read ONCE here and shared by the "Incoming orders" tile,
  // its hover summary and the Incoming panel below, so the headline number and
  // the breakdown can never disagree.
  const feed = useIncomingFeed(refreshKey)
  const incoming = useMemo(
    () => summariseIncoming(feed.boxes ?? [], feed.manual ?? []),
    [feed.boxes, feed.manual]
  )
  const incomingLoading = feed.boxes === null || feed.manual === null

  // Hover summary for the Incoming inventory panel's unit count — same
  // mechanism as the product hover card further down this file: a fixed-position
  // `.hovercard` placed from the trigger's box, held open while the pointer is
  // over the card itself. It hangs off the panel rather than a dashboard tile
  // because the purchase orders it lists are what that panel is showing.
  const [incHover, setIncHover] = useState<CSSProperties | null>(null)
  const incTimer = useRef<number | undefined>(undefined)
  const openIncHover = (rect: DOMRect): void => {
    if (incTimer.current) window.clearTimeout(incTimer.current)
    setIncHover(statHoverStyle(rect))
  }
  const closeIncHover = (): void => {
    if (incTimer.current) window.clearTimeout(incTimer.current)
    incTimer.current = window.setTimeout(() => setIncHover(null), 160)
  }
  const holdIncHover = (): void => {
    if (incTimer.current) window.clearTimeout(incTimer.current)
  }
  useEffect(
    () => () => {
      if (incTimer.current) window.clearTimeout(incTimer.current)
    },
    []
  )

  // Kept so callers elsewhere can still scroll this panel into view.
  const incomingRef = useRef<HTMLDivElement | null>(null)

  // Opening a drill-down unmounts nothing (this component stays mounted), so a
  // popover left open would reappear at a stale position on the way back.
  const openDetail = (d: Detail): void => {
    setIncHover(null)
    setDetail(d)
  }

  const orderedCategories = useMemo(() => {
    const rank = (c: string): number => {
      const i = CATEGORY_ORDER.indexOf(c)
      return i === -1 ? CATEGORY_ORDER.length : i
    }
    return [...categories].sort((a, b) => rank(a.category) - rank(b.category) || a.category.localeCompare(b.category))
  }, [categories])

  // One list from the main process, two banners: the rows the Spread excludes
  // and the rows it is still inflating. Split here rather than in two queries so
  // the flag that decides is the same one the arithmetic used.
  const outsideRows = useMemo(() => stats.zeroCost.filter((z) => z.outsideSpread), [stats.zeroCost])
  const inflatingRows = useMemo(() => stats.zeroCost.filter((z) => !z.outsideSpread), [stats.zeroCost])

  // Live off the same catalog array the Catalog tab renders, so the tile moves
  // the moment a SKU is typed anywhere in the module rather than waiting for a
  // stats query that does not know about it.
  const identifierGaps = useMemo(() => countIdentifierGaps(products), [products])

  const valueByCategory = useMemo(
    () =>
      [...categories]
        .filter((c) => c.value > 0)
        .sort((a, b) => b.value - a.value)
        .map((c) => ({ label: c.category, value: Math.round(c.value) })),
    [categories]
  )

  if (detail) {
    // The identifier view is the one drill-down that does NOT re-read from the
    // database: it is a lens over the catalog array this component was handed,
    // which the module reloads after every save. Giving it its own fetch would
    // let the tile and the list disagree about how many products need work.
    if (detail.kind === 'identifiers') {
      return (
        <MissingIdentifiers
          products={products}
          canManage={canManage}
          onOpenProduct={onOpenProduct}
          onChanged={onChanged}
          onBack={() => setDetail(null)}
        />
      )
    }
    // refreshKey is threaded in so the drill-down re-reads on every module
    // reload: a scan committed while this view is open (the Scan button lives
    // in the module header and stays reachable here) changes the average cost,
    // and the spread on screen must move with it.
    return <InventoryDetail detail={detail} refreshKey={refreshKey} onBack={() => setDetail(null)} />
  }

  return (
    <>
      <div className="stat-grid">
        {/* Inventory value is the headline figure of the whole module and stays
            the first tile. The incoming-order breakdown it briefly replaced now
            hovers off the Incoming inventory panel below, where the purchase
            orders it describes actually live. */}
        <Stat
          icon="DollarSign"
          value={formatMoney(stats.totalValue, { compact: true })}
          label="Inventory value"
          onClick={() => openDetail({ kind: 'value', label: 'Inventory value' })}
        />
        <Stat icon="Wallet" value={formatMoney(stats.totalCost, { compact: true })} label="Total cost" onClick={() => openDetail({ kind: 'cost', label: 'Total cost' })} />
        <Stat
          icon="TrendingUp"
          value={formatMoney(stats.spread, { compact: true })}
          label="Spread"
          tone={stats.spread < 0 ? 'neg' : stats.spread > 0 ? 'pos' : undefined}
          onClick={() => openDetail({ kind: 'spread', label: 'Spread' })}
        />
        <Stat icon="Boxes" value={String(stats.cases)} label="Cases on hand" onClick={() => openDetail({ kind: 'cases', label: 'Cases on hand' })} />
      </div>

      {/* Stock carried at nothing, split by what it is doing to the tiles above.
          An uncosted BOX is money the Spread is leaving out — Inventory value
          counts it, Spread does not, and this is the sentence that makes the
          difference between those two tiles readable instead of mysterious.
          Anything else uncosted is still counting its whole market value as
          profit, which is the older and worse problem, so it keeps the warning
          it has always had. Naming the products is the difference between a
          figure the operator distrusts and a short list they can go and fix —
          and the cost field beside each name is the difference between a list
          and a fix. */}
      {outsideRows.length > 0 && (
        <ZeroCostBanner
          variant="outside"
          rows={outsideRows}
          canManage={canManage}
          onOpenProduct={onOpenProduct}
          onChanged={onChanged}
        />
      )}
      {inflatingRows.length > 0 && (
        <ZeroCostBanner
          variant="inflating"
          rows={inflatingRows}
          canManage={canManage}
          onOpenProduct={onOpenProduct}
          onChanged={onChanged}
        />
      )}

      {/* Every figure above is summed from the FIFO cost layers, and a shelf
          whose layers do not account for its count is the one place that money
          is not a purchase price. The tiles still follow the QUANTITY — a shelf
          is valued for exactly what is counted on it, so nothing on screen
          contradicts the count beside it — but a valuation quietly resting on an
          average, or a cost basis attached to units nobody has, is precisely
          what goes unnoticed for a quarter. So it is said out loud. */}
      {stats.layerGaps.length > 0 && (
        <div className="zerocost-banner">
          {/* The WHY hangs off the icon rather than sitting under the headline:
              the count and the list of shelves are what has to be read every
              time, and the explanation is only wanted once. */}
          <Icon
            name="Layers"
            size={17}
            title="Valued at the shelf count using average cost. Re-count or adjust to restore a real basis."
          />
          <div className="zerocost-main">
            <strong>
              {stats.layerGaps.length} shelf{stats.layerGaps.length === 1 ? '' : 'ves'} does not
              match its cost layers.
            </strong>
            <ul>
              {stats.layerGaps.slice(0, 6).map((g) => (
                <li key={`${g.id}-${g.location}`}>
                  <button type="button" className="link-btn" onClick={() => onOpenProduct(g.name)}>
                    {g.name}
                  </button>
                  <em>
                    {g.location} · {formatUnitCount(g.quantity)} counted,{' '}
                    {formatUnitCount(g.lotQuantity)} in layers · {formatMoney(g.value)}
                  </em>
                </li>
              ))}
              {stats.layerGaps.length > 6 && (
                <li className="zerocost-more">and {stats.layerGaps.length - 6} more</li>
              )}
            </ul>
            {/* The repair, offered where the problem is READ rather than only
                on the sync screen two modules away.

                On-hand quantity does not travel between computers — it is summed
                from the cost layers, which do, and each computer works it out for
                itself. So the usual reason a shelf appears here is that this
                machine received the layers and never turned them into a count,
                and every total above is short by exactly that stock.

                It is a button and not automatic because the other direction is a
                real state too: layers left behind on a shelf somebody emptied
                here. Rebuilding those puts stock back that is not on the shelf,
                which is why the wording says which is which and a person
                decides. */}
            {canManage && (
              <Button
                size="sm"
                loading={rebuilding}
                onClick={rebuildFromLayers}
              >
                Rebuild counts from cost layers
              </Button>
            )}
          </div>
        </div>
      )}

      {stats.lowStockCount > 0 && (
        <div className="lowstock-banner">
          <Icon name="AlertTriangle" size={17} />
          {stats.lowStockCount} product{stats.lowStockCount === 1 ? '' : 's'} at or below the low-stock threshold.
        </div>
      )}

      <div className="panel-row">
        <div className="panel-card">
          <div className="panel-head">
            <div>
              <h3>Inventory value by category</h3>
              <span className="ph-sub">Market value on hand</span>
            </div>
            <div className="ph-right">
              <div className="ph-total">{formatMoney(stats.totalValue, { compact: true })}</div>
              <div className="ph-sub">
                {LOCATIONS.map((l) => `${l.label} ${stats.unitsByLocation[l.id] ?? 0}`).join(' · ')} units
              </div>
            </div>
          </div>
          {valueByCategory.length === 0 ? (
            <div className="chart-empty">
              <Icon name="BarChart3" size={26} />
              <div>
                <div style={{ fontWeight: 600, color: 'var(--text-2)' }}>No value on hand yet</div>
                <div className="text-sm">Add stock to a product and it'll chart here.</div>
              </div>
            </div>
          ) : (
            <BarList
              items={valueByCategory}
              formatValue={(v) => formatMoney(v, { compact: true })}
              colorFor={(label) => categoryColor(label)}
              renderIcon={(label) => <CategoryLogo category={label} size={16} />}
              showShare
            />
          )}
        </div>

        <IncomingPanel
          hoverId={incHover ? INCOMING_HOVER_ID : undefined}
          onHoverOpen={openIncHover}
          onHoverClose={closeIncHover}
          panelRef={incomingRef}
          canManage={canManage}
          onReceived={onChanged}
          onScan={onScan}
          feed={feed}
          summary={incoming}
          loading={incomingLoading}
        />
      </div>

      <div className="section-head">
        <div>
          <h2>By category</h2>
        </div>
        <button className="link-btn" onClick={() => openDetail({ kind: 'skus', label: 'All products' })}>
          View all {stats.skuCount} products
        </button>
      </div>

      {orderedCategories.length === 0 ? (
        <EmptyState icon="Boxes" title="No inventory yet" />
      ) : (
        <div className="cat-grid">
          {orderedCategories.map((c) => (
            <button
              key={c.category}
              className="cat-card"
              style={{ '--cat': categoryColor(c.category) } as CSSProperties}
              onClick={() => setDetail({ kind: 'category', category: c.category, label: c.category })}
            >
              <div className="cc-head">
                <span className="cc-ico">
                  <CategoryLogo category={c.category} size={20} />
                </span>
                <span className="cc-name">{c.category}</span>
              </div>
              <div className="cc-cases">
                {c.cases} <small>{c.cases === 1 ? 'case' : 'cases'}</small>
              </div>
              <div className="cc-sub">
                <span>{c.productCount} products</span>
                <span>{formatMoney(c.value, { compact: true })}</span>
              </div>
            </button>
          ))}

          {/* A VIEW sitting beside the categories, not another category.
              Deliberately last, so the real categories keep the order the
              dashboard has always shown them in, and deliberately the same
              `.cat-card` markup, so it reads as part of the grid rather than as
              a warning bolted underneath it.

              WHY IT IS NOT A CATEGORY. Filing a product with no SKU under
              "Missing identifiers" would move it out of Football — and the
              category cards, the value-by-category chart and every total on this
              screen sum straight off the stored category column, so its cases
              and its market value would go with it. The gap is a fact ABOUT a
              Football product, not a different kind of product. See
              @shared/identifiers.

              It stays on screen at zero rather than disappearing: this is the
              screen somebody comes to in order to CHECK, and a tile that only
              exists while something is wrong cannot be found by anyone asking
              whether anything is. */}
          <button
            className="cat-card cat-ident"
            style={
              {
                '--cat': identifierGaps.total > 0 ? 'var(--warning)' : 'var(--success)'
              } as CSSProperties
            }
            onClick={() => openDetail({ kind: 'identifiers', label: 'Missing identifiers' })}
          >
            <div className="cc-head">
              <span className="cc-ico">
                <Icon name="ScanBarcode" size={20} />
              </span>
              <span className="cc-name">Missing identifiers</span>
            </div>
            <div className="cc-cases">
              {identifierGaps.total}{' '}
              <small>{identifierGaps.total === 1 ? 'product' : 'products'}</small>
            </div>
            {/* Three numbers, never one. They are three different jobs: no SKU
                is a product an invoice can only match by name, no barcode is a
                product no scanner can find, and neither is both at once. Worded
                from GAP_META so the tile, the chips behind it and the badge on
                each row cannot end up calling the same number two things. */}
            <div className="cc-sub">
              <span>
                {identifierGaps.sku} {GAP_META.sku.noun} · {identifierGaps.upc} {GAP_META.upc.noun}
              </span>
              <span>
                {identifierGaps.both} {GAP_META.both.noun}
              </span>
            </div>
          </button>
        </div>
      )}

      {incHover && (
        <IncomingOrdersHoverCard
          summary={incoming}
          loading={incomingLoading}
          style={incHover}
          onMouseEnter={holdIncHover}
          onMouseLeave={closeIncHover}
        />
      )}
    </>
  )
}

/** One order still on its way in — a purchase order, or a hand-logged shipment. */
interface OutstandingOrder {
  id: string
  /** 'po' rows come from the PO pipeline; 'manual' from Log a shipment. */
  source: 'po' | 'manual'
  /** PO number, or the product name for a manual shipment. */
  title: string
  /** Supplier / destination / ETA line. */
  detail: string
  /** PO stage; null for manual shipments (they have no pipeline). */
  status: PurchaseOrderStatus | null
  /** Distinct products still outstanding on this order. */
  itemCount: number
  /** Units still to arrive. */
  units: number
  /** What those units are worth at their agreed buy price. */
  value: number
}

interface IncomingSummary {
  orders: OutstandingOrder[]
  /** Σ units still to arrive across every order. */
  totalUnits: number
  /** Σ money still committed and undelivered. */
  totalValue: number
}

/**
 * Stock carried at nothing — named, and fixable where it stands.
 *
 * TWO VARIANTS, BECAUSE THERE ARE TWO PROBLEMS. `outside` is the box case: the
 * Spread deliberately does not count stock with no cost basis, so this is not a
 * warning that a number is wrong, it is a note that it is incomplete — and it
 * carries the amount, because that amount is exactly the gap between the
 * Inventory value and Total cost tiles above and the Spread beside them.
 * `inflating` is everything else uncosted, where the whole market value is still
 * being reported as profit; that one is a warning and keeps the words it has
 * always had. Same list, same field, same click-through — only the sentence at
 * the top changes, because only the consequence does.
 *
 * WHY THE FIELD IS HERE RATHER THAN A LINK TO THE CATALOG. The names have always
 * been buttons into the Catalog, which is one navigation, one search and one
 * scroll per product, times however many the import left uncosted (the run that
 * prompted this left four). The cost is a single number per row and this is
 * where the operator is already looking at the damage it is doing.
 *
 * IT SETS A COST BASIS, NOT AN AVERAGE, AND THAT DISTINCTION IS THE WHOLE POINT.
 * The valuation reads the FIFO layers first and only falls back to the product's
 * stored average where a shelf has none. A product that got here the usual way —
 * created by a catalog import at zero, then counted by a baseline paste that
 * opened its layers at the zero it found — has layers, all at zero, so writing
 * the average alone would clear nothing and this banner would still be here on
 * the next reload. `fixCostBasis` re-bases the layers carrying nothing as well,
 * and reports back what the product is worth afterwards so this can SAY the fix
 * landed rather than imply it by disappearing.
 *
 * When it somehow does not land — a shape neither of us has thought of — the row
 * says so and points at the adjust screen, because a field that quietly fails at
 * the one thing it was offered for is worse than no field.
 */
function ZeroCostBanner({
  variant,
  rows,
  canManage,
  onOpenProduct,
  onChanged
}: {
  /** 'outside' — boxes the Spread leaves out; 'inflating' — stock it counts whole. */
  variant: 'outside' | 'inflating'
  rows: InventoryStats['zeroCost']
  canManage: boolean
  onOpenProduct: (name: string) => void
  onChanged: () => Promise<void>
}): JSX.Element {
  const toast = useToast()
  // What each row has been set to in this session, and whether it took. A saved
  // row usually vanishes on the next reload — it is no longer zero-cost — but it
  // is still on screen until that lands, and `saved` is also what the field
  // holds as its committed value, so blurring the same box twice cannot fire the
  // save twice (EditField only commits when the text differs from `value`).
  const [settled, setSettled] = useState<
    Record<string, { saved: string; state: 'fixed' | 'stuck' }>
  >({})

  const SHOWN = 6
  const fix = async (id: string, raw: string): Promise<void> => {
    const cost = Number(raw)
    if (!Number.isFinite(cost) || cost <= 0) return
    const res = await api.inventory.fixCostBasis(id, cost)
    if (!res.ok || !res.data) {
      toast.error(res.error ?? 'That cost could not be saved.')
      return
    }
    // The returned basis is read the same way the banner is, so this is the
    // actual answer to "did that work", not an assumption that it did.
    const worked = res.data.costValue > 0
    setSettled((s) => ({
      ...s,
      [id]: { saved: String(cost), state: worked ? 'fixed' : 'stuck' }
    }))
    if (worked) toast.success(`${res.data.product.name} is now carried at cost.`)
    await onChanged()
  }

  const total = rows.reduce((n, z) => n + z.marketValue, 0)
  const outside = variant === 'outside'
  return (
    <div className={`zerocost-banner${outside ? ' zerocost-note' : ''}`}>
      <Icon name={outside ? 'Info' : 'AlertTriangle'} size={17} />
      <div className="zerocost-main">
        <strong>
          {outside
            ? `${formatMoney(total)} of stock is sitting outside the Spread above.`
            : `${formatMoney(total)} of the Spread above is stock with no cost recorded.`}
        </strong>
        <span>
          {outside
            ? 'No cost recorded, so these count in Inventory value but not in Spread. Type what one cost.'
            : 'On the shelf at $0.00, so all of their market value counts as profit. Type what one unit cost.'}
        </span>
        <ul>
          {rows.slice(0, SHOWN).map((z) => (
            <li key={z.id}>
              <button type="button" className="link-btn" onClick={() => onOpenProduct(z.name)}>
                {z.name}
              </button>
              <em>
                {z.quantity} on hand · {formatMoney(z.marketValue)}
              </em>
              {canManage && (
                <span className="zerocost-fix">
                  <EditField
                    label="Cost each"
                    type="number"
                    value={settled[z.id]?.saved ?? ''}
                    onCommit={(v) => void fix(z.id, v)}
                  />
                </span>
              )}
              {settled[z.id]?.state === 'fixed' && (
                <em className="zerocost-done">
                  <Icon name="Check" size={12} /> Saved
                </em>
              )}
              {settled[z.id]?.state === 'stuck' && (
                <em className="zerocost-stuck">
                  Still $0.00 — adjust this product&rsquo;s stock to give it a real cost basis.
                </em>
              )}
            </li>
          ))}
          {rows.length > SHOWN && (
            <li className="zerocost-more">and {rows.length - SHOWN} more</li>
          )}
        </ul>
      </div>
    </div>
  )
}

/**
 * The one read of "what is on its way in", shared by the Incoming orders tile,
 * its hover summary and the Incoming panel. Fetching it once means the tile's
 * headline and the panel below can never drift apart.
 *
 * Re-runs on refreshKey: receiving a PO's last line by UPC scan completes it,
 * and its box must leave both the tile and the panel without a manual refresh.
 */
interface IncomingFeed {
  /** null while the first fetch is in flight. */
  boxes: PurchaseOrderDetail[] | null
  manual: IncomingShipment[] | null
  thumbs: Record<string, string>
  reloadManual: () => Promise<void>
  reloadBoxes: () => Promise<void>
}

function useIncomingFeed(refreshKey: number): IncomingFeed {
  const [boxes, setBoxes] = useState<PurchaseOrderDetail[] | null>(null)
  const [manual, setManual] = useState<IncomingShipment[] | null>(null)
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  // Every post-await setState checks this: the dashboard unmounts when the user
  // switches Inventory tab, which can land mid-flight.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const reloadManual = useCallback(async () => {
    const r = await api.inventory.listIncoming().catch(() => [])
    if (mounted.current) setManual(r)
  }, [])

  const reloadBoxes = useCallback(async () => {
    const b = await api.purchaseOrders.incomingBoxes().catch(() => [])
    if (mounted.current) setBoxes(b)
  }, [])

  useEffect(() => {
    let active = true
    api.inventory
      .listIncoming()
      .then((r) => {
        if (active) setManual(r)
      })
      .catch(() => {
        if (active) setManual([])
      })
    api.purchaseOrders
      .incomingBoxes()
      .then((b) => {
        if (active) setBoxes(b)
      })
      .catch(() => {
        if (active) setBoxes([])
      })
    api.purchaseOrders
      .thumbnails()
      .then((t) => {
        if (active) setThumbs(t)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [refreshKey])

  return { boxes, manual, thumbs, reloadManual, reloadBoxes }
}

/**
 * Is any of this order coming to this building at all?
 *
 * Phrased as "pure dropship" rather than "has receivable units" on purpose, and
 * it is the same test the main process compiles into its SQL: a purchase order
 * with NO LINES has both figures at zero and must keep appearing here exactly as
 * it does today. Only an order with drop units and no receivable ones vanishes.
 *
 * Repeated in the renderer rather than trusted from the query because the panel
 * also holds boxes it read before an order was re-routed on another machine, and
 * a box offering "All of it arrived" for units that are not coming is the one
 * mistake this whole feature exists to prevent.
 */
function arrivesHere(box: PurchaseOrderDetail): boolean {
  return !(box.receivableUnits === 0 && box.dropshipUnits > 0)
}

/**
 * Fold the raw incoming reads into "what is still on order".
 *
 * Counts what is OUTSTANDING, not what was ordered: a part-scanned PO has
 * already put some of its units into stock, and counting those again would
 * overstate both the tile and its summary. Money is `qtyOutstanding ×
 * unitPrice` — the agreed buy price on the line, which is exactly the cost
 * basis addStock will open the lot at when the box is checked in.
 *
 * Every unit figure here is the STOCK-BOUND one. A mixed line of twenty with
 * eight drop-shipped contributes twelve, never twenty — this panel answers "what
 * is arriving at this building", and eight boxes going straight from a supplier
 * to a shop are not. The money follows the same restriction for the same reason:
 * no lot will ever be opened for those eight, so no cost basis is waiting on
 * them. (The ORDER's total still covers them — they are bought and paid for.
 * That figure lives on the purchase order, which is where the money is.)
 */
function summariseIncoming(
  boxes: PurchaseOrderDetail[],
  manual: IncomingShipment[]
): IncomingSummary {
  const orders: OutstandingOrder[] = []
  for (const b of boxes) {
    if (!arrivesHere(b)) continue
    const open = b.lines
      .map((l) => ({ line: l, left: receivableOutstanding(l) }))
      .filter((l) => l.left > 0)
    const units = open.reduce((n, l) => n + l.left, 0)
    if (units <= 0) continue
    orders.push({
      id: b.id,
      source: 'po',
      title: b.poNumber,
      detail: `${b.supplier || 'No supplier'} · → ${
        b.destinationCount > 1 ? `${b.destinationCount} destinations` : b.location
      }`,
      status: b.status,
      itemCount: open.length,
      units,
      value: open.reduce((sum, l) => sum + l.left * l.line.unitPrice, 0)
    })
  }
  for (const s of manual) {
    if (s.quantity <= 0) continue
    orders.push({
      id: s.id,
      source: 'manual',
      title: s.productName,
      detail: `→ ${s.location} · ${s.expectedDate ? formatDate(s.expectedDate) : 'No ETA'}`,
      status: null,
      itemCount: 1,
      units: s.quantity,
      value: s.quantity * (s.unitCost ?? 0)
    })
  }
  // Biggest commitment first — that is the one worth chasing.
  orders.sort((a, b) => b.value - a.value || b.units - a.units)
  return {
    orders,
    totalUnits: orders.reduce((n, o) => n + o.units, 0),
    totalValue: orders.reduce((n, o) => n + o.value, 0)
  }
}

/**
 * Dashboard panel: stock on its way in. Shows a "shipping box" per open purchase
 * order (grouped, stage-tagged, live from the PO pipeline) plus any manually
 * logged shipments. PO boxes are display-only here — their cases only fold into
 * on-hand stock later, at the scan/check-in step; the manual shipments keep
 * their receive / cancel actions.
 *
 * Its data comes from the dashboard's shared feed, so its headline is the same
 * number the Incoming orders tile shows.
 */
function IncomingPanel({
  panelRef,
  canManage,
  onReceived,
  onScan,
  feed,
  summary,
  loading,
  hoverId,
  onHoverOpen,
  onHoverClose
}: {
  /** Kept so other screens can still scroll this panel into view. */
  panelRef: MutableRefObject<HTMLDivElement | null>
  canManage: boolean
  onReceived: () => Promise<void>
  onScan?: () => void
  feed: IncomingFeed
  summary: IncomingSummary
  loading: boolean
  /** id of the summary popover while it is open, for aria-describedby. */
  hoverId?: string
  onHoverOpen?: (rect: DOMRect) => void
  onHoverClose?: () => void
}): JSX.Element {
  const toast = useToast()
  const { thumbs, reloadManual: load, reloadBoxes: loadBoxes } = feed
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  // The panel unmounts if the user opens a stat detail mid-action, so every
  // post-await setState in the receive/scan/cancel handlers checks this.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const setBusyFor = (id: string, on: boolean): void => {
    if (!mounted.current) return
    setBusy((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  // A pure-drop order's box does not appear at all — not greyed, not collapsed,
  // absent. Those boxes are not coming to the building, so there is nothing on
  // this panel for them to be: no count to add, no delivery to record, no
  // "All of it arrived" that could mean anything.
  const boxes = (feed.boxes ?? []).filter(arrivesHere)
  const manual = feed.manual ?? []
  const totalUnits = summary.totalUnits
  const empty = !loading && boxes.length === 0 && manual.length === 0

  const receive = async (s: IncomingShipment): Promise<void> => {
    setBusyFor(s.id, true)
    try {
      const res = await api.inventory.receiveIncoming(s.id)
      if (res.ok) {
        toast.success(`Received ${s.quantity} × ${s.productName} into ${s.location}.`)
        await load()
        await onReceived()
      } else {
        toast.error(res.error ?? 'Could not receive the shipment.')
      }
    } finally {
      setBusyFor(s.id, false)
    }
  }

  const scanIn = async (box: PurchaseOrderDetail): Promise<void> => {
    setBusyFor(box.id, true)
    try {
      const res = await api.purchaseOrders.scanIn(box.id)
      if (res.ok) {
        // Named per DESTINATION, not per order: "into RM" on an order whose
        // units went to two shelves says something that is only half true, and
        // the half it leaves out is where six boxes went.
        toast.success(
          box.destinationCount > 1
            ? `Scanned in ${box.poNumber} — its units went to their own destinations.`
            : `Scanned in ${box.poNumber} into ${box.location}.`
        )
        await loadBoxes()
        await onReceived()
      } else {
        toast.error(res.error ?? 'Could not scan in the purchase order.')
      }
    } finally {
      setBusyFor(box.id, false)
    }
  }

  const cancel = async (s: IncomingShipment): Promise<void> => {
    setBusyFor(s.id, true)
    try {
      const res = await api.inventory.cancelIncoming(s.id)
      if (res.ok) {
        toast.success(`Cancelled incoming ${s.productName}.`)
        await load()
      } else {
        toast.error(res.error ?? 'Could not cancel the shipment.')
      }
    } finally {
      setBusyFor(s.id, false)
    }
  }

  return (
    <div className="panel-card incoming-card" ref={panelRef}>
      <div className="panel-head">
        <div>
          <h3>Incoming inventory</h3>
          {canManage && onScan ? (
            <button type="button" className="link-btn incoming-scan-link" onClick={onScan}>
              <Icon name="ScanBarcode" size={13} /> Scan items in
            </button>
          ) : (
            <span className="ph-sub">Stock on its way in</span>
          )}
        </div>
        {/* The unit count is the trigger: hovering it breaks the figure down
            into the purchase orders still outstanding. A button, not a div, so
            it is reachable from the keyboard as well as the pointer. */}
        <button
          type="button"
          className="ph-right ph-right-hover"
          aria-describedby={hoverId}
          onMouseEnter={
            onHoverOpen ? (e) => onHoverOpen(e.currentTarget.getBoundingClientRect()) : undefined
          }
          onMouseLeave={onHoverClose}
          onFocus={
            onHoverOpen ? (e) => onHoverOpen(e.currentTarget.getBoundingClientRect()) : undefined
          }
          onBlur={onHoverClose}
        >
          <div className="ph-total">{loading ? '—' : totalUnits}</div>
          <div className="ph-sub">unit{totalUnits === 1 ? '' : 's'}</div>
        </button>
      </div>

      {loading ? (
        <div className="incoming-loading">
          <span className="spinner dark" />
        </div>
      ) : empty ? (
        <div className="incoming-empty">
          <Icon name="Truck" size={24} />
          <div className="text-sm">Nothing scheduled to arrive.</div>
          {canManage && (
            <Button size="sm" variant="secondary" icon="Plus" onClick={() => setAdding(true)}>
              Log a shipment
            </Button>
          )}
        </div>
      ) : (
        <>
          {/* THE ORDERS SCROLL, THE PANEL DOES NOT.
              With enough purchase orders open this list grew without limit, so
              reading it meant scrolling the whole Inventory page — past the
              category cards and the chart — and the stat tiles above scrolled
              away with it, which are the numbers somebody is checking the list
              against. Capped instead, with its own scrollbar: a few orders sit
              in view, the tiles and the Log-a-shipment button stay put, and the
              rest is a flick away rather than a page away. */}
          <div className="incoming-scroll">
          {boxes.length > 0 && (
            <div className="po-ship-list">
              {boxes.map((b) => (
                <PurchaseOrderBox
                  key={b.id}
                  box={b}
                  thumbnails={thumbs}
                  canManage={canManage}
                  busy={busy.has(b.id)}
                  onScan={() => scanIn(b)}
                  onReceived={load}
                />
              ))}
            </div>
          )}
          {manual.length > 0 && (
          <div className="incoming-list">
            {manual.map((s) => (
              <div className="incoming-row" key={s.id} style={{ '--cat': categoryColor(s.category) } as CSSProperties}>
                <span className="inc-dot" />
                <div className="inc-main">
                  <span className="inc-name" title={s.productName}>
                    {s.productName}
                  </span>
                  <span className="inc-meta">
                    <span className="inc-loc">{s.location}</span>
                    <span>{s.expectedDate ? formatDate(s.expectedDate) : 'No ETA'}</span>
                    {s.reference && <span className="inc-ref">{s.reference}</span>}
                  </span>
                </div>
                <span className="inc-qty">+{s.quantity}</span>
                {canManage && (
                  <span className="inc-actions">
                    <button
                      type="button"
                      className="inc-btn receive"
                      title="Receive into stock"
                      aria-label={`Receive ${s.productName} into ${s.location}`}
                      disabled={busy.has(s.id)}
                      onClick={() => receive(s)}
                    >
                      <Icon name="PackageCheck" size={15} />
                    </button>
                    <button
                      type="button"
                      className="inc-btn"
                      title="Cancel shipment"
                      aria-label={`Cancel incoming ${s.productName}`}
                      disabled={busy.has(s.id)}
                      onClick={() => cancel(s)}
                    >
                      <Icon name="X" size={14} />
                    </button>
                  </span>
                )}
              </div>
            ))}
          </div>
          )}
          </div>
          {canManage && (
            <button type="button" className="incoming-add" onClick={() => setAdding(true)}>
              <Icon name="Plus" size={14} /> Log a shipment
            </button>
          )}
        </>
      )}

      {adding && (
        <IncomingModal
          onClose={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false)
            await load()
          }}
        />
      )}
    </div>
  )
}

/**
 * One purchase order shown as a shipping-box container in the Incoming panel:
 * the PO number + its live stage tag, a supplier/destination/units summary, and
 * (expanded) the products inside. Display-only — receiving into stock happens at
 * the future scan/check-in step.
 */
function PurchaseOrderBox({
  box,
  thumbnails,
  canManage,
  busy,
  onScan,
  onReceived
}: {
  box: PurchaseOrderDetail
  thumbnails: Record<string, string>
  canManage: boolean
  busy: boolean
  onScan: () => void | Promise<void>
  /** Re-read the panel after a part delivery, so the counts and bars move. */
  onReceived: () => void | Promise<void>
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [counting, setCounting] = useState(false)
  const meta = PO_STAGE_META[box.status]
  // Counted in UNITS, off the lines. The old test — receivedLineCount between
  // 0 and lineCount — could only see a partial delivery once a whole LINE had
  // completed, so an order with twenty-three of thirty-eight units in, spread
  // across nine part-filled lines, reported receivedLineCount 0 and rendered as
  // though the truck had not arrived.
  //
  // Against the RECEIVABLE units, so a mixed order's box counts the twelve that
  // are coming here and not the twenty that were ordered. Twenty is the truth
  // about the purchase; twelve is the truth about the delivery, and this is a
  // panel about deliveries.
  const got = receivableProgressOf(box.lines)
  const outstanding = got.outstanding
  const drops = dropDestinations(box)
  return (
    <div className={`po-ship-box po-ship-${box.status}`}>
      <button
        type="button"
        className="po-ship-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="po-ship-ico">
          <Icon name="Package" size={17} />
        </span>
        <span className="po-ship-main">
          <span className="po-ship-top">
            <span className="mono po-ship-num">{box.poNumber}</span>
            <span className={`badge po-badge po-badge-${meta.tone}`}>
              <Icon name={meta.icon} size={12} />
              {meta.label}
            </span>
          </span>
          <span className="po-ship-sub">
            {box.supplier || 'No supplier'} · →{' '}
            {box.destinationCount > 1 ? `${box.destinationCount} destinations` : box.location} ·{' '}
            {got.state === 'none'
              ? `${box.lineCount} ${box.lineCount === 1 ? 'item' : 'items'} · ${got.ordered} unit${
                  got.ordered === 1 ? '' : 's'
                }`
              : `${got.received} of ${got.ordered} units in · ${outstanding} left`}
          </span>
          {/* Only once something has landed. A rail at zero on every box still
              with the supplier buries the one that is half here. */}
          {got.state !== 'none' && <ReceiveBar progress={got} compact className="po-ship-recv" />}
        </span>
        <Icon name={open ? 'ChevronDown' : 'ChevronRight'} size={16} className="po-ship-exp" />
      </button>
      {open && (
        <div className="po-ship-lines">
          {box.lines.map((l) => {
            const left = receivableOutstanding(l)
            const wholly = lineIsWhollyDrop(l)
            const done = !wholly && left <= 0
            return (
              <div
                className={`po-ship-line ${done ? 'po-ship-line-done' : ''}${
                  wholly ? ' po-ship-line-drop' : ''
                }`}
                key={l.id}
              >
                <span className="po-ship-thumb">
                  {thumbnails[l.productId] ? (
                    <img src={thumbnails[l.productId]} alt="" />
                  ) : (
                    <CategoryLogo category={l.category} size={16} />
                  )}
                </span>
                <span className="po-ship-name" title={l.productName}>
                  {l.productName}
                </span>
                {/* A wholly drop-shipped line stays on the list — the box has to
                    account for every line on the order or its counts look like a
                    bug — but it carries a marker instead of a count, because
                    there is no quantity of it arriving to count down. */}
                <span
                  className="po-ship-qty mono"
                  title={
                    wholly
                      ? 'Drop-shipped — never arrives here'
                      : done
                        ? 'Received'
                        : 'Still outstanding'
                  }
                >
                  {wholly ? (
                    <span className="po-drop-chip">Drop</span>
                  ) : done ? (
                    <Icon name="PackageCheck" size={14} className="po-ship-tick" />
                  ) : (
                    `×${left}${l.qtyReceived > 0 ? ` of ${l.qtyReceivable}` : ''}`
                  )}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* NON-COUNTING, and it exists precisely so the count above reconciles
          against the receipt without anybody opening the purchase order: a box
          that says twelve against an order that says twenty is a discrepancy
          until this sentence explains it. It must never be added to any total —
          those units are not on their way anywhere near this building. */}
      {box.dropshipUnits > 0 && (
        <div className="po-ship-dropnote">
          {box.dropshipUnits} unit{box.dropshipUnits === 1 ? '' : 's'} drop-shipped to{' '}
          {destinationSummary(drops) || 'another destination'} — not arriving here.
        </div>
      )}
      {/* The count-it-in form, on the same panel the boxes are listed on.
          A part delivery is unpacked at the shelf, not at the desk with the
          purchase order board open, so the form has to be reachable from here —
          otherwise the only control within reach is the all-or-nothing one, and
          the twenty-three units that turned up get booked as thirty-eight. */}
      {canManage && counting && (
        <DeliveryPanel po={box} onReceived={() => void onReceived()} />
      )}
      {canManage && (
        <div className="po-ship-foot">
          <button type="button" className="btn btn-sm po-ship-scan" disabled={busy} onClick={onScan}>
            <Icon name="PackageCheck" size={14} />{' '}
            {busy
              ? 'Scanning…'
              : got.state === 'partial'
                ? `Receive remaining ${outstanding}`
                : 'All of it arrived'}
          </button>
          {outstanding > 0 && (
            <button
              type="button"
              className="btn btn-sm po-ship-part"
              disabled={busy}
              onClick={() => setCounting((v) => !v)}
            >
              {counting ? 'Cancel' : 'Only part of it'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function Stat({
  icon,
  value,
  unit,
  label,
  tone,
  onClick,
  describedBy,
  onHoverOpen,
  onHoverClose
}: {
  icon: string
  value: string
  /** Optional noun rendered small after the figure ("46 units"). */
  unit?: string
  label: string
  tone?: 'pos' | 'neg'
  onClick?: () => void
  /** id of the popover this tile is currently describing itself with. */
  describedBy?: string
  /** Called with the tile's box when pointer or keyboard focus arrives. */
  onHoverOpen?: (rect: DOMRect) => void
  onHoverClose?: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className="stat stat-btn"
      onClick={onClick}
      aria-describedby={describedBy}
      // Focus/blur as well as the pointer, so the summary is reachable from the
      // keyboard rather than being a mouse-only affordance.
      onMouseEnter={onHoverOpen ? (e) => onHoverOpen(e.currentTarget.getBoundingClientRect()) : undefined}
      onMouseLeave={onHoverClose}
      onFocus={onHoverOpen ? (e) => onHoverOpen(e.currentTarget.getBoundingClientRect()) : undefined}
      onBlur={onHoverClose}
    >
      <div className="stat-ico">
        <Icon name={icon} size={21} />
      </div>
      <div>
        <div className={`stat-val ${tone === 'pos' ? 'pos' : tone === 'neg' ? 'neg' : ''}`}>
          {value}
          {unit && <small>{unit}</small>}
        </div>
        <div className="stat-label">{label}</div>
      </div>
      <Icon name="ChevronRight" size={17} className="stat-go" />
    </button>
  )
}

/** Position a hover card to the RIGHT of a row, clamped to stay on-screen. */
const HOVER_W = 384
function hoverStyle(rect: DOMRect): CSSProperties {
  const margin = 12
  // Always anchor to the right of the row. If that would run off the right
  // edge, slide it left just enough to stay fully visible (never flip it over
  // the row, never go negative).
  const left = Math.max(margin, Math.min(rect.right + margin, window.innerWidth - HOVER_W - margin))
  const top = Math.max(margin, Math.min(rect.top, window.innerHeight - margin - 260))
  return { top, left, width: HOVER_W, maxHeight: window.innerHeight - top - margin }
}

const INCOMING_HOVER_ID = 'inv-incoming-summary'
const INCOMING_HOVER_W = 404
/**
 * Position the incoming summary directly UNDER its tile (the tiles sit in a row
 * at the top of the dashboard, so there is always room below and never room
 * beside the rightmost one). Left-aligned to the tile, clamped to the viewport.
 */
function statHoverStyle(rect: DOMRect): CSSProperties {
  const margin = 12
  const left = Math.max(margin, Math.min(rect.left, window.innerWidth - INCOMING_HOVER_W - margin))
  const top = rect.bottom + 8
  return {
    top,
    left,
    width: INCOMING_HOVER_W,
    maxHeight: Math.max(200, window.innerHeight - top - margin)
  }
}

/**
 * The Incoming orders tile's hover summary: every order still outstanding, what
 * is in it and what it is worth. Built on the same `.hovercard` shell as the
 * product hover card on this dashboard — a fixed-position card placed from the
 * trigger's box, held open while the pointer is over the card itself so a long
 * list stays scrollable.
 */
function IncomingOrdersHoverCard({
  summary,
  loading,
  style,
  onMouseEnter,
  onMouseLeave
}: {
  summary: IncomingSummary
  loading: boolean
  style: CSSProperties
  onMouseEnter: () => void
  onMouseLeave: () => void
}): JSX.Element {
  const { orders, totalUnits, totalValue } = summary
  const poCount = orders.filter((o) => o.source === 'po').length
  const manualCount = orders.length - poCount
  const parts = [
    `${poCount} purchase order${poCount === 1 ? '' : 's'}`,
    ...(manualCount > 0 ? [`${manualCount} logged shipment${manualCount === 1 ? '' : 's'}`] : [])
  ]

  return (
    <div
      id={INCOMING_HOVER_ID}
      role="tooltip"
      className="hovercard inc-hover"
      style={style}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="hovercard-head">
        <span className="hc-name">Outstanding orders</span>
        <span className="hc-sub">
          {loading ? 'Loading…' : orders.length === 0 ? 'Nothing on order' : parts.join(' · ')}
        </span>
      </div>

      {loading ? (
        <div className="inc-hover-empty">
          <span className="spinner dark" />
        </div>
      ) : orders.length === 0 ? (
        <div className="inc-hover-empty">
          <Icon name="Truck" size={22} />
          <span>Nothing scheduled to arrive.</span>
        </div>
      ) : (
        <>
          <div className="inc-hover-list">
            {orders.map((o) => {
              const meta = o.status ? PO_STAGE_META[o.status] : null
              return (
                <div className="ih-row" key={`${o.source}-${o.id}`}>
                  <span className="ih-ico">
                    <Icon name={o.source === 'po' ? 'Package' : 'Truck'} size={15} />
                  </span>
                  <span className="ih-main">
                    <span className="ih-top">
                      <span className={`ih-title ${o.source === 'po' ? 'mono' : ''}`} title={o.title}>
                        {o.title}
                      </span>
                      <span className={`ih-stage ih-stage-${o.status ?? 'logged'}`}>
                        {meta ? meta.label : 'Logged'}
                      </span>
                    </span>
                    <span className="ih-sub">{o.detail}</span>
                    <span className="ih-sub">
                      {o.itemCount} {o.itemCount === 1 ? 'item' : 'items'} · {o.units} unit
                      {o.units === 1 ? '' : 's'} to arrive
                    </span>
                  </span>
                  <span className="ih-val mono">{formatMoney(o.value)}</span>
                </div>
              )
            })}
          </div>
          <div className="inc-hover-foot">
            <span>
              {totalUnits} unit{totalUnits === 1 ? '' : 's'} on order
            </span>
            <span className="mono">{formatMoney(totalValue)}</span>
          </div>
        </>
      )}
    </div>
  )
}

/** Shared detail view: a product table with the money metrics + a totals row. */
/**
 * What one row can be ranked by.
 *
 * Written to MIRROR THE CELLS BELOW line for line: wherever the table prints a
 * dash this returns null, so the ranking and the screen can never tell
 * different stories. If a cell's condition changes, this changes with it.
 */
function sortRowOf({ p, m }: { p: InventoryProduct; m: ProductMetrics }): InventorySortRow {
  return {
    name: p.name,
    unit: p.unitType,
    quantity: p.quantity,
    byLocation: p.quantityByLocation,
    highBid: m.hasBid ? m.marketUnit : null,
    invValue: p.quantity > 0 ? m.invValue : null,
    avgCost: m.hasCost ? m.avgCost : null,
    totalCost: m.hasCost && p.quantity > 0 ? m.totalCost : null,
    spread: m.hasCost && !m.outsideSpread && p.quantity > 0 ? m.spread : null
  }
}

/**
 * A column header you can rank the table by.
 *
 * The arrow is always drawn, faint until the column is the one in use, because
 * an arrow that only appears on hover is a feature nobody finds. The whole
 * header is the button, so the target is the width of the column rather than a
 * 13px glyph.
 */
function SortTh({
  label,
  sortKey,
  sort,
  onSort,
  align = 'left'
}: {
  label: string
  sortKey: string
  sort: SortState
  onSort: (key: string) => void
  align?: 'left' | 'center' | 'right'
}): JSX.Element {
  const active = sort.key === sortKey
  const dir = active ? sort.dir : null
  const arrow = (
    <Icon
      name={dir === 'asc' ? 'ChevronUp' : dir === 'desc' ? 'ChevronDown' : 'ChevronsUpDown'}
      size={13}
      className="sort-arrow"
    />
  )
  return (
    <th
      className={`sort-th sort-${align}${active ? ' sorted' : ''}`}
      aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}
    >
      <button
        type="button"
        className="sort-btn"
        onClick={() => onSort(sortKey)}
        title={
          active
            ? `Sorted by ${label}, ${dir === 'asc' ? 'lowest' : 'highest'} first — click to reverse`
            : `Sort by ${label}`
        }
      >
        {/* THE ARROW LEADS ON A MONEY COLUMN. Trailing it would push the
            heading left by its own width and the heading would stop lining up
            with the right-aligned figures under it — the same complaint the PO
            card headers drew, one column over. */}
        {align === 'right' && arrow}
        <span className="sort-label">{label}</span>
        {align !== 'right' && arrow}
      </button>
    </th>
  )
}

function InventoryDetail({
  detail,
  refreshKey = 0,
  onBack
}: {
  detail: Detail
  /** Bumped by every module reload — re-reads the rows this table derives its
   * money columns (and the totals row) from. Without it a scan committed while
   * this view is open would roll the average cost in the database and leave the
   * spread on screen frozen at its pre-scan value. */
  refreshKey?: number
  onBack: () => void
}): JSX.Element {
  const [rows, setRows] = useState<InventoryProduct[] | null>(null)
  const [hover, setHover] = useState<{ data: ProductCardData; style: CSSProperties } | null>(null)
  const closeTimer = useRef<number | undefined>(undefined)
  const [sort, setSort] = useState<SortState>(() => defaultInventorySort(detail.kind))

  // A new drill-down arrives sorted by the figure ITS tile counts — see
  // defaultInventorySort. Carrying the previous view's column across would
  // answer a question the operator asked about a different table.
  useEffect(() => {
    setSort(defaultInventorySort(detail.kind))
  }, [detail])

  useEffect(() => {
    let active = true
    const load = detail.kind === 'category' ? api.inventory.byCategory(detail.category) : api.inventory.list()
    load.then((r) => {
      // Not reset to null first: a refresh swaps the numbers in place instead of
      // flashing the whole table back to a spinner.
      if (active) setRows(r)
    })
    return () => {
      active = false
    }
  }, [detail, refreshKey])

  // Tear down any pending hover timer if the detail view unmounts.
  useEffect(
    () => () => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
    },
    []
  )

  const openHover = (p: InventoryProduct, rect: DOMRect): void => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    setHover({
      data: {
        productId: p.id,
        name: p.name,
        sku: p.sku,
        category: p.category,
        unitType: p.unitType,
        quantity: p.quantity,
        unitCost: p.unitCost,
        highBid: p.highBid,
        costValue: p.costValue,
        marketValue: p.marketValue
      },
      style: hoverStyle(rect)
    })
  }
  const scheduleClose = (): void => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setHover(null), 160)
  }
  const cancelClose = (): void => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
  }

  /**
   * WHAT the tile speaks for. Filtering only — the ORDER is the operator's now,
   * and the two must not be confused: re-ranking by Total cost on the Spread
   * drill-down must not drag an uncosted box into a total that excludes it.
   */
  const filtered = useMemo(() => {
    if (!rows) return []
    const withM = rows.map((p) => ({ p, m: productMetrics(p) }))
    switch (detail.kind) {
      // Inventory value counts every unit on hand, cost basis or not — which is
      // exactly what the tile above it counts.
      case 'value':
        return withM.filter((x) => x.p.quantity > 0)
      case 'cost':
        return withM.filter((x) => x.p.quantity > 0 && x.m.hasCost)
      // An uncosted box contributes nothing to the tile, so it is not listed
      // under it either — it is accounted for in the line above the table.
      case 'spread':
        return withM.filter((x) => x.p.quantity > 0 && x.m.hasCost && !x.m.outsideSpread)
      case 'cases':
        return withM.filter((x) => x.p.unitType === 'case' && x.p.quantity > 0)
      case 'skus':
      case 'category':
      default:
        return withM
    }
  }, [rows, detail])

  const shown = useMemo(() => sortInventoryRows(filtered, sort, sortRowOf), [filtered, sort])

  const onSort = useCallback((key: string) => {
    setSort((cur) => nextSortState(cur, key))
  }, [])

  /**
   * ONE list, drawn twice.
   *
   * The desktop draws it as clickable column headers; the phone, where the
   * table stacks into cards and the whole header row is hidden, draws it as a
   * picker above the cards. Deriving both from this means a column can never
   * become sortable on one and not the other.
   */
  const columns: { key: string; label: string; align: 'left' | 'center' | 'right' }[] = useMemo(
    () => [
      { key: 'product', label: 'Product', align: 'left' },
      { key: 'structure', label: 'Structure', align: 'left' },
      ...LOCATIONS.map((l) => ({
        key: locationSortKey(l.id),
        label: l.label,
        align: 'center' as const
      })),
      { key: 'total', label: 'Total', align: 'center' },
      { key: 'highBid', label: 'High bid', align: 'right' },
      { key: 'invValue', label: 'Inv. value', align: 'right' },
      { key: 'avgCost', label: 'Avg cost', align: 'right' },
      { key: 'totalCost', label: 'Total cost', align: 'right' },
      { key: 'spread', label: 'Spread', align: 'right' }
    ],
    []
  )

  if (rows === null) return <CenterLoader />

  // Stock the Spread tile does not speak for — uncosted boxes. Stated above the
  // table on the spread drill-down, because a total with products missing from
  // it has to say which and how much, or the operator is left subtracting tiles
  // to find out where the difference went.
  const held = rows.filter((p) => productMetrics(p).outsideSpread)
  const outside =
    detail.kind === 'spread' && held.length > 0
      ? { count: held.length, value: held.reduce((n, p) => n + p.marketValue, 0) }
      : null

  const totals = shown.reduce(
    (acc, { p, m }) => {
      acc.value += p.quantity > 0 ? m.invValue : 0
      acc.cost += m.hasCost && p.quantity > 0 ? m.totalCost : 0
      acc.spread += m.hasCost && p.quantity > 0 ? m.spread : 0
      // "On hand" counts cases specifically (matching the category cards), not a
      // mix of every unit type.
      acc.cases += p.unitType === 'case' ? p.quantity : 0
      return acc
    },
    { value: 0, cost: 0, spread: 0, cases: 0 }
  )

  return (
    <>
      <div className="section-head">
        <div className="row" style={{ gap: 12 }}>
          <Button variant="ghost" size="sm" icon="ArrowLeft" onClick={onBack}>
            Back
          </Button>
          <div>
            <h2>{detail.label}</h2>
            <p>
              {shown.length} product{shown.length === 1 ? '' : 's'} · {totals.cases} case
              {totals.cases === 1 ? '' : 's'} on hand
              {outside && (
                <>
                  {' '}
                  · {outside.count} uncosted box{outside.count === 1 ? '' : 'es'} not listed,{' '}
                  {formatMoney(outside.value)} of market value outside this figure
                </>
              )}
            </p>
          </div>
        </div>
      </div>

      {shown.length === 0 ? (
        <EmptyState icon="Boxes" title="Nothing to show here yet" />
      ) : (
        <>
          {/* The phone's version of the column headers. The stacked card layout
              hides the whole header row (mobile.css section 3), so without this
              the table could only be re-ranked on a desktop. Hidden above the
              breakpoint, where the headers themselves do the job. */}
          <div className="sort-bar">
            <label className="sort-bar-label" htmlFor="inv-sort">
              Sort by
            </label>
            <select
              id="inv-sort"
              className="input"
              value={sort.key}
              onChange={(e) => setSort({ key: e.target.value, dir: firstSortDir(e.target.value) })}
            >
              {columns.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
            <Button
              variant="ghost"
              size="sm"
              icon={sort.dir === 'asc' ? 'ChevronUp' : 'ChevronDown'}
              onClick={() => setSort((s) => ({ ...s, dir: s.dir === 'asc' ? 'desc' : 'asc' }))}
            >
              {sort.dir === 'asc' ? 'Lowest first' : 'Highest first'}
            </Button>
          </div>

          <div className="table-wrap">
          {/* The widest table in the app — product, structure, one column per
              location, then six money columns. On a phone it stacks into one
              card per product with each figure printed against its own header;
              see section 3 of styles/mobile.css. The location labels come from
              LOCATIONS so a new site cannot end up with an unlabelled line. */}
          <table className="data as-cards">
            <thead>
              <tr>
                {columns.map((c) => (
                  <SortTh
                    key={c.key}
                    label={c.label}
                    sortKey={c.key}
                    align={c.align}
                    sort={sort}
                    onSort={onSort}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map(({ p, m }) => (
                <tr
                  key={p.id}
                  className="hoverable-row"
                  style={{ opacity: p.quantity > 0 ? 1 : 0.55 }}
                  onMouseEnter={(e) => openHover(p, e.currentTarget.getBoundingClientRect())}
                  onMouseLeave={scheduleClose}
                >
                  <td>
                    <div style={{ fontWeight: 600 }}>{p.name}</div>
                    <div className="p-sub mono">{p.sku}</div>
                  </td>
                  <td data-label="Structure">
                    <UnitBadge unit={p.unitType} />
                  </td>
                  {LOCATIONS.map((l) => (
                    <td key={l.id} style={{ textAlign: 'center' }} className="mono" data-label={l.label}>
                      {formatUnitCount(p.quantityByLocation[l.id] ?? 0)}
                    </td>
                  ))}
                  <td style={{ fontWeight: 700, textAlign: 'center' }} data-label="Total">
                    {formatUnitCount(p.quantity)}
                  </td>
                  <td className="money" data-label="High bid">
                    {m.hasBid ? formatMoney(m.marketUnit) : dash}
                  </td>
                  <td className="money" data-label="Inv. value">
                    {p.quantity > 0 ? formatMoney(m.invValue) : dash}
                  </td>
                  <td className="money" data-label="Avg cost">
                    {m.hasCost ? formatUnitMoney(m.avgCost) : dash}
                  </td>
                  <td className="money" data-label="Total cost">
                    {m.hasCost && p.quantity > 0 ? formatMoney(m.totalCost) : dash}
                  </td>
                  {/* A dash, never $0.00, for a box the Spread excludes: zero is
                      a spread somebody measured, and this one has not been. */}
                  <td
                    className={`money ${m.hasCost ? (m.spread < 0 ? 'neg' : m.spread > 0 ? 'pos' : '') : ''}`}
                    data-label="Spread"
                  >
                    {m.hasCost && !m.outsideSpread && p.quantity > 0 ? formatMoney(m.spread) : dash}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="data-total">
                <td colSpan={3 + LOCATIONS.length} style={{ fontWeight: 700 }}>
                  Total
                </td>
                {/* Spacers holding the High bid and Avg cost columns open —
                    neither has a meaningful total. Empty, so the stacked phone
                    card drops them rather than printing a labelless blank line
                    that would read as a figure that failed to load. */}
                <td />
                <td className="money" data-label="Inv. value">
                  {formatMoney(totals.value)}
                </td>
                <td />
                <td className="money" data-label="Total cost">
                  {formatMoney(totals.cost)}
                </td>
                <td
                  className={`money ${totals.spread < 0 ? 'neg' : totals.spread > 0 ? 'pos' : ''}`}
                  data-label="Spread"
                >
                  {formatMoney(totals.spread)}
                </td>
              </tr>
            </tfoot>
          </table>
          </div>
        </>
      )}

      {hover && (
        <ProductHoverCard
          data={hover.data}
          style={hover.style}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        />
      )}
    </>
  )
}

const dash = <span className="muted">—</span>
