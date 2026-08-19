import { useEffect, useMemo, useState } from 'react'
import type { DealTicketRow } from '@shared/dealTickets'
import {
  dealTicketMatches,
  dealTicketSide,
  describeDealTicketKind,
  isDropshipKind,
  summariseDealTickets
} from '@shared/dealTickets'
import { Icon } from '../../components/Icon'
import { CenterLoader, EmptyState } from '../../components/ui'
import { Money } from './bits'
import { finance } from './api'

/**
 * Finance → History → Deal tickets: the register of every commercial movement.
 *
 * ## Why this is a list and nothing else
 *
 * There is no button on this screen. Nothing here creates, edits, voids or
 * reassigns a ticket, because a ticket is not a thing anybody works — it is
 * struck automatically the moment a purchase order or a sales order is created
 * and then it is simply a fact. A screen offering to change one would be
 * offering to make the register disagree with what happened.
 *
 * So this is a register in the accounting sense: read it, search it, quote a
 * number off it. Everything actionable lives on the order the row points at.
 *
 * ## The year and the search box belong to the PARENT
 *
 * They are drawn in the same bar as the Purchase / Sales / Deal tickets strip,
 * so the three views share one set of controls in one place rather than each
 * growing a second row of their own that lands in a different spot as you flip
 * between them. This component takes both as props and owns only the rows.
 *
 * ## Both numbers are shown
 *
 * The ticket number and the document number are different labels for the same
 * movement, and somebody arrives here holding either one. The document number
 * shown is the one the order carries TODAY — which can differ from the snapshot
 * taken at issue, because sync renumbers a purchase order when two offline
 * machines mint the same one. When those two disagree the old one is shown
 * beside it rather than dropped, since the old number is what is written on the
 * paperwork somebody is looking at.
 *
 * ## A missing order is shown, not hidden
 *
 * A ticket outlives the document it names. When the order behind one has been
 * deleted the row stays and says so, because the alternative is a register with
 * an unexplained gap in its sequence — and a gap nobody can account for is worse
 * than a number that says plainly what became of it.
 */
export function DealTicketsTab({
  year,
  query,
  nextNumber
}: {
  year: number
  query: string
  /** What the register will call the next movement, for the empty state. */
  nextNumber: string
}): JSX.Element {
  const [rows, setRows] = useState<DealTicketRow[] | null>(null)

  useEffect(() => {
    let alive = true
    setRows(null)
    void finance.dealTickets(year).then((r) => alive && setRows(r))
    return () => {
      alive = false
    }
  }, [year])

  const shown = useMemo(
    () => (rows ?? []).filter((r) => dealTicketMatches(r, query)),
    [rows, query]
  )
  const totals = useMemo(() => summariseDealTickets(shown), [shown])

  if (rows === null) return <CenterLoader />

  if (shown.length === 0) {
    return (
      <EmptyState
        icon="Hash"
        title={query ? 'Nothing matches that' : `No deal tickets in ${year}`}
        message={
          query
            ? 'Try the ticket number, the order number, or the supplier or buyer.'
            : // The next number is quoted so somebody who has just turned this on
              // can see the register is armed and where it will start, rather than
              // reading an empty screen as a thing that is not working.
              `A ticket is struck automatically every time a purchase order or a sales order is raised — there is nothing to fill in. The next one will be ${nextNumber || 'DT-000337'}.`
        }
      />
    )
  }

  return (
    <>
      <p className="hist-count">
        {totals.count} ticket{totals.count === 1 ? '' : 's'}
        {totals.first && totals.last && (
          <>
            {' '}
            · {totals.first === totals.last ? totals.first : `${totals.first} – ${totals.last}`}
          </>
        )}{' '}
        · <Money value={totals.inbound} /> in · <Money value={totals.outbound} /> out
      </p>
      <div className="table-wrap">
        <table className="data hist-table">
          <thead>
            <tr>
              <th>Ticket</th>
              <th>Date</th>
              <th>Movement</th>
              <th>Party</th>
              <th>Order</th>
              <th className="num">Amount</th>
              <th>Stage</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <TicketRow key={r.id} row={r} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function TicketRow({ row }: { row: DealTicketRow }): JSX.Element {
  const inbound = dealTicketSide(row.kind) === 'in'
  // The live number is the truth about where to look; the snapshot is what the
  // paperwork says. They agree almost always, and when they do not BOTH matter.
  const liveNumber = row.liveNumber?.trim() || null
  const snapshot = row.documentNumber?.trim() || null
  const renamed = liveNumber && snapshot && liveNumber !== snapshot

  return (
    <tr className={`hist-row dt-row ${row.documentMissing ? 'gone' : ''}`}>
      <td className="hist-num dt-number">{row.number}</td>
      <td className="hist-date">{row.issuedAt.slice(0, 10)}</td>
      <td>
        <span className={`dt-kind ${inbound ? 'in' : 'out'}`}>
          <Icon name={inbound ? 'ArrowDown' : 'ArrowUp'} size={13} />
          {describeDealTicketKind(row.kind)}
        </span>
        {isDropshipKind(row.kind) && (
          <span
            className="dt-pair"
            title="Bought and sold as one deal — the other half has its own ticket"
          >
            paired
          </span>
        )}
      </td>
      <td>{row.party || '—'}</td>
      <td className="dt-doc">
        {liveNumber ?? snapshot ?? '—'}
        {renamed && (
          <span
            className="dt-was"
            title="Renumbered when two machines synced; the paperwork may still say this"
          >
            was {snapshot}
          </span>
        )}
      </td>
      <td className="num">
        <Money value={row.liveAmount ?? row.amount} />
      </td>
      <td>
        {row.documentMissing ? (
          <span
            className="dt-gone"
            title="The order was deleted. The number stays so the sequence has no unexplained gap."
          >
            order deleted
          </span>
        ) : (
          <span className={`hist-stage st-${row.liveStatus ?? 'draft'}`}>
            {row.liveStatus ?? 'draft'}
          </span>
        )}
      </td>
    </tr>
  )
}
