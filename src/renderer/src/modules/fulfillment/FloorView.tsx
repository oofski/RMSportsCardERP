import { useCallback, useEffect, useState } from 'react'
import type { ShipStationBoard, ShipStationOrder, ShipStationRole } from '@shared/shipStations'
import { CLAIM_BEAT_MS } from '@shared/shipStations'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { Button, CenterLoader } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { SlipPane } from './SlipPane'
import type { ShipTabProps } from './ShippingModule'

/**
 * The bench.
 *
 * Step 5 of the SOP is one sentence — "one person gathers the team bags for
 * each order, the shipper checks the break and username line up, then one
 * bubble mailer, double wrapped in a second, with the matching label" — and
 * this screen is that sentence, split in two.
 *
 * Everything here is deliberately narrow. A picker sees ONE order at a time
 * with the customer's own slip beside it. A packer sees only what has been
 * handed to them, and a count of what is behind it — never the night's list,
 * because the whole complaint was people being confused about which orders
 * were theirs.
 *
 * Three screens, in the order somebody arriving at a bench meets them:
 * who is standing here → picking or packing → the work.
 *
 * ## In from step 5, out again when the picking is done
 *
 * This is not a place anybody browses to. You arrive from the checklist's fifth
 * step, and the step is finished when the last order has been picked — so the
 * picker who finishes it is told, and taken back to the checklist, without ever
 * having to decide that the night is over. Everyone else's screen is left alone;
 * a packer mid-box does not get yanked anywhere.
 *
 * Every other screen here still carries a plain way back, because leaving early
 * is normal and being trapped on a bench is not.
 */
export function FloorView({ canFind, canPack, onGoTo, onChanged }: ShipTabProps): JSX.Element {
  const toast = useToast()
  const [board, setBoard] = useState<ShipStationBoard | null>(null)
  const [roster, setRoster] = useState<Array<{ id: string; name: string }>>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [who, setWho] = useState<string | null>(null)
  const [sendingBack, setSendingBack] = useState(false)
  const [reason, setReason] = useState('')

  const load = useCallback(async () => {
    const [b, r] = await Promise.all([api.shipping.stationBoard(), api.shipping.stationRoster()])
    setBoard(b)
    setRoster(r)
  }, [])

  useLiveRefresh(LIVE.shipping, load)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        await load()
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [load])

  // Keep this station's claims alive while somebody is genuinely here. Local
  // and cheap — no network — so it costs nothing to run all evening.
  useEffect(() => {
    if (!board?.session) return
    const t = window.setInterval(() => void api.shipping.stationHeartbeat(), CLAIM_BEAT_MS)
    return () => window.clearInterval(t)
  }, [board?.session])

  if (loading) return <CenterLoader />

  const session = board?.session ?? null

  // ---- Screen 1: who is standing at this bench ----------------------------
  if (!session) {
    return (
      <div className="floor floor-gate">
        <h2>Who is at this bench?</h2>
        <p className="floor-lead">
          Everyone on the clock right now. Your name goes on the cards you find and the boxes you
          pack — the computer's does not.
        </p>
        {roster.length === 0 ? (
          <div className="floor-empty">
            <Icon name="Clock" size={26} />
            <div>
              <b>Nobody is clocked in.</b>
              <span>Punch in first — that is what puts you on this list.</span>
            </div>
          </div>
        ) : (
          <div className="floor-people">
            {roster.map((p) => (
              <button
                key={p.id}
                className={`floor-person ${who === p.id ? 'on' : ''}`}
                onClick={() => setWho(p.id)}
              >
                <Icon name="User" size={20} />
                {p.name}
              </button>
            ))}
          </div>
        )}

        <button className="floor-back" onClick={() => onGoTo('sop')}>
          <Icon name="ArrowLeft" size={14} />
          Back to Steps
        </button>

        {who && (
          <>
            <h3 className="floor-ask">What are you doing?</h3>
            <div className="floor-jobs">
              <JobButton
                icon="ListChecks"
                title="Picking"
                detail="Work through the orders, gathering each customer's team bags."
                count={board?.toPick ?? 0}
                countLabel="orders to pick"
                disabled={!canFind || busy}
                onClick={() => void start(who, 'pick')}
              />
              <JobButton
                icon="PackageCheck"
                title="Packing"
                detail="Mailer and label, one order at a time, from the queue."
                count={board?.packQueue ?? 0}
                countLabel="waiting to pack"
                disabled={!canPack || busy}
                onClick={() => void start(who, 'pack')}
              />
            </div>
            {!canFind && !canPack && (
              <p className="floor-note">This account cannot work either job. Ask a lead.</p>
            )}
          </>
        )}
      </div>
    )
  }

  // ---- Screens 2 and 3: the work ------------------------------------------
  const current = board?.current ?? null

  return (
    <div className="floor">
      <header className="floor-bar">
        <span className="floor-who">
          <Icon name="User" size={15} />
          <b>{session.operatorName ?? 'Someone'}</b>
          <em>{session.role === 'pick' ? 'picking' : 'packing'}</em>
        </span>
        <span className="floor-counts">
          {session.role === 'pick' ? (
            <>
              <b>{board?.toPick ?? 0}</b> to pick
              {(board?.packQueue ?? 0) > 0 && (
                <span className="floor-behind">· {board?.packQueue} waiting to pack</span>
              )}
            </>
          ) : (
            <>
              <b>{board?.packQueue ?? 0}</b> waiting
            </>
          )}
        </span>
        <Button size="sm" variant="ghost" icon="RotateCcw" disabled={busy} onClick={() => void switchJob()}>
          Switch job
        </Button>
        {/* The way out. Step 5 closes itself when the picking does, so this is
            not "I am finished" — it is "I am not standing here any more", which
            people need at half past nine as much as at the end. */}
        <Button size="sm" variant="ghost" icon="ListTodo" onClick={() => onGoTo('sop')}>
          Steps
        </Button>
      </header>

      {/* Somebody piling up work with nobody at the mailing bench. Passive on
          purpose — a picker working alone on a weeknight is normal, and this
          must not read as an error. */}
      {session.role === 'pick' && (board?.packQueue ?? 0) >= 10 && (
        <div className="floor-strip">
          <Icon name="Info" size={15} />
          {board?.packQueue} orders are waiting and nobody is packing.
        </div>
      )}

      {current ? (
        <OrderPane
          order={current}
          role={session.role}
          busy={busy}
          sendingBack={sendingBack}
          reason={reason}
          onReason={setReason}
          onStartSendBack={() => setSendingBack(true)}
          onCancelSendBack={() => {
            setSendingBack(false)
            setReason('')
          }}
          onSendBack={() => void doSendBack(current)}
          onAdvance={() => void advance(current)}
        />
      ) : (
        <Idle
          role={session.role}
          board={board}
          onTake={() => void take()}
          onBack={() => onGoTo('sop')}
          busy={busy}
        />
      )}
    </div>
  )

  async function start(operatorId: string, role: ShipStationRole): Promise<void> {
    setBusy(true)
    try {
      const res = await api.shipping.stationStart(operatorId, role)
      if (!res.ok) {
        toast.error(res.error ?? 'Could not start.')
        return
      }
      await load()
      await take()
    } finally {
      setBusy(false)
    }
  }

  async function switchJob(): Promise<void> {
    setBusy(true)
    try {
      // Ending the session releases whatever this bench is holding. A silent
      // switch would strand the order: nobody else could take it, and the
      // person who had it is now looking at a different queue.
      await api.shipping.stationEnd()
      setWho(null)
      await load()
      await onChanged()
    } finally {
      setBusy(false)
    }
  }

  async function take(): Promise<void> {
    const b = await api.shipping.stationBoard()
    if (!b?.session) return
    const res =
      b.session.role === 'pack'
        ? await api.shipping.stationPackNext()
        : await api.shipping.stationPickNext()
    if (!res.ok) toast.error(res.error ?? 'Could not take the next one.')
    await load()
  }

  async function advance(order: ShipStationOrder): Promise<void> {
    setBusy(true)
    try {
      if (session?.role === 'pack') {
        const res = await api.shipping.stationPackDone(order.customerId)
        if (!res.ok) {
          toast.error(res.error ?? 'Could not close that one.')
          return
        }
        await api.shipping.stationPackNext()
      } else {
        const res = await api.shipping.stationPickAdvance(order.customerId)
        if (!res.ok) {
          toast.error(res.error ?? 'Could not move on.')
          return
        }
        // That was the last one, and this click is what closed step 5 — the
        // main process says so for exactly ONE caller, so nobody else's screen
        // moves and nothing is deducted twice. Refresh before leaving, or the
        // checklist arrives showing the state from before the tick.
        if (res.data?.sopShipCompleted) {
          const waiting = res.data.queueDepth
          toast.success(
            waiting > 0
              ? `Every order is picked — shipping is ticked off. ${waiting} ${waiting === 1 ? 'box is' : 'boxes are'} still to pack.`
              : 'Every order is picked — shipping is ticked off.'
          )
          await load()
          await onChanged()
          onGoTo('sop')
          return
        }
      }
      await load()
      await onChanged()
    } finally {
      setBusy(false)
    }
  }

  async function doSendBack(order: ShipStationOrder): Promise<void> {
    const text = reason.trim()
    if (!text) return
    setBusy(true)
    try {
      const res = await api.shipping.stationSendBack(order.customerId, text)
      if (!res.ok) {
        toast.error(res.error ?? 'Could not send it back.')
        return
      }
      setSendingBack(false)
      setReason('')
      toast.success('Sent back to picking.')
      await api.shipping.stationPackNext()
      await load()
      await onChanged()
    } finally {
      setBusy(false)
    }
  }
}

function JobButton({
  icon,
  title,
  detail,
  count,
  countLabel,
  disabled,
  onClick
}: {
  icon: string
  title: string
  detail: string
  count: number
  countLabel: string
  disabled: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button className="floor-job" disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={30} />
      <b>{title}</b>
      <span className="floor-job-detail">{detail}</span>
      <span className="floor-job-count">
        <b>{count}</b> {countLabel}
      </span>
    </button>
  )
}

/**
 * Nothing in hand.
 *
 * For a packer this is the important one: an empty queue mid-show is NORMAL —
 * the pickers are still walking the boxes — and it must not read as "the night
 * is over". So it says what is still upstream rather than congratulating
 * anybody.
 */
function Idle({
  role,
  board,
  onTake,
  onBack,
  busy
}: {
  role: ShipStationRole
  board: ShipStationBoard | null
  onTake: () => void
  onBack: () => void
  busy: boolean
}): JSX.Element {
  const done = board?.allDone === true
  const queue = board?.packQueue ?? 0
  if (done) {
    return (
      <div className="floor-empty big">
        <Icon name="CheckCheck" size={34} />
        <div>
          <b>Every order is picked and packed.</b>
          <span>Scanning and Confirm are still to tick on the checklist.</span>
        </div>
        <Button variant="primary" icon="ListTodo" onClick={onBack}>
          Back to Steps
        </Button>
      </div>
    )
  }
  return (
    <div className="floor-empty big">
      <Icon name={role === 'pack' ? 'PackageOpen' : 'ListChecks'} size={34} />
      <div>
        <b>{role === 'pack' ? 'Nothing waiting.' : 'Nothing to pick right now.'}</b>
        <span>
          {role === 'pack'
            ? `The pickers are still going — ${board?.toPick ?? 0} orders left to pick.`
            : // Nothing to PICK is not an empty bench. Step 5 follows the
              // picking, so it can be ticked off with boxes still stacked at the
              // mailing end, and a screen that stopped at "you are done" would be
              // the one thing telling anybody the room was clear.
              queue > 0
              ? `Every order is either picked or in somebody else’s hands — ${queue} ${queue === 1 ? 'is' : 'are'} still waiting to be packed.`
              : 'Every order is either picked or in somebody else’s hands.'}
        </span>
      </div>
      <div className="floor-idle-actions">
        <Button variant="primary" icon="RefreshCw" disabled={busy} onClick={onTake}>
          Check again
        </Button>
        <Button variant="ghost" icon="ListTodo" onClick={onBack}>
          Back to Steps
        </Button>
      </div>
    </div>
  )
}

function OrderPane({
  order,
  role,
  busy,
  sendingBack,
  reason,
  onReason,
  onStartSendBack,
  onCancelSendBack,
  onSendBack,
  onAdvance
}: {
  order: ShipStationOrder
  role: ShipStationRole
  busy: boolean
  sendingBack: boolean
  reason: string
  onReason: (v: string) => void
  onStartSendBack: () => void
  onCancelSendBack: () => void
  onSendBack: () => void
  onAdvance: () => void
}): JSX.Element {
  return (
    <div className="floor-work">
      <div className="floor-order">
        <div className="floor-order-head">
          <span className="floor-handle">@{order.handle}</span>
          {order.realName && <span className="floor-name">{order.realName}</span>}
          <span className="floor-cards">
            {order.cardsChecked}/{order.cardsTotal} cards
          </span>
        </div>

        {/* A rejected order carries its reason into the picking run, so whoever
            takes it next knows BEFORE they start rather than after. */}
        {order.sentBackReason && (
          <div className="floor-sentback">
            <Icon name="Undo2" size={15} />
            <span>
              <b>Sent back:</b> {order.sentBackReason}
            </span>
          </div>
        )}

        {sendingBack ? (
          <div className="floor-back-form">
            <label>What is wrong with it?</label>
            <div className="floor-back-presets">
              {['Missing a card', 'Wrong card', 'Damaged'].map((p) => (
                <button key={p} className="floor-preset" onClick={() => onReason(p)}>
                  {p}
                </button>
              ))}
            </div>
            <input
              className="input"
              value={reason}
              autoFocus
              placeholder="Say what the picker needs to fix"
              onChange={(e) => onReason(e.target.value)}
            />
            <div className="floor-back-actions">
              <Button variant="ghost" onClick={onCancelSendBack}>
                Cancel
              </Button>
              <Button variant="danger" icon="Undo2" disabled={!reason.trim() || busy} onClick={onSendBack}>
                Send back to picking
              </Button>
            </div>
          </div>
        ) : (
          <div className="floor-actions">
            <Button
              variant="primary"
              icon={role === 'pack' ? 'PackageCheck' : 'ArrowRight'}
              disabled={busy}
              onClick={onAdvance}
            >
              {role === 'pack' ? 'Packed · next' : 'Picked · next order'}
            </Button>
            {role === 'pack' && (
              <Button variant="ghost" icon="Undo2" disabled={busy} onClick={onStartSendBack}>
                Send back
              </Button>
            )}
          </div>
        )}
      </div>

      {/* The customer's own slip. A picker who cannot see the paper cannot do
          the job the paper is for. */}
      <div className="floor-slip">
        <SlipPane pages={order.pages} label={`@${order.handle}`} />
      </div>
    </div>
  )
}
