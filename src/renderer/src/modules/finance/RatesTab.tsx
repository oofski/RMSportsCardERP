import { useCallback, useEffect, useMemo, useState } from 'react'
import type { WhatnotRatePeriod } from '@shared/financeStreaming'
import {
  COMMISSION_RATE_MAX,
  COMMISSION_RATE_MIN,
  DEFAULT_FEE_RATES,
  PROCESSING_FLAT_MAX_CENTS,
  PROCESSING_FLAT_MIN_CENTS,
  PROCESSING_RATE_MAX,
  PROCESSING_RATE_MIN,
  TAX_RATE_MAX,
  TAX_RATE_MIN,
  coveringRatePeriod,
  deriveSaleFee,
  effectiveFeeRates,
  isDayKey,
  overlappingRatePeriod,
  ratePct,
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
 * Finance → Fees & rates: what the platform takes, and when it took it.
 *
 * WHY THIS SCREEN EXISTS, AND WHY IT IS IN FINANCE RATHER THAN ADMIN.
 *
 * Whatnot's ledger pays NET — every charge is already gone before the row is
 * written. Everything the Streaming tab shows above the fee line is therefore
 * recovered from that net figure, and the four terms here are the inputs to that
 * arithmetic the app cannot read out of the file. Get one wrong and every gross,
 * every fee and every margin in the module is wrong with it.
 *
 * So it sits beside the P&L it drives rather than in Admin with the settings
 * nobody looks at twice a year. Changing anything here changes the statement one
 * tab across, immediately and retroactively, and this screen says so out loud
 * because that is a surprising amount of power for one small form.
 *
 * THE DEFAULTS ARE SHOWN, NOT IMPLIED. An empty table means the standard terms
 * everywhere, which used to be constants in a file. They are printed as a real
 * row at the bottom of the list, so "what was being used for last March" is
 * answerable by reading the screen rather than by knowing what the code does
 * when it finds nothing.
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
      toast.success('Period removed. Those nights fall back to whatever else covers them.')
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
          This build has no rate bridge. Every day is priced at the{' '}
          {ratePct(DEFAULT_FEE_RATES.commissionRate)} default until you update.
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

        {/* THREE STANDING PANELS USED TO SIT HERE and they now live where each
            one is actually needed. Sales tax being in the list because the card
            fee is charged on it is a fact about the SALES TAX FIELD, and it is
            its hint. Dates being show nights rather than calendar days is a fact
            about the FROM and TO FIELDS, and it is their hints. And "changing a
            rate re-prices history" is said by the save confirmation in the form
            below, at the moment somebody is about to do it — which is the only
            moment it changes anybody's mind. */}
        <p className="fin-rates-lead">
          Whatnot pays net. These four numbers are what the app needs to work back to the price the
          buyer bid.
        </p>
      </section>

      <RateStack
        periods={periods}
        canManage={canManage}
        onAdd={() => setEditing('new')}
        onEdit={(p) => setEditing(p)}
        onDelete={(p) => setDeleting(p)}
      />

      <EffectiveRate periods={periods} />

      <ProcessingPanel />

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
            <b>{spanLabel(deleting)}</b> at <b>{ratePct(deleting.rate)}</b> commission,{' '}
            <b>{ratePct(deleting.taxRate)}</b> tax and{' '}
            <b>
              {ratePct(deleting.processingRate)} + {deleting.processingFlatCents}¢
            </b>{' '}
            processing goes.
          </p>
          <p className="fin-confirm-lead">
            Those nights fall back to any other period, or the defaults, and are re-priced on next
            read.
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
          Platform terms
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
          {/* All four, on the row. The commission is the headline because it is
              the one that moves; a period whose card terms differ from the
              others is exactly the thing somebody needs to see without opening
              the form. */}
          <p className="fin-rate-terms mono">{termsLabel(p)}</p>
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
          <b className="fin-rate-figure mono">{ratePct(DEFAULT_FEE_RATES.commissionRate)}</b>
          <span className="fin-rate-span">Every other night</span>
          <span className="fin-rate-tag is-muted">Default</span>
        </div>
        <p className="fin-rate-terms mono">{termsLabel(DEFAULT_TERMS)}</p>
        <p className="fin-rate-note">
          Used for any show night no period covers. Add a period to override it.
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
 * actually walks up with: what was a particular show charged, and which row
 * decided that.
 *
 * It reads the SAME `effectiveFeeRates` and `deriveSaleFee` the P&L does, and —
 * since the statement prices a row by its show's business day — it is asking
 * those functions the SAME KIND OF KEY. So the worked example under it is not an
 * illustration, it is the arithmetic the Streaming tab will run for that night,
 * running.
 */
function EffectiveRate({ periods }: { periods: WhatnotRatePeriod[] }): JSX.Element {
  const [day, setDay] = useState(() => todayKey())
  const valid = isDayKey(day)

  const rates = valid ? effectiveFeeRates(periods, day) : DEFAULT_FEE_RATES
  const covering = valid ? coveringRatePeriod(periods, day) : null

  // A $100 payout, taken apart exactly as a real row would be, by the function
  // that takes real rows apart. Concrete on purpose: four rates on four
  // different bases is more than anybody holds in their head, and a worked
  // hundred dollars is something anybody can check with a calculator.
  const example = deriveSaleFee(10000, rates)
  const bid = (example.itemCents ?? 0) / 100

  return (
    <section className="fin-rate-check">
      <span className="fin-section-title">
        <Icon name="CalendarSearch" size={15} />
        The terms on a given show night
      </span>

      <div className="fin-rate-check-row">
        <Field label="Show night" hint="The night a show started on.">
          <Input
            type="date"
            value={day}
            invalid={!valid}
            onChange={(e) => setDay(e.target.value)}
          />
        </Field>
        <p className="fin-rate-check-answer">
          <b className="mono">{ratePct(rates.commissionRate)}</b>{' '}
          {covering ? (
            <>
              from <b>{spanLabel(covering)}</b>
              {covering.note ? ` — ${covering.note}` : ''}
            </>
          ) : (
            <>
              — the <b>{ratePct(DEFAULT_FEE_RATES.commissionRate)} default</b>, because no period
              covers this day
            </>
          )}
          <br />
          <span className="mono">{termsLabel(covering ?? DEFAULT_TERMS)}</span>
        </p>
      </div>

      {example.exact ? (
        <p className="fin-rate-worked">
          A <Money value={100} /> payout that night was bid up to <Money value={bid} strong />:{' '}
          <Money value={Math.abs(example.whatnotFeeCents) / 100} /> commission,{' '}
          <Money value={Math.abs(example.processingFeeCents) / 100} /> processing,{' '}
          <Money value={example.taxCents / 100} /> tax to the state.
        </p>
      ) : (
        // The inverse could not reproduce this payout at these terms. It is not
        // reachable with any sane set of rates, but saying so beats printing a
        // bid nobody made — which is the whole reason the model reports whether
        // it reproduced the payout rather than just returning a number.
        <Note tone="warn" icon="AlertTriangle">
          <b>No bid produces a $100.00 payout on these terms.</b>
          <p>
            The Streaming tab will still show figures that reconcile to what Whatnot paid, but the
            sale prices behind them are approximate at these rates. Check the four numbers above
            against a Whatnot statement.
          </p>
        </Note>
      )}
    </section>
  )
}

/**
 * Card processing, and why it is not simply a percentage of the sale.
 *
 * This panel used to say the card terms were fixed and deliberately not
 * configurable. That was wrong twice over: the platform changes what it passes
 * on, and the charge is levied on the ORDER — sale plus tax — rather than on the
 * sale, so a reader comparing the fee line to 2.9% of the gross would find it
 * short every time and go looking for a bug. Both are now stated here, and all
 * four terms are editable in the form above.
 */
function ProcessingPanel(): JSX.Element {
  return (
    <section className="fin-rate-stripe">
      <span className="fin-section-title">
        <Icon name="CreditCard" size={15} />
        Card processing
      </span>
      <p>A percentage of the whole order — sale plus tax — plus a flat charge per order.</p>
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
 * The rates are entered as PERCENTAGES, because that is how Whatnot writes them
 * in the seller agreement and how a state writes a tax rate, and converted here.
 * A form that took 0.08 would collect an 8 from somebody eventually — an 800%
 * commission, which the validator would refuse, but only after they had wondered
 * why. The flat charge is entered in CENTS for the mirror-image reason: 0.30 in
 * a field labelled cents is thirty hundredths of a cent.
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
  const pct = (fraction: number): string => String(Math.round(fraction * 10000) / 100)
  const [percent, setPercent] = useState(
    pct(period ? period.rate : DEFAULT_FEE_RATES.commissionRate)
  )
  const [taxPercent, setTaxPercent] = useState(
    pct(period ? period.taxRate : DEFAULT_FEE_RATES.taxRate)
  )
  const [procPercent, setProcPercent] = useState(
    pct(period ? period.processingRate : DEFAULT_FEE_RATES.processingRate)
  )
  const [flatCents, setFlatCents] = useState(
    String(period ? period.processingFlatCents : DEFAULT_FEE_RATES.processingFlatCents)
  )
  const [note, setNote] = useState(period?.note ?? '')

  // Number('') is 0 and Number('8%') is NaN. Both have to reach the validator as
  // themselves rather than being smoothed into something plausible — a blank
  // field must not book a 0% commission, or a 0% tax that shifts every
  // processing fee on the range.
  const asRate = (text: string): number =>
    text.trim() === '' ? Number.NaN : Number(text) / 100
  const rate = asRate(percent)
  const candidate = {
    fromDate,
    toDate: toDate.trim() === '' ? null : toDate,
    rate,
    taxRate: asRate(taxPercent),
    processingRate: asRate(procPercent),
    processingFlatCents: flatCents.trim() === '' ? Number.NaN : Number(flatCents),
    note
  }

  // The candidate as the MODEL sees it, so the preview below is the same
  // arithmetic the P&L will run rather than a second version of it. Shipping is
  // zero because a rate period cannot know what one buyer paid for postage.
  const candidateRates = {
    commissionRate: candidate.rate,
    taxRate: candidate.taxRate,
    processingRate: candidate.processingRate,
    processingFlatCents: candidate.processingFlatCents,
    shippingCents: 0
  }

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
        taxRate: candidate.taxRate,
        processingRate: candidate.processingRate,
        processingFlatCents: candidate.processingFlatCents,
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
        {/* Both dates are SHOW NIGHTS, not calendar days, and the two hints are
            where that used to be a standing panel above the list. A show that
            starts at 9pm and ends at 2am is one show at one rate, counted on the
            night it started. */}
        <Field
          label="From"
          hint="Inclusive. The first show NIGHT at this rate — a show counts on the night it started."
        >
          <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        </Field>
        <Field
          label="To"
          hint="Inclusive — the last show night, after-midnight hours included. Blank for the rate still in force."
        >
          <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </Field>
        <Field
          label="Commission (%)"
          hint={`What Whatnot takes of the SALE PRICE — not of shipping or tax. ${
            COMMISSION_RATE_MIN * 100
          }–${COMMISSION_RATE_MAX * 100}%.`}
        >
          <Input
            type="number"
            step="0.01"
            min={COMMISSION_RATE_MIN * 100}
            max={COMMISSION_RATE_MAX * 100}
            value={percent}
            invalid={!!invalid}
            onChange={(e) => setPercent(e.target.value)}
          />
        </Field>
        <Field
          label="Sales tax (%)"
          // Never revenue and never a cost — it is configured here only because
          // the card fee is charged on it. That used to be a panel of its own
          // above the list; it belongs on the field it is about.
          hint={`What the BUYER pays on top — the state gets it, and it is in no P&L figure. It is here because card processing is charged on it. ${
            TAX_RATE_MIN * 100
          }–${TAX_RATE_MAX * 100}%.`}
        >
          <Input
            type="number"
            step="0.0001"
            min={TAX_RATE_MIN * 100}
            max={TAX_RATE_MAX * 100}
            value={taxPercent}
            invalid={!!invalid}
            onChange={(e) => setTaxPercent(e.target.value)}
          />
        </Field>
        <Field
          label="Card processing (%)"
          hint={`Charged on the whole order, tax included. ${PROCESSING_RATE_MIN * 100}–${
            PROCESSING_RATE_MAX * 100
          }%.`}
        >
          <Input
            type="number"
            step="0.01"
            min={PROCESSING_RATE_MIN * 100}
            max={PROCESSING_RATE_MAX * 100}
            value={procPercent}
            invalid={!!invalid}
            onChange={(e) => setProcPercent(e.target.value)}
          />
        </Field>
        <Field
          label="Card flat charge (¢)"
          hint={`Per ORDER, in cents — 30, not 0.30. ${PROCESSING_FLAT_MIN_CENTS}–${PROCESSING_FLAT_MAX_CENTS}¢.`}
        >
          <Input
            type="number"
            step="1"
            min={PROCESSING_FLAT_MIN_CENTS}
            max={PROCESSING_FLAT_MAX_CENTS}
            value={flatCents}
            invalid={!!invalid}
            onChange={(e) => setFlatCents(e.target.value)}
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
          Saving this re-prices every show that started on one of those nights — all of it, the
          after-midnight hours included — the next time the Streaming tab is read. A $100 payout on
          one of those shows becomes a{' '}
          <Money value={deriveSaleFee(10000, candidateRates).grossCents / 100} strong /> sale.
        </p>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
//
// `ratePct` used to live here. It is the contract's now, and imported rather
// than copied, because the P&L's commission line prints the same rates this
// screen does — "6.25%" here and "6.3%" one tab across is the same "matches
// nothing configured" complaint the blended-rate disclosure exists for.

/**
 * The three terms that are not the headline, in one line: "tax 5.18% · card
 * 2.9% + 30¢".
 *
 * Shared by the list, the default row and the effective-terms answer so the same
 * period cannot be spelled two ways on one screen — the same reason `ratePct`
 * moved into the contract.
 */
function termsLabel(p: {
  taxRate: number
  processingRate: number
  processingFlatCents: number
}): string {
  return `tax ${ratePct(p.taxRate)} · card ${ratePct(p.processingRate)} + ${p.processingFlatCents}¢`
}

/** The defaults, shaped like a period so `termsLabel` takes them unchanged. */
const DEFAULT_TERMS = {
  taxRate: DEFAULT_FEE_RATES.taxRate,
  processingRate: DEFAULT_FEE_RATES.processingRate,
  processingFlatCents: DEFAULT_FEE_RATES.processingFlatCents
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
