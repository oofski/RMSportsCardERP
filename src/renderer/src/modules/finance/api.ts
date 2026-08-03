import type { Result } from '@shared/types'
import type {
  ImportDeleteImpact,
  LedgerImport,
  LedgerImportResult,
  LedgerRow,
  RatePeriodInput,
  StreamingFinanceView,
  WhatnotRatePeriod
} from '@shared/financeStreaming'
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

/** Result → message, so no failed write is ever swallowed into silence. */
export function resultError(res: Result<unknown>, fallback: string): string {
  return res.error?.trim() || fallback
}
