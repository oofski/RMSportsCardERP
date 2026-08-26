import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  PnlLine,
  PnlSection,
  StreamDayFinance,
  StreamingFinanceView,
  UncostedStreamItem
} from '@shared/financeStreaming'
import { buildPnl, pnlChecksum } from '@shared/financeStreaming'
import { buildPnlOmissions } from '@shared/pnlOmissions'
import { pnlDrillSource } from '@shared/pnlDrill'
import { parseMoneyInput } from '@shared/streaming'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { formatUnitCount, stockUnitWord } from '../../lib/productUnits'
import { useSession } from '../../lib/session'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { Button, CenterLoader, Field, Input, Modal } from '../../components/ui'
import { costEntryReady, resultError, streaming } from '../streaming/api'
import { Money, Note, Profit, moneyText, plural } from './bits'
import { type DrillStep, PnlDrillPanel, resolveTrail } from './PnlDrill'
import { RangeBar } from './RangeBar'
import { finance, pnlDrillReady } from './api'
import { type DayRange, coveredRange, totalsForRange } from './range'
import { dayRangeLabel, shortDayLabel } from './time'

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
 * about what "fees" or "cost of goods" contains is for both to read the same
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
 * Cost of goods, Gross profit, Platform fees, Other show costs, General
 * expenses, Adjustments, Net profit — which is the whole P&L in eight lines, and
 * the detail is one click from whichever line raised the question.
 *
 * It closed by default because the previous layout put roughly twenty rows on
 * screen whether or not anyone was reading them, under a summary that already
 * answered the top-level question. A statement nobody can take in at a glance
 * gets skipped, and a skipped statement is worse than a short one.
 */
export function PnlStatement({
  money,
  range = null,
  rangeLabel = 'All time',
  onCosted
}: {
  money: PnlMoney
  /**
   * The range these figures are FOR, so a click on one of them can ask main for
   * the records inside the same window. Null is all time, exactly as everywhere
   * else. Without it the drill-down would have to guess, and a month's line
   * answered with a day's rows is the one mistake this feature cannot make.
   */
  range?: DayRange | null
  /** How that range reads in words, printed at the top of every drill view so a
   *  list of records can never be mistaken for a different period's. */
  rangeLabel?: string
  /**
   * Present when this reader may enter a cost against a stream line — the P&L's
   * uncosted rows then become controls rather than statements. Absent for anyone
   * without `streaming.manage`, and for a caller that has no way to reload the
   * figures afterwards: a row that changed the database and left a stale
   * statement on screen would be worse than a row that could not be clicked.
   */
  onCosted?: () => void | Promise<void>
}): JSX.Element {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [showAll, setShowAll] = useState(false)
  /** The uncosted line being priced. Held here rather than per row so the modal
   *  outlives the re-render that follows a save. */
  const [costing, setCosting] = useState<UncostedStreamItem[] | null>(null)
  /**
   * WHERE IN THE STATEMENT THE READER IS — empty is the statement itself.
   *
   * Held here rather than inside the drill panel because it has to outlive that
   * panel: pricing a line reloads every figure on the page, and a trail that
   * reset to the top on each save would send the operator back through three
   * clicks after every entry.
   *
   * KEYS, not the sections and lines themselves — see `DrillStep`. `sections` is
   * rebuilt whenever the figures move, and a trail holding the objects captured
   * on the way in would go on showing the arithmetic from before the save.
   */
  const [trail, setTrail] = useState<DrillStep[]>([])

  const sections = useMemo(() => buildStatement(money), [money])

  // The trail against the statement as it is now, cut at the first step that no
  // longer exists — which is what pricing a line does to its own row, since an
  // uncosted key and a costed one are deliberately different.
  const drill = useMemo(() => resolveTrail(sections, trail), [sections, trail])
  useEffect(() => {
    if (drill.length < trail.length) setTrail((cur) => cur.slice(0, drill.length))
  }, [drill.length, trail.length])

  // BACK TO THE STATEMENT WHEN THE PERIOD MOVES. A record step holds the payload
  // main sent for the OLD window — a ledger row that may not be in the new one
  // at all — and even the levels that would re-resolve correctly leave the
  // reader three deep in a report they did not ask for. Changing the period is
  // asking a different question; it gets the top of the answer.
  useEffect(() => {
    setTrail([])
  }, [range?.from, range?.to])

  const navigate = useCallback((depth: number) => {
    setTrail((cur) => (depth < 0 ? [] : cur.slice(0, depth + 1)))
  }, [])
  const push = useCallback((step: DrillStep) => setTrail((cur) => [...cur, step]), [])

  /** A figure opens what is behind it — unless nothing claims it. See
   *  `@shared/pnlDrill`: an unmapped line is a gap in the contract, which the
   *  enumeration test fails on rather than leaving as a dead click here. */
  const openLine = useCallback(
    (sectionKey: string, line: PnlLine): (() => void) | undefined =>
      pnlDrillReady && pnlDrillSource(line.key)
        ? () => push({ kind: 'line', sectionKey, key: line.key })
        : undefined,
    [push]
  )
  const openSection = useCallback(
    (section: PnlSection): (() => void) | undefined =>
      pnlDrillReady ? () => push({ kind: 'section', key: section.key }) : undefined,
    [push]
  )

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

  /**
   * WHAT THIS PROFIT LEAVES OUT.
   *
   * Read off the same `money` the statement is built from, and deliberately NOT
   * a section: every section is in `netProfit` and `pnlChecksum` asserts it, so
   * money that is missing FROM the bottom line cannot live in one. See
   * @shared/pnlOmissions.
   *
   * `PnlMoney` is the DAY shape; a period row and the all-time totals both
   * extend it with `dayCount` at runtime, which is the only grain where "4 of 21
   * nights" means anything. Read narrowly rather than widening the prop — a
   * single day passes no count, and "a night with no stock recorded" is still
   * true without a denominator.
   */
  const omissions = useMemo(
    () =>
      buildPnlOmissions({
        ...money,
        dayCount: (money as PnlMoney & { dayCount?: number }).dayCount ?? null
      }),
    [money]
  )

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
            Sections total <Money value={check.checksum} strong /> but the stored net profit is{' '}
            <Money value={check.stated} strong /> — <Money value={check.drift} strong /> out. Update
            the app and re-import.
          </p>
        </Note>
      )}

      {/* THE STATEMENT OR ONE OF ITS FIGURES OPENED, never both. QuickBooks
          replaces the report with the drill-down for the same reason: a list of
          records under the statement it came from puts two amount columns on one
          screen and leaves the reader to work out which of them they are reading.
          The trail across the top says where they are and the crumbs come back. */}
      {drill.length > 0 ? (
        <PnlDrillPanel
          stack={drill}
          sections={sections}
          range={range}
          rangeLabel={rangeLabel}
          onNavigate={navigate}
          onPush={push}
          onEnterCost={onCosted && costEntryReady ? setCosting : undefined}
        />
      ) : (
        <>
          {/* A table, not a stack of divs: one table means ONE amount column, so
              a section subtotal is guaranteed to sit on the same right edge as
              the lines above it. That alignment is the only way to eyeball
              whether a subtotal belongs to the lines it follows. */}
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
                onEnterCost={onCosted ? setCosting : undefined}
                onOpenLine={openLine}
                onOpenSection={openSection}
              />
            ))}
          </table>

          {/* UNDER THE BOTTOM LINE, AND OUTSIDE THE TABLE.
              Outside on purpose: the table has one amount column and every
              figure in it is in net profit. A row here is the opposite — money
              that is NOT in that number — and putting it on the same right edge
              is how somebody adds it up by mistake. */}
          {omissions.items.length > 0 && (
            <div className="fin-omit">
              <div className="fin-omit-head">
                <Icon name="AlertTriangle" size={15} />
                <span>
                  <b>What this profit does not include.</b>{' '}
                  {omissions.pricedTotal > 0 ? (
                    <>
                      Net profit above is at least <Money value={omissions.pricedTotal} strong /> too
                      high
                      {omissions.unpriceable > 0 ? ', and probably more — ' : '. '}
                    </>
                  ) : (
                    <>Net profit above is too high, by an amount this app cannot total — </>
                  )}
                  {omissions.unpriceable > 0 && (
                    <>
                      {omissions.unpriceable === 1 ? 'one cost below has' : `${omissions.unpriceable} costs below have`}{' '}
                      no figure the app can put on {omissions.unpriceable === 1 ? 'it' : 'them'} yet.
                    </>
                  )}
                </span>
              </div>
              <ul className="fin-omit-list">
                {omissions.items.map((o) => (
                  <li key={o.key} className="fin-omit-row">
                    <span className="fin-omit-label">{o.label}</span>
                    <span className="fin-omit-amt mono">
                      {o.amount === null ? (
                        <span className="muted">not priced</span>
                      ) : (
                        <Money value={o.amount} strong />
                      )}
                    </span>
                    <span className="fin-omit-detail">{o.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

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
        </>
      )}

      {costing && onCosted && (
        <UncostedModal
          items={costing}
          onClose={() => setCosting(null)}
          onSaved={async () => {
            setCosting(null)
            await onCosted()
          }}
        />
      )}
    </div>
  )
}

/**
 * A figure that opens what is behind it.
 *
 * Every money cell on the statement goes through here, including the ones that
 * print words rather than a number. The affordance is deliberately quiet — a
 * dotted underline that fills in on hover — because a P&L where twenty amounts
 * shout "click me" stops reading as a statement, and the one thing this feature
 * must not cost is the statement's own legibility.
 *
 * `onOpen` absent means there is nowhere to go: the figure prints exactly as it
 * did before, with a title saying why rather than a button that does nothing.
 */
function Figure({
  onOpen,
  label,
  children
}: {
  onOpen?: () => void
  /** What the click will open, for the screen reader and the tooltip. */
  label: string
  children: JSX.Element
}): JSX.Element {
  if (!onOpen) return children
  return (
    <button
      type="button"
      className="fin-pnl-amt"
      onClick={onOpen}
      title={`Show what makes up ${label}`}
    >
      {children}
    </button>
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
  revenue,
  onEnterCost,
  onOpenLine,
  onOpenSection
}: {
  section: PnlSection
  open: boolean
  onToggle: () => void
  showAll: boolean
  revenue: number | null
  onEnterCost?: (items: UncostedStreamItem[]) => void
  /** Both return undefined where there is nothing to open, so a figure with no
   *  drill-down prints as it always did rather than as a button that does
   *  nothing. */
  onOpenLine: (sectionKey: string, line: PnlLine) => (() => void) | undefined
  onOpenSection: (section: PnlSection) => (() => void) | undefined
}): JSX.Element {
  const cols = revenue === null ? 2 : 3

  // A running section is a milestone: it has no lines of its own, it is a
  // figure carried down from everything above it. Rendering it with a caret
  // would promise a disclosure that has nothing inside it.
  //
  // It still OPENS, and what it opens is the only honest answer to "what is
  // gross profit made of": the sections above it. That composition is precisely
  // what `pnlChecksum` sums, so it reconciles by the same construction the
  // statement's own assertion uses.
  if (section.running) {
    return (
      <tbody className="fin-pnl-sec is-running">
        <tr className={`fin-pnl-mile${section.key === 'netProfit' ? ' is-bottom' : ''}`}>
          <th scope="row">{section.subtotalLabel}</th>
          <td className="is-num">
            <Figure onOpen={onOpenSection(section)} label={section.subtotalLabel}>
              <Profit value={section.subtotal} />
            </Figure>
          </td>
          <ShareCell amount={section.subtotal} revenue={revenue} />
        </tr>
      </tbody>
    )
  }

  const visible = showAll ? section.lines : section.lines.filter((l) => !l.empty)
  const bodyId = `fin-pnl-${section.key}`

  return (
    <tbody className="fin-pnl-sec" id={bodyId}>
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
            {/* Every subtotal here is inside net profit, so the only thing a
                heading has to disclose is a section that could not count one of
                its own inputs — which makes the bottom line above it slightly
                too high. Sections are closed by default, so saying it inside
                would be saying it to nobody. */}
            {section.incomplete && <em className="fin-pnl-partial">not fully counted</em>}
            {!open && visible.length > 0 && (
              <em className="fin-pnl-count">{plural(visible.length, 'line')}</em>
            )}
          </button>
        </th>
        <td className="is-num">
          {/* The subtotal opens the lines that make it, whether or not the
              section is expanded. A reader who takes a figure off the column
              without opening anything is exactly who needs the way in. */}
          <Figure onOpen={onOpenSection(section)} label={section.subtotalLabel}>
            <Money value={section.subtotal} strong />
          </Figure>
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
          visible.map((line) => (
            <LineRow
              key={line.key}
              line={line}
              revenue={revenue}
              onEnterCost={onEnterCost}
              onOpen={onOpenLine(section.key, line)}
            />
          ))
        ))}

      {/* The section's own footnote, printed verbatim from the contract for the
          same reason a line's detail is: rewriting it here would put two
          versions of the same sentence in the app. Only the fees section has one
          today, and it is the sentence that stops a derived gross being read as
          a figure Whatnot stated.

          There was a second strip under this one, for a section carrying a live
          `warning` — drawn as an alarm rather than as prose, because a fact that
          changes the bottom line should not arrive in the same ink as a
          footnote. Packaging was the only section that ever set one, and both
          went together. A section that grows a condition again wants that
          treatment back rather than a longer note. */}
      {open && section.note && (
        <tr className="fin-pnl-note">
          <td colSpan={cols}>{section.note}</td>
        </tr>
      )}
    </tbody>
  )
}

function LineRow({
  line,
  revenue,
  onEnterCost,
  onOpen
}: {
  line: PnlLine
  revenue: number | null
  onEnterCost?: (items: UncostedStreamItem[]) => void
  /** The drill-down, when the contract knows where this line's money is. */
  onOpen?: () => void
}): JSX.Element {
  // NOBODY RECORDED WHAT THIS COST — and unlike the row below it, that is
  // something the reader can fix from here. The words replace the figure for the
  // same reason "not known" does: $0.00 says the cost did not happen, and this
  // cost happened. It is never hidden — `buildPnl` refuses to mark it `empty`,
  // so the zero-line toggle cannot swallow it either.
  //
  // THE CLICK NOW OPENS THE LINES RATHER THAN THE FORM. It used to go straight
  // to the price fields, which was one click quicker and answered none of "which
  // nights, which show, how many boxes" — the drill-down lists them and carries
  // the same form one button away, so the operator prices what they can see. The
  // old path stays as the fallback for a preload with no drill-down behind it:
  // whatever else changes, this row must not stop being actionable.
  if (line.uncosted) {
    const items = line.uncostedItems ?? []
    const priceHere = !!onEnterCost && costEntryReady && items.length > 0
    const act = onOpen ?? (priceHere ? () => onEnterCost?.(items) : undefined)
    return (
      <tr className="fin-pnl-line is-uncosted">
        <th scope="row">
          <span className="fin-pnl-label">{line.label}</span>
          {line.detail && <em className="fin-pnl-detail">{line.detail}</em>}
        </th>
        <td className="is-num">
          {act ? (
            <button
              type="button"
              className="fin-pnl-cost-btn mono"
              onClick={act}
              title={
                onOpen
                  ? `Show the stream lines behind ${line.label} — none of them carries a cost yet`
                  : `Enter what ${line.label} cost — it is carried at nothing until you do`
              }
            >
              no cost recorded
              <Icon name={onOpen ? 'ChevronRight' : 'Pencil'} size={11} />
            </button>
          ) : (
            <span
              className="fin-money zero mono"
              title="Nobody recorded what this cost, so it is carried at nothing"
            >
              no cost recorded
            </span>
          )}
        </td>
        {revenue !== null && (
          <td className="is-num fin-pnl-share">
            <span className="fin-money zero mono">—</span>
          </td>
        )}
      </tr>
    )
  }

  // The row above had a sibling: a line flagged `unavailable`, which printed
  // "not known" where the figure goes because the packaging model could not
  // count the envelopes for a night whose packing slips had been replaced. It
  // went with the packaging section — nothing on this statement is
  // measured-and-lost any more. If a figure ever is again, the shape to copy is
  // the one above and not the ordinary row below: words instead of a number, no
  // share cell, and never hidden by the zero-line toggle.
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
            same sentence in the app.

            `detailHint` is the answer to the one question a detail provokes and
            does not answer — today, why the card charge exceeds the card
            percentage of sales. It hangs off the hover because it is wanted
            once, by one reader, and printing it under the section made everybody
            else read it every time. */}
        {line.detail && (
          <em className="fin-pnl-detail" title={line.detailHint}>
            {line.detail}
          </em>
        )}
      </th>
      <td className="is-num">
        <Figure onOpen={onOpen} label={line.label}>
          <Money value={line.amount} dash />
        </Figure>
      </td>
      <ShareCell amount={line.amount} revenue={revenue} />
    </tr>
  )
}

/**
 * Price the stream lines behind one uncosted row, from the statement itself.
 *
 * The owner asked for this in "the streaming or finance", and finance is where
 * the hole is noticed: the statement is the screen that shows a night's cost of
 * goods short, so it is the screen that has to be able to fix it.
 *
 * ONE FORM PER LINE, not one for the row. A row can stand for the same product
 * broken on three nights, and those three boxes did not necessarily cost the
 * same — one price applied to all of them would be a guess dressed as an entry.
 * Each is priced in ITS OWN product's stock unit, per `priceUnit`, exactly as
 * the Streaming module does it.
 *
 * The panel says what this changes and what it does not. An operator's
 * reasonable reading of a cost field is that it re-values the shelf; it does
 * not, on either kind of line, and being told that here is cheaper than
 * discovering it in Inventory afterwards. See `setItemCost` in db/streaming.ts.
 */
function UncostedModal({
  items,
  onClose,
  onSaved
}: {
  items: UncostedStreamItem[]
  onClose: () => void
  onSaved: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [prices, setPrices] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const priced = items
    .map((it) => ({ item: it, price: parseMoneyInput(prices[it.id] ?? '') }))
    .filter((e) => Number.isFinite(e.price) && e.price >= 0)
  const anyBad = items.some(
    (it) => (prices[it.id] ?? '').trim() !== '' && !(parseMoneyInput(prices[it.id] ?? '') >= 0)
  )

  const save = async (): Promise<void> => {
    if (priced.length === 0) return
    setBusy(true)
    try {
      let saved = 0
      for (const entry of priced) {
        const res = await streaming.setItemCost({
          itemId: entry.item.id,
          unitPrice: entry.price
        })
        if (!res.ok) {
          toast.error(resultError(res, 'That cost could not be saved.'))
          break
        }
        saved += 1
      }
      // Reloaded even on a partial failure: some of the writes landed, and a
      // statement still showing the old figures for them is the one thing worse
      // than the failure itself.
      if (saved > 0) {
        toast.success(`${plural(saved, 'line')} costed. The statement below has moved with it.`)
        await onSaved()
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="What did this cost?"
      subtitle={`${plural(items.length, 'line')} carrying no cost`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="DollarSign"
            loading={busy}
            disabled={priced.length === 0 || anyBad}
            onClick={() => void save()}
          >
            {priced.length > 1 ? `Save ${priced.length} costs` : 'Save the cost'}
          </Button>
        </>
      }
    >
      {items.map((it) => {
        const one = it.priceUnit ? stockUnitWord(it.priceUnit, 1) : 'unit'
        const many = it.priceUnit ? stockUnitWord(it.priceUnit, 2) : 'units'
        const price = parseMoneyInput(prices[it.id] ?? '')
        const total = Number.isFinite(price) && price >= 0 ? it.quantity * price : null
        return (
          <Field
            key={it.id}
            label={`${shortDayLabel(it.streamDate)} · ${it.sessionTitle || 'Untitled show'}`}
            hint={
              total !== null
                ? `${formatUnitCount(it.quantity)} ${
                    it.quantity === 1 ? one : many
                  } → ${moneyText(Math.round(total * 100) / 100)} on that night`
                : `${formatUnitCount(it.quantity)} ${
                    it.quantity === 1 ? one : many
                  } ${it.kind === 'giveaway' ? 'given away' : 'broken'} · price per ${one}`
            }
          >
            <Input
              inputMode="decimal"
              value={prices[it.id] ?? ''}
              onChange={(e) => setPrices((p) => ({ ...p, [it.id]: e.target.value }))}
              placeholder={`what one ${one} cost`}
              invalid={(prices[it.id] ?? '').trim() !== '' && !(price >= 0)}
            />
          </Field>
        )
      })}

      <Note tone="info" icon="Info">
        <b>This corrects the statement, not the stock.</b>
        <p>
          {items.every((i) => i.reconciled)
            ? 'These lines never moved stock, so no shelf changes when the price does.'
            : 'That stock is already gone. Its cost layers stay as they are; only what the night cost changes.'}
        </p>
      </Note>
    </Modal>
  )
}

/**
 * FINANCE → COMPLETE P&L: the statement as a report you can open.
 *
 * This tab said "not built yet" for four releases, and the reason it gave was
 * honest at the time: a complete P&L means streaming plus wholesale plus
 * overhead, and two of those three are not recorded anywhere. That reason has
 * not gone away and is still printed at the foot of this page — what changed is
 * what the owner asked for, which was not the missing halves but the ability to
 * READ the half that exists the way QuickBooks lets him read one: click a
 * figure, land on the transactions inside it, click one of those, see the
 * record.
 *
 * So this is the streaming statement with every figure on it openable, over a
 * range this tab picks for itself. It is deliberately NOT the Streaming tab
 * again: no calendar, no widgets, no import panel, no unattributed pile. Those
 * answer "what happened and can I trust the file"; this answers "what does this
 * number consist of", and a page that tried to do both would bury the statement
 * under the apparatus around it.
 *
 * ONE READ, like every other finance screen. `streamView()` derives the days,
 * the rollups and the reconciliation verdict in a single pass; the range is
 * applied to the DAYS with the contract's own accumulator, so a range that lines
 * up with a week produces that week's figures to the cent and the drill-down
 * asks main about exactly the window on screen.
 */
export function CompletePnl(): JSX.Element {
  const { can } = useSession()
  // Entering a cost against a stream line is a STREAMING write — it edits
  // `stream_items` — so it is gated on the streaming permission even though the
  // click happens on the P&L.
  const canCostLines = can('streaming.manage')

  const [view, setView] = useState<StreamingFinanceView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  /** Null is all time, the same null the Streaming tab's range uses. */
  const [range, setRange] = useState<DayRange | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const next = await finance.streamView()
        if (alive) setView(next)
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'The P&L could not be read.')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [attempt])

  // A ledger import or a cost entered on another machine changes every figure
  // here. Reuses the retry counter rather than adding a second way to reload.
  useLiveRefresh(LIVE.finance, () => setAttempt((n) => n + 1))

  const totals = useMemo(() => totalsForRange(view?.days ?? [], range), [view, range])
  const covered = useMemo(() => coveredRange(view?.days ?? []), [view])
  const rangeLabel = range
    ? dayRangeLabel(range.from, range.to)
    : covered
      ? `All time · ${dayRangeLabel(covered.from, covered.to)}`
      : 'All time'

  if (loading) return <CenterLoader />

  if (error || !view) {
    return (
      <Note tone="danger" icon="AlertTriangle" role="alert">
        <b>The P&amp;L could not be read.</b>
        <p>{error ?? 'Nothing came back.'}</p>
        <Button size="sm" icon="RefreshCw" onClick={() => setAttempt((a) => a + 1)}>
          Try again
        </Button>
      </Note>
    )
  }

  return (
    <div className="fin-stream">
      {/* Reconciliation first and unconditionally. If the rows do not add up,
          nothing below means what it says — and this is the one screen whose
          whole promise is that every figure can be opened and checked. */}
      {!view.reconciled && (
        <Note tone="danger" icon="AlertTriangle" role="alert">
          <b>These numbers do not add up — do not use them yet.</b>
          <p>
            {view.reconcileNote ??
              'Some rows are neither on a day nor in the unattributed pile, so the totals below are incomplete.'}
          </p>
          <p>Re-attribute on the Streaming tab, and re-import if that does not clear it.</p>
        </Note>
      )}

      <section className="fin-head" aria-label="Complete profit and loss">
        <div className="fin-head-top">
          <h2>Complete P&amp;L</h2>
          <span className="fin-head-scope">{rangeLabel}</span>
        </div>
        <RangeBar range={range} weeks={view.weeks} months={view.months} onRange={setRange} />
      </section>

      <section className="fin-stmt" aria-label={`Profit and loss for ${rangeLabel}`}>
        {totals.dayCount === 0 ? (
          // Every figure would be zero, and a full statement of zeros invites the
          // reader to wonder which of them is a finding. None of them is.
          <p className="fin-detail-empty">
            <Icon name="Moon" size={14} />
            No show landed in this range. Widen it, or pick a month with shows in it.
          </p>
        ) : (
          <PnlStatement
            money={totals}
            range={range}
            rangeLabel={rangeLabel}
            /* Only offered to somebody who may write a stream line, and the
               whole view is re-read afterwards rather than patched: a cost lands
               on cost of goods, gross profit, net profit and every rollup that
               contains the day. */
            onCosted={canCostLines ? () => setAttempt((n) => n + 1) : undefined}
          />
        )}
      </section>

      {/* THE HALF THAT IS NOT HERE, said plainly and at the bottom rather than
          instead of the statement. The old placeholder was right that adding
          streaming to an empty wholesale figure would report a profit that is
          too high; it was wrong to withhold the statement that does exist over
          it. Both facts fit on one page. */}
      <Note tone="info" icon="Info">
        <b>This is the streaming business, complete down to net profit.</b>
        <p>
          Complete for streaming. Wholesale and overhead are not recorded anywhere yet, so neither
          is in this total.
        </p>
      </Note>
    </div>
  )
}
