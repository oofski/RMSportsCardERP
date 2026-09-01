import { useCallback, useEffect, useMemo, useState } from 'react'
import type { StreamDayFinance, WhatnotRatePeriod } from '@shared/financeStreaming'
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
import { compactDayLabel, todayKey } from './time'
import { reconInRange, reconRows, reconTotals, type ReconRow } from '@shared/pnlRecon'
import {
  fitFromGross,
  fitStatement,
  fitVerdict,
  grossFitVerdict,
  type StatementFit,
  payoutCheck
} from '@shared/statementFit'

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

      <DayCoverage periods={periods} onSaved={setPeriods} />

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

/**
 * EVERY NIGHT, WHAT WAS PAID, WHAT THE APP MADE OF IT, AND AT WHOSE RATE.
 *
 * The owner's words: "all I am doing is taking the net payments, asking for the
 * revenue projection, and then looking at cost of goods sold" — and the two
 * numbers would not tie. This is that sum, laid out one night at a time, so the
 * night that does not tie can be pointed at instead of argued about.
 *
 * ## Why it lives on the RATES tab
 *
 * Because of the specific thing it catches. A rate period covers a DATE RANGE,
 * and `effectiveFeeRates` falls back to the built-in 8% for any business day no
 * period covers. The list above shows what somebody entered and looks perfectly
 * correct; it cannot show the GAPS BETWEEN the periods, and a gap is exactly
 * where a night gets priced at a rate nobody chose. So this asks the question
 * from the other end — start at the nights that took money, and say which terms
 * each one was actually charged under.
 *
 * Reading it: `Net paid` is the only column that is a RECORD rather than a
 * model. It is the ledger's own figure, the number that was uploaded, and it
 * should match Whatnot to the cent. `Revenue` is that same money with the
 * modelled fees added back, and it is the one column a wrong rate moves.
 */
function DayCoverage({
  periods,
  onSaved
}: {
  periods: WhatnotRatePeriod[]
  /** Hands the re-read list up, so saving a fitted rate refreshes the table
   *  above rather than leaving the screen showing terms it no longer uses. */
  onSaved: (next: WhatnotRatePeriod[]) => void
}): JSX.Element | null {
  const [days, setDays] = useState<StreamDayFinance[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  useEffect(() => {
    let alive = true
    void finance
      .streamView()
      .then((v) => {
        if (alive) setDays(Array.isArray(v?.days) ? v.days : [])
      })
      .catch(() => {
        // No ledger imported yet is the ordinary state of a fresh install. The
        // rate list above is still worth showing, so this panel simply is not.
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [])

  const all = useMemo(() => reconRows(days ?? [], periods), [days, periods])
  const rows = useMemo(() => reconInRange(all, from, to), [all, from, to])
  const totals = useMemo(() => reconTotals(rows), [rows])

  if (failed || days === null) return null
  if (all.length === 0) return null

  return (
    <section className="fin-recon" aria-label="Night by night">
      <div className="fin-head-top">
        <h3>Night by night</h3>
        <span className="fin-head-scope">What was paid, what it grossed, what it cost</span>
      </div>

      <p className="fin-rates-lead">
        <b>Net paid</b> is the ledger&rsquo;s own figure — the money that was uploaded, and the one
        column here that is a record rather than a model. It should match Whatnot to the cent.{' '}
        <b>Revenue</b> is that same money with the fees below added back on, so it is the column a
        wrong rate moves. Everything else follows from those two.
      </p>

      {/* THE FINDING THIS PANEL EXISTS FOR, said before the table rather than
          left for somebody to spot in a column of forty rows. A gap between two
          rate periods is invisible in the list above — it is the absence of a
          row, not a row — and this is the only place in the app it becomes
          visible. Sized in MONEY, not in nights: four uncovered Tuesdays that
          took $40 is a footnote, one uncovered Saturday that took $60,000 is the
          entire discrepancy, and a count cannot tell those apart. */}
      {totals.uncoveredDays > 0 && (
        <Note tone="warn" icon="AlertTriangle">
          <b>
            {totals.uncoveredDays} night{totals.uncoveredDays === 1 ? '' : 's'} here{' '}
            {totals.uncoveredDays === 1 ? 'is' : 'are'} not covered by any rate period above.
          </b>
          <p>
            {totals.uncoveredDays === 1 ? 'It was' : 'They were'} priced at the built-in{' '}
            {ratePct(DEFAULT_FEE_RATES.commissionRate)} default, not at a rate anybody chose —{' '}
            <Money value={totals.uncoveredNetPaid} strong /> of takings between{' '}
            {totals.uncoveredDays === 1 ? 'it' : 'them'}. The revenue figure for those nights is
            wrong by whatever the real rate differs by. Extend a period to cover them, or add one.
          </p>
        </Note>
      )}

      <div className="fin-recon-range">
        <label>
          <span>From</span>
          <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          <span>To</span>
          <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        {(from || to) && (
          <button type="button" className="fin-more" onClick={() => { setFrom(''); setTo('') }}>
            <Icon name="X" size={13} /> Clear
          </button>
        )}
        <span className="fin-recon-count">
          {rows.length} night{rows.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="fin-recon-scroll">
        <table className="data fin-recon-table">
          <thead>
            <tr>
              <th scope="col">Night</th>
              <th scope="col" className="num">Net paid</th>
              <th scope="col" className="num">Revenue</th>
              <th scope="col" className="num">Commission</th>
              <th scope="col" className="num">Card fee</th>
              <th scope="col" className="num">Cost of goods</th>
              <th scope="col" className="num">Net profit</th>
              <th scope="col">Rate used</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r: ReconRow) => (
              <tr key={r.day} className={r.covered ? undefined : 'is-uncovered'}>
                <td className="mono">{compactDayLabel(r.day)}</td>
                <td className="num"><Money value={r.netPaid} /></td>
                <td className="num"><Money value={r.grossSales} /></td>
                <td className="num"><Money value={r.commission} /></td>
                <td className="num"><Money value={r.processing} /></td>
                {/* A NIGHT WITH NO COST IS SHOWN AS A DASH, NOT AS $0.00. Zero
                    reads as "nothing was broken"; the dash reads as "nobody said
                    what was broken", and on this table those are the two answers
                    somebody is trying to tell apart. */}
                <td className="num">
                  {r.cogs === 0 ? <span className="muted">—</span> : <Money value={r.cogs} />}
                </td>
                <td className="num"><Money value={r.netProfit} strong /></td>
                <td>
                  {r.rate === null ? (
                    <span className="muted">no sales</span>
                  ) : r.covered ? (
                    <span title={r.periodNote ?? 'From a rate period you set'}>
                      {ratePct(r.rate)}
                    </span>
                  ) : (
                    <span className="fin-recon-fallback" title="No rate period covers this night">
                      <Icon name="AlertTriangle" size={12} /> {ratePct(r.rate)} default
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              <td className="num"><Money value={totals.netPaid} strong /></td>
              <td className="num"><Money value={totals.grossSales} strong /></td>
              <td className="num"><Money value={totals.commission} strong /></td>
              <td className="num"><Money value={totals.processing} strong /></td>
              <td className="num"><Money value={totals.cogs} strong /></td>
              <td className="num"><Money value={totals.netProfit} strong /></td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="fin-rates-lead">
        Set the two dates to whatever window a statement covers and the total row is the figure to
        compare against it. Whatnot&rsquo;s own statement periods do not always run to a calendar
        month, so matching the window is the first thing to check when two numbers disagree.
      </p>

      <RevenueCheck
        totals={totals}
        periods={periods}
        from={from}
        to={to}
        onSaved={onSaved}
      />

      <StatementCheck totals={totals} taxRate={effTax(periods, to || from)} />
    </section>
  )
}

/** The tax rate in force at one end of the window, or the default. */
function effTax(periods: WhatnotRatePeriod[], day: string): number {
  const p = day ? periods.find((x) => x.fromDate <= day && (!x.toDate || x.toDate >= day)) : null
  return p ? p.taxRate : DEFAULT_FEE_RATES.taxRate
}

/**
 * ONE NUMBER IS ENOUGH: type what the platform says the window sold.
 *
 * ## Why this exists beside the three-figure check below
 *
 * `StatementCheck` needs sales, commission and processing off a real statement
 * and solves both rates at once. It is the better tool when somebody is holding
 * that document. They usually are not. Whatnot's dashboard states SALES and
 * nothing else, and a 1099 states gross and nothing else — so the case that
 * actually comes up had nowhere to go, and the owner watching revenue run
 * $15-25k a month over Whatnot's own figure had exactly one number to offer.
 *
 * One is enough because the window is not three unknowns. The ledger already
 * supplies two of them: the net is a RECORD — the column that was uploaded, the
 * one that reconciles to the bank — and so is the order count. Only the
 * commission is unknown, and one equation solves it. See `fitFromGross`.
 *
 * ## It solves the commission and pins the rest
 *
 * Because the commission is the term that actually moves: negotiated, revised,
 * and different by what is being sold. The card percentage is a processor's
 * published number a seller does not negotiate, so pinning the term that does
 * not vary is what makes the answer a point rather than a line.
 *
 * ## NOTHING IS SAVED BY LOOKING
 *
 * Running the check changes no figure anywhere. Saving the fitted rate is a
 * separate button and a separate decision, because it re-prices every night in
 * the window the moment it lands — and somebody who was only checking must not
 * discover that by finding their history moved.
 */
function RevenueCheck({
  totals,
  periods,
  from,
  to,
  onSaved
}: {
  totals: { netPaid: number; grossSales: number; orders: number }
  periods: WhatnotRatePeriod[]
  from: string
  to: string
  onSaved: (next: WhatnotRatePeriod[]) => void
}): JSX.Element {
  const toast = useToast()
  const [stated, setStated] = useState('')
  const [paidOut, setPaidOut] = useState('')
  const [busy, setBusy] = useState(false)

  const num = (v: string): number => {
    const x = Number((v || '').replace(/[^0-9.-]/g, ''))
    return Number.isFinite(x) ? x : 0
  }
  const filled = stated.trim() !== ''

  // The terms held fixed come from the window's own dates rather than the
  // defaults, so a period that already sets a card rate is respected.
  const pinned = useMemo(() => {
    const r = effectiveFeeRates(periods, to || from || todayKey())
    return {
      processingRate: r.processingRate,
      taxRate: r.taxRate,
      processingFlatCents: r.processingFlatCents
    }
  }, [periods, from, to])

  const fit = useMemo(
    () =>
      filled
        ? fitFromGross(
            num(stated),
            { netPaid: totals.netPaid, derivedRevenue: totals.grossSales, orders: totals.orders },
            pinned
          )
        : null,
    [filled, stated, totals, pinned]
  )
  const verdict = fit ? grossFitVerdict(fit) : null

  /**
   * THE UPSTREAM CHECK, and it runs whether or not a sales figure was typed.
   *
   * Both sides are RECORDED — the ledger's own Amount column and the money the
   * platform actually sent — so unlike the fit it contains no fee schedule and
   * cannot be wrong for a fee schedule's reasons. When it disagrees, no
   * commission rate can be right, because the app is holding a different set of
   * orders from the one the statement is about. See payoutCheck.
   */
  const paid = useMemo(
    () => (paidOut.trim() === '' ? null : payoutCheck(totals.netPaid, num(paidOut))),
    [paidOut, totals.netPaid]
  )

  const applyRate = async (): Promise<void> => {
    if (!fit?.solvable || !from || !to) return
    setBusy(true)
    try {
      const res = await finance.saveRate({
        fromDate: from,
        toDate: to,
        rate: fit.fittedCommissionRate,
        taxRate: pinned.taxRate,
        processingRate: pinned.processingRate,
        processingFlatCents: pinned.processingFlatCents,
        note: `Fitted to a stated ${fmtMoney(fit.statedGross)}`
      })
      if (!res.ok) {
        toast.error(resultError(res, 'That rate could not be saved.'))
        return
      }
      onSaved(res.data ?? [])
      toast.success('Saved. Every night in this window is now priced on those terms.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="fin-fit" aria-label="Check revenue against a stated figure">
      <div className="fin-head-top">
        <h3>Check revenue against Whatnot</h3>
        <span className="fin-head-scope">One figure, and it solves the commission</span>
      </div>
      <p className="fin-rates-lead">
        Revenue on the Streaming tab is <b>worked out, not recorded</b> — Whatnot states only what it
        paid, and the price a buyer bid is that figure with the fees added back. Type what Whatnot
        says this window <b>sold</b> and this works out the commission that would reproduce it.
        Nothing changes until you choose to save it.
      </p>

      <div className="fin-fit-inputs">
        <label>
          <span>Whatnot says this window sold</span>
          <input
            className="input"
            inputMode="decimal"
            placeholder="306977.00"
            value={stated}
            onChange={(e) => setStated(e.target.value)}
          />
        </label>
        {/* THE PAYOUT, beside the sales figure and answering a different
            question. Sales is a total Whatnot computed; the payout is money that
            moved, and the app has a figure of the same kind. Optional, because a
            dashboard reading states sales alone — but when it is to hand it is
            the more useful of the two, and it is checked first. */}
        <label>
          <span>
            And paid out <span className="fin-fit-opt">optional</span>
          </span>
          <input
            className="input"
            inputMode="decimal"
            placeholder="369362.53"
            value={paidOut}
            onChange={(e) => setPaidOut(e.target.value)}
          />
        </label>
      </div>

      {/* BEFORE the fit, always. A gap here means the app is holding the wrong
          ORDERS, and a commission fitted on top of that would be a rate invented
          to paper over a window that does not line up. */}
      {paid && (
        <Note
          tone={paid.material ? 'danger' : paid.gap === 0 ? 'good' : 'warn'}
          icon={paid.material ? 'AlertTriangle' : 'Check'}
        >
          <b>
            {paid.material
              ? 'Start here — the ledger and the payout do not agree'
              : 'The ledger matches what was paid out'}
          </b>
          <p>{paid.sentence}</p>
          <table className="data fin-fit-table">
            <tbody>
              <tr>
                <th scope="row">The ledger you uploaded holds</th>
                <td className="num"><Money value={paid.netPaid} /></td>
              </tr>
              <tr>
                <th scope="row">Whatnot paid out</th>
                <td className="num"><Money value={paid.statedPayout} /></td>
              </tr>
              <tr className={paid.material ? 'is-bad' : 'is-ok'}>
                <th scope="row">Out by</th>
                <td className="num"><Money value={paid.gap} strong /></td>
              </tr>
            </tbody>
          </table>
        </Note>
      )}

      {fit && verdict && (
        <>
          <Note
            tone={verdict.tone === 'good' ? 'good' : verdict.tone === 'bad' ? 'danger' : 'warn'}
            icon={verdict.tone === 'good' ? 'Check' : 'AlertTriangle'}
          >
            <b>{verdict.headline}</b>
            <p>{verdict.detail}</p>
          </Note>

          {fit.solvable && (
            <table className="data fin-fit-table">
              <tbody>
                <tr>
                  <th scope="row">Revenue the app shows</th>
                  <td className="num"><Money value={fit.derivedRevenue} /></td>
                </tr>
                <tr>
                  <th scope="row">Whatnot says</th>
                  <td className="num"><Money value={fit.statedGross} /></td>
                </tr>
                <tr className={Math.abs(fit.revenueGap) < 1 ? 'is-ok' : 'is-bad'}>
                  <th scope="row">Out by</th>
                  <td className="num"><Money value={fit.revenueGap} strong /></td>
                </tr>
                {/* THE ROW THAT TELLS A RATE ERROR FROM A PER-ORDER ONE. A
                    commission error scales with the money; a flat charge scales
                    with the ORDERS. Two windows of different sizes that agree on
                    this figure are being broken by the same per-order term. */}
                {fit.perOrderGap !== null && Math.abs(fit.revenueGap) >= 1 && (
                  <tr>
                    <th scope="row">Per order, across {fit.orders.toLocaleString()} orders</th>
                    <td className="num mono">
                      {fit.perOrderGap < 0 ? '\u2212' : ''}
                      {Math.round(Math.abs(fit.perOrderGap) * 100)}¢
                    </td>
                  </tr>
                )}
                <tr className="fin-fit-fit">
                  <th scope="row">Commission that reproduces it</th>
                  <td className="num mono">{ratePct(fit.fittedCommissionRate)}</td>
                </tr>
              </tbody>
            </table>
          )}

          {fit.solvable && Math.abs(fit.revenueGap) >= 1 && from && to && (
            <div className="fin-fit-actions">
              <Button variant="primary" loading={busy} onClick={() => void applyRate()}>
                Use {ratePct(fit.fittedCommissionRate)} for {compactDayLabel(from)} –{' '}
                {compactDayLabel(to)}
              </Button>
              <span className="fin-head-scope">
                Saves a rate period over exactly these dates and re-prices every night in it.
              </span>
            </div>
          )}
        </>
      )}
    </section>
  )
}

/** "$306,977.00" — for a note somebody will read on a saved rate period. */
function fmtMoney(v: number): string {
  return `$${Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`
}

/**
 * TYPE IN WHAT THE STATEMENT SAYS, AND SOLVE FOR THE TERMS THAT PRODUCE IT.
 *
 * The owner's ask: "figure out the projected revenue vs the actual and create
 * some formula that adjusts the revenue to match."
 *
 * The formula is not a correction bolted on the end — that would be a second
 * number beside the first, and the two drift the first time anything changes.
 * The model already has three knobs and every one of them is a guess until it is
 * checked against a document. So this reads the document and works out what the
 * knobs must have been. Set them, and the revenue matches by construction.
 *
 * ## IT CHECKS THE WINDOW BEFORE IT CHECKS THE RATE
 *
 * `sales − commission − processing` is what the statement says it paid. The
 * ledger already knows what it actually paid. If those two disagree the two
 * documents are covering different days, and no rate on earth closes that — so
 * the fit is not even offered until they tie. See @shared/statementFit.
 */
function StatementCheck({
  totals,
  taxRate
}: {
  totals: { netPaid: number; grossSales: number; orders: number }
  taxRate: number
}): JSX.Element {
  const [sales, setSales] = useState('')
  const [commission, setCommission] = useState('')
  const [processing, setProcessing] = useState('')

  const num = (v: string): number => {
    const x = Number((v || '').replace(/[^0-9.-]/g, ''))
    return Number.isFinite(x) ? x : 0
  }
  const filled = sales.trim() !== '' && commission.trim() !== '' && processing.trim() !== ''

  const fit: StatementFit | null = useMemo(() => {
    if (!filled) return null
    return fitStatement(
      { sales: num(sales), commission: num(commission), processing: num(processing) },
      {
        netPaid: totals.netPaid,
        derivedRevenue: totals.grossSales,
        derivedCommission: 0,
        derivedProcessing: 0,
        orders: totals.orders
      },
      taxRate
    )
  }, [filled, sales, commission, processing, totals, taxRate])

  const verdict = fit ? fitVerdict(fit) : null

  return (
    <section className="fin-fit" aria-label="Check against a statement">
      <div className="fin-head-top">
        <h3>Check against a statement</h3>
        <span className="fin-head-scope">Solve the rate from the document</span>
      </div>
      <p className="fin-rates-lead">
        Copy the three figures off a Whatnot statement for the <b>same window as the dates above</b>
        , and this works out what the terms must have been to produce them. Nothing is saved until
        you choose to.
      </p>

      <div className="fin-fit-inputs">
        <label>
          <span>Sales</span>
          <input
            className="input"
            inputMode="decimal"
            placeholder="127825.00"
            value={sales}
            onChange={(e) => setSales(e.target.value)}
          />
        </label>
        <label>
          <span>Commission fees</span>
          <input
            className="input"
            inputMode="decimal"
            placeholder="5113.00"
            value={commission}
            onChange={(e) => setCommission(e.target.value)}
          />
        </label>
        <label>
          <span>Payment processing</span>
          <input
            className="input"
            inputMode="decimal"
            placeholder="4732.59"
            value={processing}
            onChange={(e) => setProcessing(e.target.value)}
          />
        </label>
      </div>

      {fit && verdict && (
        <>
          <Note tone={verdict.tone === 'good' ? 'good' : verdict.tone === 'bad' ? 'danger' : 'warn'}
            icon={verdict.tone === 'good' ? 'Check' : 'AlertTriangle'}>
            <b>{verdict.headline}</b>
            <p>{verdict.detail}</p>
          </Note>

          <table className="data fin-fit-table">
            <tbody>
              <tr>
                <th scope="row">Statement says it paid out</th>
                <td className="num"><Money value={fit.statementNet} /></td>
              </tr>
              <tr>
                <th scope="row">Ledger says it was paid</th>
                <td className="num"><Money value={totals.netPaid} /></td>
              </tr>
              <tr className={fit.sameWindow ? 'is-ok' : 'is-bad'}>
                <th scope="row">Difference</th>
                <td className="num"><Money value={fit.windowGap} strong /></td>
              </tr>
              {/* EVERYTHING BELOW IS MEANINGLESS UNTIL THE ROW ABOVE IS ZERO, so
                  it is not drawn. A fitted rate against the wrong fortnight is a
                  confident number pointing the wrong way, which is worse than no
                  number at all. */}
              {fit.sameWindow && (
                <>
                  <tr>
                    <th scope="row">Revenue the app shows</th>
                    <td className="num"><Money value={totals.grossSales} /></td>
                  </tr>
                  <tr>
                    <th scope="row">Revenue the statement shows</th>
                    <td className="num"><Money value={num(sales)} /></td>
                  </tr>
                  <tr className={Math.abs(fit.revenueGap) < 1 ? 'is-ok' : 'is-bad'}>
                    <th scope="row">Out by</th>
                    <td className="num"><Money value={fit.revenueGap} strong /></td>
                  </tr>
                  {/* THE COLUMN THAT TELLS A RATE ERROR FROM A PER-ORDER ONE.
                      A commission error scales with the money; a flat charge
                      scales with the ORDERS. Two windows that disagree on the
                      total but agree on this figure are being broken by the same
                      per-order term. */}
                  {fit.perOrderGap !== null && Math.abs(fit.revenueGap) >= 1 && (
                    <tr>
                      <th scope="row">Per order, across {totals.orders.toLocaleString()} orders</th>
                      <td className="num mono">
                        {fit.perOrderGap < 0 ? '−' : ''}
                        {Math.round(Math.abs(fit.perOrderGap) * 100)}¢
                      </td>
                    </tr>
                  )}
                  <tr className="fin-fit-fit">
                    <th scope="row">Terms that reproduce the statement</th>
                    <td className="num mono">
                      {ratePct(fit.fittedCommissionRate)} + {ratePct(fit.fittedProcessingRate)} card
                    </td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </>
      )}
    </section>
  )
}
