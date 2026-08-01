import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ShipBreakSummary } from '@shared/shippingViews'
import { useSession } from '../../lib/session'
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
 * Everyone lands here, so it answers the two questions people actually arrive
 * with: *what am I meant to be doing*, and *what is stopping the room*. Nothing
 * on this screen is a place to work; every tile is a door into Find or Pack.
 *
 * The blocking numbers matter more than the totals. A break with nobody on it is
 * not a statistic — it is thirty cards nobody is pulling, and every package that
 * touches it cannot be closed. That relationship is the one thing the module
 * could never show before, and it is what a lead needs to decide where the next
 * person goes.
 */
export function TodayTab({ summary, onGoTo }: ShipTabProps): JSX.Element {
  const { user } = useSession()
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

  const mine = useMemo(
    () => breaks.filter((b) => b.assignees.some((a) => a.employeeId === user?.id)),
    [breaks, user?.id]
  )
  const unassigned = useMemo(() => breaks.filter((b) => b.assignees.length === 0), [breaks])
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

  if (loading) return <CenterLoader />

  if (!summary?.hasDataset || breaks.length === 0) {
    return (
      <EmptyState
        icon="CalendarDays"
        title="No show loaded"
        message="Import tonight's packing slips and the board fills in."
        action={
          <Button variant="primary" icon="UploadCloud" onClick={() => onGoTo('setup')}>
            Go to Setup
          </Button>
        }
      />
    )
  }

  const nextMine = mine.find((b) => b.checkedTeams < b.totalTeams)

  return (
    <div className="today-page">
      {/* ---- Yours. First, because most people opening this are here to work. */}
      <section className="today-mine" data-empty={mine.length === 0 ? 'true' : 'false'}>
        <header>
          <Icon name="UserCheck" size={17} />
          <h3>{mine.length > 0 ? 'Your breaks' : 'Nothing assigned to you'}</h3>
          {nextMine && (
            <Button variant="primary" size="sm" icon="ListChecks" onClick={() => onGoTo('find')}>
              Start finding
            </Button>
          )}
        </header>
        {mine.length === 0 ? (
          <p className="today-note">
            Any break with nobody on it is fair game — open Find and take one.
          </p>
        ) : (
          <div className="today-chips">
            {mine.map((b) => (
              <button key={b.id} className="today-chip" onClick={() => onGoTo('find')}>
                <BreakChip label={b.breakLabel} />
                <span className="today-chip-prog">
                  {b.checkedTeams}/{b.totalTeams}
                </span>
                <span
                  className="today-chip-bar"
                  style={{
                    ['--p' as string]: `${b.totalTeams ? (b.checkedTeams / b.totalTeams) * 100 : 0}%`
                  }}
                />
              </button>
            ))}
          </div>
        )}
      </section>

      {/* ---- What is stopping the room. */}
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
            label={
              looseLeft === 1
                ? 'giveaway in no break'
                : 'giveaways in no break'
            }
            tone="warn"
            onClick={() => onGoTo('find')}
          />
        )}
        <Blocker
          icon="UserX"
          value={unassigned.length}
          label={unassigned.length === 1 ? 'break with nobody on it' : 'breaks with nobody on them'}
          tone={unassigned.length > 0 ? 'warn' : 'ok'}
          onClick={() => onGoTo('setup')}
        />
        <Blocker
          icon="Flag"
          value={summary.counts.warnings}
          label={summary.counts.warnings === 1 ? 'flag to look at' : 'flags to look at'}
          tone={summary.counts.warnings > 0 ? 'warn' : 'ok'}
          onClick={() => onGoTo('flags')}
        />
        <Blocker
          icon="Package"
          value={summary.onHoldCount}
          label={summary.onHoldCount === 1 ? 'package on hold' : 'packages on hold'}
          tone={summary.onHoldCount > 0 ? 'warn' : 'ok'}
          onClick={() => onGoTo('pack')}
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
                incl. {looseTotal} in no break
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
            Every break is picked, but {looseLeft} giveaway{looseLeft === 1 ? '' : 's'} belonging to
            no break {looseLeft === 1 ? 'is' : 'are'} still out — they are at the bottom of Find.
          </p>
        )}
      </section>
    </div>
  )
}

function Blocker({
  icon,
  value,
  label,
  tone,
  onClick
}: {
  icon: string
  value: number
  label: string
  tone: 'ok' | 'warn' | 'busy'
  onClick: () => void
}): JSX.Element {
  return (
    <button className="today-blocker" data-tone={tone} onClick={onClick}>
      <Icon name={icon} size={16} />
      <span className="today-blocker-value">{value.toLocaleString()}</span>
      <span className="today-blocker-label">{label}</span>
    </button>
  )
}
