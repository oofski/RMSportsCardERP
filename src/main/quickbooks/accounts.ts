/**
 * Reading reference data out of QuickBooks — the chart of accounts and the
 * vendor list.
 *
 * Everything here is READ-ONLY. Nothing in this file can change the operator's
 * books, which is what makes it safe to run against a live company before the
 * posting side is trusted.
 */
import type { QboAccount } from '@shared/quickbooks'
import { qboRequest } from './client'

/** QuickBooks caps a query page at 1000 rows regardless of what you ask for. */
const PAGE = 1000

interface QueryResponse<T> {
  QueryResponse?: Record<string, T[] | number | undefined>
}

/**
 * Run a QBO query and page through every result.
 *
 * The paging is real, not defensive: a mature company's chart of accounts plus
 * sub-accounts passes 1000 more often than you would think, and a silently
 * truncated account list shows up as "my account isn't in the dropdown" with no
 * error anywhere — the worst possible failure for a mapping screen.
 */
async function queryAll<T>(entity: string, where = ''): Promise<T[]> {
  const out: T[] = []
  // QuickBooks positions are 1-based.
  let start = 1
  for (;;) {
    const sql = `select * from ${entity}${where ? ` where ${where}` : ''} startposition ${start} maxresults ${PAGE}`
    const body = await qboRequest<QueryResponse<T>>({ path: 'query', query: { query: sql } })
    const page = (body.QueryResponse?.[entity] as T[] | undefined) ?? []
    out.push(...page)
    if (page.length < PAGE) return out
    start += page.length
  }
}

interface RawAccount {
  Id?: string
  Name?: string
  FullyQualifiedName?: string
  AccountType?: string
  AccountSubType?: string
  Classification?: string
  Active?: boolean
}

/**
 * The chart of accounts, active entries only.
 *
 * Inactive accounts are filtered at the source: QuickBooks keeps them forever
 * (they still carry history) and offering one in a mapping dropdown produces a
 * posting that Intuit rejects at write time with a fault that does not mention
 * the word "inactive".
 */
export async function fetchAccounts(): Promise<QboAccount[]> {
  const raw = await queryAll<RawAccount>('Account', 'Active = true')
  return raw
    .filter((a): a is RawAccount & { Id: string } => typeof a.Id === 'string')
    .map((a) => ({
      id: a.Id,
      name: a.Name ?? '',
      fullyQualifiedName: a.FullyQualifiedName || a.Name || '',
      accountType: a.AccountType ?? '',
      accountSubType: a.AccountSubType ?? '',
      classification: a.Classification ?? '',
      active: a.Active !== false
    }))
    .sort((a, b) =>
      a.accountType === b.accountType
        ? a.fullyQualifiedName.localeCompare(b.fullyQualifiedName)
        : a.accountType.localeCompare(b.accountType)
    )
}

export interface QboVendor {
  id: string
  displayName: string
  active: boolean
}

interface RawVendor {
  Id?: string
  DisplayName?: string
  Active?: boolean
}

/**
 * Vendors, for matching a PO's free-text supplier to a real QuickBooks vendor.
 * Also read-only: creating a missing vendor is a write and belongs with the
 * posting code, behind the same confirmation everything else that writes is.
 */
export async function fetchVendors(): Promise<QboVendor[]> {
  const raw = await queryAll<RawVendor>('Vendor', 'Active = true')
  return raw
    .filter((v): v is RawVendor & { Id: string } => typeof v.Id === 'string')
    .map((v) => ({ id: v.Id, displayName: v.DisplayName ?? '', active: v.Active !== false }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
}
