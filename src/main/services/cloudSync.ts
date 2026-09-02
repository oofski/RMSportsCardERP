import { BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import { CLOUD_SYNC_BUILT_IN, CLOUD_SYNC_KEY, CLOUD_SYNC_URL } from '@shared/config'
import type { SyncConfig, SyncConfigView, SyncStatus, SyncPhase } from '@shared/sync'
import { getDb } from '../db/database'
import { queueEverything } from '../db/syncTriggers'
import { rebuildShipDocument } from '../db/shipping'
import { rebuildOrderDocuments } from '../db/orderExtras'
import {
  applyRows,
  clearForJoin,
  clearOutbox,
  cursor,
  deviceId,
  isBlankJoiner,
  pendingCount,
  rebuildDerivedStock,
  rebuildDerivedSupplyStock,
  retryRejects,
  rejectCount,
  setCursor,
  syncStateGet,
  syncStateSet,
  takeOutbox,
  type IncomingRow
} from '../db/sync'

/**
 * The sync loop: push what changed here, pull what changed there, repeat.
 *
 * Everything about this is designed to fail quietly and recover on its own. A
 * laptop with no internet keeps working and keeps queueing; when the connection
 * comes back the queue drains. Nothing in the app blocks on this, waits for it,
 * or breaks when it is off — which is the property that makes it safe to ship a
 * networked feature into an app people use to run a warehouse.
 */

const PUSH_BATCH = 300
const PULL_BATCH = 500
const DEFAULT_INTERVAL_SECONDS = 4
const MIN_INTERVAL_SECONDS = 2
/** Failure backoff ceiling, in multiples of the interval. */
const MAX_BACKOFF = 15

let timer: NodeJS.Timeout | null = null
let running = false
let phase: SyncPhase = 'off'
let failures = 0
let lastPulledRows = 0
let remoteRows: number | null = null
let remoteCursor: number | null = null

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Where this machine syncs to.
 *
 * The built-in values win unless somebody has deliberately typed something
 * else. That is the whole point of baking them in: a person installs the app
 * and it is already talking to the rest of the company, with nothing to enter
 * and nothing to get wrong.
 */
export function getSyncConfig(): SyncConfig {
  const storedUrl = (syncStateGet('url') ?? '').trim()
  const stored = syncStateGet('enabled')
  return {
    url: storedUrl || envValue('RMOPS_SYNC_URL') || CLOUD_SYNC_URL,
    device: (syncStateGet('device') ?? '').trim() || defaultDeviceName(),
    intervalSeconds: Number(syncStateGet('interval') ?? DEFAULT_INTERVAL_SECONDS) || DEFAULT_INTERVAL_SECONDS,
    // Never touched means ON for a build that ships a relay, or for a server
    // that was handed one. Somebody who pauses it has said so explicitly, and
    // that choice sticks.
    enabled: stored === null ? CLOUD_SYNC_BUILT_IN || envConfigured() : stored === '1'
  }
}

/**
 * The relay address and key, injected at RUNTIME.
 *
 * A desktop build gets them baked in at build time from CI secrets — that is
 * what CLOUD_SYNC_URL and CLOUD_SYNC_KEY are. A server cannot: the container
 * image is built once and would carry the key in a layer anybody who can pull
 * the image can read. So the server is handed them as environment variables
 * instead, and the image contains no secret at all.
 *
 * Order is stored → environment → build-time. Something an administrator typed
 * into the app still wins, because it was a deliberate act; the environment is
 * the default the deployment provides.
 */
function envValue(name: string): string {
  return (process.env[name] ?? '').trim()
}

function envConfigured(): boolean {
  return envValue('RMOPS_SYNC_URL').length > 0 && envValue('RMOPS_SYNC_KEY').length > 0
}

function sharedKey(): string {
  return (syncStateGet('key') ?? '').trim() || envValue('RMOPS_SYNC_KEY') || CLOUD_SYNC_KEY
}

function defaultDeviceName(): string {
  return `${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'This computer'}`
}

export function syncConfigView(): SyncConfigView {
  const config = getSyncConfig()
  const key = sharedKey()
  return {
    ...config,
    keySet: key.length > 0,
    keyHint: key ? key.slice(-4) : '',
    // True when this build came wired up, so the screen can say "nothing to do
    // here" instead of presenting empty fields that look like a task.
    builtIn: CLOUD_SYNC_BUILT_IN && !(syncStateGet('url') ?? '').trim()
  }
}

export interface SyncConfigUpdate extends Partial<SyncConfig> {
  /** Omitted leaves the stored key alone; '' clears it. */
  key?: string
}

export function setSyncConfig(update: SyncConfigUpdate): SyncStatus {
  if (update.url !== undefined) syncStateSet('url', normalizeUrl(update.url))
  if (update.device !== undefined) syncStateSet('device', update.device.trim().slice(0, 60))
  if (update.intervalSeconds !== undefined) {
    syncStateSet('interval', String(Math.max(MIN_INTERVAL_SECONDS, Math.round(update.intervalSeconds))))
  }
  if (update.key !== undefined) syncStateSet('key', update.key.trim())
  if (update.enabled !== undefined) syncStateSet('enabled', update.enabled ? '1' : '0')

  failures = 0
  syncStateSet('last_error', null)
  restart()
  return syncStatus()
}

/** Trailing slashes and a stray /v1 are the two things people paste. */
function normalizeUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  return trimmed.replace(/\/v1$/, '')
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export function syncStatus(): SyncStatus {
  const config = syncConfigView()
  const configured = config.url.length > 0 && config.keySet
  return {
    phase: !config.enabled ? 'off' : configured ? phase : 'unconfigured',
    config,
    pending: pendingCount(),
    cursor: cursor(),
    lastPushAt: syncStateGet('last_push_at'),
    lastPullAt: syncStateGet('last_pull_at'),
    lastPulledRows,
    lastError: syncStateGet('last_error'),
    failures,
    rejects: rejectCount(),
    remoteRows,
    remoteCursor
  }
}

function broadcast(): void {
  const status = syncStatus()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.syncStatusEvent, status)
  }
}

/**
 * Tell the renderer that data underneath it changed.
 *
 * Carries only the record types that moved, never the records. A screen decides
 * for itself whether it cares and refetches through the normal path, which keeps
 * permission checks where they belong and means this event can never be the
 * thing that shows someone a number they are not allowed to see.
 */
function announceChange(kinds: string[]): void {
  if (kinds.length === 0) return
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.syncChangedEvent, { kinds })
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * The ONE place that knows the relay's address, its key and how it fails.
 *
 * Exported so services/webPush.ts can reach the notification routes without a
 * second copy of the address resolution, the bearer header, the 30-second
 * timeout and — most of all — the "that is not a URL, it is the key" check
 * below, which took a week to diagnose the first time and would be worth
 * exactly nothing sitting in only one of two callers.
 */

export async function call(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; timeoutMs?: number }
): Promise<Record<string, unknown>> {
  const config = getSyncConfig()
  const key = sharedKey()
  if (!config.url || !key) throw new Error('Sync is not configured.')
  // CHECKED HERE, in words, because the native failure is unreadable and points
  // at nothing. A relay address that is not a URL — the commonest way being the
  // shared KEY pasted into the url field, since the two are set together and
  // look alike on a hosting dashboard — produces "Failed to parse URL from
  // <key>/v1/pull?since=0&limit=500&device=…". That message names the pull
  // route, so it reads like a relay fault or a protocol bug. It is neither: it
  // is one env var holding the other one's value, and nothing syncs at all
  // until somebody guesses that. This says so instead.
  if (!/^https?:\/\//i.test(config.url)) {
    throw new Error(
      `The relay address is not a URL: "${config.url}". It must start with https:// — ` +
        `this is usually the shared KEY pasted into the URL field by mistake. ` +
        `Nothing will sync until it is corrected.`
    )
  }

  const controller = new AbortController()
  /**
   * Long enough for a big first push over a bad connection, short enough that a
   * dead relay does not hold the loop open indefinitely.
   *
   * OVERRIDABLE, because not every caller is a sync round. A pull is this app
   * talking to the relay and nothing else; a QuickBooks call is this app, then
   * the relay, then INTUIT, and possibly a token refresh in the middle that
   * waits up to six seconds on its own lease before it even starts. Holding
   * both to the same ceiling meant the longest chain got the shortest patience,
   * and gave up on work that was still running.
   */
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? 30_000)
  try {
    const response = await fetch(`${config.url}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal
    })
    const text = await response.text()
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(text) as Record<string, unknown>
    } catch {
      // A Cloudflare error page is HTML. Reporting the first line of it beats
      // reporting "Unexpected token <".
      throw new Error(
        response.status === 200
          ? 'The relay replied with something that is not JSON — check the URL.'
          : `Relay error ${response.status}.`
      )
    }
    if (!response.ok || parsed.ok === false) {
      throw new Error(
        typeof parsed.error === 'string'
          ? parsed.error
          : `Relay error ${response.status}.`
      )
    }
    return parsed
  } finally {
    clearTimeout(timeout)
  }
}

// ---------------------------------------------------------------------------
// One round
// ---------------------------------------------------------------------------

export interface RoundResult {
  pushed: number
  pulled: number
  applied: number
  rejected: number
}

/**
 * Push, then pull. In that order, always.
 *
 * Pushing first means this laptop's own work is safe on the relay before it
 * takes anyone else's on board, so a crash mid-round loses nothing. It also
 * means the echo of your own push is already excluded from the pull that
 * follows it, rather than arriving a round later and being applied over your
 * newer local edits.
 */
export async function syncOnce(): Promise<RoundResult> {
  const result: RoundResult = { pushed: 0, pulled: 0, applied: 0, rejected: 0 }
  const device = deviceId()

  // A laptop that has never been set up is joining an existing installation
  // rather than starting one. Everything it holds is the starter catalog it
  // seeded for itself, under ids nobody else has ever seen — discard it and take
  // the shared version whole, instead of reconciling a hundred imaginary
  // conflicts between two copies of the same 122 boxes.
  if (isBlankJoiner()) {
    const removed = clearForJoin()
    if (removed > 0) {
      console.log(`Sync: joining an existing installation — cleared ${removed} placeholder rows.`)
    }
  } else if (syncStateGet('published_at') === null) {
    // First run on a machine that already has a business on it.
    //
    // The capture triggers only see changes made from now on, so without this
    // the relay would stay empty and everyone else would join to nothing —
    // clearing their own starter catalog on the way in and ending up with a
    // blank app. Somebody has to publish what already exists, once.
    //
    // Asking the relay first is what makes it safe to do automatically: only a
    // machine that finds the relay EMPTY publishes. The second machine to reach
    // this point sees rows already there, records that it looked, and just
    // syncs normally.
    const state = await call('/v1/state', { method: 'GET' })
    const rows = typeof state.rows === 'number' ? state.rows : 0
    if (rows === 0) {
      const queued = queueEverything(getDb())
      console.log(`Sync: relay is empty — publishing ${queued} records from this machine.`)
    }
    syncStateSet('published_at', new Date().toISOString())
  }

  // ---- push -------------------------------------------------------------
  phase = 'pushing'
  broadcast()
  for (;;) {
    const batch = takeOutbox(PUSH_BATCH)
    if (batch.length === 0) break
    const reply = await call('/v1/push', { method: 'POST', body: { device, rows: batch } })
    clearOutbox(batch)
    result.pushed += batch.length
    if (typeof reply.cursor === 'number') remoteCursor = reply.cursor
    syncStateSet('last_push_at', new Date().toISOString())
    if (batch.length < PUSH_BATCH) break
  }

  // ---- pull -------------------------------------------------------------
  phase = 'pulling'
  broadcast()
  const changedKinds = new Set<string>()
  const touchedSupplies = new Set<string>()
  const touchedProducts = new Set<string>()
  for (;;) {
    const since = cursor()
    const reply = await call(
      `/v1/pull?since=${since}&limit=${PULL_BATCH}&device=${encodeURIComponent(device)}`,
      { method: 'GET' }
    )
    const rows = (Array.isArray(reply.rows) ? reply.rows : []) as IncomingRow[]
    const nextCursor = typeof reply.cursor === 'number' ? reply.cursor : since

    if (rows.length > 0) {
      const applied = applyRows(rows)
      result.applied += applied.applied + applied.deleted
      result.rejected += applied.rejected
      result.pulled += rows.length
      for (const kind of applied.kinds) changedKinds.add(kind)
      for (const id of applied.touchedSupplies) touchedSupplies.add(id)
      for (const id of applied.touchedProducts) touchedProducts.add(id)
      if (applied.touchedProducts.length > 0) {
        // Quantities and average costs are recomputed from the lots that just
        // landed rather than trusted as they arrived — see rebuildDerivedStock.
        //
        // Done per batch AND again once the pull drains. Per batch so that a
        // pull interrupted half way through — a dropped connection on a first
        // sync of a whole catalog — still leaves every shelf it did manage to
        // fill reading correctly, rather than leaving lots with no quantity
        // beside them and a cursor already past the rows that would fix it.
        if (rebuildDerivedStock(applied.touchedProducts) > 0) {
          changedKinds.add('inventory_stock')
        }
      }
    }

    // Only advance after the rows are committed locally. A crash between the
    // apply and this line re-delivers the batch, which is harmless — every
    // apply is an upsert — whereas advancing first would lose it for good.
    if (nextCursor > since) setCursor(nextCursor)
    syncStateSet('last_pull_at', new Date().toISOString())
    if (reply.more !== true || nextCursor <= since) break
  }

  // ---- settle -----------------------------------------------------------
  //
  // Everything below runs ONCE, after the pull has fully drained, and the timing
  // is the point. Tier ordering holds inside a batch, not across them, so a
  // supply that arrived in one batch with its purchases still in the next has an
  // incomplete history until here. Rebuilding per batch would settle it on a
  // negative count and leave it there until the next completed pull.
  if (rejectCount() > 0) {
    // A quarantined row is a permanently wrong number once a count is derived
    // from rows, so give the rejects a chance to land before deriving anything
    // from them. Most are a child that beat its parent.
    //
    // Unconditional, and it did not used to be: this ran only when a SUPPLY had
    // been touched in the same round. A quarantined inventory LOT — the ordinary
    // case of a lot arriving before its product — therefore sat in the
    // quarantine untouched for as long as nobody happened to edit a supply, and
    // the cursor was already past the rows that would have retried it.
    const retry = retryRejects()
    if (retry.recovered > 0) changedKinds.add('supplies')
    for (const id of retry.touchedSupplies) touchedSupplies.add(id)
    // And what the replay landed is rebuilt with everything else below. Recovered
    // lots used to be dropped on the floor here: the rows were in the database
    // and the quantity beside them was not, which reads on screen as a shelf
    // holding nothing while its cost layers say otherwise.
    for (const id of retry.touchedProducts) touchedProducts.add(id)
  }
  if (touchedSupplies.size > 0) {
    if (rebuildDerivedSupplyStock([...touchedSupplies]) > 0) changedKinds.add('supplies')
  }
  if (touchedProducts.size > 0) {
    // Once more over everything the whole pull touched, not just the last batch.
    // Tier ordering holds inside a batch and not across them, so a product whose
    // lots arrived in one batch and whose own row arrived in the next was
    // rebuilt against half its layers; this is the pass that has all of them.
    if (rebuildDerivedStock([...touchedProducts]) > 0) changedKinds.add('inventory_stock')
  }
  if (changedKinds.has('ship_document_parts')) {
    // The packing slip, put back together from the slices that travelled.
    //
    // Here rather than per batch for the reason the whole settle block exists: a
    // twelve-slice document arrives across several batches, and eleven slices
    // assembled is a corrupt PDF that opens to a blank pane — which somebody
    // reads as "this order has nothing on it". rebuildShipDocument waits for all
    // of them and checks the length before writing anything.
    if (rebuildShipDocument() > 0) {
      changedKinds.add('ship_documents')
      console.log('Sync: the packing slip arrived from another machine.')
    }
  }
  if (changedKinds.has('order_document_parts')) {
    // The shipping labels, put back together the same way and for the same
    // reason. Without this the slices arrive, the file never does, and every
    // machine except the one that uploaded shows a label it can never open —
    // which is the exact failure the packing slip had before it was sliced.
    //
    // Worse here than there: an order's label is what gets EMAILED to whoever
    // is shipping the goods, and a send from a machine holding no bytes would
    // go out saying a label is attached when none is.
    if (rebuildOrderDocuments() > 0) {
      changedKinds.add('order_documents')
      console.log('Sync: a shipping label arrived from another machine.')
    }
  }

  lastPulledRows = result.applied
  announceChange([...changedKinds])
  return result
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  const config = getSyncConfig()
  if (!config.enabled || !config.url || !sharedKey()) {
    phase = config.enabled ? 'unconfigured' : 'off'
    schedule()
    return
  }
  if (running) return
  running = true
  try {
    await syncOnce()
    failures = 0
    phase = 'idle'
    syncStateSet('last_error', null)
  } catch (err) {
    failures += 1
    phase = 'error'
    syncStateSet('last_error', err instanceof Error ? err.message : String(err))
  } finally {
    running = false
    broadcast()
    schedule()
  }
}

function schedule(): void {
  if (timer) clearTimeout(timer)
  const config = getSyncConfig()
  const base = Math.max(MIN_INTERVAL_SECONDS, config.intervalSeconds) * 1000
  // Back off after failures so a relay that is down is not hammered, and so the
  // log does not fill with the same error four times a second.
  const delay = base * Math.min(2 ** failures, MAX_BACKOFF)
  timer = setTimeout(() => void tick(), delay)
  timer.unref?.()
}

function restart(): void {
  if (timer) clearTimeout(timer)
  timer = null
  const config = getSyncConfig()
  if (!config.enabled) {
    phase = 'off'
    broadcast()
    return
  }
  phase = 'idle'
  timer = setTimeout(() => void tick(), 250)
  timer.unref?.()
  broadcast()
}

/** Start the loop at boot. Does nothing at all when sync is switched off. */
export function initCloudSync(): void {
  deviceId()
  if (!syncStateGet('device')) syncStateSet('device', defaultDeviceName())
  restart()
}

export function stopCloudSync(): void {
  if (timer) clearTimeout(timer)
  timer = null
  phase = 'off'
}

/** "Sync now" — runs a round immediately and reports what happened. */
export async function syncNow(): Promise<{ ok: boolean; error?: string; result?: RoundResult }> {
  const config = getSyncConfig()
  if (!config.url || !sharedKey()) return { ok: false, error: 'Set the relay address and key first.' }
  if (running) return { ok: false, error: 'A sync is already running.' }
  running = true
  try {
    const result = await syncOnce()
    failures = 0
    phase = 'idle'
    syncStateSet('last_error', null)
    return { ok: true, result }
  } catch (err) {
    failures += 1
    phase = 'error'
    const message = err instanceof Error ? err.message : String(err)
    syncStateSet('last_error', message)
    return { ok: false, error: message }
  } finally {
    running = false
    broadcast()
    schedule()
  }
}

/** Check the address and key without changing anything. */
export async function testConnection(): Promise<{ ok: boolean; error?: string; rows?: number }> {
  try {
    const reply = await call('/v1/state', { method: 'GET' })
    remoteRows = typeof reply.rows === 'number' ? reply.rows : null
    remoteCursor = typeof reply.cursor === 'number' ? reply.cursor : null
    return { ok: true, rows: remoteRows ?? 0 }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Seed the relay from this laptop.
 *
 * Run once, on the machine holding the real data. Triggers only see changes
 * made from now on, so without this the relay would start empty and everyone
 * else would receive nothing but future edits — the catalog, the stock and the
 * history would stay on one machine.
 */
export function seedRelay(): { queued: number } {
  return { queued: queueEverything(getDb()) }
}
