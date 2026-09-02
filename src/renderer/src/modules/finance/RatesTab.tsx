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
import { compactDayLabel, dayRangeLabel, todayKey } from './time'
import { RANGE_PRESETS, type DayRange } from './range'
import {
  checkWindow,
  pinTermsFor,
  reconInRange,
  reconRows,
  reconTotals,
  revenueStanding,
  type CheckWindow,
  type PinnedTermsFor,
  type ReconRow
} from '@shared/pnlRecon'
import {
  fitFromGross,
  fitStatement,
  fitVerdict,
  grossFitVerdict,
  type StatementFit,
  type StatementInput,
  type WhatnotStatement,
  payoutCheck
} from '@shared/statementFit'

/**
 * FALSE AGAINST A PACKAGED PRELOAD THAT PREDATES THE SAVED-FIGURES BRIDGE.
 *
 * The rest of this screen still works on such a build — rates, coverage, both
 * typed-in checks — so the saved-figures panel is simply not drawn rather than
 * throwing "statements is not a function" on first paint. Same rule the `rates`
 * check at the top of the render keeps, and for the same reason: the renderer
 * and main ship as separate artifacts and one can be older than the other.
 */
const statementsReady =
  typeof finance?.statements === 'function' && typeof finance?.saveStatement === 'function'

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

      <DayCoverage periods={periods} canManage={canManage} onSaved={setPeriods} />

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
  canManage,
  onSaved
}: {
  periods: WhatnotRatePeriod[]
  /** Whether saved figures may be added, edited or removed. The IPC enforces the
   *  same permission with `requireManage`; this only stops the buttons being
   *  offered to somebody the write would then refuse. */
  canManage: boolean
  /** Hands the re-read list up, so saving a fitted rate refreshes the table
   *  above rather than leaving the screen showing terms it no longer uses. */
  onSaved: (next: WhatnotRatePeriod[]) => void
}): JSX.Element | null {
  const [days, setDays] = useState<StreamDayFinance[] | null>(null)
  const [failed, setFailed] = useState(false)

  /**
   * THE WINDOW OPENS ON THE LAST FULL MONTH. IT USED TO OPEN ON NOTHING.
   *
   * These two boxes were `useState('')` and `useState('')`, and a blank end
   * means NO FILTER in `reconInRange` — so every comparison ever drawn on this
   * screen ran over THE ENTIRE LEDGER while the panels underneath it talked
   * about "this window". Type July's payout in and the app compared one month
   * against every night ever imported, then reported the difference as a
   * discrepancy. That is the $24k the owner has been chasing, manufactured by
   * the default value of two pieces of component state.
   *
   * The last full calendar month is the right default because it is the only
   * preset on the range bar that is a CLOSED window, and a statement is always
   * closed: it covers a period with two ends. "This month" runs to today, which
   * no statement covers, and "last 30 days" is not a period anybody reports on.
   *
   * The two dates stay one piece of state so they can never be set half way —
   * picking a saved figure moves both ends at once, and an intermediate render
   * holding July's start with June's end would be a window nobody chose.
   */
  const [range, setRange] = useState<DayRange>(lastFullMonth)
  const { from, to } = range
  const setFrom = (v: string): void => setRange((r) => ({ ...r, from: v }))
  const setTo = (v: string): void => setRange((r) => ({ ...r, to: v }))

  /** What Whatnot states, kept. Null while the read is in flight — which is not
   *  the same as "none saved", and the panels below say different things about
   *  the two. */
  const [statements, setStatements] = useState<WhatnotStatement[] | null>(null)

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

  // Read ONCE, and held HERE rather than inside the panel that compares against
  // them, because two things need the very same list: the list you pick a window
  // out of, and the check that asks whether any saved figure covers the window
  // you picked. Two reads would eventually disagree, and a screen offering a row
  // that the check beside it says does not exist is worse than either alone.
  useEffect(() => {
    if (!statementsReady) {
      setStatements([])
      return
    }
    let alive = true
    void finance
      .statements()
      .then((next) => {
        if (alive) setStatements(Array.isArray(next) ? next : [])
      })
      .catch(() => {
        // LEFT AS null — "we could not find out" — and NOT as [], which means
        // "there are none". They are different facts and only one of them is
        // known here. Collapsing them made the panel print the positive claim
        // "No figure from Whatnot has ever been saved" on a window that may
        // already carry one, and its instruction is to type the figure and save
        // it — which always INSERTS, so following a sentence the app had no
        // grounds for produces a duplicate row for a period already covered.
        // null fails the guard on the Note below, so the screen says nothing
        // rather than something it cannot support. The typed-in boxes still
        // work; they never needed the list.
        if (alive) setStatements(null)
      })
    return () => {
      alive = false
    }
  }, [])

  const all = useMemo(() => reconRows(days ?? [], periods), [days, periods])
  const rows = useMemo(() => reconInRange(all, from, to), [all, from, to])
  const totals = useMemo(() => reconTotals(rows), [rows])

  /**
   * IS THIS WINDOW FIT TO BE COMPARED WITH AN OUTSIDE DOCUMENT?
   *
   * Judged ONCE, here, and handed to both panels — so the two can never disagree
   * about whether the dates on screen mean anything. The table itself is not
   * gated on it: a night-by-night view of the ledger with no dates set is a
   * perfectly good view of the ledger. It is the panels that ASSERT AGREEMENT
   * that must refuse, because that is where an open end stops being a
   * convenience and becomes a claim that is not true. See @shared/pnlRecon.
   */
  const win = useMemo(() => checkWindow(from, to), [from, to])

  /**
   * THE TERMS BOTH PANELS HOLD FIXED, pinned by the rule the STORE uses.
   *
   * This screen used to pin them off `to || from || todayKey()` — the window's
   * last day, and TODAY whenever the boxes were blank, which they were by
   * default. So a fit on July's money was priced at whatever card terms happen
   * to be in force today, while `whatnotStatements.revenueCheck` pinned the same
   * question on the heaviest night and got a different answer. `pinTermsFor` is
   * that rule, in one place, taking the lookup as a callback because the
   * resolver differs on the two sides of the bridge.
   */
  const terms = useMemo(
    () =>
      pinTermsFor(
        rows,
        (day) => {
          const r = effectiveFeeRates(periods, day)
          return {
            processingRate: r.processingRate,
            taxRate: r.taxRate,
            processingFlatCents: r.processingFlatCents
          }
        },
        DEFAULT_TERMS
      ),
    [rows, periods]
  )

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

      <StatementList
        statements={statements}
        canManage={canManage}
        activeFrom={from}
        activeTo={to}
        onPick={(s) => setRange({ from: s.fromDate, to: s.toDate })}
        onSaved={setStatements}
      />

      <div className="fin-recon-range">
        <label>
          <span>From</span>
          <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          <span>To</span>
          <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        {/* THE PRESET IS ONE CLICK BECAUSE THE REFUSALS BELOW POINT AT IT. A
            panel that says "these dates cannot be compared" and gives no way out
            teaches somebody to type two dates from memory, which is the habit
            this whole change exists to remove. */}
        <button type="button" className="fin-more" onClick={() => setRange(lastFullMonth())}>
          <Icon name="CalendarRange" size={13} /> Last month
        </button>
        {(from || to) && (
          <button
            type="button"
            className="fin-more"
            onClick={() => setRange({ from: '', to: '' })}
          >
            <Icon name="X" size={13} /> Every night
          </button>
        )}
        {/* THE WINDOW SPELLED OUT IN WORDS, beside the count. Two date inputs
            render in the machine's own format and are read as boxes rather than
            as a period; "Jul 1 – Jul 31, 2026" is the thing somebody checks
            against the document in their other hand. */}
        <span className="fin-recon-count">
          <b className="fin-recon-window">
            {win.bounded ? dayRangeLabel(win.from, win.to) : 'Every night imported'}
          </b>
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
        Pick a saved figure above and the window becomes exactly the days that figure is about.
        That is the point of the list: matching the window by remembering to is the step that keeps
        getting skipped, and every comparison below is worthless when it is. Whatnot&rsquo;s own
        statement periods do not always run to a calendar month, so the dates stay editable by
        hand, and the total row is the figure to compare.
      </p>

      <RevenueCheck
        totals={totals}
        win={win}
        terms={terms}
        statements={statements}
        canManage={canManage}
        onLastMonth={() => setRange(lastFullMonth())}
        onSaved={onSaved}
        onStatements={setStatements}
      />

      <StatementCheck
        totals={totals}
        win={win}
        taxRate={terms.pinned.taxRate}
        onLastMonth={() => setRange(lastFullMonth())}
      />
    </section>
  )
}

/* `effTax` USED TO LIVE HERE, and it was the same defect twice over. It read the
   tax rate off `to || from` — the window's LAST day, and nothing at all when the
   boxes were blank, which was the default — so a fit over July could be pinned
   on terms that were never in force during July, and on a blank window it fell
   straight through to the built-in defaults. Both panels now take their terms
   from `pinTermsFor`, which pins the night that carried the most money and is
   the same rule the store's own `revenueCheck` applies. */

/**
 * THE WINDOW THIS SCREEN OPENS ON: the last full calendar month.
 *
 * Built from the range bar's OWN preset rather than from a second copy of the
 * arithmetic, because two definitions of "last month" drift and the day they do,
 * this screen and the Streaming tab report different months under the same
 * words. It is the only preset that is a CLOSED window, which is what a
 * statement always is.
 *
 * The blank/blank fallback exists only for the case where that preset is ever
 * renamed away. Blank used to be the default here and it was a lie; it is no
 * longer, because every panel that asserts agreement with an outside document
 * now asks `checkWindow` first and refuses an open window outright. So the worst
 * this degrades to is "the panels ask for dates", not "the panels compare July
 * against all time".
 */
function lastFullMonth(): DayRange {
  const preset = RANGE_PRESETS.find((p) => p.key === 'lastMonth')
  return preset ? preset.build() : { from: '', to: '' }
}

/**
 * WHY A PANEL IS REFUSING TO COMPARE ANYTHING, and the one click out of it.
 *
 * Shared by both checks so the refusal reads identically wherever it appears —
 * the sentence itself comes from `checkWindow`, which has five of them and knows
 * which one applies. A panel that computed over all time while looking like it
 * computed over a month is worse than a panel that refuses, and this is what
 * refusing looks like.
 */
function WindowRefusal({
  win,
  onLastMonth
}: {
  win: CheckWindow
  onLastMonth: () => void
}): JSX.Element {
  const month = lastFullMonth()
  return (
    <Note tone="warn" icon="AlertTriangle">
      <b>These dates cannot be checked against a document.</b>
      <p>{win.problem}</p>
      {!!month.from && !!month.to && (
        <Button size="sm" variant="secondary" icon="CalendarRange" onClick={onLastMonth}>
          Use last month &mdash; {dayRangeLabel(month.from, month.to)}
        </Button>
      )}
    </Note>
  )
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
  win,
  terms,
  statements,
  canManage,
  onLastMonth,
  onSaved,
  onStatements
}: {
  totals: { netPaid: number; ledgerNet: number; grossSales: number; orders: number }
  /** The window, ALREADY JUDGED. Nothing below is drawn until it is bounded. */
  win: CheckWindow
  /** The card terms held fixed while the commission is solved, pinned on the
   *  heaviest night in the window by the shared rule. */
  terms: PinnedTermsFor
  /** Every saved figure, or null while the read is in flight. */
  statements: WhatnotStatement[] | null
  canManage: boolean
  /** Sets the window to the last full month, for the refusal below. */
  onLastMonth: () => void
  onSaved: (next: WhatnotRatePeriod[]) => void
  /** Hands the re-read list of saved figures up after this panel saves one. */
  onStatements: (next: WhatnotStatement[]) => void
}): JSX.Element {
  const toast = useToast()
  const [stated, setStated] = useState('')
  const [paidOut, setPaidOut] = useState('')
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)

  // FOR DISPLAY ONLY. Zero on anything unparseable, which keeps a half-typed box
  // from blanking the panel while somebody is still typing in it.
  const num = (v: string): number => {
    const x = Number((v || '').replace(/[^0-9.-]/g, ''))
    return Number.isFinite(x) ? x : 0
  }
  // FOR STORING. NaN on anything unparseable, so the validator refuses it rather
  // than the app recording a figure nobody stated. The two must not be merged:
  // the panel wants a number it can render mid-keystroke, and the database wants
  // a refusal. See saveFigure, and StatementModal's copy of this same rule.
  const persisted = (v: string): number => {
    const t = (v || '').replace(/[^0-9.-]/g, '').trim()
    return t === '' ? Number.NaN : Number(t)
  }
  const filled = stated.trim() !== ''

  // The terms held fixed come from the NIGHT THAT CARRIED THE MOST MONEY in this
  // window, not from one of its ends. See `pinTermsFor` in @shared/pnlRecon for
  // the defect that rule replaced: pinning on the last day meant a quiet Tuesday
  // closing the month decided how a $60,000 Saturday was fitted, and on the old
  // blank window it pinned July's fit on today's rates.
  const pinned = terms.pinned

  /**
   * WHERE THIS WINDOW ALREADY STANDS AGAINST WHATNOT, BEFORE ANYTHING IS TYPED.
   *
   * The typed boxes below are the "we have not saved one yet" path, and they
   * always were the whole panel — which meant the answer disappeared the moment
   * the screen was closed, and the next person typed the same figure again from
   * the same PDF. A saved figure makes the comparison a STANDING fact about
   * these days, and this is the sentence that reports it.
   *
   * The sentence is built in the contract, not here. A component assembling it
   * out of four booleans and two numbers eventually assembles one the numbers do
   * not support, and this screen has already lied twice.
   */
  const standing = useMemo(
    () => revenueStanding(win, statements ?? [], totals.grossSales),
    [win, statements, totals.grossSales]
  )

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
    () => (paidOut.trim() === '' ? null : payoutCheck(totals.ledgerNet, num(paidOut))),
    [paidOut, totals.ledgerNet]
  )

  const applyRate = async (): Promise<void> => {
    if (!fit?.solvable || !win.bounded) return
    setBusy(true)
    try {
      const res = await finance.saveRate({
        fromDate: win.from,
        toDate: win.to,
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

  /**
   * KEEP THE FIGURE, so nobody types it off the same PDF twice.
   *
   * It saves the window ON SCREEN, which is exactly the pair of dates the figure
   * was just compared against — so a saved figure can never end up filed under a
   * period it is not about. That is only true because the window is guaranteed
   * bounded by the time this button exists; on the old blank default this would
   * have stored a figure against no dates at all.
   *
   * The payout goes with it when one was typed. Null when it was not, which is
   * ordinary: a dashboard reading states sales alone.
   */
  const saveFigure = async (): Promise<void> => {
    if (!filled || !win.bounded) return
    setSaving(true)
    try {
      const input: StatementInput = {
        fromDate: win.from,
        toDate: win.to,
        // NOT the display `num` above. That one returns 0 for anything it cannot
        // parse, which is right for a figure being shown and WRONG for one being
        // stored: typing "n/a" in the payout box would persist a stated payout of
        // $0.00, the validator would accept it (finite, >= 0, <= gross), and the
        // payout check would then read it as the platform having paid nothing and
        // report that there is nothing to chase. StatementModal's own `num` has
        // carried the NaN rule and the reason for it all along; this path was
        // added later and did not inherit it.
        statedGross: persisted(stated),
        statedPayout: paidOut.trim() === '' ? null : persisted(paidOut),
        note: 'Typed in on Fees & rates'
      }
      const res = await finance.saveStatement(input)
      if (!res.ok || !res.data) {
        toast.error(resultError(res, 'That figure could not be saved.'))
        return
      }
      onStatements(res.data)
      toast.success('Saved. This window now carries Whatnot\u2019s own figure beside it.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'That figure could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  // THE REFUSAL, and it comes before every figure below it. This panel compares
  // one month's stated sales against what the app derives for the same days, and
  // an open end means "the same days" is the whole ledger. Every hook above has
  // already run, so the early return cannot change their order.
  if (!win.bounded) {
    return (
      <section className="fin-fit" aria-label="Check revenue against a stated figure">
        <div className="fin-head-top">
          <h3>Check revenue against Whatnot</h3>
          <span className="fin-head-scope">Needs a window a statement could cover</span>
        </div>
        <WindowRefusal win={win} onLastMonth={onLastMonth} />
      </section>
    )
  }

  return (
    <section className="fin-fit" aria-label="Check revenue against a stated figure">
      <div className="fin-head-top">
        <h3>Check revenue against Whatnot</h3>
        <span className="fin-head-scope">One figure, and it solves the commission</span>
      </div>
      <p className="fin-rates-lead">
        Revenue on the Streaming tab is <b>worked out, not recorded</b> &mdash; Whatnot states only
        what it paid, and the price a buyer bid is that figure with the fees added back. Type what
        Whatnot says <b>{dayRangeLabel(win.from, win.to)}</b> sold and this works out the commission
        that would reproduce it. Nothing changes until you choose to save it.
      </p>

      {/* WHERE THESE DAYS ALREADY STAND, said before the boxes. Somebody who
          saved the figure last month should not have to retype it to find out,
          and somebody who never saved one is told that is what is missing rather
          than being shown an empty comparison. On a build whose bridge predates
          saved figures there is nothing to stand on and no way to save one, so
          the sentence is not drawn at all rather than telling somebody to press
          a button that is not there. */}
      {statementsReady && statements !== null && (
        <Note
          tone={
            standing.state === 'compared'
              ? 'good'
              : standing.state === 'disagrees'
                ? 'danger'
                : 'info'
          }
          icon={
            standing.state === 'compared'
              ? 'Check'
              : standing.state === 'disagrees'
                ? 'AlertTriangle'
                : 'Info'
          }
        >
          <b>
            {standing.state === 'never'
              ? 'No figure from Whatnot has ever been saved'
              : standing.state === 'stale'
                ? 'No saved figure covers these days'
                : standing.state === 'compared'
                  ? 'Compared with Whatnot\u2019s own figure'
                  : 'These days do not agree with Whatnot'}
          </b>
          <p>{standing.sentence}</p>
        </Note>
      )}

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

      {/* KEEPING IT IS A SEPARATE PRESS from checking it, the same way saving a
          fitted rate is. Checking changes nothing; saving files a figure against
          these exact dates that every later comparison will be drawn from. */}
      {statementsReady && canManage && filled && (
        <div className="fin-fit-actions">
          <Button variant="secondary" icon="Save" loading={saving} onClick={() => void saveFigure()}>
            Save this figure for {dayRangeLabel(win.from, win.to)}
          </Button>
          <span className="fin-head-scope">
            Keeps it in the list above, so this window comes with Whatnot&rsquo;s own number next
            time instead of being typed off the same document again.
          </span>
        </div>
      )}

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
                <th scope="row">Every row you uploaded, added up</th>
                <td className="num"><Money value={paid.ledgerNet} /></td>
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

          {/* ONE FITTED COMMISSION ASSUMES ONE SET OF CARD TERMS, and this
              window did not have one. The fit is still the best single answer
              available; saying so costs a sentence, and letting somebody save an
              average of two regimes believing it was the rate either of them
              charged costs a re-priced month. */}
          {fit.solvable && terms.mixedTerms && (
            <Note tone="warn" icon="AlertTriangle">
              <b>These nights were not all priced on the same card terms.</b>
              <p>
                The terms held fixed are the ones that priced{' '}
                {terms.pinnedDay ? compactDayLabel(terms.pinnedDay) : 'the heaviest night'} — the
                night in this window that carried the most money. The commission below is therefore
                an average across two sets of terms rather than the rate either of them charged.
              </p>
            </Note>
          )}

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

          {fit.solvable && Math.abs(fit.revenueGap) >= 1 && (
            <div className="fin-fit-actions">
              <Button variant="primary" loading={busy} onClick={() => void applyRate()}>
                Use {ratePct(fit.fittedCommissionRate)} for {compactDayLabel(win.from)} &ndash;{' '}
                {compactDayLabel(win.to)}
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
  win,
  taxRate,
  onLastMonth
}: {
  totals: { netPaid: number; grossSales: number; orders: number }
  /** The window, ALREADY JUDGED. Nothing below is drawn until it is bounded. */
  win: CheckWindow
  /** The tax rate the fit holds fixed, pinned on the heaviest night by
   *  `pinTermsFor` rather than read off whichever end of the window happened to
   *  be filled in. */
  taxRate: number
  /** Sets the window to the last full month, for the refusal below. */
  onLastMonth: () => void
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

  // THE REFUSAL. This panel's first move is to compare the statement's own net
  // against the ledger's, and an open end makes that "one statement against
  // every night ever imported" — which fails `sameWindow` by the size of the
  // rest of the ledger and hides everything below it for a reason that has
  // nothing to do with the document. Every hook above has already run.
  if (!win.bounded) {
    return (
      <section className="fin-fit" aria-label="Check against a statement">
        <div className="fin-head-top">
          <h3>Check against a statement</h3>
          <span className="fin-head-scope">Needs a window a statement could cover</span>
        </div>
        <WindowRefusal win={win} onLastMonth={onLastMonth} />
      </section>
    )
  }

  return (
    <section className="fin-fit" aria-label="Check against a statement">
      <div className="fin-head-top">
        <h3>Check against a statement</h3>
        <span className="fin-head-scope">Solve the rate from the document</span>
      </div>
      <p className="fin-rates-lead">
        Copy the three figures off a Whatnot statement covering{' '}
        <b>{dayRangeLabel(win.from, win.to)}</b> &mdash; the window on screen, and it has to be the
        same one &mdash; and this works out what the terms must have been to produce them. Nothing
        is saved until you choose to.
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

// ---------------------------------------------------------------------------
// What Whatnot states
// ---------------------------------------------------------------------------

/**
 * THE FIGURES WHATNOT ITSELF PUBLISHED, KEPT — AND THE WINDOW THEY ARE ABOUT.
 *
 * ## Why a list and not another pair of boxes
 *
 * Every check on this screen compares something the app derived against
 * something a document says, and the document said it ABOUT A PERIOD. The two
 * facts travel together and were being taken apart: the figure went in a box,
 * the period went in two date inputs somebody typed from memory, and nothing
 * anywhere held them to each other. That is how a July figure ends up checked
 * against all time, which is what this screen did on every render it ever drew.
 *
 * Picking a row here sets the night-by-night window to that statement's own
 * dates. The comparison is then correct BY CONSTRUCTION rather than by somebody
 * remembering to retype two dates — and remembering is the step that keeps
 * getting skipped, because nothing on screen ever complained when it was.
 *
 * ## Why it looks exactly like the rate periods above it
 *
 * Because it is the same kind of thing: a figure, the span it applies to, a note
 * about where it came from, and the two actions that maintain it. Same markup,
 * same vocabulary, same permission gate. A second visual language for the second
 * list of dated figures on one screen would be a thing to learn for no reason.
 *
 * NEWEST FIRST, AND NOT RE-SORTED HERE. `listStatements` orders by from_date
 * descending because a reconciliation starts from the thing that just landed.
 * Sorting again in the renderer would be a second opinion about that order, and
 * the day the two differ this list and the store disagree about which figure is
 * the current one.
 */
function StatementList({
  statements,
  canManage,
  activeFrom,
  activeTo,
  onPick,
  onSaved
}: {
  /** Null while the read is in flight — drawn as nothing, not as "none saved". */
  statements: WhatnotStatement[] | null
  canManage: boolean
  /** The window on screen, so the row it came from can say so. */
  activeFrom: string
  activeTo: string
  onPick: (statement: WhatnotStatement) => void
  onSaved: (next: WhatnotStatement[]) => void
}): JSX.Element | null {
  const toast = useToast()
  const [editing, setEditing] = useState<WhatnotStatement | 'new' | null>(null)
  const [deleting, setDeleting] = useState<WhatnotStatement | null>(null)
  const [busy, setBusy] = useState(false)

  const remove = useCallback(async () => {
    if (!deleting) return
    setBusy(true)
    try {
      const res = await finance.deleteStatement(deleting.id)
      if (!res.ok || !res.data) {
        toast.error(resultError(res, 'That figure could not be removed.'))
        return
      }
      onSaved(res.data)
      setDeleting(null)
      // Removing a figure removes EVIDENCE, not money: nothing the app derives
      // moves, the window simply stops having an outside number beside it.
      toast.success('Figure removed. Nothing the app derives changes.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'That figure could not be removed.')
    } finally {
      setBusy(false)
    }
  }, [deleting, onSaved, toast])

  if (!statementsReady) return null
  if (statements === null) return null

  return (
    <section className="fin-stmt-list" aria-label="What Whatnot states">
      <div className="fin-imports-head">
        <span className="fin-section-title">
          <Icon name="ReceiptText" size={15} />
          What Whatnot states
          <span className="fin-count">{statements.length}</span>
        </span>
        {canManage && (
          <Button size="sm" variant="secondary" icon="Plus" onClick={() => setEditing('new')}>
            Add a figure
          </Button>
        )}
      </div>

      <p className="fin-rates-lead">
        The only figures on this screen that came from <b>outside the app</b>. Pick one and the
        window below becomes exactly the days it covers, so what the table totals and what Whatnot
        stated are about the same period without anybody having to check that they are.
      </p>

      {statements.length === 0 && (
        <p className="fin-blank-gate">
          Nothing saved yet. Type a figure into the revenue check below and press{' '}
          <b>Save this figure</b>, or add one here from a statement or a 1099.
        </p>
      )}

      {statements.map((st) => {
        const active = st.fromDate === activeFrom && st.toDate === activeTo
        return (
          <article key={st.id} className={`fin-rate fin-stmt${active ? ' is-active' : ''}`}>
            <div className="fin-rate-main">
              <b className="fin-rate-figure mono">{fmtMoney(st.statedGross)}</b>
              <span className="fin-rate-span">{spanLabel(st)}</span>
              {active && <span className="fin-rate-tag">On screen</span>}
            </div>
            {/* THE PAYOUT IS PRINTED EVEN WHEN IT IS MISSING, because its absence
                is the reason the one check that cannot be wrong for a fee
                schedule's reasons never runs on this window. "Sales only" is a
                fact worth seeing from the list. */}
            <p className="fin-rate-terms mono">
              {st.statedPayout === null
                ? 'sales only — no payout stated'
                : `paid out ${fmtMoney(st.statedPayout)}`}
              {st.statedFees !== null && ` · fees ${fmtMoney(st.statedFees)}`}
            </p>
            {st.note && <p className="fin-rate-note">{st.note}</p>}
            <div className="fin-rate-acts">
              <button type="button" className="fin-more" onClick={() => onPick(st)}>
                <Icon name="CalendarRange" size={14} />
                Use these dates
              </button>
              {canManage && (
                <>
                  <button type="button" className="fin-more" onClick={() => setEditing(st)}>
                    <Icon name="Pencil" size={14} />
                    Edit
                  </button>
                  <button
                    type="button"
                    className="fin-more is-danger"
                    onClick={() => setDeleting(st)}
                  >
                    <Icon name="Trash2" size={14} />
                    Remove
                  </button>
                </>
              )}
            </div>
          </article>
        )
      })}

      {!canManage && (
        <p className="fin-blank-gate">
          Saving a stated figure needs the <b>Manage finance data</b> permission. Picking a window
          from the list does not.
        </p>
      )}

      {editing && (
        <StatementModal
          statement={editing === 'new' ? null : editing}
          defaultFrom={activeFrom}
          defaultTo={activeTo}
          onClose={() => setEditing(null)}
          onSaved={(next) => {
            onSaved(next)
            setEditing(null)
          }}
        />
      )}

      {deleting && (
        <Modal
          title="Remove this stated figure?"
          onClose={() => (busy ? undefined : setDeleting(null))}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleting(null)} disabled={busy}>
                Keep it
              </Button>
              <Button variant="danger" icon="Trash2" loading={busy} onClick={() => void remove()}>
                Remove the figure
              </Button>
            </>
          }
        >
          <p className="fin-confirm-lead">
            Whatnot&rsquo;s <b>{fmtMoney(deleting.statedGross)}</b> for{' '}
            <b>{spanLabel(deleting)}</b> goes.
          </p>
          <p className="fin-confirm-lead">
            No figure the app derives changes. Those days simply stop having anything from outside
            the app to be checked against, and the revenue check goes back to asking for one.
          </p>
        </Modal>
      )}
    </section>
  )
}

/**
 * EVERYTHING THAT CAN BE WRONG WITH A STATED FIGURE, as a sentence, or null.
 *
 * These are the store's own rules restated, NOT a second opinion about them.
 * `validateStatement` runs inside the write in `src/main/db/whatnotStatements.ts`
 * and is the authority; it cannot be imported here, because nothing in
 * `src/main` can follow the bridge into a browser bundle. The value of the copy
 * is that a reversed pair of dates is caught while somebody is still looking at
 * the field rather than after they press save. When the two drift, the store
 * wins — its message is what the toast prints.
 *
 * NaN reaches here for a blank box, deliberately: `Number('')` is 0 and a stated
 * gross of zero is a claim that the window sold nothing, which the revenue check
 * would then report as the app overshooting by the whole month.
 */
function statementProblem(
  fromDate: string,
  toDate: string,
  gross: number,
  fees: number | null,
  payout: number | null
): string | null {
  if (!isDayKey(fromDate)) return 'The start date is not a real date.'
  if (!isDayKey(toDate)) return 'The end date is not a real date.'
  if (toDate < fromDate) return 'The end date is before the start date.'
  if (!Number.isFinite(gross) || gross <= 0) {
    return 'Enter the sales figure the platform states for this window.'
  }
  if (fees !== null) {
    if (!Number.isFinite(fees) || fees < 0) return 'The fees figure is not a number.'
    if (fees >= gross) return 'The fees cannot be the whole of the sales.'
  }
  if (payout !== null) {
    if (!Number.isFinite(payout) || payout < 0) return 'The payout figure is not a number.'
    // A payout ABOVE sales would mean the platform paid out more than it took,
    // which is possible for one day and absurd for a whole window. Almost always
    // the two boxes have each other's figure in them.
    if (payout > gross) {
      return 'The payout is larger than the sales, which cannot be right for a whole window — are the two figures the other way round?'
    }
  }
  return null
}

/**
 * Add or edit one stated figure.
 *
 * Shaped like the rate form above it on purpose — same Modal, same Field hints,
 * same "nothing is saved until you press the button" footer — because it is the
 * same job on the other half of the comparison, and the checks it runs are
 * `statementProblem` above, which is the store's own validator restated.
 *
 * ## Blank is not zero
 *
 * `Number('')` is 0, and a stated gross of zero is not "nothing was entered" —
 * it is a claim that the window sold nothing, which the revenue check would then
 * report as the app overshooting by the entire month. The empty string is
 * refused here and refused again in the store. Fees and payout are the mirror
 * image: blank means NOT STATED, which is ordinary and must reach the bridge as
 * null rather than as a zero the payout check would read as "Whatnot paid
 * nothing".
 */
function StatementModal({
  statement,
  defaultFrom,
  defaultTo,
  onClose,
  onSaved
}: {
  statement: WhatnotStatement | null
  /** The window on screen. A new figure is nearly always about the days being
   *  looked at, so the form opens on them rather than on today. */
  defaultFrom: string
  defaultTo: string
  onClose: () => void
  onSaved: (next: WhatnotStatement[]) => void
}): JSX.Element {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const text = (v: number | null): string => (v === null || v === undefined ? '' : String(v))
  const [fromDate, setFromDate] = useState(statement?.fromDate ?? defaultFrom ?? '')
  const [toDate, setToDate] = useState(statement?.toDate ?? defaultTo ?? '')
  const [gross, setGross] = useState(statement ? text(statement.statedGross) : '')
  const [fees, setFees] = useState(statement ? text(statement.statedFees) : '')
  const [payout, setPayout] = useState(statement ? text(statement.statedPayout) : '')
  const [note, setNote] = useState(statement?.note ?? '')

  // NaN for a blank box rather than 0, so an empty field cannot be smoothed into
  // a stated figure of zero on its way to the validator. Same rule the rate form
  // above keeps, and for the same reason.
  const num = (v: string): number => {
    const t = (v || '').replace(/[^0-9.-]/g, '').trim()
    return t === '' ? Number.NaN : Number(t)
  }
  const grossValue = num(gross)
  const payoutValue = payout.trim() === '' ? null : num(payout)
  const feesValue = fees.trim() === '' ? null : num(fees)

  const problem = statementProblem(fromDate, toDate, grossValue, feesValue, payoutValue)

  const save = async (): Promise<void> => {
    if (problem) return
    setBusy(true)
    try {
      const input: StatementInput = {
        id: statement?.id,
        fromDate,
        toDate,
        statedGross: grossValue,
        statedFees: feesValue,
        statedPayout: payoutValue,
        note
      }
      const res = await finance.saveStatement(input)
      if (!res.ok || !res.data) {
        toast.error(resultError(res, 'That figure could not be saved.'))
        return
      }
      onSaved(res.data)
      toast.success(`${fmtMoney(grossValue)} saved for ${dayRangeLabel(fromDate, toDate)}.`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'That figure could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={statement ? 'Edit this stated figure' : 'Add what Whatnot states'}
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
            {statement ? 'Save the figure' : 'Add the figure'}
          </Button>
        </>
      }
    >
      <div className="fin-rate-form">
        {/* THE DATES ARE THE STATEMENT'S OWN PERIOD, not a calendar month. A
            Whatnot period frequently does not start on the 1st, and a figure
            filed under the wrong days is exactly the error every panel on this
            screen was making before the list existed. */}
        <Field
          label="From"
          hint="Inclusive. The first show night this document covers — as the document dates it, not as the calendar does."
        >
          <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        </Field>
        <Field label="To" hint="Inclusive — the last show night this document covers.">
          <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </Field>
        <Field
          label="Sales the document states"
          hint="What the platform says the window SOLD, before anything came off. The figure the app's revenue is checked against."
        >
          <Input
            type="text"
            inputMode="decimal"
            placeholder="306977.00"
            value={gross}
            invalid={!!problem && !Number.isFinite(grossValue)}
            onChange={(e) => setGross(e.target.value)}
          />
        </Field>
        <Field
          label="Paid out (optional)"
          // The most useful field on the form, and the one a dashboard reading
          // does not have. Both sides of that comparison are RECORDED money, so
          // it is the one check that cannot be wrong for a fee schedule's
          // reasons — and it is what says whether the app is even holding the
          // right set of orders before any rate is argued about.
          hint="What actually landed in the bank. Blank when the document does not say — it is not zero."
        >
          <Input
            type="text"
            inputMode="decimal"
            placeholder="369362.53"
            value={payout}
            onChange={(e) => setPayout(e.target.value)}
          />
        </Field>
        <Field
          label="Fees (optional)"
          hint="What the document says came off. Blank when it does not itemise them."
        >
          <Input
            type="text"
            inputMode="decimal"
            placeholder="14231.90"
            value={fees}
            onChange={(e) => setFees(e.target.value)}
          />
        </Field>
        <Field label="Note" hint="Which document this came off — the statement, the dashboard, a 1099.">
          <Input
            type="text"
            maxLength={200}
            value={note}
            placeholder="July statement PDF…"
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
          Saving this changes <b>no figure the app derives</b>. It files what Whatnot said about
          these days, so the checks below the table have something from outside the app to compare
          against — and so the next person does not type it off the same document again.
        </p>
      )}
    </Modal>
  )
}
