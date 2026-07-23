import type Database from 'better-sqlite3'
import type { CogsEntry } from '@shared/types'
import { getDb } from './database'
import { newId, nowIso } from '../util'

interface CogsRow {
  id: string
  po_id: string
  po_number: string
  amount: number
  occurred_at: string
  note: string | null
  created_at: string
}

function toCogs(r: CogsRow): CogsEntry {
  return {
    id: r.id,
    poId: r.po_id,
    poNumber: r.po_number,
    amount: r.amount,
    occurredAt: r.occurred_at,
    note: r.note,
    createdAt: r.created_at
  }
}

/** Record a COGS ledger entry for a purchase. Takes the active db so it nests
 * inside the createPurchaseOrder transaction (atomic with the PO insert). */
export function recordPoCogs(
  db: Database.Database,
  args: { poId: string; poNumber: string; amount: number; occurredAt: string; note: string | null }
): void {
  db.prepare(
    `INSERT INTO finance_cogs (id, po_id, po_number, amount, occurred_at, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(newId(), args.poId, args.poNumber, args.amount, args.occurredAt, args.note, nowIso())
}

/** Void (delete) a PO's COGS entry — called on cancel. Takes the active db so it
 * nests inside the setPurchaseOrderStatus transaction. */
export function voidPoCogs(db: Database.Database, poId: string): void {
  db.prepare('DELETE FROM finance_cogs WHERE po_id = ?').run(poId)
}

export function listCogsEntries(): CogsEntry[] {
  return (
    getDb()
      .prepare(
        `SELECT id, po_id, po_number, amount, occurred_at, note, created_at
         FROM finance_cogs
         ORDER BY occurred_at DESC, created_at DESC`
      )
      .all() as CogsRow[]
  ).map(toCogs)
}
