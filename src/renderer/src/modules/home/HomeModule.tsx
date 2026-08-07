import { useSession } from '../../lib/session'
import { useChrome } from '../../lib/chrome'
import { IS_WEB } from '../../lib/api'
import { Icon } from '../../components/Icon'
import { TimeClock } from '../../components/TimeClock'
import { OwnerBoard } from './OwnerBoard'

/**
 * The morning page.
 *
 * ONE question, asked in one order: what do I have to do today, and how is the
 * business doing. The owner drew it — two rows of three cards, then his own
 * to-do list underneath — and the drawing is the specification. Stock arriving,
 * packages going out and the notes people left him sit above the money, because
 * money is a report and the top row is work.
 *
 * ## What this page used to be
 *
 * Eleven things, most of them restatements of screens one click away: four stat
 * tiles counting employees, a donut of the same employees by role, a fourteen-day
 * area chart of hours, an average-hours tile, and a horizontally-scrolling
 * carousel of the modules already listed down the left-hand side. Every one of
 * them was true and none of them was ACTED on at eight in the morning. They were
 * built to have something to look at while the modules behind them were being
 * written, which is a real reason and an expired one.
 *
 * Most are gone rather than moved, because they already exist where they
 * belong: the employee counts are Admin → Employees, the totals behind the
 * hours figures are Time & Payroll, and the module list is the sidebar, which
 * is on screen at all times.
 *
 * TWO WERE DROPPED OUTRIGHT and it is worth saying so rather than implying a
 * relocation: the fourteen-day hours chart and the average-hours-per-active-
 * member tile exist nowhere else. Neither was ever acted on — they described
 * a trend nobody scheduled against — and Time & Payroll holds the underlying
 * hours if the question comes back. If it does, that is where they go.
 *
 * ONE behaviour of the carousel was not redundant and is kept below. The sidebar
 * filters modules by WORKSPACE as well as permission, so from the Operations
 * workspace the carousel was the only one-click route to the shipping floor.
 * "Tonight's floor" is that route, and `navigate` switches the workspace on the
 * way exactly as the carousel did.
 */
function greetingWord(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

export function HomeModule(): JSX.Element {
  const { user, can } = useSession()
  const { navigate } = useChrome()

  const canHours = can('admin.hours.view')
  const canInvoicing = can('module.invoicing')
  const canFloor = can('module.fulfillment')

  return (
    <div className="content-narrow">
      <div className="greeting">
        <h2>
          {greetingWord()}, {user?.firstName}
        </h2>
      </div>

      <div style={{ marginBottom: 16 }}>
        <TimeClock />
      </div>

      {/* The sketch, in full. Renders nothing for somebody whose permissions
          cover none of its sections, so the floor's home page stays simple. */}
      <OwnerBoard />

      <div className="panel-card" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3>Quick actions</h3>
        </div>
            {/* THREE, and each one lands on the thing it names.

                There is no router in this app: `navigate` takes a module id and
                nothing else, and every module holds its own tab in local state.
                So an action can only ever land on a module's DEFAULT screen —
                which is why "Upload packing slips" is not here. It would put
                somebody on Admin → Employees, three tabs from the importer, and
                an action that lands in the wrong place is worse than one that
                does not exist. The three below all have the thing they promise
                on the landing screen. */}
        <div className="qa-list">
              {canHours && (
                <QuickAction
                  icon="Wallet"
                  title="Run payroll"
                  desc="Timesheets and the Gusto export"
                  onClick={() => navigate('timepay')}
                />
              )}
              {canFloor && (
                <QuickAction
                  icon="Package"
                  title="Tonight's floor"
                  desc="The show, the bench and what is left to ship"
                  onClick={() => navigate('fulfillment')}
                />
              )}
              {canInvoicing && (
                <QuickAction
                  icon="FileText"
                  title="New purchase order"
                  desc="Order stock in"
                  onClick={() => navigate('invoicing')}
                />
              )}
              {/* Desktop only. In a browser the page is already the latest
                  version — see the note in services/updater.ts. */}
              {!IS_WEB && (
                <QuickAction
                  icon="RefreshCw"
                  title="Check for updates"
                  desc="Get the latest version"
                  onClick={() => window.dispatchEvent(new CustomEvent('rmops:check-updates'))}
                />
              )}
        </div>
      </div>
    </div>
  )
}

function QuickAction({
  icon,
  title,
  desc,
  onClick
}: {
  icon: string
  title: string
  desc: string
  onClick: () => void
}): JSX.Element {
  return (
    <button className="qa-chip" onClick={onClick}>
      <span className="qa-ico">
        <Icon name={icon} size={17} />
      </span>
      <span style={{ flex: 1 }}>
        <span className="qa-t" style={{ display: 'block' }}>
          {title}
        </span>
        <span className="qa-d" style={{ display: 'block' }}>
          {desc}
        </span>
      </span>
      <span className="qa-arrow">
        <Icon name="ArrowUpRight" size={16} />
      </span>
    </button>
  )
}
