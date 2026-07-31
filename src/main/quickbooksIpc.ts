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
import { ipcMain } from './ipcRegistry'
import { IPC } from '@shared/ipc'
import type { Result } from '@shared/types'
import type { QboAccount, QboAccountMap, QboEnvironment, QboStatus, QboSyncRow } from '@shared/quickbooks'
import { getQboConfig, setQboConfig, clearQboConfig, getQboTokens, setQboTokens, clearQboTokens } from './quickbooks/store'
import { authorize, exchangeCode, revokeTokens } from './quickbooks/oauth'
import { QBO_REDIRECT_URI, buildAuthorizeUrl } from '@shared/quickbooks'
import { fetchCompanyInfo } from './quickbooks/client'
import { fetchAccounts } from './quickbooks/accounts'
import { getAccountMap, setAccountMap, suggestMap, validateMap } from './quickbooks/mapping'
import { listSyncRows } from './db/qboSync'
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

  /**
   * Diagnostics: the exact URL the browser is sent to. Intuit's "redirect_uri
   * is invalid" error says nothing about what it actually received, so being
   * able to read the outgoing value — and paste it into a browser by hand — is
   * the difference between debugging and guessing. The client id is in this URL
   * but that is not a secret; it travels in the address bar either way.
   */
  ipcMain.handle(IPC.qboAuthorizeUrl, (): Result<{ url: string; redirectUri: string }> => {
    try {
      requireAdmin()
      const config = getQboConfig()
      if (!config) return { ok: false, error: 'Enter the client id and secret first.' }
      return {
        ok: true,
        data: {
          url: buildAuthorizeUrl(config.clientId, 'diagnostic-state'),
          redirectUri: QBO_REDIRECT_URI
        }
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * Adopt tokens minted elsewhere — Intuit's OAuth Playground, which every app
   * already has a registered redirect for. This is not a lesser path: the
   * tokens belong to the SAME app registration, so once stored the normal
   * refresh cycle takes over and the operator never repeats it.
   *
   * expiresAt is deliberately set to 0 so the very first call must refresh.
   * That proves the refresh token and the stored client credentials work
   * TOGETHER before anything is called connected, and replaces the guessed
   * lifetimes with the real ones Intuit hands back.
   */
  ipcMain.handle(
    IPC.qboPasteTokens,
    async (_e, input: { accessToken: string; refreshToken: string; realmId: string }): Promise<Result<QboStatus>> => {
      try {
        requireAdmin()
        if (!getQboConfig()) return { ok: false, error: 'Save the client id and secret first.' }
        const accessToken = (input?.accessToken ?? '').trim()
        const refreshToken = (input?.refreshToken ?? '').trim()
        const realmId = (input?.realmId ?? '').trim()
        if (!refreshToken || !realmId) {
          return { ok: false, error: 'The refresh token and the company (realm) id are both required.' }
        }
        const previous = getQboTokens()
        setQboTokens({
          accessToken,
          refreshToken,
          realmId,
          expiresAt: 0,
          refreshExpiresAt: Date.now() + 100 * 24 * 60 * 60 * 1000
        })
        try {
          const info = await fetchCompanyInfo()
          setMeta(getDb(), COMPANY_KEY, info.CompanyName ?? info.LegalName ?? '')
        } catch (err) {
          // Put back whatever was there rather than leaving a half-set state.
          if (previous) setQboTokens(previous)
          else clearQboTokens()
          const message = err instanceof Error ? err.message : String(err)
          noteError(message)
          return { ok: false, error: message }
        }
        noteError(null)
        return { ok: true, data: buildStatus() }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  /**
   * The chart of accounts, plus a suggested mapping. Read-only against
   * QuickBooks — this is the call to make first against a live company,
   * because it proves the connection works without writing anything.
   */
  ipcMain.handle(
    IPC.qboAccounts,
    async (): Promise<Result<{ accounts: QboAccount[]; suggested: QboAccountMap }>> => {
      try {
        requireAdmin()
        const accounts = await fetchAccounts()
        noteError(null)
        return { ok: true, data: { accounts, suggested: suggestMap(accounts) } }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        noteError(message)
        return { ok: false, error: message }
      }
    }
  )

  ipcMain.handle(IPC.qboMappingGet, (): Result<{ realmId: string; map: QboAccountMap }> => {
    try {
      requireAdmin()
      const tokens = getQboTokens()
      if (!tokens) return { ok: false, error: 'Connect QuickBooks first.' }
      return { ok: true, data: { realmId: tokens.realmId, map: getAccountMap(tokens.realmId) } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * Save the mapping, but only after checking every chosen account against the
   * live chart of accounts. The fetch is deliberately not optional: an
   * unverified mapping is how inventory ends up posted to an income account,
   * and that error is invisible until it is expensive.
   */
  ipcMain.handle(
    IPC.qboMappingSave,
    async (_e, input: { map: QboAccountMap }): Promise<Result<{ map: QboAccountMap }>> => {
      try {
        requireAdmin()
        const tokens = getQboTokens()
        if (!tokens) return { ok: false, error: 'Connect QuickBooks first.' }
        const map = input?.map ?? {}

        let accounts: QboAccount[]
        try {
          accounts = await fetchAccounts()
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return { ok: false, error: `Could not verify the accounts against QuickBooks: ${message}` }
        }

        const check = validateMap(map, accounts)
        if (!check.ok) return { ok: false, error: check.error }

        setAccountMap(tokens.realmId, map)
        noteError(null)
        return { ok: true, data: { map: getAccountMap(tokens.realmId) } }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  /** What has been pushed to the connected company, and as what. */
  ipcMain.handle(IPC.qboSyncLog, (): Result<QboSyncRow[]> => {
    try {
      requireAdmin()
      const tokens = getQboTokens()
      if (!tokens) return { ok: false, error: 'Connect QuickBooks first.' }
      return { ok: true, data: listSyncRows(getDb(), tokens.realmId) }
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
