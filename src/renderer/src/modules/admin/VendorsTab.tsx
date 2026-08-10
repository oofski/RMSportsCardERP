import { useCallback, useEffect, useState } from 'react'
import type { VendorSummary } from '@shared/purchaseOrders'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { CenterLoader, EmptyState } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { formatMoney, formatDate } from '../../lib/format'

/**
 * The people we buy from.
 *
 * ## READ THIS BEFORE ADDING AN "ADD VENDOR" BUTTON
 *
 * There is no vendor table in this app and this screen does not pretend there
 * is. A purchase order's supplier is free text — a nullable TEXT column with no
 * id and nothing pointing at it — and `inventory_lots.vendor` is the same thing
 * on a cost layer. So a vendor is not a record that can be created; it is a name
 * that appears because somebody bought something. See listVendors() for how the
 * list is assembled and @shared/purchaseOrders for why the supplier was never
 * turned into a foreign key.
 *
 * That makes this a DERIVED list, and derived is the right shape for it here:
 * it is complete by construction (nobody can be bought from without appearing),
 * it cannot go stale, and it cannot contain a distributor nobody has ordered
 * from since 2019 because somebody typed them in once.
 *
 * What it cannot do is hold an email or a phone number, because no purchase
 * order carries one. When a contact record happens to be filed under the same
 * name — the customer list is one list of people, not a sell-side one — its
 * details show in the Contact column. Most vendors will have nothing there, and
 * a dash is the honest answer: this app has never been told how to reach them.
 *
 * Filing vendor contact details properly is a schema question, not a screen
 * question, and it is deliberately NOT answered here. It needs either a vendors
 * table with an importer of its own, or a flag on the existing contact table
 * saying which side of the business each contact is on. Both are real work with
 * a real migration; neither should be guessed at from a spreadsheet nobody in
 * this repository has seen.
 */
export function VendorsTab(): JSX.Element {
  const [vendors, setVendors] = useState<VendorSummary[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setVendors(await api.purchaseOrders.vendors())
  }, [])

  // Three tables feed this list and each moves for a different reason: a new
  // purchase order on another laptop adds a vendor, receiving stock adds one
  // with no order behind it, and a contact import is what fills the Contact
  // column in. Watching only `purchasing` would leave the last two stale.
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

  if (loading) return <CenterLoader />

  return (
    <>
      <div className="section-head">
        <div>
          <h2>Vendors</h2>
          <p className="section-sub">
            Everyone this business has bought from, most recent first.
          </p>
        </div>
      </div>

      {vendors.length === 0 ? (
        <EmptyState
          icon="Truck"
          title="No vendors yet"
          message="A vendor appears here as soon as a purchase order names them, or as soon as stock is received against their name. There is nothing to add by hand — this list is what has actually been bought."
        />
      ) : (
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
              {vendors.map((v) => (
                <tr key={v.name.toLowerCase()}>
                  <td style={{ fontWeight: 600 }}>{v.name}</td>
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
                  <td className="muted" data-label="Last">
                    {formatDate(v.lastAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="inv-foot">
        <Icon name="Info" size={14} />
        <span>
          This list is <b>derived</b>, not typed: a vendor is here because a purchase
          order names them or because stock was received against their name, so it is
          always exactly who has been bought from. <b>Ordered</b> is what those purchase
          orders came to, with cancelled ones left out — cancelled money was never
          committed — while <b>Orders</b> counts every one raised, cancelled included.{' '}
          <b>Contact</b> is filled in only when somebody of that exact name is already on
          the customer list; this app has nowhere else to keep a vendor&apos;s email or
          phone number, and a dash means it has never been told one.
        </span>
      </p>
    </>
  )
}
