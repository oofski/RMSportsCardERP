import { useEffect, useMemo, useState } from 'react'
import type { EmployeeHoursSummary } from '@shared/types'
import { api } from '../../lib/api'
import { useChrome } from '../../lib/chrome'
import { Avatar, Button, CenterLoader, EmptyState } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { formatHours, formatDateTime, initials } from '../../lib/format'

/**
 * Admin > Hours is a high-level overview. The company-level tooling —
 * timesheets, pay periods and Gusto export — lives in the Time & Payroll
 * module.
 */
export function HoursTab(): JSX.Element {
  const { navigate } = useChrome()
  const [summary, setSummary] = useState<EmployeeHoursSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ;(async () => {
      setSummary(await api.hours.summary())
      setLoading(false)
    })()
  }, [])

  const totals = useMemo(() => {
    const minutes = summary.reduce((acc, s) => acc + s.totalMinutes, 0)
    const tracked = summary.filter((s) => s.entryCount > 0).length
    const entries = summary.reduce((acc, s) => acc + s.entryCount, 0)
    return { minutes, tracked, entries }
  }, [summary])

  if (loading) return <CenterLoader />

  return (
    <>
      <div className="stat-grid">
        <Stat icon="Clock" value={formatHours(totals.minutes)} label="Total hours logged" />
        <Stat icon="Users" value={String(totals.tracked)} label="Employees tracked" />
        <Stat icon="CalendarClock" value={String(totals.entries)} label="Time entries" />
      </div>

      <div className="section-head">
        <div>
          <h2>Hours at a glance</h2>
          <p>A quick overview. Open Time &amp; Payroll for timesheets and Gusto export.</p>
        </div>
        <Button variant="primary" icon="ArrowUpRight" onClick={() => navigate('timepay')}>
          Open Time &amp; Payroll
        </Button>
      </div>

      {summary.length === 0 ? (
        <EmptyState icon="Clock" title="No employees to show" />
      ) : (
        <div className="table-wrap">
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
              {summary.map((s) => (
                <tr key={s.employeeId}>
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
                  <td className="mono">{s.companyId}</td>
                  <td style={{ fontWeight: 600 }}>{formatHours(s.totalMinutes)}</td>
                  <td className="muted">{s.entryCount}</td>
                  <td className="muted">{formatDateTime(s.lastEntryAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
