import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ShipBreakSummary } from '@shared/shippingViews'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { Button, CenterLoader, EmptyState } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { formatMoney } from '../../lib/format'
import { BreakChip } from './BreakChip'
import type { ShipTabProps } from './ShippingModule'

/**
 * Today — the show-day board.
 *
 * Everyone lands here, so the first thing on it is the answer to the question
 * nine people in ten arrive with: *where do I start*. One button, always the
 * same button, going to the same place — the checklist, which then tells them
 * what is next. There is no decision in it, because there was never really a
 * decision to make: the seven steps run in order and the first one is the first
 * one.
 *
 * What USED to be here was "your breaks", built on somebody having handed the
 * show out first. Most nights nobody had, so the screen everybody landed on
 * opened with "Nothing assigned to you" — a dead end at the front door.
 *
 * Below the button, the board. The blocking numbers matter more than the totals:
 * a break with nobody on it is not a statistic, it is thirty cards nobody is
 * pulling, and every package that touches it cannot be closed. That is a lead's
 * screen and it stays exactly as it was.
 */
export function TodayTab({ summary, onGoTo }: ShipTabProps): JSX.Element {
  const [breaks, setBreaks] = useState<ShipBreakSummary[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setBreaks(await api.shipping.breaks())
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

  const unassigned = useMemo(() => breaks.filter((b) => b.assignees.length === 0), [breaks])
  /** Somebody has begun handing the show out — so a gap in it is a real gap. */
  const handoutStarted = useMemo(() => breaks.some((b) => b.assignees.length > 0), [breaks])
  const unfinished = useMemo(
    () => breaks.filter((b) => b.checkedTeams < b.totalTeams),
    [breaks]
  )

  // Every card in the show, breaks AND the break-less giveaways.
  //
  // These used to be summed over `breaks` alone, which cannot see a giveaway
  // that came with no break number — 29 of them on a real July import. The Find
  // badge counts every slot, so the badge said 29 cards were still out while
  // this board said everything was found, and there was no screen anywhere that
  // reconciled the two.
  const boardTotal = breaks.reduce((a, b) => a + b.totalTeams, 0)
  const boardFound = breaks.reduce((a, b) => a + b.checkedTeams, 0)
  const looseTotal = summary?.looseCards ?? 0
  const looseFound = summary?.looseChecked ?? 0
  const cardsTotal = boardTotal + looseTotal
  const found = boardFound + looseFound
  const cardsLeft = cardsTotal - found
  const looseLeft = looseTotal - looseFound
  // Nearly always true: a promo rider comes with no break number by nature. A
  // PAID card outside every break is the odd one, and the import flags it.
  const looseGiveawaysOnly = looseTotal > 0 && (summary?.looseGiveawayCards ?? 0) === looseTotal
  const stepsLeft = Math.max(0, (summary?.sopTotal ?? 0) - (summary?.sopDone ?? 0))
  // Supplies that leave the shelf have to book to a date, so a show with no day
  // cannot be ticked off at all — and that is a person's job to fix, not a
  // number that will come down on its own.
  const noShowDay = !(summary?.event?.date ?? '').trim()

  if (loading) return <CenterLoader />

  if (!summary?.hasDataset || breaks.length === 0) {
    return (
      // No button. Importing moved to Admin with the rest of running a show, and
      // a bench operator cannot do it — so this says what has not happened yet
      // and who does it, rather than offering a door that is locked.
      <EmptyState
        icon="CalendarDays"
        title="Tonight's show has not been imported yet"
        message="A lead loads the packing slips in Admin → Shipping, and this board fills itself in. Nothing to do at the bench until then."
      />
    )
  }

  return (
    <div className="today-page">
      {/* ---- The front door.

          One action, and it is the same one every night: go to the checklist and
          start at the top. Deliberately the largest thing on the screen — this is
          what almost everybody who opens this app came here to press, and making
          them read a board first to find it was the whole complaint. */}
      <section className="today-start">
        <div className="today-start-text">
          <h3>Start fulfillment</h3>
          <p>
            The seven steps, in order. Tick one off and the next one opens — nothing to
            choose, nothing to be assigned first.
          </p>
        </div>
        <Button
          className="today-start-btn"
          variant="primary"
          icon="PlayCircle"
          onClick={() => onGoTo('sop')}
        >
          Start fulfillment
        </Button>
      </section>

      {/*
        What is stopping the room.

        Amber means A PERSON HAS TO DO SOMETHING they would not otherwise know
        about. It does not mean "this number is above zero" — that is the trap
        this row fell into, and it lit three tiles amber on a perfectly healthy
        import: every break present, every giveaway normal, nobody assigned yet
        because the night had not started. Once the board cries wolf on a clean
        show, the one tile that matters stops being read.

        So: work left is busy, not alarming. The normal shape of a show is never
        amber. Only a flag nobody has looked at, a package somebody stopped, and
        a hand-out that was started and left half-done get the colour.
      */}
      <div className="today-blockers">
        <Blocker
          icon="Layers"
          value={cardsLeft}
          label={cardsLeft === 1 ? 'card still to find' : 'cards still to find'}
          tone={cardsLeft > 0 ? 'busy' : 'ok'}
          onClick={() => onGoTo('find')}
        />
        {looseLeft > 0 && (
          <Blocker
            icon="Gift"
            value={looseLeft}
            // A giveaway having no break number is what a giveaway IS. Calling
            // it "in no break" described the data model, not the job, and read
            // as though something had gone wrong with 29 cards.
            label={
              looseGiveawaysOnly
                ? looseLeft === 1
                  ? 'giveaway to find'
                  : 'giveaways to find'
                : looseLeft === 1
                  ? 'card outside any break'
                  : 'cards outside any break'
            }
            tone="busy"
            onClick={() => onGoTo('find')}
          />
        )}
        <Blocker
          icon="UserX"
          value={unassigned.length}
          // Nobody assigned to ANYTHING is a show that has not been handed out
          // yet — the state every import starts in, and not a fault. A hand-out
          // that covered some breaks and missed others is the real miss, and
          // that is the only version worth the colour.
          label={
            handoutStarted
              ? unassigned.length === 1
                ? 'break missed in the hand-out'
                : 'breaks missed in the hand-out'
              : unassigned.length === 1
                ? 'break not handed out yet'
                : 'breaks not handed out yet'
          }
          tone={handoutStarted && unassigned.length > 0 ? 'warn' : 'ok'}
          // Handing the show out is a lead's job and it happens in Admin, so
          // this reports rather than travels. A tile that goes nowhere is worse
          // than a tile that stays put and says who to ask.
          note="A lead hands the breaks out in Admin → Shipping."
        />
        <Blocker
          icon="Flag"
          value={summary.counts.warnings}
          label={summary.counts.warnings === 1 ? 'flag to look at' : 'flags to look at'}
          tone={summary.counts.warnings > 0 ? 'warn' : 'ok'}
          note="A lead reviews flags in Admin → Shipping."
        />
        <Blocker
          icon="Package"
          value={summary.onHoldCount}
          label={summary.onHoldCount === 1 ? 'package on hold' : 'packages on hold'}
          tone={summary.onHoldCount > 0 ? 'warn' : 'ok'}
          onClick={() => onGoTo('find')}
        />
        {/* Steps outstanding is BUSY, not amber — a show that has not been
            worked yet is the normal state of every import. The exception is a
            show with no day: nothing can be ticked at all until somebody fixes
            that, which is precisely what amber is for. */}
        <Blocker
          icon="ListTodo"
          value={stepsLeft}
          label={
            noShowDay
              ? 'steps blocked — no day set'
              : stepsLeft === 1
                ? 'SOP step left'
                : 'SOP steps left'
          }
          tone={noShowDay ? 'warn' : stepsLeft > 0 ? 'busy' : 'ok'}
          onClick={() => onGoTo('sop')}
        />
      </div>

      {/* ---- Every break, at a glance. */}
      <section className="today-board">
        <header>
          <Icon name="LayoutGrid" size={17} />
          <h3>
            {breaks.length} breaks · {found} of {cardsTotal} cards found
            {looseTotal > 0 && (
              <em className="today-loose-note">
                {' '}
                incl. {looseTotal} {looseGiveawaysOnly ? 'giveaways' : 'outside a break'}
              </em>
            )}
          </h3>
          <span className="today-value">{formatMoney(summary.value ?? 0)}</span>
        </header>
        <div className="today-grid">
          {breaks.map((b) => {
            const done = b.totalTeams > 0 && b.checkedTeams >= b.totalTeams
            const pct = b.totalTeams ? (b.checkedTeams / b.totalTeams) * 100 : 0
            return (
              <button
                key={b.id}
                className="today-break"
                data-done={done ? 'true' : 'false'}
                data-orphan={b.assignees.length === 0 ? 'true' : 'false'}
                onClick={() => onGoTo('find')}
              >
                <div className="today-break-top">
                  <BreakChip label={b.breakLabel} />
                  <span className="today-break-count">
                    {b.checkedTeams}/{b.totalTeams}
                  </span>
                </div>
                <span
                  className="today-break-bar"
                  style={{ ['--p' as string]: `${pct}%` }}
                  data-done={done ? 'true' : 'false'}
                />
                <div className="today-break-who">
                  {b.assignees.length === 0 ? (
                    <span className="today-nobody">Nobody yet</span>
                  ) : (
                    b.assignees.map((a) => a.name || 'Removed').join(', ')
                  )}
                </div>
              </button>
            )
          })}
        </div>
        {unfinished.length === 0 && looseLeft === 0 && (
          <p className="today-note today-done">
            Every card is found. Packing can run to the end.
          </p>
        )}
        {unfinished.length === 0 && looseLeft > 0 && (
          <p className="today-note">
            Every break is picked. {looseLeft} {looseGiveawaysOnly ? 'giveaway' : 'card'}
            {looseLeft === 1 ? '' : 's'} {looseLeft === 1 ? 'is' : 'are'} still to find at the bottom
            of Find — they belong to no break, so no break can show them.
          </p>
        )}
      </section>
    </div>
  )
}

/**
 * One number that might be somebody's next move.
 *
 * Some of them are a door and some are only news — the flags and the hand-out
 * are a lead's work in Admin, and a bench operator pressing them would go
 * nowhere. Those render as a plain tile carrying the sentence that says where
 * the work really happens, which is the same answer the collision strip gives.
 */
function Blocker({
  icon,
  value,
  label,
  tone,
  onClick,
  note
}: {
  icon: string
  value: number
  label: string
  tone: 'ok' | 'warn' | 'busy'
  onClick?: () => void
  note?: string
}): JSX.Element {
  const inner = (
    <>
      <Icon name={icon} size={16} />
      <span className="today-blocker-value">{value.toLocaleString()}</span>
      <span className="today-blocker-label">{label}</span>
    </>
  )
  if (!onClick) {
    return (
      <div className="today-blocker" data-tone={tone} data-static="true" title={note}>
        {inner}
      </div>
    )
  }
  return (
    <button className="today-blocker" data-tone={tone} onClick={onClick}>
      {inner}
    </button>
  )
}
