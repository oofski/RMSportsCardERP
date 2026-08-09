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
import { getDb, getMeta, setMeta } from '../db/database'

const CONFIG_KEY = 'qbo_config'
const TOKENS_KEY = 'qbo_tokens'

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
    environment: cfg.environment === 'production' ? 'production' : 'sandbox',
    redirectUri: typeof cfg.redirectUri === 'string' ? cfg.redirectUri : undefined
  }
}

export function setQboConfig(
  clientId: string,
  clientSecret: string,
  environment: QboEnvironment,
  redirectUri?: string
): void {
  setMeta(getDb(), CONFIG_KEY, seal({
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
    environment: environment === 'production' ? 'production' : 'sandbox',
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
