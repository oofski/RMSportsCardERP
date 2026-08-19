import { useCallback, useEffect, useState } from 'react'
import type { Employee } from '@shared/types'
import { addDays, dayKey } from '@shared/homeTasks'
import { useSession } from '../../lib/session'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { CenterLoader } from '../../components/ui'
import { MyScheduleTab } from './MyScheduleTab'
import { RotationTab } from './RotationTab'
import { TeamScheduleTab } from './TeamScheduleTab'

/**
 * Schedule — when you are in, and the days you can and cannot work.
 *
 * Split out of Time & Payroll, which had become one tab answering two unrelated
 * questions because they were both about time. Nobody opens an app to think
 * about time; they open it to check their pay, or to find out whether they are
 * working Thursday. Those get asked on different days for different reasons, and
 * one of them is now a place the floor WRITES to — which a tab called "Hours"
 * gave no hint of.
 *
 * ## One screen for everybody, two more for leads
 *
 * MY SCHEDULE is the whole module for a packer: their rota and their usual week
 * on one calendar.
 *
 * TEAM is the oversight half — what needs sorting out this week, how each night
 * is covered, and everybody's usual week in one grid. It answers "who can I put
 * on Thursday" before the rota tab is opened to do it.
 *
 * ROTATION is where the week is actually built: one row per person, one column
 * per day, grouped by the job people do — and nothing on it reaches a phone
 * until somebody presses Publish.
 *
 * ## The week is owned HERE, not by either tab
 *
 * Both lead tabs are looking at the same seven days, and a lead who spots a gap
 * on Team and clicks through has to land on that day of THAT week. Two tabs each
 * holding their own week would put them on whichever week the rota tab last had,
 * which is the sort of thing somebody only notices after rostering the wrong
 * Thursday.
 */
export function ScheduleModule(): JSX.Element {
  const { can } = useSession()
  const canTeam = can('admin.hours.view')
  const [tab, setTab] = useState<'mine' | 'team' | 'rota'>('mine')
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)

  /** The Monday on or before a day. Sunday belongs to the week just ended. */
  const mondayOf = (day: string): string => {
    const t = Date.parse(`${day}T12:00:00Z`)
    if (!Number.isFinite(t)) return day
    const dow = new Date(t).getUTCDay()
    return addDays(day, dow === 0 ? -6 : 1 - dow)
  }

  const [weekStart, setWeekStart] = useState(() => mondayOf(dayKey(new Date())))
  const [focusDay, setFocusDay] = useState<string | null>(null)

  const loadEmployees = useCallback(async () => {
    // The roster is only needed to BUILD a rota. A packer cannot read it and
    // does not need to, so asking for it would be a request that fails on the
    // one screen that must not fail.
    if (!canTeam) {
      setEmployees([])
      return
    }
    try {
      setEmployees(await api.employees.list())
    } catch {
      setEmployees([])
    }
  }, [canTeam])

  useLiveRefresh(LIVE.people, loadEmployees)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        await loadEmployees()
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [loadEmployees])

  if (loading) return <CenterLoader />

  if (!canTeam) {
    return (
      <div className="content-narrow">
        <MyScheduleTab />
      </div>
    )
  }

  /** Team → Rota, landing on the day that was clicked, in the week shown. */
  const openDay = (day: string): void => {
    setWeekStart(mondayOf(day))
    setFocusDay(day)
    setTab('rota')
  }

  return (
    <div className="content-narrow">
      <div className="seg-row">
        <button className={`seg ${tab === 'mine' ? 'on' : ''}`} onClick={() => setTab('mine')}>
          My schedule
        </button>
        {/* Oversight before editing, because that is the order the work happens
            in: you find out what needs doing, then you go and do it. */}
        <button className={`seg ${tab === 'team' ? 'on' : ''}`} onClick={() => setTab('team')}>
          Team
        </button>
        {/* Reading it is admin.hours.view; CHANGING it needs
            admin.employees.manage, which the tab checks again inside. The tab id
            stays 'rota' — it is remembered in component state and named by
            openDay below, and renaming what a thing is CALLED is not a reason to
            rename what it is. */}
        <button className={`seg ${tab === 'rota' ? 'on' : ''}`} onClick={() => setTab('rota')}>
          Rotation
        </button>
      </div>

      {tab === 'mine' ? (
        <MyScheduleTab />
      ) : tab === 'team' ? (
        <TeamScheduleTab weekStart={weekStart} onOpenDay={openDay} />
      ) : (
        <RotationTab
          employees={employees}
          weekStart={weekStart}
          setWeekStart={setWeekStart}
          focusDay={focusDay}
          onFocusHandled={() => setFocusDay(null)}
        />
      )}
    </div>
  )
}
