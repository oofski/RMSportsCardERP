/**
 * The QuickBooks ids an invoice needs before it can be posted — the class, the
 * payment terms, and where this company wants a class put.
 *
 * ## Nothing here ever guesses an id
 *
 * That is the whole rule of this file. A ClassRef or a SalesTermRef is a pointer
 * into somebody's real books, and an id we invented does not fail loudly: it
 * either bounces with "Invalid Reference Id", which names nothing, or — much
 * worse — it lands on a DIFFERENT record that happens to hold that id and posts
 * real revenue against the wrong class. So every resolver here returns either an
 * id QuickBooks confirmed or null with a sentence saying why, and the payload
 * builder omits what it did not get. An invoice on the company's default terms
 * is a small, visible problem. An invoice on the wrong class is an invisible one
 * that surfaces at year end.
 *
 * ## Resolved once per process, per company
 *
 * The class and the term list change about never, and posting an invoice
 * already costs two full customer/item sweeps. The cache is keyed by realm id
 * because sandbox and production are different companies with different ids, and
 * a cache that ignored that would post production invoices against a sandbox
 * class id — which resolves to nothing, or to something.
 */
import type { QboClassPlacement, QboRef } from '@shared/invoices'
import { qboRequest } from './client'
import { getQboTokens } from './store'

/** The class every invoice from this app belongs to. The owner's instruction. */
export const RM_CLASS_NAME = 'United States'

interface QueryResponse<T> {
  QueryResponse?: Record<string, T[] | number | undefined>
}

const PAGE = 1000

async function queryAll<T>(entity: string, where = ''): Promise<T[]> {
  const out: T[] = []
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

function realm(): string {
  return getQboTokens()?.realmId ?? 'unknown'
}

function norm(v: string | null | undefined): string {
  return (v ?? '').trim().toLowerCase()
}

/**
 * How long a NEGATIVE answer is believed.
 *
 * A resolved id is cached for the life of the process — an id does not change,
 * and re-querying the class list on every invoice is two round trips to learn
 * the same number. A failure is different: "class tracking is switched off" is a
 * setting the operator is being told to go and change, and a cache that
 * outlived the fix would keep posting classless invoices until somebody
 * restarted the app and nobody would connect the two.
 *
 * Ten minutes is long enough that a bad afternoon at Intuit does not become two
 * extra calls per invoice, and short enough that going to fix the setting and
 * coming back works.
 */
const NEGATIVE_TTL_MS = 10 * 60 * 1000

interface Cached<T> {
  value: T
  /** Infinity for answers that cannot go stale. */
  until: number
}

function fresh<T>(entry: Cached<T> | undefined): T | undefined {
  if (!entry) return undefined
  return entry.until > Date.now() ? entry.value : undefined
}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

interface RawClass {
  Id?: string
  Name?: string
  FullyQualifiedName?: string
  Active?: boolean
}

/** What a resolver hands back: an id QuickBooks confirmed, or the reason not. */
export interface RefResult {
  ref: QboRef | null
  /** Null when `ref` is set. A sentence naming the failure when it is not. */
  reason: string | null
}

const classCache = new Map<string, Cached<RefResult>>()

/**
 * Find the "United States" class, creating it once if this company has none.
 *
 * INACTIVE CLASSES ARE STILL MATCHED. QuickBooks keeps a deactivated class
 * forever and refuses to let a second one take its name, so filtering to active
 * only would find nothing, try to create it, and be refused with a duplicate-name
 * fault on every single invoice. Matching it and letting QuickBooks decide what
 * to do with a reference to a dormant class is the behaviour that terminates.
 *
 * The match is on Name AND FullyQualifiedName because a sub-class is named
 * "United States" and qualified "Regions:United States"; either is the class the
 * owner means, and only the qualified form is unique.
 *
 * Creation is the one WRITE in this file, and it is deliberate: the owner asked
 * for the class to exist and it is a category, not a transaction — nothing about
 * an empty class changes a number in their books. It happens at most once per
 * company, because after it exists the query finds it.
 */
export async function resolveInvoiceClass(): Promise<RefResult> {
  const key = realm()
  const cached = fresh(classCache.get(key))
  if (cached) return cached

  let result: RefResult
  try {
    const rows = await queryAll<RawClass>('Class')
    const wanted = norm(RM_CLASS_NAME)
    const found = rows.find(
      (c) => c.Id && (norm(c.Name) === wanted || norm(c.FullyQualifiedName) === wanted)
    )
    if (found?.Id) {
      result = {
        ref: { value: String(found.Id), name: found.FullyQualifiedName || found.Name || RM_CLASS_NAME },
        reason: null
      }
    } else {
      const created = await qboRequest<{ Class?: { Id?: string; Name?: string } }>({
        method: 'POST',
        path: 'class',
        body: { Name: RM_CLASS_NAME }
      })
      const id = created.Class?.Id
      result = id
        ? { ref: { value: String(id), name: created.Class?.Name || RM_CLASS_NAME }, reason: null }
        : {
            ref: null,
            reason:
              `QuickBooks accepted a new “${RM_CLASS_NAME}” class but did not say what its id is, ` +
              'so no class was put on this invoice.'
          }
    }
  } catch (err) {
    // Class tracking switched off is the likely cause and Intuit's fault text
    // says so; whatever it says is carried through verbatim rather than
    // paraphrased, because the operator has to act on it in QuickBooks.
    result = {
      ref: null,
      reason:
        `The “${RM_CLASS_NAME}” class could not be resolved, so no class was put on this ` +
        `invoice: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  // A FAILURE IS CACHED TOO, and on purpose: class tracking being off is a
  // setting, not a blip, and retrying the create on every invoice would mean two
  // extra round trips and an identical refusal each time. But only for a while —
  // the operator is being told to go and change that setting, and an answer
  // cached for the life of the process would outlive the fix.
  classCache.set(key, { value: result, until: result.ref ? Infinity : Date.now() + NEGATIVE_TTL_MS })
  return result
}

/** Drop the memo, so a reconnect or a settings change is picked up. */
export function forgetInvoiceRefs(): void {
  classCache.clear()
  termCache.clear()
  placementCache.clear()
}

// ---------------------------------------------------------------------------
// Where a class goes
// ---------------------------------------------------------------------------

interface RawPreferences {
  Preferences?: {
    AccountingInfoPrefs?: {
      ClassTrackingPerTxn?: boolean
      ClassTrackingPerTxnLine?: boolean
    }
  }
}

const placementCache = new Map<string, Cached<QboClassPlacement>>()

/**
 * Header, line, or both — read from the company's own preferences.
 *
 * This matters more than it looks. Putting a ClassRef in the slot a company does
 * not use is NOT an error: QuickBooks accepts the invoice and drops the
 * reference silently, so the document posts and the class is simply missing,
 * with nothing anywhere to say it went. Reading
 * AccountingInfoPrefs.ClassTrackingPerTxn / ...PerTxnLine is the only way to
 * know which slot is live.
 *
 * 'both' when the preferences could not be read. The reference in whichever slot
 * they ignore is discarded without complaint, so sending both LANDS the class
 * where a guess would have a even chance of losing it.
 */
export async function resolveClassPlacement(): Promise<QboClassPlacement> {
  const key = realm()
  const cached = fresh(placementCache.get(key))
  if (cached) return cached

  let placement: QboClassPlacement
  let settled = true
  try {
    const body = await qboRequest<RawPreferences>({ path: 'preferences' })
    const prefs = body.Preferences?.AccountingInfoPrefs ?? {}
    const perLine = prefs.ClassTrackingPerTxnLine === true
    const perTxn = prefs.ClassTrackingPerTxn === true
    placement = perLine && perTxn ? 'both' : perLine ? 'line' : perTxn ? 'transaction' : 'none'
    // 'none' means class tracking is OFF, which is the thing the operator is
    // being told to switch on. Held briefly rather than for the session, for the
    // same reason the class failure is.
    settled = placement !== 'none'
  } catch {
    placement = 'both'
    settled = false
  }
  placementCache.set(key, {
    value: placement,
    until: settled ? Infinity : Date.now() + NEGATIVE_TTL_MS
  })
  return placement
}

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

interface RawTerm {
  Id?: string
  Name?: string
  Active?: boolean
  DueDays?: number
}

const termCache = new Map<string, Cached<Map<string, QboRef>>>()

/**
 * The company's payment terms, keyed by lowercased name.
 *
 * Terms are a REFERENCE on an invoice, never the words. Sending the string
 * "Net 30" does nothing at all — QuickBooks ignores an unrecognised shape here —
 * and the invoice quietly takes the customer's default terms instead, with a due
 * date computed from those. Two systems then disagree about when the money is
 * owed, and neither screen says so.
 */
async function loadTerms(): Promise<Map<string, QboRef>> {
  const key = realm()
  const cached = fresh(termCache.get(key))
  if (cached) return cached

  const byName = new Map<string, QboRef>()
  try {
    for (const t of await queryAll<RawTerm>('Term', 'Active = true')) {
      if (!t.Id || !t.Name) continue
      byName.set(norm(t.Name), { value: String(t.Id), name: t.Name })
    }
  } catch {
    // An empty map means "omit SalesTermRef", which is the safe outcome. The
    // reason is reported by the caller, which knows which term it wanted.
  }
  // Always time-limited, unlike the class id. A term this app wanted and did not
  // find is something the operator can go and ADD in QuickBooks, and a list
  // cached for the session would keep reporting it missing afterwards. One extra
  // query every ten minutes is not a cost worth optimising against that.
  termCache.set(key, { value: byName, until: Date.now() + NEGATIVE_TTL_MS })
  return byName
}

/**
 * Match one of this app's four terms to a QuickBooks Term.
 *
 * Case-insensitive, because Intuit's stock companies ship "Due on receipt" and
 * plenty of real ones have been re-typed as "Due On Receipt" — the same term,
 * and refusing it would drop the terms off every invoice on the commonest
 * setting this floor uses.
 */
export async function resolveTermRef(terms: string): Promise<RefResult> {
  const byName = await loadTerms()
  const hit = byName.get(norm(terms))
  if (hit) return { ref: hit, reason: null }
  return {
    ref: null,
    reason:
      `QuickBooks has no payment term called “${terms}”, so the invoice was posted on the ` +
      'terms QuickBooks holds for that customer. Add the term in QuickBooks to match this app.'
  }
}
