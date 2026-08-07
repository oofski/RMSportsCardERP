import { Icon } from '../../components/Icon'

/**
 * Bringing somebody new on.
 *
 * A PLACEHOLDER, deliberately and visibly. The owner asked for the tab now and
 * the substance later, and the honest way to hold a space is to say what it is
 * for and what it does not do yet — rather than a half-built checklist that
 * somebody starts relying on before it works.
 *
 * What it lists is not invented: every step below is something the app can
 * already do, in the place it already does it. So the tab is useful the day it
 * ships — it is the order of operations for a new hire, written down — and it
 * becomes the specification for what gets automated here.
 */
const STEPS: Array<{ title: string; detail: string; where: string }> = [
  {
    title: 'Create the account',
    detail: 'Name, company ID, role and title. They get an invite with a temporary password.',
    where: 'Admin → Employees → Add employee'
  },
  {
    title: 'Set what they can reach',
    detail:
      'The role decides it. Shipping is the packing bench and nothing else; Staff adds inventory. Anything beyond the role is a per-person override.',
    where: 'Admin → Roles & Permissions'
  },
  {
    title: 'Give them a clock-in PIN',
    detail:
      'Four digits, for the clock portal. Without one the portal refuses them, which is the commonest first-day problem.',
    where: 'Admin → Employees → PIN'
  },
  {
    title: 'Show them the floor',
    detail: 'The bench: claiming an order, checking cards off, packing and sending back.',
    where: 'Shipping → Today'
  },
  {
    title: 'First shift',
    detail: 'They clock in from Home, or from the portal on the warehouse tablet.',
    where: 'Home → the time clock'
  }
]

export function OnboardingTab(): JSX.Element {
  return (
    <div className="panel-card">
      <div className="panel-head">
        <div>
          <h3>Onboarding a new hire</h3>
          <span className="ph-sub">The order it happens in</span>
        </div>
      </div>

      <div className="onb-note">
        <Icon name="Info" size={15} />
        <span>
          Nothing here is automated yet — this is the checklist, and each step names the screen that
          does it. Ticking, assigning and tracking a new starter comes later.
        </span>
      </div>

      <ol className="onb-steps">
        {STEPS.map((s, i) => (
          <li key={s.title}>
            <span className="onb-n">{i + 1}</span>
            <div className="onb-body">
              <div className="onb-title">{s.title}</div>
              <div className="onb-detail">{s.detail}</div>
              <div className="onb-where">{s.where}</div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
