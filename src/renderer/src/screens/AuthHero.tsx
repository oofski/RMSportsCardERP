import { Brand } from '../components/Brand'
import { Icon } from '../components/Icon'

const POINTS = [
  {
    icon: 'ShieldCheck',
    title: 'Roles & permissions',
    text: 'Owner, Operations and Staff access — controlled from one place.'
  },
  {
    icon: 'Users',
    title: 'Your whole team',
    text: 'Add employees, invite them by email, and track their hours.'
  },
  {
    icon: 'Rocket',
    title: 'Built to grow',
    text: 'Nine modules — from orders to forecasting — arriving over time.'
  }
]

export function AuthHero(): JSX.Element {
  return (
    <div className="auth-hero">
      <Brand onNavy gold />
      <div>
        <h1>The operations backbone for RM Cardz.</h1>
        <p className="tagline">
          One place to run the business — employees, orders, ledger, invoicing and more.
        </p>
      </div>
      <div className="auth-hero-points">
        {POINTS.map((p) => (
          <div className="auth-hero-point" key={p.title}>
            <span className="ico">
              <Icon name={p.icon} size={18} />
            </span>
            <div>
              <h4>{p.title}</h4>
              <p>{p.text}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
