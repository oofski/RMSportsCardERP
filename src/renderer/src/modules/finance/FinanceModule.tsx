import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { EmptyState } from '../../components/ui'
import { CompletePnl } from './Pnl'
import { RatesTab } from './RatesTab'
import { StreamingTab } from './StreamingTab'
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
 * Wholesale still says plainly that it is not here yet rather than showing a
 * plausible-looking zero — a finance screen that invents a number is worse than
 * one that admits it has none.
 */
type FinanceTab = 'streaming' | 'rates' | 'wholesale' | 'pnl'

const TABS: Array<{ id: FinanceTab; label: string; icon: string }> = [
  { id: 'streaming', label: 'Streaming', icon: 'Activity' },
  { id: 'rates', label: 'Fees & rates', icon: 'Percent' },
  { id: 'wholesale', label: 'Wholesale', icon: 'Boxes' },
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
        <NotBuiltYet
          icon="Boxes"
          title="Wholesale is not built yet"
          lead="Bulk and wholesale orders sold off-stream."
        />
      ) : (
        <CompletePnl />
      )}
    </div>
  )
}

/**
 * An honest placeholder. It says what the tab will be, why it is not here, and
 * — most importantly — that no number on it is being estimated in the meantime.
 */
function NotBuiltYet({
  icon,
  title,
  lead
}: {
  icon: string
  title: string
  lead: string
}): JSX.Element {
  return (
    <section className="fin-soon">
      <span className="fin-soon-ico">
        <Icon name={icon} size={28} />
      </span>
      <h2>{title}</h2>
      <p>{lead}</p>
      <span className="fin-soon-tag">
        <Icon name="Sparkles" size={14} />
        Coming in a later release
      </span>
    </section>
  )
}
