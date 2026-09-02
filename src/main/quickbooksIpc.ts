/**
 * QuickBooks Online IPC.
 *
 * Every handler is gated on 'admin.access': connecting an accounting system is
 * an owner-level action, and the client secret is entered through it.
 *
 * The secret is WRITE-ONLY across this boundary — it goes in, and nothing ever
 * hands it back to the renderer. Status carries the last four of the client id
 * only, which is enough to tell two app registrations apart.
 *
 * ## Where the connection goes when you set it up
 *
 * TO THE RELAY, whenever this build has one. The client id and secret typed into
 * step 1 are sent to Cloudflare and stored encrypted there; consent is exchanged
 * there; the tokens are refreshed there. Nothing lands in this machine's
 * keychain. That is what makes it a one-time setup for the whole company rather
 * than a task every admin repeats — see @shared/quickbooksRelay for why one
 * holder is the only safe number.
 *
 * The local path is still here and still works, for a standalone build with no
 * relay and for the owner's existing connection until it is promoted. Every
 * handler asks which holder is in play rather than assuming, and `qboPromote` is
 * the one-time move from one to the other.
 */
import { ipcMain } from './ipcRegistry'
import { IPC } from '@shared/ipc'
import type { Result } from '@shared/types'
import type { QboAccount, QboAccountMap, QboEnvironment, QboStatus, QboSyncRow } from '@shared/quickbooks'
import {
  getQboConfig,
  setQboConfig,
  clearQboConfig,
  getQboTokens,
  setQboTokens,
  clearQboTokens,
  clearQboRelayMemo
} from './quickbooks/store'
import { authorize, effectiveRedirectUri, exchangeCode, revokeTokens } from './quickbooks/oauth'
import {
  QBO_DEFAULT_REDIRECT_URI,
  QBO_REDIRECT_URI,
  buildAuthorizeUrl,
  isLoopbackRedirect,
  validateClientId,
  validateRealmId,
  validateRefreshToken
} from '@shared/quickbooks'
import {
  describePromotionBlock,
  promotionBlock,
  type QboHolder,
  type QboRelayProbe
} from '@shared/quickbooksRelay'
import { activeRealmId, fetchCompanyInfo, qboHolder } from './quickbooks/client'
import {
  diagnoseRelay,
  probeRelayQbo,
  relayAdoptQboTokens,
  relayConfigured,
  relayDisconnectQbo,
  relayExchangeQboCode,
  relayForgetQbo,
  relayQboAuthorizeUrl,
  relaySaveQboConfig,
  rememberedRelayQbo
} from './quickbooks/relay'
import { fetchAccounts } from './quickbooks/accounts'
import { getAccountMap, setAccountMap, suggestMap, validateMap } from './quickbooks/mapping'
import { forgetInvoiceRefs } from './quickbooks/invoiceRefs'
import { listSyncRows } from './db/qboSync'
import { currentUser } from './services/auth'
import type { RelayDiagnosis } from '@shared/relayDiagnosis'
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

/**
 * The whole picture, in one object: what this machine has, what the relay has,
 * and which of the two the next invoice will actually go through.
 *
 * Asks the relay rather than trusting the memo, because this is exactly the
 * moment somebody is looking at the screen to find out — and a remembered answer
 * from before they finished setting it up on another machine is the one that
 * makes the button look broken.
 */
export async function buildStatus(): Promise<QboStatus> {
  const config = getQboConfig()
  const tokens = getQboTokens()
  const relay: QboRelayProbe | null = relayConfigured() ? await probeRelayQbo() : null
  const holder = await qboHolder()
  const block = promotionBlock({
    relayConfigured: relayConfigured(),
    relayConnected: relay?.connected === true,
    localConfigured: !!config,
    localConnected: !!config && !!tokens
  })

  // The COMPANY the screen names comes from whoever is holding the grant. A
  // laptop that was promoted still has an old company name in its meta table,
  // and showing that beside a relay connection to a different company would be
  // the most confidently wrong thing this screen could do.
  const companyName =
    holder === 'relay' ? (relay?.companyName ?? null) : getMeta(getDb(), COMPANY_KEY) || null

  return {
    configured: !!config,
    connected: !!tokens,
    environment: 'production',
    clientIdHint:
      holder === 'relay' ? (relay?.clientIdHint ?? null) : config ? config.clientId.slice(-4) : null,
    realmId: holder === 'relay' ? (relay?.realmId ?? null) : (tokens?.realmId ?? null),
    companyName,
    expiresAt: holder === 'relay' ? (relay?.expiresAt ?? null) : iso(tokens?.expiresAt),
    refreshExpiresAt:
      holder === 'relay' ? (relay?.refreshExpiresAt ?? null) : iso(tokens?.refreshExpiresAt),
    // The relay's own recorded failure beats this machine's when the relay is
    // the holder: a stale local error from a connection that no longer runs
    // anything is noise on a screen somebody opened because something is wrong.
    lastError:
      holder === 'relay'
        ? (relay?.problem ?? relay?.lastError ?? null)
        : getMeta(getDb(), ERROR_KEY) || null,
    redirectUri: config ? effectiveRedirectUri(config) : QBO_DEFAULT_REDIRECT_URI,
    holder,
    relay,
    canPromote: block === null,
    promoteBlocked: describePromotionBlock(block)
  }
}

function noteError(message: string | null): void {
  setMeta(getDb(), ERROR_KEY, message ?? '')
}

/**
 * Where setup should WRITE, which is not always where the current connection
 * lives.
 *
 * A build with a relay always sets up on the relay, even when this machine
 * happens to still hold an old local connection — otherwise pressing "Save keys"
 * on the owner's laptop would keep re-creating the very thing the migration is
 * removing.
 */
function setupTarget(): 'relay' | 'local' {
  return relayConfigured() ? 'relay' : 'local'
}

export function registerQuickBooksIpc(): void {
  ipcMain.handle(IPC.qboStatus, async (): Promise<QboStatus | null> => {
    if (!canAdmin()) return null
    return buildStatus()
  })

  ipcMain.handle(
    IPC.qboSaveConfig,
    async (
      _e,
      input: {
        clientId: string
        clientSecret: string
        environment: QboEnvironment
        redirectUri?: string
      }
    ): Promise<Result<QboStatus>> => {
      try {
        requireAdmin()
        const clientId = (input?.clientId ?? '').trim()
        const clientSecret = (input?.clientSecret ?? '').trim()
        if (!clientId || !clientSecret) return { ok: false, error: 'Enter both the client id and the client secret.' }
        const badId = validateClientId(clientId)
        if (badId) return { ok: false, error: badId }

        if (setupTarget() === 'relay') {
          // Straight to Cloudflare. The secret is not written to this machine at
          // all — not even briefly — because a copy that exists for one minute
          // still exists in a backup taken during that minute.
          await relaySaveQboConfig(clientId, clientSecret, input.redirectUri)
          forgetInvoiceRefs()
          noteError(null)
          return { ok: true, data: await buildStatus() }
        }

        const previous = getQboConfig()
        // PRODUCTION ONLY. The sandbox choice is gone: this business has one
        // set of books and every invoice raised here is real, so an environment
        // switch was a way to point a night's billing at a test company and not
        // notice until somebody asked where the invoices went.
        setQboConfig(clientId, clientSecret, 'production', input.redirectUri)
        // Changing the app registration invalidates any existing grant — tokens
        // issued by one app are meaningless to another.
        if (previous && previous.clientId !== clientId) {
          clearQboTokens()
          setMeta(getDb(), COMPANY_KEY, '')
        }
        noteError(null)
        return { ok: true, data: await buildStatus() }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(IPC.qboConnect, async (): Promise<Result<QboStatus>> => {
    try {
      requireAdmin()
      const relay = setupTarget() === 'relay'
      const config = getQboConfig()
      if (!relay && !config) return { ok: false, error: 'Enter the client id and secret first.' }

      // The listener can only catch a redirect aimed at itself. With any other
      // redirect — the Playground's, or a company's own https endpoint — Intuit
      // sends the browser somewhere this app cannot read, so starting a
      // listener would hang until it timed out and report nothing useful.
      // Refused up front, naming the step that does work.
      const redirectUri = relay ? QBO_REDIRECT_URI : effectiveRedirectUri(config as NonNullable<typeof config>)
      if (!relay && !isLoopbackRedirect(config?.redirectUri)) {
        return {
          ok: false,
          error:
            'This connection uses a redirect URI the app cannot catch, so consent has to be finished by hand: press “Open consent page”, approve, then paste the code from the address bar.'
        }
      }

      // The consent URL is built by whoever holds the client id. On the relay
      // path that is Cloudflare, so the client id never comes back to a laptop
      // merely to open a browser tab.
      const { code, realmId } = await authorize(async (state) =>
        relay
          ? (await relayQboAuthorizeUrl(state, QBO_REDIRECT_URI)).url
          : buildAuthorizeUrl((config as NonNullable<typeof config>).clientId, state, redirectUri)
      )

      if (relay) {
        await relayExchangeQboCode(code, realmId, QBO_REDIRECT_URI)
        forgetInvoiceRefs()
        noteError(null)
        return { ok: true, data: await buildStatus() }
      }

      const tokens = await exchangeCode(config as NonNullable<typeof config>, code, realmId)
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
      return { ok: true, data: await buildStatus() }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      noteError(message)
      return { ok: false, error: message }
    }
  })

  ipcMain.handle(IPC.qboDisconnect, async (): Promise<Result<QboStatus>> => {
    try {
      requireAdmin()
      const holder: QboHolder = await qboHolder()
      if (holder === 'relay') {
        // Disconnecting the relay disconnects EVERYBODY, which is the honest
        // consequence of one holder and is why the button lives behind
        // admin.access. The relay revokes with Intuit and clears its own row.
        await relayDisconnectQbo()
        forgetInvoiceRefs()
        noteError(null)
        return { ok: true, data: await buildStatus() }
      }

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
      forgetInvoiceRefs()
      noteError(null)
      return { ok: true, data: await buildStatus() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /** Forget the app registration too, secret included — on whichever holder. */
  ipcMain.handle(IPC.qboForget, async (): Promise<Result<QboStatus>> => {
    try {
      requireAdmin()
      if ((await qboHolder()) === 'relay') await relayForgetQbo()
      clearQboTokens()
      clearQboConfig()
      setMeta(getDb(), COMPANY_KEY, '')
      forgetInvoiceRefs()
      noteError(null)
      return { ok: true, data: await buildStatus() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * Move the connection this machine already has onto the relay. Once, ever.
   *
   * ## Why this is not "disconnect and reconnect"
   *
   * Reconnecting means going back to Intuit's portal, re-consenting and picking
   * the company again — and the owner is connected TODAY. Nothing about that
   * grant is machine-specific: it is a refresh token minted against an app
   * registration, and the relay has the same registration the moment the secret
   * is handed over. So the grant is carried across rather than re-issued.
   *
   * ## The order is the safety
   *
   * Config, then tokens, then a live QuickBooks call THROUGH THE RELAY, and only
   * then is the local copy erased. Erase first and a relay that refuses the
   * tokens leaves the owner with no connection anywhere and a re-consent to do.
   * This way the worst outcome is that nothing changed.
   *
   * ## What happens to the local copy, plainly
   *
   * It is deleted. The tokens and the client secret both. That is the point of
   * the move: a machine still holding a grant Intuit rotates is a second holder,
   * and a second holder is the failure this whole change removes.
   */
  ipcMain.handle(
    IPC.qboPromote,
    async (): Promise<Result<{ status: QboStatus; companyName: string; localCleared: boolean }>> => {
      try {
        requireAdmin()
        const config = getQboConfig()
        const tokens = getQboTokens()
        const relay = relayConfigured() ? await probeRelayQbo() : null
        const block = promotionBlock({
          relayConfigured: relayConfigured(),
          relayConnected: relay?.connected === true,
          localConfigured: !!config,
          localConnected: !!config && !!tokens
        })
        if (block) return { ok: false, error: describePromotionBlock(block) ?? 'That cannot be moved.' }
        if (!config || !tokens) return { ok: false, error: 'There is nothing on this computer to move.' }

        await relaySaveQboConfig(config.clientId, config.clientSecret, config.redirectUri)
        // The ACCESS token is deliberately not carried: the relay is told to
        // refresh immediately, which proves the refresh token and the client
        // credentials work TOGETHER before any of this is called connected, and
        // replaces our guessed lifetimes with the real ones Intuit hands back.
        const after = await relayAdoptQboTokens({
          refreshToken: tokens.refreshToken,
          realmId: tokens.realmId,
          refreshExpiresAt: tokens.refreshExpiresAt
        })
        if (!after.connected) {
          return {
            ok: false,
            error:
              'The relay took the keys but could not use the grant, so nothing was changed on this ' +
              'computer. ' + (after.lastError ?? after.problem ?? '')
          }
        }

        // Only now. The local copy stops existing, and the reference caches are
        // dropped because they are keyed by realm and were filled by a holder
        // that no longer runs anything.
        clearQboTokens()
        clearQboConfig()
        setMeta(getDb(), COMPANY_KEY, '')
        forgetInvoiceRefs()
        noteError(null)
        return {
          ok: true,
          data: {
            status: await buildStatus(),
            companyName: after.companyName ?? '',
            localCleared: true
          }
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  /**
   * Finish consent from a code the operator pasted.
   *
   * The other half of a non-loopback redirect. Intuit sent the browser to a
   * page this app cannot read, so the code is carried across by hand — and the
   * EXCHANGE is still done by whoever holds the secret, which on a relay build
   * is the relay. That is the part that matters: the holder ends up with a token
   * pair minted against its own client id and secret and refreshes them from
   * then on, and nothing but a one-time code ever passes through a clipboard.
   *
   * The redirect URI sent here MUST equal the one sent with the authorize
   * request — Intuit compares them and refuses otherwise — which is why both
   * read it from the same place rather than from a constant.
   */
  ipcMain.handle(
    IPC.qboExchangeCode,
    async (_e, input: { code: string; realmId: string }): Promise<Result<QboStatus>> => {
      try {
        requireAdmin()
        const code = (input?.code ?? '').trim()
        const realmId = (input?.realmId ?? '').trim()
        if (!code) return { ok: false, error: 'Paste the authorization code.' }
        const badRealm = validateRealmId(realmId)
        if (badRealm) return { ok: false, error: badRealm }

        if (setupTarget() === 'relay') {
          try {
            await relayExchangeQboCode(code, realmId)
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            noteError(message)
            return { ok: false, error: message }
          }
          forgetInvoiceRefs()
          noteError(null)
          return { ok: true, data: await buildStatus() }
        }

        const config = getQboConfig()
        if (!config) return { ok: false, error: 'Enter the client id and secret first.' }
        const previous = getQboTokens()
        try {
          setQboTokens(await exchangeCode(config, code, realmId))
          const info = await fetchCompanyInfo()
          setMeta(getDb(), COMPANY_KEY, info.CompanyName ?? info.LegalName ?? '')
        } catch (err) {
          // Put back whatever was there. A half-finished exchange that leaves
          // dead tokens behind is worse than not having tried.
          if (previous) setQboTokens(previous)
          else clearQboTokens()
          const message = err instanceof Error ? err.message : String(err)
          noteError(message)
          return { ok: false, error: message }
        }
        noteError(null)
        return { ok: true, data: await buildStatus() }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  /**
   * Diagnostics: the exact URL the browser is sent to. Intuit's "redirect_uri
   * is invalid" error says nothing about what it actually received, so being
   * able to read the outgoing value — and paste it into a browser by hand — is
   * the difference between debugging and guessing. The client id is in this URL
   * but that is not a secret; it travels in the address bar either way.
   */
  ipcMain.handle(
    IPC.qboAuthorizeUrl,
    async (): Promise<Result<{ url: string; redirectUri: string }>> => {
      try {
        requireAdmin()
        if (setupTarget() === 'relay') {
          const built = await relayQboAuthorizeUrl('rmops')
          return { ok: true, data: built }
        }
        const config = getQboConfig()
        if (!config) return { ok: false, error: 'Enter the client id and secret first.' }
        return {
          ok: true,
          data: {
            url: buildAuthorizeUrl(config.clientId, 'rmops', effectiveRedirectUri(config)),
            redirectUri: effectiveRedirectUri(config)
          }
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  /**
   * Adopt tokens minted elsewhere — Intuit's OAuth Playground, which every app
   * already has a registered redirect for. This is not a lesser path: the
   * tokens belong to the SAME app registration, so once stored the normal
   * refresh cycle takes over and the operator never repeats it.
   *
   * expiresAt is deliberately set to 0 so the very first call must refresh.
   * That proves the refresh token and the stored client credentials work
   * TOGETHER before anything is called connected, and replaces the guessed
   * lifetimes with the real ones Intuit hands back. The relay does the same.
   */
  ipcMain.handle(
    IPC.qboPasteTokens,
    async (_e, input: { accessToken: string; refreshToken: string; realmId: string }): Promise<Result<QboStatus>> => {
      try {
        requireAdmin()
        const accessToken = (input?.accessToken ?? '').trim()
        const refreshToken = (input?.refreshToken ?? '').trim()
        const realmId = (input?.realmId ?? '').trim()
        // Shape-checked before anything is sent. Intuit's refusal names none of
        // this, and "Client ID pasted into the company box" is the mistake that
        // actually happens — see @shared/quickbooks.
        const badToken = validateRefreshToken(refreshToken)
        if (badToken) return { ok: false, error: badToken }
        const badRealm = validateRealmId(realmId)
        if (badRealm) return { ok: false, error: badRealm }

        if (setupTarget() === 'relay') {
          try {
            await relayAdoptQboTokens({ refreshToken, realmId })
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            noteError(message)
            return { ok: false, error: message }
          }
          forgetInvoiceRefs()
          noteError(null)
          return { ok: true, data: await buildStatus() }
        }

        if (!getQboConfig()) return { ok: false, error: 'Save the client id and secret first.' }
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
        return { ok: true, data: await buildStatus() }
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

  ipcMain.handle(IPC.qboMappingGet, async (): Promise<Result<{ realmId: string; map: QboAccountMap }>> => {
    try {
      requireAdmin()
      // Asked rather than remembered: this screen is frequently the first thing
      // opened after the relay was connected on somebody else's machine, and a
      // memo from before that would report "connect QuickBooks first" about a
      // connection that already exists.
      await qboHolder()
      const realmId = activeRealmId()
      if (!realmId) return { ok: false, error: 'Connect QuickBooks first.' }
      return { ok: true, data: { realmId, map: getAccountMap(realmId) } }
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
        await qboHolder()
        const realmId = activeRealmId()
        if (!realmId) return { ok: false, error: 'Connect QuickBooks first.' }
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

        setAccountMap(realmId, map)
        noteError(null)
        return { ok: true, data: { map: getAccountMap(realmId) } }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  /** What has been pushed to the connected company, and as what. */
  ipcMain.handle(IPC.qboSyncLog, (): Result<QboSyncRow[]> => {
    try {
      requireAdmin()
      const realmId = activeRealmId()
      if (!realmId) return { ok: false, error: 'Connect QuickBooks first.' }
      return { ok: true, data: listSyncRows(getDb(), realmId) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * Live round-trip against the API, so "connected" can be trusted.
   *
   * Forces a fresh relay probe first: this button exists precisely for the
   * moment somebody suspects the connection is wrong, and answering it out of a
   * two-minute-old memo would be answering a different question.
   */
  /**
   * Which hop is broken. Always ok:true — a failing hop is the ANSWER here, not
   * an error, and returning ok:false would hide the finding behind a red box
   * with none of the timings in it.
   */
  ipcMain.handle(IPC.qboDiagnoseRelay, async (): Promise<Result<RelayDiagnosis>> => {
    try {
      requireAdmin()
      return { ok: true, data: await diagnoseRelay() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.qboTest, async (): Promise<Result<{ companyName: string; realmId: string }>> => {
    try {
      requireAdmin()
      if (relayConfigured()) {
        clearQboRelayMemo()
        await probeRelayQbo()
      }
      const info = await fetchCompanyInfo()
      const name = info.CompanyName ?? info.LegalName ?? ''
      const holder = await qboHolder()
      if (holder !== 'relay') setMeta(getDb(), COMPANY_KEY, name)
      noteError(null)
      return {
        ok: true,
        data: {
          companyName: name,
          realmId: (holder === 'relay' ? rememberedRelayQbo()?.realmId : getQboTokens()?.realmId) ?? ''
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      noteError(message)
      return { ok: false, error: message }
    }
  })
}
