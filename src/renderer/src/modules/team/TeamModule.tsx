import { TEAM_TABS } from '@shared/modules'
import { useSession } from '../../lib/session'
import { Icon } from '../../components/Icon'
import { EmptyState } from '../../components/ui'
import { ContactsModule } from '../contacts/ContactsModule'
import { TimePayrollModule } from '../timepay/TimePayrollModule'
import { ScheduleModule } from '../schedule/ScheduleModule'

/**
 * Team: one door for the three questions people ask about people.
 *
 * Contacts, Pay and Schedule used to be three entries in the sidebar. They are
 * one subject — who works here, what they are owed, when they are in — and
 * three slots of a list somebody reads at eight in the morning is a real cost
 * for a grouping that was never argued for, only accumulated.
 *
 * ## Nothing inside this file knows it was regrouped
 *
 * The three screens are mounted UNCHANGED. This is a tab strip and a switch,
 * not a rewrite: each module keeps its own state, its own fetches and its own
 * live-refresh subscriptions, so moving them cost nothing behaviourally and
 * moving one back out would cost nothing either.
 *
 * ## The tab ids are the OLD module ids
 *
 * Deliberately. `navigate('timepay')` is called from the home board, from the
 * staff board and from Admin, and somebody's browser may have remembered
 * `schedule` as where they were. The shell translates those ids into "Team, on
 * that tab" (see `teamTabFor`), which is why none of those call sites had to
 * learn about the regrouping.
 *
 * ## Why the tabs are filtered rather than assumed
 *
 * Two of the three are open to everyone by definition and Contacts needs
 * `module.messages`, which every role holds — so in practice everybody sees
 * three. But a role could be narrowed tomorrow, and a tab strip that renders a
 * heading for a screen the person cannot open is worse than one that does not:
 * it teaches them the app is broken rather than that the door is closed.
 */
export function TeamModule({
  tab,
  onTab
}: {
  tab: string
  onTab: (id: string) => void
}): JSX.Element {
  const { can } = useSession()
  const tabs = TEAM_TABS.filter((t) => (t.permission ? can(t.permission) : true))

  // Nothing to show at all. Only reachable if a role is narrowed past every tab,
  // and it says so rather than rendering an empty strip over a blank page.
  if (tabs.length === 0) {
    return (
      <div className="content-narrow">
        <EmptyState
          icon="Users"
          title="Nothing here for you yet"
          message="Your account does not have access to any of the team screens."
        />
      </div>
    )
  }

  // The remembered tab may be one this person cannot open — a role narrowed
  // since they last looked, or a `navigate('contacts')` from a stale link. Fall
  // back to the first they CAN, rather than rendering nothing under a strip
  // that shows a different tab as selected.
  const active = tabs.some((t) => t.id === tab) ? tab : tabs[0].id

  return (
    <div className="team">
      <div className="team-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={t.id === active}
            className={`team-tab ${t.id === active ? 'on' : ''}`}
            title={t.description}
            onClick={() => onTab(t.id)}
          >
            <Icon name={t.icon} size={15} />
            {t.label}
          </button>
        ))}
      </div>

      {/* Mounted, not routed. Switching tabs unmounts the previous screen, which
          is what keeps each one's fetches honest — a Pay tab left mounted behind
          Schedule would go on polling hours nobody is looking at. */}
      {active === 'contacts' && <ContactsModule />}
      {active === 'timepay' && <TimePayrollModule />}
      {active === 'schedule' && <ScheduleModule />}
    </div>
  )
}
