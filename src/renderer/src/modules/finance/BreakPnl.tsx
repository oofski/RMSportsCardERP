import { useEffect, useState } from 'react'
import type { BreakPnlSplit } from '@shared/breakPnl'
import { api } from '../../lib/api'
import { Icon } from '../../components/Icon'
import { CenterLoader } from '../../components/ui'
import { formatMoney } from '../../lib/format'

/**
 * The night, split by break.
 *
 * The day statement answers "what did last night make". This answers the
 * question underneath — "which breaks made it" — and it is the same arithmetic
 * grouped one level finer, so the two cannot disagree. See @shared/breakPnl for
 * why the fees are exact rather than apportioned.
 *
 * ## The blank cell is the point
 *
 * A break with no recorded box cost shows a dash where its margin would be, not
 * a number. Every instinct in a table like this says fill the cell — and filling
 * it with the revenue is a printed claim of 100% margin, on exactly the break
 * that has a data problem, which then flatters any sort by profit. The dash is
 * the honest answer and the count above the table says how many there are.
 */
export function BreakPnl({ streamDate }: { streamDate: string }): JSX.Element {
  const [split, setSplit] = useState<BreakPnlSplit | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true)
    void (async () => {
      const data = await api.finance.breakPnl(streamDate)
      if (!active) return
      setSplit(data)
      setLoading(false)
    })()
    return () => {
      active = false
    }
  }, [streamDate])

  if (loading) return <CenterLoader />
  if (!split || split.rows.length === 0) {
    return <div className="bpnl-empty">No sales on this day carry a break number.</div>
  }

  return (
    <div className="bpnl">
      {split.uncostedBreaks > 0 && (
        <div className="bpnl-note">
          <Icon name="AlertTriangle" size={14} />
          <span>
            {split.uncostedBreaks === 1
              ? 'One break has sales but no recorded box cost'
              : `${split.uncostedBreaks} breaks have sales but no recorded box cost`}
            , and no box count could be read from their listing title either, so their margin is
            unknown rather than zero. Enter what was ripped on the show to fill them in.
          </span>
        </div>
      )}

      <table className="bpnl-table">
        <thead>
          <tr>
            <th>Break</th>
            <th className="num">Sales</th>
            <th className="num">Cost</th>
            <th className="num">Fees</th>
            <th className="num">Net</th>
          </tr>
        </thead>
        <tbody>
          {split.rows.map((r) => (
            <tr
              key={r.breakNumber === null ? 'none' : r.breakNumber}
              className={`${r.breakNumber === null ? 'unattributed' : ''} ${
                r.costKnown ? '' : 'uncosted'
              }`}
            >
              <td>
                <span className="bpnl-label">{r.label}</span>
                {r.products.length > 0 && (
                  <span className="bpnl-product">{r.products.join(', ')}</span>
                )}
                {r.boxes !== null && (
                  <span className="bpnl-count">
                    {r.boxes} box{r.boxes === 1 ? '' : 'es'}
                  </span>
                )}
                {r.saleCount > 0 && (
                  <span className="bpnl-count">
                    {r.saleCount} row{r.saleCount === 1 ? '' : 's'}
                  </span>
                )}
              </td>
              <td className="num mono">{formatMoney(r.grossSales)}</td>
              <td className="num mono">
                {r.costKnown ? (
                  // A DERIVED cost is a real number the app worked out — boxes
                  // off the listing title times the night's per-box price —
                  // rather than one somebody entered. Marked, because an
                  // operator reconciling a night needs to know which is which,
                  // and because the mark is what tells them a break is still
                  // waiting to have its boxes entered.
                  <span
                    className={r.costSource === 'derived' ? 'bpnl-derived' : undefined}
                    title={
                      r.costSource === 'derived'
                        ? `Worked out: ${r.boxes} boxes at the night's per-box price. Enter what was ripped to replace it.`
                        : undefined
                    }
                  >
                    {formatMoney(-r.cogs)}
                    {r.costSource === 'derived' && <em>~</em>}
                  </span>
                ) : (
                  <span className="bpnl-unknown" title="Nobody recorded what was ripped for this break">
                    —
                  </span>
                )}
              </td>
              <td className="num mono">{formatMoney(r.totalFees)}</td>
              <td className={`num mono ${r.netProfit !== null && r.netProfit < 0 ? 'neg' : 'pos'}`}>
                {r.netProfit === null ? <span className="bpnl-unknown">—</span> : formatMoney(r.netProfit)}
              </td>
            </tr>
          ))}
        </tbody>
        {/* The reason the table is trustworthy: these two add back to the
            statement above, to the cent. Cost is deliberately NOT totalled
            against a "day cost" here — it is only what was recorded, and
            printing it beside two exact figures would imply it was complete. */}
        <tfoot>
          <tr>
            <td>All breaks</td>
            <td className="num mono">{formatMoney(split.grossSales)}</td>
            <td className="num mono">{split.cogs ? formatMoney(-split.cogs) : '—'}</td>
            <td className="num mono">{formatMoney(split.totalFees)}</td>
            <td />
          </tr>
        </tfoot>
      </table>

      {split.hasUnattributed && (
        <p className="bpnl-foot">
          “No break named” is money whose ledger row did not say which break it came from. It is
          shown rather than dropped so the lines above add back to the day.
        </p>
      )}
    </div>
  )
}
