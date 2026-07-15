import { Fragment, useEffect, useMemo, useState } from 'react'
import type { TimeEntry } from '@shared/types'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Avatar, Button, Select } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { initials, fullName, formatHours } from '../../lib/format'
import {
  presetPeriods,
  customPeriod,
  computePayroll,
  entryMinutes,
  toDateInput,
  inclusiveEndInput,
  type Period
} from '../../lib/payperiod'

function timeWithSeconds(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  })
}

function dayHeading(dayKey: string): string {
  const d = new Date(`${dayKey}T00:00:00`)
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric'
  })
}

function dayKeyOf(iso: string): string {
  const d = new Date(iso)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export interface TimesheetSubject {
  id: string
  firstName: string
  lastName: string
  companyId: string
  title: string
}

export function EmployeeTimesheet({
  employee,
  onBack,
  canManage,
  onChanged
}: {
  employee: TimesheetSubject
  onBack: () => void
  canManage: boolean
  onChanged: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const presets = useMemo(() => presetPeriods(), [])
  const [period, setPeriod] = useState<Period>(presets[0])
  const [customStart, setCustomStart] = useState(() => toDateInput(presets[0].start))
  const [customEnd, setCustomEnd] = useState(() => inclusiveEndInput(presets[0].end))
  const [entries, setEntries] = useState<TimeEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState<string | null>(null)

  const load = async (p: Period): Promise<void> => {
    setLoading(true)
    try {
      const rows = await api.hours.timesheet(employee.id, p.start, p.end)
      setEntries(rows)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load(period)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period])

  const onPreset = (id: string): void => {
    if (id === 'custom') {
      setPeriod(customPeriod(customStart, customEnd))
    } else {
      const p = presets.find((x) => x.id === id)
      if (p) {
        setPeriod(p)
        setCustomStart(toDateInput(p.start))
        setCustomEnd(inclusiveEndInput(p.end))
      }
    }
  }

  const applyCustom = (start: string, end: string): void => {
    setCustomStart(start)
    setCustomEnd(end)
    if (start && end) setPeriod(customPeriod(start, end))
  }

  const grouped = useMemo(() => {
    const map = new Map<string, TimeEntry[]>()
    for (const e of entries) {
      const key = dayKeyOf(e.clockIn)
      ;(map.get(key) ?? map.set(key, []).get(key)!).push(e)
    }
    return Array.from(map.entries())
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([day, list]) => ({
        day,
        list: list.sort((a, b) => (a.clockIn < b.clockIn ? -1 : 1)),
        minutes: list.reduce((acc, e) => acc + entryMinutes(e), 0)
      }))
  }, [entries])

  const totals = useMemo(() => computePayroll(entries), [entries])

  const doExport = async (format: 'timesheet' | 'gusto'): Promise<void> => {
    setExporting(format)
    try {
      const res = await api.hours.export({
        scope: 'employee',
        employeeId: employee.id,
        start: period.start,
        end: period.end,
        format
      })
      if (res.ok) toast.success(`Exported to ${res.path}`)
      else if (!res.canceled) toast.error(res.error ?? 'Export failed.')
    } finally {
      setExporting(null)
    }
  }

  const removeEntry = async (id: string): Promise<void> => {
    const res = await api.hours.delete(id)
    if (res.ok) {
      toast.success('Entry removed.')
      await load(period)
      await onChanged()
    } else {
      toast.error(res.error ?? 'Could not remove entry.')
    }
  }

  return (
    <>
      <div className="section-head">
        <div className="row" style={{ gap: 12 }}>
          <Button variant="ghost" size="sm" icon="ArrowLeft" onClick={onBack}>
            Back
          </Button>
          <div className="cell-name">
            <Avatar text={initials(employee.firstName, employee.lastName)} />
            <div>
              <div style={{ fontWeight: 600 }}>{fullName(employee.firstName, employee.lastName)}</div>
              <div className="muted text-sm">
                {employee.companyId} · {employee.title || '—'}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="panel-card" style={{ marginBottom: 18 }}>
        <div className="panel-head" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <div style={{ width: 168 }}>
              <Select value={period.id} onChange={(e) => onPreset(e.target.value)}>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
                <option value="custom">Custom range</option>
              </Select>
            </div>
            {period.id === 'custom' && (
              <div className="row" style={{ gap: 8 }}>
                <input
                  className="input"
                  type="date"
                  style={{ width: 150 }}
                  value={customStart}
                  onChange={(e) => applyCustom(e.target.value, customEnd)}
                />
                <span className="muted">to</span>
                <input
                  className="input"
                  type="date"
                  style={{ width: 150 }}
                  value={customEnd}
                  onChange={(e) => applyCustom(customStart, e.target.value)}
                />
              </div>
            )}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <Button
              variant="secondary"
              size="sm"
              icon="Download"
              loading={exporting === 'timesheet'}
              onClick={() => doExport('timesheet')}
            >
              Timesheet CSV
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon="FileSpreadsheet"
              loading={exporting === 'gusto'}
              onClick={() => doExport('gusto')}
            >
              Export to Gusto
            </Button>
          </div>
        </div>

        <div className="stat-grid" style={{ marginBottom: 0 }}>
          <MiniStat label="Regular hours" value={formatHours(totals.regularMinutes)} />
          <MiniStat label="Overtime (>40/wk)" value={formatHours(totals.overtimeMinutes)} />
          <MiniStat label="Total hours" value={formatHours(totals.totalMinutes)} strong />
        </div>
      </div>

      {loading ? (
        <div className="empty">Loading timesheet…</div>
      ) : entries.length === 0 ? (
        <div className="empty">
          <div className="empty-ico">
            <Icon name="CalendarDays" size={26} />
          </div>
          <h3>No hours in this period</h3>
          <p>Pick a different range, or entries will appear here as {employee.firstName} clocks in and out.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Clock in</th>
                <th>Clock out</th>
                <th>Hours</th>
                <th>Location</th>
                {canManage && <th style={{ textAlign: 'right' }}></th>}
              </tr>
            </thead>
            <tbody>
              {grouped.map((g) => (
                <Fragment key={g.day}>
                  <tr className="matrix-group-row">
                    <td colSpan={canManage ? 4 : 3}>{dayHeading(g.day)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }} className="matrix-group-row">
                      {formatHours(g.minutes)}
                    </td>
                  </tr>
                  {g.list.map((e) => (
                    <tr key={e.id}>
                      <td className="mono">{timeWithSeconds(e.clockIn)}</td>
                      <td className="mono">
                        {e.clockOut ? (
                          timeWithSeconds(e.clockOut)
                        ) : (
                          <span className="badge badge-invited">In progress</span>
                        )}
                      </td>
                      <td style={{ fontWeight: 600 }}>
                        {e.clockOut ? formatHours(entryMinutes(e)) : '—'}
                      </td>
                      <td className="muted">
                        {e.clockInLocation.place ? (
                          <span className="row" style={{ gap: 5 }}>
                            <Icon name="MapPin" size={13} />
                            {e.clockInLocation.place}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      {canManage && (
                        <td>
                          <div className="cell-actions">
                            <Button
                              size="sm"
                              variant="ghost"
                              icon="Trash2"
                              onClick={() => removeEntry(e.id)}
                            >
                              Remove
                            </Button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function MiniStat({
  label,
  value,
  strong
}: {
  label: string
  value: string
  strong?: boolean
}): JSX.Element {
  return (
    <div className="stat">
      <div className="stat-ico">
        <Icon name={strong ? 'Timer' : 'Clock'} size={21} />
      </div>
      <div>
        <div className="stat-val" style={strong ? { color: 'var(--brand-600)' } : undefined}>
          {value}
        </div>
        <div className="stat-label">{label}</div>
      </div>
    </div>
  )
}
