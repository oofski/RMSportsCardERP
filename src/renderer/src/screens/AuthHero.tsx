import { Brand } from '../components/Brand'
import { Icon } from '../components/Icon'

const POINTS = [
  { icon: 'ShieldCheck', title: 'Roles & permissions' },
  { icon: 'Users', title: 'Your whole team' },
  { icon: 'Rocket', title: 'Built to grow' }
]

export function AuthHero(): JSX.Element {
  return (
    <div className="auth-hero">
      <Brand onNavy gold />
      <div>
        <h1>The operations backbone for RM Cardz.</h1>
      </div>
      <div className="auth-hero-points">
        {POINTS.map((p) => (
          <div className="auth-hero-point" key={p.title}>
            <span className="ico">
              <Icon name={p.icon} size={18} />
            </span>
            <div>
              <h4>{p.title}</h4>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
