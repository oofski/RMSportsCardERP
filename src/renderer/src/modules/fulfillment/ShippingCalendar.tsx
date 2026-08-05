import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type {
  ShipCalendarDay,
  ShipCalendarDayDetail,
  ShipCalendarMonth,
  ShipCalendarSource
} from '@shared/shippingViews'
import { api } from '../../lib/api'
import { formatDateTime, formatMoney } from '../../lib/format'
import { Icon } from '../../components/Icon'
import { Button, EmptyState } from '../../components/ui'

/**
 * History calendar — a month of REAL activity, one cell per day.
 *
 * Everything here is derived by the main process from `ship_imports`,
 * `ship_snapshots` and the live dataset (src/main/db/shippingCalendar.ts).
 * There is no rollup table and no placeholder array: `api.shipping.calendar()`
 * returns one entry for every day of the month — including the empty ones — so
 * the grid lays out from a single read.
 *
 * Two things the UI must be honest about:
 *
 *  - **How solid a day's numbers are.** `day.source` is `live` (this day's
 *    dataset is still loaded, so the figures are current), `snapshot` (rebuilt
 *    from that day's capture), `import` (an import ran but nothing captured its
 *    progress — progress genuinely is unknown, so the cell says so instead of
 *    drawing an empty 0/0 bar) or `none`.
 *  - **How busy a day was.** `day.intensity` is 0..1 against the busiest day of
 *    the month; it drives the cell's wash and border weight, so a heavy day is
 *    legible at a glance and an empty one stays calm rather than looking broken.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const SOURCE_META: Record<ShipCalendarSource, { label: string; icon: string; hint: string }> = {
  live: {
    label: 'Live',
    icon: 'CircleDot',
    hint: 'This day holds the dataset loaded right now — every number is current.'
  },
  snapshot: {
    label: 'Snapshot',
    icon: 'Archive',
    hint: 'Rebuilt from the capture taken that day.'
  },
  import: {
    label: 'Import only',
    icon: 'FileUp',
    hint: 'An import ran, but nothing captured its progress — only volume and value are known.'
  },
  none: {
    label: 'Quiet',
    icon: 'Circle',
    hint: 'Nothing was imported or captured.'
  }
}

/** Parse a `YYYY-MM-DD` key as a LOCAL date — `new Date(key)` would read UTC
 *  and slide the day backwards for anyone west of Greenwich. */
function parseKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

function dayNumber(key: string): number {
  return Number(key.slice(8, 10))
}

function monthLabel(year: number, month: number): string {
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric'
  })
}

function longDate(key: string): string {
  const d = parseKey(key)
  if (!d) return key
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  })
}

function pct(part: number, whole: number): number {
  if (!whole || whole <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)))
}

type Cell =
  | { kind: 'pad'; key: string; label: number }
  | { kind: 'day'; key: string; day: ShipCalendarDay }

export interface ShippingCalendarProps {
  /** Bumped by the History tab after an import/snapshot mutation so the month
   *  and any open day re-derive without the operator refreshing anything. */
  refreshToken: number
  /** Expand that snapshot in the list further down the page. */
  onOpenSnapshot: (id: string) => void
  /** Write that snapshot's orders CSV (the History tab owns the file dialog). */
  onExportSnapshot: (id: string) => void
  /** The snapshot whose export is running, so the panel can show its spinner. */
  exportingSnapshotId: string | null
  /** True while ANY export is running. Exports share one file dialog and one
   *  busy key upstream, so a second must not be startable from here. */
  exportBusy: boolean
}

export function ShippingCalendar({
  refreshToken,
  onOpenSnapshot,
  onExportSnapshot,
  exportingSnapshotId,
  exportBusy
}: ShippingCalendarProps): JSX.Element {
  // The month on screen. Starts on the current one; every read is keyed to it.
  const [cursor, setCursor] = useState(() => {
    const d = new Date()
    return { year: d.getFullYear(), month: d.getMonth() + 1 }
  })

  const [month, setMonth] = useState<ShipCalendarMonth | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [denied, setDenied] = useState(false)

  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<ShipCalendarDayDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  // A rejected read must never leave the grid on a permanent spinner: catch,
  // surface it with a retry, and always clear loading.
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const next = await api.shipping.calendar(cursor.year, cursor.month)
        if (!active) return
        setMonth(next)
        setDenied(next === null)
      } catch (err) {
        if (!active) return
        setError(err instanceof Error ? err.message : 'Could not load the calendar.')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [cursor.year, cursor.month, refreshToken, attempt])

  // The day panel is a second, deliberately lazy read — the grid stays cheap no
  // matter how many months are flicked through.
  useEffect(() => {
    if (!selected) {
      setDetail(null)
      setDetailError(null)
      setDetailLoading(false)
      return
    }
    let active = true
    setDetailLoading(true)
    setDetailError(null)
    ;(async () => {
      try {
        const next = await api.shipping.calendarDay(selected)
        if (!active) return
        setDetail(next)
        if (!next) setDetailError('That day could not be read.')
      } catch (err) {
        if (!active) return
        setDetail(null)
        setDetailError(err instanceof Error ? err.message : 'Could not load that day.')
      } finally {
        if (active) setDetailLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [selected, refreshToken])

  const go = useCallback((delta: number) => {
    setSelected(null)
    setCursor((c) => {
      const d = new Date(c.year, c.month - 1 + delta, 1)
      return { year: d.getFullYear(), month: d.getMonth() + 1 }
    })
  }, [])

  const goToday = useCallback(() => {
    setSelected(null)
    const today = new Date()
    setCursor({ year: today.getFullYear(), month: today.getMonth() + 1 })
  }, [])

  const cells = useMemo<Cell[]>(() => {
    if (!month) return []
    const out: Cell[] = []
    // Leading + trailing days belong to the neighbouring months. They are drawn
    // muted and inert: the read only covers this month, and inventing figures
    // for days it did not return would be a lie.
    const lead = month.startWeekday
    for (let i = lead; i > 0; i--) {
      const d = new Date(month.year, month.month - 1, 1 - i)
      out.push({ kind: 'pad', key: `lead-${i}`, label: d.getDate() })
    }
    for (const day of month.days) out.push({ kind: 'day', key: day.date, day })
    const trail = (7 - (out.length % 7)) % 7
    for (let i = 1; i <= trail; i++) {
      const d = new Date(month.year, month.month, i)
      out.push({ kind: 'pad', key: `trail-${i}`, label: d.getDate() })
    }
    return out
  }, [month])

  // Keyed to the CURSOR, not the loaded payload: while a month is in flight the
  // button must already reflect where the user is going.
  const isThisMonth = useMemo(() => {
    const now = new Date()
    return cursor.year === now.getFullYear() && cursor.month === now.getMonth() + 1
  }, [cursor.year, cursor.month])

  // `month` still holds the PREVIOUS month until the new read lands. Rendering
  // it under the new month's header would label July's cells "August", so the
  // grid falls back to the skeleton until the payload catches up.
  const stale = !month || month.year !== cursor.year || month.month !== cursor.month

  // The panel renders below a grid that already fills the viewport, so without
  // this a click on an early day opens a detail panel ~600px off-screen and
  // reads as "nothing happened". 'nearest' so a bottom-row click does not jump.
  const panelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!selected) return
    const id = requestAnimationFrame(() => {
      panelRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
    return () => cancelAnimationFrame(id)
  }, [selected, detailLoading])

  return (
    <section className="hist-section">
      <div className="hist-head">
        <span className="hist-title">
          <Icon name="CalendarRange" size={16} /> Activity calendar
        </span>
        <span className="hist-sub">
          Every day that carried work. Shading is how busy it was against the month&rsquo;s
          heaviest.
        </span>
        <div className="hcal-nav">
          <button className="hcal-nav-btn" onClick={() => go(-1)} aria-label="Previous month">
            <Icon name="ChevronLeft" size={16} />
          </button>
          <span className="hcal-month">
            {monthLabel(cursor.year, cursor.month)}
            {loading && <Icon name="Loader2" size={13} className="spin-ico" />}
          </span>
          <button className="hcal-nav-btn" onClick={() => go(1)} aria-label="Next month">
            <Icon name="ChevronRight" size={16} />
          </button>
          <button className="hcal-today-btn" onClick={goToday} disabled={isThisMonth}>
            Today
          </button>
        </div>
      </div>

      {error ? (
        <div className="hcal-error">
          <Icon name="AlertTriangle" size={15} />
          <span>{error}</span>
          <Button size="sm" icon="RefreshCw" onClick={() => setAttempt((a) => a + 1)}>
            Try again
          </Button>
        </div>
      ) : denied ? (
        <EmptyState
          icon="ShieldCheck"
          title="Calendar unavailable"
          message="Your account cannot read the fulfillment workspace."
        />
      ) : stale || !month ? (
        <div className="hcal-grid loading" aria-hidden="true">
          {Array.from({ length: 35 }, (_, i) => (
            <span className="hcal-skel" key={i} />
          ))}
        </div>
      ) : (
        <>
          <div className="hcal-sum">
            <SumItem icon="FileUp" value={String(month.totals.imports)} label="imports" />
            <SumItem icon="Archive" value={String(month.totals.snapshots)} label="snapshots" />
            <SumItem icon="CalendarDays" value={String(month.totals.activeDays)} label="busy days" />
            <SumItem icon="SquareStack" value={String(month.totals.cards)} label="cards in" />
            <SumItem icon="Package" value={String(month.totals.packages)} label="packages in" />
            <SumItem
              icon="DollarSign"
              value={formatMoney(month.totals.value)}
              label="imported value"
              strong
            />
          </div>

          <div className={`hcal ${loading ? 'is-loading' : ''}`}>
            <div className="hcal-week">
              {WEEKDAYS.map((w) => (
                <span className="hcal-wd" key={w}>
                  {w}
                </span>
              ))}
            </div>
            <div className="hcal-grid">
              {cells.map((cell) =>
                cell.kind === 'pad' ? (
                  <span className="hcal-cell pad" key={cell.key} aria-hidden="true">
                    <span className="hcal-num">{cell.label}</span>
                  </span>
                ) : (
                  <DayCell
                    key={cell.key}
                    day={cell.day}
                    isToday={cell.day.date === month.today}
                    isBusiest={cell.day.date === month.busiestDate && cell.day.hasActivity}
                    selected={selected === cell.day.date}
                    onSelect={() =>
                      setSelected((s) => (s === cell.day.date ? null : cell.day.date))
                    }
                  />
                )
              )}
            </div>
          </div>

          {month.totals.activeDays === 0 && !loading && (
            <div className="hist-empty">
              <Icon name="CalendarDays" size={15} />
              Nothing was imported or captured in {monthLabel(month.year, month.month)}.
            </div>
          )}

          {selected && (
            <div ref={panelRef}>
              <DayPanel
                date={selected}
                detail={detail}
                loading={detailLoading}
                error={detailError}
                exportingSnapshotId={exportingSnapshotId}
                exportBusy={exportBusy}
                onClose={() => setSelected(null)}
                onOpenSnapshot={onOpenSnapshot}
                onExportSnapshot={onExportSnapshot}
              />
            </div>
          )}
        </>
      )}
    </section>
  )
}

function SumItem({
  icon,
  value,
  label,
  strong
}: {
  icon: string
  value: string
  label: string
  strong?: boolean
}): JSX.Element {
  return (
    <span className={`hcal-sum-item ${strong ? 'strong' : ''}`}>
      <Icon name={icon} size={13} />
      <b className="mono">{value}</b>
      <em>{label}</em>
    </span>
  )
}

// ---------------------------------------------------------------------------
// One day
// ---------------------------------------------------------------------------

function DayCell({
  day,
  isToday,
  isBusiest,
  selected,
  onSelect
}: {
  day: ShipCalendarDay
  isToday: boolean
  isBusiest: boolean
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  const meta = SOURCE_META[day.source]
  const primary = day.imports[0] ?? null
  const extra = Math.max(0, day.imports.length - 1)
  const picked = pct(day.cardsPicked, day.cards)
  // `import` means nobody captured this dataset's progress. Drawing a 0% bar
  // would read as "nothing was picked" — which is not what is known.
  const progressKnown = day.source === 'live' || day.source === 'snapshot'

  const label = day.hasActivity
    ? `${longDate(day.date)} — ${day.imports.length} import${day.imports.length === 1 ? '' : 's'}, ${
        day.snapshots.length
      } snapshot${day.snapshots.length === 1 ? '' : 's'}, ${formatMoney(day.value)}`
    : `${longDate(day.date)} — nothing happened`

  return (
    <button
      type="button"
      className={[
        'hcal-cell',
        day.hasActivity ? 'live-day' : 'quiet',
        selected ? 'selected' : '',
        isToday ? 'today' : '',
        day.isActive ? 'active-set' : ''
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ '--hcal-w': day.intensity } as CSSProperties}
      aria-pressed={selected}
      aria-current={isToday ? 'date' : undefined}
      aria-label={label}
      onClick={onSelect}
    >
      <span className="hcal-wash" aria-hidden="true" />
      <span className="hcal-top">
        <span className="hcal-num">{dayNumber(day.date)}</span>
        {isToday && <span className="hcal-today-dot">Today</span>}
        {isBusiest && (
          <span className="hcal-flame" title="The busiest day this month">
            <Icon name="Flame" size={12} />
          </span>
        )}
        {day.hasActivity && (
          <span className={`hcal-src ${day.source}`} title={meta.hint}>
            <Icon name={meta.icon} size={11} />
          </span>
        )}
      </span>

      {day.hasActivity ? (
        <span className="hcal-body">
          {primary ? (
            <span className="hcal-imp" title={`${primary.name} · ${primary.filename || 'no file'}`}>
              <Icon name="FileUp" size={11} />
              <b>{primary.name}</b>
              {extra > 0 && <em>+{extra}</em>}
            </span>
          ) : (
            <span className="hcal-imp snap" title="Snapshots captured this day">
              <Icon name="Archive" size={11} />
              <b>
                {day.snapshots.length} capture{day.snapshots.length === 1 ? '' : 's'}
              </b>
            </span>
          )}
          {primary?.filename && (
            <span className="hcal-file mono" title={primary.filename}>
              {primary.filename}
            </span>
          )}

          <span className="hcal-money mono">{formatMoney(day.value, { compact: true })}</span>

          {progressKnown ? (
            <>
              <span className="hcal-bar" title={`${day.cardsPicked} of ${day.cards} cards picked`}>
                <i style={{ width: `${picked}%` }} />
              </span>
              <span className="hcal-stats">
                <em title={`${day.cardsPicked} of ${day.cards} cards picked`}>
                  <Icon name="ListChecks" size={10} />
                  {day.cardsPicked}/{day.cards}
                </em>
                <em title={`${day.packagesWithTracking} of ${day.packages} packages have tracking`}>
                  <Icon name="Truck" size={10} />
                  {day.packagesWithTracking}/{day.packages}
                </em>
                <em title={`${day.packagesDelivered} delivered, ${day.packagesSent} sent`}>
                  <Icon name="PackageCheck" size={10} />
                  {day.packagesDelivered}
                </em>
              </span>
            </>
          ) : (
            <span className="hcal-unknown">
              <Icon name="Circle" size={10} />
              {day.cards} cards · {day.packages} pkgs
            </span>
          )}
        </span>
      ) : (
        <span className="hcal-quiet-mark" aria-hidden="true" />
      )}
    </button>
  )
}

// ---------------------------------------------------------------------------
// The day panel
// ---------------------------------------------------------------------------

function DayPanel({
  date,
  detail,
  loading,
  error,
  exportingSnapshotId,
  exportBusy,
  onClose,
  onOpenSnapshot,
  onExportSnapshot
}: {
  date: string
  detail: ShipCalendarDayDetail | null
  loading: boolean
  error: string | null
  exportingSnapshotId: string | null
  exportBusy: boolean
  onClose: () => void
  onOpenSnapshot: (id: string) => void
  onExportSnapshot: (id: string) => void
}): JSX.Element {
  const meta = detail ? SOURCE_META[detail.source] : SOURCE_META.none
  const progressKnown = detail?.source === 'live' || detail?.source === 'snapshot'

  return (
    <div className="hcal-panel">
      <div className="hcal-panel-head">
        <span className="hcal-panel-date">
          <Icon name="CalendarDays" size={15} />
          {longDate(date)}
        </span>
        {detail?.hasActivity && (
          <span className={`hcal-src-chip ${detail.source}`} title={meta.hint}>
            <Icon name={meta.icon} size={11} /> {meta.label}
          </span>
        )}
        {detail?.isActive && (
          <span className="ship-chip ok mini">
            <Icon name="Check" size={11} /> Active dataset
          </span>
        )}
        {detail?.event?.name && <span className="hcal-panel-event">{detail.event.name}</span>}
        <button className="hcal-panel-close" onClick={onClose} aria-label="Close this day">
          <Icon name="X" size={16} />
        </button>
      </div>

      {loading ? (
        <div className="hcal-panel-loading">
          <Icon name="Loader2" size={15} className="spin-ico" /> Reading that day&hellip;
        </div>
      ) : error ? (
        <div className="hcal-error">
          <Icon name="AlertTriangle" size={15} />
          <span>{error}</span>
        </div>
      ) : !detail || !detail.hasActivity ? (
        <div className="hist-empty">
          <Icon name="Moon" size={15} />
          Nothing was imported or captured on this day.
        </div>
      ) : (
        <>
          <div className="hcal-panel-grid">
            <PanelStat icon="DollarSign" label="Value" value={formatMoney(detail.value)} strong />
            <PanelStat
              icon="ListChecks"
              label="Cards picked"
              value={progressKnown ? `${detail.cardsPicked}/${detail.cards}` : `— /${detail.cards}`}
            />
            <PanelStat icon="Package" label="Packages" value={String(detail.packages)} />
            <PanelStat
              icon="Truck"
              label="With tracking"
              value={progressKnown ? String(detail.packagesWithTracking) : '—'}
            />
            <PanelStat
              icon="Send"
              label="Sent"
              value={progressKnown ? String(detail.packagesSent) : '—'}
            />
            <PanelStat
              icon="PackageCheck"
              label="Delivered"
              value={progressKnown ? String(detail.packagesDelivered) : '—'}
            />
          </div>

          {!progressKnown && (
            <span className="hcal-note">
              <Icon name="Info" size={13} /> Nothing captured this day&rsquo;s progress, so only
              what came in is known.
            </span>
          )}

          {detail.imports.length > 0 && (
            <div className="hcal-panel-block">
              <span className="hcal-panel-title">
                <Icon name="FileUp" size={13} /> Imported that day
              </span>
              {detail.imports.map((r) => (
                <div className="hcal-imp-row" key={r.id}>
                  <span className="hcal-imp-name">
                    <Icon name="FileText" size={13} />
                    {r.name}
                    {r.id === detail.importId && (
                      <span className="ship-chip info mini">
                        <Icon name="CircleDot" size={11} /> These figures
                      </span>
                    )}
                  </span>
                  <span className="hcal-imp-file mono" title={r.filename}>
                    {r.filename || '—'}
                  </span>
                  <span className="hcal-imp-counts">
                    <em>{r.counts.customers} customers</em>
                    <em>{r.counts.breaks} breaks</em>
                    <em>{r.counts.teamSlots} cards</em>
                    <em>{r.counts.shipments} packages</em>
                  </span>
                  <span className="hcal-imp-when">{formatDateTime(r.createdAt)}</span>
                  <span className="hcal-imp-value mono">{formatMoney(r.counts.cardValue)}</span>
                </div>
              ))}
            </div>
          )}

          {detail.snapshots.length > 0 && (
            <div className="hcal-panel-block">
              <span className="hcal-panel-title">
                <Icon name="Archive" size={13} /> Captured that day
              </span>
              {detail.snapshots.map((s) => (
                <div className="hcal-snap-row" key={s.id}>
                  <span className="hcal-imp-name">
                    <Icon name="Archive" size={13} />
                    {s.name}
                    {s.id === detail.snapshotId && (
                      <span className="ship-chip info mini">
                        <Icon name="CircleDot" size={11} /> These figures
                      </span>
                    )}
                  </span>
                  <span className="hcal-imp-when">{formatDateTime(s.createdAt)}</span>
                  <div className="hcal-snap-acts">
                    <Button size="sm" icon="ChevronRight" onClick={() => onOpenSnapshot(s.id)}>
                      Open snapshot
                    </Button>
                    <Button
                      size="sm"
                      icon="FileDown"
                      loading={exportingSnapshotId === s.id}
                      disabled={exportBusy}
                      onClick={() => onExportSnapshot(s.id)}
                    >
                      CSV
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {detail.breaks.length > 0 && (
            <div className="hcal-panel-block">
              <span className="hcal-panel-title">
                <Icon name="Layers" size={13} /> Breaks in that dataset
                <span className="hist-count mono">{detail.breaks.length}</span>
              </span>
              <div className="hcal-breaks">
                {detail.breaks.map((b) => (
                  <div className="hcal-break" key={b.breakId}>
                    <span className="hcal-break-no mono">
                      {b.breakNumber === null ? 'Giveaways' : `#${b.breakNumber}`}
                    </span>
                    <span className="hcal-break-bar" title={`${b.picked} of ${b.cards} picked`}>
                      <i style={{ width: `${pct(b.picked, b.cards)}%` }} />
                    </span>
                    <span className="hcal-break-nums mono">
                      {b.picked}/{b.cards}
                    </span>
                    <span className="hcal-break-cust">{b.customers} cust.</span>
                    <span className="hcal-break-value mono">{formatMoney(b.value)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function PanelStat({
  icon,
  label,
  value,
  strong
}: {
  icon: string
  label: string
  value: string
  strong?: boolean
}): JSX.Element {
  return (
    <div className={`hcal-panel-stat ${strong ? 'strong' : ''}`}>
      <Icon name={icon} size={14} />
      <b>{value}</b>
      <em>{label}</em>
    </div>
  )
}
