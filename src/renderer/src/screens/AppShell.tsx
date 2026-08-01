import { useCallback, useEffect, useMemo, useState } from 'react'
import { MODULES } from '@shared/modules'
import { StreamingModule } from '../modules/streaming/StreamingModule'
import { FinanceModule } from '../modules/finance/FinanceModule'
import { useSession } from '../lib/session'
import { useTheme } from '../lib/theme'
import { api } from '../lib/api'
import { ChromeContext } from '../lib/chrome'
import { Brand } from '../components/Brand'
import { Icon } from '../components/Icon'
import { LiveBadge } from '../components/LiveBadge'
import { Avatar } from '../components/ui'
import { UpdatePanel } from '../components/UpdatePanel'
import { useToast } from '../components/Toast'
import { initials, fullName } from '../lib/format'
import { roleLabel } from '@shared/permissions'
import { AdminModule } from '../modules/admin/AdminModule'
import { HomeModule } from '../modules/home/HomeModule'
import { TimePayrollModule } from '../modules/timepay/TimePayrollModule'
import { InventoryModule } from '../modules/inventory/InventoryModule'
import { InvoicingModule } from '../modules/invoicing/InvoicingModule'
import { ShippingModule } from '../modules/fulfillment/ShippingModule'
import { ComingSoon } from '../modules/ComingSoon'

const HOME = { id: 'home', name: 'Home', description: 'Your operations overview.' }

type WorkspaceId = 'ops' | 'shipping'

const WORKSPACES: { id: WorkspaceId; name: string; icon: string }[] = [
  { id: 'ops', name: 'RM Cardz Operations', icon: 'Building2' },
  { id: 'shipping', name: 'RM Cardz Shipping', icon: 'Truck' }
]

export function AppShell(): JSX.Element {
  const { user, appInfo, can, logout, refresh } = useSession()
  const { mode, toggle } = useTheme()
  const toast = useToast()
  const [showUpdates, setShowUpdates] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [wsOpen, setWsOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [activeId, setActiveId] = useState<string>('home')
  const [workspace, setWorkspace] = useState<WorkspaceId>(() => {
    const saved = localStorage.getItem('rmops.workspace')
    return saved === 'shipping' ? 'shipping' : 'ops'
  })

  const visible = useMemo(
    () =>
      MODULES.filter(
        (m) =>
          (m.workspace ?? 'ops') === workspace &&
          (m.status === 'active' ? (m.permission ? can(m.permission) : true) : true)
      ),
    [can, workspace]
  )

  // Switching workspace swaps the whole sidebar, so land on something that
  // exists there rather than leaving the old module mounted.
  const switchWorkspace = useCallback(
    (next: WorkspaceId): void => {
      setWorkspace(next)
      localStorage.setItem('rmops.workspace', next)
      setSearch('')
      setActiveId(next === 'shipping' ? 'fulfillment' : 'home')
    },
    []
  )

  useEffect(() => {
    const handler = (): void => setShowUpdates(true)
    window.addEventListener('rmops:check-updates', handler)
    return () => window.removeEventListener('rmops:check-updates', handler)
  }, [])

  // Modules live in workspaces, and `visible` is filtered by the active one —
  // so setting activeId alone silently no-ops when the target is in the OTHER
  // workspace (the render chain falls through to Home). Cross-workspace links
  // switch the sidebar first, which is what "go to that screen" has to mean.
  const navigate = (id: string): void => {
    const target = MODULES.find((m) => m.id === id)
    const targetWorkspace: WorkspaceId = target?.workspace ?? 'ops'
    if (target && targetWorkspace !== workspace) {
      setWorkspace(targetWorkspace)
      localStorage.setItem('rmops.workspace', targetWorkspace)
    }
    setActiveId(id)
    setSearch('')
  }

  if (!user) return <></>

  // Self-service profile picture: pick/remove the signed-in user's own photo,
  // then refresh the session so the shell + everywhere they appear updates.
  const changePhoto = async (): Promise<void> => {
    setMenuOpen(false)
    const res = await api.employees.setAvatar(user.id)
    if (res.ok) {
      await refresh()
      toast.success('Profile picture updated.')
    } else if (res.error && res.error !== 'No image selected.') {
      toast.error(res.error)
    }
  }
  const removePhoto = async (): Promise<void> => {
    setMenuOpen(false)
    const res = await api.employees.removeAvatar(user.id)
    if (res.ok) {
      await refresh()
      toast.success('Profile picture removed.')
    } else {
      toast.error(res.error ?? 'Could not remove the picture.')
    }
  }

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

          <div className="ws-switch">
            <button className="workspace" onClick={() => setWsOpen((v) => !v)}>
              <span className="ws-ico">
                <Icon name="Building2" size={15} />
              </span>
              <span className="ws-meta">
                <span className="ws-label">Workspace</span>
                <span className="ws-name">
                  {WORKSPACES.find((w) => w.id === workspace)?.name ?? 'RM Cardz Operations'}
                </span>
              </span>
              <Icon name="ChevronsUpDown" size={15} />
            </button>
            {wsOpen && (
              <>
                <div
                  style={{ position: 'fixed', inset: 0, zIndex: 40 }}
                  onClick={() => setWsOpen(false)}
                />
                <div className="ws-pop">
                  {WORKSPACES.map((ws) => (
                    <button
                      key={ws.id}
                      className="ws-item"
                      onClick={() => {
                        setWsOpen(false)
                        switchWorkspace(ws.id)
                      }}
                    >
                      <span className="ws-i">
                        <Icon name={ws.icon} size={14} />
                      </span>
                      <span className="ws-n">{ws.name}</span>
                      {ws.id === workspace && (
                        <span className="ws-check">
                          <Icon name="Check" size={16} />
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}
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
              <LiveBadge />
              <button
                className="icon-btn"
                onClick={toggle}
                title={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              >
                <Icon name={mode === 'dark' ? 'Sun' : 'Moon'} size={18} />
              </button>
              <button
                className="icon-btn"
                onClick={() => setShowUpdates(true)}
                title="Check for updates"
              >
                <Icon name="RefreshCw" size={18} />
              </button>

              <div className="usermenu">
                <button className="usermenu-btn" onClick={() => setMenuOpen((v) => !v)}>
                  <Avatar text={initials(user.firstName, user.lastName)} src={user.avatarUrl} small />
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
                        <div className="um-head-id">
                          <Avatar text={initials(user.firstName, user.lastName)} src={user.avatarUrl} />
                          <div>
                            <div className="um-h-name">{fullName(user.firstName, user.lastName)}</div>
                            <div className="um-h-email">{user.email}</div>
                          </div>
                        </div>
                        <div style={{ marginTop: 8 }}>
                          <span className={`badge badge-${user.role}`}>
                            <span className="dot" />
                            {roleLabel(user.role)}
                          </span>
                        </div>
                      </div>
                      <button className="menu-item" onClick={changePhoto}>
                        <Icon name="ImagePlus" size={16} />
                        {user.avatarUrl ? 'Change photo' : 'Add photo'}
                      </button>
                      {user.avatarUrl && (
                        <button className="menu-item" onClick={removePhoto}>
                          <Icon name="Trash2" size={16} />
                          Remove photo
                        </button>
                      )}
                      <button
                        className="menu-item"
                        onClick={() => {
                          setMenuOpen(false)
                          toggle()
                        }}
                      >
                        <Icon name={mode === 'dark' ? 'Sun' : 'Moon'} size={16} />
                        {mode === 'dark' ? 'Light mode' : 'Dark mode'}
                      </button>
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
            ) : activeModule?.id === 'timepay' ? (
              <TimePayrollModule />
            ) : activeModule?.id === 'inventory' ? (
              <InventoryModule />
            ) : activeModule?.id === 'finance' ? (
              <FinanceModule />
            ) : activeModule?.id === 'streaming' ? (
              <StreamingModule />
            ) : activeModule?.id === 'invoicing' ? (
              <InvoicingModule />
            ) : activeModule?.id === 'fulfillment' ? (
              <ShippingModule />
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
