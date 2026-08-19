import { useEffect, useMemo, useState } from 'react'
import type { DealTicketGroup, DealTicketRow } from '@shared/dealTickets'
import {
  dealTicketMatches,
  dealTicketSide,
  describeDealTicketKind,
  groupDealTickets,
  isCombined,
  isDropshipKind,
  summariseDealTickets
} from '@shared/dealTickets'
import { Icon } from '../../components/Icon'
import { Button, CenterLoader, EmptyState } from '../../components/ui'
import { useToast } from '../../components/Toast'
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
  const toast = useToast()
  const [rows, setRows] = useState<DealTicketRow[] | null>(null)
  /**
   * Which tickets are ticked, by id.
   *
   * Cleared whenever the register is refetched. A selection that survived a
   * reload would be a set of ids the operator can no longer see, and the next
   * press would combine rows nobody had chosen on screen.
   */
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    setRows(null)
    setPicked(new Set())
    void finance.dealTickets(year).then((r) => alive && setRows(r))
    return () => {
      alive = false
    }
  }, [year])

  const shown = useMemo(
    () => (rows ?? []).filter((r) => dealTicketMatches(r, query)),
    [rows, query]
  )
  const groups = useMemo(() => groupDealTickets(shown), [shown])
  const totals = useMemo(() => summariseDealTickets(shown), [shown])

  const toggle = (id: string): void =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const pickedRows = shown.filter((r) => picked.has(r.id))
  // The one that keeps its number is the OLDEST selected — the deal started
  // there, and choosing the newest would fold a month of history under a number
  // struck yesterday.
  const target = pickedRows.reduce<DealTicketRow | null>(
    (lo, r) => (lo === null || r.seq < lo.seq ? r : lo),
    null
  )
  const anyCombined = pickedRows.some((r) => r.mergedInto)

  const combine = async (): Promise<void> => {
    if (busy || !target || pickedRows.length < 2) return
    setBusy(true)
    try {
      const res = await finance.mergeDealTickets(
        target.id,
        pickedRows.map((r) => r.id)
      )
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Those could not be combined.')
        return
      }
      setRows(res.data.filter((r) => year === null || r.issuedAt.slice(0, 4) === String(year)))
      setPicked(new Set())
      toast.success(`${pickedRows.length} documents now answer to ${target.number}.`)
    } finally {
      setBusy(false)
    }
  }

  const separate = async (): Promise<void> => {
    if (busy || pickedRows.length === 0) return
    setBusy(true)
    try {
      const res = await finance.unmergeDealTickets(pickedRows.map((r) => r.id))
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Those could not be separated.')
        return
      }
      setRows(res.data.filter((r) => year === null || r.issuedAt.slice(0, 4) === String(year)))
      setPicked(new Set())
      toast.success('Back to their own numbers.')
    } finally {
      setBusy(false)
    }
  }

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
      {/* THE ONE THING A PERSON DOES TO THIS REGISTER.
          A ticket is struck automatically per document, which is right — but a
          DEAL is often several movements: cases bought from one supplier and
          sold on to three shops is four documents and one piece of business.
          Ticking them and combining says so. Nothing is renumbered: the absorbed
          rows keep their numbers and simply answer to the oldest one, which is
          why it can be undone. */}
      {picked.size > 0 && (
        <div className="dt-actions">
          <span className="dt-actions-n">
            {picked.size} selected
            {target && picked.size > 1 && !anyCombined && (
              <>
                {' '}
                — they will all answer to <b>{target.number}</b>, the oldest
              </>
            )}
          </span>
          <div className="dt-actions-btns">
            <Button variant="ghost" size="sm" onClick={() => setPicked(new Set())} disabled={busy}>
              Clear
            </Button>
            {anyCombined && (
              <Button
                variant="secondary"
                size="sm"
                icon="X"
                loading={busy}
                disabled={busy}
                onClick={() => void separate()}
              >
                Separate
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              icon="Layers"
              loading={busy}
              disabled={busy || picked.size < 2}
              onClick={() => void combine()}
            >
              Combine into one
            </Button>
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table className="data hist-table">
          <thead>
            <tr>
              <th className="dt-pick" aria-label="Select" />
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
            {groups.map((g) => (
              <GroupRows
                key={g.root.id}
                group={g}
                picked={picked}
                onToggle={toggle}
                disabled={busy}
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

/**
 * One deal ticket and every document under it.
 *
 * A group of one renders as a plain row — which is the overwhelming majority —
 * and a combined group adds a header line saying how many documents answer to
 * the number and what they come to together. Same component either way, so the
 * common case cannot drift away from the rare one.
 */
function GroupRows({
  group,
  picked,
  onToggle,
  disabled
}: {
  group: DealTicketGroup
  picked: Set<string>
  onToggle: (id: string) => void
  disabled: boolean
}): JSX.Element {
  const combined = isCombined(group)
  return (
    <>
      {combined && (
        <tr className="dt-group-head">
          <td />
          <td className="hist-num dt-number">{group.root.number}</td>
          <td colSpan={4}>
            <span className="dt-group-n">
              <Icon name="Layers" size={12} />
              {group.rows.length} documents, one deal
            </span>
          </td>
          <td className="num">
            <Money value={group.outbound - group.inbound} />
          </td>
          <td />
        </tr>
      )}
      {group.rows.map((r) => (
        <TicketRow
          key={r.id}
          row={r}
          inGroup={combined}
          checked={picked.has(r.id)}
          onToggle={onToggle}
          disabled={disabled}
        />
      ))}
    </>
  )
}

function TicketRow({
  row,
  inGroup = false,
  checked = false,
  onToggle,
  disabled = false
}: {
  row: DealTicketRow
  inGroup?: boolean
  checked?: boolean
  onToggle?: (id: string) => void
  disabled?: boolean
}): JSX.Element {
  const inbound = dealTicketSide(row.kind) === 'in'
  // The live number is the truth about where to look; the snapshot is what the
  // paperwork says. They agree almost always, and when they do not BOTH matter.
  const liveNumber = row.liveNumber?.trim() || null
  const snapshot = row.documentNumber?.trim() || null
  const renamed = liveNumber && snapshot && liveNumber !== snapshot

  return (
    <tr
      className={`hist-row dt-row ${row.documentMissing ? 'gone' : ''}${
        inGroup ? ' dt-in-group' : ''
      }`}
    >
      <td className="dt-pick">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-label={`Select ${row.number}`}
          onChange={() => onToggle?.(row.id)}
        />
      </td>
      {/* A ticket folded into another still shows ITS OWN number, quietly. The
          register accounts for every number it handed out, and hiding one here
          would make it unfindable by the number somebody wrote down. */}
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
