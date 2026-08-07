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
 *   ship_documents           The uploaded packing-slip PDF, verbatim — a single
 *                            row holding several megabytes of BLOB, which is not
 *                            a shape a row-at-a-time relay can carry.
 *
 *                            It travels anyway, as ship_document_parts: the same
 *                            file cut into 512 KB slices, each an ordinary synced
 *                            row with its own id, reassembled by the receiver
 *                            once every slice is present. So this table is
 *                            DERIVED on every machine but the one that uploaded
 *                            — the same arrangement as inventory_stock and for
 *                            the same reason. See rebuildShipDocument().
 *
 *                            The claim that used to sit here — "a laptop without
 *                            the document loses the paper, not the job" — was
 *                            wrong about the job. The slip IS the job: it is what
 *                            a packer checks the box against, and everybody
 *                            except the person who imported it saw "No slip on
 *                            this machine".
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
  // The packing slip itself, in slices. Tier 0 because a slice points at nothing
  // — it carries its own document's metadata precisely so it does not have to
  // wait for a parent row, and a set of slices is complete or it is not.
  { table: 'ship_document_parts', key: ['id'], tier: 0 },
  { table: 'ship_snapshots', key: ['id'], tier: 0 },
  // `ship_sop_steps` and `ship_supply_usage` are deliberately ABSENT, and their
  // tables are deliberately still in the schema. The checklist that wrote them
  // is gone, so nothing reads or writes them any more — but dropping a table on
  // somebody's machine cannot be undone, and syncing one nothing reads is
  // bandwidth spent carrying a dead night around forever.
  { table: 'ledger_imports', key: ['id'], tier: 0 },
  // Synced, and it has to be. The commission rate is what turns the net figure
  // Whatnot pays into the gross a P&L reports, so a laptop without a period the
  // owner entered would show a DIFFERENT profit for the same show off the same
  // rows — with nothing on either screen to say which one was right. It is
  // operator-authored, one row per range, keyed by a UUID nobody else mints, and
  // it changes about once a year; last-write-wins arbitrates only edits to the
  // same range, which is exactly what it is good at. Overlap is refused on
  // write, and the write is local, so a pull can in principle land a range that
  // overlaps one made offline here — the reader takes the first match in date
  // order, and the rates screen shows both, which is the state somebody has to
  // resolve rather than one the app should silently pick a winner for.
  { table: 'whatnot_fee_periods', key: ['id'], tier: 0 },
  // Synced, on the same argument that put the rate periods above it here: it
  // changes the reported bottom line of a day. A laptop missing an entry the
  // owner typed would show a HIGHER net profit for that night than the machine he
  // typed it on, with nothing on either screen to say which was right — and this
  // is the one figure in the P&L that no re-import can reconstruct, because it
  // exists nowhere but in the row somebody wrote.
  //
  // It arbitrates cleanly. Each entry is a whole authored fact under a UUID
  // nobody else mints, so last-write-wins only ever compares an entry against an
  // older copy of ITSELF — there is no shared counter, no derived quantity and
  // nothing another machine can be concurrently adding to. Tier 0: it points at
  // nothing (its day is a date string, not a session id) and nothing points at it.
  { table: 'finance_expenses', key: ['id'], tier: 0 },
  { table: 'stream_sessions', key: ['id'], tier: 0 },
  { table: 'purchase_orders', key: ['id'], tier: 0 },
  { table: 'inventory_resets', key: ['id'], tier: 0 },
  { table: 'qbo_sync_log', key: ['id'], tier: 0 },
  { table: 'intake_links', key: ['id'], tier: 0 },
  // The owner's inbox, and it had to start travelling. Every reminder is a note
  // somebody on the floor wrote FOR HIM — and until now it stayed on the machine
  // it was typed on, so a packer sending "we are out of team bags" from the
  // bench was writing into a box the owner's laptop could not see. A message
  // that does not arrive is worse than no message box at all.
  //
  // Last-write-wins arbitrates nothing dangerous here: a reminder is a whole
  // authored fact under a UUID nobody else mints, and the only field two people
  // can move is `status`, where the later write — somebody marked it done — is
  // exactly the answer wanted.
  { table: 'reminders', key: ['id'], tier: 0 },

  // Tier 1 — children of a tier-0 row.
  // One person's own checklist. Tier 1: it belongs to an employee.
  //
  // Safe under last-write-wins by construction — each row has exactly one author
  // and one reader, so the relay only ever compares a row against an older copy
  // of ITSELF from the same person's other machine. That is also what makes it
  // worth syncing at all: a list that only exists on the laptop it was typed on
  // is a list somebody keeps twice.
  { table: 'todos', key: ['id'], tier: 1 },
  // A repeating job, and the record of which occurrence was last ticked. Safe
  // under last-write-wins for the same reason a to-do is — one author, one
  // reader — and it has to travel, or ticking payroll off on the laptop would
  // leave it still asking on the web app.
  { table: 'recurring_tasks', key: ['id'], tier: 1 },
  // The rota. It has to travel, and for a blunter reason than most rows here: a
  // shift is written on the lead's machine and read on the packer's, so a rota
  // that stayed where it was typed would be a rota the people working it cannot
  // see. Last-write-wins is the right arbiter — a shift is a whole authored fact
  // under a UUID nobody else mints, and two leads editing the same one are
  // making the same kind of correction, where the later word is the one wanted.
  { table: 'shifts', key: ['id'], tier: 1 },
  // What somebody said about a day before anybody was put on it. It travels for
  // the mirror-image reason the rota does: availability is written by the
  // packer and read by the lead building next week, so one that stayed on the
  // phone it was typed on would be a message nobody receives.
  //
  // The id is DERIVED from the person and the day rather than minted, which is
  // what makes last-write-wins the right arbiter here rather than a coin toss:
  // two machines recording the same person's answer for the same day produce
  // the same row, so the later answer wins — exactly what somebody changing
  // their mind means. A UUID would leave two rows saying opposite things.
  { table: 'availability', key: ['id'], tier: 1 },
  // The usual week behind those answers. Seven rows per person, derived ids for
  // the same reason, and it travels for the same reason: set on a phone at the
  // bench, read on the laptop where next week gets built.
  { table: 'availability_pattern', key: ['id'], tier: 1 },
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
