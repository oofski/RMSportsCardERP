import type {
  OwnerBoard,
  OwnerEmployeeToday,
  OwnerIncomingOrder,
  OwnerInventorySnapshot,
  OwnerOrderToShip,
  OwnerPayable,
  OwnerPnlWindow,
  OwnerReceivables,
  OwnerScheduleItem,
  OwnerWholesalePnl,
  OwnerWhatnotPnl
} from '@shared/ownerDashboard'
import type { StreamDayFinance } from '@shared/financeStreaming'
import { deriveSaleFee } from '@shared/financeStreaming'
import { getDb } from './database'
import { streamingFinanceView } from './financeStreaming'
import { rateLookup } from './whatnotRates'
import { listActivePurchaseOrderBoxes, listPurchaseOrders } from './purchaseOrders'
import { listIncoming } from './incoming'
import { recurringDueNow, slipsOutstanding } from './homeTasks'
import { listShifts } from './schedule'
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
function windowOf(
  days: StreamDayFinance[],
  label: string,
  span: number,
  from: string,
  to: string
): OwnerPnlWindow {
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
    activeDays,
    from,
    to
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
    today: windowOf(view.days.filter((d) => d.streamDate === today), 'Today', 1, today, today),
    week: windowOf(inRange(weekFrom), 'Last 7 days', 7, weekFrom, today),
    month: windowOf(inRange(monthFrom), 'Last 30 days', 30, monthFrom, today),
    lastDay: last?.streamDate ?? null,
    lastDayNet: money(last?.netProfit ?? 0),
    unreconciled: view.reconciled === false,
    reconcileNote: view.reconcileNote
  }
}

/**
 * The off-stream side, from the same ledger.
 *
 * The product breakdown goes back to the row table because a day does not carry
 * WHICH boxes sold — and now the windows do too, because a fee cannot be
 * apportioned out of a day's total. The flat card charge is levied per order and
 * the terms come from each row's own BUSINESS DAY, so the only honest way to
 * price a subset of a day's sales is to price the rows in it. `deriveSaleFee`
 * is the same function the day view uses, AND it is handed the same date — this
 * widget and the Streaming tab would otherwise report two different costs for
 * one box the moment a show ran past midnight into a different rate period.
 */
function wholesalePnl(): OwnerWholesalePnl | null {
  try {
    streamingFinanceView()
  } catch {
    return null
  }
  const weekFrom = daysAgo(6)
  const monthFrom = daysAgo(29)

  // Every whole-product sale in the widest window either card needs, priced once.
  const rateAt = rateLookup()
  const saleRows = getDb()
    .prepare(
      `SELECT stream_date AS d, CAST(ROUND(amount * 100) AS INTEGER) AS cents
         FROM ledger_rows
        WHERE bucket = 'product_sale' AND stream_date IS NOT NULL AND stream_date >= ?`
    )
    .all(monthFrom) as Array<{ d: string; cents: number }>

  /**
   * A product-sales-only window.
   *
   * `revenue` is the DERIVED gross, matching the Streaming tab's top line, and
   * `fees` is what came off it — the two add back to the net Whatnot paid, to
   * the cent. COGS is left at zero: matching a sale to a product is done, costing
   * it against that product's lots is not, and a fabricated cost would make this
   * widget the only place in the app that guesses.
   */
  const today = localDay(new Date())
  const win = (from: string, label: string, span: number): OwnerPnlWindow => {
    let grossCents = 0
    let feeCents = 0
    const activeDays = new Set<string>()
    for (const r of saleRows) {
      if (r.d < from) continue
      // The show's business day picks the rate, exactly as `buildView` does —
      // see the long note there for why a period follows the night rather than
      // the calendar.
      const fee = deriveSaleFee(r.cents, rateAt(r.d))
      grossCents += fee.grossCents
      feeCents += fee.whatnotFeeCents + fee.processingFeeCents
      if (r.cents !== 0) activeDays.add(r.d)
    }
    const revenue = grossCents / 100
    const fees = feeCents / 100
    return {
      label,
      days: span,
      revenue: money(revenue),
      fees: money(fees),
      cogs: 0,
      netProfit: money(revenue + fees),
      activeDays: activeDays.size,
      from,
      to: today
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
    today: win(today, 'Today', 1),
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
 * moved out to the bank. The difference is the balance sitting at Whatnot. This
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
    // Below zero is not "low stock" — it is a count that is wrong. Nothing in
    // the app deducts supplies on its own any more, so a negative here is a
    // hand-entered count that disagrees with the shelf, and it is reported as a
    // fact about now rather than as a warning about later.
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

/**
 * Stock on its way in.
 *
 * BOTH sources, folded, because neither alone answers the question. The
 * hand-logged shipments in `inventory_incoming` miss every purchase order, which
 * is where the money is; the purchase orders miss anything somebody logged by
 * hand. The Inventory dashboard already folds them exactly this way — see
 * summariseIncoming in InventoryOverview.tsx — and this follows it line for
 * line so the two screens cannot report different totals.
 *
 * OUTSTANDING units, not ordered units. A part-scanned purchase order has
 * already put some of its boxes on a shelf, and counting those again would say
 * stock is arriving that is already here.
 */
function incomingOrders(scope: {
  inventory: boolean
  invoicing: boolean
}): { items: OwnerIncomingOrder[]; orderCount: number; units: number; value: number } {
  const orders: OwnerIncomingOrder[] = []

  // Inventory OR invoicing, matching the gate on IPC.poIncomingBoxes — an
  // inventory user watches these shipments land, which is the whole reason that
  // operation is open to them. Gating this half on invoicing alone told a Staff
  // account "nothing on the way" while the Inventory screen two clicks away
  // listed four purchase orders arriving.
  if (scope.invoicing || scope.inventory) {
    for (const po of listActivePurchaseOrderBoxes()) {
      // STOCK-BOUND outstanding, not ordered-minus-received. A drop-shipped unit
      // is ordered and paid for and is never arriving here, so counting it would
      // say stock is on the way to a building it was never addressed to — the
      // same failure as counting units that have already landed, from the other
      // end. On every order raised before dropship existed qtyReceivable equals
      // quantity, so this is the figure this loop has always produced.
      const outstanding = (l: { qtyReceivable: number; qtyReceived: number }): number =>
        Math.max(0, l.qtyReceivable - l.qtyReceived)
      const open = po.lines.filter((l) => outstanding(l) > 0)
      const units = open.reduce((n, l) => n + outstanding(l), 0)
      if (units <= 0) continue
      orders.push({
        id: po.id,
        source: 'po',
        title: po.poNumber,
        detail: `${po.supplier || 'No supplier'} → ${
          po.destinationCount > 1 ? `${po.destinationCount} destinations` : po.location
        }`,
        itemCount: open.length,
        units,
        value: money(open.reduce((sum, l) => sum + outstanding(l) * l.unitPrice, 0))
      })
    }
  }

  // Gated separately, and deliberately: invoicing can see purchase orders and
  // has no claim on what somebody logged against the inventory module.
  if (scope.inventory) {
    for (const shipment of listIncoming()) {
      if (shipment.quantity <= 0) continue
      orders.push({
        id: shipment.id,
        source: 'manual',
        title: shipment.productName,
        detail: `→ ${shipment.location}${shipment.expectedDate ? ` · ${shipment.expectedDate}` : ''}`,
        itemCount: 1,
        units: shipment.quantity,
        value: money(shipment.quantity * (shipment.unitCost ?? 0))
      })
    }
  }

  // Biggest commitment first — that is the one worth chasing. Sorting by
  // expected date is tempting and wrong: purchase_orders carries no expected
  // date at all, so every PO would fall into one undated bucket at the bottom.
  orders.sort((a, b) => b.value - a.value || b.units - a.units)
  return {
    items: orders.slice(0, 5),
    orderCount: orders.length,
    units: orders.reduce((n, o) => n + o.units, 0),
    value: money(orders.reduce((n, o) => n + o.value, 0))
  }
}

/**
 * Packages still to go out.
 *
 * TWO QUERIES, not listOrders(). The obvious implementation reads the same rows
 * the floor's walk reads, which is right for fidelity and wrong for a landing
 * screen: listOrders builds a context that reads every ship_customers row AND
 * every ship_team_slots row, and the bench counters beside it run a claims query
 * PER PACKAGE. On a two-hundred-package night that is two whole-table scans and
 * two hundred queries, on the screen that has to paint first.
 *
 * The extra fidelity those buy — live claims, stale leases, send-backs — is real
 * and belongs on the bench board that acts on it. An owner glancing at "what is
 * left to go out" does not need to know which bench is holding one.
 *
 * ship_shipments holds exactly one live dataset, because an import clears and
 * replaces it, so a plain aggregate over that table IS tonight's packages.
 */
function ordersToShip(): { items: OwnerOrderToShip[]; remaining: number; imported: boolean } {
  const db = getDb()
  const counts = db
    .prepare(
      `SELECT COUNT(*) AS all_rows,
              SUM(CASE WHEN COALESCE(on_hold, 0) = 0 AND packed_at IS NULL THEN 1 ELSE 0 END) AS open_rows
         FROM ship_shipments`
    )
    .get() as { all_rows: number; open_rows: number | null }

  const rows = db
    .prepare(
      `SELECT s.customer_id AS cid, c.whatnot_handle AS handle, c.real_name AS name,
              COALESCE(SUM(CASE WHEN t.picked_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS done,
              COUNT(t.id) AS total
         FROM ship_shipments s
         JOIN ship_customers c ON c.id = s.customer_id
         LEFT JOIN ship_team_slots t ON t.customer_id = s.customer_id
        WHERE COALESCE(s.on_hold, 0) = 0 AND s.packed_at IS NULL
        GROUP BY s.customer_id, c.whatnot_handle, c.real_name
        ORDER BY (COUNT(t.id) - COALESCE(SUM(CASE WHEN t.picked_at IS NOT NULL THEN 1 ELSE 0 END), 0)) DESC,
                 c.whatnot_handle
        LIMIT 5`
    )
    .all() as Array<{
    cid: string
    handle: string | null
    name: string | null
    done: number
    total: number
  }>

  return {
    // An empty table is "no packing slip has been imported", which is a
    // completely different sentence from "every package has gone out" — and the
    // second one is reassurance the data does not support. The card needs to be
    // able to tell them apart.
    imported: counts.all_rows > 0,
    remaining: counts.open_rows ?? 0,
    items: rows.map((r) => ({
      customerId: r.cid,
      handle: r.handle || r.cid,
      realName: r.name || '',
      cardsLeft: Math.max(0, r.total - r.done),
      cardsTotal: r.total
    }))
  }
}

/**
 * Who is at work today, and who is due to be.
 *
 * TWO SOURCES, joined on the person. Time entries that START today are the only
 * record of somebody actually being in; today's rota rows are the record of who
 * was expected. Keeping them apart is what lets the card say "Dana is in" and
 * "Rob is due at four and has not arrived" in the same list without either
 * sentence being a guess.
 *
 * This used to be the clock alone, because there was no rota to read. There is
 * one now (v49), and the owner asked for exactly this — "the employees that are
 * going to be in".
 *
 * On the clock first, then everybody rostered, then most hours logged: at 8am
 * the useful half of this card is the people currently standing in the building,
 * and the second most useful is the ones who should be.
 */
function employeesToday(): OwnerEmployeeToday[] {
  // LOCAL midnight, expressed as the UTC instant it happened — which is what
  // every other "today" in this app compares against (see startOfToday in
  // main/ipc.ts, feeding the clock widget).
  //
  // NOT `substr(clock_in, 1, 10) = <today>`. Clock times are stored as UTC ISO
  // strings, so the first ten characters are the UTC date, and matching them
  // against a local one is right for about two-thirds of the day and wrong for
  // the rest: in Chicago, somebody clocking in at 7:30pm is stored as
  // 2026-08-08T00:30:00Z and would drop off tonight's card and reappear on
  // tomorrow's. The evening is exactly when this warehouse is busy.
  // STILL CLOCKED IN COUNTS, WHATEVER DAY IT STARTED.
  //
  // This window was clock_in >= local midnight and nothing else, so somebody
  // who started before midnight and never clocked out vanished from the card
  // at 00:00 while they were standing in the building. It also lost anyone
  // whose shift began the previous evening — which is when this warehouse is
  // busy — and anyone whose row synced from another machine after the fact.
  //
  // An entry with no clock_out is an open shift by definition. It is on the
  // card because the person is HERE, not because of when they arrived. The
  // date window still bounds everything that has already ended, so the query
  // does not widen into history.
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  const from = dayStart.toISOString()
  const rows = getDb()
    .prepare(
      `SELECT e.id AS id, e.first_name AS first, e.last_name AS last, e.role AS role,
              t.clock_in AS clock_in, t.clock_out AS clock_out
         FROM time_entries t
         JOIN employees e ON e.id = t.employee_id
        WHERE (t.clock_in >= ? OR t.clock_out IS NULL)
          AND e.status != 'disabled'`
    )
    .all(from) as Array<{
    id: string
    first: string | null
    last: string | null
    role: string
    clock_in: string
    clock_out: string | null
  }>

  // Today's rota, keyed by person. Read separately rather than joined into the
  // query above, because the two sets only partly overlap: somebody rostered who
  // has not arrived has no time entry at all, and would fall out of an inner
  // join — which is exactly the person this card was extended to show.
  const rostered = new Map<string, { start: string | null }>()
  for (const s of listShifts(localDay(new Date()), localDay(new Date()))) {
    rostered.set(s.employeeId, { start: s.startTime })
  }

  const byPerson = new Map<string, OwnerEmployeeToday>()
  for (const r of rows) {
    const existing = byPerson.get(r.id)
    const person: OwnerEmployeeToday = existing ?? {
      id: r.id,
      name: `${r.first ?? ''} ${r.last ?? ''}`.trim() || 'Someone',
      role: r.role,
      onTheClock: false,
      since: null,
      minutesToday: 0,
      dueAt: rostered.get(r.id)?.start ?? null,
      scheduled: rostered.has(r.id)
    }
    if (r.clock_out) {
      const mins = (new Date(r.clock_out).getTime() - new Date(r.clock_in).getTime()) / 60000
      if (Number.isFinite(mins) && mins > 0) person.minutesToday += Math.round(mins)
    } else {
      // Still open. The running time counts too, or somebody who clocked in an
      // hour ago reads as having done nothing.
      person.onTheClock = true
      person.since = person.since && person.since < r.clock_in ? person.since : r.clock_in
      const mins = (Date.now() - new Date(r.clock_in).getTime()) / 60000
      if (Number.isFinite(mins) && mins > 0) person.minutesToday += Math.round(mins)
    }
    byPerson.set(r.id, person)
  }

  // Anybody on today's rota who has not clocked in at all. They have no time
  // entry, so nothing above could have produced them — and they are the whole
  // point of reading the rota here: the four o'clock start that has not turned
  // up is the one thing on this card somebody might act on.
  const missing = [...rostered.keys()].filter((id) => !byPerson.has(id))
  if (missing.length > 0) {
    const placeholders = missing.map(() => '?').join(', ')
    const people = getDb()
      .prepare(
        `SELECT id, first_name AS first, last_name AS last, role
           FROM employees
          WHERE id IN (${placeholders}) AND status != 'disabled'`
      )
      .all(...missing) as Array<{
      id: string
      first: string | null
      last: string | null
      role: string
    }>
    for (const p of people) {
      byPerson.set(p.id, {
        id: p.id,
        name: `${p.first ?? ''} ${p.last ?? ''}`.trim() || 'Someone',
        role: p.role,
        onTheClock: false,
        since: null,
        minutesToday: 0,
        dueAt: rostered.get(p.id)?.start ?? null,
        scheduled: true
      })
    }
  }

  return [...byPerson.values()].sort((a, b) => {
    if (a.onTheClock !== b.onTheClock) return a.onTheClock ? -1 : 1
    // Somebody expected sorts above somebody who has finished for the day: the
    // shift still to come is the one there is anything to do about.
    if (a.onTheClock === false && a.scheduled !== b.scheduled) return a.scheduled ? -1 : 1
    if (b.minutesToday !== a.minutesToday) return b.minutesToday - a.minutesToday
    return a.name.localeCompare(b.name)
  })
}

export interface OwnerBoardScope {
  finance: boolean
  invoicing: boolean
  inventory: boolean
  streaming: boolean
  fulfillment: boolean
  hours: boolean
  /** WHO is asking, for the half of the board that is theirs alone. */
  viewerId: string | null
}

export function getOwnerBoard(scope: OwnerBoardScope): OwnerBoard {
  return {
    whatnot: scope.finance ? whatnotPnl() : null,
    wholesale: scope.finance ? wholesalePnl() : null,
    receivables: scope.finance ? receivables() : null,
    payables: scope.invoicing ? payables() : null,
    inventory: scope.inventory ? inventorySnapshot() : null,
    schedule: scope.streaming ? schedule() : null,
    incoming: scope.inventory || scope.invoicing ? incomingOrders(scope) : null,
    toShip: scope.fulfillment ? ordersToShip() : null,
    employeesToday: scope.hours ? employeesToday() : null,
    // Never null. Everybody has a list of their own, and each half gates
    // itself: a person who cannot see the streaming module is not told about a
    // stream, and a recurring job belongs to one person by construction.
    tasks: {
      slips: scope.streaming && scope.fulfillment ? slipsOutstanding() : [],
      recurring: scope.viewerId ? recurringDueNow(scope.viewerId) : []
    },
    generatedAt: nowIso()
  }
}
