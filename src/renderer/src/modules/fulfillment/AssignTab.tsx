import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ShipBreakStatus } from '@shared/shippingTypes'
import type {
  ShipAssignmentBoard,
  ShipAssignmentEmployee,
  ShipBreakAssignee,
  ShipBreakAssignmentUpdate,
  ShipBreakSummary
} from '@shared/shippingViews'
import { api } from '../../lib/api'
import { BreakChip } from './BreakChip'
import { useToast } from '../../components/Toast'
import { Avatar, Button, CenterLoader, EmptyState, Select } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { formatDate, formatDateTime, formatMoney } from '../../lib/format'

/**
 * Admin > Break assignments — "who is sorting break #12".
 *
 * This is the framework, deliberately: assign, unassign, see. No auto-assign,
 * no workload balancing, no notifications.
 *
 * The whole screen is ONE read — `assignmentBoard()` hands back the current
 * dataset's breaks (each already carrying its assignees) plus the pickable
 * roster, and `canManage` so the controls hide without a second permission
 * check. Every mutation returns the re-derived break AND the board totals, so
 * state is reconciled in place rather than refetched.
 *
 * Assignments are operator state, not dataset rows: a re-import keeps them
 * (break ids are `break_<n>` and stable), so "Maya is sorting break 12"
 * survives re-uploading the same show.
 */

const STATUS_LABELS: Record<ShipBreakStatus, string> = {
  pending: 'Pending',
  picking: 'Picking',
  packed: 'Packed',
  shipped: 'Shipped'
}

const STATUS_ICONS: Record<ShipBreakStatus, string> = {
  pending: 'CircleDot',
  picking: 'ListChecks',
  packed: 'PackageCheck',
  shipped: 'Truck'
}

/**
 * What to print on a chip. A resolved assignee carries a real name; an orphaned
 * one carries the raw employee id, which is noise on screen — so it reads
 * "Removed employee" and the id moves into the hover title, where it is still
 * available to whoever has to clean the row up.
 */
function assigneeLabel(a: { name: string; found: boolean }): string {
  return a.found ? a.name : 'Removed employee'
}

/**
 * A face for an assignee. An orphaned row has no name to take initials from, so
 * the backend falls back to the first characters of the uuid — rendered on the
 * brand gradient that reads as a person called "7F" sitting beside the words
 * "Removed employee". A neutral marker is the honest version.
 */
function AssigneeFace({
  found,
  initials,
  avatarUrl
}: {
  found: boolean
  initials: string
  avatarUrl: string | null
}): JSX.Element {
  if (!found) {
    return (
      <span className="ba-gone-face" aria-hidden="true">
        <Icon name="AlertTriangle" size={11} />
      </span>
    )
  }
  return <Avatar text={initials} src={avatarUrl} small />
}

/** One person on the floor, folded up from the breaks they appear on. */
interface RosterRow {
  employeeId: string
  name: string
  initials: string
  avatarUrl: string | null
  found: boolean
  breaks: ShipBreakSummary[]
}

export function AssignTab(): JSX.Element {
  const toast = useToast()

  const [board, setBoard] = useState<ShipAssignmentBoard | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [onlyUnassigned, setOnlyUnassigned] = useState(false)
  /** The break currently mid-write — its card locks, the rest stay usable. */
  const [busyBreakId, setBusyBreakId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setBoard(await api.shipping.assignmentBoard())
  }, [])

  useEffect(() => {
    let active = true
    ;(async () => {
      // A rejected read must never leave the tab on a permanent spinner: catch
      // it, surface it, and always clear loading.
      try {
        await load()
      } catch (err) {
        if (active) {
          setLoadError(err instanceof Error ? err.message : 'Could not load break assignments.')
        }
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [load])

  const retry = useCallback(() => {
    setLoadError(null)
    setLoading(true)
    void load()
      .catch((err) =>
        setLoadError(err instanceof Error ? err.message : 'Could not load break assignments.')
      )
      .finally(() => setLoading(false))
  }, [load])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not refresh break assignments.')
    } finally {
      setRefreshing(false)
    }
  }, [load, toast])

  /**
   * Fold a mutation's payload back into the board. The handler already
   * re-derived the break and the whole-board totals, so nothing is recomputed
   * here and no refetch is needed.
   */
  const applyUpdate = useCallback((update: ShipBreakAssignmentUpdate) => {
    setBoard((prev) => {
      if (!prev) return prev
      const breaks = update.break
        ? prev.breaks.map((b) => (b.id === update.breakId ? (update.break as ShipBreakSummary) : b))
        : // `break: null` means the break vanished mid-flight — drop the stale card
          // rather than leaving a row that no longer exists.
          prev.breaks.filter((b) => b.id !== update.breakId)
      return {
        ...prev,
        breaks,
        totalAssignments: update.totalAssignments,
        unassignedBreaks: update.unassignedBreaks
      }
    })
  }, [])

  const assign = useCallback(
    async (breakId: string, employeeId: string, employeeName: string, breakLabel: string) => {
      setBusyBreakId(breakId)
      try {
        const res = await api.shipping.assignBreak(breakId, employeeId)
        if (!res.ok || !res.data) {
          toast.error(res.error ?? 'Could not assign that employee.')
          return
        }
        applyUpdate(res.data)
        toast.success(`${employeeName} is sorting break #${breakLabel}.`)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not assign that employee.')
      } finally {
        setBusyBreakId(null)
      }
    },
    [applyUpdate, toast]
  )

  const unassign = useCallback(
    async (assignment: ShipBreakAssignee) => {
      setBusyBreakId(assignment.breakId)
      try {
        const res = await api.shipping.unassignBreak(assignment.id)
        if (!res.ok || !res.data) {
          toast.error(res.error ?? 'Could not remove that assignment.')
          return
        }
        applyUpdate(res.data)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not remove that assignment.')
      } finally {
        setBusyBreakId(null)
      }
    },
    [applyUpdate, toast]
  )

  const breaks = board?.breaks ?? []

  /** Who is on the floor, and which breaks they hold. */
  const roster = useMemo<RosterRow[]>(() => {
    const rows = new Map<string, RosterRow>()
    for (const br of breaks) {
      for (const a of br.assignees) {
        const row = rows.get(a.employeeId)
        if (row) row.breaks.push(br)
        else
          rows.set(a.employeeId, {
            employeeId: a.employeeId,
            name: a.name,
            initials: a.initials,
            avatarUrl: a.avatarUrl,
            found: a.found,
            breaks: [br]
          })
      }
    }
    return [...rows.values()].sort(
      (a, b) => b.breaks.length - a.breaks.length || a.name.localeCompare(b.name)
    )
  }, [breaks])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    // "break 12", "break #12", "#12" and "12" all have to find break #12 — the
    // placeholder invites the phrasing, so drop the '#' and the spaces from
    // both sides rather than matching one exact spelling.
    const loose = q.replace(/[#\s]+/g, '')
    return breaks.filter((b) => {
      if (onlyUnassigned && b.assignees.length > 0) return false
      if (!q) return true
      return (
        (loose !== '' &&
          b.breakLabel !== null &&
          `break${b.breakLabel}`.toLowerCase().includes(loose)) ||
        b.assignees.some((a) => a.name.toLowerCase().includes(q))
      )
    })
  }, [breaks, query, onlyUnassigned])

  if (loading) return <CenterLoader />

  if (loadError) {
    return (
      <EmptyState
        icon="AlertTriangle"
        title="Could not load break assignments"
        message={loadError}
        action={
          <Button variant="primary" icon="RefreshCw" onClick={retry}>
            Try again
          </Button>
        }
      />
    )
  }

  // `null` board = the caller cannot open the fulfillment module at all.
  if (!board) {
    return (
      <EmptyState
        icon="ShieldCheck"
        title="Shipping workspace unavailable"
        message="Break assignments live in Shipping. Ask an owner for the Shipping permission."
      />
    )
  }

  // Assignments hang off breaks, so with no dataset loaded there is nothing to
  // assign anyone to. Point at the import rather than showing an empty grid.
  //
  // The import is the Import segment of this same screen, one click away — this
  // used to send people to the Shipping workspace, which was right when Setup
  // lived there and is a dead end now that it does not. A bench has no import.
  if (breaks.length === 0) {
    return (
      <EmptyState
        icon="Layers"
        title="No breaks to assign"
        message="Import tonight's packing-slip PDF on the Import tab and every break shows up here."
      />
    )
  }

  const assignedBreaks = breaks.length - board.unassignedBreaks

  return (
    <>
      <div className="section-head">
        <div>
          <h2>Break assignments</h2>
          <p className="section-sub">
            {board.event.name}
            {board.event.date ? ` · ${formatDate(board.event.date)}` : ''}
          </p>
        </div>
        <Button icon="RefreshCw" loading={refreshing} onClick={refresh}>
          Refresh
        </Button>
      </div>

      <div className="stat-grid">
        <Stat icon="Layers" value={breaks.length} label="Breaks in the dataset" />
        <Stat icon="UserCheck" value={assignedBreaks} label="Breaks with someone on them" />
        <Stat icon="UserMinus" value={board.unassignedBreaks} label="Breaks nobody has" />
        <Stat icon="Users" value={roster.length} label="People on the floor" />
      </div>

      {roster.length > 0 && (
        <div className="ba-roster">
          <div className="ba-roster-head">
            <span className="ba-roster-title">
              <Icon name="Users" size={15} /> On the floor
            </span>
          </div>
          <div className="ba-roster-list">
            {roster.map((r) => (
              <div
                key={r.employeeId}
                className={`ba-person ${r.found ? '' : 'gone'}`}
                title={
                  r.found ? undefined : `This employee record has been removed (${r.employeeId}).`
                }
              >
                <AssigneeFace found={r.found} initials={r.initials} avatarUrl={r.avatarUrl} />
                <div className="ba-person-main">
                  <span className="ba-person-name">{assigneeLabel(r)}</span>
                  <span className="ba-person-breaks">
                    {r.breaks
                      .map((b) => `#${b.breakLabel}`)
                      .join(' · ')}
                  </span>
                </div>
                <span className="ba-person-count mono">{r.breaks.length}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="ba-toolbar">
        <div className="topsearch ba-search">
          <Icon name="Search" size={16} />
          <input
            placeholder="Find a break or a person…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="ts-clear" title="Clear" onClick={() => setQuery('')}>
              <Icon name="X" size={14} />
            </button>
          )}
        </div>
        <button
          className={`ba-filter ${onlyUnassigned ? 'active' : ''}`}
          onClick={() => setOnlyUnassigned((v) => !v)}
        >
          <Icon name="UserMinus" size={14} />
          Unassigned only <span className="mono">{board.unassignedBreaks}</span>
        </button>
        <span className="spacer" />
        <span className="ba-total">
          <b className="mono">{board.totalAssignments}</b> assignment
          {board.totalAssignments === 1 ? '' : 's'} across{' '}
          <b className="mono">{breaks.length}</b> breaks
        </span>
      </div>

      {!board.canManage && (
        <div className="ba-readonly">
          <Icon name="Info" size={14} />
          You can see who is on each break, but changing an assignment needs the{' '}
          <b>Manage shipping</b> permission.
        </div>
      )}

      {visible.length === 0 ? (
        <EmptyState
          icon="Search"
          title="No breaks match"
          message={
            onlyUnassigned && board.unassignedBreaks === 0
              ? 'Every break has someone on it.'
              : 'Nothing matches the current search and filter.'
          }
          action={
            <Button
              icon="X"
              onClick={() => {
                setQuery('')
                setOnlyUnassigned(false)
              }}
            >
              Clear filters
            </Button>
          }
        />
      ) : (
        <div className="ba-grid">
          {visible.map((b) => (
            <BreakAssignCard
              key={b.id}
              summary={b}
              employees={board.employees}
              canManage={board.canManage}
              busy={busyBreakId === b.id}
              onAssign={assign}
              onUnassign={unassign}
            />
          ))}
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// One break, and who is sorting it
// ---------------------------------------------------------------------------

function BreakAssignCard({
  summary,
  employees,
  canManage,
  busy,
  onAssign,
  onUnassign
}: {
  summary: ShipBreakSummary
  employees: ShipAssignmentEmployee[]
  canManage: boolean
  busy: boolean
  onAssign: (
    breakId: string,
    employeeId: string,
    employeeName: string,
    breakLabel: string
  ) => void | Promise<void>
  onUnassign: (assignment: ShipBreakAssignee) => void | Promise<void>
}): JSX.Element {
  const assigned = new Set(summary.assignees.map((a) => a.employeeId))
  const available = employees.filter((e) => !assigned.has(e.id))
  const pct =
    summary.totalTeams > 0 ? Math.round((summary.checkedTeams / summary.totalTeams) * 100) : 0

  return (
    <div className={`ba-card ${busy ? 'busy' : ''}`} data-bstatus={summary.status}>
      <div className="ba-card-head">
        <span className="ba-num">
          <BreakChip label={summary.breakLabel} size="sm" />
        </span>
        <span className={`chk-status ${summary.status}`}>
          <Icon name={STATUS_ICONS[summary.status]} size={12} />
          {STATUS_LABELS[summary.status]}
        </span>
        <span
          className={`ba-headcount ${summary.assignees.length === 0 ? 'none' : ''}`}
          title={`${summary.assignees.length} assigned`}
        >
          <Icon name="Users" size={12} />
          <span className="mono">{summary.assignees.length}</span>
        </span>
      </div>

      <div className="ba-meta">
        <span title="Cards picked">
          <Icon name="ListChecks" size={12} /> {summary.checkedTeams}/{summary.totalTeams}
        </span>
        <span title="Customers in this break">
          <Icon name="Users" size={12} /> {summary.customerCount}
        </span>
        <span className="ba-value mono">{formatMoney(summary.value)}</span>
      </div>

      <div className="ba-prog">
        <span className="ba-prog-fill" style={{ width: `${pct}%` }} />
      </div>

      {summary.assignees.length === 0 ? (
        <div className="ba-nobody">
          <Icon name="UserPlus" size={14} />
          Nobody assigned
        </div>
      ) : (
        <div className="ba-chips">
          {summary.assignees.map((a) => (
            <span
              key={a.id}
              className={`ba-chip ${a.found ? '' : 'gone'}`}
              title={
                a.found
                  ? `Assigned ${formatDateTime(a.assignedAt)}${a.note ? ` · ${a.note}` : ''}`
                  : `This employee record has been removed (${a.employeeId}) — the assignment is kept so it can be cleared.`
              }
            >
              {/* The name stays at --text, at full contrast rather than dimmed;
                  the face is what says "this employee record is gone". */}
              <AssigneeFace found={a.found} initials={a.initials} avatarUrl={a.avatarUrl} />
              <span className="ba-chip-name">{assigneeLabel(a)}</span>
              {canManage && (
                <button
                  className="ba-chip-x"
                  disabled={busy}
                  aria-label={`Unassign ${assigneeLabel(a)} from break #${summary.breakLabel}`}
                  title={`Unassign ${assigneeLabel(a)}`}
                  onClick={() => void onUnassign(a)}
                >
                  <Icon name="X" size={12} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {canManage && (
        <div className="ba-assign">
          <Select
            className="ba-picker"
            // A one-shot picker: it never holds a value, it fires an assign and
            // snaps back to the placeholder.
            value=""
            disabled={busy || available.length === 0}
            aria-label={`Assign someone to break #${summary.breakLabel}`}
            onChange={(e) => {
              const id = e.target.value
              if (!id) return
              const person = available.find((p) => p.id === id)
              if (!person) return
              void onAssign(summary.id, person.id, person.name, summary.breakLabel)
            }}
          >
            <option value="">
              {employees.length === 0
                ? 'No employees to assign'
                : available.length === 0
                  ? 'Everyone is already on this break'
                  : 'Assign someone…'}
            </option>
            {available.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {e.title ? ` · ${e.title}` : ''}
              </option>
            ))}
          </Select>
          {busy && <span className="spinner dark ba-spin" />}
        </div>
      )}
    </div>
  )
}

function Stat({
  icon,
  value,
  label
}: {
  icon: string
  value: string | number
  label: string
}): JSX.Element {
  return (
    <div className="stat">
      <div className="stat-ico">
        <Icon name={icon} size={20} />
      </div>
      <div>
        <div className="stat-val">{value}</div>
        <div className="stat-label">{label}</div>
      </div>
    </div>
  )
}
