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
  /**
   * BY break_id, WHICH IS THE PRIMARY KEY — and it was by break_label, which is
   * not a key at all.
   *
   * The upsert is built as ON CONFLICT (<these columns>), so a key that names no
   * PRIMARY KEY and no UNIQUE index is not a merge that picks the wrong winner:
   * it is SQL SQLite refuses to run. Every row of this table was rejected on
   * arrival, in the batch and again on the row-by-row retry, and landed in
   * sync_rejects under "usually the same thing created twice" — which is exactly
   * what it was not.
   *
   * break_id is safe to merge on for the same reason ship_breaks is: it IS
   * ship_breaks.id, which already travels under that id, and it comes off the
   * parsed slip rather than being minted per machine. Both writers here key on
   * it, and the audit is one row per break.
   */
  { table: 'ship_break_audit', key: ['break_id'], tier: 0 },
  { table: 'ship_imports', key: ['id'], tier: 0 },
  // The packing slip itself, in slices. Tier 0 because a slice points at nothing
  // — it carries its own document's metadata precisely so it does not have to
  // wait for a parent row, and a set of slices is complete or it is not.
  { table: 'ship_document_parts', key: ['id'], tier: 0 },
  { table: 'ship_snapshots', key: ['id'], tier: 0 },
  // The floor's work log. It HAS to travel: the bench, the picking station and
  // the packing station are different machines, so a performance figure built
  // from one laptop's rows would report whoever happened to be standing at it.
  //
  // Tier 0 although it names breaks and shipments, because it is designed to
  // OUTLIVE both — break_id and break_label are denormalised onto the row for
  // exactly that reason, and a row that waited for a parent that was deleted
  // three shows ago would never land at all.
  //
  // Last-write-wins arbitrates cleanly: the id is derived from the step and its
  // subject, so two machines that saw the same tick write the same row and the
  // relay only ever compares it against an older copy of itself. There is no
  // counter here and nothing another machine adds to concurrently.
  { table: 'ship_work_log', key: ['id'], tier: 0 },
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
  // What the platform said a window sold. Synced because it is the evidence a
  // derived revenue figure is checked against, and a check only one machine can
  // see is one the others quietly go without.
  { table: 'whatnot_statements', key: ['id'], tier: 0 },
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
  // A show that has not happened yet, and the only table on this list that has
  // to travel for a reason OUTSIDE the app: the relay cannot remind anybody
  // about a stream it has never seen. Everything else here syncs so that ten
  // laptops agree; this one syncs so that a Cloudflare cron has something to
  // read at ten to nine on a Friday.
  //
  // It also has to travel for the ordinary reason. A plan typed on the office
  // laptop is read by the person who has to be at the desk for it, and a plan
  // that stays where it was typed is a plan nobody else knows about.
  //
  // Last-write-wins arbitrates cleanly: a plan is a whole authored fact under a
  // UUID nobody else mints, so the relay only ever compares it against an older
  // copy of itself. There is no counter and nothing another machine adds to.
  // Tier 0 — it names an employee and a session, and both are allowed to dangle
  // (see the migration note), so it must never wait for either.
  { table: 'stream_schedule', key: ['id'], tier: 0 },
  { table: 'purchase_orders', key: ['id'], tier: 0 },
  { table: 'inventory_resets', key: ['id'], tier: 0 },
  // WHERE STOCK CAN SIT. Tier 0 and it must travel: the shelf test reads this
  // set, so a Roadshow shop added at the office and absent on the bench laptop
  // would make the same sales order draw stock on one machine and read as a
  // dropship on the other.
  //
  // The id is the NAME, so two people adding the same shop write the same row
  // and last-write-wins compares it against a copy of itself — the same
  // reasoning order_party_pins gives.
  { table: 'stock_locations', key: ['id'], tier: 0 },
  // WHAT HAPPENED TO AN ORDER — who moved it, when, and from what to what.
  //
  // Tier 0 although every row names a purchase order or a sales order, for the
  // same reason ship_work_log is: it is designed to OUTLIVE its subject. The
  // actor's NAME is denormalised onto the row precisely so the log still reads
  // after the person has left, and a row that waited for a parent somebody
  // deleted last month would never land at all.
  //
  // Last-write-wins is trivially safe here: an event is an immutable record of
  // a moment under a UUID nobody else mints, so the relay only ever compares a
  // row against an older copy of itself. Nothing edits one and nothing counts.
  { table: 'order_events', key: ['id'], tier: 0 },
  // The parcels an order ships in. Tier 1: an order has to land first, because
  // a shipment with no order to hang off is a tracking number for nothing.
  { table: 'order_shipments', key: ['id'], tier: 1 },
  // A shipping label, in slices that travel — the same arrangement as
  // ship_document_parts and for exactly the same reason. Tier 0 because a slice
  // points at nothing: it carries its own document's metadata so it never waits
  // on a parent, and a set of slices is complete or it is not.
  //
  // `order_documents` — the whole-file row — is deliberately absent. It holds
  // the bytes verbatim and is rebuilt from these on every machine but the one
  // that uploaded. See rebuildOrderDocuments().
  { table: 'order_document_parts', key: ['id'], tier: 0 },
  // Buyers. Operator-authored whole facts under UUIDs nobody else mints, and
  // they have to travel: an invoice raised on the office laptop for a buyer
  // added at the bench would otherwise have nobody to address it to.
  { table: 'invoice_customers', key: ['id'], tier: 0 },
  // The operator's favourite destinations, beside the directory they are drawn
  // from. Tier 0: a pin points at nothing — it is a NAME, deliberately, so a pin
  // survives the contact record being renamed or retired.
  //
  // The id is DERIVED from the lower-cased name rather than minted, which is
  // what makes last-write-wins the right arbiter here rather than a coin toss:
  // two laptops pinning the same shop write the same row, so the relay only ever
  // compares it against an older copy of itself. A UUID would leave two rows and
  // a picker showing the shop twice. Same reasoning as availability below.
  { table: 'order_party_pins', key: ['id'], tier: 0 },
  // The invoice itself. Tier 0 because its customer id is allowed to dangle by
  // design — the buyer's name is snapshotted onto the row, so an invoice whose
  // customer record is gone still reads correctly and must still apply.
  { table: 'invoices', key: ['id'], tier: 0 },
  // THE DEAL TICKET REGISTER. One number per commercial movement, across both
  // sides of the business.
  //
  // Tier 0 despite naming a purchase order or an invoice, and for the strongest
  // form of the reason order_events gives: a ticket is DESIGNED to outlive its
  // document. Everything a reader needs — the number, the party, the amount, the
  // kind — is snapshotted onto the row, so a ticket whose order was deleted is
  // still a correct register entry. Waiting for a parent that is never coming
  // would silently drop numbers out of a sequence whose whole value is that it
  // has none missing.
  //
  // The `number` column is UNIQUE and it is a LABEL, so two machines trading
  // offline WILL mint the same one. That is settled by RELABEL_ON_CONFLICT in
  // sync.ts exactly as purchase_orders is — never by NATURAL_KEYS, because two
  // tickets carrying DT-000412 are two different deals and de-duplicating them
  // would delete one.
  { table: 'deal_tickets', key: ['id'], tier: 0 },
  // Messages. The thread is tier 0 because everything else points at it; the
  // participants and the messages are tier 1 so they land after it in the same
  // batch. The MESSAGE is the record — the push notification is only the buzz
  // that says to come and look, and a phone that was off must not cost somebody
  // a conversation.
  { table: 'message_threads', key: ['id'], tier: 0 },
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
  { table: 'message_participants', key: ['id'], tier: 1 },
  { table: 'messages', key: ['id'], tier: 1 },
  { table: 'purchase_order_lines', key: ['id'], tier: 1 },
  // Money on an order that bought no goods — see PurchaseOrderAdjustment. It
  // travels for the same reason a line does: it changes the order's total, and
  // a machine holding the lines without the credits would price the same
  // purchase differently from the one beside it. Tier 1 puts it after the
  // purchase_orders header it points at.
  { table: 'purchase_order_adjustments', key: ['id'], tier: 1 },
  { table: 'purchase_order_payments', key: ['id'], tier: 1 },
  { table: 'supply_transactions', key: ['id'], tier: 1 },
  { table: 'supply_orders', key: ['id'], tier: 1 },
  { table: 'finance_cogs', key: ['id'], tier: 1 },
  { table: 'ship_team_slots', key: ['id'], tier: 1 },
  { table: 'ship_shipments', key: ['id'], tier: 1 },
  { table: 'ship_orders', key: ['id'], tier: 1 },
  { table: 'ship_warnings', key: ['id'], tier: 1 },
  { table: 'ship_break_assignments', key: ['id'], tier: 1 },
  // The bag tick for teams nobody bought — the half of step 3 that has no card
  // row to live on. Tier 1: it points at a break, and a bag for a break that has
  // not landed yet would be a tick against nothing.
  //
  // It arbitrates cleanly BECAUSE its id is derived from the break and the team
  // rather than minted. Two benches bagging the same team write the same row, so
  // last-write-wins only ever compares that row against an older copy of itself
  // — there is no counter and nothing another machine adds to concurrently.
  { table: 'ship_break_team_bags', key: ['id'], tier: 1 },
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
  // Stock that is ours and is somewhere else. Tier 1 beside stream_items
  // because it is the same shape and the same parent: a product. Its lot slices
  // are tier 2 below.
  { table: 'consignments', key: ['id'], tier: 1 },
  // Who is on a show. Tier 1 rather than 2 despite naming a session, because it
  // also names an EMPLOYEE — and the recovery path applies rows one at a time,
  // so a crew row must be able to land whichever of the two arrived first. The
  // UNIQUE on (session_id, employee_id) is what makes a re-apply idempotent.
  { table: 'stream_session_hosts', key: ['id'], tier: 1 },

  // Tier 2 — children of a tier-1 row.
  // Which cost layers a consignment took, so a case that comes back goes into
  // the exact layers it left at the exact price. Without these a return would
  // be re-costed at today's average and quietly rewrite a shelf's basis.
  { table: 'consignment_lots', key: ['id'], tier: 2 },
  { table: 'po_line_receipts', key: ['id'], tier: 2 },
  // Where each slice of a purchase-order line is going. Tier 2 beside the
  // receipts, and for the same reason: it names a LINE, and an allocation
  // arriving before the line it splits would be a routing attached to nothing.
  //
  // po_unit_destinations is deliberately NOT here and must never be: it is a
  // VIEW, created by the migration on every machine, so it is schema rather than
  // data. Syncing a view's rows would carry a machine's own derivation to
  // everyone else and let last-write-wins arbitrate a computed answer.
  { table: 'purchase_order_allocations', key: ['id'], tier: 2 },
  // Invoice lines. Tier 2 so they land after the invoice they belong to on the
  // row-at-a-time recovery path.
  { table: 'invoice_lines', key: ['id'], tier: 2 },
  // Where each slice of a sales-order line comes FROM. Tier 3, one below the
  // line it splits, for the same reason order_shipment_lines is: a routing that
  // landed before its line would be attached to nothing on the recovery path.
  //
  // invoice_unit_sources is deliberately NOT here and must never be: it is a
  // VIEW, created by the migration on every machine, so it is schema rather than
  // data — the same rule po_unit_destinations keeps above.
  { table: 'invoice_line_allocations', key: ['id'], tier: 3 },
  // Which purchases supplied a sale. Tier 3: it names an INVOICE and a PURCHASE
  // ORDER, both tier 1, and the recovery path applies rows one at a time — so it
  // has to land after whichever of the two arrives last or it is a link to
  // nothing. The UNIQUE on (invoice_id, po_id) is what makes a re-apply
  // idempotent, the same standing stream_session_hosts has.
  { table: 'sale_purchase_links', key: ['id'], tier: 3 },
  // Which line items are in which parcel. Tier 3, one below everything it
  // names: it points at a SHIPMENT (tier 1) and at a LINE, and the line it
  // names is an invoice line at tier 2 — so it has to be the last of the four
  // to land or it is an assignment attached to nothing on the recovery path.
  { table: 'order_shipment_lines', key: ['id'], tier: 3 },
  { table: 'stream_item_lots', key: ['id'], tier: 2 },
  // Which cost layers one ledger movement took, and whether an operator chose
  // them. Tier 2: it names a transaction, and a composition arriving before the
  // movement it explains would be a set of slices attached to nothing.
  { table: 'inventory_txn_lots', key: ['id'], tier: 2 },
  { table: 'ledger_row_imports', key: ['row_id', 'import_id'], tier: 2 },
  /**
   * WHAT A SALE TOOK OFF THE SHELF, and what those goods cost.
   *
   * THIS WAS MISSING, and it is the quietest kind of missing: the sales order
   * travelled, its lines travelled, and the cost layers travelled with their
   * remainders already reduced — so `inventory_stock` rebuilt to the right
   * number on every machine and the quantities all agreed. Only the RECEIPT
   * linking the sale to the layers it consumed stayed behind, which meant that
   * on every laptop but the one that raised the order:
   *
   *   - the order showed no cost of goods, so it read as pure margin
   *     (orderHistory reads the cost from here, not from the lines);
   *   - voiding it could not put the stock back, because nothing said what to
   *     put back;
   *   - a roadshow shop's "sold" column counted zero, because that count comes
   *     off these rows.
   *
   * Nothing looked broken. The order was there, the numbers were there, and one
   * of them was wrong.
   *
   * Tier 2: it names an INVOICE and an INVENTORY TRANSACTION, both tier 1, so it
   * has to land after whichever arrives last on the row-at-a-time recovery path
   * or it is a receipt for nothing. It does NOT depend on invoice_lines despite
   * pointing at one — `line_position` is an ordinal, not a foreign key.
   */
  { table: 'invoice_stock_moves', key: ['id'], tier: 2 }
]

/**
 * TABLES THAT DELIBERATELY DO NOT TRAVEL, and why — as a list a test can read
 * rather than prose a test cannot.
 *
 * The reasons are written out above in the module header. This exists because
 * that header could not be checked: `invoice_stock_moves` was absent from both
 * the synced list and the header's account of what is deliberately absent, and
 * nothing anywhere could tell that omission from a decision. A table added to
 * the schema now fails the completeness test until somebody puts it in one list
 * or the other, which is the whole point — the choice has to be MADE, not
 * defaulted into by forgetting.
 */
export const NEVER_SYNCED: readonly string[] = [
  // Machine-local by definition: sessions, and the bench somebody is stood at.
  'server_sessions',
  'ship_station_sessions',
  // Secrets and per-machine settings. Sealed with safeStorage on the machine
  // that holds them, and must never leave it.
  'meta',
  // DERIVED on arrival, not carried. See the module header.
  'inventory_stock',
  // Rows point at files this machine holds; the bytes travel as *_parts.
  'inventory_product_images',
  'ship_documents',
  'order_documents',
  // The sync plumbing itself.
  'sync_control',
  'sync_outbox',
  'sync_rejects',
  'sync_state',
  /**
   * NOT A DECISION — A GAP, recorded here so it stops being invisible.
   *
   * Both are shared operational facts that plainly ought to travel: the packing
   * SOP ticks for a day, and what supplies a shift consumed. They are listed as
   * exclusions only so the completeness test can pass while naming them, and
   * they should move up into SYNCED_TABLES when somebody works out the tier and
   * can test it. They are left alone here because this change is about a sale's
   * stock receipt and widening it would put two untested tables on the wire.
   */
  'ship_sop_steps',
  'ship_supply_usage'
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
