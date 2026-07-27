/**
 * QuickBooks Online IPC.
 *
 * Every handler is gated on 'admin.access': connecting an accounting system is
 * an owner-level action, and the client secret is entered through it.
 *
 * The secret is WRITE-ONLY across this boundary — it goes in, and nothing ever
 * hands it back to the renderer. Status carries the last four of the client id
 * only, which is enough to tell two app registrations apart.
 */
import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { Result } from '@shared/types'
import type { QboEnvironment, QboStatus } from '@shared/quickbooks'
import { getQboConfig, setQboConfig, clearQboConfig, getQboTokens, setQboTokens, clearQboTokens } from './quickbooks/store'
import { authorize, exchangeCode, revokeTokens } from './quickbooks/oauth'
import { fetchCompanyInfo } from './quickbooks/client'
import { currentUser } from './services/auth'
import { getDb, getMeta, setMeta } from './db/database'

const COMPANY_KEY = 'qbo_company_name'
const ERROR_KEY = 'qbo_last_error'

function canAdmin(): boolean {
  const user = currentUser()
  return !!user && user.permissions.includes('admin.access')
}

function requireAdmin(): void {
  if (!canAdmin()) {
    throw new Error('You do not have permission to manage the QuickBooks connection.')
  }
}

function iso(ms: number | undefined): string | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

export function buildStatus(): QboStatus {
  const config = getQboConfig()
  const tokens = getQboTokens()
  return {
    configured: !!config,
    connected: !!tokens,
    environment: config?.environment ?? 'sandbox',
    clientIdHint: config ? config.clientId.slice(-4) : null,
    realmId: tokens?.realmId ?? null,
    companyName: getMeta(getDb(), COMPANY_KEY) || null,
    expiresAt: iso(tokens?.expiresAt),
    refreshExpiresAt: iso(tokens?.refreshExpiresAt),
    lastError: getMeta(getDb(), ERROR_KEY) || null
  }
}

function noteError(message: string | null): void {
  setMeta(getDb(), ERROR_KEY, message ?? '')
}

export function registerQuickBooksIpc(): void {
  ipcMain.handle(IPC.qboStatus, (): QboStatus | null => {
    if (!canAdmin()) return null
    return buildStatus()
  })

  ipcMain.handle(
    IPC.qboSaveConfig,
    (_e, input: { clientId: string; clientSecret: string; environment: QboEnvironment }): Result<QboStatus> => {
      try {
        requireAdmin()
        const clientId = (input?.clientId ?? '').trim()
        const clientSecret = (input?.clientSecret ?? '').trim()
        if (!clientId || !clientSecret) return { ok: false, error: 'Enter both the client id and the client secret.' }
        const previous = getQboConfig()
        setQboConfig(clientId, clientSecret, input.environment)
        // Changing the app registration or the environment invalidates any
        // existing grant — tokens issued by one app are meaningless to another,
        // and sandbox tokens do not work against production.
        if (previous && (previous.clientId !== clientId || previous.environment !== input.environment)) {
          clearQboTokens()
          setMeta(getDb(), COMPANY_KEY, '')
        }
        noteError(null)
        return { ok: true, data: buildStatus() }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(IPC.qboConnect, async (): Promise<Result<QboStatus>> => {
    try {
      requireAdmin()
      const config = getQboConfig()
      if (!config) return { ok: false, error: 'Enter the client id and secret first.' }

      const { code, realmId } = await authorize(config)
      const tokens = await exchangeCode(config, code, realmId)
      setQboTokens(tokens)

      // Prove the grant actually works before calling it connected. A stored
      // token that 401s on first use is worse than an honest failure here.
      try {
        const info = await fetchCompanyInfo()
        setMeta(getDb(), COMPANY_KEY, info.CompanyName ?? info.LegalName ?? '')
      } catch (err) {
        clearQboTokens()
        const message = err instanceof Error ? err.message : String(err)
        noteError(message)
        return { ok: false, error: `Connected, but the first request failed: ${message}` }
      }

      noteError(null)
      return { ok: true, data: buildStatus() }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      noteError(message)
      return { ok: false, error: message }
    }
  })

  ipcMain.handle(IPC.qboDisconnect, async (): Promise<Result<QboStatus>> => {
    try {
      requireAdmin()
      const config = getQboConfig()
      const tokens = getQboTokens()
      // Tell Intuit if we can, but never let that stop the local disconnect —
      // a network failure must not leave the operator stuck "connected".
      if (config && tokens) {
        try {
          await revokeTokens(config, tokens)
        } catch {
          /* best effort */
        }
      }
      clearQboTokens()
      setMeta(getDb(), COMPANY_KEY, '')
      noteError(null)
      return { ok: true, data: buildStatus() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /** Forget the app registration too, secret included. */
  ipcMain.handle(IPC.qboForget, (): Result<QboStatus> => {
    try {
      requireAdmin()
      clearQboTokens()
      clearQboConfig()
      setMeta(getDb(), COMPANY_KEY, '')
      noteError(null)
      return { ok: true, data: buildStatus() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /** Live round-trip against the API, so "connected" can be trusted. */
  ipcMain.handle(IPC.qboTest, async (): Promise<Result<{ companyName: string; realmId: string }>> => {
    try {
      requireAdmin()
      const info = await fetchCompanyInfo()
      const tokens = getQboTokens()
      const name = info.CompanyName ?? info.LegalName ?? ''
      setMeta(getDb(), COMPANY_KEY, name)
      noteError(null)
      return { ok: true, data: { companyName: name, realmId: tokens?.realmId ?? '' } }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      noteError(message)
      return { ok: false, error: message }
    }
  })
}
