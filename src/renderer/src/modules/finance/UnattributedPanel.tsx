import { useMemo, useState } from 'react'
import type { StreamingFinanceView, UnattributedCluster } from '@shared/financeStreaming'
import { bucketDef } from '@shared/financeStreaming'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { Button } from '../../components/ui'
import { useChrome } from '../../lib/chrome'
import { useSession } from '../../lib/session'
import { BucketChip, Money, Note, plural } from './bits'
import { finance, resultError } from './api'
import { crossedDays, shortDayLabel, timeLabel } from './time'

/** How many clusters show before the list asks to be expanded. */
const CLUSTER_PREVIEW = 6

/**
 * Money that matched no show.
 *
 * This is INFORMATION, not a failure, and the panel is written that way on the
 * owner's instruction: "if a stream isn't in the streaming schedule, don't worry
 * about it, it'll just show up empty." A row is attributed only when its instant
 * falls inside a logged session, RM often runs two shows a day and only the
 * evening one gets clocked, and on real data this pile has been about a quarter
 * of the business. Nothing is lost and nothing is wrong — the money is stored,
 * counted, and waiting for a session to claim it.
 *
 * So the panel is neutral: a plain surface and a plain heading. What stays loud
 * is the CLUSTERS, because they are the only thing here that is actionable —
 * each one names a time window where a show almost certainly ran, and adding it
 * is a two-minute job nobody does if they cannot see it.
 */
export function UnattributedPanel({
  view,
  canManage,
  onView
}: {
  view: StreamingFinanceView
  canManage: boolean
  onView: (view: StreamingFinanceView) => void
}): JSX.Element {
  const toast = useToast()
  const { navigate } = useChrome()
  const { can } = useSession()
  const [busy, setBusy] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const { unattributed, totals } = view

  // Biggest first: the operator fixes one missing show at a time, and the one
  // worth $12k is the one to fix first.
  const clusters = useMemo(
    () => [...unattributed.clusters].sort((a, b) => b.amount - a.amount),
    [unattributed.clusters]
  )

  // Measured against the attributed TOP line, not net: the unattributed figure
  // is a raw sum of ledger rows with no fees taken off it, so comparing it to
  // net revenue would overstate the share against a smaller denominator.
  const pool = totals.totalRevenue + unattributed.amount
  const share = pool > 0 ? unattributed.amount / pool : 0

  const reattribute = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await finance.reattribute()
      if (!res.ok || !res.data) {
        toast.error(resultError(res, 'Re-attribution did not run.'))
        return
      }
      const after = res.data.unattributed
      const claimed = unattributed.rowCount - after.rowCount
      onView(res.data)
      toast.success(
        claimed > 0
          ? `${plural(claimed, 'row')} moved onto a show.`
          : 'Every row re-checked. Nothing new matched — the missing shows still need logging.'
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Re-attribution did not run.')
    } finally {
      setBusy(false)
    }
  }

  if (unattributed.rowCount === 0) {
    return (
      <section className="fin-unattr is-clear">
        <span className="fin-unattr-clear">
          <Icon name="CheckCircle2" size={16} />
          <b>Every ledger row landed on a show.</b> Nothing is sitting outside a session, so the
          days below account for all of it.
        </span>
        {canManage && (
          <Button size="sm" icon="RefreshCw" loading={busy} onClick={() => void reattribute()}>
            Re-attribute
          </Button>
        )}
      </section>
    )
  }

  const visible = showAll ? clusters : clusters.slice(0, CLUSTER_PREVIEW)

  return (
    <section className="fin-unattr">
      <div className="fin-unattr-head">
        <span className="fin-unattr-icon" aria-hidden="true">
          <Icon name="CalendarRange" size={18} />
        </span>
        <div className="fin-unattr-headline">
          <h3>Waiting for a show</h3>
          <p>
            These rows happened outside every logged session, so they are not on any day yet. That
            is expected — a stream that was never in the schedule simply has nothing to attach to.
          </p>
        </div>
        <div className="fin-unattr-figure">
          <Money value={unattributed.amount} strong />
          <span className="fin-unattr-sub">
            {plural(unattributed.rowCount, 'row')}
            {share > 0 && ` · ${Math.round(share * 100)}% of everything imported`}
          </span>
        </div>
      </div>

      <Note tone="info" icon="Info">
        A sale is matched only when a session covers the moment it happened. RM often runs two shows
        a day and only the evening one gets clocked, so an afternoon block sits here in full.
        Settlement costs that post after a show — shipping, subsidies, giveaway postage — are booked
        back to the show that caused them, so what waits here is mostly real sales from shows nobody
        logged. Nothing is lost: every row is stored. Log the missing session in <b>Streaming</b>,
        press <b>Re-attribute</b>, and it lands on the right day.
      </Note>

      {unattributed.byBucket.length > 0 && (
        <div className="fin-unattr-buckets">
          {unattributed.byBucket.map((b) => (
            <div className="fin-unattr-bucket" key={b.bucket}>
              <BucketChip bucket={b.bucket} />
              <Money
                value={b.amount}
                cost={bucketDef(b.bucket).treatment === 'expense'}
                strong
              />
              <em>{plural(b.rowCount, 'row')}</em>
            </div>
          ))}
        </div>
      )}

      {/* The clusters keep the emphasis the panel as a whole gave up. They are
          the only actionable thing here: each one is a show you can go and log. */}
      <div className="fin-cluster-block">
        <span className="fin-section-title">
          <Icon name="CalendarDays" size={15} />
          Probably unlogged shows
          <span className="fin-count">{clusters.length}</span>
        </span>
        <p className="fin-cluster-lead">
          Each block below is a run of activity with a gap either side of it — which is what a show
          looks like in the ledger. Add a session covering the times shown and its money moves onto
          that day.
        </p>

        <ul className="fin-clusters">
          {visible.map((c) => (
            <ClusterRow key={`${c.from}-${c.to}`} cluster={c} />
          ))}
        </ul>

        {clusters.length > CLUSTER_PREVIEW && (
          <button type="button" className="fin-more" onClick={() => setShowAll((v) => !v)}>
            <Icon name={showAll ? 'ChevronUp' : 'ChevronDown'} size={14} />
            {showAll
              ? 'Show fewer'
              : `Show all ${clusters.length} blocks (${clusters.length - CLUSTER_PREVIEW} more)`}
          </button>
        )}
      </div>

      <div className="fin-unattr-acts">
        {can('module.streaming') && (
          <Button icon="ArrowRight" onClick={() => navigate('streaming')}>
            Log a missing show
          </Button>
        )}
        {canManage && (
          <Button
            variant="primary"
            icon="RefreshCw"
            loading={busy}
            onClick={() => void reattribute()}
          >
            Re-attribute
          </Button>
        )}
        <span className="fin-unattr-note">
          Re-attribution re-checks every stored row against the sessions as they are now. It never
          moves money on its own — it only matches what a session already covers.
        </span>
      </div>
    </section>
  )
}

function ClusterRow({ cluster }: { cluster: UnattributedCluster }): JSX.Element {
  const days = crossedDays(cluster.from, cluster.to)
  return (
    <li className="fin-cluster">
      <span className="fin-cluster-when">
        <b>{shortDayLabel(cluster.localDate)}</b>
        <span className="mono">
          {timeLabel(cluster.from)}–{timeLabel(cluster.to)}
        </span>
        {days > 0 && (
          <span
            className="fin-plus"
            title={`Ran on past midnight — ended ${days} day${days === 1 ? '' : 's'} later`}
          >
            +{days}d
          </span>
        )}
      </span>
      <span className="fin-cluster-rows">{plural(cluster.rowCount, 'row')}</span>
      <Money value={cluster.amount} strong />
    </li>
  )
}
