import { useCallback, useEffect, useState } from 'react'
import type { Employee } from '@shared/types'
import type { StreamSession } from '@shared/streaming'
import { useSession } from '../../lib/session'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { Icon } from '../../components/Icon'
import { EmptyState } from '../../components/ui'
import { LiveBar } from './LiveBar'
import { StreamCalendar } from './StreamCalendar'
import { SessionsTab } from './SessionsTab'
import { SlipsTab, useSlipsWorkspace } from './SlipsTab'
import { SessionDetail } from './SessionDetail'
import { SessionFormModal } from './SessionFormModal'
import { ScheduledStrip } from './Scheduled'
import { streaming, streamingReady } from './api'
import { todayKey } from './time'

/**
 * Streaming — the module shell.
 *
 * The calendar is the front door because a show is a thing that happened on a
 * night, and the night is how the operator remembers it. Everything else hangs
 * off that: a day opens its sessions, a session opens the screen where breaks
 * and giveaways are recorded.
 *
 * Two pieces of state are owned here rather than by a tab. The **live session**,
 * because the bar is visible from every view and a stream started on one tab
 * must show up on the others. And a **version counter**, bumped after any write,
 * because the calendar, the list and the live bar all read the same sessions
 * from different angles and must never disagree about them.
 */
type StreamTab = 'calendar' | 'sessions' | 'slips'

export function StreamingModule(): JSX.Element {
  const { can } = useSession()
  const canManage = can('streaming.manage')
  // The product picker reads the Inventory catalog, which is gated separately —
  // a streaming-only account can see every line but cannot search for new ones.
  const canSearchCatalog = can('module.inventory')

  const [tab, setTab] = useState<StreamTab>('calendar')
  const slips = useSlipsWorkspace(setTab)
  const [openId, setOpenId] = useState<string | null>(null)
  const [active, setActive] = useState<StreamSession | null>(null)
  const [activeLoading, setActiveLoading] = useState(true)
  const [hosts, setHosts] = useState<Employee[]>([])
  const [version, setVersion] = useState(0)
  const [addingFor, setAddingFor] = useState<string | null>(null)

  const reloadActive = useCallback(async () => {
    try {
      setActive(await streaming.active())
    } catch {
      // The bar is a status line, not the module. A failed read leaves it
      // saying "nothing live" rather than taking the whole screen down.
      setActive(null)
    } finally {
      setActiveLoading(false)
    }
  }, [])

  // The stream board is watched during a break while items are added elsewhere.
  useLiveRefresh(LIVE.streaming, reloadActive)

  useEffect(() => {
    if (!streamingReady) {
      setActiveLoading(false)
      return
    }
    void reloadActive()
  }, [reloadActive])

  // The host list lives behind the employee-admin permission, so most operators
  // get an empty array. That is not an error — the pickers just hide themselves.
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const list = await api.employees.list()
        if (alive) setHosts(list.filter((e) => e.status !== 'disabled'))
      } catch {
        if (alive) setHosts([])
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const onChanged = useCallback(async () => {
    setVersion((v) => v + 1)
    await reloadActive()
  }, [reloadActive])

  if (!streamingReady) {
    return (
      <div className="content-narrow stm-shell">
        <EmptyState
          icon="AlertTriangle"
          title="Streaming is not available in this build"
          message="This build does not expose the streaming bridge. Restart after updating."
        />
      </div>
    )
  }

  // Nothing blocks on the live read: the bar reports its own progress and the
  // calendar draws its own skeleton, so the month is already loading while the
  // "is anything on air" question resolves.
  return (
    <div className="content-narrow stm-shell">
      <LiveBar
        active={active}
        loading={activeLoading}
        canManage={canManage}
        hosts={hosts}
        onStarted={async (session) => {
          await onChanged()
          // Straight into the session: the next thing that happens on a live
          // show is a break, and that is recorded here.
          setOpenId(session.id)
        }}
        onEnded={onChanged}
        onOpen={setOpenId}
      />

      {/* Under the bar because it answers the same question from the other
          side: the bar says what is on air, this says what is not on air YET.
          Hidden while a session is open — that screen is about one night, and
          next Friday is not part of it. */}
      {!openId && (
        <ScheduledStrip
          version={version}
          canManage={canManage}
          hosts={hosts}
          onChanged={onChanged}
          onOpenSession={setOpenId}
        />
      )}

      {openId ? (
        <SessionDetail
          id={openId}
          canManage={canManage}
          canSearchCatalog={canSearchCatalog}
          hosts={hosts}
          onBack={() => setOpenId(null)}
          onChanged={onChanged}
        />
      ) : (
        <>
          <div className="tabs stm-tabs">
            <button
              className={`tab ${tab === 'calendar' ? 'active' : ''}`}
              onClick={() => setTab('calendar')}
            >
              <Icon name="CalendarRange" size={16} />
              Calendar
            </button>
            <button
              className={`tab ${tab === 'sessions' ? 'active' : ''}`}
              onClick={() => setTab('sessions')}
            >
              <Icon name="ListChecks" size={16} />
              Sessions
            </button>
            {/* THE SLIPS BELONG TO THE SHOW.
                A packing slip is the record of what a stream sold, so importing
                one is the last step of running the night rather than a separate
                administrative errand — which is what it was, three tabs deep in
                Admin, on a screen about employees. Here it sits next to the
                session it describes, and the break assignment that follows it is
                one click away instead of in another module. */}
            {canManage && (
              <button
                className={`tab ${tab === 'slips' ? 'active' : ''}`}
                onClick={() => setTab('slips')}
              >
                <Icon name="UploadCloud" size={16} />
                Packing slips
                {slips.warnings > 0 && (
                  <span className="ship-tab-badge warning">{slips.warnings}</span>
                )}
              </button>
            )}
          </div>

          {tab === 'slips' ? (
            <SlipsTab workspace={slips} />
          ) : tab === 'calendar' ? (
            <StreamCalendar
              version={version}
              canManage={canManage}
              onOpen={setOpenId}
              onAddManual={setAddingFor}
            />
          ) : (
            <SessionsTab
              version={version}
              canManage={canManage}
              onOpen={setOpenId}
              onAddManual={setAddingFor}
            />
          )}
        </>
      )}

      {addingFor && (
        <SessionFormModal
          initialDate={addingFor || todayKey()}
          hosts={hosts}
          onClose={() => setAddingFor(null)}
          onSaved={async () => {
            setAddingFor(null)
            await onChanged()
          }}
        />
      )}
    </div>
  )
}
