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
    breakCost: finite(m.breakCost),
    giveawayCost: finite(m.giveawayCost),
    cogs: finite(m.cogs),
    grossProfit: finite(m.grossProfit),
    netProfit: finite(m.netProfit)
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

export function PnlStatement({ money }: { money: PnlMoney }): JSX.Element {
  const [showAll, setShowAll] = useState(false)

  const sections = useMemo(() => buildStatement(money), [money])

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
      <table className="fin-pnl">
        {sections.map((section) => (
          <SectionBody key={section.key} section={section} showAll={showAll} />
        ))}
      </table>

      {zeroLines > 0 && (
        <button
          type="button"
          className="fin-more"
          aria-pressed={showAll}
          onClick={() => setShowAll((v) => !v)}
        >
          <Icon name={showAll ? 'ChevronUp' : 'ChevronDown'} size={14} />
          {showAll
            ? `Hide the ${plural(zeroLines, 'empty line')}`
            : `Show ${plural(zeroLines, 'line')} sitting at zero`}
        </button>
      )}
    </div>
  )
}

function SectionBody({
  section,
  showAll
}: {
  section: PnlSection
  showAll: boolean
}): JSX.Element {
  // A running section is a milestone: it has no lines of its own, it is a
  // figure carried down from everything above it. Rendering it as a heading
  // plus a subtotal would make it look like a section with its contents hidden.
  if (section.running) {
    return (
      <tbody className="fin-pnl-sec is-running">
        <tr className={`fin-pnl-mile${section.key === 'netProfit' ? ' is-bottom' : ''}`}>
          <th scope="row">{section.subtotalLabel}</th>
          <td>
            <Profit value={section.subtotal} />
          </td>
        </tr>
      </tbody>
    )
  }

  const visible = showAll ? section.lines : section.lines.filter((l) => !l.empty)

  return (
    <tbody className="fin-pnl-sec">
      <tr className="fin-pnl-head">
        <th scope="colgroup" colSpan={2}>
          {section.label}
        </th>
      </tr>

      {visible.length === 0 ? (
        // Never let the section itself disappear. Its subtotal is part of the
        // sum that has to reconcile on screen, and a heading followed straight
        // by a zero total reads as a rendering fault rather than as "nothing
        // happened here".
        <tr className="fin-pnl-line is-none">
          <td colSpan={2}>Nothing in this section.</td>
        </tr>
      ) : (
        visible.map((line) => <LineRow key={line.key} line={line} />)
      )}

      <tr className="fin-pnl-sub">
        <th scope="row">{section.subtotalLabel}</th>
        <td>
          <Money value={section.subtotal} strong />
        </td>
      </tr>
    </tbody>
  )
}

function LineRow({ line }: { line: PnlLine }): JSX.Element {
  return (
    <tr className={`fin-pnl-line${line.empty ? ' is-empty' : ''}`}>
      <th scope="row">
        <span className="fin-pnl-label">{line.label}</span>
        {/* The detail is what makes the figure checkable — "2.9% + 30c x 1029"
            is the sum, written out. It stays beside the label rather than in a
            tooltip precisely because nobody hovers a number they already
            believe. It is printed verbatim from the contract: rewriting the
            builder's own words in the renderer would put two versions of the
            same sentence in the app. */}
        {line.detail && <em className="fin-pnl-detail">{line.detail}</em>}
      </th>
      <td>
        <Money value={line.amount} dash />
      </td>
    </tr>
  )
}
