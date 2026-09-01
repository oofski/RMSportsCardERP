import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PurchaseOrder } from '@shared/types'
import type { StockAtLocationRow } from '@shared/availability'
import { ROADSHOW_SHOPS, emptyShelfHeadline, unpricedTabWarning } from '@shared/roadshowTab'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { Icon } from '../../components/Icon'
import { Button, CenterLoader } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { formatMoney } from '../../lib/format'
import { AddToShopModal } from './AddToShopModal'
import { ShopBuysPanel } from './ShopBuysPanel'

/**
 * THE FOUR SHOPS, AND WHAT IS STANDING IN EACH.
 *
 * The owner, cutting his own feature down to what he actually wanted: "all I
 * want is that I can put products into each roadshow column and see what I have
 * — just what products I have — and then I can create sales orders using both my
 * on-hand location and Kentucky."
 *
 * ## What this replaces
 *
 * Every one of those things already worked, and not one of them was reachable.
 * Putting stock at a shop meant raising a purchase order, finding the Roadshow
 * tick, and typing the shop's name EXACTLY as it was typed last time — because
 * that typed string became the shelf. Seeing what was there meant opening the
 * tab and adding up its lines by eye. So the feature existed and the front door
 * did not.
 *
 * Four columns. Pick a shop, add what you bought, look at what is there.
 *
 * ## The columns are the SHELVES, not the tabs
 *
 * Read from `stockAtLocation` — the same table a sales order draws from — rather
 * than from the open tab's lines. The tab is what was BOUGHT and the shelf is
 * what is THERE, and after the first sale those stop being the same number: a
 * case sold out of Kentucky stays on the tab for ever, and a case that reached
 * Kentucky any other way was never on one. Reading the shelf means this board
 * and the sales order can never disagree about what is available, which is the
 * only property that makes the board worth looking at.
 *
 * ## The tab is still down there, and still where the money is
 *
 * Each column names its open tab and what the week has come to, and that is all:
 * pricing, closing and settling stay on the purchase order's own screen, where
 * they already work and where the deal ticket and the bill live. Duplicating
 * them here would be a second place to settle a week, and two places to do one
 * thing is how they come to disagree.
 */
export function RoadshowBoard(): JSX.Element {
  const toast = useToast()
  const [tabs, setTabs] = useState<PurchaseOrder[] | null>(null)
  const [stock, setStock] = useState<Record<string, StockAtLocationRow[]>>({})
  const [adding, setAdding] = useState<string | null>(null)
  /** The tile somebody opened, and which shop it is on. Null the rest of the time. */
  const [openTile, setOpenTile] = useState<{ shop: string; product: StockAtLocationRow } | null>(
    null
  )

  const load = useCallback(async () => {
    const [openTabs, ...shelves] = await Promise.all([
      api.purchaseOrders.openTabs(),
      ...ROADSHOW_SHOPS.map((shop) => api.inventory.stockAtLocation(shop))
    ])
    const next: Record<string, StockAtLocationRow[]> = {}
    ROADSHOW_SHOPS.forEach((shop, i) => {
      next[shop] = shelves[i] ?? []
    })
    setStock(next)
    setTabs(openTabs)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * IT REPAINTS WHEN THE FACTS MOVE, which every other board here already did.
   *
   * This one read once on mount and then only after its own Add — so a price
   * filled in on the purchase order, a case sold at the counter, or anything a
   * second laptop did left the columns showing what was true when the screen was
   * opened. On a Saturday that is the whole point of the board: two people are
   * buying and selling out of the same four shelves at once, and the one staring
   * at this screen was the one with the stale numbers.
   *
   * BOTH families, because the card is two different facts. The columns are the
   * SHELVES (inventory) and the footer is the TAB (purchasing), and watching one
   * would leave the other half of every card stale — which reads as the two
   * disagreeing rather than as one of them being old.
   */
  useLiveRefresh([...LIVE.purchasing, ...LIVE.inventory], () => {
    void load()
  })

  /**
   * The open tab for each shop, folded for case.
   *
   * A purchase order's supplier is free text — see @shared/purchaseOrders for
   * why it is not a foreign key — so a tab raised before the shops became a list
   * may be spelled differently in case. Matching case-insensitively is what lets
   * this board adopt a week that is already running rather than offering to open
   * a second one beside it.
   */
  const tabFor = useMemo(() => {
    const by = new Map<string, PurchaseOrder>()
    for (const t of tabs ?? []) {
      const who = (t.supplier ?? '').trim().toLowerCase()
      if (who && !by.has(who)) by.set(who, t)
    }
    return by
  }, [tabs])

  if (tabs === null) return <CenterLoader />

  return (
    <>
      <div className="rs-board">
        {ROADSHOW_SHOPS.map((shop) => {
          const rows = stock[shop] ?? []
          const units = rows.reduce((n, r) => n + r.quantity, 0)
          const tab = tabFor.get(shop.toLowerCase()) ?? null
          // The shelf and the tab are two different facts, and this is the one
          // place they are held together — so both sentences are derived here.
          const standing = tab
            ? {
                poNumber: tab.poNumber,
                orderedUnits: tab.orderedUnits,
                receivedUnits: tab.receivedUnits,
                pendingPriceCount: tab.pendingPriceCount ?? 0
              }
            : null
          const headline = emptyShelfHeadline(standing)
          // NOT INSIDE THE EMPTY BRANCH. An unpriced line matters MOST on a
          // column that still holds its cases — those are standing there at a
          // cost of zero and every screen that values stock is reading it. See
          // unpricedTabWarning.
          const warning = unpricedTabWarning(standing)
          return (
            <section className="rs-col" key={shop}>
              <header className="rs-col-head">
                <div className="rs-col-name">
                  <Icon name="Store" size={15} />
                  <span>{shop}</span>
                </div>
                {/* THE COUNT IS UNITS ON THE SHELF, not lines on the tab. See
                    the note at the top: after the first sale those are two
                    different numbers, and this is the one somebody can pick
                    from. */}
                <span className="rs-col-count" title="Units standing at this shop">
                  {units}
                </span>
              </header>

              {rows.length === 0 ? (
                /* WHY IT IS EMPTY, not merely THAT it is. A shop with a running
                   tab has almost never had "nothing added" — a case bought and
                   sold the same afternoon leaves the shelf at zero and the tab
                   holding it for ever — and saying so invites somebody to add it
                   twice. See emptyShelfHeadline. */
                <div className="rs-col-empty">
                  <p>{headline}</p>
                </div>
              ) : (
                <ul className="rs-list">
                  {rows.map((r) => (
                    <li key={r.productId}>
                      {/* A TILE, and it opens. The count answers "have I got
                          any"; the dates and the order numbers answer "when did
                          I buy these and what did they cost", which is the
                          question at settling-up time and the one this column
                          could not reach. See ShopBuysPanel. */}
                      <button
                        type="button"
                        className="rs-item"
                        onClick={() => setOpenTile({ shop, product: r })}
                        title={`When ${r.name} was bought at ${shop}`}
                      >
                        <span className="rs-item-name">{r.name}</span>
                        <span className="rs-item-qty mono">{r.quantity}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {/* AFTER the list and before the buttons, on every column that
                  has one. Below the products because it is about them, and
                  above the footer because filling the price in is the thing it
                  is asking for. */}
              {warning && <p className="rs-col-warn">{warning}</p>}

              <footer className="rs-col-foot">
                <Button
                  size="sm"
                  icon="Plus"
                  onClick={() => setAdding(shop)}
                  title={`Add what you just bought at ${shop}`}
                >
                  Add what you bought
                </Button>
                {/* WHAT THE WEEK HAS COME TO, and where to go to settle it.
                    Named rather than counted — "PO-0424" is something somebody
                    can go and find, and "1 open tab" is not. */}
                {tab ? (
                  <span className="rs-col-tab" title="The open tab for this shop, on the purchase board">
                    {tab.poNumber} · {formatMoney(tab.total)}
                    {(tab.pendingPriceCount ?? 0) > 0 && (
                      <span className="rs-col-pending">
                        {tab.pendingPriceCount} unpriced
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="rs-col-tab is-none">no tab open</span>
                )}
              </footer>
            </section>
          )
        })}
      </div>

      {openTile && (
        <ShopBuysPanel
          shop={openTile.shop}
          product={openTile.product}
          onClose={() => setOpenTile(null)}
          onMoved={async (what) => {
            toast.success(what)
            await load()
          }}
        />
      )}

      {adding && (
        <AddToShopModal
          shop={adding}
          tab={tabFor.get(adding.toLowerCase()) ?? null}
          onClose={() => setAdding(null)}
          onAdded={async (what) => {
            setAdding(null)
            toast.success(what)
            await load()
          }}
        />
      )}
    </>
  )
}
