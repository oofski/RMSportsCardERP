import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Employee, EmployeeHoursSummary, TimeEntry } from '@shared/types'
import { MODULES } from '@shared/modules'
import { ROLES } from '@shared/permissions'
import { useSession } from '../../lib/session'
import { useChrome } from '../../lib/chrome'
import { api } from '../../lib/api'
import { Icon } from '../../components/Icon'
import { Donut, AreaChart } from '../../components/charts'
import { CenterLoader } from '../../components/ui'
import { TimeClock } from '../../components/TimeClock'
import { ShowCard } from './ShowCard'
import { OwnerBoard, SendReminder } from './OwnerBoard'
import { formatHours } from '../../lib/format'

function greetingWord(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

/** Bucket completed time entries into per-day totals for the last N days. */
function hoursByDay(entries: TimeEntry[], days: number): { labels: string[]; minutes: number[] } {
  const labels: string[] = []
  const minutes: number[] = []
  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(now.getDate() - i)
    d.setHours(0, 0, 0, 0)
    const next = new Date(d)
    next.setDate(d.getDate() + 1)
    let total = 0
    for (const e of entries) {
      if (!e.clockOut) continue
      const t = new Date(e.clockIn).getTime()
      if (t >= d.getTime() && t < next.getTime()) {
        total += (new Date(e.clockOut).getTime() - new Date(e.clockIn).getTime()) / 60000
      }
    }
    labels.push(String(d.getDate()))
    minutes.push(Math.max(0, Math.round(total)))
  }
  return { labels, minutes }
}

export function HomeModule(): JSX.Element {
  const { user, can } = useSession()
  const { navigate } = useChrome()
  const [employees, setEmployees] = useState<Employee[]>([])
  const [summary, setSummary] = useState<EmployeeHoursSummary[]>([])
  const [entries, setEntries] = useState<TimeEntry[]>([])
  const [loading, setLoading] = useState(true)

  const canEmployees = can('admin.employees.view')
  const canHours = can('admin.hours.view')

  useEffect(() => {
    ;(async () => {
      const [emp, sum, ent] = await Promise.all([
        canEmployees ? api.employees.list() : Promise.resolve([]),
        canHours ? api.hours.summary() : Promise.resolve([]),
        canHours ? api.hours.list() : Promise.resolve([])
      ])
      setEmployees(emp)
      setSummary(sum)
      setEntries(ent)
      setLoading(false)
    })()
  }, [canEmployees, canHours])

  const stats = useMemo(() => {
    const total = employees.length
    const active = employees.filter((e) => e.status === 'active').length
    const invited = employees.filter((e) => e.status === 'invited').length
    const byRole = ROLES.map((r) => ({
      role: r,
      count: employees.filter((e) => e.role === r.id).length
    }))
    const totalMinutes = summary.reduce((a, s) => a + s.totalMinutes, 0)
    const avgPerActive = active > 0 ? Math.round(totalMinutes / active) : 0
    return { total, active, invited, byRole, totalMinutes, avgPerActive }
  }, [employees, summary])

  const chart = useMemo(() => hoursByDay(entries, 14), [entries])
  const hasHours = chart.minutes.some((m) => m > 0)

  const visibleModules = useMemo(
    () => MODULES.filter((m) => (m.status === 'active' ? (m.permission ? can(m.permission) : true) : true)),
    [can]
  )

  if (loading) return <CenterLoader />

  const ROLE_COLORS: Record<string, string> = {
    owner: '#c9a24b',
    operations: 'var(--brand-500)',
    staff: 'var(--text-3)'
  }

  return (
    <div className="content-narrow">
      <div className="greeting">
        <h2>
          {greetingWord()}, {user?.firstName}
        </h2>
      </div>

      <div style={{ marginBottom: 16 }}>
        <TimeClock />
      </div>

      {/* The night's show, before anything else on the page: whoever runs the
          floor opens here, and "is it loaded, and what day is it" is the first
          thing they need. Renders nothing for someone without the module. */}
      <div style={{ marginBottom: 16 }}>
        <ShowCard />
      </div>

      {/* Every side of the business, for whoever can see all of it. Renders
          nothing for somebody whose permissions cover none of its sections, so
          the floor's home page is unchanged. */}
      <OwnerBoard />

      {canEmployees && (
        <div className="stat-grid">
          <Stat icon="Users" value={String(stats.total)} label="Total employees" />
          <Stat icon="CheckCircle2" value={String(stats.active)} label="Active" />
          <Stat icon="Mail" value={String(stats.invited)} label="Pending invites" />
          {canHours && (
            <Stat icon="Clock" value={formatHours(stats.totalMinutes)} label="Hours logged" />
          )}
        </div>
      )}

      <div className="dash-grid">
        <div className="dash-col">
          {canEmployees ? (
            <div className="panel-card">
              <div className="panel-head">
                <h3>Team overview</h3>
                <span className="ph-sub">{stats.total} people</span>
              </div>
              <div className="donut-row">
                <Donut percent={stats.total ? (stats.active / stats.total) * 100 : 0} />
                <div style={{ flex: 1 }}>
                  <div className="donut-legend" style={{ marginBottom: 12 }}>
                    <div className="dl-big">
                      {stats.active}
                      <span style={{ fontSize: 15, color: 'var(--text-3)', fontWeight: 600 }}>
                        {' '}
                        / {stats.total}
                      </span>
                    </div>
                    <div className="dl-sub">active team members</div>
                  </div>
                  <div className="metric-list">
                    {stats.byRole.map((r) => (
                      <div className="metric-row" key={r.role.id}>
                        <span className="m-k">
                          <span className="m-dot" style={{ background: ROLE_COLORS[r.role.id] }} />
                          {r.role.label}
                        </span>
                        <span className="m-v">{r.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="panel-card">
              <div className="panel-head">
                <h3>Welcome to RM Operations</h3>
              </div>
              <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
                Your workspace for RM Cardz. Use the modules below to get to your work. As new
                modules ship, they'll appear here automatically.
              </p>
            </div>
          )}

          {canHours && (
            <div className="panel-card">
              <div className="panel-head">
                <div>
                  <h3>Hours logged</h3>
                  <span className="ph-sub">Last 14 days</span>
                </div>
                <div className="chart-legend">
                  <span className="cl">
                    <span className="sw" style={{ background: 'var(--chart-blue)' }} />
                    Hours
                  </span>
                </div>
              </div>
              {hasHours ? (
                <AreaChart
                  series={[{ points: chart.minutes.map((m) => m / 60), color: 'var(--chart-blue)', fill: true }]}
                  labels={chart.labels}
                  height={200}
                />
              ) : (
                <div className="chart-empty">
                  <Icon name="LineChart" size={26} />
                  <div>
                    <div style={{ fontWeight: 600, color: 'var(--text-2)' }}>No hours logged yet</div>
                    <div className="text-sm">Time entries will chart here as they're logged.</div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="dash-col">
          {canHours && (
            <div className="panel-card tint hilite">
              <div className="hl-label">Avg hours / active member</div>
              <div className="hl-val">{formatHours(stats.avgPerActive)}</div>
              <div className="text-sm muted">Across {stats.active} active team members this period.</div>
            </div>
          )}

          <div className="panel-card">
            <div className="panel-head">
              <h3>Quick actions</h3>
            </div>
            <div className="qa-list">
              {canEmployees && (
                <QuickAction
                  icon="UserPlus"
                  title="Manage employees"
                  desc="Add people, invite them, set roles"
                  onClick={() => navigate('admin')}
                />
              )}
              {canHours && (
                <QuickAction
                  icon="Clock"
                  title="Review hours"
                  desc="See logged time across the team"
                  onClick={() => navigate('admin')}
                />
              )}
              <QuickAction
                icon="RefreshCw"
                title="Check for updates"
                desc="Get the latest version"
                onClick={() => window.dispatchEvent(new CustomEvent('rmops:check-updates'))}
              />
            </div>
          </div>

          {/* Anybody can write one, so this sits on the ORDINARY home page
              rather than inside the owner's board — a box the floor cannot see
              is a box nobody writes into. */}
          <SendReminder />
        </div>
      </div>

      <div className="panel-card" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3>Modules</h3>
          <span className="ph-sub">{visibleModules.length}</span>
        </div>
        <ModulesCarousel modules={visibleModules} onOpen={navigate} />
      </div>
    </div>
  )
}

function ModulesCarousel({
  modules,
  onOpen
}: {
  modules: typeof MODULES
  onOpen: (id: string) => void
}): JSX.Element {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [atStart, setAtStart] = useState(true)
  const [atEnd, setAtEnd] = useState(false)

  const updateArrows = useCallback(() => {
    const el = trackRef.current
    if (!el) return
    setAtStart(el.scrollLeft <= 2)
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 2)
  }, [])

  useEffect(() => {
    updateArrows()
    const el = trackRef.current
    if (!el) return
    el.addEventListener('scroll', updateArrows, { passive: true })
    window.addEventListener('resize', updateArrows)
    return () => {
      el.removeEventListener('scroll', updateArrows)
      window.removeEventListener('resize', updateArrows)
    }
  }, [updateArrows])

  const scrollBy = (dir: 1 | -1): void => {
    trackRef.current?.scrollBy({ left: dir * 250, behavior: 'smooth' })
  }

  return (
    <div className="mc-wrap">
      <button className="mc-arrow left" disabled={atStart} onClick={() => scrollBy(-1)} aria-label="Previous">
        <Icon name="ArrowLeft" size={17} />
      </button>
      <div className="mc-track" ref={trackRef}>
        {modules.map((m) => (
          <button
            key={m.id}
            className={`module-tile ${m.status === 'active' ? 'live' : ''}`}
            onClick={() => onOpen(m.id)}
          >
            <div className="mt-ico">
              <Icon name={m.icon} size={19} />
            </div>
            <div className="mt-name">{m.name}</div>
            <div className="mt-desc">{m.description}</div>
            <div className="mt-tag">
              {m.status === 'active' ? (
                <span className="badge badge-active">Live</span>
              ) : (
                <span className="badge badge-soon">Soon</span>
              )}
            </div>
          </button>
        ))}
      </div>
      <button className="mc-arrow right" disabled={atEnd} onClick={() => scrollBy(1)} aria-label="Next">
        <Icon name="ChevronRight" size={17} />
      </button>
    </div>
  )
}

function Stat({ icon, value, label }: { icon: string; value: string; label: string }): JSX.Element {
  return (
    <div className="stat">
      <div className="stat-ico">
        <Icon name={icon} size={21} />
      </div>
      <div>
        <div className="stat-val">{value}</div>
        <div className="stat-label">{label}</div>
      </div>
    </div>
  )
}

function QuickAction({
  icon,
  title,
  desc,
  onClick
}: {
  icon: string
  title: string
  desc: string
  onClick: () => void
}): JSX.Element {
  return (
    <button className="qa-chip" onClick={onClick}>
      <span className="qa-ico">
        <Icon name={icon} size={17} />
      </span>
      <span style={{ flex: 1 }}>
        <span className="qa-t" style={{ display: 'block' }}>
          {title}
        </span>
        <span className="qa-d" style={{ display: 'block' }}>
          {desc}
        </span>
      </span>
      <span className="qa-arrow">
        <Icon name="ArrowUpRight" size={16} />
      </span>
    </button>
  )
}
