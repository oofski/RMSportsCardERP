/**
 * Which QuickBooks account each kind of money lands in.
 *
 * Stored PER COMPANY (realm). Account ids are company-local — id "80" is Cost
 * of Goods Sold in one company and something unrelated in the next — so a
 * single shared mapping would silently point production postings at sandbox
 * accounts the first time the environment is switched. Keying by realm makes
 * that impossible rather than merely unlikely.
 *
 * Not secret, so this is plain JSON in `meta` rather than going through
 * safeStorage: it is a list of account ids the operator chose, and encrypting
 * it would only make it harder to support.
 */
import type { QboAccount, QboAccountMap, QboMapSlotKey } from '@shared/quickbooks'
import { QBO_MAP_SLOTS } from '@shared/quickbooks'
import { getDb, getMeta, setMeta } from '../db/database'

function key(realmId: string): string {
  return `qbo_map:${realmId}`
}

const SLOT_KEYS = new Set<string>(QBO_MAP_SLOTS.map((s) => s.key))

export function getAccountMap(realmId: string): QboAccountMap {
  const raw = getMeta(getDb(), key(realmId))
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: QboAccountMap = {}
    for (const [k, v] of Object.entries(parsed)) {
      // Drop anything that is not a slot we still recognise, so removing a slot
      // in a later version cannot resurrect a stale account id.
      if (SLOT_KEYS.has(k) && typeof v === 'string' && v.trim()) {
        out[k as QboMapSlotKey] = v.trim()
      }
    }
    return out
  } catch {
    return {}
  }
}

export function setAccountMap(realmId: string, map: QboAccountMap): void {
  const clean: QboAccountMap = {}
  for (const slot of QBO_MAP_SLOTS) {
    const value = map[slot.key]
    if (typeof value === 'string' && value.trim()) clean[slot.key] = value.trim()
  }
  setMeta(getDb(), key(realmId), JSON.stringify(clean))
}

export function clearAccountMap(realmId: string): void {
  setMeta(getDb(), key(realmId), '')
}

/**
 * Check a proposed mapping against the real chart of accounts.
 *
 * Both halves matter. An id that does not exist produces an Intuit fault at
 * post time that names neither the field nor the account. An id that exists but
 * is the WRONG TYPE is worse: QuickBooks will happily accept inventory posted
 * to an income account, and the books balance while being materially wrong.
 * That is a mistake nobody notices until a reconciliation months later, so it
 * is refused here.
 */
export function validateMap(
  map: QboAccountMap,
  accounts: QboAccount[]
): { ok: true } | { ok: false; error: string } {
  const byId = new Map(accounts.map((a) => [a.id, a]))
  for (const slot of QBO_MAP_SLOTS) {
    const id = map[slot.key]
    if (!id) continue
    const account = byId.get(id)
    if (!account) {
      return { ok: false, error: `${slot.label}: that account no longer exists in QuickBooks.` }
    }
    if (!slot.accountTypes.includes(account.accountType)) {
      return {
        ok: false,
        error: `${slot.label}: "${account.fullyQualifiedName}" is a ${account.accountType} account. Expected ${slot.accountTypes.join(' or ')}.`
      }
    }
  }
  return { ok: true }
}

/**
 * A best-effort starting point, matched off the account types and QuickBooks'
 * own sub-type names. Only ever used to PRE-FILL the form — it is never saved
 * without the operator confirming, because a plausible-looking wrong guess is
 * more dangerous here than an empty field.
 */
export function suggestMap(accounts: QboAccount[]): QboAccountMap {
  const out: QboAccountMap = {}
  const pick = (types: string[], prefer: RegExp[]): string | undefined => {
    const candidates = accounts.filter((a) => types.includes(a.accountType))
    for (const re of prefer) {
      const hit = candidates.find((a) => re.test(a.fullyQualifiedName) || re.test(a.accountSubType))
      if (hit) return hit.id
    }
    // Exactly one candidate of the right type is unambiguous; more than one is
    // a real choice and is left to the operator.
    return candidates.length === 1 ? candidates[0].id : undefined
  }

  out.inventoryAsset = pick(['Other Current Asset'], [/inventory/i])
  out.cogs = pick(['Cost of Goods Sold'], [/cost of goods/i])
  out.accountsPayable = pick(['Accounts Payable'], [/payable/i])
  out.paymentAccount = pick(['Bank', 'Credit Card'], [/checking/i, /operating/i])
  out.suppliesExpense = pick(['Expense', 'Other Expense'], [/suppl/i, /packag/i, /shipping suppl/i])
  out.salesIncome = pick(['Income'], [/sales/i, /^income$/i])
  out.shippingIncome = pick(['Income'], [/shipping/i, /freight/i, /delivery/i])
  out.shippingExpense = pick(['Expense', 'Other Expense'], [/postage/i, /shipping/i, /freight/i])

  for (const k of Object.keys(out) as QboMapSlotKey[]) {
    if (!out[k]) delete out[k]
  }
  return out
}
