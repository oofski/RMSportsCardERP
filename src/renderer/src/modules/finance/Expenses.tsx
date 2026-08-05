import { useCallback, useEffect, useMemo, useState } from 'react'
import type { GeneralExpense, StreamingFinanceView } from '@shared/financeStreaming'
import {
  EXPENSE_AMOUNT_MAX,
  EXPENSE_LABEL_MAX,
  validateGeneralExpense
} from '@shared/financeStreaming'
import { Icon } from '../../components/Icon'
import { Button, Field, Input, Modal } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { Money, Note, plural } from './bits'
import { finance, resultError } from './api'
import type { DayRange } from './range'
import { shortDayLabel, todayKey } from './time'

/**
 * Finance → Streaming: what was lost rather than sold.
 *
 * A DOLLAR AMOUNT, NOT A STOCK MOVEMENT, and that is the whole reason this panel
 * exists beside the Streaming module rather than inside it. Logging a giveaway in
 * Streaming moves inventory — it consumes the FIFO layers, drops the on-hand
 * count and values the loss at what those layers cost — and that is the right
 * tool whenever somebody is going to reconcile the shelf. This is for the case
 * the owner described, "we opened one for fun", where nobody is: it books the
 * money and touches no stock.
 *
 * SO THE TWO MUST NOT BE USED FOR THE SAME EVENT. A prize entered in Streaming
 * and typed here as well books the same pack twice — once through
 * `stream_items.loss_value` into cost of goods, once through this into general
 * expenses — and nothing can detect it, because one is a stock movement and the
 * other is a bare number. The panel says so on screen rather than only in a
 * comment.
 *
 * IT SHOWS THE SELECTED RANGE and writes against ONE DAY. Those are different
 * questions and conflating them is how a panel ends up quietly adding an entry to
 * "the range", which is not a thing an expense can belong to.
 */
export function Expenses({
  range,
  canManage,
  onView
}: {
  /** The range the whole tab is reporting on. Null is all time. */
  range: DayRange | null
  canManage: boolean
  /** A write re-derives every figure on the screen, so the panel hands the whole
   *  view back rather than letting the tab refetch and possibly disagree. */
  onView: (view: StreamingFinanceView) => void
}): JSX.Element | null {
  const toast = useToast()
  const [all, setAll] = useState<GeneralExpense[] | null>(null)
  const [editing, setEditing] = useState<GeneralExpense | 'new' | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const next = await finance.expenses()
        if (alive) setAll(next)
      } catch {
        // Deliberately quiet. Every other figure on this tab is still true, and
        // a red banner over a list that is usually empty would be the loudest
        // thing on a screen whose whole job is to flag the numbers that are
        // wrong. `all` stays null and the panel renders as empty.
        if (alive) setAll([])
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const applied = useCallback(
    (next: { expenses: GeneralExpense[]; view: StreamingFinanceView }) => {
      setAll(next.expenses)
      onView(next.view)
    },
    [onView]
  )

  const remove = useCallback(
    async (e: GeneralExpense) => {
      setBusyId(e.id)
      try {
        const res = await finance.deleteExpense(e.id)
        if (!res.ok || !res.data) {
          toast.error(resultError(res, 'That expense could not be removed.'))
          return
        }
        applied(res.data)
        toast.success(`Removed. ${shortDayLabel(e.streamDate)} gets that money back.`)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'That expense could not be removed.')
      } finally {
        setBusyId(null)
      }
    },
    [applied, toast]
  )

  // The entries inside the selected range, newest day first — the same window
  // every other figure on the tab is reported over, so the total below the
  // statement's General expenses line is the one this panel lists.
  const shown = useMemo(() => {
    const rows = all ?? []
    if (!range) return rows
    return rows.filter((e) => e.streamDate >= range.from && e.streamDate <= range.to)
  }, [all, range])

  const total = useMemo(
    () => Math.round(shown.reduce((n, e) => n + e.amount, 0) * 100) / 100,
    [shown]
  )

  // A packaged preload that predates this bridge has no `expenses` on it.
  // Rendering nothing is right here, unlike on the Rates screen: this panel is
  // an addition to a tab that works without it, so an explanatory banner would
  // be noise on every screen of an older build.
  if (typeof finance?.expenses !== 'function') return null

  const single = range && range.from === range.to ? range.from : null

  return (
    <section className="fin-expenses" aria-label="General expenses">
      <div className="fin-expenses-head">
        <span className="fin-section-title">
          <Icon name="PackageMinus" size={14} />
          Product lost &amp; write-offs
        </span>
        {shown.length > 0 && (
          <span className="fin-expenses-figure">
            <Money value={-total} strong />
            <em>{plural(shown.length, 'entry', 'entries')}</em>
          </span>
        )}
        {canManage && (
          <span className="fin-expenses-acts">
            <Button size="sm" icon="Plus" onClick={() => setEditing('new')}>
              Record a loss
            </Button>
          </span>
        )}
      </div>

      {shown.length === 0 ? (
        <p className="fin-expenses-empty">
          Nothing written off here. Use this for a dollar amount only — stock that left the shelf
          is a Streaming giveaway.
        </p>
      ) : (
        <ul className="fin-expenses-list">
          {shown.map((e) => (
            <li className="fin-expense" key={e.id}>
              <span className="fin-expense-date">{shortDayLabel(e.streamDate)}</span>
              <span className="fin-expense-label">
                {e.label}
                {e.note && <em>{e.note}</em>}
              </span>
              <Money value={-e.amount} />
              {canManage && (
                <span className="fin-expense-acts">
                  <button
                    type="button"
                    className="fin-expense-act"
                    title="Edit this entry"
                    onClick={() => setEditing(e)}
                  >
                    <Icon name="Pencil" size={13} />
                  </button>
                  <button
                    type="button"
                    className="fin-expense-act is-danger"
                    title="Remove this entry"
                    disabled={busyId === e.id}
                    onClick={() => void remove(e)}
                  >
                    <Icon name="Trash2" size={13} />
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <ExpenseModal
          expense={editing === 'new' ? null : editing}
          // The day the operator is already looking at, when they are looking at
          // exactly one. A wider range has no day to default to and the form asks
          // — guessing "today" inside a June range would file the loss three
          // months from where the person is reading.
          defaultDay={single ?? todayKey()}
          onClose={() => setEditing(null)}
          onSaved={(next) => {
            applied(next)
            setEditing(null)
          }}
        />
      )}
    </section>
  )
}

/**
 * Add or edit one entry.
 *
 * IT VALIDATES WITH THE CONTRACT'S OWN FUNCTION, the same one main runs inside
 * the write — so the operator finds out about a blank amount while they are
 * still in the field. Main re-runs it regardless: a renderer is a convenience,
 * not a trust boundary, and this number comes straight off reported profit.
 */
function ExpenseModal({
  expense,
  defaultDay,
  onClose,
  onSaved
}: {
  expense: GeneralExpense | null
  defaultDay: string
  onClose: () => void
  onSaved: (next: { expenses: GeneralExpense[]; view: StreamingFinanceView }) => void
}): JSX.Element {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [day, setDay] = useState(expense?.streamDate ?? defaultDay)
  const [amount, setAmount] = useState(expense ? String(expense.amount) : '')
  const [label, setLabel] = useState(expense?.label ?? '')
  const [note, setNote] = useState(expense?.note ?? '')

  // Number('') is 0, which would book a zero-dollar expense onto a day. It has
  // to reach the validator as NaN and be refused there rather than being
  // smoothed into something plausible here.
  const candidate = {
    id: expense?.id,
    streamDate: day,
    amount: amount.trim() === '' ? Number.NaN : Number(amount),
    label,
    note
  }
  const problem = validateGeneralExpense(candidate)

  const save = async (): Promise<void> => {
    if (problem) return
    setBusy(true)
    try {
      const res = await finance.saveExpense(candidate)
      if (!res.ok || !res.data) {
        toast.error(resultError(res, 'That expense could not be saved.'))
        return
      }
      onSaved(res.data)
      toast.success(`Booked against ${shortDayLabel(day)}. It comes off that day's profit.`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'That expense could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={expense ? 'Edit this write-off' : 'Record a loss'}
      subtitle="A dollar amount against a show day. Nothing here moves stock."
      onClose={() => (busy ? undefined : onClose())}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="Check"
            loading={busy}
            disabled={!!problem}
            onClick={() => void save()}
          >
            {expense ? 'Save the entry' : 'Record it'}
          </Button>
        </>
      }
    >
      <div className="fin-rate-form">
        <Field label="Day" hint="The SHOW night, not the calendar date it was noticed on.">
          <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </Field>
        <Field label="Amount ($)" hint="What it was worth. Positive — the statement shows it as a cost.">
          <Input
            type="number"
            step="0.01"
            min={0.01}
            max={EXPENSE_AMOUNT_MAX}
            value={amount}
            invalid={!!problem}
            placeholder="24.99"
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field label="What was it" hint="Short enough to read on a P&L line.">
          <Input
            type="text"
            maxLength={EXPENSE_LABEL_MAX}
            value={label}
            placeholder="Opened a Prizm hobby box on air"
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
        <Field label="Note" hint="Optional. Anything the label has no room for.">
          <Input
            type="text"
            maxLength={200}
            value={note}
            placeholder="Cracked for the crowd after the last break"
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
      </div>

      {problem ? (
        <Note tone="danger" icon="AlertTriangle" role="alert">
          <p>{problem}</p>
        </Note>
      ) : (
        // The one thing worth saying twice, because getting it wrong is silent.
        <Note tone="info" icon="Info">
          <p>
            Books a dollar amount and moves no stock. If it came off the shelf, log a Streaming
            giveaway instead — doing both books it twice.
          </p>
        </Note>
      )}
    </Modal>
  )
}
