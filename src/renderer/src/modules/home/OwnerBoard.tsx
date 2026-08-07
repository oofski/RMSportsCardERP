import { useCallback, useEffect, useState } from 'react'
import type { OwnerBoard as Board, OwnerPnlWindow, Reminder, Todo } from '@shared/ownerDashboard'
import { REMINDER_MAX_LENGTH, TODO_MAX_LENGTH } from '@shared/ownerDashboard'
import { recurringLabel } from '@shared/homeTasks'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { useChrome } from '../../lib/chrome'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { Icon } from '../../components/Icon'
import { Button } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { formatHours, formatMoney } from '../../lib/format'

/**
 * The owner's board: every side of the business, above the fold.
 *
 * The organising idea is FOUR QUESTIONS, in the order somebody who owns this
 * actually asks them — what did we make, what do we owe, what is owed to us,
 * what is happening next — and then the inbox, because a note from the floor is
 * the only thing here that is waiting on him personally.
 *
 * Every tile is a door. Nothing on this screen is a place to work: the numbers
 * belong to their modules and a click goes there, which is what keeps this a
 * vantage point rather than a fifth copy of the same arithmetic.
 *
 * Sections the viewer cannot see arrive null and render nothing. That is the
 * whole access model — no owner-only flag to keep in step with the module list.
 */
export function OwnerBoard(): JSX.Element | null {
  const { can } = useSession()
  const { navigate } = useChrome()
  const [board, setBoard] = useState<Board | null>(null)
  const [reminders, setReminders] = useState<Reminder[]>([])
  const [loaded, setLoaded] = useState(false)

  const canInbox = can('admin.access')

  const load = useCallback(async () => {
    const [b, r] = await Promise.all([
      api.owner.board(),
      canInbox ? api.owner.reminders() : Promise.resolve([] as Reminder[])
    ])
    setBoard(b)
    setReminders(r)
  }, [canInbox])

  // Every family the six cards read, not just two of them. The gaps were real:
  // without `purchasing` a case received on the warehouse laptop left the
  // incoming list stale, and without `finance` an overnight ledger import on
  // another machine never reached the owner's morning numbers at all — which is
  // the one thing this page exists to show.
  useLiveRefresh(LIVE.inventory, load)
  useLiveRefresh(LIVE.shipping, load)
  useLiveRefresh(LIVE.purchasing, load)
  useLiveRefresh(LIVE.finance, load)
  useLiveRefresh(LIVE.people, load)
  useLiveRefresh(LIVE.notes, load)
  // The slips task is a statement about a STREAM, so a show starting or ending
  // on another machine is a change this page has to hear.
  useLiveRefresh(LIVE.streaming, load)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        await load()
      } finally {
        if (active) setLoaded(true)
      }
    })()
    return () => {
      active = false
    }
  }, [load])

  if (!loaded || !board) return null
  // Somebody whose permissions reach none of the sections has nothing to put
  // here — an empty grid is a worse screen than no grid.
  //
  // THE TO-DO LIST IS NOT PART OF THAT TEST, and this is the whole bug the gate
  // had: it listed four sections, was written before three more existed, and so
  // a packer on the Shipping role — whose "orders to ship" card main had
  // already built and sent down — got a blank page. Their own checklist went
  // with it, though nothing gates a checklist but being signed in.
  const anySection =
    board.whatnot ||
    board.payables ||
    board.inventory ||
    board.schedule ||
    board.incoming ||
    board.toShip ||
    board.employeesToday ||
    canInbox
  if (!anySection) {
    return (
      <div className="ob">
        <div className="ob-grid">
          <TodayCard board={board} reminders={reminders} onChanged={load} canInbox={canInbox} />
        </div>
      </div>
    )
  }

  return (
    <div className="ob">
      {board.whatnot?.unreconciled && (
        <button className="ob-alert" onClick={() => navigate('finance')}>
          <Icon name="AlertTriangle" size={16} />
          <span>
            <b>The P&amp;L does not add up.</b>{' '}
            {board.whatnot.reconcileNote ?? 'Open Finance before booking from these numbers.'}
          </span>
          <Icon name="ArrowRight" size={15} />
        </button>
      )}

      {/* THE SKETCH'S ORDER, and the order is the point. The top row is what
          somebody has to DO today — stock arriving, packages going out, notes
          people left him. The second row is how the business is doing. Money
          above work would be a dashboard; work above money is a morning. */}
      <div className="ob-grid">
        {board.incoming && (
          <div className="ob-card">
            <header onClick={() => navigate('inventory')}>
              <Icon name="Truck" size={16} />
              <h3>Incoming orders</h3>
              <span className="ob-sub">
                {board.incoming.orderCount === 0
                  ? 'Nothing on the way'
                  : `${board.incoming.units} unit${board.incoming.units === 1 ? '' : 's'} · ${formatMoney(board.incoming.value)}`}
              </span>
              <span className="ob-open">
                Open <Icon name="ArrowRight" size={13} />
              </span>
            </header>
            {board.incoming.items.length > 0 ? (
              <ul className="ob-mini">
                {board.incoming.items.map((o) => (
                  <li key={o.id}>
                    <span className="ob-mini-name">{o.title}</span>
                    <span className="ob-mini-qty">{o.detail}</span>
                    <span className="ob-mini-val mono">{o.units}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ob-empty">Nothing on its way in.</p>
            )}
          </div>
        )}

        {board.toShip && (
          <div className="ob-card">
            <header onClick={() => navigate('fulfillment')}>
              <Icon name="Package" size={16} />
              <h3>Orders to ship</h3>
              <span className="ob-sub">
                {!board.toShip.imported
                  ? 'No slip imported'
                  : board.toShip.remaining === 0
                    ? 'All gone out'
                    : `${board.toShip.remaining} still to go`}
              </span>
              <span className="ob-open">
                Open <Icon name="ArrowRight" size={13} />
              </span>
            </header>
            {board.toShip.items.length > 0 ? (
              <ul className="ob-mini">
                {board.toShip.items.map((o) => (
                  <li key={o.customerId}>
                    <span className="ob-mini-name">@{o.handle}</span>
                    <span className="ob-mini-qty">{o.realName}</span>
                    <span className="ob-mini-val mono">
                      {o.cardsLeft}/{o.cardsTotal}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ob-empty">
                {board.toShip.imported
                  ? 'Every package has gone out.'
                  : "Nothing imported yet — upload tonight's packing slips."}
              </p>
            )}
          </div>
        )}

        {board.whatnot && (
          <PnlCard
            title="Whatnot"
            sub="Live shows"
            icon="Radio"
            windows={[board.whatnot.today, board.whatnot.week, board.whatnot.month]}
            footer={
              board.whatnot.lastDay
                ? `Last show ${board.whatnot.lastDay} · ${formatMoney(board.whatnot.lastDayNet)} net`
                : 'No show data yet'
            }
            onOpen={() => navigate('finance')}
          />
        )}

        {board.wholesale && (
          <PnlCard
            title="Wholesale"
            sub="Sold off-stream"
            icon="Package"
            windows={[board.wholesale.today, board.wholesale.week, board.wholesale.month]}
            /* After fees, NOT after cost of goods — unlike the Whatnot card
               beside it, whose headline figure is net of the boxes. The two sit
               in the same place on the page, so the difference has to be said
               rather than inferred. */
            footer={
              board.wholesale.productCount > 0
                ? `After fees, before cost of goods · ${board.wholesale.productCount} product${board.wholesale.productCount === 1 ? '' : 's'} this month` +
                  (board.wholesale.unmatchedCount > 0
                    ? ` · ${board.wholesale.unmatchedCount} not in the catalog`
                    : '')
                : 'Nothing sold outright in the last 30 days'
            }
            onOpen={() => navigate('finance')}
          >
            {board.wholesale.top.length > 0 && (
              <ul className="ob-mini">
                {board.wholesale.top.map((t) => (
                  <li key={`${t.productId ?? 'x'}|${t.name}`}>
                    <span className="ob-mini-name" title={t.name}>
                      {!t.productId && (
                        <Icon name="Link2Off" size={12} />
                      )}
                      {t.name}
                    </span>
                    <span className="ob-mini-qty">{t.units}</span>
                    <span className="ob-mini-val mono">{formatMoney(t.revenue)}</span>
                  </li>
                ))}
              </ul>
            )}
          </PnlCard>
        )}

        {board.employeesToday && (
          <div className="ob-card">
            <header onClick={() => navigate('timepay')}>
              <Icon name="Users" size={16} />
              <h3>Employees today</h3>
              <span className="ob-sub">
                {board.employeesToday.filter((e) => e.onTheClock).length} on the clock
              </span>
              <span className="ob-open">
                Open <Icon name="ArrowRight" size={13} />
              </span>
            </header>
            {board.employeesToday.length > 0 ? (
              <ul className="ob-shows">
                {board.employeesToday.map((e) => (
                  <li key={e.id} data-live={e.onTheClock ? 'true' : 'false'}>
                    <span className="ob-show-when">
                      {formatHours(e.minutesToday)}
                      <em>
                        {e.since
                          ? new Date(e.since).toLocaleTimeString([], {
                              hour: 'numeric',
                              minute: '2-digit'
                            })
                          : 'finished'}
                      </em>
                    </span>
                    <span className="ob-show-title">{e.name}</span>
                    {e.onTheClock && <span className="ob-flag" data-tone="ok">IN</span>}
                  </li>
                ))}
              </ul>
            ) : (
              /* NOT a rota. Nothing in this app records who is DUE in — only who
                 has clocked in — so an empty card says exactly that rather than
                 implying nobody is coming. */
              <p className="ob-empty">Nobody has clocked in yet today.</p>
            )}
          </div>
        )}

        {(board.payables || board.receivables) && (
          <div className="ob-card">
            <header onClick={() => navigate('invoicing')}>
              <Icon name="Wallet" size={16} />
              <h3>Money</h3>
              <span className="ob-open">
                Open <Icon name="ArrowRight" size={13} />
              </span>
            </header>

            {board.receivables && (
              <div className="ob-money-row in">
                <div>
                  <b className="mono">{formatMoney(board.receivables.awaitingPayout)}</b>
                  <em>waiting on Whatnot</em>
                </div>
                <span className="ob-money-note">
                  {board.receivables.lastPayoutAt
                    ? `Last payout ${formatMoney(board.receivables.lastPayoutAmount)} on ${board.receivables.lastPayoutAt.slice(0, 10)}`
                    : 'No payout recorded yet'}
                </span>
              </div>
            )}

            {board.payables && (
              <>
                <div className="ob-money-row out">
                  <div>
                    <b className="mono">{formatMoney(board.payables.total)}</b>
                    <em>
                      {board.payables.count} purchase order
                      {board.payables.count === 1 ? '' : 's'} to pay
                    </em>
                  </div>
                </div>
                {board.payables.items.length > 0 ? (
                  <ul className="ob-mini">
                    {board.payables.items.map((p) => (
                      <li key={p.id}>
                        <span className="ob-mini-name">
                          {p.poNumber}
                          {p.supplier ? ` · ${p.supplier}` : ''}
                        </span>
                        <span className={`ob-mini-qty ${p.ageDays >= 14 ? 'old' : ''}`}>
                          {p.ageDays}d
                        </span>
                        <span className="ob-mini-val mono">{formatMoney(p.total)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="ob-empty">Nothing waiting to be paid.</p>
                )}
              </>
            )}
          </div>
        )}

        {board.inventory && (
          <div className="ob-card">
            <header onClick={() => navigate('inventory')}>
              <Icon name="Boxes" size={16} />
              <h3>Inventory</h3>
              <span className="ob-open">
                Open <Icon name="ArrowRight" size={13} />
              </span>
            </header>
            <div className="ob-stats">
              <Stat value={formatMoney(board.inventory.stockValue)} label="at cost" wide />
              <Stat value={String(board.inventory.productCount)} label="products" />
              <Stat value={String(board.inventory.incomingCount)} label="incoming" />
            </div>
            <div className="ob-flags">
              <Flag
                n={board.inventory.lowStockCount}
                label="products low"
                tone={board.inventory.lowStockCount > 0 ? 'warn' : 'ok'}
              />
              <Flag
                n={board.inventory.supplyLowCount}
                label="supplies low"
                tone={board.inventory.supplyLowCount > 0 ? 'warn' : 'ok'}
              />
              {/* Below zero is not "low" — it is a count that is wrong. The
                  shipping checklist that used to deduct past empty is gone, and
                  every remaining hand-driven path refuses to cross zero
                  (`useSupply` and `adjustSupply` both reject the movement). What
                  can still land here is the sync rebuild:
                  `rebuildDerivedSupplyStock` recovers the count as the SUM of
                  every movement row and writes it with no floor, so two machines
                  each consuming a legal amount offline — or a legacy `ship_use`
                  row from the removed checklist still sitting in the table — can
                  settle below zero once they merge. That is a real disagreement
                  between the books and the shelf, so it earns the loud colour. */}
              <Flag
                n={board.inventory.supplyNegativeCount}
                label="below zero"
                tone={board.inventory.supplyNegativeCount > 0 ? 'danger' : 'ok'}
              />
            </div>
          </div>
        )}

        {board.schedule && (
          <div className="ob-card">
            <header onClick={() => navigate('streaming')}>
              <Icon name="CalendarDays" size={16} />
              <h3>Shows</h3>
              <span className="ob-open">
                Open <Icon name="ArrowRight" size={13} />
              </span>
            </header>
            {board.schedule.length > 0 ? (
              <ul className="ob-shows">
                {board.schedule.map((s) => (
                  <li key={s.id} data-live={s.live ? 'true' : 'false'}>
                    <span className="ob-show-when">
                      {s.streamDate}
                      <em>
                        {new Date(s.startedAt).toLocaleTimeString([], {
                          hour: 'numeric',
                          minute: '2-digit'
                        })}
                      </em>
                    </span>
                    <span className="ob-show-title">{s.title || 'Untitled show'}</span>
                    {s.live && <span className="ob-live">LIVE</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ob-empty">Nothing scheduled.</p>
            )}
          </div>
        )}

        <TodayCard board={board} reminders={reminders} onChanged={load} canInbox={canInbox} />
      </div>
    </div>
  )
}

/**
 * The owner's own checklist, full width beneath the two rows of tiles.
 *
 * Its own component with its own fetch, deliberately: it is the one card on this
 * page that is not a view of something else, so it has nothing to gain from the
 * board's single round trip and everything to lose from being coupled to it —
 * ticking a box must not re-read the whole business.
 *
 * Everybody gets one. There is no permission on it because there is nothing to
 * gate: it is your list, scoped to you by the handler, and a packer keeping
 * three lines on it costs nobody anything.
 */
function TodayCard({
  board,
  reminders,
  onChanged,
  canInbox
}: {
  board: Board
  reminders: Reminder[]
  onChanged: () => Promise<void>
  canInbox: boolean
}): JSX.Element {
  const toast = useToast()
  const [items, setItems] = useState<Todo[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  /** The row with a call in flight. A second click on the same X used to reach
   *  a row that was already gone and raise "that task is no longer on your
   *  list" — an error toast for an action that worked. */
  const [pending, setPending] = useState<string | null>(null)

  const load = useCallback(async () => {
    setItems(await api.owner.todos())
  }, [])

  useLiveRefresh(LIVE.notes, load)

  useEffect(() => {
    void load()
  }, [load])

  const add = async (): Promise<void> => {
    const body = draft.trim()
    if (!body || busy) return
    setBusy(true)
    try {
      const res = await api.owner.addTodo(body)
      if (!res.ok) {
        toast.error(res.error ?? 'Could not add that.')
        return
      }
      setDraft('')
      await load()
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (todo: Todo): Promise<void> => {
    if (pending) return
    setPending(todo.id)
    try {
      const res = await api.owner.setTodoDone(todo.id, !todo.done)
      if (!res.ok) toast.error(res.error ?? 'That did not save.')
      await load()
    } finally {
      setPending(null)
    }
  }

  const remove = async (todo: Todo): Promise<void> => {
    if (pending) return
    setPending(todo.id)
    try {
      const res = await api.owner.deleteTodo(todo.id)
      if (!res.ok) toast.error(res.error ?? 'Could not remove that.')
      await load()
    } finally {
      setPending(null)
    }
  }

  const clearDone = async (): Promise<void> => {
    const res = await api.owner.clearDoneTodos()
    if (!res.ok) toast.error(res.error ?? 'Could not clear those.')
    await load()
  }

  const derived = board.tasks.slips
  const due = board.tasks.recurring
  const openReminders = reminders.filter((r) => r.status === 'open').length
  const openCount = items.filter((t) => !t.done).length + derived.length + due.length + openReminders

  const tickRecurring = async (id: string, occurrence: string): Promise<void> => {
    if (pending) return
    setPending(id)
    try {
      const res = await api.owner.completeRecurring(id, occurrence)
      // A second tick — from another machine, or a double click — finds the
      // occurrence already recorded and reports nothing changed. That is the
      // job being done, not a failure, and an error toast for it is a lie.
      if (!res.ok && !/no longer on your list/i.test(res.error ?? '')) {
        toast.error(res.error ?? 'That did not save.')
      }
      await onChanged()
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="ob-card ob-span">
      <header>
        <Icon name="ListChecks" size={16} />
        <h3>Today</h3>
        <span className="ob-sub">
          {openCount === 0 ? 'Nothing outstanding' : `${openCount} to do`}
        </span>
        {items.some((t) => t.done) && (
          <button className="ob-todo-clear" onClick={() => void clearDone()}>
            Clear ticked
          </button>
        )}
      </header>

      <div className="ob-todo-add">
        <input
          value={draft}
          maxLength={TODO_MAX_LENGTH}
          placeholder="Payroll, upload packing slips, call the supplier…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add()
          }}
        />
        <Button size="sm" icon="Plus" loading={busy} disabled={!draft.trim()} onClick={() => void add()}>
          Add
        </Button>
      </div>

      {/* WHAT THE APP WORKED OUT, above what anybody typed.
          A stream with no packing slip against it, and a job whose clock has
          come round, are both things somebody has to do that nobody remembered
          to write down — which makes them the most likely things on the page to
          be missed. The slip rows carry no tick: they clear themselves the
          moment the import lands, so a tick would be a lie. */}
      {(derived.length > 0 || due.length > 0) && (
        <ul className="ob-rem ob-auto">
          {due.map((d) => (
            <li key={d.id} data-late={d.daysLate > 0 ? 'true' : 'false'}>
              <button
                className="ob-rem-tick"
                disabled={pending === d.id}
                title={`Mark ${d.dueOn} done`}
                onClick={() => void tickRecurring(d.id, d.dueOn)}
              >
                <Icon name="Circle" size={16} />
              </button>
              <span className="ob-rem-body">
                <span className="ob-rem-text">{d.title}</span>
                <span className="ob-rem-meta">
                  {recurringLabel(d)} · {d.dueOn}
                </span>
              </span>
            </li>
          ))}
          {derived.map((t) => (
            <li key={t.id}>
              {/* A MARK, not a tick. These rows clear themselves when the
                  import lands, so a tick would be a lie — and the shared class
                  made it look like one, cursor and hover included. */}
              <span className="ob-rem-mark" aria-hidden="true">
                <Icon name="AlertTriangle" size={15} />
              </span>
              <span className="ob-rem-body">
                <span className="ob-rem-text">{t.title}</span>
                <span className="ob-rem-meta">{t.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {items.length > 0 ? (
        <ul className="ob-rem">
          {items.map((t) => (
            <li key={t.id} data-done={t.done ? 'true' : 'false'}>
              <button
                className="ob-rem-tick"
                disabled={pending === t.id}
                title={t.done ? 'Put it back on the list' : 'Tick it off'}
                onClick={() => void toggle(t)}
              >
                <Icon name={t.done ? 'CheckCircle2' : 'Circle'} size={16} />
              </button>
              <span className="ob-rem-body">
                <span className="ob-rem-text">{t.body}</span>
              </span>
              <button
                className="ob-rem-tick"
                disabled={pending === t.id}
                title="Remove"
                onClick={() => void remove(t)}
              >
                <Icon name="X" size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : derived.length === 0 && due.length === 0 ? (
        <p className="ob-empty">Nothing on the list. Add the first thing above.</p>
      ) : null}

      {/* The inbox, in the same module rather than a card of its own. It is the
          same question — what do I have to deal with — asked by somebody else. */}
      {canInbox && reminders.length > 0 && (
        <>
          <div className="ob-todo-split">From the floor</div>
          <Inbox reminders={reminders} onChanged={onChanged} bare />
        </>
      )}

      <div className="ob-todo-split">Send a reminder to the owner</div>
      <SendReminder bare />
    </div>
  )
}

function PnlCard({
  title,
  sub,
  icon,
  windows,
  footer,
  onOpen,
  children
}: {
  title: string
  sub: string
  icon: string
  windows: OwnerPnlWindow[]
  footer: string
  onOpen: () => void
  children?: React.ReactNode
}): JSX.Element {
  const head = windows[0]
  return (
    <div className="ob-card">
      <header onClick={onOpen}>
        <Icon name={icon} size={16} />
        <h3>{title}</h3>
        <span className="ob-sub">{sub}</span>
        <span className="ob-open">
          Open <Icon name="ArrowRight" size={13} />
        </span>
      </header>
      <div className="ob-pnl">
        {windows.map((w) => (
          <div className="ob-pnl-col" key={w.label} data-lead={w === head ? 'true' : 'false'}>
            <span className={`ob-pnl-net mono ${w.netProfit < 0 ? 'neg' : ''}`}>
              {formatMoney(w.netProfit)}
            </span>
            <em>{w.label}</em>
            <span className="ob-pnl-rev">
              {formatMoney(w.revenue)} in
              {w.activeDays > 0 && ` · ${w.activeDays}d`}
            </span>
          </div>
        ))}
      </div>
      {children}
      <p className="ob-foot">{footer}</p>
    </div>
  )
}

/**
 * The owner's inbox.
 *
 * Sending is not here — anyone can send, from anywhere, so the compose box
 * lives on the ordinary home page where the floor will see it. This half is the
 * reading half: what is waiting, oldest first so nothing falls off the bottom.
 */
function Inbox({
  reminders,
  onChanged,
  bare
}: {
  reminders: Reminder[]
  onChanged: () => Promise<void>
  /** Inside the merged Today module: the list only, no card and no header. */
  bare?: boolean
}): JSX.Element {
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const open = reminders.filter((r) => r.status === 'open')

  const set = async (id: string, status: 'open' | 'done'): Promise<void> => {
    setBusy(id)
    try {
      const res = await api.owner.setReminderStatus(id, status)
      if (!res.ok) {
        toast.error(res.error ?? 'Could not update that.')
        return
      }
      await onChanged()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={bare ? '' : 'ob-card ob-inbox'}>
      {!bare && (
        <header>
          <Icon name="Inbox" size={16} />
          <h3>Reminders</h3>
          <span className="ob-sub">
            {open.length === 0 ? 'all clear' : `${open.length} open`}
          </span>
        </header>
      )}
      {reminders.length === 0 ? (
        <p className="ob-empty">Nothing from the floor.</p>
      ) : (
        <ul className={bare ? 'ob-rem ob-rem-scroll' : 'ob-rem'}>
          {reminders.map((r) => (
            <li key={r.id} data-done={r.status === 'done' ? 'true' : 'false'}>
              <button
                className="ob-rem-tick"
                disabled={busy === r.id}
                onClick={() => void set(r.id, r.status === 'done' ? 'open' : 'done')}
                title={r.status === 'done' ? 'Put it back' : 'Done with it'}
              >
                <Icon name={r.status === 'done' ? 'CheckSquare' : 'Square'} size={16} />
              </button>
              <div className="ob-rem-body">
                <span className="ob-rem-text">
                  {r.urgent && r.status === 'open' && <b className="ob-urgent">!</b>}
                  {r.body}
                </span>
                <span className="ob-rem-meta">
                  {r.fromName ?? 'Someone'} · {new Date(r.createdAt).toLocaleDateString()}
                  {r.dueDate ? ` · for ${r.dueDate}` : ''}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * The compose half, for everybody.
 *
 * Deliberately on the ordinary home page rather than behind the owner's board:
 * the failure mode of a staff-to-owner inbox is silence, and a box the floor
 * cannot see is a box nobody writes into.
 */
export function SendReminder({ bare }: { bare?: boolean } = {}): JSX.Element {
  const toast = useToast()
  const [body, setBody] = useState('')
  const [urgent, setUrgent] = useState(false)
  const [sending, setSending] = useState(false)

  const send = async (): Promise<void> => {
    const text = body.trim()
    if (!text) return
    setSending(true)
    try {
      const res = await api.owner.sendReminder({ body: text, urgent })
      if (!res.ok) {
        toast.error(res.error ?? 'Could not send that.')
        return
      }
      setBody('')
      setUrgent(false)
      toast.success('Sent.')
    } finally {
      setSending(false)
    }
  }

  const left = REMINDER_MAX_LENGTH - body.length

  return (
    <div className={bare ? 'ob-compose-wrap' : 'panel-card'}>
      {!bare && (
        <div className="panel-head">
          <h3>Send a reminder</h3>
          <span className="ph-sub">Goes to the owner</span>
        </div>
      )}
      <textarea
        className="input ob-compose"
        rows={2}
        maxLength={REMINDER_MAX_LENGTH}
        placeholder="Something that needs doing, or something worth knowing…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends; Shift+Enter is a newline. A reminder is one line of
          // text, so the common case should not need the mouse.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void send()
          }
        }}
      />
      <div className="ob-compose-row">
        <label className="ob-urgent-check">
          <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />
          Urgent
        </label>
        {left < 100 && <span className="ob-compose-left">{left}</span>}
        <Button
          variant="primary"
          size="sm"
          icon="Send"
          disabled={!body.trim() || sending}
          onClick={() => void send()}
        >
          Send
        </Button>
      </div>
    </div>
  )
}

function Stat({ value, label, wide }: { value: string; label: string; wide?: boolean }): JSX.Element {
  return (
    <span className={`ob-stat ${wide ? 'wide' : ''}`}>
      <b className="mono">{value}</b>
      <em>{label}</em>
    </span>
  )
}

function Flag({ n, label, tone }: { n: number; label: string; tone: string }): JSX.Element {
  return (
    <span className="ob-flag" data-tone={tone}>
      <b>{n}</b>
      {label}
    </span>
  )
}
