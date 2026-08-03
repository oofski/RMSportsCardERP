import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { EmptyState } from '../../components/ui'
import { RatesTab } from './RatesTab'
import { StreamingTab } from './StreamingTab'
import { financeReady } from './api'

/**
 * Finance — the module shell.
 *
 * Four tabs, two of them real. Streaming is built because it is where the money
 * is: the Whatnot ledger is the only complete record of what the business earns,
 * and until it is attributed to shows there is nothing to build a P&L on. Fees &
 * rates is built because Whatnot's ledger pays NET — the gross on the Streaming
 * tab is derived from it, and the commission rate is the one input that
 * derivation needs and the export does not carry. It lives here rather than in
 * Admin on the owner's call: the setting belongs beside the P&L it decides, not
 * three modules away from it.
 *
 * Wholesale and the complete P&L say plainly that they are not here yet rather
 * than showing a plausible-looking zero — a finance screen that invents a number
 * is worse than one that admits it has none.
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
          message="The app is running against a version that does not expose the finance bridge. Restart after updating and it will appear."
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
          lead="This tab will cover the revenue that does not come from a live show — bulk and wholesale orders sold off-stream."
          detail="Nothing is being calculated for it, so there is deliberately nothing on screen. When it lands it will read from the same ledger discipline as Streaming: real rows, attributed, or visibly not attributed."
        />
      ) : (
        <NotBuiltYet
          icon="BarChart3"
          title="The complete P&L is not built yet"
          lead="This is where streaming and wholesale profit meet everything else the business spends — rent, wages, supplies, the costs no show is responsible for."
          // Streaming's own statement is now complete down to net profit,
          // including cost of goods, so the old reason this tab was empty no
          // longer holds. The remaining reason is the honest one and it is
          // stated: Wholesale has no numbers at all yet.
          detail="Streaming already runs its own full P&L, cost of goods included. What is missing is the other half — Wholesale is not built, and no overhead is recorded anywhere yet. Adding those two up while one of them is empty would produce a profit figure that is simply too high."
        />
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
  lead,
  detail
}: {
  icon: string
  title: string
  lead: string
  detail: string
}): JSX.Element {
  return (
    <section className="fin-soon">
      <span className="fin-soon-ico">
        <Icon name={icon} size={28} />
      </span>
      <h2>{title}</h2>
      <p>{lead}</p>
      <p className="fin-soon-detail">{detail}</p>
      <span className="fin-soon-tag">
        <Icon name="Sparkles" size={14} />
        Coming in a later release
      </span>
    </section>
  )
}
