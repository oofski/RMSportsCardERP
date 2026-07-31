import { BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import type { SyncConfig, SyncConfigView, SyncStatus, SyncPhase } from '@shared/sync'
import { getDb } from '../db/database'
import { queueEverything } from '../db/syncTriggers'
import {
  applyRows,
  clearForJoin,
  clearOutbox,
  cursor,
  deviceId,
  isBlankJoiner,
  pendingCount,
  rebuildDerivedStock,
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

export function getSyncConfig(): SyncConfig {
  return {
    url: (syncStateGet('url') ?? '').trim(),
    device: (syncStateGet('device') ?? '').trim() || defaultDeviceName(),
    intervalSeconds: Number(syncStateGet('interval') ?? DEFAULT_INTERVAL_SECONDS) || DEFAULT_INTERVAL_SECONDS,
    enabled: syncStateGet('enabled') === '1'
  }
}

function sharedKey(): string {
  return syncStateGet('key') ?? ''
}

function defaultDeviceName(): string {
  return `${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'This computer'}`
}

export function syncConfigView(): SyncConfigView {
  const config = getSyncConfig()
  const key = sharedKey()
  return { ...config, keySet: key.length > 0, keyHint: key ? key.slice(-4) : '' }
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

async function call(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown }
): Promise<Record<string, unknown>> {
  const config = getSyncConfig()
  const key = sharedKey()
  if (!config.url || !key) throw new Error('Sync is not configured.')

  const controller = new AbortController()
  // Long enough for a big first push over a bad connection, short enough that a
  // dead relay does not hold the loop open indefinitely.
  const timeout = setTimeout(() => controller.abort(), 30_000)
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
      if (applied.touchedProducts.length > 0) {
        // Quantities and average costs are recomputed from the lots that just
        // landed rather than trusted as they arrived — see rebuildDerivedStock.
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
