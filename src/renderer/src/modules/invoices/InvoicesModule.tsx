import { useState } from 'react'
import { InvoicesBoard } from './InvoicesBoard'
import { BuyersTab } from './BuyersTab'
import { QuickBooksTab } from './QuickBooksTab'

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
 * INVOICES is the board — where every invoice is, and which have been paid.
 * Laid out like the purchase-order board on purpose: same columns, same cards,
 * same drag. Somebody who has used one has used the other.
 *
 * BUYERS is the people. It exists because the answer to "pick a buyer and it
 * fills itself in" has to be maintained somewhere, and burying that inside the
 * invoice form meant a buyer could only be corrected while writing an invoice
 * to them.
 *
 * QUICKBOOKS is the connection. It lives HERE rather than in Admin because
 * this is the only place in the app that uses it, and a setting whose only
 * consumer is three screens away is a setting nobody can find when it says it
 * is not connected.
 */
export function InvoicesModule(): JSX.Element {
  const [tab, setTab] = useState<'invoices' | 'buyers' | 'quickbooks'>('invoices')

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
          <button className={`seg ${tab === 'buyers' ? 'on' : ''}`} onClick={() => setTab('buyers')}>
            Buyers
          </button>
          <button
            className={`seg ${tab === 'quickbooks' ? 'on' : ''}`}
            onClick={() => setTab('quickbooks')}
          >
            QuickBooks
          </button>
        </div>

        {tab === 'invoices' ? (
          <InvoicesBoard onOpenQuickBooks={() => setTab('quickbooks')} />
        ) : tab === 'buyers' ? (
          <BuyersTab />
        ) : (
          <QuickBooksTab />
        )}
      </div>
    </div>
  )
}
