/**
 * The QuickBooks sync log.
 *
 * Nothing here talks to Intuit — this module only records what was sent and
 * what came back, which is the part that has to be durable. The rule the whole
 * design rests on:
 *
 *   WRITE THE INTENT BEFORE THE CALL, THE RESULT AFTER IT.
 *
 * A crash between those two leaves a 'pending' row, which reads as "we may or
 * may not have created this in QuickBooks — check before retrying". That is an
 * honest state. The alternative (record only on success) loses a bill that was
 * created seconds before a power cut and then creates it again on the next run,
 * and QuickBooks has no bulk undo to clean that up with.
 */
import type Database from 'better-sqlite3'
import { createHash } from 'crypto'
import type { QboSyncEntity, QboSyncRow, QboSyncStatus } from '@shared/quickbooks'
import { newId, nowIso } from '../util'

interface Row {
  id: string
  entity: string
  local_id: string
  realm_id: string
  qbo_type: string
  qbo_id: string | null
  doc_number: string | null
  amount: number
  status: string
  error: string | null
  payload_hash: string | null
  created_at: string
  updated_at: string
  synced_at: string | null
}

function toRow(r: Row): QboSyncRow {
  return {
    id: r.id,
    entity: r.entity as QboSyncEntity,
    localId: r.local_id,
    realmId: r.realm_id,
    qboType: r.qbo_type,
    qboId: r.qbo_id,
    docNumber: r.doc_number,
    amount: r.amount,
    status: r.status as QboSyncStatus,
    error: r.error,
    payloadHash: r.payload_hash,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    syncedAt: r.synced_at
  }
}

/**
 * Stable hash of what we are about to send.
 *
 * JSON.stringify key order follows insertion order, so two structurally equal
 * payloads built by different code paths could hash differently. Sorting keys
 * makes the hash depend on the DATA rather than on how it was assembled —
 * otherwise a harmless refactor would look like every record changed and
 * re-push the entire ledger.
 */
export function payloadHash(payload: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, canonical(v)])
      )
    }
    return value
  }
  return createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex')
}

export function getSyncRow(
  db: Database.Database,
  realmId: string,
  entity: QboSyncEntity,
  localId: string
): QboSyncRow | null {
  const row = db
    .prepare('SELECT * FROM qbo_sync_log WHERE realm_id = ? AND entity = ? AND local_id = ?')
    .get(realmId, entity, localId) as Row | undefined
  return row ? toRow(row) : null
}

export function listSyncRows(db: Database.Database, realmId: string, limit = 200): QboSyncRow[] {
  const rows = db
    .prepare('SELECT * FROM qbo_sync_log WHERE realm_id = ? ORDER BY updated_at DESC LIMIT ?')
    .all(realmId, limit) as Row[]
  return rows.map(toRow)
}

export interface SyncDecision {
  /** Whether this record needs sending at all. */
  action: 'create' | 'update' | 'skip'
  /** The existing log row, if this record has been seen before. */
  existing: QboSyncRow | null
  reason: string
}

/**
 * Decide what to do with one record, given what the log already knows.
 *
 * 'pending' is deliberately NOT auto-retried as a create. A pending row means a
 * previous run wrote its intent and never recorded an outcome, so the record
 * may already exist in QuickBooks under an id we never learned. Re-creating it
 * is the one genuinely destructive mistake available here, so it is escalated
 * to a human instead.
 */
export function decideSync(existing: QboSyncRow | null, hash: string): SyncDecision {
  if (!existing) return { action: 'create', existing: null, reason: 'Not sent yet.' }

  if (existing.status === 'pending') {
    return {
      action: 'skip',
      existing,
      reason:
        'A previous attempt was interrupted before QuickBooks confirmed it. Check QuickBooks for this record before retrying.'
    }
  }

  if (existing.status === 'failed') {
    return { action: 'create', existing, reason: 'The last attempt failed; sending again.' }
  }

  // status === 'synced'
  if (existing.payloadHash === hash) {
    return { action: 'skip', existing, reason: 'Already in QuickBooks and unchanged.' }
  }
  return { action: 'update', existing, reason: 'Changed since it was last sent.' }
}

export interface BeginSyncInput {
  realmId: string
  entity: QboSyncEntity
  localId: string
  qboType: string
  amount: number
  payloadHash: string
}

/**
 * Record the intent to send. Call this BEFORE the network request, and always
 * within the caller's transaction so intent and any local side effects commit
 * together.
 *
 * Upserts, because a retry of a failed record reuses its row rather than
 * stacking a second one — the unique index on (realm, entity, local) is what
 * guarantees a record can only ever have one relationship with one company.
 */
export function beginSync(db: Database.Database, input: BeginSyncInput): string {
  const ts = nowIso()
  const existing = getSyncRow(db, input.realmId, input.entity, input.localId)
  if (existing) {
    db.prepare(
      `UPDATE qbo_sync_log
          SET qbo_type = ?, amount = ?, payload_hash = ?, status = 'pending',
              error = NULL, updated_at = ?
        WHERE id = ?`
    ).run(input.qboType, input.amount, input.payloadHash, ts, existing.id)
    return existing.id
  }
  const id = newId()
  db.prepare(
    `INSERT INTO qbo_sync_log
       (id, entity, local_id, realm_id, qbo_type, qbo_id, doc_number, amount,
        status, error, payload_hash, created_at, updated_at, synced_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 'pending', NULL, ?, ?, ?, NULL)`
  ).run(
    id,
    input.entity,
    input.localId,
    input.realmId,
    input.qboType,
    input.amount,
    input.payloadHash,
    ts,
    ts
  )
  return id
}

/** Record that QuickBooks accepted it, and under which id. */
export function completeSync(
  db: Database.Database,
  logId: string,
  qboId: string,
  docNumber: string | null
): void {
  const ts = nowIso()
  db.prepare(
    `UPDATE qbo_sync_log
        SET status = 'synced', qbo_id = ?, doc_number = ?, error = NULL,
            updated_at = ?, synced_at = ?
      WHERE id = ?`
  ).run(qboId, docNumber, ts, ts, logId)
}

/**
 * Record that it did not work. The message is kept verbatim — Intuit's faults
 * are specific ("Business Validation Error: ...") and paraphrasing them makes
 * the difference between a fixable problem and a mystery.
 */
export function failSync(db: Database.Database, logId: string, error: string): void {
  const ts = nowIso()
  db.prepare(
    `UPDATE qbo_sync_log SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`
  ).run(error.slice(0, 2000), ts, logId)
}

/**
 * Forget everything recorded for one company.
 *
 * Scoped to a realm rather than truncating the table: disconnecting sandbox
 * must not erase the record of what was pushed to production. Note this only
 * clears the LOCAL memory — anything already created in QuickBooks stays there
 * and would be re-created on the next sync, which is why the UI has to say so.
 */
export function clearSyncLog(db: Database.Database, realmId: string): number {
  return db.prepare('DELETE FROM qbo_sync_log WHERE realm_id = ?').run(realmId).changes
}
