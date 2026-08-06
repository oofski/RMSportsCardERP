/**
 * The records behind one P&L line, over one range.
 *
 * `@shared/pnlDrill` says WHERE each line's money lives. This file goes and gets
 * it, and it is the only place that reads a source. One query per click, never
 * with the statement: a five-week export is nine thousand ledger rows and almost
 * none of them are ever opened, so paying for all of them to render a column of
 * subtotals would be paying for a page nobody asked for.
 *
 * ## Nothing here re-derives a figure the statement already has
 *
 * The rules that decide what a line means live in `buildView` and in `buildPnl`,
 * and every one of them is reused rather than restated:
 *
 *   - the same attribution filter (`session_id IS NOT NULL OR attribution =
 *     'own_day'`), so a row orphaned by a deleted session cannot appear under a
 *     day it no longer belongs to;
 *   - the same `deriveSaleFee`, handed the same BUSINESS DAY, so a drill into
 *     the sales line prices each row exactly as the day that contains it did —
 *     a show running past midnight into another rate period would otherwise make
 *     the detail disagree with the statement by a few dollars, with nothing on
 *     screen to explain it;
 *   - the same `mergeCogsItems` and the same cap, so the roll-up tail is
 *     precisely the products the statement rolled up.
 *
 * ## Totals cover everything; the list may not
 *
 * `total` is summed over every matching record before the page limit is applied.
 * A month of break spots is thousands of rows and no screen wants them, but a
 * total that quietly meant "the first thousand" would be a reconciliation the
 * reader could not trust — so what is left out is counted and its money is
 * reported beside it.
 */
import type { Database } from 'better-sqlite3'
import type { CogsItem } from '@shared/financeStreaming'
import { COGS_LINES_MAX, UNNAMED_PRODUCT, deriveSaleFee, mergeCogsItems } from '@shared/financeStreaming'
import type {
  PnlDetail,
  PnlDrillRequest,
  PnlLedgerRecord,
  PnlStreamItemRecord,
  PnlStreamItemSelector
} from '@shared/pnlDrill'
import { PNL_DRILL_LIMIT, pnlDrillSource } from '@shared/pnlDrill'
// NEITHER THE PACKAGING RATES NOR `packagingFactsByDay` ARE IMPORTED HERE ANY
// MORE. They priced the six packaging lines' per-night terms, and the statement
// stopped emitting those lines when the owner took packaging off the P&L. Both
// modules are untouched and still price every night for the fields a day carries
// — see `StreamDayFinance` — so reinstating the section brings these imports and
// the resolver they fed back together.
import { getDb } from './database'
import {
  LEDGER_ROW_COLUMNS,
  type RawLedgerRow,
  toLedgerRow
} from './financeStreaming'
import { stockUnitOf } from './inventory'
import { rateLookup } from './whatnotRates'

const toCents = (dollars: number): number => Math.round(dollars * 100)
const toDollars = (cents: number): number => Math.round(cents) / 100

/** "1,029" — pinned to en-US like every other count the statement writes, so the
 *  same period does not render two ways on two desks. */
const count = (n: number): string => n.toLocaleString('en-US')

const usd = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })

/** An ISO business day, or null for "no bound". Anything else is refused rather
 *  than pasted into a WHERE clause. */
const dayKey = (v: string | null | undefined): string | null =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null

interface Bounds {
  start: string | null
  end: string | null
}

/**
 * The range clause for a column holding a business day.
 *
 * Both bounds absent is ALL TIME, which is the null range the tab's own control
 * uses — carried through rather than turned into sentinel dates somebody would
 * have to recognise.
 */
function rangeClause(column: string, b: Bounds, args: Record<string, unknown>): string {
  const parts: string[] = []
  if (b.start) {
    parts.push(`${column} >= @drillStart`)
    args.drillStart = b.start
  }
  if (b.end) {
    parts.push(`${column} <= @drillEnd`)
    args.drillEnd = b.end
  }
  return parts.length ? ` AND ${parts.join(' AND ')}` : ''
}

/**
 * The records behind one statement line.
 *
 * Never throws for a line it does not recognise: an unmapped id comes back as an
 * empty ledger list carrying a note that says so, because the screen's
 * reconciliation check then reports "0 records against $X" — which is exactly
 * what has gone wrong — rather than a red error box that says nothing about
 * which line is missing from the contract.
 */
export function pnlDetail(req: PnlDrillRequest, db: Database = getDb()): PnlDetail {
  const lineId = String(req?.lineId ?? '')
  const label = ''
  const bounds: Bounds = { start: dayKey(req?.start), end: dayKey(req?.end) }
  const source = pnlDrillSource(lineId)

  if (!source) {
    return {
      kind: 'ledgerRows',
      lineId,
      label,
      total: 0,
      omitted: { count: 0, amount: 0 },
      rows: [],
      note:
        `No drill-down is defined for "${lineId}" — the figure is real, but nothing here ` +
        `can account for it.`
    }
  }

  switch (source.kind) {
    case 'ledgerRows':
      return ledgerDetail(db, lineId, source.buckets, source.basis, bounds)
    case 'streamItems':
      return source.select === 'rollup'
        ? rollupDetail(db, lineId, bounds)
        : streamItemDetail(db, lineId, source.select, bounds)
    case 'expenses':
      return expenseDetail(db, lineId, bounds)
    case 'derived':
      return derivedDetail(lineId)
  }
}

// ---------------------------------------------------------------------------
// Ledger rows
// ---------------------------------------------------------------------------

/**
 * The rows under a revenue, fee, show-cost or adjustment line.
 *
 * THE CONTRIBUTION IS NOT ALWAYS THE STORED AMOUNT. Whatnot pays net, so the
 * sales line is a derived gross and the two fee lines are the pieces that were
 * taken off before the row was written. All three come out of ONE call to
 * `deriveSaleFee` per row, against the rates for that row's business day — the
 * same call, on the same key, that `buildView` made when it built the figure
 * being drilled. Anything else and a show that ran across a rate boundary would
 * make the list disagree with the line.
 *
 * `basis` is written onto the row wherever the two differ, so the reader can see
 * the addition rather than being asked to accept a number that does not match
 * the ledger they can also open.
 */
function ledgerDetail(
  db: Database,
  lineId: string,
  buckets: readonly string[],
  basis: 'amount' | 'grossSales' | 'whatnotFee' | 'processingFee',
  bounds: Bounds
): PnlDetail {
  const args: Record<string, unknown> = {}
  const marks = buckets.map((b, i) => {
    args[`b${i}`] = b
    return `@b${i}`
  })
  // ATTRIBUTED ROWS ONLY, matching `buildView` exactly. A row whose session was
  // deleted keeps its stale `stream_date`; counting it here would put money on a
  // day the statement does not have it on.
  const sql =
    `SELECT ${LEDGER_ROW_COLUMNS}
       FROM ledger_rows
      WHERE stream_date IS NOT NULL AND (session_id IS NOT NULL OR attribution = 'own_day')
        AND bucket IN (${marks.join(', ')})` +
    rangeClause('stream_date', bounds, args) +
    ` ORDER BY occurred_at DESC, rowid DESC`

  const raw = db.prepare(sql).all(args) as RawLedgerRow[]
  const rateAt = basis === 'amount' ? null : rateLookup()

  let totalCents = 0
  const rows: PnlLedgerRecord[] = []
  let omittedCount = 0
  let omittedCents = 0

  for (const r of raw) {
    const netCents = toCents(r.amount)
    let cents = netCents
    let note: string | undefined
    if (rateAt) {
      const fee = deriveSaleFee(netCents, rateAt(r.stream_date as string))
      if (basis === 'grossSales') {
        cents = fee.grossCents
        note =
          `${usd(toDollars(netCents))} paid out + ${usd(toDollars(-fee.whatnotFeeCents))} ` +
          `commission + ${usd(toDollars(-fee.processingFeeCents))} card` +
          (fee.exact ? '' : ' · the model could not reproduce this payout exactly')
      } else if (basis === 'whatnotFee') {
        cents = fee.whatnotFeeCents
        note = `commission on ${usd(toDollars(fee.grossCents))} of gross`
      } else {
        cents = fee.processingFeeCents
        note = `card charge on ${usd(toDollars(fee.grossCents + fee.taxCents))} of order value`
      }
    }
    totalCents += cents
    if (rows.length < PNL_DRILL_LIMIT) {
      rows.push({ row: toLedgerRow(r), amount: toDollars(cents), ...(note ? { basis: note } : null) })
    } else {
      omittedCount += 1
      omittedCents += cents
    }
  }

  return {
    kind: 'ledgerRows',
    lineId,
    label: '',
    total: toDollars(totalCents),
    omitted: { count: omittedCount, amount: toDollars(omittedCents) },
    rows
  }
}

// ---------------------------------------------------------------------------
// Cost of goods
// ---------------------------------------------------------------------------

interface RawItem {
  id: string
  kind: string
  name: string
  quantity: number
  cost_cents: number
  loss_cents: number
  stated: number | null
  break_number: number | null
  location: string
  note: string | null
  created_at: string
  d: string
  title: string
  unit_type: string | null
}

/**
 * Every stream line in the range, with the two cost figures already in cents.
 *
 * `cost_total` is what the FIFO layers a break consumed came to; `loss_value` is
 * what given-away stock was worth as a cost of the show. Which of the two a line
 * contributes depends on the act, exactly as it does in `buildView` — booking
 * both for a giveaway would count the same prize twice.
 */
function itemRows(db: Database, bounds: Bounds, extra = '', args: Record<string, unknown> = {}): RawItem[] {
  const sql =
    `SELECT i.id AS id, i.kind AS kind, TRIM(i.product_name) AS name, i.quantity AS quantity,
            CAST(ROUND(i.cost_total * 100) AS INTEGER) AS cost_cents,
            CAST(ROUND(i.loss_value * 100) AS INTEGER) AS loss_cents,
            i.stated_case_price AS stated, i.break_number AS break_number,
            i.location AS location, i.note AS note, i.created_at AS created_at,
            s.stream_date AS d, s.title AS title, p.unit_type AS unit_type
       FROM stream_items i
       JOIN stream_sessions s ON s.id = i.session_id
       LEFT JOIN inventory_products p ON p.id = i.product_id
      WHERE 1 = 1` +
    rangeClause('s.stream_date', bounds, args) +
    extra +
    ` ORDER BY s.stream_date DESC, i.created_at DESC, i.rowid DESC`
  return db.prepare(sql).all(args) as RawItem[]
}

/** What one line contributes to cost of goods, in cents and NEGATIVE. */
const itemCents = (r: RawItem): number => -(r.kind === 'giveaway' ? r.loss_cents : r.cost_cents)

/** Uncosted means the figure for this line's act is zero — the same test
 *  `buildView` splits its groups on, written once here. */
const itemUncosted = (r: RawItem): boolean =>
  (r.kind === 'giveaway' ? r.loss_cents : r.cost_cents) === 0

function toItemRecord(r: RawItem): PnlStreamItemRecord {
  return {
    id: r.id,
    kind: r.kind === 'giveaway' ? 'giveaway' : 'break',
    streamDate: r.d,
    sessionTitle: (r.title ?? '').trim(),
    productName: r.name || UNNAMED_PRODUCT,
    quantity: r.quantity,
    priceUnit: r.unit_type ? stockUnitOf(r.unit_type) : null,
    // Read off the LINE rather than re-derived from the session's date: a show
    // can be re-dated afterwards and what a line did when it was written is
    // fixed from then on. Same rule `restoreItemStock` reverses by.
    reconciled: r.stated !== null,
    amount: toDollars(itemCents(r)),
    breakNumber: r.break_number,
    location: r.location ?? '',
    note: (r.note ?? '').trim(),
    createdAt: r.created_at
  }
}

/**
 * The stream lines behind one cost-of-goods row.
 *
 * The costed/uncosted split is honoured because the statement makes it: a case
 * broken for $1,200 and a second case of the same name broken for nothing are
 * two rows on the P&L, and a drill that answered either of them with both would
 * report a total that matches neither.
 */
function streamItemDetail(
  db: Database,
  lineId: string,
  select: PnlStreamItemSelector,
  bounds: Bounds
): PnlDetail {
  const args: Record<string, unknown> = { act: select.act }
  let extra = ' AND i.kind = @act'
  if (select.product !== null) {
    args.name = select.product
    // A line whose name never made it onto the row shows as `UNNAMED_PRODUCT` on
    // the statement — `mergeCogsItems` gives that money a name rather than
    // dropping it — so the drill has to accept the blank it stands for.
    extra +=
      select.product === UNNAMED_PRODUCT
        ? " AND (TRIM(i.product_name) = '' OR TRIM(i.product_name) = @name)"
        : ' AND TRIM(i.product_name) = @name'
  }

  const all = itemRows(db, bounds, extra, args).filter((r) =>
    select.costing === 'either' ? true : itemUncosted(r) === (select.costing === 'uncosted')
  )

  let totalCents = 0
  for (const r of all) totalCents += itemCents(r)
  const shown = all.slice(0, PNL_DRILL_LIMIT)
  const rest = all.slice(shown.length)

  return {
    kind: 'streamItems',
    lineId,
    label: '',
    total: toDollars(totalCents),
    omitted: {
      count: rest.length,
      amount: toDollars(rest.reduce((n, r) => n + itemCents(r), 0))
    },
    items: shown.map(toItemRecord),
    note:
      select.costing === 'uncosted'
        ? 'Carried at nothing, so net profit is that much too high. Price any line and the ' +
          'statement moves.'
        : undefined
  }
}

/**
 * The roll-up tail: every product the statement did not have room to name.
 *
 * Rebuilt through the SAME merge and the SAME cap the statement used, because
 * "the rest" is defined by them. Reproducing the ordering by hand here would
 * work until somebody changed the sort — and then the tail on screen and the
 * tail in this list would be different sets of products with the same total,
 * which is the kind of disagreement nobody ever notices.
 */
function rollupDetail(db: Database, lineId: string, bounds: Bounds): PnlDetail {
  const all = itemRows(db, bounds)

  // Grouped exactly as `buildView` groups them — by day, act, name and whether
  // the line carries a cost at all — so the merge below sees what the statement
  // saw.
  const groups = new Map<string, CogsItem>()
  const keyOf = (r: RawItem): string =>
    `${r.d}|${r.kind === 'giveaway' ? 'giveaway' : 'break'}|${itemUncosted(r) ? 1 : 0}|${r.name}`
  for (const r of all) {
    const k = keyOf(r)
    const hit = groups.get(k)
    if (hit) hit.amount = toDollars(toCents(hit.amount) + itemCents(r))
    else {
      groups.set(k, {
        kind: r.kind === 'giveaway' ? 'giveaway' : 'break',
        name: r.name || UNNAMED_PRODUCT,
        amount: toDollars(itemCents(r)),
        ...(itemUncosted(r) ? { uncosted: true } : null)
      })
    }
  }

  const merged = mergeCogsItems([...groups.values()])
  const tail = merged.slice(COGS_LINES_MAX)
  const tailKeys = new Set(
    tail.map((i) => `${i.kind}|${i.uncosted ? 1 : 0}|${i.name}`)
  )
  const rows = all.filter((r) =>
    tailKeys.has(
      `${r.kind === 'giveaway' ? 'giveaway' : 'break'}|${itemUncosted(r) ? 1 : 0}|${
        r.name || UNNAMED_PRODUCT
      }`
    )
  )

  let totalCents = 0
  for (const r of rows) totalCents += itemCents(r)
  const shown = rows.slice(0, PNL_DRILL_LIMIT)
  const rest = rows.slice(shown.length)

  return {
    kind: 'streamItems',
    lineId,
    label: '',
    total: toDollars(totalCents),
    omitted: {
      count: rest.length,
      amount: toDollars(rest.reduce((n, r) => n + itemCents(r), 0))
    },
    items: shown.map(toItemRecord),
    note:
      tail.length > 0
        ? `The ${count(tail.length)} product${tail.length === 1 ? '' : 's'} the statement ` +
          `rolled up. The cap changes what is printed, never the total.`
        : 'Nothing was rolled up in this range — every product the period touched is named ' +
          'on the statement.'
  }
}

// ---------------------------------------------------------------------------
// Typed expenses
// ---------------------------------------------------------------------------

/**
 * The entries somebody typed against a day in this range.
 *
 * Stored POSITIVE and reported NEGATIVE, the bargain `buildView` makes with the
 * same table: the statement books them as a cost, so the total that has to match
 * the line is the negation of what the rows hold.
 */
function expenseDetail(db: Database, lineId: string, bounds: Bounds): PnlDetail {
  const args: Record<string, unknown> = {}
  const rows = db
    .prepare(
      `SELECT id, stream_date, amount, label, note, created_at, created_by, updated_at
         FROM finance_expenses
        WHERE 1 = 1` +
        rangeClause('stream_date', bounds, args) +
        ` ORDER BY stream_date DESC, created_at DESC, rowid DESC`
    )
    .all(args) as Array<{
    id: string
    stream_date: string
    amount: number
    label: string
    note: string | null
    created_at: string
    created_by: string | null
    updated_at: string
  }>

  let totalCents = 0
  for (const r of rows) totalCents -= toCents(r.amount)

  return {
    kind: 'expenses',
    lineId,
    label: '',
    total: toDollars(totalCents),
    omitted: { count: 0, amount: 0 },
    entries: rows.map((r) => ({
      id: r.id,
      streamDate: r.stream_date,
      // Rounded on read for the same reason `listExpenses` does it: a row can
      // arrive from another laptop through the relay, and a fraction of a cent
      // would surface as an unreconciled day rather than as the typo it is.
      amount: toDollars(toCents(r.amount)),
      label: r.label,
      note: r.note ?? '',
      createdAt: r.created_at,
      createdBy: r.created_by,
      updatedAt: r.updated_at
    })),
    note: 'Typed against a business day, not imported. Nothing here moved stock.'
  }
}

// ---------------------------------------------------------------------------
// Modelled figures
// ---------------------------------------------------------------------------

/**
 * A modelled line — a figure with no records to list.
 *
 * DERIVED IS NOT EMPTY, and the distinction is the whole reason this kind exists.
 * The packaging block used it properly: there is no row anywhere holding "$0.15
 * of sleeves", so a `PACKAGING_BASIS` table here turned each night's card count,
 * team slate and envelope count back into the arithmetic that produced the money
 * — reproducible with a calculator, which is the only way a cost model earns its
 * place on a statement. That table, and the nights it had to report as
 * unpriceable, went with the packaging section when the owner took the cost off
 * the P&L.
 *
 * What is left is one line, and it is the opposite case: the cost-of-goods
 * residual has nothing behind it BY CONSTRUCTION, because it only exists when
 * main and the renderer were built from different versions. So it lists no terms
 * and says why, as a fault rather than as a footnote.
 */
function derivedDetail(lineId: string): PnlDetail {
  return {
    kind: 'derived',
    lineId,
    label: '',
    total: 0,
    omitted: { count: 0, amount: 0 },
    terms: [],
    // A BUILD FAULT, drawn like one. The renderer raises it as the same danger
    // banner the statement uses when its own sections do not add up — see
    // `PnlDetailBase.noteTone`.
    note: 'Residual — cost of goods the section could not attribute. Update the app and re-import.',
    noteTone: 'danger'
  }
}
