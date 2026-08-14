import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MODULES, inWorkspace } from '@shared/modules'
import { isPhoneWidth } from '../lib/viewport'
import { StreamingModule } from '../modules/streaming/StreamingModule'
import { FinanceModule } from '../modules/finance/FinanceModule'
import { useSession } from '../lib/session'
import { api, IS_WEB } from '../lib/api'
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
import { PerformanceModule } from '../modules/performance/PerformanceModule'
import { HomeModule } from '../modules/home/HomeModule'
import { TimePayrollModule } from '../modules/timepay/TimePayrollModule'
import { ScheduleModule } from '../modules/schedule/ScheduleModule'
import { InventoryModule } from '../modules/inventory/InventoryModule'
import { InvoicingModule } from '../modules/invoicing/InvoicingModule'
import { InvoicesModule } from '../modules/invoices/InvoicesModule'
import { ContactsModule } from '../modules/contacts/ContactsModule'
import { AccountModule } from '../modules/account/AccountModule'
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
  const toast = useToast()
  const [showUpdates, setShowUpdates] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [wsOpen, setWsOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [activeId, setActiveId] = useState<string>('home')
  const navRef = useRef<HTMLElement | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceId>(() => {
    const saved = localStorage.getItem('rmops.workspace')
    return saved === 'shipping' ? 'shipping' : 'ops'
  })

  /**
   * Is the left-hand nav hidden?
   *
   * REMEMBERED, because it is a preference about how somebody wants to work
   * rather than a transient bit of screen state. Reading a 59-column shipping
   * table or a P&L on a laptop is the case this exists for, and having to
   * re-collapse the nav on every reload would make it not worth pressing.
   *
   * Stored beside `rmops.workspace` in localStorage and read the same way: the
   * default when the key is absent or unreadable is SHOWN, so nothing about a
   * fresh install or a private window changes.
   *
   * DESKTOP ONLY, and that is enforced in CSS rather than here. On a phone this
   * same `<aside>` is the bottom navigation bar (see mobile.css); hiding it
   * would leave a tab with no way to reach another screen, so the mobile media
   * query overrides the collapse and the toggle button is not drawn.
   */
  const [navHidden, setNavHidden] = useState<boolean>(
    () => localStorage.getItem('rmops.nav.hidden') === '1'
  )
  const toggleNav = (): void => {
    setNavHidden((hidden) => {
      const next = !hidden
      try {
        localStorage.setItem('rmops.nav.hidden', next ? '1' : '0')
      } catch {
        /* a browser with storage denied still gets the toggle, just not the memory */
      }
      return next
    })
  }

  const visible = useMemo(
    () =>
      MODULES.filter(
        (m) =>
          inWorkspace(m, workspace) &&
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

  // On a phone this same <nav> is a horizontally scrolling bottom bar (see
  // styles/mobile.css), and a module is often opened from somewhere OTHER than
  // the bar — a Home quick action, a cross-workspace link, the workspace switch
  // landing you on a different default. The newly active item is then off the
  // edge of a strip nobody has scrolled, so the app looks like it swallowed the
  // tap. Guarded on the width rather than left to be harmless, so the desktop
  // provably never runs it: there the nav is a full-height column with no
  // sideways scroll to perform.
  useEffect(() => {
    if (!isPhoneWidth(window.innerWidth)) return
    navRef.current
      ?.querySelector('.nav-item.active')
      ?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  }, [activeId, workspace])

  // Modules live in workspaces, and `visible` is filtered by the active one —
  // so setting activeId alone silently no-ops when the target is in the OTHER
  // workspace (the render chain falls through to Home). Cross-workspace links
  // switch the sidebar first, which is what "go to that screen" has to mean.
  const navigate = (id: string): void => {
    const target = MODULES.find((m) => m.id === id)
    // A module that lives in BOTH needs no switch — it is already in the
    // sidebar wherever you are standing, and moving the whole app to another
    // company to open your own payslip would be a worse answer than doing
    // nothing.
    if (target && !inWorkspace(target, workspace)) {
      const targetWorkspace: WorkspaceId = target.workspace === 'shipping' ? 'shipping' : 'ops'
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
      <div className={`shell${navHidden ? ' nav-hidden' : ''}`}>
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

          <nav className="nav" ref={navRef}>
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

          {/* In a browser there is nothing to check. The page IS the current
              version — it changed the moment the site was deployed — so the
              three "Check for updates" entry points become one honest label.
              What they used to do was compare the release feed against a
              version the server did not know its own name for, decide the tab
              was out of date, and offer a macOS installer a tab cannot run. */}
          <div className="sidebar-footer">
            {IS_WEB ? (
              <div className="sidebar-update" title="The web app is always the deployed version">
                <Icon name="Cloud" size={16} />
                <span>Web app</span>
                <span className="ver">v{appInfo?.version ?? '—'}</span>
              </div>
            ) : (
              <button
                className="sidebar-update"
                onClick={() => setShowUpdates(true)}
                title="Check for updates"
              >
                <Icon name="RefreshCw" size={16} />
                <span>Check for updates</span>
                <span className="ver">v{appInfo?.version ?? '0.0.0'}</span>
              </button>
            )}
          </div>
        </aside>

        <main className="main">
          <header className="topbar">
            {/* The toggle lives HERE and not in the sidebar, because a button
                inside the thing it hides can only ever be pressed once. */}
            <button
              className="nav-toggle"
              onClick={toggleNav}
              title={navHidden ? 'Show the menu' : 'Hide the menu'}
              aria-label={navHidden ? 'Show the menu' : 'Hide the menu'}
              aria-expanded={!navHidden}
            >
              <Icon name={navHidden ? 'PanelLeftOpen' : 'PanelLeftClose'} size={18} />
            </button>

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
              {!IS_WEB && (
                <button
                  className="icon-btn"
                  onClick={() => setShowUpdates(true)}
                  title="Check for updates"
                >
                  <Icon name="RefreshCw" size={18} />
                </button>
              )}

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
                            {/* Whoever has no address is identified by what they
                                actually signed in with. */}
                            <div className="um-h-email">{user.email || user.companyId}</div>
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
                      {!IS_WEB && (
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
                      )}
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
            ) : activeModule?.id === 'schedule' ? (
              <ScheduleModule />
            ) : activeModule?.id === 'inventory' ? (
              <InventoryModule />
            ) : activeModule?.id === 'performance' ? (
              <PerformanceModule />
            ) : activeModule?.id === 'finance' ? (
              <FinanceModule />
            ) : activeModule?.id === 'streaming' ? (
              <StreamingModule />
            ) : activeModule?.id === 'invoicing' ? (
              <InvoicingModule />
            ) : activeModule?.id === 'invoices' ? (
              <InvoicesModule />
            ) : activeModule?.id === 'contacts' ? (
              <ContactsModule />
            ) : activeModule?.id === 'account' ? (
              <AccountModule />
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
