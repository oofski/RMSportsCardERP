/**
 * Employee performance — the shipping floor's numbers, over a range.
 *
 * Gated on 'admin.access', the same permission the QuickBooks connection uses,
 * and for a blunter reason: this is a report ABOUT NAMED PEOPLE. How long
 * somebody took at a bench is the sort of figure that decides a conversation,
 * and the set of people who may open it is the set who may already see the
 * timesheets. Nothing here is exposed to the floor at all — not even their own
 * row — because a screen that shows you your own average invites comparing it
 * with somebody else's, and this module has no way to say who was helping.
 *
 * ONE handler, ONE range. Every figure the screen prints comes out of the same
 * call, so the headline counts and the per-person table cannot end up
 * describing different periods — which is what happened on the Finance tab when
 * a grain switch and a total were computed from different state.
 */
import { ipcMain } from './ipcRegistry'
import { IPC } from '@shared/ipc'
import type { ShippingPerformanceView } from '@shared/performance'
import { summariseShipping, utcWindowForDays } from '@shared/performance'
import { currentUser } from './services/auth'
import { getDb } from './db/database'
import { listWorkEvents, workLogSpan } from './db/workLog'
import { listEmployees } from './db/employees'

function canRead(): boolean {
  const user = currentUser()
  return !!user && user.permissions.includes('admin.access')
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Minutes each person was clocked in during the window, by OVERLAP.
 *
 * Not "entries whose clock-in falls in the range", which is what the payroll
 * summary asks: a shift that began at 22:00 and ran past midnight belongs to
 * both days in part, and charging the whole of it to the day it started would
 * inflate one day and empty the next. An open shift contributes only up to the
 * end of the window, so somebody still on the clock does not read as having
 * worked into next week.
 *
 * Context only. It is never divided into a step timing — see the note on
 * EmployeePerf.clockedMinutes for why a utilisation figure built from those two
 * would be supported by neither of them.
 */
function clockedMinutes(startIso: string, endIso: string): Map<string, number> {
  const rows = getDb()
    .prepare(
      `SELECT employee_id, clock_in, clock_out FROM time_entries
        WHERE clock_in < ? AND (clock_out IS NULL OR clock_out > ?)`
    )
    .all(endIso, startIso) as Array<{
    employee_id: string
    clock_in: string
    clock_out: string | null
  }>
  const windowStart = Date.parse(startIso)
  const windowEnd = Date.parse(endIso)
  const out = new Map<string, number>()
  for (const r of rows) {
    const a = Date.parse(r.clock_in)
    // An open shift is clipped at the window's end rather than at "now": a
    // report on last week must not grow every time somebody looks at it.
    const b = r.clock_out ? Date.parse(r.clock_out) : windowEnd
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    const overlap = Math.min(b, windowEnd) - Math.max(a, windowStart)
    if (overlap <= 0) continue
    out.set(r.employee_id, (out.get(r.employee_id) ?? 0) + Math.round(overlap / 60000))
  }
  return out
}

export function registerPerformanceIpc(): void {
  ipcMain.handle(
    IPC.perfShipping,
    (_e, payload: { from?: string; to?: string }): ShippingPerformanceView | null => {
      if (!canRead()) return null
      const from = String(payload?.from ?? '')
      const to = String(payload?.to ?? '')
      // A malformed range returns nothing rather than falling back to "all
      // time". A report that silently widens its own window is the one that
      // gets screenshotted under the wrong heading.
      if (!DAY_RE.test(from) || !DAY_RE.test(to)) return null

      const { startIso, endIso } = utcWindowForDays(from, to)
      if (!startIso || !endIso) return null

      const employees = listEmployees()
      const names = new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`.trim()]))
      const span = workLogSpan()

      return {
        ...summariseShipping({
          // Narrowed by UTC here for the index; re-tested against the LOCAL
          // calendar inside the summary, which is the definitive answer when a
          // range spans a clock change.
          events: listWorkEvents(startIso, endIso),
          from,
          to,
          nameOf: (id) => names.get(id) ?? null,
          clockedMinutes: clockedMinutes(startIso, endIso)
        }),
        loggedFrom: span.first,
        loggedTo: span.last
      }
    }
  )
}
