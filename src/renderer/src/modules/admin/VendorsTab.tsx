import { useCallback, useEffect, useMemo, useState } from 'react'
import type { VendorSummary } from '@shared/purchaseOrders'
import { hasVendorActivity } from '@shared/purchaseOrders'
import type { ContactImportResult } from '@shared/contacts'
import { summarizeImport } from '@shared/contacts'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { Button, CenterLoader, EmptyState } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { ImportReport } from '../../components/ImportReport'
import { useToast } from '../../components/Toast'
import { formatMoney, formatDate } from '../../lib/format'

/**
 * The people we buy from — the imported directory and the documents, on one list.
 *
 * ## Two halves that answer two different questions
 *
 * This screen used to be purely DERIVED: a vendor was a name that appeared
 * because somebody bought something, on a purchase order's free-text supplier or
 * on a cost layer. That was honest but half an answer — it could tell you who
 * this business does buy from and had nowhere at all to keep who it CAN buy
 * from, or a street address for any of them.
 *
 * Both halves are here now and neither replaces the other:
 *
 *   the DIRECTORY  the owner's own vendor list, imported (Import vendors). This
 *                  is who we can buy from. It carries an address and the label
 *                  they file the business under, and it can name a supplier
 *                  nobody has ordered from yet.
 *   the DOCUMENTS  orders, receipts, what has been spent, when they were last
 *                  dealt with. This is who we DO buy from. It is complete by
 *                  construction and cannot go stale.
 *
 * THE DERIVATION WAS NOT THROWN AWAY, and must not be. A vendor with activity
 * and no directory record still appears — most of the regular distributors were
 * typed straight onto purchase orders long before any list existed — and is
 * marked "not on the list", which is a to-do rather than an error. A directory
 * record with no activity appears too, marked "no orders yet". Drop either and
 * this screen quietly starts answering a narrower question than its title.
 *
 * See listVendors() for how the two are merged (on the name, case-insensitively,
 * exactly as the two document sources already merge with each other) and
 * db/vendorImport.ts for why an imported vendor is a contact record with a flag
 * rather than a row in a vendors table of its own.
 */

type Filter = 'all' | 'active' | 'directory'

export function VendorsTab(): JSX.Element {
  const toast = useToast()
  const [vendors, setVendors] = useState<VendorSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>('all')
  const [importing, setImporting] = useState(false)
  const [imported, setImported] = useState<ContactImportResult | null>(null)

  const load = useCallback(async () => {
    setVendors(await api.purchaseOrders.vendors())
  }, [])

  // Three tables feed this list and each moves for a different reason: a new
  // purchase order on another laptop adds a vendor, receiving stock adds one
  // with no order behind it, and a contact or vendor import is what fills the
  // directory half in. Watching only `purchasing` would leave the last two stale.
  useLiveRefresh([...LIVE.purchasing, 'inventory_lots', 'invoice_customers'], load)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        await load()
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [load])

  /**
   * Bring in the owner's vendor sheet.
   *
   * The result is kept on screen rather than announced in a toast and lost, the
   * same decision the customer import made and for the same reason: an import of
   * 151 rows says something about dozens of them — which were added, which
   * already existed, which had an address this app could not take apart — and a
   * line of text that disappears after four seconds is not a report anybody can
   * act on.
   */
  const importVendors = async (): Promise<void> => {
    if (importing) return
    setImporting(true)
    try {
      const res = await api.purchaseOrders.importVendors()
      if (!res.ok || !res.data) {
        if (res.error && res.error !== 'No file selected.') toast.error(res.error)
        return
      }
      setImported(res.data)
      await load()
      toast.success(summarizeImport(res.data))
    } finally {
      setImporting(false)
    }
  }

  const counts = useMemo(() => {
    const active = vendors.filter(hasVendorActivity).length
    return { all: vendors.length, active, directory: vendors.filter((v) => v.onFile).length }
  }, [vendors])

  // Overlapping on purpose rather than three exclusive buckets. "Bought from"
  // and "On the list" are two different questions and most vendors are the
  // answer to both; splitting them into disjoint groups would put the ordinary
  // case — a supplier who is on the list AND has been ordered from — into a
  // third tab labelled something nobody would think to click.
  const shown = useMemo(() => {
    if (filter === 'active') return vendors.filter(hasVendorActivity)
    if (filter === 'directory') return vendors.filter((v) => v.onFile)
    return vendors
  }, [vendors, filter])

  if (loading) return <CenterLoader />

  return (
    <>
      <div className="section-head">
        <div>
          <h2>Vendors</h2>
          <p className="section-sub">
            Everyone we can buy from, with what we have actually bought — most recent
            first.
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Button
            variant="secondary"
            icon="FileUp"
            loading={importing}
            onClick={() => void importVendors()}
          >
            Import vendors
          </Button>
        </div>
      </div>

      {imported && <ImportReport result={imported} onDismiss={() => setImported(null)} />}

      {vendors.length === 0 ? (
        <EmptyState
          icon="Truck"
          title="No vendors yet"
          message="A vendor appears here as soon as a purchase order names them, or as soon as stock is received against their name. Import your vendor list to add the ones you have not ordered from yet."
        />
      ) : (
        <>
          {/* The same pill group the Inventory and Performance headers use, so a
              filter looks like a filter everywhere in the app. */}
          <div className="tabs">
            <button
              className={`tab ${filter === 'all' ? 'active' : ''}`}
              onClick={() => setFilter('all')}
            >
              Everyone ({counts.all})
            </button>
            <button
              className={`tab ${filter === 'active' ? 'active' : ''}`}
              onClick={() => setFilter('active')}
            >
              Bought from ({counts.active})
            </button>
            <button
              className={`tab ${filter === 'directory' ? 'active' : ''}`}
              onClick={() => setFilter('directory')}
            >
              On the list ({counts.directory})
            </button>
          </div>

          <div className="table-wrap">
            {/* Six columns — name, contact, two counts, a total and a date — so on
                a phone it stacks into one card per vendor. See section 3 of
                styles/mobile.css. The name is the headline and carries no label;
                everything else prints its column header. */}
            <table className="data as-cards">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Contact</th>
                  <th style={{ textAlign: 'right' }}>Orders</th>
                  <th style={{ textAlign: 'right' }}>Receipts</th>
                  <th style={{ textAlign: 'right' }}>Ordered</th>
                  <th>Last</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((v) => (
                  <tr key={v.name.toLowerCase()}>
                    <td style={{ fontWeight: 600 }}>
                      {v.name}
                      {/* Which half of the list this row came from, said only when
                          it is one half and not both — the ordinary vendor is on
                          the list AND has been ordered from, and a badge on every
                          row is a badge nobody reads. */}
                      {!v.onFile && (
                        <span className="badge badge-soon" style={{ marginLeft: 8 }}>
                          Not on the list
                        </span>
                      )}
                      {v.onFile && !hasVendorActivity(v) && (
                        <span className="badge badge-staff" style={{ marginLeft: 8 }}>
                          No orders yet
                        </span>
                      )}
                      {v.label && <div className="vendor-label">{v.label}</div>}
                    </td>
                    <td className="muted" data-label="Contact">
                      {v.detail || '—'}
                    </td>
                    <td style={{ textAlign: 'right' }} data-label="Orders">
                      {v.orders}
                    </td>
                    {/* Stock received straight onto the shelf with no purchase
                        order behind it. Shown rather than folded into the order
                        count because they are different acts: one is paperwork
                        this app raised, the other is a case somebody carried in. */}
                    <td style={{ textAlign: 'right' }} data-label="Receipts">
                      {v.receipts}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }} data-label="Ordered">
                      {formatMoney(v.ordered)}
                    </td>
                    {/* "Never" rather than a dash or a blank. A vendor on the list
                        who has not been ordered from has no last date at all, and
                        an empty cell there reads as a date this app failed to
                        find rather than a thing that has not happened. */}
                    <td className="muted" data-label="Last">
                      {v.lastAt ? formatDate(v.lastAt) : 'Never'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <p className="inv-foot">
        <Icon name="Info" size={14} />
        <span>
          This list has two halves. <b>Import vendors</b> reads your vendor sheet and files
          everybody under the name it gives — that half is who you <b>can</b> buy from, and
          it is the only way an address or a filing label reaches this screen. The figures
          beside them are <b>derived</b> from documents: a vendor has orders because a
          purchase order names them and receipts because stock was booked in against their
          name, so that half is always exactly who you <b>do</b> buy from.{' '}
          <b>Ordered</b> is what those purchase orders came to, with cancelled ones left
          out — cancelled money was never committed — while <b>Orders</b> counts every one
          raised, cancelled included. Run the import again whenever the sheet changes; it
          updates rather than duplicates, and it never touches anything you typed here.
        </span>
      </p>
    </>
  )
}
