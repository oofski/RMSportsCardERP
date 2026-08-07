import { useCallback, useEffect, useState } from 'react'
import type { Employee } from '@shared/types'
import { useSession } from '../../lib/session'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { CenterLoader } from '../../components/ui'
import { MyScheduleTab } from './MyScheduleTab'
import { RotaTab } from './RotaTab'

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
 * ONE screen for everybody, plus one more for leads. "Mine" is the whole module
 * for a packer: their rota and their availability on one calendar. A lead also
 * gets the week view they build the rota in, with everybody's answers shown
 * against the day they are filling — which is the entire point of collecting
 * them.
 */
export function ScheduleModule(): JSX.Element {
  const { can } = useSession()
  const canTeam = can('admin.hours.view')
  const [tab, setTab] = useState<'mine' | 'rota'>('mine')
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)

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

  return (
    <div className="content-narrow">
      <div className="seg-row">
        <button className={`seg ${tab === 'mine' ? 'on' : ''}`} onClick={() => setTab('mine')}>
          My schedule
        </button>
        {/* Who is DUE in, and what everybody said about the days that are still
            open. Reading it is admin.hours.view; CHANGING it needs
            admin.employees.manage, which the tab checks again inside. */}
        <button className={`seg ${tab === 'rota' ? 'on' : ''}`} onClick={() => setTab('rota')}>
          Team rota
        </button>
      </div>

      {tab === 'mine' ? <MyScheduleTab /> : <RotaTab employees={employees} />}
    </div>
  )
}
