/**
 * Which tables travel between laptops, and how a row in each is identified.
 *
 * This list is the contract. A table that is not here is private to the machine
 * it is on; a table that IS here has every insert, update and delete captured by
 * a trigger and carried to everyone else. Adding a table later means adding a
 * line here — the triggers, the push, the pull and the apply all read from this
 * one manifest, so there is no second place to remember.
 */

export interface SyncedTable {
  /** The SQLite table name. Doubles as the record's "kind" on the wire. */
  table: string
  /**
   * Column(s) that identify a record. Almost everything is a UUID `id`; the
   * handful of exceptions are natural keys that predate the sync work.
   */
  key: string[]
  /**
   * Apply order. Parents before children, so the row-by-row recovery path
   * (which cannot defer foreign keys) still lands most rows. Inside a healthy
   * batch this does not matter — the whole batch commits at once with foreign
   * keys deferred — but recovery is exactly when ordering earns its keep.
   */
  tier: number
}

/**
 * Deliberately NOT synced:
 *
 *   meta                     Holds schema_version. Two laptops on different app
 *                            versions must never overwrite each other's idea of
 *                            what the schema is; that is how you corrupt every
 *                            database at once.
 *   server_sessions          Login tokens for the optional LAN server. Machine-
 *                            local by definition.
 *   inventory_product_images Rows point at image FILES in this machine's app
 *                            data folder. Syncing the row without the bytes
 *                            produces a broken thumbnail on every other laptop,
 *                            which is worse than no thumbnail. Needs object
 *                            storage (R2) before it can travel.
 *   inventory_stock          On-hand quantity is DERIVED — the app already
 *                            enforces quantity == Σ(lot remainders) for every
 *                            (product, location). Shipping it as a row would
 *                            make last-write-wins arbitrate a number, so two
 *                            people receiving the same product in the same
 *                            minute would lose one of the receipts silently.
 *                            The lots travel instead (they are per-receipt rows
 *                            with their own ids, which never collide) and the
 *                            quantity is recomputed from them after every pull.
 *                            See rebuildDerivedStock() in sync.ts.
 *   ship_documents           The uploaded packing-slip PDF, verbatim. A megabyte
 *                            of BLOB does not belong in a row-at-a-time relay
 *                            that batches whole rows into one JSON body. The
 *                            parsed dataset — every card, every break, every
 *                            address, which is what the work is actually done
 *                            against — syncs as normal, so a laptop without the
 *                            document loses the paper, not the job. Needs
 *                            object storage (R2) before it can travel.
 *   sync_*                   The plumbing itself.
 */
export const SYNCED_TABLES: SyncedTable[] = [
  // Tier 0 — roots nothing else points at, or that everything points at.
  // KNOWN LIMIT — `supplies.quantity` is a COUNT arbitrated by last-write-wins.
  //
  // Two laptops ticking the same checklist step converge correctly (the usage
  // rows carry derived ids and absolute quantities, so they merge into one). But
  // an unrelated edit to the same supply made offline — a rename, a reorder
  // point — carries that machine's stale `quantity` along with it and can land
  // on top of a deduction, putting the stock back.
  //
  // inventory_stock solves this by not travelling at all and being rebuilt from
  // its lots. The equivalent here is to apply each incoming movement's delta
  // once on first sight, making the number a counter rather than a value. See
  // the note on ApplyResult.touchedSupplies in sync.ts for why the obvious
  // shortcut — recomputing from supply_transactions after a pull — is worse than
  // the problem it fixes.
  { table: 'employees', key: ['id'], tier: 0 },
  { table: 'audit_log', key: ['id'], tier: 0 },
  { table: 'inventory_products', key: ['id'], tier: 0 },
  { table: 'supplies', key: ['id'], tier: 0 },
  { table: 'ship_event', key: ['id'], tier: 0 },
  { table: 'ship_breaks', key: ['id'], tier: 0 },
  { table: 'ship_customers', key: ['id'], tier: 0 },
  { table: 'ship_settings', key: ['key'], tier: 0 },
  { table: 'ship_batch_urls', key: ['batch_number'], tier: 0 },
  { table: 'ship_break_audit', key: ['break_label'], tier: 0 },
  { table: 'ship_imports', key: ['id'], tier: 0 },
  { table: 'ship_snapshots', key: ['id'], tier: 0 },
  // Both carry DERIVED ids ('date|step', 'date|step|role') and ABSOLUTE
  // quantities, so two benches ticking the same step off the same show land on
  // one row holding one number rather than two rows holding the night twice.
  { table: 'ship_sop_steps', key: ['id'], tier: 0 },
  { table: 'ship_supply_usage', key: ['id'], tier: 0 },
  { table: 'ledger_imports', key: ['id'], tier: 0 },
  { table: 'stream_sessions', key: ['id'], tier: 0 },
  { table: 'purchase_orders', key: ['id'], tier: 0 },
  { table: 'inventory_resets', key: ['id'], tier: 0 },
  { table: 'qbo_sync_log', key: ['id'], tier: 0 },
  { table: 'intake_links', key: ['id'], tier: 0 },

  // Tier 1 — children of a tier-0 row.
  { table: 'time_entries', key: ['id'], tier: 1 },
  { table: 'inventory_transactions', key: ['id'], tier: 1 },
  { table: 'inventory_incoming', key: ['id'], tier: 1 },
  { table: 'inventory_lots', key: ['id'], tier: 1 },
  { table: 'inventory_scans', key: ['id'], tier: 1 },
  { table: 'purchase_order_lines', key: ['id'], tier: 1 },
  { table: 'supply_transactions', key: ['id'], tier: 1 },
  { table: 'supply_orders', key: ['id'], tier: 1 },
  { table: 'finance_cogs', key: ['id'], tier: 1 },
  { table: 'ship_team_slots', key: ['id'], tier: 1 },
  { table: 'ship_shipments', key: ['id'], tier: 1 },
  { table: 'ship_orders', key: ['id'], tier: 1 },
  { table: 'ship_warnings', key: ['id'], tier: 1 },
  { table: 'ship_break_assignments', key: ['id'], tier: 1 },
  // Every column is written by exactly ONE device — the station that created
  // the row — so last-write-wins arbitrates nothing here: the relay only ever
  // compares a row against an older copy of itself from the same writer. The
  // contended answer ("who has this order") is DERIVED from the row set, the
  // way inventory_stock is derived from its lots.
  { table: 'ship_work_claims', key: ['id'], tier: 1 },
  { table: 'ledger_rows', key: ['id'], tier: 1 },
  { table: 'ledger_quarantine', key: ['id'], tier: 1 },
  { table: 'stream_items', key: ['id'], tier: 1 },
  { table: 'intake_submissions', key: ['id'], tier: 1 },

  // Tier 2 — children of a tier-1 row.
  { table: 'po_line_receipts', key: ['id'], tier: 2 },
  { table: 'stream_item_lots', key: ['id'], tier: 2 },
  { table: 'ledger_row_imports', key: ['row_id', 'import_id'], tier: 2 }
]

/** Lookup by table name. */
export const SYNCED_BY_TABLE = new Map(SYNCED_TABLES.map((t) => [t.table, t]))

/** Separator for composite keys on the wire. Keys are UUIDs, so it is safe. */
export const KEY_SEP = '|'

/** The single string that identifies a record of this kind on the wire. */
export function joinKey(values: Array<string | number>): string {
  return values.map((v) => String(v)).join(KEY_SEP)
}

/** SQL expression producing that same string inside a trigger. */
export function keyExpr(spec: SyncedTable, alias: 'NEW' | 'OLD'): string {
  const parts = spec.key.map((col) => `CAST(${alias}.${col} AS TEXT)`)
  return parts.length === 1 ? parts[0] : parts.join(` || '${KEY_SEP}' || `)
}
