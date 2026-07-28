import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { EmptyState } from '../../components/ui'
import { StreamingTab } from './StreamingTab'
import { financeReady } from './api'

/**
 * Finance — the module shell.
 *
 * Three tabs, one of them real. Streaming is built because it is where the
 * money is: the Whatnot ledger is the only complete record of what the business
 * earns, and until it is attributed to shows there is nothing to build a P&L
 * on. Wholesale and the complete P&L say plainly that they are not here yet
 * rather than showing a plausible-looking zero — a finance screen that invents
 * a number is worse than one that admits it has none.
 */
type FinanceTab = 'streaming' | 'wholesale' | 'pnl'

const TABS: Array<{ id: FinanceTab; label: string; icon: string }> = [
  { id: 'streaming', label: 'Streaming', icon: 'Activity' },
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
          lead="This is where streaming and wholesale revenue meet the cost of the goods that produced them, plus everything else the business spends."
          detail="It needs the two tabs beside it finished first, and it needs cost of goods, which the Streaming tab deliberately leaves out today. Until all of that is real, showing a profit figure here would be a guess dressed up as an answer."
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
