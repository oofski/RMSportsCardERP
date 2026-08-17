import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Employee, EmployeeHoursSummary } from '@shared/types'
import { useSession } from '../../lib/session'
import { MyHours } from './MyHours'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { useToast } from '../../components/Toast'
import { Avatar, Button, CenterLoader, EmptyState, Field, Input, Modal, Select } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { formatHours, formatDateTime, initials, toLocalInputValue, fromLocalInputValue } from '../../lib/format'
import { presetPeriods, type Period } from '../../lib/payperiod'
import { EmployeeTimesheet, type TimesheetSubject } from '../admin/EmployeeTimesheet'

/** Build a timesheet subject from the roster if present, else the summary row. */
function subjectFromSummary(s: EmployeeHoursSummary, employees: Employee[]): TimesheetSubject {
  const emp = employees.find((e) => e.id === s.employeeId)
  if (emp) {
    return {
      id: emp.id,
      firstName: emp.firstName,
      lastName: emp.lastName,
      companyId: emp.companyId,
      title: emp.title
    }
  }
  const [first, ...rest] = s.employeeName.split(' ')
  return {
    id: s.employeeId,
    firstName: first ?? s.employeeName,
    lastName: rest.join(' '),
    companyId: s.companyId,
    title: ''
  }
}

export function TimePayrollModule(): JSX.Element {
  const { can } = useSession()
  const toast = useToast()
  const canManage = can('admin.employees.manage')
  /** Whether the TEAM's timesheet is theirs to see. Their own always is. */
  const canView = can('admin.hours.view')
  const [scope, setScope] = useState<'me' | 'team'>('me')

  const [employees, setEmployees] = useState<Employee[]>([])
  const [summary, setSummary] = useState<EmployeeHoursSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [addOpen, setAddOpen] = useState(false)
  const [selected, setSelected] = useState<TimesheetSubject | null>(null)

  const presets = useMemo(() => presetPeriods(), [])
  const [teamPeriod, setTeamPeriod] = useState<Period>(presets[0])
  const [exporting, setExporting] = useState(false)

  /**
   * Reload for the period on screen.
   *
   * `teamPeriod` is a real dependency, and leaving it out was the bug: the
   * picker set state that only the export button read, so the table underneath
   * it showed all-time totals no matter what was chosen — while the export sent
   * the chosen period. Two different answers on one screen, with nothing saying
   * so.
   */
  const load = useCallback(async () => {
    const [emp, sum] = await Promise.all([
      api.employees.list(),
      api.hours.summary({ start: teamPeriod.start, end: teamPeriod.end })
    ])
    setEmployees(emp)
    setSummary(sum)
  }, [teamPeriod.start, teamPeriod.end])

  // Somebody clocking in on the warehouse machine belongs on this timesheet now,
  // not whenever an admin happens to reopen the tab.
  useLiveRefresh(LIVE.people, load)

  useEffect(() => {
    ;(async () => {
      await load()
      setLoading(false)
    })()
  }, [load])

  const totals = useMemo(() => {
    const minutes = summary.reduce((acc, s) => acc + s.totalMinutes, 0)
    const tracked = summary.filter((s) => s.entryCount > 0).length
    const entries = summary.reduce((acc, s) => acc + s.entryCount, 0)
    return { minutes, tracked, entries }
  }, [summary])

  const exportTeam = async (): Promise<void> => {
    setExporting(true)
    try {
      const res = await api.hours.export({
        scope: 'team',
        start: teamPeriod.start,
        end: teamPeriod.end,
        format: 'gusto'
      })
      if (res.ok) toast.success(`Exported to ${res.path}`)
      else if (!res.canceled) toast.error(res.error ?? 'Export failed.')
    } finally {
      setExporting(false)
    }
  }

  if (loading) return <CenterLoader />

  if (selected) {
    return (
      <div className="content-narrow">
        <EmployeeTimesheet
          employee={selected}
          canManage={canManage}
          onBack={() => {
            setSelected(null)
            void load()
          }}
          onChanged={load}
        />
      </div>
    )
  }

  // WHOSE HOURS. Everybody gets their own; only a lead gets the team's, and the
  // segmented switch appears only when there is a second thing to switch to.
  if (!canView) {
    return (
      <div className="content-narrow">
        <MyHours />
      </div>
    )
  }

  return (
    <div className="content-narrow">
      <div className="seg-row">
        <button className={`seg ${scope === 'me' ? 'on' : ''}`} onClick={() => setScope('me')}>
          My hours
        </button>
        <button className={`seg ${scope === 'team' ? 'on' : ''}`} onClick={() => setScope('team')}>
          The team
        </button>
      </div>

      {scope === 'me' ? (
        <MyHours />
      ) : (
      <>
      {/* Labelled with the period, because "Total hours logged" is the sentence
          that made the old behaviour so easy to miss — it reads as a lifetime
          figure and it now is not one. The number and the words have to move
          together. */}
      <div className="stat-grid">
        <Stat
          icon="Clock"
          value={formatHours(totals.minutes)}
          label={`Hours logged · ${teamPeriod.label.toLowerCase()}`}
        />
        <Stat icon="Users" value={String(totals.tracked)} label="Employees with hours" />
        <Stat icon="CalendarClock" value={String(totals.entries)} label="Time entries" />
      </div>

      <div className="section-head">
        <div>
          <h2>Timesheets</h2>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <div style={{ width: 150 }}>
            <Select
              value={teamPeriod.id}
              onChange={(e) => {
                const p = presets.find((x) => x.id === e.target.value)
                if (p) setTeamPeriod(p)
              }}
            >
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </div>
          <Button variant="secondary" icon="FileSpreadsheet" loading={exporting} onClick={exportTeam}>
            Export team to Gusto
          </Button>
          {canManage && (
            <Button variant="primary" icon="Plus" onClick={() => setAddOpen(true)}>
              Add time entry
            </Button>
          )}
        </div>
      </div>

      {summary.length === 0 ? (
        <EmptyState icon="Clock" title="No employees to show" />
      ) : (
        <div className="table-wrap">
          {/* Stacks into one card per person on a phone — see section 3 of
              styles/mobile.css. Both the class and the data-labels are inert
              on the desktop. */}
          <table className="data as-cards">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Company ID</th>
                <th>Total hours</th>
                <th>Entries</th>
                <th>Last entry</th>
                <th style={{ textAlign: 'right' }}></th>
              </tr>
            </thead>
            <tbody>
              {summary.map((s) => {
                const open = (): void => setSelected(subjectFromSummary(s, employees))
                return (
                  <tr key={s.employeeId} onClick={open} style={{ cursor: 'pointer' }}>
                    <td>
                      <div className="cell-name">
                        <Avatar
                          text={initials(
                            s.employeeName.split(' ')[0] ?? '',
                            s.employeeName.split(' ').slice(1).join(' ')
                          )}
                          small
                        />
                        <span style={{ fontWeight: 600 }}>{s.employeeName}</span>
                      </div>
                    </td>
                    <td className="mono" data-label="Company ID">
                      {s.companyId}
                    </td>
                    <td style={{ fontWeight: 600 }} data-label="Total hours">
                      {formatHours(s.totalMinutes)}
                    </td>
                    <td className="muted" data-label="Entries">
                      {s.entryCount}
                    </td>
                    <td className="muted" data-label="Last entry">
                      {formatDateTime(s.lastEntryAt)}
                    </td>
                    <td>
                      <div className="cell-actions">
                        <Button size="sm" variant="ghost" icon="ChevronRight" onClick={open}>
                          Timesheet
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {addOpen && (
        <AddTimeEntryModal
          employees={employees}
          onClose={() => setAddOpen(false)}
          onSaved={async () => {
            setAddOpen(false)
            await load()
            toast.success('Time entry added.')
          }}
        />
      )}
      </>
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

function AddTimeEntryModal({
  employees,
  onClose,
  onSaved
}: {
  employees: Employee[]
  onClose: () => void
  onSaved: () => void | Promise<void>
}): JSX.Element {
  const now = new Date()
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000)
  const activeEmployees = employees.filter((e) => e.status !== 'disabled')

  const [form, setForm] = useState({
    employeeId: activeEmployees[0]?.id ?? '',
    clockIn: toLocalInputValue(hourAgo),
    clockOut: toLocalInputValue(now),
    note: ''
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setError('')
    if (!form.employeeId) {
      setError('Select an employee.')
      return
    }
    setBusy(true)
    try {
      const res = await api.hours.create({
        employeeId: form.employeeId,
        clockIn: fromLocalInputValue(form.clockIn),
        clockOut: form.clockOut ? fromLocalInputValue(form.clockOut) : null,
        note: form.note || null
      })
      if (!res.ok) {
        setError(res.error ?? 'Could not add entry.')
        return
      }
      await onSaved()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Add time entry"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="Check" loading={busy} onClick={submit}>
            Add entry
          </Button>
        </>
      }
    >
      {error && <div className="auth-alert">{error}</div>}
      <Field label="Employee">
        <Select
          value={form.employeeId}
          onChange={(e) => setForm((f) => ({ ...f, employeeId: e.target.value }))}
        >
          {activeEmployees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.firstName} {e.lastName} · {e.companyId}
            </option>
          ))}
        </Select>
      </Field>
      <div className="field-row">
        <Field label="Clock in">
          <Input
            type="datetime-local"
            value={form.clockIn}
            onChange={(e) => setForm((f) => ({ ...f, clockIn: e.target.value }))}
          />
        </Field>
        <Field label="Clock out">
          <Input
            type="datetime-local"
            value={form.clockOut}
            onChange={(e) => setForm((f) => ({ ...f, clockOut: e.target.value }))}
          />
        </Field>
      </div>
      <Field label="Note (optional)">
        <Input
          value={form.note}
          onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
          placeholder="e.g. Card grading shift"
        />
      </Field>
    </Modal>
  )
}
