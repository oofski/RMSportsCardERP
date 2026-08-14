import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { EmptyState } from '../../components/ui'
import { CompletePnl } from './Pnl'
import { RatesTab } from './RatesTab'
import { StreamingTab } from './StreamingTab'
import { HistoryTab } from './HistoryTab'
import { WholesaleTab } from './WholesaleTab'
import { financeReady } from './api'

/**
 * Finance — the module shell.
 *
 * Four tabs, three of them real. Streaming is built because it is where the
 * money is: the Whatnot ledger is the only complete record of what the business
 * earns, and until it is attributed to shows there is nothing to build a P&L on.
 * Fees & rates is built because Whatnot's ledger pays NET — the gross on the
 * Streaming tab is derived from it, and the commission rate is the one input
 * that derivation needs and the export does not carry. It lives here rather than
 * in Admin on the owner's call: the setting belongs beside the P&L it decides,
 * not three modules away from it.
 *
 * The complete P&L is now the STATEMENT AS A REPORT YOU CAN OPEN — every figure
 * on it drills to the records that add up to it, which is what the owner asked
 * for when he asked for it to work like QuickBooks. It said "not built yet" for
 * four releases on the grounds that a complete P&L needs wholesale and overhead
 * too; that is still true and the page says so at its foot, but withholding the
 * half that does exist bought nobody anything.
 *
 * History is the year's ledger of orders, both sides. It exists because a
 * purchase order that has been received and settled has no work left on it, so
 * it leaves the board two days later — and something has to be the place it goes.
 * Nothing is deleted: every line, date and price is still on the row.
 *
 * Wholesale is built now, and what unblocked it was not this screen: a sales
 * order used to move no stock, so nothing off-stream had a cost attached and any
 * margin here would have been invented. Orders take their own FIFO layers now,
 * so every row on that tab is a subtraction between two numbers the app holds.
 * The rows it CANNOT price — lines shipped under the old fulfilment model — are
 * listed and excluded from the totals rather than counted at zero, which is the
 * same principle the placeholder was defending.
 */
type FinanceTab = 'streaming' | 'rates' | 'wholesale' | 'history' | 'pnl'

const TABS: Array<{ id: FinanceTab; label: string; icon: string }> = [
  { id: 'streaming', label: 'Streaming', icon: 'Activity' },
  { id: 'rates', label: 'Fees & rates', icon: 'Percent' },
  { id: 'wholesale', label: 'Wholesale', icon: 'Boxes' },
  { id: 'history', label: 'History', icon: 'ClipboardList' },
  { id: 'pnl', label: 'Complete P&L', icon: 'BarChart3' }
]

export function FinanceModule(): JSX.Element {
  const [tab, setTab] = useState<FinanceTab>('streaming')

  if (!financeReady) {
    return (
      <div className="content-narrow fin-shell">
        <EmptyState
          icon="AlertTriangle"
          title="Finance is not available in this build"
          message="This build does not expose the finance bridge. Restart after updating."
        />
      </div>
    )
  }

  return (
    <div className="content-narrow fin-shell">
      <div className="tabs fin-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <Icon name={t.icon} size={16} />
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'streaming' ? (
        <StreamingTab />
      ) : tab === 'rates' ? (
        <RatesTab />
      ) : tab === 'wholesale' ? (
        <WholesaleTab />
      ) : tab === 'history' ? (
        <HistoryTab />
      ) : (
        <CompletePnl />
      )}
    </div>
  )
}
