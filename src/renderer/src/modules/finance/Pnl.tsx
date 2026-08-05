import { useMemo, useState } from 'react'
import type { PnlLine, PnlSection, StreamDayFinance } from '@shared/financeStreaming'
import { buildPnl, pnlChecksum } from '@shared/financeStreaming'
import { Icon } from '../../components/Icon'
import { Money, Note, Profit, plural } from './bits'

/**
 * The statement, read top to bottom.
 *
 * The SECTIONS ARE NOT WRITTEN HERE. `buildPnl` in the contract decides which
 * field belongs in which section and what each section adds up to, and this
 * file walks whatever it returns. That is the entire point of the split: a
 * statement whose layout is hand-written beside its arithmetic is how you end
 * up with sections that each look right and a total that matches none of them.
 * Adding a line upstream makes it appear here with no change to this file.
 *
 * Two things this screen does that the builder cannot:
 *
 * 1. It CHECKS. `pnlChecksum` sums every non-running subtotal, which must equal
 *    net profit. It is asserted on every render and shown when it fails, rather
 *    than being trusted. A P&L that silently does not add up is worse than no
 *    P&L, and the renderer and main ship as separate artifacts — this is the
 *    check that catches the skew.
 * 2. It hides zero lines, because a real day fills maybe half of them and the
 *    other half are noise. Never a whole section though: a section that
 *    vanished would take its subtotal with it and the statement would stop
 *    reconciling on screen.
 */

/** Anything below half a cent is zero — float sums arrive as -0 and 1e-13. */
const isZero = (n: number): boolean => Math.abs(n) < 0.005

/**
 * Every money field the statement needs. Both `StreamDayFinance` and
 * `FinancePeriodRow` satisfy it, which is what lets one component render a day,
 * a week and a month — they are the same statement at different grains, and two
 * components would be two chances to disagree.
 */
export type PnlMoney = Omit<StreamDayFinance, 'streamDate' | 'sessionTitles'>

/**
 * Cost of goods and the two profit figures landed in the contract after the
 * fields around them, and main ships as a separate artifact from the renderer —
 * the same skew `financeReady` and the `Array.isArray(view.weeks)` guard exist
 * for. A packaged main that predates them sends rows without these five keys,
 * and reading `undefined` into the statement would print NaN down the whole
 * page. Zero is the only safe reading, and the checksum below then FAILS
 * loudly, which is exactly right: the figures on screen genuinely would not add
 * up on that build.
 *
 * The other fields are not guarded because they have shipped for releases; a
 * blanket guard would only hide a real bug behind a plausible zero.
 */
const finite = (n: number): number => (Number.isFinite(n) ? n : 0)

/**
 * Exported because the SUMMARY EQUATION at the top of the tab is built from the
 * same sections this statement is.
 *
 * That is not a convenience. The strip's whole job is to be checkable by eye
 * against the statements below it, and the only way two screens cannot disagree
 * about what "fees" or "shipping" contains is for both to read the same
 * `buildPnl` output — including the same guards on the same fields.
 */
export function buildStatement(m: PnlMoney): PnlSection[] {
  return buildPnl({
    ...m,
    // `netSales` and `grossSales` replaced a single `sales` field when the fee
    // model was corrected, and a packaged main that predates that sends neither.
    // Zero is the only safe reading; the checksum below then fails loudly, which
    // is right — on that build the top line genuinely is not being reported.
    netSales: finite(m.netSales),
    grossSales: finite(m.grossSales),
    feeSaleCount: finite(m.feeSaleCount),
    breakCost: finite(m.breakCost),
    giveawayCost: finite(m.giveawayCost),
    cogs: finite(m.cogs),
    grossProfit: finite(m.grossProfit),
    netProfit: finite(m.netProfit),
    // The three newest fields, guarded for the same reason and with the same
    // consequence. A packaged main that predates them sends none: the statement
    // then prints the two cost-of-goods totals it always printed, no marketplace
    // line, and an empty General expenses section — all of which are TRUE on that
    // build, so nothing here fails when it should not.
    productGrossSales: finite(m.productGrossSales),
    generalExpenses: finite(m.generalExpenses),
    generalExpenseCount: finite(m.generalExpenseCount)
  })
}

/** The subtotal of one section, by key. Zero for a section this build's
 *  contract does not produce, which the checksum then catches. */
export function sectionSubtotal(sections: PnlSection[], key: string): number {
  return sections.find((s) => s.key === key)?.subtotal ?? 0
}

/**
 * The statement's own assertion, in the one shape every caller needs: what the
 * sections add up to, what the period claims, and the gap between them.
 */
export function pnlDrift(sections: PnlSection[], statedNetProfit: number): {
  checksum: number
  stated: number
  drift: number
  ok: boolean
} {
  const checksum = pnlChecksum(sections)
  const stated = Math.round(finite(statedNetProfit) * 100) / 100
  const drift = Math.round((checksum - stated) * 100) / 100
  return { checksum, stated, drift, ok: isZero(drift) }
}

/**
 * THE STATEMENT AS DISCLOSURES.
 *
 * Every section now carries its own subtotal ON THE HEADING ROW and opens to
 * show the lines that make it. That is one row per section closed — Revenue,
 * Cost of goods, Gross profit, Platform fees, Shipping, Show costs,
 * Adjustments, Net profit — which is the whole P&L in eight lines, and the
 * detail is one click from whichever line raised the question.
 *
 * It closed by default because the previous layout put roughly twenty rows on
 * screen whether or not anyone was reading them, under a summary that already
 * answered the top-level question. A statement nobody can take in at a glance
 * gets skipped, and a skipped statement is worse than a short one.
 */
export function PnlStatement({ money }: { money: PnlMoney }): JSX.Element {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [showAll, setShowAll] = useState(false)

  const sections = useMemo(() => buildStatement(money), [money])

  const expandable = useMemo(() => sections.filter((s) => !s.running), [sections])
  const openCount = expandable.filter((s) => open[s.key]).length
  const allOpen = openCount === expandable.length && expandable.length > 0

  // Counted across the whole statement rather than per section, because the
  // toggle is one control: "5 zero lines hidden" is the promise it has to keep.
  const zeroLines = useMemo(
    () => sections.reduce((n, s) => n + s.lines.filter((l) => l.empty).length, 0),
    [sections]
  )

  // The assertion, run on every paint. `pnlChecksum` sums the sections that are
  // not running totals; that sum IS net profit by construction, so any drift
  // means the day was built by arithmetic this build does not agree with.
  const check = useMemo(() => pnlDrift(sections, money.netProfit), [sections, money.netProfit])

  // The denominator for the share column. Zero revenue means no column at all
  // rather than a column of dashes or, worse, of divisions by nothing.
  const revenue = sections.find((s) => s.key === 'revenue')?.subtotal ?? 0
  const withShare = revenue > 0

  const toggleAll = (): void => {
    const next: Record<string, boolean> = {}
    for (const s of expandable) next[s.key] = !allOpen
    setOpen(next)
  }

  return (
    <div className="fin-pnl-wrap">
      {!check.ok && (
        <Note tone="danger" icon="AlertTriangle" role="alert">
          <b>This statement does not add up — do not use it.</b>
          <p>
            The sections below total <Money value={check.checksum} strong />, but this period was
            stored with a net profit of <Money value={check.stated} strong />, a difference of{' '}
            <Money value={check.drift} strong />. That can only happen if the app and its data
            engine were built from different versions of the P&amp;L. Update the app and re-import
            before trusting any figure here.
          </p>
        </Note>
      )}

      {/* A table, not a stack of divs: one table means ONE amount column, so a
          section subtotal is guaranteed to sit on the same right edge as the
          lines above it. That alignment is the only way to eyeball whether a
          subtotal belongs to the lines it follows. */}
      <table className={`fin-pnl${withShare ? ' has-share' : ''}`}>
        <thead>
          <tr>
            <th scope="col">Account</th>
            <th scope="col" className="is-num">
              Amount
            </th>
            {withShare && (
              <th scope="col" className="is-num" title="Share of total revenue for this period">
                % rev
              </th>
            )}
          </tr>
        </thead>

        {sections.map((section) => (
          <SectionBody
            key={section.key}
            section={section}
            open={!!open[section.key]}
            onToggle={() => setOpen((prev) => ({ ...prev, [section.key]: !prev[section.key] }))}
            showAll={showAll}
            revenue={withShare ? revenue : null}
          />
        ))}
      </table>

      <div className="fin-pnl-foot">
        {expandable.length > 0 && (
          <button type="button" className="fin-more" aria-pressed={allOpen} onClick={toggleAll}>
            <Icon name={allOpen ? 'ChevronsDownUp' : 'ChevronsUpDown'} size={14} />
            {allOpen ? 'Collapse all' : 'Expand all'}
          </button>
        )}

        {zeroLines > 0 && openCount > 0 && (
          <button
            type="button"
            className="fin-more"
            aria-pressed={showAll}
            onClick={() => setShowAll((v) => !v)}
          >
            <Icon name={showAll ? 'EyeOff' : 'Eye'} size={14} />
            {showAll
              ? `Hide the ${plural(zeroLines, 'empty line')}`
              : `Show ${plural(zeroLines, 'line')} sitting at zero`}
          </button>
        )}
      </div>
    </div>
  )
}

/** A section's share of revenue, as the statement's own column prints it.
 *  Magnitude, not sign: the sign is already on the figure beside it, and
 *  "−16.8%" of revenue reads as a negative share of something. */
function ShareCell({ amount, revenue }: { amount: number; revenue: number | null }): JSX.Element | null {
  if (revenue === null) return null
  if (isZero(amount)) {
    return (
      <td className="is-num fin-pnl-share">
        <span className="fin-money zero mono">—</span>
      </td>
    )
  }
  return (
    <td className="is-num fin-pnl-share">
      <span className="mono">{((Math.abs(amount) / revenue) * 100).toFixed(1)}%</span>
    </td>
  )
}

function SectionBody({
  section,
  open,
  onToggle,
  showAll,
  revenue
}: {
  section: PnlSection
  open: boolean
  onToggle: () => void
  showAll: boolean
  revenue: number | null
}): JSX.Element {
  const cols = revenue === null ? 2 : 3

  // A running section is a milestone: it has no lines of its own, it is a
  // figure carried down from everything above it. Rendering it with a caret
  // would promise a disclosure that has nothing inside it.
  if (section.running) {
    return (
      <tbody className="fin-pnl-sec is-running">
        <tr className={`fin-pnl-mile${section.key === 'netProfit' ? ' is-bottom' : ''}`}>
          <th scope="row">{section.subtotalLabel}</th>
          <td className="is-num">
            <Profit value={section.subtotal} />
          </td>
          <ShareCell amount={section.subtotal} revenue={revenue} />
        </tr>
      </tbody>
    )
  }

  const visible = showAll ? section.lines : section.lines.filter((l) => !l.empty)
  const bodyId = `fin-pnl-${section.key}`

  return (
    <tbody className={`fin-pnl-sec${section.memo ? ' is-memo' : ''}`} id={bodyId}>
      <tr className={`fin-pnl-head${open ? ' is-open' : ''}`}>
        <th scope="row">
          {/* The whole heading is the control. A caret-sized hit target on a
              row this wide is a miss waiting to happen, and there is nothing
              else on the row to click. */}
          <button
            type="button"
            className="fin-pnl-toggle"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={onToggle}
          >
            <Icon name={open ? 'ChevronDown' : 'ChevronRight'} size={14} />
            <span>{section.label}</span>
            {/* A memo subtotal sits in the same column, at the same weight, as
                the subtotals that DO add up to the bottom line. Somebody adding
                the column by eye would land a few hundred dollars under net
                profit and go looking for the bug. So the row says on its face
                that it is outside the total; the section's note says why. */}
            {section.memo && <em className="fin-pnl-memo">not in net profit</em>}
            {!open && visible.length > 0 && (
              <em className="fin-pnl-count">{plural(visible.length, 'line')}</em>
            )}
          </button>
        </th>
        <td className="is-num">
          <Money value={section.subtotal} strong />
        </td>
        <ShareCell amount={section.subtotal} revenue={revenue} />
      </tr>

      {open &&
        (visible.length === 0 ? (
          // Never let the section itself disappear. Its subtotal is part of the
          // sum that has to reconcile on screen, and a heading followed by
          // nothing at all reads as a rendering fault rather than as "nothing
          // happened here".
          <tr className="fin-pnl-line is-none">
            <td colSpan={cols}>Nothing in this section.</td>
          </tr>
        ) : (
          visible.map((line) => <LineRow key={line.key} line={line} revenue={revenue} />)
        ))}

      {/* The section's own footnote, printed verbatim from the contract for the
          same reason a line's detail is: rewriting it here would put two
          versions of the same sentence in the app. Only the fees section has one
          today, and it is the sentence that stops a derived gross being read as
          a figure Whatnot stated. */}
      {open && section.note && (
        <tr className="fin-pnl-note">
          <td colSpan={cols}>{section.note}</td>
        </tr>
      )}
    </tbody>
  )
}

function LineRow({ line, revenue }: { line: PnlLine; revenue: number | null }): JSX.Element {
  // NOT KNOWN IS NOT ZERO, and this is the row where that has to be visible.
  // Printing $0.00 for a cost the app could not measure tells the reader the
  // cost did not happen. The figure is replaced by words, the share column is
  // dropped rather than dividing an unknown by revenue, and the line is never
  // hidden — `buildPnl` refuses to mark an unavailable line `empty`, so the
  // zero-line toggle cannot swallow it either.
  if (line.unavailable) {
    return (
      <tr className="fin-pnl-line is-unknown">
        <th scope="row">
          <span className="fin-pnl-label">{line.label}</span>
          {line.detail && <em className="fin-pnl-detail">{line.detail}</em>}
        </th>
        <td className="is-num">
          <span className="fin-money zero mono" title="This period has no packing record to count">
            not known
          </span>
        </td>
        {revenue !== null && (
          <td className="is-num fin-pnl-share">
            <span className="fin-money zero mono">—</span>
          </td>
        )}
      </tr>
    )
  }

  return (
    <tr className={`fin-pnl-line${line.empty ? ' is-empty' : ''}`}>
      <th scope="row">
        <span className="fin-pnl-label">{line.label}</span>
        {/* The detail is what makes the figure checkable — "2.9% of $24,010.00
            order value + 30¢ × 1,029 orders" is the sum, written out, INCLUDING
            which total the percentage runs on. It stays beside the label rather than in a
            tooltip precisely because nobody hovers a number they already
            believe. It is printed verbatim from the contract: rewriting the
            builder's own words in the renderer would put two versions of the
            same sentence in the app. */}
        {line.detail && <em className="fin-pnl-detail">{line.detail}</em>}
      </th>
      <td className="is-num">
        <Money value={line.amount} dash />
      </td>
      <ShareCell amount={line.amount} revenue={revenue} />
    </tr>
  )
}
