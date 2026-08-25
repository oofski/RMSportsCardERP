/**
 * QuickBooks Online connection state.
 *
 * The client secret and the OAuth tokens are the two things here that must
 * never sit in plain text, so both go through the OS keychain (Windows DPAPI /
 * macOS Keychain) via Electron's safeStorage, the same way the "remember me"
 * credentials do. Nothing QuickBooks-related is ever committed to the repo or
 * baked into the build — the credentials are entered in the app and live only
 * in the operator's own database.
 *
 * Two records, deliberately separate:
 *   config — the app registration (client id/secret, environment). Survives a
 *            disconnect, because reconnecting should not mean re-typing it.
 *   tokens — the grant for one company. Cleared on disconnect.
 */
import { safeStorage } from 'electron'
import type { QboConfig, QboEnvironment, QboTokens } from '@shared/quickbooks'
import { DEFAULT_INVOICE_DELIVERY, type InvoiceDelivery } from '@shared/invoiceDelivery'
import type { QboRelayProbe } from '@shared/quickbooksRelay'
import { getDb, getMeta, setMeta } from '../db/database'

const CONFIG_KEY = 'qbo_config'
const TOKENS_KEY = 'qbo_tokens'
const RELAY_KEY = 'qbo_relay_state'

function encAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** Encrypt with the keychain when it exists; fall back to base64 when it does
 *  not, so the integration still works on a machine without one. */
function seal(value: unknown): string {
  const json = JSON.stringify(value)
  return encAvailable()
    ? 'v1:' + safeStorage.encryptString(json).toString('base64')
    : 'b64:' + Buffer.from(json, 'utf8').toString('base64')
}

function open<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    if (raw.startsWith('v1:')) {
      if (!encAvailable()) return null
      return JSON.parse(safeStorage.decryptString(Buffer.from(raw.slice(3), 'base64'))) as T
    }
    if (raw.startsWith('b64:')) {
      return JSON.parse(Buffer.from(raw.slice(4), 'base64').toString('utf8')) as T
    }
    return null
  } catch {
    return null
  }
}

export function getQboConfig(): QboConfig | null {
  const cfg = open<QboConfig>(getMeta(getDb(), CONFIG_KEY))
  if (!cfg || typeof cfg.clientId !== 'string' || typeof cfg.clientSecret !== 'string') return null
  return {
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    // Production, always. A config saved when the sandbox switch existed reads
    // back as production rather than silently pointing today's invoices at a
    // test company.
    environment: 'production',
    redirectUri: typeof cfg.redirectUri === 'string' ? cfg.redirectUri : undefined
  }
}

export function setQboConfig(
  clientId: string,
  clientSecret: string,
  /** Kept in the signature so callers read naturally; production is the only
   *  value stored. See the note below. */
  _environment: QboEnvironment,
  redirectUri?: string
): void {
  setMeta(getDb(), CONFIG_KEY, seal({
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
    environment: 'production',
    // Blank stores as undefined so `effectiveRedirectUri` falls back to the
    // loopback rather than sending Intuit an empty string.
    redirectUri: (redirectUri ?? '').trim() || undefined
  } satisfies QboConfig))
}

export function clearQboConfig(): void {
  setMeta(getDb(), CONFIG_KEY, '')
}

export function getQboTokens(): QboTokens | null {
  const t = open<QboTokens>(getMeta(getDb(), TOKENS_KEY))
  if (!t || typeof t.accessToken !== 'string' || typeof t.refreshToken !== 'string') return null
  return t
}

export function setQboTokens(tokens: QboTokens): void {
  setMeta(getDb(), TOKENS_KEY, seal(tokens))
}

export function clearQboTokens(): void {
  setMeta(getDb(), TOKENS_KEY, '')
}

// ---------------------------------------------------------------------------
// What the relay last said
// ---------------------------------------------------------------------------

/**
 * The relay's answer, remembered on this machine.
 *
 * NOT a cache for speed — a cache for CORRECTNESS. Once a laptop has learned
 * that the relay is holding the connection, it must keep believing that while
 * the relay is unreachable. The alternative is that a five-minute Cloudflare
 * wobble makes the app fall back to whatever stale tokens happen to be sitting
 * in this machine's keychain, and those tokens refreshing is precisely the
 * rotation race the relay exists to remove. So an unreachable relay is reported
 * as an unreachable relay, and nothing quietly promotes itself to second holder.
 *
 * Plain JSON rather than sealed: it holds no secret. The last four of a client
 * id, a company name and two timestamps are all that is in it. Deliberately NOT
 * synced either — it is this machine's record of a conversation it had, and
 * pushing it around would mean one laptop's outage becoming everybody's.
 */
export interface QboRelayMemo extends QboRelayProbe {
  /** ISO, when this answer was received. */
  checkedAt: string
}

export function getQboRelayMemo(): QboRelayMemo | null {
  const raw = getMeta(getDb(), RELAY_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as QboRelayMemo
    return typeof parsed?.checkedAt === 'string' ? parsed : null
  } catch {
    return null
  }
}

export function setQboRelayMemo(memo: QboRelayMemo): void {
  setMeta(getDb(), RELAY_KEY, JSON.stringify(memo))
}

export function clearQboRelayMemo(): void {
  setMeta(getDb(), RELAY_KEY, '')
}

// ---------------------------------------------------------------------------
// How the invoice reaches the buyer
// ---------------------------------------------------------------------------

/**
 * The payment instructions and the auto-send switch.
 *
 * ## In `meta`, and therefore going nowhere
 *
 * `meta` is one of the four tables deliberately left out of sync — see
 * syncTables — so the bank details typed in here stay in this database. They do
 * not travel through the relay, they are not on another laptop, and THEY ARE
 * NOT IN THIS REPOSITORY, which is public. That last one is the reason the
 * instructions are a setting at all rather than a constant somebody would have
 * had to commit.
 *
 * ## Plain JSON, not sealed
 *
 * Unlike the client secret and the tokens above, which go through safeStorage.
 * These details are PRINTED ON EVERY INVOICE THE BUSINESS SENDS — a wire is
 * paid by publishing the account number to whoever owes you money — so they are
 * not a credential and encrypting them at rest would be theatre. What matters
 * is that they are not committed and not synced, and both of those are true of
 * where they sit rather than of how they are stored.
 *
 * The web app has its own database, so this is answered once per install. That
 * is the same as the SMTP account and for the same reason.
 */
const DELIVERY_KEY = 'qbo_invoice_delivery'

export function getInvoiceDelivery(): InvoiceDelivery {
  const raw = getMeta(getDb(), DELIVERY_KEY)
  if (!raw) return { ...DEFAULT_INVOICE_DELIVERY }
  try {
    const parsed = JSON.parse(raw) as Partial<InvoiceDelivery>
    return {
      paymentInstructions:
        typeof parsed?.paymentInstructions === 'string' ? parsed.paymentInstructions : '',
      // === true, so anything that is not the word yes reads as no. A record
      // written by an older build has no such key, and an invoice must never
      // email itself because a field was missing.
      autoSend: parsed?.autoSend === true
    }
  } catch {
    return { ...DEFAULT_INVOICE_DELIVERY }
  }
}

export function setInvoiceDelivery(input: InvoiceDelivery): void {
  setMeta(
    getDb(),
    DELIVERY_KEY,
    JSON.stringify({
      paymentInstructions: String(input?.paymentInstructions ?? '').trim(),
      autoSend: input?.autoSend === true
    } satisfies InvoiceDelivery)
  )
}
