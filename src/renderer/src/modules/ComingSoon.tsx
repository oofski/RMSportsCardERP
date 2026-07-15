import type { AppModule } from '@shared/modules'
import { Icon } from '../components/Icon'

export function ComingSoon({ module }: { module: AppModule }): JSX.Element {
  return (
    <div className="coming">
      <div className="c-ico">
        <Icon name={module.icon} size={34} />
      </div>
      <h2>{module.name}</h2>
      <p>{module.description}</p>
      <span className="roadmap-tag">
        <Icon name="Sparkles" size={15} />
        On the roadmap
      </span>
    </div>
  )
}
