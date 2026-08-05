import { useCallback, useEffect, useState } from 'react'
import type { OwnerBoard as Board, OwnerPnlWindow, Reminder } from '@shared/ownerDashboard'
import { REMINDER_MAX_LENGTH } from '@shared/ownerDashboard'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { useChrome } from '../../lib/chrome'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { Icon } from '../../components/Icon'
import { Button } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { formatMoney } from '../../lib/format'

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

  useLiveRefresh(LIVE.inventory, load)
  useLiveRefresh(LIVE.shipping, load)

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
  // Somebody with no finance, no invoicing, no inventory and no streaming has
  // nothing to put here — the ordinary home page is a better screen for them
  // than a grid of empty boxes.
  const anything =
    board.whatnot || board.payables || board.inventory || board.schedule || canInbox
  if (!anything) return null

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

      <div className="ob-grid">
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
            windows={[board.wholesale.week, board.wholesale.month]}
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

        {canInbox && <Inbox reminders={reminders} onChanged={load} />}
      </div>
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
  onChanged
}: {
  reminders: Reminder[]
  onChanged: () => Promise<void>
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
    <div className="ob-card ob-inbox">
      <header>
        <Icon name="Inbox" size={16} />
        <h3>Reminders</h3>
        <span className="ob-sub">
          {open.length === 0 ? 'all clear' : `${open.length} open`}
        </span>
      </header>
      {reminders.length === 0 ? (
        <p className="ob-empty">Nothing from the floor.</p>
      ) : (
        <ul className="ob-rem">
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
export function SendReminder(): JSX.Element {
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
    <div className="panel-card">
      <div className="panel-head">
        <h3>Send a reminder</h3>
        <span className="ph-sub">Goes to the owner</span>
      </div>
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
