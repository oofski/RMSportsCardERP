import { useEffect, useMemo, useState } from 'react'
import type { DeletedOrder } from '@shared/orders'
import { finance } from './api'
import { Icon } from '../../components/Icon'
import { CenterLoader, EmptyState } from '../../components/ui'
import { Money } from './bits'
import { formatDate } from '../../lib/format'

/**
 * EVERY ORDER SOMEBODY DELETED. The backlog.
 *
 * The owner's question, which the app could not answer at all: "can you see if
 * we deleted any POs, or where I can see what the issue is."
 *
 * ## Why a board could never answer it
 *
 * A board shows what EXISTS. An order somebody removed left a gap in the number
 * sequence and nothing else — no name, no total, no date, no author. The
 * deal-ticket register knew a number had been handed out and could print "order
 * deleted" beside it, which is the fact without the story: not who, not when,
 * and not what was on it.
 *
 * ## Everything on the row is a copy, and that is correct here
 *
 * Every other screen in this app derives what it shows from the thing it is
 * showing. This one cannot: there is no order left to derive from, and there
 * never will be again. The facts were written down at the moment of deletion —
 * see describeDeletion — which is the one case in the app where copying beats
 * pointing. Nothing here can go stale, because its subject stopped existing
 * before the row was written.
 *
 * ## NO YEAR FILTER, deliberately
 *
 * The rest of History is organised by year because a ledger is. "Did we delete
 * any purchase orders?" is not a question about a calendar year, and a backlog
 * that hid December's deletion behind a year button would answer "no" to
 * somebody who needed "yes, in December". The search box narrows it instead,
 * and the date is on every row.
 */
export function DeletedTab({ query }: { query: string }): JSX.Element {
  const [rows, setRows] = useState<DeletedOrder[] | null>(null)

  useEffect(() => {
    let alive = true
    setRows(null)
    void finance
      .deletedOrders()
      .then((r) => alive && setRows(r))
      .catch(() => alive && setRows([]))
    return () => {
      alive = false
    }
  }, [])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows ?? []
    return (rows ?? []).filter((r) =>
      [r.number, r.party, r.actorName, r.stage, r.detail]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    )
  }, [rows, query])

  if (rows === null) return <CenterLoader />

  if (shown.length === 0) {
    return (
      <EmptyState
        icon="Trash2"
        title={query ? 'Nothing matches that' : 'Nothing has been deleted'}
        message={
          query
            ? 'No deleted order matches what you typed.'
            : 'When an order is deleted it is recorded here — what it was, what it was worth, and who removed it.'
        }
      />
    )
  }

  return (
    <div className="table-wrap">
      <table className="data hist-table del-table">
        <thead>
          <tr>
            <th>Deleted</th>
            <th>Kind</th>
            <th>Number</th>
            <th>Who it was with</th>
            <th className="num">Units</th>
            <th className="num">Was worth</th>
            <th>Stage</th>
            <th>Deleted by</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.id} className="hist-row del-row" title={r.detail ?? undefined}>
              <td className="hist-date">{formatDate(r.deletedAt)}</td>
              <td>
                {/* Which side it was. A deleted purchase and a deleted sale are
                    very different losses — one is money we were going to spend,
                    the other money we were going to take — and the register
                    holds both, so the row has to say which. */}
                <span className={`del-side ${r.side === 'po' ? 'in' : 'out'}`}>
                  <Icon name={r.side === 'po' ? 'ArrowDown' : 'ArrowUp'} size={13} />
                  {r.side === 'po' ? 'Purchase' : 'Sales'}
                </span>
              </td>
              <td className="hist-num">{r.number ?? '—'}</td>
              <td>{r.party ?? '—'}</td>
              <td className="num">{r.units || '—'}</td>
              <td className="num">
                <Money value={r.total} />
              </td>
              {/* A deleted DRAFT and a deleted PAID order are not the same
                  event. The stage it was in when it went is the difference
                  between somebody tidying up and somebody removing a document
                  the money has already moved against. */}
              <td>
                {r.stage ? <span className={`hist-stage st-${r.stage}`}>{r.stage}</span> : '—'}
              </td>
              {/* NAMED AS THEY WERE THEN, and blank rather than guessed when
                  the deletion predates this record. "Unknown" would be a claim;
                  a dash is the honest reading of a row written before anybody
                  was writing anybody down. */}
              <td>{r.actorName ?? <span className="del-nobody">not recorded</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
