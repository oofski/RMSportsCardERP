import { useState } from 'react'
import { InvoicesBoard } from './InvoicesBoard'
import { QuickBooksTab } from './QuickBooksTab'
import { ReadyToShipBoard } from './ReadyToShipBoard'

/**
 * Invoices — the sell side, and its own module.
 *
 * It began as a tab inside Purchase Orders on the argument that the two are
 * mirror images. They are, in shape — a party, some lines, a total — and that
 * turned out to be the wrong reason to share a door: nobody asks "what do we
 * owe" and "what are we owed" in the same breath, so the sell side was always
 * one extra click away and read as a footnote to the buy side.
 *
 * ## Three sub-tabs, and each is a different question
 *
 * SALES ORDERS is the board — where every invoice is, and which have been paid.
 * Laid out like the purchase-order board on purpose: same columns, same cards,
 * same drag. Somebody who has used one has used the other.
 *
 * READY TO SHIP is the same orders asked a DIFFERENT question: not where the
 * document is, but where the goods are. The two genuinely come apart — an order
 * can be paid with nothing in hand, or boxed and labelled while the buyer has
 * paid nothing because they are on delivery terms — which is why it is a second
 * board rather than more columns on the first. It sits here, beside the orders
 * it is about, rather than in Shipping: the person who raised the sale is the
 * one who knows whether the case turned up.
 *
 * QUICKBOOKS is the connection. It lives HERE rather than in Admin because
 * this is the only place in the app that uses it, and a setting whose only
 * consumer is three screens away is a setting nobody can find when it says it
 * is not connected.
 *
 * ## BUYERS IS GONE FROM HERE, AND IT DID NOT BECOME A SECOND COPY
 *
 * The customer list is one screen and it is now Admin → Customers, beside
 * Employees and Vendors, because those three are one question — who this
 * business deals with — and it was only ever filed here because invoices are
 * what references it. Nothing was duplicated: this module still picks a
 * customer through CustomerTypeahead, which searches that same table, and
 * typing a name nobody has on file still works exactly as it did.
 *
 * The cost of the move is real and worth writing down: an account granted
 * `module.invoicing` WITHOUT `admin.access` can raise a sales order and can no
 * longer open the customer list, because Admin is the door and admin.access is
 * its lock. No role in @shared/permissions grants one without the other — only
 * a hand-made per-person override could — so this is a corner, not a hole. If
 * it ever becomes somebody's actual job, the fix is a permission on the Admin
 * module, not a second customer screen in here.
 */
export function InvoicesModule(): JSX.Element {
  const [tab, setTab] = useState<'invoices' | 'ship' | 'quickbooks'>('invoices')

  return (
    <div className="content-narrow inv-shell">
      <div className="inv-scroll po-tab">
        <div className="seg-row">
          <button
            className={`seg ${tab === 'invoices' ? 'on' : ''}`}
            onClick={() => setTab('invoices')}
          >
            Sales Orders
          </button>
          <button className={`seg ${tab === 'ship' ? 'on' : ''}`} onClick={() => setTab('ship')}>
            Ready to Ship
          </button>
          <button
            className={`seg ${tab === 'quickbooks' ? 'on' : ''}`}
            onClick={() => setTab('quickbooks')}
          >
            QuickBooks
          </button>
        </div>

        {tab === 'invoices' && <InvoicesBoard onOpenQuickBooks={() => setTab('quickbooks')} />}
        {tab === 'ship' && <ReadyToShipBoard />}
        {tab === 'quickbooks' && <QuickBooksTab />}
      </div>
    </div>
  )
}
