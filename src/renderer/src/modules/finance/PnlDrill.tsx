import { useEffect, useMemo, useState } from 'react'
import type { PnlLine, PnlSection, UncostedStreamItem } from '@shared/financeStreaming'
import type {
  PnlDerivedTerm,
  PnlDetail,
  PnlLedgerRecord,
  PnlStreamItemRecord
} from '@shared/pnlDrill'
import type { GeneralExpense } from '@shared/financeStreaming'
import { asUncostedStreamItem, pnlDetailCount } from '@shared/pnlDrill'
import { formatUnitCount, stockUnitWord } from '../../lib/productUnits'
import { Icon } from '../../components/Icon'
import { Money, Note, moneyText, plural } from './bits'
import { LedgerRowLine } from './LedgerRows'
import { finance } from './api'
import type { DayRange } from './range'
import { longDayLabel, shortDayLabel, timeLabel } from './time'

/**
 * DRILLING INTO THE STATEMENT — the QuickBooks move, in this app's clothes.
 *
 * Read the P&L, click a figure, land on the records that add up to it; click one
 * of those and see the record itself; get back with the trail across the top.
 * That is the entire feature, and the reason it matters is that a number nobody
 * can open is a number that has to be taken on faith. The owner's whole
 * complaint about every previous version of this screen was some variant of
 * "where does that come from".
 *
 * ## Three levels and a stack, not a router
 *
 * A section subtotal opens the lines that make it. A line opens the records. A
 * record opens itself. The path is a plain array — push to go in, slice to come
 * back — so the crumbs, the back button and the browser-less shell all read the
 * same state, and there is no way to reach a screen the crumbs cannot describe.
 *
 * ## The composition level is computed HERE and the records are not
 *
 * A section's lines are already in hand: `buildPnl` returned them with the
 * statement, they sum to the subtotal by construction, and asking main to
 * rebuild the whole view to answer "what is in Revenue" would be a full ledger
 * scan for an answer already on screen. Records are the opposite — they are the
 * thing deliberately NOT loaded with the statement — so those are one call per
 * click. See `@shared/pnlDrill` for the line-id → source contract.
 *
 * ## Every level states its own reconciliation
 *
 * Each view prints "these N records total $X" beside the figure it drilled from,
 * and shouts when the two differ. That is not decoration: a detail list that
 * quietly disagrees with its own line is worse than none, because it either
 * makes a correct statement look wrong or hides a real skew behind a plausible
 * list of rows.
 */

/** Anything below half a cent is zero — float sums arrive as -0 and 1e-13. */
const isZero = (n: number): boolean => Math.abs(n) < 0.005

/**
 * One step of the trail, held BY KEY rather than by the section or line object.
 *
 * That is not fussiness. Pricing an uncosted line from inside the drill-down
 * reloads every figure on the page, and a trail holding the objects captured on
 * the way in would then be showing the arithmetic from before the save — the
 * statement's own comments call that out as worse than a control that cannot be
 * clicked at all. Keys are re-resolved against the current statement on every
 * render, so the drill view can only ever show figures the statement above it
 * agrees with.
 *
 * A record is the exception and holds its payload: it came from main, it is not
 * in the statement, and it is a leaf.
 */
export type DrillStep =
  | { kind: 'section'; key: string }
  | { kind: 'line'; sectionKey: string; key: string }
  | { kind: 'record'; label: string; record: DrillRecord }

/** A step with its section or line found. What the panel actually renders. */
export type DrillNode =
  | { kind: 'section'; section: PnlSection }
  | { kind: 'line'; line: PnlLine }
  | { kind: 'record'; label: string; record: DrillRecord }

export type DrillRecord =
  | { kind: 'ledger'; rec: PnlLedgerRecord }
  | { kind: 'item'; rec: PnlStreamItemRecord }
  | { kind: 'expense'; rec: GeneralExpense }

/**
 * The trail against the statement as it is NOW, cut at the first step that no
 * longer exists.
 *
 * Steps DO disappear, and the case that matters is the good one: price an
 * uncosted line and its key changes — `cogs:break:uncosted:X` becomes
 * `cogs:break:X` — so the trail truncates to the section above it, which now
 * shows the costed line with its money on it. Landing one level up on a view
 * that reflects what just happened beats both alternatives: a dead view of a
 * line that is gone, or being thrown back to the top of the statement.
 */
export function resolveTrail(sections: PnlSection[], trail: DrillStep[]): DrillNode[] {
  const out: DrillNode[] = []
  for (const step of trail) {
    if (step.kind === 'record') {
      out.push(step)
      continue
    }
    if (step.kind === 'section') {
      const section = sections.find((s) => s.key === step.key)
      if (!section) break
      out.push({ kind: 'section', section })
      continue
    }
    const line = sections
      .find((s) => s.key === step.sectionKey)
      ?.lines.find((l) => l.key === step.key)
    if (!line) break
    out.push({ kind: 'line', line })
  }
  return out
}

/** The label a node wears in the breadcrumb trail. */
export function drillLabel(node: DrillNode): string {
  return node.kind === 'section' ? node.section.label : node.kind === 'line' ? node.line.label : node.label
}

/**
 * One row of a composition view: a line inside a section, or a section inside a
 * running total.
 *
 * `open` is what makes it a rung rather than a leaf. Everything on this screen
 * that shows money is clickable if there is anywhere for it to go, which is the
 * promise the whole feature makes.
 */
interface CompositionRow {
  key: string
  label: string
  detail?: string
  /** Hover text for the detail, carried through from the line — see
   *  `PnlLine.detailHint`. The same words in both places or in neither. */
  detailHint?: string
  amount: number
  words?: string
  open?: () => void
}

/**
 * What a section is made of.
 *
 * A RUNNING SECTION IS NOT MADE OF LINES — gross profit and net profit have
 * none, because they are figures carried down from everything above them. So
 * those drill to the SECTIONS they are carried down from, which is exactly what
 * `pnlChecksum` sums and therefore reconciles by the same construction the
 * statement's own assertion uses. Gross profit stops at cost of goods because
 * that is where it is struck; net profit takes every non-running section there
 * is.
 */
function compose(
  sections: PnlSection[],
  section: PnlSection,
  push: (step: DrillStep) => void
): CompositionRow[] {
  if (!section.running) {
    return section.lines.map((line) => ({
      key: line.key,
      label: line.label,
      detail: line.detail,
      detailHint: line.detailHint,
      amount: line.amount,
      words: line.uncosted ? 'no cost recorded' : undefined,
      open: () => push({ kind: 'line', sectionKey: section.key, key: line.key })
    }))
  }
  const upto = sections.findIndex((s) => s.key === section.key)
  const feeding = sections.filter(
    (s, i) => !s.running && (section.key === 'grossProfit' ? i < upto : true)
  )
  return feeding.map((s) => ({
    key: s.key,
    label: s.subtotalLabel,
    detail: s.incomplete ? 'not fully counted' : undefined,
    amount: s.subtotal,
    open: () => push({ kind: 'section', key: s.key })
  }))
}

export function PnlDrillPanel({
  stack,
  sections,
  range,
  rangeLabel,
  onNavigate,
  onPush,
  onEnterCost
}: {
  /** Never empty — the caller renders the statement instead when it is. */
  stack: DrillNode[]
  /** The whole statement, for the running totals' composition. */
  sections: PnlSection[]
  /** What the tab is reporting on. Null is all time, exactly as elsewhere. */
  range: DayRange | null
  rangeLabel: string
  /** A depth to cut the trail back to — the crumbs and the back arrow both call
   *  it, and -1 is the statement itself. Going back is a slice rather than a
   *  pop so a crumb three levels up is one click, not three. */
  onNavigate: (depth: number) => void
  /** One step deeper. The trail lives with the statement, not here: it has to
   *  survive this panel remounting when the range or the figures change. */
  onPush: (step: DrillStep) => void
  /** Offered where the reader may price a stream line. The modal lives with the
   *  statement so it outlives the reload that follows a save. */
  onEnterCost?: (items: UncostedStreamItem[]) => void
}): JSX.Element {
  const node = stack[stack.length - 1]

  return (
    <div className="fin-drill">
      <nav className="fin-crumbs" aria-label="Where you are in the statement">
        <button type="button" className="fin-crumb" onClick={() => onNavigate(-1)}>
          <Icon name="ArrowLeft" size={13} />
          Profit &amp; loss
        </button>
        {stack.map((n, i) => (
          <span className="fin-crumb-step" key={`${drillLabel(n)}-${i}`}>
            <Icon name="ChevronRight" size={12} />
            {i === stack.length - 1 ? (
              <b className="fin-crumb is-here">{drillLabel(n)}</b>
            ) : (
              <button type="button" className="fin-crumb" onClick={() => onNavigate(i)}>
                {drillLabel(n)}
              </button>
            )}
          </span>
        ))}
      </nav>

      <p className="fin-drill-scope">
        <Icon name="CalendarRange" size={12} />
        {rangeLabel}
      </p>

      {node.kind === 'section' ? (
        <CompositionView section={node.section} rows={compose(sections, node.section, onPush)} />
      ) : node.kind === 'line' ? (
        <LineView
          line={node.line}
          range={range}
          onOpenRecord={(label, record) => onPush({ kind: 'record', label, record })}
          onEnterCost={onEnterCost}
        />
      ) : (
        <RecordView record={node.record} onEnterCost={onEnterCost} />
      )}
    </div>
  )
}

/**
 * The lines behind a subtotal.
 *
 * Every one of them is a rung: the amounts here are the statement's own line
 * amounts, so clicking one is the same click as clicking it on the statement.
 * Nothing is fetched — see the note at the top of the file for why the
 * composition level is the one thing computed on this side.
 */
function CompositionView({
  section,
  rows
}: {
  section: PnlSection
  rows: CompositionRow[]
}): JSX.Element {
  const sum = rows.reduce((n, r) => n + r.amount, 0)
  return (
    <>
      <DrillHead
        title={section.subtotalLabel}
        figure={section.subtotal}
        stated={section.subtotal}
        found={sum}
        countLabel={plural(rows.length, section.running ? 'section' : 'line')}
        derived={false}
      />
      {section.note && <p className="fin-drill-note">{section.note}</p>}
      {rows.length === 0 ? (
        <p className="fin-detail-empty">
          <Icon name="Info" size={14} />
          This section has no lines in this range.
        </p>
      ) : (
        <ul className="fin-rows">
          {rows.map((r) => (
            <li key={r.key}>
              <button
                type="button"
                className="fin-row is-openable"
                onClick={r.open}
                disabled={!r.open}
              >
                <span className="fin-row-msg is-lead" title={r.label}>
                  {r.label}
                </span>
                {r.detail && (
                  <span className="fin-row-note" title={r.detailHint}>
                    {r.detail}
                  </span>
                )}
                {r.words ? (
                  <span className="fin-money zero mono fin-row-words">{r.words}</span>
                ) : (
                  <Money value={r.amount} dash />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/**
 * The records behind one line, fetched on arrival.
 *
 * One call, one line, one range — never the whole statement's worth. `total` on
 * the payload is the sum of EVERY matching record rather than of the page that
 * came back, so the reconciliation printed above the list is a claim about the
 * whole period even when the list is not.
 */
function LineView({
  line,
  range,
  onOpenRecord,
  onEnterCost
}: {
  line: PnlLine
  range: DayRange | null
  onOpenRecord: (label: string, record: DrillRecord) => void
  onEnterCost?: (items: UncostedStreamItem[]) => void
}): JSX.Element {
  const [detail, setDetail] = useState<PnlDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const start = range?.from ?? null
  const end = range?.to ?? null

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const next = await finance.pnlDetail({ lineId: line.key, start, end })
        if (alive) setDetail(next)
      } catch (err) {
        if (alive) {
          setError(err instanceof Error ? err.message : 'Those records could not be read.')
        }
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
    // THE AMOUNT IS A DEPENDENCY, and it is the one that is easy to leave out.
    // Pricing a stream line from this very view moves the figure this list has
    // to add up to; without it the records stay as they were fetched and the
    // reconciliation above them starts screaming about a gap that is entirely
    // this component's own staleness.
  }, [line.key, line.amount, start, end])

  // Every uncosted line in the payload, in the shape the existing cost form
  // takes. Offered as one action above the list rather than per row: a product
  // left unpriced on three nights is three prices, and the form already asks for
  // them one at a time.
  const uncosted = useMemo<UncostedStreamItem[]>(
    () =>
      detail?.kind === 'streamItems'
        ? detail.items.filter((i) => isZero(i.amount)).map(asUncostedStreamItem)
        : [],
    [detail]
  )

  if (loading) {
    return (
      <p className="fin-detail-empty">
        <span className="spinner dark" />
        Reading the records behind {line.label}…
      </p>
    )
  }

  if (error || !detail) {
    return (
      <Note tone="danger" icon="AlertTriangle" role="alert">
        <b>Those records could not be read.</b>
        <p>{error ?? 'Nothing came back.'}</p>
      </Note>
    )
  }

  const records = pnlDetailCount(detail)
  const derived = detail.kind === 'derived'

  return (
    <>
      <DrillHead
        title={line.label}
        figure={line.amount}
        stated={line.amount}
        found={detail.total}
        countLabel={plural(
          records,
          derived ? 'night' : detail.kind === 'expenses' ? 'entry' : 'record',
          derived ? 'nights' : detail.kind === 'expenses' ? 'entries' : 'records'
        )}
        derived={derived}
        words={line.uncosted ? 'no cost recorded' : undefined}
      />

      {line.detail && <p className="fin-drill-basis">{line.detail}</p>}
      {/* A note the payload marked `danger` is a build fault, not a footnote, so
          it gets the statement's own alarm rather than the grey paragraph — and
          only while the figure it describes is actually there. The residual is
          the one line that sets it: zero residual, nothing to report. */}
      {detail.note &&
        (detail.noteTone === 'danger' ? (
          !isZero(line.amount) && (
            <Note tone="danger" icon="AlertTriangle" role="alert">
              {detail.note}
            </Note>
          )
        ) : (
          <p className="fin-drill-note">{detail.note}</p>
        ))}

      {uncosted.length > 0 && onEnterCost && (
        <button
          type="button"
          className="fin-more"
          onClick={() => onEnterCost(uncosted)}
          title="Enter what these lines cost — they are carried at nothing until you do"
        >
          <Icon name="Pencil" size={14} />
          Price the {plural(uncosted.length, 'line')} carrying no cost
        </button>
      )}

      {records === 0 ? (
        <p className="fin-detail-empty">
          <Icon name="Info" size={14} />
          {isZero(detail.total)
            ? 'Nothing in this range contributed to this line.'
            : 'No record could be found for this figure — see above.'}
        </p>
      ) : detail.kind === 'ledgerRows' ? (
        <ul className="fin-rows">
          {detail.rows.map((r) => (
            <LedgerRowLine
              key={r.row.id}
              row={r.row}
              amount={r.amount}
              basis={r.basis}
              onOpen={() => onOpenRecord(timeLabel(r.row.occurredAt), { kind: 'ledger', rec: r })}
            />
          ))}
        </ul>
      ) : detail.kind === 'streamItems' ? (
        <ul className="fin-rows">
          {detail.items.map((it) => (
            <li key={it.id}>
              <button
                type="button"
                className="fin-row is-openable"
                onClick={() => onOpenRecord(it.productName, { kind: 'item', rec: it })}
              >
                <span className="fin-row-time mono">{shortDayLabel(it.streamDate)}</span>
                <span className={`fin-bucket tone-${it.kind === 'giveaway' ? 'ignored' : 'expense'}`}>
                  <Icon name={it.kind === 'giveaway' ? 'Gift' : 'Package'} size={11} />
                  {it.kind === 'giveaway' ? 'Given away' : 'Broken'}
                </span>
                <span className="fin-row-msg is-lead" title={it.productName}>
                  {it.productName}
                </span>
                <span className="fin-row-note">{unitCount(it)}</span>
                {isZero(it.amount) ? (
                  <span className="fin-money zero mono fin-row-words">no cost recorded</span>
                ) : (
                  <Money value={it.amount} />
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : detail.kind === 'expenses' ? (
        <ul className="fin-rows">
          {detail.entries.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                className="fin-row is-openable"
                onClick={() => onOpenRecord(e.label, { kind: 'expense', rec: e })}
              >
                <span className="fin-row-time mono">{shortDayLabel(e.streamDate)}</span>
                <span className="fin-row-msg is-lead" title={e.label}>
                  {e.label}
                </span>
                {e.note && <span className="fin-row-note">{e.note}</span>}
                {/* Stored positive, booked as a cost. `cost` rather than a minus
                    typed here, so the sign comes from the one component that
                    decides what an outflow looks like on this screen. */}
                <Money value={e.amount} cost />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <DerivedTerms terms={detail.terms} />
      )}

      {detail.omitted.count > 0 && (
        <p className="fin-detail-foot">
          {plural(detail.omitted.count, 'further record')} worth{' '}
          {moneyText(detail.omitted.amount)} {detail.omitted.count === 1 ? 'is' : 'are'} inside the
          total above and not listed — narrow the range to see them.
        </p>
      )}
    </>
  )
}

/** "2 cases" / "1.25 boxes" — in the product's own stock unit, which is the unit
 *  a price for the line would be per. */
function unitCount(it: PnlStreamItemRecord): string {
  const one = it.priceUnit ? stockUnitWord(it.priceUnit, 1) : 'unit'
  const many = it.priceUnit ? stockUnitWord(it.priceUnit, 2) : 'units'
  return `${formatUnitCount(it.quantity)} ${it.quantity === 1 ? one : many}`
}

/**
 * A modelled figure, night by night.
 *
 * The terms are the arithmetic, not a list of records, and the heading above
 * says so. What makes them worth showing anyway is that they add to the same
 * figure — "5,300 cards × 5¢" on a night is something a person can check with a
 * calculator, which is the only claim a cost model is entitled to make.
 *
 * It used to print a second block under these: the nights the packaging model
 * could not price at all, named, because a line reading "not known" that drilled
 * to an empty table would have said the cost did not happen. That went with the
 * packaging section, and no payload carries such a night any more. Today the only
 * derived line is the cost-of-goods residual, which has no terms either and says
 * so in its note.
 */
function DerivedTerms({ terms }: { terms: PnlDerivedTerm[] }): JSX.Element {
  return (
    <>
      {terms.length > 0 && (
        <ul className="fin-rows">
          {terms.map((t) => (
            <li key={t.key}>
              <span className="fin-row">
                <span className="fin-row-time mono">{shortDayLabel(t.label)}</span>
                <span className="fin-row-msg is-lead">{t.detail}</span>
                <Money value={t.amount} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/**
 * The heading of every drill view, and the reconciliation it has to make.
 *
 * The figure that was clicked on the left, what the records below add to on the
 * right, and a loud disagreement between them when there is one. The gap is
 * printed rather than described: "these rows are $12.40 short of the line" is
 * something somebody can go and look for.
 */
function DrillHead({
  title,
  figure,
  stated,
  found,
  countLabel,
  derived,
  words
}: {
  title: string
  figure: number
  stated: number
  found: number
  countLabel: string
  /** Modelled rather than transacted — the badge that stops a rate-blended
   *  figure being read as a list of transactions. */
  derived: boolean
  /** The line printed words instead of a figure. Repeated here so the drill
   *  never turns "no cost recorded" back into $0.00. */
  words?: string
}): JSX.Element {
  const drift = Math.round((found - stated) * 100) / 100
  const ok = isZero(drift)
  return (
    <>
      <header className="fin-drill-head">
        <div className="fin-drill-title">
          <h4>{title}</h4>
          {derived && (
            <span
              className="fin-drill-tag"
              title="Counts priced at a stated rate — arithmetic, not transactions."
            >
              <Icon name="Calculator" size={11} />
              derived
            </span>
          )}
        </div>
        {words ? (
          <span className="fin-money zero mono fin-drill-figure">{words}</span>
        ) : (
          <span className="fin-drill-figure">
            <Money value={figure} strong />
          </span>
        )}
      </header>

      {ok ? (
        <p className="fin-drill-recon">
          <Icon name="CheckCircle2" size={13} />
          {countLabel} below, totalling <Money value={found} /> — exactly the figure above.
        </p>
      ) : (
        <Note tone="danger" icon="AlertTriangle" role="alert">
          <b>This detail does not add up to the line it came from.</b>
          <p>
            {countLabel} below total <Money value={found} strong />, but the statement reports{' '}
            <Money value={stated} strong /> — a difference of <Money value={drift} strong />. One of
            the two is wrong; do not book from either until it is found.
          </p>
        </Note>
      )}
    </>
  )
}

/**
 * The record itself — the end of the trail.
 *
 * Facts, in the words the underlying table uses, including the ones nobody
 * normally wants: the raw message a classifier read, the fingerprint a
 * re-upload is de-duplicated on, the location a break took its stock from. This
 * is the level somebody reaches when they have stopped believing a figure, and
 * at that point paraphrasing is the opposite of helpful.
 */
function RecordView({
  record,
  onEnterCost
}: {
  record: DrillRecord
  onEnterCost?: (items: UncostedStreamItem[]) => void
}): JSX.Element {
  if (record.kind === 'ledger') {
    const { row, amount, basis } = record.rec
    return (
      <>
        <header className="fin-drill-head">
          <div className="fin-drill-title">
            <h4>Ledger row</h4>
            <span className={`fin-bucket tone-${row.amount < 0 ? 'expense' : 'revenue'}`}>
              {row.txnType || 'row'}
            </span>
          </div>
          <span className="fin-drill-figure">
            <Money value={amount} strong />
          </span>
        </header>
        {basis && <p className="fin-drill-basis">{basis}</p>}
        <Facts
          rows={[
            ['Message', row.message],
            ['Occurred', `${longDayLabel(row.occurredAt.slice(0, 10))} · ${timeLabel(row.occurredAt)}`],
            ['Business day', row.streamDate ? longDayLabel(row.streamDate) : 'not on a show'],
            [
              'Attribution',
              row.attribution === 'carried_back'
                ? 'settled after the show ended and was booked back to it'
                : row.attribution
            ],
            ['Bucket', row.bucket],
            ['Ledger amount', moneyText(row.amount)],
            ['Order ID', row.orderId || '—'],
            ['Listing ID', row.listingId || '—'],
            ['Break', row.breakNumber === null ? '—' : `#${row.breakNumber}`],
            ['Repaired on import', row.repaired ? 'yes — the export was malformed' : 'no'],
            ['Fingerprint', row.fingerprint]
          ]}
        />
      </>
    )
  }

  if (record.kind === 'item') {
    const it = record.rec
    const uncosted = isZero(it.amount)
    return (
      <>
        <header className="fin-drill-head">
          <div className="fin-drill-title">
            <h4>{it.productName}</h4>
            <span className={`fin-bucket tone-${it.kind === 'giveaway' ? 'ignored' : 'expense'}`}>
              <Icon name={it.kind === 'giveaway' ? 'Gift' : 'Package'} size={11} />
              {it.kind === 'giveaway' ? 'Given away' : 'Broken'}
            </span>
          </div>
          {uncosted ? (
            <span className="fin-money zero mono fin-drill-figure">no cost recorded</span>
          ) : (
            <span className="fin-drill-figure">
              <Money value={it.amount} strong />
            </span>
          )}
        </header>
        <Facts
          rows={[
            ['Show', `${longDayLabel(it.streamDate)} · ${it.sessionTitle || 'Untitled show'}`],
            ['Quantity', unitCount(it)],
            ['Break', it.breakNumber === null ? '—' : `#${it.breakNumber}`],
            ['Stock location', it.location || '—'],
            [
              'Kind of line',
              it.reconciled
                ? 'a reconciliation — it moved no stock, it records what a show already history cost'
                : 'a live line — the stock came off the shelf when it was recorded'
            ],
            ['Note', it.note || '—']
          ]}
        />
        {uncosted && onEnterCost && (
          <button
            type="button"
            className="fin-more"
            onClick={() => onEnterCost([asUncostedStreamItem(it)])}
          >
            <Icon name="Pencil" size={14} />
            Enter what this cost
          </button>
        )}
      </>
    )
  }

  const e = record.rec
  return (
    <>
      <header className="fin-drill-head">
        <div className="fin-drill-title">
          <h4>{e.label}</h4>
          <span className="fin-bucket tone-expense">typed by hand</span>
        </div>
        <span className="fin-drill-figure">
          <Money value={e.amount} cost strong />
        </span>
      </header>
      <Facts
        rows={[
          ['Business day', longDayLabel(e.streamDate)],
          ['Note', e.note || '—'],
          ['Entered', e.createdAt.slice(0, 10)],
          ['Last changed', e.updatedAt.slice(0, 10)]
        ]}
      />
      <p className="fin-drill-note">
        A dollar amount against a day — nothing here came off a shelf.
      </p>
    </>
  )
}

function Facts({ rows }: { rows: Array<[string, string]> }): JSX.Element {
  return (
    <dl className="fin-facts">
      {rows.map(([k, v]) => (
        <div className="fin-fact" key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}
