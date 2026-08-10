import { useState } from 'react'
import { useSession } from '../../lib/session'
import { Icon } from '../../components/Icon'
import { EmptyState } from '../../components/ui'
import { ShippingTab } from './ShippingTab'
import { StreamingTab } from './StreamingTab'

/**
 * Employee performance: two tabs, one built.
 *
 * SHIPPING answers what the owner asked — how many breaks and packages went
 * through a range, and how long each person takes at the five steps.
 * STREAMING is a stated gap rather than a hidden one; see StreamingTab.
 *
 * The permission check is here AND in the main process, and neither is
 * redundant. This one decides whether a door is drawn; that one decides whether
 * anything comes back through it. A gate that exists only in the UI is not a
 * gate — the same rule the bench checklist follows.
 */
export function PerformanceModule(): JSX.Element {
  const { can } = useSession()
  const [tab, setTab] = useState<'shipping' | 'streaming'>('shipping')

  if (!can('admin.access')) {
    return (
      <div className="content-narrow">
        <EmptyState
          icon="ShieldCheck"
          title="Not your report"
          message="Performance is limited to the accounts that can already see the timesheets."
        />
      </div>
    )
  }

  return (
    <div className="content-narrow">
      <div className="tabs">
        <button
          className={`tab ${tab === 'shipping' ? 'active' : ''}`}
          onClick={() => setTab('shipping')}
        >
          <Icon name="PackageCheck" size={16} />
          Shipping
        </button>
        <button
          className={`tab ${tab === 'streaming' ? 'active' : ''}`}
          onClick={() => setTab('streaming')}
        >
          <Icon name="CircleDot" size={16} />
          Streaming
          {/* Says what it is before it is clicked. A tab that looks identical to
              a working one and then apologises is a click somebody has to spend
              to learn something the strip could have told them. */}
          <span className="ship-tab-badge warning">soon</span>
        </button>
      </div>

      {tab === 'shipping' ? <ShippingTab /> : <StreamingTab />}
    </div>
  )
}
