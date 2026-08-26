import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PurchaseOrder } from '@shared/types'
import type { StockLocation } from '@shared/inventory'
import { isRoadshowLocation } from '@shared/inventory'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Button, CenterLoader, Modal } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { formatDate, formatMoney } from '../../lib/format'

/**
 * THE WAY IN TO A WEEK'S BUYING FROM A ROADSHOW SHOP.
 *
 * The owner's words: "the roadshow shops are a little different — we buy things
 * from them throughout the week and then pay once at the end ... a button on a
 * PO that for each of the 4 roadshows we can add what we buy from them for a
 * purchase order throughout the week."
 *
 * ## One row per shop, and the shops come off the location list
 *
 * Not a typed name and not a hand-kept list of four. Every roadshow is already a
 * place in this app called "Roadshow <somewhere>", and `isRoadshowLocation` is
 * the same test the picker uses to group them — so a fifth shop added next
 * season appears here the moment it is created, with nobody remembering to come
 * back and add it. See @shared/inventory.
 *
 * ## Pressing a row is find-or-create, and that is the whole design
 *
 * There is only ever ONE open tab per shop — a second would split a week's
 * trading across two amounts owed to somebody expecting one payment — so
 * "open the tab" and "start the tab" are the same press with the same outcome,
 * and nobody has to remember whether they bought anything on Monday. The row
 * says which of the two it will be before it is pressed, because the amount
 * already on a running tab is the thing somebody came here to see.
 *
 * ## The two figures always travel together
 *
 * "$1,240 · 3 not priced". The total is the PRICED lines only — a line nobody
 * has been given a price for contributes nothing — so printing it alone would
 * show a number that looks like the bill and is not, on the one screen used to
 * work out what to pay a shop. See @shared/roadshowTab.
 */
export function RoadshowTabsModal({
  onClose,
  onOpenTab
}: {
  onClose: () => void
  /**
   * Show the tab's own document. The receipt is where lines are added, prices
   * filled in and the week settled — this modal only decides WHICH tab, because
   * a second place to edit an order is a second place for the two to disagree.
   */
  onOpenTab: (poId: string) => void
}): JSX.Element {
  const toast = useToast()
  const [tabs, setTabs] = useState<PurchaseOrder[] | null>(null)
  const [places, setPlaces] = useState<StockLocation[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    /**
     * THE SHOPS ARE READ HERE, not taken from the shared `LOCATIONS` binding.
     *
     * That binding is a module-level registry hydrated once when the session is
     * read, and it is genuinely allowed to be stale — see the note in
     * session.tsx, which calls it display-only for exactly that reason. This
     * screen is the one place where a stale registry does not mislabel a row but
     * ERASES one: a shop missing from it is a shop with no way to start a tab,
     * and the answer looks like "the app does not know about Roadshow Tulsa".
     *
     * So it asks, every time it is opened. It also picks up a shop somebody
     * added five minutes ago at another bench, which the binding would not.
     *
     * BOTH READS ARE DEFENDED AGAINST A NON-ARRAY, because the two ends of a
     * channel are joined by a NAME and not by a type: a handler returning the
     * wrong shape typechecks perfectly on both sides and throws here, before a
     * single row is drawn. That happened once already — see IPC.poOpenTabs.
     */
    const [gotTabs, gotPlaces] = await Promise.all([
      api.purchaseOrders.openTabs(),
      api.inventory.locations().catch(() => [])
    ])
    setTabs(Array.isArray(gotTabs) ? gotTabs : [])
    setPlaces(Array.isArray(gotPlaces) ? gotPlaces : [])
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * The shops, with whatever tab each currently has running.
   *
   * Matched on the NAME, folded for case, because a tab's supplier is free text
   * on a purchase order — see @shared/purchaseOrders for why it is not a foreign
   * key — so "Roadshow Dallas" and "roadshow dallas" have to land on one row.
   */
  const shops = useMemo(() => {
    const byName = new Map<string, PurchaseOrder>()
    for (const t of tabs ?? []) {
      const key = (t.supplier ?? '').trim().toLowerCase()
      if (key && !byName.has(key)) byName.set(key, t)
    }
    const rows = places
      // Retired shops are dropped: a place nobody stocks any more is not
      // somewhere to start a week's buying. One that still has a tab RUNNING
      // comes back below, on the fallback, because money is owed on it.
      .filter((l) => !l.retired && isRoadshowLocation(l.id))
      .map((l) => ({
        name: l.label,
        tab: byName.get(l.label.trim().toLowerCase()) ?? null
      }))
    // A TAB WHOSE SHOP IS NOT ON THE LIST STILL SHOWS. A shop can be renamed or
    // retired while money is owed to it, and a row that quietly vanished would
    // take an open tab with it — the one outcome this screen must not have.
    const listed = new Set(rows.map((r) => r.name.trim().toLowerCase()))
    for (const t of tabs ?? []) {
      const key = (t.supplier ?? '').trim().toLowerCase()
      if (key && !listed.has(key)) rows.push({ name: t.supplier ?? '', tab: t })
    }
    return rows
  }, [tabs, places])

  const press = async (name: string, existing: PurchaseOrder | null): Promise<void> => {
    if (existing) {
      onOpenTab(existing.id)
      return
    }
    setBusy(name)
    try {
      // The destination is where the boxes end up, and a roadshow buy comes
      // HOME — it is carried back and checked in here. Anything else is a
      // per-line correction on the document, which the receipt can make.
      const res = await api.purchaseOrders.openTab(name, 'RM')
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Could not open that tab.')
        return
      }
      toast.success(`Tab open with ${name}.`)
      onOpenTab(res.data.id)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal
      title="Roadshow tabs"
      subtitle="Buy all week, settle up once"
      onClose={onClose}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      {tabs === null ? (
        <CenterLoader />
      ) : shops.length === 0 ? (
        <div className="rs-tabs-empty">
          <Icon name="Store" size={24} />
          <div>
            No roadshow shops yet. Add one on <b>Inventory → Locations</b> — anything called
            &ldquo;Roadshow …&rdquo; turns up here on its own.
          </div>
        </div>
      ) : (
        <div className="rs-tabs">
          {shops.map((s) => {
            const pending = s.tab?.pendingPriceCount ?? 0
            return (
              <button
                key={s.name}
                type="button"
                className={`rs-tab-row${s.tab ? ' is-open' : ''}`}
                disabled={busy === s.name}
                onClick={() => void press(s.name, s.tab)}
              >
                <span className="rs-tab-icon">
                  <Icon name="Store" size={18} />
                </span>
                <span className="rs-tab-main">
                  <span className="rs-tab-name">{s.name}</span>
                  <span className="rs-tab-sub">
                    {s.tab
                      ? `${s.tab.poNumber} · open since ${formatDate(s.tab.tabOpenedAt)}`
                      : 'No tab running — start one'}
                  </span>
                </span>
                {s.tab ? (
                  <span className="rs-tab-figs">
                    <span className="mono">{formatMoney(s.tab.total)}</span>
                    <em>
                      {pending > 0
                        ? `${pending} not priced`
                        : s.tab.lineCount === 0
                          ? 'nothing on it yet'
                          : 'all priced'}
                    </em>
                  </span>
                ) : (
                  <span className="rs-tab-figs">
                    <span className="rs-tab-start">Open a tab</span>
                  </span>
                )}
                <Icon name="ChevronRight" size={16} />
              </button>
            )
          })}
        </div>
      )}

      <div className="qbo-note">
        <Icon name="Info" size={15} />
        <div>
          A tab is an ordinary purchase order that <b>does not close itself</b>. Keep adding what
          you buy — leave the price blank if the shop has not said yet — and press{' '}
          <b>Settle &amp; pay</b> on it at the end of the week. Sales raised off a running tab share
          its deal ticket.
        </div>
      </div>
    </Modal>
  )
}
