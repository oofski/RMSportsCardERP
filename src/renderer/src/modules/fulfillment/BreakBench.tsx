import { useCallback, useEffect, useState } from 'react'
import type { BreakBagRow, BreakBenchDetail, BreakStepId } from '@shared/breakSteps'
import {
  BREAK_STEPS,
  SHIP_STEPS,
  blockedReason,
  breakProgress,
  canStartStep,
  currentStep,
  isBreakReady,
  isStamped,
  isStepDone
} from '@shared/breakSteps'
import { api } from '../../lib/api'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { CenterLoader } from '../../components/ui'
import { formatDateTime } from '../../lib/format'

/**
 * The bench checklist for ONE break.
 *
 * Three steps in order — sleeve and top-load, sort into trays, then team-bag
 * every team against its buyer — and nothing about this break ships until all
 * three are done. See @shared/breakSteps for why the first two are a single
 * tick each and the third is thirty.
 *
 * ## The list is the sticker stack
 *
 * Step 3's rows are in the order the paperwork prints them, because somebody is
 * working down a physical stack of stickers while looking at this. Re-sorting
 * it alphabetically would be tidier on screen and wrong in the hand.
 *
 * ## What the row says, and why
 *
 * The TEAM and the HANDLE, at the same size. The whole job is matching one to
 * the other, so making either secondary makes the match harder — and a mismatch
 * here puts a stranger's card in somebody's mailer.
 *
 * ## Refusals come from the main process
 *
 * The gates are enforced server-side, so a tick that should not be possible
 * comes back as an error rather than being silently swallowed. The UI greys the
 * locked step as well, but that is the courtesy, not the rule — a stale tab or a
 * second laptop would sail straight past a check that only lived here.
 */
export function BreakBench({
  breakId,
  canAct,
  onChanged
}: {
  breakId: string
  canAct: boolean
  /** Fired after any tick so the surrounding board can re-derive its counts. */
  onChanged: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [detail, setDetail] = useState<BreakBenchDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    const d = await api.shipping.bench(breakId)
    setDetail(d)
    setLoading(false)
  }, [breakId])

  useEffect(() => {
    void load()
  }, [load])

  const toggleStep = async (step: BreakStepId, done: boolean): Promise<void> => {
    if (step === 'bag' || busy) return
    setBusy(step)
    try {
      const res = await api.shipping.setBenchStep(breakId, step, done)
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Could not update that step.')
        return
      }
      setDetail(res.data)
      await onChanged()
    } finally {
      setBusy(null)
    }
  }

  const toggleTeam = async (row: BreakBagRow): Promise<void> => {
    if (busy) return
    setBusy(row.teamName)
    try {
      const res = await api.shipping.setTeamBagged(breakId, row.teamName, !row.bagged)
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Could not update that team.')
        return
      }
      setDetail(res.data)
      await onChanged()
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <CenterLoader />
  if (!detail) {
    return <div className="bench-empty">That break is no longer in this dataset.</div>
  }

  const { state, rows } = detail
  const ready = isBreakReady(state)
  const active = currentStep(state)
  const pct = Math.round(breakProgress(state) * 100)

  return (
    <div className="bench">
      <div className="bench-head">
        <div className="bench-head-text">
          <span className="bench-title">On the bench</span>
          <span className="bench-sub">
            {/* When this break is done but the floor is not, the old wording —
                "can be packed from" — was a claim the gate would then refuse.
                The gate's own sentence is the accurate one. */}
            {ready ? detail.shipGate.reason : `${state.baggedTeams} of ${state.totalTeams} teams bagged`}
          </span>
        </div>
        <div className={`bench-bar ${ready ? 'done' : ''}`} title={`${pct}%`}>
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>

      {/* ---- Steps 1 and 2: one tick each ---------------------------------- */}
      <ol className="bench-steps">
        {BREAK_STEPS.filter((s) => !s.perTeam).map((s) => {
          const done = isStepDone(s.id, state)
          const locked = !done && !canStartStep(s.id, state)
          const stamp = s.id === 'sleeve' ? state.sleeve : state.sort
          return (
            <li
              key={s.id}
              className={`bench-step ${done ? 'done' : ''} ${locked ? 'locked' : ''} ${
                active === s.id ? 'active' : ''
              }`}
            >
              <button
                type="button"
                className="bench-tick"
                disabled={!canAct || locked || busy === s.id}
                title={
                  locked
                    ? (blockedReason(s.id, state) ?? '')
                    : done
                      ? 'Tick again to undo'
                      : 'Mark this step done'
                }
                onClick={() => void toggleStep(s.id, !done)}
              >
                <Icon
                  name={done ? 'CheckCircle2' : locked ? 'Lock' : 'Circle'}
                  size={22}
                  strokeWidth={done ? 2.5 : 2}
                />
              </button>
              <div className="bench-step-text">
                <span className="bench-step-label">
                  <b>{s.n}.</b> {s.label}
                </span>
                <span className="bench-step-detail">{s.detail}</span>
                {isStamped(stamp) && (
                  <span className="bench-step-stamp">Done {formatDateTime(stamp.at as string)}</span>
                )}
              </div>
            </li>
          )
        })}
      </ol>

      {/* ---- Step 3: thirty ticks, in slip order ---------------------------- */}
      <div className={`bench-bagging ${detail.bagBlockedReason ? 'locked' : ''}`}>
        <div className="bench-bag-head">
          <span className="bench-step-label">
            <b>3.</b> Sticker &amp; team-bag
          </span>
          <span className="bench-bag-count">
            {state.baggedTeams}/{state.totalTeams}
          </span>
        </div>

        {detail.bagBlockedReason ? (
          <div className="bench-blocked">
            <Icon name="Lock" size={14} />
            {detail.bagBlockedReason}
          </div>
        ) : (
          <p className="bench-bag-hint">
            Work down the sticker stack. Match each team to the buyer shown, bag it, sticker it,
            and put it in the break box.
          </p>
        )}

        <ul className="bench-teams">
          {rows.map((r) => (
            <li
              key={r.teamName}
              className={`bench-team ${r.bagged ? 'bagged' : ''} ${r.handle ? '' : 'unsold'}`}
            >
              <button
                type="button"
                className="bench-tick sm"
                disabled={!canAct || (!!detail.bagBlockedReason && !r.bagged) || busy === r.teamName}
                title={
                  detail.bagBlockedReason && !r.bagged
                    ? detail.bagBlockedReason
                    : r.bagged
                      ? 'Tick again to undo'
                      : 'Bagged and stickered'
                }
                onClick={() => void toggleTeam(r)}
              >
                <Icon
                  name={r.bagged ? 'CheckCircle2' : 'Circle'}
                  size={18}
                  strokeWidth={r.bagged ? 2.5 : 2}
                />
              </button>
              <span className="bench-team-name">{r.teamName}</span>
              {r.handle ? (
                <span className="bench-team-who" title={r.realName || undefined}>
                  @{r.handle}
                  {r.isGiveaway && <em className="bench-team-tag">giveaway</em>}
                </span>
              ) : (
                // Named rather than blank. "Nobody bought this, it goes to the
                // house" and "the slip did not read" need different actions, and
                // an empty space says neither.
                <span className="bench-team-who none">nobody bought this — to the house</span>
              )}
            </li>
          ))}
        </ul>
      </div>

      {/* ---- Steps 4 and 5: not this break's to tick ------------------------
          On the same numbered list because the checklist stopping at step 3
          made the bench look like the whole job — somebody finishing a break
          could not see what came next, or what was still holding it up. The
          gate itself was already enforced; it just refused them later, from
          another screen, with no way to have known.

          Never tickable here. Packing happens per PACKAGE at the pack station
          and scanning at the ship station; a checkbox on a break's page would
          be claiming one break can mark a package packed. */}
      <ol className="bench-steps bench-after" data-gate={detail.shipGate.status}>
        {SHIP_STEPS.map((s) => (
          <li key={s.id} className={`bench-step ${detail.shipGate.status === 'go' ? '' : 'locked'}`}>
            <span className="bench-tick static" aria-hidden="true">
              <Icon
                name={detail.shipGate.status === 'go' ? 'ArrowRight' : 'Lock'}
                size={22}
                strokeWidth={2}
              />
            </span>
            <div className="bench-step-text">
              <span className="bench-step-label">
                <b>{s.n}.</b> {s.label}
              </span>
              <span className="bench-step-detail">{s.detail}</span>
            </div>
          </li>
        ))}
        {/* Said once under both, not twice — it is one fact about the floor. */}
        <li className={`bench-gate ${detail.shipGate.status}`}>
          <Icon
            name={
              detail.shipGate.status === 'go'
                ? 'CheckCircle2'
                : detail.shipGate.status === 'waiting'
                  ? 'Clock'
                  : 'Lock'
            }
            size={14}
          />
          <span>{detail.shipGate.reason}</span>
        </li>
      </ol>
    </div>
  )
}
