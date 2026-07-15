import { useMemo, useState } from 'react'
import { MODULES, type AppModule } from '@shared/modules'
import { useSession } from '../lib/session'
import { Brand } from '../components/Brand'
import { Icon } from '../components/Icon'
import { Avatar } from '../components/ui'
import { UpdatePanel } from '../components/UpdatePanel'
import { initials, fullName } from '../lib/format'
import { roleLabel } from '@shared/permissions'
import { AdminModule } from '../modules/admin/AdminModule'
import { ComingSoon } from '../modules/ComingSoon'

export function AppShell(): JSX.Element {
  const { user, appInfo, can, logout } = useSession()
  const [showUpdates, setShowUpdates] = useState(false)

  // Modules the user can see: active modules require their permission; the
  // not-yet-built modules are shown to everyone as a roadmap.
  const visible = useMemo(
    () =>
      MODULES.filter((m) =>
        m.status === 'active' ? (m.permission ? can(m.permission) : true) : true
      ),
    [can]
  )

  const [activeId, setActiveId] = useState<string>(() => {
    const firstActive = visible.find((m) => m.status === 'active')
    return (firstActive ?? visible[0])?.id ?? 'admin'
  })

  const active: AppModule | undefined = visible.find((m) => m.id === activeId) ?? visible[0]

  if (!user) return <></>

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Brand onNavy />
        </div>

        <div className="nav-section-label">Modules</div>
        <nav className="nav">
          {visible.map((m) => {
            const isActive = m.id === active?.id
            return (
              <button
                key={m.id}
                className={`nav-item ${isActive ? 'active' : ''}`}
                onClick={() => setActiveId(m.id)}
              >
                <Icon name={m.icon} size={18} />
                <span>{m.name}</span>
                {m.status === 'coming-soon' && <span className="soon">SOON</span>}
              </button>
            )
          })}
        </nav>

        <div className="sidebar-footer">
          <button
            className="sidebar-update"
            onClick={() => setShowUpdates(true)}
            title="Check for updates"
          >
            <Icon name="RefreshCw" size={16} />
            <span>Check for updates</span>
            <span className="ver">v{appInfo?.version ?? '0.0.0'}</span>
          </button>

          <div className="user-chip">
            <Avatar text={initials(user.firstName, user.lastName)} small />
            <div className="meta">
              <div className="u-name">{fullName(user.firstName, user.lastName)}</div>
              <div className="u-role">{roleLabel(user.role)}</div>
            </div>
            <button className="modal-close" onClick={() => logout()} title="Sign out">
              <Icon name="LogOut" size={17} />
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="title-block">
            <h1>{active?.name ?? 'RM Operations App'}</h1>
            <p>{active?.description}</p>
          </div>
        </header>

        <div className="content">
          {active?.id === 'admin' ? <AdminModule /> : active ? <ComingSoon module={active} /> : null}
        </div>
      </main>

      {showUpdates && <UpdatePanel onClose={() => setShowUpdates(false)} />}
    </div>
  )
}
