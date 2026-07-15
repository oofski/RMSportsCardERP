import { useEffect, useMemo, useState } from 'react'
import { MODULES } from '@shared/modules'
import { COMPANY_NAME } from '@shared/config'
import { useSession } from '../lib/session'
import { ChromeContext } from '../lib/chrome'
import { Brand } from '../components/Brand'
import { Icon } from '../components/Icon'
import { Avatar } from '../components/ui'
import { UpdatePanel } from '../components/UpdatePanel'
import { initials, fullName } from '../lib/format'
import { roleLabel } from '@shared/permissions'
import { AdminModule } from '../modules/admin/AdminModule'
import { HomeModule } from '../modules/home/HomeModule'
import { ComingSoon } from '../modules/ComingSoon'

const HOME = { id: 'home', name: 'Home', description: 'Your operations overview.' }

export function AppShell(): JSX.Element {
  const { user, appInfo, can, logout } = useSession()
  const [showUpdates, setShowUpdates] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [activeId, setActiveId] = useState<string>('home')

  const visible = useMemo(
    () =>
      MODULES.filter((m) =>
        m.status === 'active' ? (m.permission ? can(m.permission) : true) : true
      ),
    [can]
  )

  // Let the dashboard's "Check for updates" quick action open the panel.
  useEffect(() => {
    const handler = (): void => setShowUpdates(true)
    window.addEventListener('rmops:check-updates', handler)
    return () => window.removeEventListener('rmops:check-updates', handler)
  }, [])

  const navigate = (id: string): void => {
    setActiveId(id)
    setSearch('')
  }

  if (!user) return <></>

  const activeModule = visible.find((m) => m.id === activeId)
  const header =
    activeId === 'home'
      ? HOME
      : activeModule
        ? { id: activeModule.id, name: activeModule.name, description: activeModule.description }
        : HOME

  return (
    <ChromeContext.Provider value={{ search, navigate }}>
      <div className="shell">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <Brand />
          </div>
          <div className="workspace">
            <span className="ws-ico">
              <Icon name="Building2" size={15} />
            </span>
            <span className="ws-meta">
              <span className="ws-label">Workspace</span>
              <span className="ws-name">{COMPANY_NAME}</span>
            </span>
            <Icon name="ChevronsUpDown" size={15} />
          </div>

          <nav className="nav">
            <button
              className={`nav-item ${activeId === 'home' ? 'active' : ''}`}
              onClick={() => navigate('home')}
            >
              <Icon name="LayoutDashboard" size={18} />
              <span>Home</span>
            </button>

            <div className="nav-section-label">Modules</div>
            {visible.map((m) => (
              <button
                key={m.id}
                className={`nav-item ${m.id === activeId ? 'active' : ''}`}
                onClick={() => navigate(m.id)}
              >
                <Icon name={m.icon} size={18} />
                <span>{m.name}</span>
                {m.status === 'coming-soon' && <span className="soon">SOON</span>}
              </button>
            ))}
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
          </div>
        </aside>

        <main className="main">
          <header className="topbar">
            <div className="title-block">
              <h1>{header.name}</h1>
              <p>{header.description}</p>
            </div>

            <div className="topsearch">
              <Icon name="Search" size={16} />
              <input
                placeholder="Search employees, modules…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div className="topbar-actions">
              <div className="usermenu">
                <button className="usermenu-btn" onClick={() => setMenuOpen((v) => !v)}>
                  <Avatar text={initials(user.firstName, user.lastName)} small />
                  <span className="um-name">{user.firstName}</span>
                  <Icon name="ChevronDown" size={15} />
                </button>
                {menuOpen && (
                  <>
                    <div
                      style={{ position: 'fixed', inset: 0, zIndex: 40 }}
                      onClick={() => setMenuOpen(false)}
                    />
                    <div className="usermenu-pop">
                      <div className="um-head">
                        <div className="um-h-name">{fullName(user.firstName, user.lastName)}</div>
                        <div className="um-h-email">{user.email}</div>
                        <div style={{ marginTop: 6 }}>
                          <span className={`badge badge-${user.role}`}>
                            <span className="dot" />
                            {roleLabel(user.role)}
                          </span>
                        </div>
                      </div>
                      <button
                        className="menu-item"
                        onClick={() => {
                          setMenuOpen(false)
                          setShowUpdates(true)
                        }}
                      >
                        <Icon name="RefreshCw" size={16} />
                        Check for updates
                      </button>
                      <button className="menu-item" onClick={() => logout()}>
                        <Icon name="LogOut" size={16} />
                        Sign out
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </header>

          <div className="content">
            {activeId === 'home' ? (
              <HomeModule />
            ) : activeModule?.id === 'admin' ? (
              <AdminModule />
            ) : activeModule ? (
              <ComingSoon module={activeModule} />
            ) : (
              <HomeModule />
            )}
          </div>
        </main>

        {showUpdates && <UpdatePanel onClose={() => setShowUpdates(false)} />}
      </div>
    </ChromeContext.Provider>
  )
}
