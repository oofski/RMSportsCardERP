import { useCallback, useEffect, useMemo, useState } from 'react'
import type { WhatnotRatePeriod } from '@shared/financeStreaming'
import {
  DEFAULT_WHATNOT_RATE,
  STRIPE_FLAT_CENTS,
  STRIPE_PERCENT_RATE,
  WHATNOT_RATE_MAX,
  WHATNOT_RATE_MIN,
  coveringRatePeriod,
  deriveSaleFee,
  effectiveWhatnotRate,
  isDayKey,
  overlappingRatePeriod,
  validateRatePeriod
} from '@shared/financeStreaming'
import { Icon } from '../../components/Icon'
import { Button, CenterLoader, Field, Input, Modal } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { useSession } from '../../lib/session'
import { Money, Note } from './bits'
import { finance, resultError } from './api'
import { todayKey } from './time'

/**
 * Finance → Fees & rates: what Whatnot takes, and when it took it.
 *
 * WHY THIS SCREEN EXISTS, AND WHY IT IS IN FINANCE RATHER THAN ADMIN.
 *
 * Whatnot's ledger pays NET — its commission is already gone before the row is
 * written. Everything the Streaming tab shows above the fee line is therefore
 * reverse-engineered from that net figure, and the commission rate is the one
 * input to that arithmetic the app cannot read out of the file. Get it wrong and
 * every gross, every fee and every margin in the module is wrong with it.
 *
 * So it sits beside the P&L it drives rather than in Admin with the settings
 * nobody looks at twice a year. Changing it here changes the statement one tab
 * across, immediately and retroactively, and this screen says so out loud
 * because that is a surprising amount of power for a form with four fields.
 *
 * THE DEFAULT IS SHOWN, NOT IMPLIED. An empty table means 6% everywhere, which
 * used to be a constant in a file. It is printed as a real row at the bottom of
 * the list, so "what rate is being used for last March" is answerable by reading
 * the screen rather than by knowing what the code does when it finds nothing.
 */
export function RatesTab(): JSX.Element {
  const { can } = useSession()
  const canManage = can('finance.manage')
  const toast = useToast()

  const [periods, setPeriods] = useState<WhatnotRatePeriod[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [editing, setEditing] = useState<WhatnotRatePeriod | 'new' | null>(null)
  const [deleting, setDeleting] = useState<WhatnotRatePeriod | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    setError(null)
    ;(async () => {
      try {
        const next = await finance.rates()
        if (alive) setPeriods(next)
      } catch (err) {
        if (alive) {
          setError(err instanceof Error ? err.message : 'The rate periods could not be read.')
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [attempt])

  const remove = useCallback(async () => {
    if (!deleting) return
    setBusy(true)
    try {
      const res = await finance.deleteRate(deleting.id)
      if (!res.ok || !res.data) {
        toast.error(resultError(res, 'That period could not be removed.'))
        return
      }
      setPeriods(res.data)
      setDeleting(null)
      toast.success('Period removed. Those days fall back to whatever else covers them.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'That period could not be removed.')
    } finally {
      setBusy(false)
    }
  }, [deleting, toast])

  // The renderer and main ship as separate artifacts, so a packaged preload that
  // predates this screen has no `rates` on the bridge. `financeReady` only
  // vouches for `streamView`, and calling through anyway would throw on first
  // paint rather than say what is wrong.
  if (typeof finance?.rates !== 'function') {
    return (
      <Note tone="warn" icon="AlertTriangle">
        <b>Fee rates are not available in this build.</b>
        <p>
          The app is running against a version that does not expose the rate bridge. Restart after
          updating and this screen will appear. Until then every day is priced at the{' '}
          {ratePct(DEFAULT_WHATNOT_RATE)} default, which is what it was before this setting
          existed.
        </p>
      </Note>
    )
  }

  if (error) {
    return (
      <Note tone="danger" icon="AlertTriangle" role="alert">
        <b>The rate periods could not be read.</b>
        <p>{error}</p>
        <Button size="sm" icon="RefreshCw" onClick={() => setAttempt((a) => a + 1)}>
          Try again
        </Button>
      </Note>
    )
  }

  if (periods === null) return <CenterLoader />

  return (
    <div className="fin-rates">
      <section className="fin-head" aria-label="Platform fee rates">
        <div className="fin-head-top">
          <h2>Fees &amp; rates</h2>
          <span className="fin-head-scope">What the platform takes</span>
        </div>

        <p className="fin-rates-lead">
          Whatnot&rsquo;s ledger pays <b>net</b> — its cut is already gone before the row is
          written. The Streaming tab works back from that to what buyers actually paid, and this
          rate is the one number that arithmetic needs and the file does not contain.
        </p>

        <Note tone="info" icon="History">
          <b>Changing a rate changes history.</b>
          <p>
            The fee is worked out every time the P&amp;L is read, never stored on a row — so saving
            a period below immediately re-prices every show inside it. Nothing needs re-uploading
            and nothing needs re-attributing.
          </p>
        </Note>
      </section>

      <RateStack
        periods={periods}
        canManage={canManage}
        onAdd={() => setEditing('new')}
        onEdit={(p) => setEditing(p)}
        onDelete={(p) => setDeleting(p)}
      />

      <EffectiveRate periods={periods} />

      <StripePanel />

      {editing && (
        <RateModal
          periods={periods}
          period={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(next) => {
            setPeriods(next)
            setEditing(null)
          }}
        />
      )}

      {deleting && (
        <Modal
          title="Remove this rate period?"
          onClose={() => (busy ? undefined : setDeleting(null))}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleting(null)} disabled={busy}>
                Keep it
              </Button>
              <Button variant="danger" icon="Trash2" loading={busy} onClick={() => void remove()}>
                Remove the period
              </Button>
            </>
          }
        >
          <p className="fin-confirm-lead">
            <b>{spanLabel(deleting)}</b> at <b>{ratePct(deleting.rate)}</b> goes.
          </p>
          <p className="fin-confirm-lead">
            Those days fall back to whatever other period covers them, and to the{' '}
            {ratePct(DEFAULT_WHATNOT_RATE)} default if none does. Every show in that stretch is
            re-priced the next time the Streaming tab is opened.
          </p>
        </Modal>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/**
 * The periods, earliest first, with the default underneath them.
 *
 * The default is a ROW rather than a sentence because it is what actually
 * applies to most of the calendar — RM has never changed a rate — and a screen
 * whose only content is "no periods configured" does not answer the question the
 * operator came here with.
 */
function RateStack({
  periods,
  canManage,
  onAdd,
  onEdit,
  onDelete
}: {
  periods: WhatnotRatePeriod[]
  canManage: boolean
  onAdd: () => void
  onEdit: (p: WhatnotRatePeriod) => void
  onDelete: (p: WhatnotRatePeriod) => void
}): JSX.Element {
  const sorted = useMemo(
    () => [...periods].sort((a, b) => a.fromDate.localeCompare(b.fromDate)),
    [periods]
  )

  return (
    <section className="fin-rate-list">
      <div className="fin-imports-head">
        <span className="fin-section-title">
          <Icon name="Percent" size={15} />
          Whatnot commission
          <span className="fin-count">{sorted.length}</span>
        </span>
        {canManage && (
          <Button size="sm" variant="secondary" icon="Plus" onClick={onAdd}>
            Add a period
          </Button>
        )}
      </div>

      {sorted.map((p) => (
        <article key={p.id} className="fin-rate">
          <div className="fin-rate-main">
            <b className="fin-rate-figure mono">{ratePct(p.rate)}</b>
            <span className="fin-rate-span">{spanLabel(p)}</span>
            {p.toDate === null && <span className="fin-rate-tag">In force</span>}
          </div>
          {p.note && <p className="fin-rate-note">{p.note}</p>}
          {canManage && (
            <div className="fin-rate-acts">
              <button type="button" className="fin-more" onClick={() => onEdit(p)}>
                <Icon name="Pencil" size={14} />
                Edit
              </button>
              <button type="button" className="fin-more is-danger" onClick={() => onDelete(p)}>
                <Icon name="Trash2" size={14} />
                Remove
              </button>
            </div>
          )}
        </article>
      ))}

      <article className="fin-rate is-default">
        <div className="fin-rate-main">
          <b className="fin-rate-figure mono">{ratePct(DEFAULT_WHATNOT_RATE)}</b>
          <span className="fin-rate-span">Every other day</span>
          <span className="fin-rate-tag is-muted">Default</span>
        </div>
        <p className="fin-rate-note">
          What the app uses wherever no period above covers a date. It is not a row and cannot be
          edited or removed — add a period to override a stretch of days.
        </p>
      </article>

      {!canManage && (
        <p className="fin-blank-gate">
          Editing rates needs the <b>Manage finance data</b> permission.
        </p>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// "What was the rate on…"
// ---------------------------------------------------------------------------

/**
 * The list answers "what have we configured". This answers the question somebody
 * actually walks up with: what rate is a particular show being charged at, and
 * which row decided that.
 *
 * It reads the SAME `effectiveWhatnotRate` and `deriveSaleFee` the P&L does, so
 * the worked example under it is not an illustration — it is the arithmetic,
 * running.
 */
function EffectiveRate({ periods }: { periods: WhatnotRatePeriod[] }): JSX.Element {
  const [day, setDay] = useState(() => todayKey())
  const valid = isDayKey(day)

  const rate = valid ? effectiveWhatnotRate(periods, day) : DEFAULT_WHATNOT_RATE
  const covering = valid ? coveringRatePeriod(periods, day) : null

  // A $100 spot, taken apart exactly as a real row would be. Concrete on purpose:
  // "6% plus 2.9% plus 30c" is three numbers nobody can hold, and a worked
  // hundred dollars is one anybody can check.
  const example = deriveSaleFee(10000, rate)

  return (
    <section className="fin-rate-check">
      <span className="fin-section-title">
        <Icon name="CalendarSearch" size={15} />
        The rate on a given day
      </span>

      <div className="fin-rate-check-row">
        <Field label="Business day">
          <Input
            type="date"
            value={day}
            invalid={!valid}
            onChange={(e) => setDay(e.target.value)}
          />
        </Field>
        <p className="fin-rate-check-answer">
          <b className="mono">{ratePct(rate)}</b>{' '}
          {covering ? (
            <>
              from <b>{spanLabel(covering)}</b>
              {covering.note ? ` — ${covering.note}` : ''}
            </>
          ) : (
            <>
              — the <b>{ratePct(DEFAULT_WHATNOT_RATE)} default</b>, because no period covers this
              day
            </>
          )}
        </p>
      </div>

      <p className="fin-rate-worked">
        A spot that paid out <Money value={100} /> on that day was bought for{' '}
        <Money value={example.grossCents / 100} strong />: Whatnot took{' '}
        <Money value={Math.abs(example.whatnotFeeCents) / 100} /> and Stripe took{' '}
        <Money value={Math.abs(example.stripeFeeCents) / 100} /> (2.9% and 30¢).
      </p>
    </section>
  )
}

/**
 * Stripe, stated and not editable.
 *
 * A screen that offers to configure one of two fees, with no explanation of the
 * other, invites somebody to go looking for the missing setting. It is here to
 * say the number and to say why it has no form.
 */
function StripePanel(): JSX.Element {
  return (
    <section className="fin-rate-stripe">
      <span className="fin-section-title">
        <Icon name="CreditCard" size={15} />
        Card processing
      </span>
      <p>
        <b className="mono">{(STRIPE_PERCENT_RATE * 100).toFixed(1)}%</b> of the sale plus{' '}
        <b className="mono">{STRIPE_FLAT_CENTS}¢</b> per purchased slot. Fixed, and deliberately not
        configurable: it is Stripe&rsquo;s published card rate rather than a term RM negotiates, and
        the flat charge is what makes one break spot cost more to process than one line of a bulk
        order.
      </p>
    </section>
  )
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

/**
 * Add or edit one period.
 *
 * IT VALIDATES WITH THE CONTRACT'S OWN FUNCTIONS — `validateRatePeriod` and
 * `overlappingRatePeriod`, the same two main runs inside the write transaction.
 * That is so the operator finds out about a bad date or a collision while they
 * are still looking at the field, not so main can skip the check: main re-runs
 * both against the stored rows, because a renderer is not a trust boundary and
 * another laptop may have saved something in the meantime.
 *
 * The rate is entered as a PERCENTAGE, because that is how Whatnot writes it in
 * the seller agreement, and converted here. A form that took 0.06 would collect
 * a 6 from somebody eventually — a 600% commission, which the validator would
 * refuse, but only after they had wondered why.
 */
function RateModal({
  periods,
  period,
  onClose,
  onSaved
}: {
  periods: WhatnotRatePeriod[]
  period: WhatnotRatePeriod | null
  onClose: () => void
  onSaved: (next: WhatnotRatePeriod[]) => void
}): JSX.Element {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [fromDate, setFromDate] = useState(period?.fromDate ?? todayKey())
  const [toDate, setToDate] = useState(period?.toDate ?? '')
  const [percent, setPercent] = useState(
    period ? String(Math.round(period.rate * 10000) / 100) : String(DEFAULT_WHATNOT_RATE * 100)
  )
  const [note, setNote] = useState(period?.note ?? '')

  // Number('') is 0 and Number('6%') is NaN. Both have to reach the validator as
  // themselves rather than being smoothed into something plausible — a blank
  // field must not book a 0% commission.
  const rate = percent.trim() === '' ? Number.NaN : Number(percent) / 100
  const candidate = { fromDate, toDate: toDate.trim() === '' ? null : toDate, rate, note }

  const invalid = validateRatePeriod(candidate)
  const clash = invalid ? null : overlappingRatePeriod(periods, candidate, period?.id)
  const problem = invalid
    ? invalid
    : clash
      ? `That range overlaps ${spanLabel(clash)} at ${ratePct(clash.rate)}. Two periods cannot ` +
        `both claim a day — narrow one of them, or edit that period instead.`
      : null

  const save = async (): Promise<void> => {
    if (problem) return
    setBusy(true)
    try {
      const res = await finance.saveRate({
        id: period?.id,
        fromDate: candidate.fromDate,
        toDate: candidate.toDate,
        rate: candidate.rate,
        note: candidate.note
      })
      if (!res.ok || !res.data) {
        toast.error(resultError(res, 'That period could not be saved.'))
        return
      }
      onSaved(res.data)
      toast.success(
        `${ratePct(candidate.rate)} saved. Every show in that range is re-priced from now on.`
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'That period could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={period ? 'Edit this rate period' : 'Add a rate period'}
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
            {period ? 'Save the period' : 'Add the period'}
          </Button>
        </>
      }
    >
      <div className="fin-rate-form">
        <Field label="From" hint="Inclusive. The first business day at this rate.">
          <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        </Field>
        <Field label="To" hint="Inclusive. Leave blank for the rate still in force.">
          <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </Field>
        <Field
          label="Commission (%)"
          hint={`What Whatnot takes of each sale. ${WHATNOT_RATE_MIN * 100}–${
            WHATNOT_RATE_MAX * 100
          }%.`}
        >
          <Input
            type="number"
            step="0.01"
            min={WHATNOT_RATE_MIN * 100}
            max={WHATNOT_RATE_MAX * 100}
            value={percent}
            invalid={!!invalid}
            onChange={(e) => setPercent(e.target.value)}
          />
        </Field>
        <Field label="Note" hint="Why this rate — the agreement it came from, or the email.">
          <Input
            type="text"
            maxLength={200}
            value={note}
            placeholder="Seller agreement, July renegotiation…"
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
      </div>

      {problem ? (
        <Note tone="danger" icon="AlertTriangle" role="alert">
          <p>{problem}</p>
        </Note>
      ) : (
        <p className="fin-confirm-lead">
          Saving this re-prices every show between those dates the next time the Streaming tab is
          read. A $100 payout on one of those days becomes a{' '}
          <Money value={deriveSaleFee(10000, rate).grossCents / 100} strong /> sale.
        </p>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------

/** "6%", "6.5%" — two decimals at most, trailing zeros dropped. */
function ratePct(rate: number): string {
  const pct = Math.round(rate * 10000) / 100
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2)}%`
}

function dayLabel(day: string): string {
  const [y, m, d] = (day || '').split('-').map(Number)
  if (!y || !m || !d) return day
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${d} ${MON[m - 1]} ${y}`
}

function spanLabel(p: { fromDate: string; toDate: string | null }): string {
  return p.toDate ? `${dayLabel(p.fromDate)} – ${dayLabel(p.toDate)}` : `${dayLabel(p.fromDate)} onwards`
}
