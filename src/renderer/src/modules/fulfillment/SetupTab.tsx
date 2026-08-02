import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { UploadTab } from './UploadTab'
import { AssignTab } from './AssignTab'
import { SupplyPlanTab } from './SupplyPlanTab'
import type { ShipTabProps } from './ShippingModule'

/**
 * Setup — running the show, as opposed to doing it.
 *
 * Two jobs that only happen at the start of a night, and only for whoever is in
 * charge: get the slips in, and decide who is on which break. They sit together
 * because they are one sitting — you import, you look at what came out, you hand
 * it out — and away from Find and Pack because nobody working the floor should
 * have to walk past the button that replaces the dataset.
 *
 * Assigning used to live in the Admin module behind admin.access, which meant
 * the people who most needed to see who was on what — the floor — could not
 * reach it at all.
 */
type Section = 'import' | 'assign' | 'supplies'

export function SetupTab(props: ShipTabProps): JSX.Element {
  const [section, setSection] = useState<Section>('import')

  return (
    <div className="setup-page">
      <div className="setup-switch">
        <button
          className={`setup-seg ${section === 'import' ? 'active' : ''}`}
          onClick={() => setSection('import')}
        >
          <Icon name="UploadCloud" size={15} />
          Import
        </button>
        <button
          className={`setup-seg ${section === 'assign' ? 'active' : ''}`}
          onClick={() => setSection('assign')}
        >
          <Icon name="UserCheck" size={15} />
          Who is on what
        </button>
        <button
          className={`setup-seg ${section === 'supplies' ? 'active' : ''}`}
          onClick={() => setSection('supplies')}
        >
          <Icon name="Boxes" size={15} />
          What it takes
        </button>
      </div>

      {section === 'import' && <UploadTab {...props} />}
      {section === 'assign' && <AssignTab />}
      {section === 'supplies' && <SupplyPlanTab />}
    </div>
  )
}
