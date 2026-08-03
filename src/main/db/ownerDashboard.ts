import type {
  OwnerBoard,
  OwnerInventorySnapshot,
  OwnerPayable,
  OwnerPnlWindow,
  OwnerReceivables,
  OwnerScheduleItem,
  OwnerWholesalePnl,
  OwnerWhatnotPnl
} from '@shared/ownerDashboard'
import type { StreamDayFinance } from '@shared/financeStreaming'
import { getDb } from './database'
import { streamingFinanceView } from './financeStreaming'
import { listPurchaseOrders } from './purchaseOrders'
import { inventoryStats } from './inventory'
import { supplyStats } from './supplies'
import { nowIso } from '../util'

/**
 * Everything the owner's home board shows, assembled once.
 *
 * NOTHING here computes a number of its own. Every figure is read from the
 * module that owns it — the P&L from the streaming finance view, payables from
 * purchase orders, stock from inventory stats — so this file cannot drift from
 * the screens it summarises. A board that disagrees with the module it links to
 * is worse than no board.
 *
 * The permission flags are passed in rather than read here: this is a database
 * module, and it must not have an opinion about who is asking. The IPC layer
 * decides that and this returns null for anything it was told to skip.
 */

/** Local YYYY-MM-DD, matching how a day is keyed everywhere else. */
function localDay(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return localDay(d)
}

const money = (n: number): number => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100

/**
 * Roll a set of days into one window.
 *
 * `activeDays` counts days that carried money, not days on the calendar. "3
 * shows this week" is a fact; "7 days" is not, and averaging over the second
 * one understates a business that runs four nights.
 */
function windowOf(days: StreamDayFinance[], label: string, span: number): OwnerPnlWindow {
  let revenue = 0
  let fees = 0
  let cogs = 0
  let netProfit = 0
  let activeDays = 0
  for (const d of days) {
    revenue += d.totalRevenue
    fees += d.totalFees
    cogs += d.cogs
    netProfit += d.netProfit
    if (d.rowCount > 0) activeDays += 1
  }
  return {
    label,
    days: span,
    revenue: money(revenue),
    fees: money(fees),
    cogs: money(cogs),
    netProfit: money(netProfit),
    activeDays
  }
}

function whatnotPnl(): OwnerWhatnotPnl | null {
  let view: ReturnType<typeof streamingFinanceView>
  try {
    view = streamingFinanceView()
  } catch {
    // No ledger imported yet is the ordinary state of a fresh install, not an
    // error worth blanking the whole board for.
    return null
  }
  const today = localDay(new Date())
  const weekFrom = daysAgo(6)
  const monthFrom = daysAgo(29)
  const inRange = (from: string): StreamDayFinance[] => view.days.filter((d) => d.streamDate >= from)

  const withMoney = [...view.days].filter((d) => d.rowCount > 0).sort((a, b) =>
    b.streamDate.localeCompare(a.streamDate)
  )
  const last = withMoney[0] ?? null

  return {
    today: windowOf(view.days.filter((d) => d.streamDate === today), 'Today', 1),
    week: windowOf(inRange(weekFrom), 'Last 7 days', 7),
    month: windowOf(inRange(monthFrom), 'Last 30 days', 30),
    lastDay: last?.streamDate ?? null,
    lastDayNet: money(last?.netProfit ?? 0),
    unreconciled: view.reconciled === false,
    reconcileNote: view.reconcileNote
  }
}

/**
 * The off-stream side, from the same ledger.
 *
 * `productSales` rides on every day already (a subset of `sales`), so the
 * windows come from the same rows as the Whatnot ones and the two can never
 * disagree about what a day held. The product breakdown is the only part that
 * goes back to the row table, because a day does not carry WHICH boxes sold.
 */
function wholesalePnl(): OwnerWholesalePnl | null {
  let view: ReturnType<typeof streamingFinanceView>
  try {
    view = streamingFinanceView()
  } catch {
    return null
  }
  const weekFrom = daysAgo(6)
  const monthFrom = daysAgo(29)

  /**
   * A product-sales-only window.
   *
   * Fees are apportioned at the flat 8.9%, which is exact rather than an
   * estimate now that there is no per-transaction component — the whole take is
   * a percentage of gross, so a share of the gross carries a share of the fee.
   * COGS is left at zero: matching a sale to a product is done, costing it
   * against that product's lots is not, and a fabricated cost would make this
   * widget the only place in the app that guesses.
   */
  const win = (from: string, label: string, span: number): OwnerPnlWindow => {
    let revenue = 0
    let activeDays = 0
    for (const d of view.days) {
      if (d.streamDate < from) continue
      if (d.productSales > 0) {
        revenue += d.productSales
        activeDays += 1
      }
    }
    const fees = -money(revenue * 0.089)
    return {
      label,
      days: span,
      revenue: money(revenue),
      fees,
      cogs: 0,
      netProfit: money(revenue + fees),
      activeDays
    }
  }

  const rows = getDb()
    .prepare(
      `SELECT product_name AS name, product_id AS pid, COUNT(*) AS units,
              COALESCE(SUM(amount), 0) AS revenue
         FROM ledger_rows
        WHERE bucket = 'product_sale' AND stream_date >= ?
        GROUP BY product_name, product_id
        ORDER BY revenue DESC`
    )
    .all(monthFrom) as Array<{ name: string | null; pid: string | null; units: number; revenue: number }>

  return {
    week: win(weekFrom, 'Last 7 days', 7),
    month: win(monthFrom, 'Last 30 days', 30),
    productCount: rows.length,
    unmatchedCount: rows.filter((r) => !r.pid).length,
    top: rows.slice(0, 6).map((r) => ({
      name: r.name || 'Unnamed product',
      productId: r.pid,
      units: r.units,
      revenue: money(r.revenue)
    }))
  }
}

/**
 * Earned, and not yet in the bank.
 *
 * Every non-payout row is money the business made; every payout row is money
 * moved out to Stripe. The difference is the balance sitting at Whatnot. This
 * is the honest answer to "what is still owed to us" in an app with no
 * accounts-receivable ledger — and it is real, not modelled.
 */
function receivables(): OwnerReceivables | null {
  const db = getDb()
  try {
    const earned = db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS v FROM ledger_rows WHERE bucket <> 'payout'`
      )
      .get() as { v: number }
    const paid = db
      .prepare(`SELECT COALESCE(SUM(amount), 0) AS v FROM ledger_rows WHERE bucket = 'payout'`)
      .get() as { v: number }
    const last = db
      .prepare(
        `SELECT occurred_at, amount FROM ledger_rows WHERE bucket = 'payout'
          ORDER BY occurred_at DESC LIMIT 1`
      )
      .get() as { occurred_at: string; amount: number } | undefined
    // Payout rows are stored NEGATIVE (money leaving), so the balance is a plain
    // sum and the all-time figure is its magnitude.
    return {
      awaitingPayout: money(earned.v + paid.v),
      lastPayoutAt: last?.occurred_at ?? null,
      lastPayoutAmount: money(Math.abs(last?.amount ?? 0)),
      paidOutAllTime: money(Math.abs(paid.v))
    }
  } catch {
    return null
  }
}

/** Purchase orders placed and not yet paid. */
function payables(): { items: OwnerPayable[]; total: number; count: number } {
  const now = Date.now()
  const items = listPurchaseOrders()
    .filter((po) => po.status === 'ordered')
    .map((po): OwnerPayable => {
      const placed = po.createdAt ?? null
      const ageDays = placed
        ? Math.max(0, Math.floor((now - new Date(placed).getTime()) / 86_400_000))
        : 0
      return {
        id: po.id,
        poNumber: po.poNumber,
        supplier: po.supplier,
        total: money(po.total),
        status: po.status,
        placedAt: placed,
        ageDays
      }
    })
    // Oldest first: the one that has been sitting longest is the one to chase.
    .sort((a, b) => b.ageDays - a.ageDays)
  return {
    items: items.slice(0, 8),
    total: money(items.reduce((n, i) => n + i.total, 0)),
    count: items.length
  }
}

function inventorySnapshot(): OwnerInventorySnapshot | null {
  try {
    const stats = inventoryStats()
    const supplies = supplyStats()
    const incoming = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM inventory_incoming WHERE received_at IS NULL`)
      .get() as { n: number } | undefined
    // Below zero is not "low stock" — it is a count that is wrong, and it only
    // happens because the SOP checklist is allowed to deduct past empty.
    const negative = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM supplies WHERE quantity < 0`)
      .get() as { n: number }
    return {
      stockValue: money(stats.totalCost),
      productCount: stats.skuCount,
      lowStockCount: stats.lowStockCount,
      incomingCount: incoming?.n ?? 0,
      supplyLowCount: supplies.lowStockCount,
      supplyNegativeCount: negative?.n ?? 0
    }
  } catch {
    return null
  }
}

/** Shows from the last few days and everything still to come. */
function schedule(): OwnerScheduleItem[] {
  const rows = getDb()
    .prepare(
      `SELECT id, title, stream_date, started_at, ended_at, status
         FROM stream_sessions
        WHERE stream_date >= ?
        ORDER BY started_at ASC
        LIMIT 8`
    )
    .all(daysAgo(1)) as Array<{
    id: string
    title: string
    stream_date: string
    started_at: string
    ended_at: string | null
    status: string
  }>
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    streamDate: r.stream_date,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    status: r.status,
    live: r.status === 'live' || (!r.ended_at && r.status !== 'scheduled')
  }))
}

export interface OwnerBoardScope {
  finance: boolean
  invoicing: boolean
  inventory: boolean
  streaming: boolean
}

export function getOwnerBoard(scope: OwnerBoardScope): OwnerBoard {
  return {
    whatnot: scope.finance ? whatnotPnl() : null,
    wholesale: scope.finance ? wholesalePnl() : null,
    receivables: scope.finance ? receivables() : null,
    payables: scope.invoicing ? payables() : null,
    inventory: scope.inventory ? inventorySnapshot() : null,
    schedule: scope.streaming ? schedule() : null,
    generatedAt: nowIso()
  }
}
