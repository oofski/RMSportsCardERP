/**
 * QuickBooks Online integration — shared shapes and endpoint constants.
 *
 * Kept in @shared so the renderer can type the settings screen without pulling
 * in anything from the main process. NOTHING secret lives here: the client id
 * and secret are entered by the operator and stored encrypted on their machine
 * (see main/quickbooks/store.ts).
 */

export type QboEnvironment = 'sandbox' | 'production'

export interface QboConfig {
  clientId: string
  clientSecret: string
  environment: QboEnvironment
}

export interface QboTokens {
  accessToken: string
  refreshToken: string
  /** The QuickBooks company this grant is for. */
  realmId: string
  /** Epoch ms. Access tokens last an hour. */
  expiresAt: number
  /** Epoch ms. Refresh tokens last ~100 days and rotate on use. */
  refreshExpiresAt: number
}

/** What the settings screen renders. Never includes the secret or the tokens. */
export interface QboStatus {
  configured: boolean
  connected: boolean
  environment: QboEnvironment
  /** Last four of the client id, so the operator can tell which app is wired. */
  clientIdHint: string | null
  realmId: string | null
  companyName: string | null
  /** ISO. When the access token needs refreshing — informational. */
  expiresAt: string | null
  /** ISO. When the operator will have to re-consent. */
  refreshExpiresAt: string | null
  lastError: string | null
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const QBO_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2'
export const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
export const QBO_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke'

/** Accounting scope only. Widen deliberately, not by default. */
export const QBO_SCOPE = 'com.intuit.quickbooks.accounting'

/**
 * The loopback port the desktop app listens on to catch Intuit's redirect.
 * Fixed rather than random because Intuit requires the redirect URI to be
 * registered up front and matched exactly.
 */
export const QBO_REDIRECT_PORT = 8462
export const QBO_REDIRECT_URI = `http://localhost:${QBO_REDIRECT_PORT}/callback`

export function qboApiBase(environment: QboEnvironment): string {
  return environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com'
}

/**
 * Pinned so a minor-version bump at Intuit cannot silently change response
 * shapes underneath a running install.
 */
export const QBO_MINOR_VERSION = '75'

/**
 * Refresh this long before the access token actually expires, so a call that
 * starts just under the wire does not land just over it.
 */
export const QBO_REFRESH_SKEW_MS = 5 * 60 * 1000

/** True when the access token is missing, expired, or about to be. */
export function needsRefresh(tokens: QboTokens | null, now: number): boolean {
  if (!tokens?.accessToken) return true
  return tokens.expiresAt - QBO_REFRESH_SKEW_MS <= now
}

/** True when even the refresh token is done and the operator must re-consent. */
export function needsReconsent(tokens: QboTokens | null, now: number): boolean {
  if (!tokens?.refreshToken) return true
  return tokens.refreshExpiresAt <= now
}

/** Build the consent URL the operator's browser is sent to. */
export function buildAuthorizeUrl(clientId: string, state: string, redirectUri = QBO_REDIRECT_URI): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: QBO_SCOPE,
    redirect_uri: redirectUri,
    state
  })
  return `${QBO_AUTHORIZE_URL}?${params.toString()}`
}

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------

/**
 * One account as QuickBooks reports it. Only the fields the mapping screen
 * needs — the full entity is much larger and none of the rest is useful here.
 *
 * `fullyQualifiedName` is the one to display: sub-accounts are named "Postage"
 * but qualified as "Shipping:Postage", and two different parents can each own a
 * child called "Postage".
 */
export interface QboAccount {
  id: string
  name: string
  fullyQualifiedName: string
  accountType: string
  accountSubType: string
  classification: string
  active: boolean
}

/**
 * The slots the app needs filled before it can post anything. Deliberately
 * named for what the BUSINESS does, not for what QuickBooks calls it — the
 * operator picking these knows what a break is, not what a debit is.
 */
export type QboMapSlotKey =
  | 'inventoryAsset'
  | 'cogs'
  | 'accountsPayable'
  | 'paymentAccount'
  | 'suppliesExpense'
  | 'salesIncome'
  | 'shippingIncome'
  | 'shippingExpense'

export type QboAccountMap = Partial<Record<QboMapSlotKey, string>>

export interface QboMapSlot {
  key: QboMapSlotKey
  label: string
  hint: string
  /**
   * QuickBooks AccountType values that belong in this slot. Used to filter the
   * dropdown AND to reject a saved mapping that points somewhere nonsensical —
   * posting inventory to an income account produces books that balance and are
   * completely wrong, which is the worst kind of bug to find later.
   */
  accountTypes: string[]
}

export const QBO_MAP_SLOTS: readonly QboMapSlot[] = [
  {
    key: 'inventoryAsset',
    label: 'Inventory asset',
    hint: 'Where received card stock sits on the balance sheet until it sells.',
    accountTypes: ['Other Current Asset']
  },
  {
    key: 'cogs',
    label: 'Cost of goods sold',
    hint: 'What the cards cost, recognised when they sell.',
    accountTypes: ['Cost of Goods Sold']
  },
  {
    key: 'accountsPayable',
    label: 'Accounts payable',
    hint: 'What an unpaid supplier bill is owed against.',
    accountTypes: ['Accounts Payable']
  },
  {
    key: 'paymentAccount',
    label: 'Pays for supplies',
    hint: 'The bank or card that automated supply buys are charged to.',
    accountTypes: ['Bank', 'Credit Card']
  },
  {
    key: 'suppliesExpense',
    label: 'Supplies expense',
    hint: 'Mailers, sleeves, tape, labels — consumables, not sellable stock.',
    accountTypes: ['Expense', 'Other Expense']
  },
  {
    key: 'salesIncome',
    label: 'Break sales income',
    hint: 'Revenue from team slots sold on a break.',
    accountTypes: ['Income']
  },
  {
    key: 'shippingIncome',
    label: 'Shipping income',
    hint: 'Shipping charged to the customer.',
    accountTypes: ['Income']
  },
  {
    key: 'shippingExpense',
    label: 'Postage expense',
    hint: 'Postage actually paid to the carrier.',
    accountTypes: ['Expense', 'Other Expense']
  }
] as const

/**
 * Which slots each area of the app needs. Readiness is reported per flow rather
 * than as one all-or-nothing switch, so inventory POs can start syncing while
 * the revenue side is still being decided.
 */
export type QboFlowKey = 'inventory_po' | 'supply_order' | 'sales'

export interface QboFlow {
  key: QboFlowKey
  label: string
  description: string
  slots: QboMapSlotKey[]
}

export const QBO_FLOWS: readonly QboFlow[] = [
  {
    key: 'inventory_po',
    label: 'Inventory purchase orders',
    description: 'A received PO becomes a supplier bill.',
    slots: ['inventoryAsset', 'accountsPayable']
  },
  {
    key: 'supply_order',
    label: 'Supply orders',
    description: 'An automated supply buy becomes an expense.',
    slots: ['paymentAccount', 'suppliesExpense']
  },
  {
    key: 'sales',
    label: 'Break sales',
    description: 'A shipped show becomes sales receipts.',
    slots: ['salesIncome', 'shippingIncome']
  }
] as const

/** The slots a flow still needs before it can post. */
export function missingSlots(map: QboAccountMap, flow: QboFlow): QboMapSlotKey[] {
  return flow.slots.filter((s) => !map[s])
}

export function flowReady(map: QboAccountMap, flow: QboFlow): boolean {
  return missingSlots(map, flow).length === 0
}

// ---------------------------------------------------------------------------
// Sync log
// ---------------------------------------------------------------------------

export type QboSyncEntity = 'purchase_order' | 'supply_order' | 'ship_snapshot'
export type QboSyncStatus = 'pending' | 'synced' | 'failed'

/**
 * One local record's relationship with QuickBooks. This table is what makes the
 * sync safe to re-run: a record already synced to a given company is skipped,
 * and one that changed since is recognised by its payload hash rather than
 * being posted twice.
 */
export interface QboSyncRow {
  id: string
  entity: QboSyncEntity
  localId: string
  /** Which QuickBooks company. Sandbox and production are tracked separately. */
  realmId: string
  qboType: string
  qboId: string | null
  docNumber: string | null
  amount: number
  status: QboSyncStatus
  error: string | null
  payloadHash: string | null
  createdAt: string
  updatedAt: string
  syncedAt: string | null
}
