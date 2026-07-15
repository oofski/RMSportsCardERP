import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Employee, EmployeeHoursSummary, TimeEntry } from '@shared/types'
import { useSession } from '../../lib/session'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Avatar, Button, EmptyState, Field, Input, Modal, Select } from '../../components/ui'
import { Icon } from '../../components/Icon'
import {
  formatHours,
  formatDateTime,
  initials,
  toLocalInputValue,
  fromLocalInputValue
} from '../../lib/format'

export function HoursTab({ employees }: { employees: Employee[] }): JSX.Element {
  const { can } = useSession()
  const toast = useToast()
  const canManage = can('admin.employees.manage')

  const [summary, setSummary] = useState<EmployeeHoursSummary[]>([])
  const [entries, setEntries] = useState<TimeEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [addOpen, setAddOpen] = useState(false)

  const load = useCallback(async () => {
    const [s, e] = await Promise.all([api.hours.summary(), api.hours.list()])
    setSummary(s)
    setEntries(e)
  }, [])

  useEffect(() => {
    ;(async () => {
      await load()
      setLoading(false)
    })()
  }, [load])

  const empName = useCallback(
    (id: string) => {
      const e = employees.find((x) => x.id === id)
      return e ? `${e.firstName} ${e.lastName}` : 'Unknown'
    },
    [employees]
  )

  const totals = useMemo(() => {
    const minutes = summary.reduce((acc, s) => acc + s.totalMinutes, 0)
    const tracked = summary.filter((s) => s.entryCount > 0).length
    return { minutes, tracked, entries: entries.length }
  }, [summary, entries])

  const deleteEntry = async (id: string): Promise<void> => {
    const res = await api.hours.delete(id)
    if (res.ok) {
      toast.success('Entry removed.')
      await load()
    } else {
      toast.error(res.error ?? 'Could not remove entry.')
    }
  }

  if (loading) return <div className="empty">Loading hours…</div>

  return (
    <>
      <div className="stat-grid">
        <Stat icon="Clock" value={formatHours(totals.minutes)} label="Total hours logged" />
        <Stat icon="Users" value={String(totals.tracked)} label="Employees tracked" />
        <Stat icon="CalendarClock" value={String(totals.entries)} label="Time entries" />
      </div>

      <div className="section-head">
        <div>
          <h2>Hours by employee</h2>
          <p>Totals are rolled up from logged time entries.</p>
        </div>
        {canManage && (
          <Button variant="primary" icon="Plus" onClick={() => setAddOpen(true)}>
            Add time entry
          </Button>
        )}
      </div>

      {summary.length === 0 ? (
        <EmptyState icon="Clock" title="No employees to show" />
      ) : (
        <div className="table-wrap" style={{ marginBottom: 26 }}>
          <table className="data">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Company ID</th>
                <th>Total hours</th>
                <th>Entries</th>
                <th>Last entry</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((s) => {
                const [first, ...rest] = s.employeeName.split(' ')
                return (
                  <tr key={s.employeeId}>
                    <td>
                      <div className="cell-name">
                        <Avatar text={initials(first ?? '', rest.join(' '))} small />
                        <span style={{ fontWeight: 600 }}>{s.employeeName}</span>
                      </div>
                    </td>
                    <td className="mono">{s.companyId}</td>
                    <td style={{ fontWeight: 600 }}>{formatHours(s.totalMinutes)}</td>
                    <td className="muted">{s.entryCount}</td>
                    <td className="muted">{formatDateTime(s.lastEntryAt)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="section-head">
        <div>
          <h2>Recent time entries</h2>
          <p>The latest clock-in / clock-out records.</p>
        </div>
      </div>

      {entries.length === 0 ? (
        <EmptyState
          icon="CalendarClock"
          title="No time entries yet"
          message={
            canManage
              ? 'Add a time entry to start tracking hours. Automatic clock-in/out arrives with the Time & Payroll module.'
              : 'Hours will appear here once time is logged.'
          }
          action={
            canManage ? (
              <Button variant="primary" icon="Plus" onClick={() => setAddOpen(true)}>
                Add time entry
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Clock in</th>
                <th>Clock out</th>
                <th>Duration</th>
                <th>Note</th>
                {canManage && <th style={{ textAlign: 'right' }}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {entries.map((t) => {
                const mins = t.clockOut
                  ? Math.round(
                      (new Date(t.clockOut).getTime() - new Date(t.clockIn).getTime()) / 60000
                    )
                  : 0
                return (
                  <tr key={t.id}>
                    <td style={{ fontWeight: 600 }}>{empName(t.employeeId)}</td>
                    <td className="muted">{formatDateTime(t.clockIn)}</td>
                    <td className="muted">
                      {t.clockOut ? (
                        formatDateTime(t.clockOut)
                      ) : (
                        <span className="badge badge-invited">In progress</span>
                      )}
                    </td>
                    <td style={{ fontWeight: 600 }}>{t.clockOut ? formatHours(mins) : '—'}</td>
                    <td className="muted">{t.note || '—'}</td>
                    {canManage && (
                      <td>
                        <div className="cell-actions">
                          <Button
                            size="sm"
                            variant="ghost"
                            icon="Trash2"
                            onClick={() => deleteEntry(t.id)}
                          >
                            Remove
                          </Button>
                        </div>
                      </td>
                    )}
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
      subtitle="Log a shift manually. Leave clock-out blank for an in-progress shift."
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
