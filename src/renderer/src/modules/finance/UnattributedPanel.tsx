import { useMemo, useState } from 'react'
import type { StreamingFinanceView, UnattributedCluster } from '@shared/financeStreaming'
import { bucketDef } from '@shared/financeStreaming'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { Button } from '../../components/ui'
import { useChrome } from '../../lib/chrome'
import { useSession } from '../../lib/session'
import { BucketChip, Money, Pct, plural } from './bits'
import { finance, resultError } from './api'
import { crossedDays, shortDayLabel, timeLabel } from './time'

/** How many clusters show before the list asks to be expanded. Eight covers a
 *  normal week of missed afternoon shows without a click. */
const CLUSTER_PREVIEW = 8

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
 * So the panel is neutral, and it is now FLAT: one heading, one sentence, the
 * buckets, and the clusters. It used to nest a banner and a bordered sub-panel
 * inside a bordered panel to say all of that, which drew four frames around
 * three facts. What stays emphatic is the CLUSTER TABLE, because it is the only
 * thing here anyone can act on — each row names a window where a show almost
 * certainly ran, and adding it is a two-minute job nobody does if they cannot
 * see it.
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
  const share = pool > 0 ? (unattributed.amount / pool) * 100 : null

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
      <section className="fin-unattr is-clear" id="fin-unattributed">
        <span className="fin-unattr-clear">
          <Icon name="CheckCircle2" size={15} />
          Every ledger row landed on a show — nothing is sitting outside a session.
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
    <section className="fin-unattr" id="fin-unattributed">
      <div className="fin-unattr-head">
        <span className="fin-section-title">
          <Icon name="CalendarRange" size={15} />
          Waiting for a show
        </span>
        <span className="fin-unattr-figure">
          <Money value={unattributed.amount} strong />
          <em>
            {plural(unattributed.rowCount, 'row')}
            {share !== null && (
              <>
                {' · '}
                <Pct
                  value={share}
                  base="of everything imported"
                  title="This pile, as a share of it plus the revenue already booked to days. Both sides are raw ledger sums, before fees."
                />
              </>
            )}
          </em>
        </span>
        <span className="fin-unattr-acts">
          {can('module.streaming') && (
            <Button size="sm" icon="ArrowRight" onClick={() => navigate('streaming')}>
              Log a missing show
            </Button>
          )}
          {canManage && (
            <Button
              size="sm"
              variant="primary"
              icon="RefreshCw"
              loading={busy}
              onClick={() => void reattribute()}
            >
              Re-attribute
            </Button>
          )}
        </span>
      </div>

      <p className="fin-unattr-lead">
        A sale is matched only when a logged session covers the moment it happened, so an afternoon
        show nobody clocked sits here in full. Nothing is lost — every row is stored. Log the
        session in <b>Streaming</b>, press <b>Re-attribute</b>, and it lands on the right day.
        Re-attribution only ever matches what a session already covers; it never moves money on its
        own.
      </p>

      {unattributed.byBucket.length > 0 && (
        <div className="fin-unattr-buckets">
          {unattributed.byBucket.map((b) => (
            <span className="fin-unattr-bucket" key={b.bucket}>
              <BucketChip bucket={b.bucket} />
              <Money value={b.amount} cost={bucketDef(b.bucket).treatment === 'expense'} strong />
              <em>{plural(b.rowCount, 'row')}</em>
            </span>
          ))}
        </div>
      )}

      {/* A table, so the four columns line up down the list. Scanning for the
          biggest block is the whole use of it, and ragged figures make that a
          reading job rather than a glance. */}
      <table className="fin-clusters">
        <caption>
          Probably unlogged shows — {plural(clusters.length, 'block')} of activity with a gap either
          side, which is what a show looks like in the ledger.
        </caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">On air</th>
            <th scope="col" className="is-num">
              Rows
            </th>
            <th scope="col" className="is-num">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {visible.map((c) => (
            <ClusterRow key={`${c.from}-${c.to}`} cluster={c} />
          ))}
        </tbody>
      </table>

      {clusters.length > CLUSTER_PREVIEW && (
        <button type="button" className="fin-more" onClick={() => setShowAll((v) => !v)}>
          <Icon name={showAll ? 'ChevronUp' : 'ChevronDown'} size={14} />
          {showAll
            ? `Show only the largest ${CLUSTER_PREVIEW}`
            : `Show ${plural(clusters.length - CLUSTER_PREVIEW, 'smaller block')}`}
        </button>
      )}
    </section>
  )
}

function ClusterRow({ cluster }: { cluster: UnattributedCluster }): JSX.Element {
  const days = crossedDays(cluster.from, cluster.to)
  return (
    <tr>
      <th scope="row">{shortDayLabel(cluster.localDate)}</th>
      <td className="fin-cluster-when">
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
      </td>
      <td className="is-num mono">{cluster.rowCount.toLocaleString()}</td>
      <td className="is-num">
        <Money value={cluster.amount} strong />
      </td>
    </tr>
  )
}
