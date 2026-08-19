import type { Result } from '@shared/types'
import type {
  GeneralExpense,
  GeneralExpenseInput,
  GeneralExpenseResult,
  ImportDeleteImpact,
  LedgerImport,
  LedgerImportResult,
  LedgerRow,
  RatePeriodInput,
  StreamingFinanceView,
  WhatnotRatePeriod
} from '@shared/financeStreaming'
import type { PnlDetail, PnlDrillRequest } from '@shared/pnlDrill'
import type { WholesaleSaleRow } from '@shared/invoices'
import type {
  OrderHistoryYears,
  PurchaseOrderHistoryRow,
  SalesOrderHistoryRow
} from '@shared/orderHistory'
import type { DealTicketRow } from '@shared/dealTickets'
import { api } from '../../lib/api'

/** What `rows()` can be narrowed by. Every field is optional; an empty filter is
 *  "everything", which is why `limit` matters — a five-week export is ~9k rows. */
export interface LedgerRowFilter {
  streamDate?: string
  sessionId?: string
  bucket?: string
  unattributed?: boolean
  limit?: number
}

/**
 * The Finance bridge, named here rather than inferred from the preload.
 *
 * Same reasoning as the Streaming module: writing the surface out against
 * @shared/financeStreaming means this module compiles against the CONTRACT, so
 * drift at the boundary is a type error rather than a screen that quietly
 * renders the wrong shape.
 */
export interface FinanceApi {
  /** The whole day-by-day picture in one read — days, totals, unattributed,
   *  imports and the reconciliation verdict all derive from the same pass, so
   *  they can never be fetched out of step with each other. */
  streamView(): Promise<StreamingFinanceView>
  /** Opens a native file picker in main. Resolves once the file is parsed. */
  importLedger(): Promise<Result<LedgerImportResult>>
  imports(): Promise<LedgerImport[]>
  deleteImport(id: string): Promise<Result<StreamingFinanceView>>
  /** What deleting that import would actually cost. Read before confirming, so
   *  the dialog quotes the money that really leaves rather than the file's own
   *  row count — which overstates it by whatever another import also covers. */
  importImpact(id: string): Promise<ImportDeleteImpact>
  rows(filter: LedgerRowFilter): Promise<LedgerRow[]>
  /**
   * The records behind ONE figure on the statement, over the range on screen.
   *
   * `start`/`end` are inclusive business days; both null is all time. The
   * payload's `total` is the sum of EVERY matching record rather than of the
   * page returned, because that is what the screen reconciles against the figure
   * that was clicked — see `@shared/pnlDrill` for the line-id → source contract.
   */
  pnlDetail(req: PnlDrillRequest): Promise<PnlDetail>
  /** Re-runs attribution over every stored row against the current sessions —
   *  what you press after logging a show that was missing. */
  reattribute(): Promise<Result<StreamingFinanceView>>
  /** Whatnot's commission by date range. Empty means 6% everywhere. */
  rates(): Promise<WhatnotRatePeriod[]>
  /** Create (no id) or update (id). Rejects a range overlapping another, and
   *  hands back the whole list either way. Changing a rate re-prices history the
   *  next time the view is read — there is nothing to re-import. */
  saveRate(input: RatePeriodInput): Promise<Result<WhatnotRatePeriod[]>>
  deleteRate(id: string): Promise<Result<WhatnotRatePeriod[]>>
  /** Costs typed against a business day — product opened, given away or written
   *  off. A dollar amount only; nothing here moves stock. Both writes hand back
   *  the entries and the re-derived view, because one of them changes the bottom
   *  line of the day it lands on. */
  /** One row per product line sold on a sales order: what it sold for, what
   *  those exact FIFO layers cost, and the margin. Read-only — a sales order is
   *  where the numbers are entered, not here. */
  wholesale(): Promise<WholesaleSaleRow[]>
  /** Which years the order ledger covers, newest first. */
  historyYears(): Promise<OrderHistoryYears>
  /** One year of purchase orders, lines included so a row expands instantly. */
  historyPurchaseOrders(year: number): Promise<PurchaseOrderHistoryRow[]>
  /** One year of sales orders, with what the units on them cost. */
  historySalesOrders(year: number): Promise<SalesOrderHistoryRow[]>
  /** The deal ticket register for one year, or the whole thing for null. */
  dealTickets(year: number | null): Promise<DealTicketRow[]>
  /** Which years the register covers, and what the next number will be. */
  dealTicketYears(): Promise<{ years: number[]; next: string }>
  /** Put several documents under one ticket. Returns the whole register. */
  mergeDealTickets(targetId: string, ticketIds: string[]): Promise<Result<DealTicketRow[]>>
  /** Take documents back out, each to the number it was struck with. */
  unmergeDealTickets(ticketIds: string[]): Promise<Result<DealTicketRow[]>>
  expenses(): Promise<GeneralExpense[]>
  saveExpense(input: GeneralExpenseInput): Promise<Result<GeneralExpenseResult>>
  deleteExpense(id: string): Promise<Result<GeneralExpenseResult>>
}

/**
 * The annotation is the point: if the preload bridge ever stops satisfying the
 * interface above, this line fails to compile instead of the drift surfacing as
 * an undefined at runtime, halfway through reading a day's takings.
 */
export const finance: FinanceApi = api.finance

/**
 * False when the renderer is running against a packaged preload that predates
 * this module. Every screen below reads money, so the module says so plainly
 * rather than throwing "cannot read property of undefined" on first paint.
 */
export const financeReady = typeof finance?.streamView === 'function'

/**
 * False against a packaged preload that predates the drill-down.
 *
 * The statement PRINTS either way — every figure on it is real on that build —
 * and simply does not turn its amounts into buttons that would throw
 * "pnlDetail is not a function" on click. A statement you cannot open is the old
 * behaviour; a statement that errors when you touch it is a new bug.
 */
export const pnlDrillReady = typeof finance?.pnlDetail === 'function'

/** Result → message, so no failed write is ever swallowed into silence. */
export function resultError(res: Result<unknown>, fallback: string): string {
  return res.error?.trim() || fallback
}
