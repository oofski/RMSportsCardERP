import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import Database from 'better-sqlite3'
import { normalizeUpc } from '@shared/upc'
import { boxesPerCaseFromName } from '@shared/units'
import { seedCatalog } from './inventorySeed'
import { seedSnapshot } from './inventorySnapshot'
import { seedCatalogExpansion } from './inventoryCatalogV2'
import { dedupeProducts } from './dedupe'
import { backfillLots } from './lots'
import { fingerprintOf } from './financeStreaming'

let db: Database.Database | null = null

/**
 * Initialise (and memoise) the SQLite database. The file lives in the app's
 * per-user data directory so it survives updates and uninstalls (unless the
 * user opts to wipe app data).
 *
 * SQLite is used deliberately: it shares a dialect with Cloudflare D1, so when
 * RM Cardz moves to a shared cloud database the schema and queries port over
 * with minimal change.
 */
export function getDb(): Database.Database {
  if (db) return db

  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = join(dir, 'rm-operations.db')

  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  migrate(db)
  return db
}

/** Idempotent schema setup. Uses a schema_version row so future migrations can
 * be layered in without destroying existing data. */
function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS employees (
      id                   TEXT PRIMARY KEY,
      first_name           TEXT NOT NULL,
      last_name            TEXT NOT NULL,
      company_id           TEXT NOT NULL UNIQUE COLLATE NOCASE,
      title                TEXT NOT NULL DEFAULT '',
      email                TEXT NOT NULL UNIQUE COLLATE NOCASE,
      role                 TEXT NOT NULL,
      status               TEXT NOT NULL DEFAULT 'invited',
      password_hash        TEXT,
      must_change_password INTEGER NOT NULL DEFAULT 1,
      permissions_json     TEXT,
      created_at           TEXT NOT NULL,
      updated_at           TEXT NOT NULL,
      created_by           TEXT
    );

    CREATE TABLE IF NOT EXISTS time_entries (
      id          TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      clock_in    TEXT NOT NULL,
      clock_out   TEXT,
      note        TEXT,
      source      TEXT NOT NULL DEFAULT 'manual',
      created_at  TEXT NOT NULL,
      FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_time_entries_employee
      ON time_entries (employee_id);

    CREATE TABLE IF NOT EXISTS audit_log (
      id         TEXT PRIMARY KEY,
      actor_id   TEXT,
      action     TEXT NOT NULL,
      target     TEXT,
      detail     TEXT,
      created_at TEXT NOT NULL
    );

    -- Catalog of every product ever carried. SKU is a short (often shared)
    -- abbreviation, so it is NOT unique; the UPC barcode is the natural key.
    CREATE TABLE IF NOT EXISTS inventory_products (
      id             TEXT PRIMARY KEY,
      sku            TEXT NOT NULL DEFAULT '',
      upc            TEXT UNIQUE,
      name           TEXT NOT NULL,
      category       TEXT NOT NULL DEFAULT '',
      brand          TEXT NOT NULL DEFAULT '',
      set_name       TEXT NOT NULL DEFAULT '',
      year           TEXT NOT NULL DEFAULT '',
      unit_type      TEXT NOT NULL DEFAULT 'box',
      boxes_per_case INTEGER,
      packs_per_box  INTEGER,
      -- v25: may this product be held in FRACTIONAL units? Only ever set for
      -- product deliberately kept as giveaway material — see the v25 note below.
      giveaway_item  INTEGER NOT NULL DEFAULT 0,
      unit_cost      REAL NOT NULL DEFAULT 0,
      high_bid       REAL,
      sale_price     REAL,
      reorder_point  INTEGER NOT NULL DEFAULT 0,
      notes          TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );

    -- On-hand quantity per product per location (RM / AM).
    --
    -- quantity is declared INTEGER and is one for almost every product. SQLite
    -- is dynamically typed, and INTEGER affinity keeps a whole value an integer
    -- while storing a genuinely fractional one as a REAL — which is exactly the
    -- behaviour v25 needs, because a giveaway-flagged product may sit at 9.75
    -- boxes. The gate is in the CODE (db/lots.ts roundQty), not here: nothing
    -- but a giveaway-flagged product can ever produce a fraction.
    CREATE TABLE IF NOT EXISTS inventory_stock (
      id         TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      location   TEXT NOT NULL,
      quantity   INTEGER NOT NULL DEFAULT 0,
      UNIQUE (product_id, location),
      FOREIGN KEY (product_id) REFERENCES inventory_products (id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_inv_stock_product
      ON inventory_stock (product_id);

    CREATE TABLE IF NOT EXISTS inventory_transactions (
      id              TEXT PRIMARY KEY,
      product_id      TEXT NOT NULL,
      type            TEXT NOT NULL,
      quantity_change INTEGER NOT NULL,
      unit_price      REAL,
      counterparty    TEXT,
      note            TEXT,
      actor_id        TEXT,
      location        TEXT,
      created_at      TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES inventory_products (id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_inv_txn_product
      ON inventory_transactions (product_id);
    CREATE INDEX IF NOT EXISTS idx_inv_txn_type
      ON inventory_transactions (type);

    -- Product photos (files live in userData/product-images; this tracks them).
    CREATE TABLE IF NOT EXISTS inventory_product_images (
      id         TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      filename   TEXT NOT NULL,
      position   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES inventory_products (id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_inv_img_product
      ON inventory_product_images (product_id);

    -- Stock on its way in: expected shipments / purchase orders. Receiving one
    -- folds its quantity into inventory_stock (and its cost into the average).
    CREATE TABLE IF NOT EXISTS inventory_incoming (
      id            TEXT PRIMARY KEY,
      product_id    TEXT NOT NULL,
      location      TEXT NOT NULL,
      quantity      INTEGER NOT NULL,
      unit_cost     REAL,
      reference     TEXT,
      expected_date TEXT,
      status        TEXT NOT NULL DEFAULT 'expected',
      note          TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      received_at   TEXT,
      FOREIGN KEY (product_id) REFERENCES inventory_products (id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_inv_incoming_status
      ON inventory_incoming (status);

    -- FIFO cost layers. Every stock-in creates a lot (a dated batch bought at a
    -- unit cost); sales/negative adjustments consume the oldest lots first. The
    -- product's unit_cost is kept as the weighted average of remaining lots.
    CREATE TABLE IF NOT EXISTS inventory_lots (
      id            TEXT PRIMARY KEY,
      product_id    TEXT NOT NULL,
      location      TEXT NOT NULL,
      qty_received  INTEGER NOT NULL,
      qty_remaining INTEGER NOT NULL,
      unit_cost     REAL NOT NULL DEFAULT 0,
      received_at   TEXT NOT NULL,
      source        TEXT NOT NULL DEFAULT 'restock',
      note          TEXT,
      created_at    TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES inventory_products (id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_inv_lots_fifo
      ON inventory_lots (product_id, location, received_at, id);
    CREATE INDEX IF NOT EXISTS idx_inv_lots_product
      ON inventory_lots (product_id);

    -- Purchase orders (buy-side). A PO moves through a deal pipeline
    -- (ordered -> paid -> received, or cancelled). total is a stored snapshot
    -- of Σ(line qty × unit_price) at creation. Receiving a PO does NOT yet write
    -- stock/cost into inventory (deferred); it is a normal pipeline stage.
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id           TEXT PRIMARY KEY,
      po_number    TEXT NOT NULL UNIQUE,
      supplier     TEXT,
      notes        TEXT,
      status       TEXT NOT NULL DEFAULT 'ordered',
      location     TEXT NOT NULL DEFAULT 'RM',
      total        REAL NOT NULL DEFAULT 0,
      created_by   TEXT,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      ordered_at   TEXT,
      paid_at      TEXT,
      received_at  TEXT,
      cancelled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_po_status
      ON purchase_orders (status);

    -- Line items on a PO. Each references a real catalog product and stores the
    -- quantity and the per-unit buy price being paid; the buy price is retained
    -- so it can later become the FIFO cost basis when received->inventory ships.
    CREATE TABLE IF NOT EXISTS purchase_order_lines (
      id         TEXT PRIMARY KEY,
      po_id      TEXT NOT NULL,
      product_id TEXT NOT NULL,
      quantity   INTEGER NOT NULL,
      unit_price REAL NOT NULL DEFAULT 0,
      position   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (po_id) REFERENCES purchase_orders (id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES inventory_products (id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_po_lines_po
      ON purchase_order_lines (po_id);
    CREATE INDEX IF NOT EXISTS idx_po_lines_product
      ON purchase_order_lines (product_id);

    -- v20: one row per RECEIPT against a PO line. A line can be received in
    -- several partial commits (scan 4 boxes, then 6 more), and each one opens
    -- its own FIFO lot at its own cost — so the relationship is 1:N and a single
    -- lot_id column on the line could only ever remember the last of them.
    -- Cancelling a received PO walks these rows to hand back exactly what each
    -- receipt took in.
    CREATE TABLE IF NOT EXISTS po_line_receipts (
      id          TEXT PRIMARY KEY,
      po_id       TEXT NOT NULL,
      po_line_id  TEXT NOT NULL,
      lot_id      TEXT NOT NULL,
      quantity    INTEGER NOT NULL,
      created_at  TEXT NOT NULL,
      FOREIGN KEY (po_id) REFERENCES purchase_orders (id) ON DELETE CASCADE,
      FOREIGN KEY (po_line_id) REFERENCES purchase_order_lines (id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_po_line_receipts_po
      ON po_line_receipts (po_id);
    CREATE INDEX IF NOT EXISTS idx_po_line_receipts_line
      ON po_line_receipts (po_line_id);

    -- Cost-of-Goods-Sold ledger. One row per purchase order (a purchase),
    -- recorded when the PO is created; voided (deleted) if the PO is cancelled.
    CREATE TABLE IF NOT EXISTS finance_cogs (
      id          TEXT PRIMARY KEY,
      po_id       TEXT NOT NULL,
      po_number   TEXT NOT NULL,
      amount      REAL NOT NULL DEFAULT 0,
      occurred_at TEXT NOT NULL,
      note        TEXT,
      created_at  TEXT NOT NULL,
      FOREIGN KEY (po_id) REFERENCES purchase_orders (id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_finance_cogs_po ON finance_cogs (po_id);

    -- v11: operating supplies / consumables (bubble mailers, poly bags, labels,
    -- tape, boxes). Deliberately SEPARATE from inventory_products so supply stock
    -- never touches sellable inventory value or spread. Single on-hand count
    -- (supplies aren't split across RM/AM the way cards are).
    CREATE TABLE IF NOT EXISTS supplies (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      unit          TEXT NOT NULL DEFAULT 'each',
      quantity      INTEGER NOT NULL DEFAULT 0,
      unit_cost     REAL NOT NULL DEFAULT 0,
      reorder_point INTEGER NOT NULL DEFAULT 0,
      recurring     INTEGER NOT NULL DEFAULT 0,
      notes         TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    -- Purchase / use / adjust log for supplies. 'purchase' rows carry the spend
    -- (total_cost) that powers the operating-expense rollup.
    CREATE TABLE IF NOT EXISTS supply_transactions (
      id              TEXT PRIMARY KEY,
      supply_id       TEXT NOT NULL,
      type            TEXT NOT NULL,
      quantity_change INTEGER NOT NULL,
      unit_cost       REAL,
      total_cost      REAL,
      note            TEXT,
      actor_id        TEXT,
      created_at      TEXT NOT NULL,
      FOREIGN KEY (supply_id) REFERENCES supplies (id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_supply_txn_supply ON supply_transactions (supply_id);

    -- v14: supply orders — a lightweight CRM pipeline for reorders moving through
    -- Ordered → In-transit → Delivered. Stock/cost are applied when an order is
    -- marked Delivered (until a purchasing API can drive the stages).
    CREATE TABLE IF NOT EXISTS supply_orders (
      id             TEXT PRIMARY KEY,
      supply_id      TEXT NOT NULL,
      units          INTEGER NOT NULL,
      items_per_unit INTEGER NOT NULL,
      total          REAL NOT NULL DEFAULT 0,
      status         TEXT NOT NULL DEFAULT 'ordered',
      -- v18: who placed the buy. 'manual' is a person filling the form;
      -- 'auto' is the low-stock reorder automation (Amazon Business API).
      -- Supply orders sit in the same board as product POs, so the card has to
      -- be able to say which of the two it was without guessing from the actor.
      source         TEXT NOT NULL DEFAULT 'manual',
      note           TEXT,
      actor_id       TEXT,
      ordered_at     TEXT,
      in_transit_at  TEXT,
      delivered_at   TEXT,
      cancelled_at   TEXT,
      created_at     TEXT NOT NULL,
      FOREIGN KEY (supply_id) REFERENCES supplies (id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_supply_orders_supply ON supply_orders (supply_id);

    -- v15: the UPC scan log. One row per scan that did something (or explicitly
    -- did nothing). product_name / sku / po_number are DENORMALISED snapshots so
    -- history survives a product or PO delete — which is also why the two FKs
    -- are SET NULL rather than CASCADE, and why po_line_id is deliberately NOT a
    -- foreign key (PO lines cascade away with their PO; the audit row outlives
    -- them). lot_id + txn_id are what make undo exact: the reversal targets the
    -- precise FIFO lot this scan created instead of consuming FIFO-oldest, which
    -- would silently corrupt the cost basis. po_completed / po_prev_status /
    -- po_prev_received_at capture whether THIS scan auto-completed the PO and
    -- what the header looked like before, so undo can restore it.
    CREATE TABLE IF NOT EXISTS inventory_scans (
      id                  TEXT PRIMARY KEY,
      raw_code            TEXT NOT NULL,
      normalized_code     TEXT,
      mode                TEXT NOT NULL DEFAULT 'wedge',
      outcome             TEXT NOT NULL,
      product_id          TEXT,
      product_name        TEXT,
      sku                 TEXT,
      po_id               TEXT,
      po_number           TEXT,
      po_line_id          TEXT,
      location            TEXT,
      quantity            INTEGER NOT NULL DEFAULT 0,
      unit_cost           REAL,
      lot_id              TEXT,
      txn_id              TEXT,
      po_completed        INTEGER NOT NULL DEFAULT 0,
      po_prev_status      TEXT,
      po_prev_received_at TEXT,
      client_token        TEXT,
      actor_id            TEXT,
      created_at          TEXT NOT NULL,
      undone_at           TEXT,
      undone_by           TEXT,
      FOREIGN KEY (product_id) REFERENCES inventory_products (id) ON DELETE SET NULL,
      FOREIGN KEY (po_id)      REFERENCES purchase_orders (id)   ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inv_scans_created ON inventory_scans (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_inv_scans_po_line ON inventory_scans (po_line_id);
    -- Network-retry / future-phone-client idempotency key.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inv_scans_token
      ON inventory_scans (client_token) WHERE client_token IS NOT NULL;

    -- ===================================================================
    -- v16: the Shipping workspace (RM Cardz break fulfillment).
    --
    -- ONE active dataset at a time: a Whatnot "labels + packing slips" PDF is
    -- parsed into these tables, and the next import overwrites them wholesale
    -- (operator state is carried forward only on a confirmed same-named-event
    -- re-import — see importDataset in db/shipping.ts).
    --
    -- Deliberately NO foreign keys between the ship_* tables: the import
    -- rewrites every array in one transaction, and a break-less giveaway's
    -- break_id ('giveaway_<handle>') intentionally has no ship_breaks row, so
    -- referential constraints would reject legitimate data.
    -- ===================================================================

    -- The active dataset's event. Single row (id = 1). The name is usually
    -- blank (these PDFs rarely carry one) which is precisely why carry-forward
    -- requires a NON-EMPTY name on both sides.
    CREATE TABLE IF NOT EXISTS ship_event (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      name       TEXT,
      date       TEXT,
      updated_at TEXT
    );

    -- One row per DISTINCT break number in the dataset.
    CREATE TABLE IF NOT EXISTS ship_breaks (
      id           TEXT PRIMARY KEY,
      break_number INTEGER,
      event_name   TEXT,
      event_date   TEXT,
      status       TEXT NOT NULL DEFAULT 'pending'
    );

    -- id = the Whatnot handle: the join key between packing and breaking slips.
    CREATE TABLE IF NOT EXISTS ship_customers (
      id             TEXT PRIMARY KEY,
      whatnot_handle TEXT,
      real_name      TEXT,
      address        TEXT,
      is_new         INTEGER NOT NULL DEFAULT 0
    );

    -- ONE row per physical card — the atomic unit of pick work. break_number is
    -- NULL for a break-less giveaway (a promo rider that belongs to no break).
    CREATE TABLE IF NOT EXISTS ship_team_slots (
      id             TEXT PRIMARY KEY,
      break_id       TEXT,
      break_number   INTEGER,
      team_name      TEXT,
      customer_id    TEXT,
      order_id       TEXT,
      price          REAL NOT NULL DEFAULT 0,
      is_giveaway    INTEGER NOT NULL DEFAULT 0,
      top_sleeved    INTEGER NOT NULL DEFAULT 0,
      checked_off    INTEGER NOT NULL DEFAULT 0,
      checked_off_at TEXT,
      checked_off_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ship_slots_customer ON ship_team_slots (customer_id);
    CREATE INDEX IF NOT EXISTS idx_ship_slots_break    ON ship_team_slots (break_id);

    -- ONE row per customer package (id = 'ship_<handle>'). status_code +
    -- status_set_at/by are the manual tracking status; the order's fulfillment
    -- stage is derived from it so Orders and Shipping can never disagree.
    CREATE TABLE IF NOT EXISTS ship_shipments (
      id                 TEXT PRIMARY KEY,
      customer_id        TEXT,
      tracking_number    TEXT,
      carrier            TEXT,
      service_type       TEXT,
      weight_oz          REAL,
      usps_url           TEXT,
      status_code        TEXT NOT NULL DEFAULT 'not_shipped',
      status_set_at      TEXT,
      status_set_by      TEXT,
      notes              TEXT,
      packed_at          TEXT,
      packed_by          TEXT,
      on_hold            INTEGER NOT NULL DEFAULT 0,
      held_reason        TEXT,
      queue_order        INTEGER NOT NULL DEFAULT 0,
      special_request    TEXT,
      special_request_at TEXT,
      special_request_by TEXT,
      last_updated       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ship_shipments_customer ON ship_shipments (customer_id);

    -- Line-item mirror of ship_team_slots; drives sales / ledger math.
    CREATE TABLE IF NOT EXISTS ship_orders (
      id           TEXT PRIMARY KEY,
      customer_id  TEXT,
      break_id     TEXT,
      break_number INTEGER,
      team_name    TEXT,
      price        REAL NOT NULL DEFAULT 0,
      is_giveaway  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ship_orders_customer ON ship_orders (customer_id);

    -- USPS "open all" bulk-tracking URLs, chunked into batches.
    CREATE TABLE IF NOT EXISTS ship_batch_urls (
      batch_number INTEGER PRIMARY KEY,
      count        INTEGER,
      url          TEXT
    );

    -- Per-break fidelity audit: captured teams vs the league's full slate, plus
    -- collisions (one team claimed by two customers in the same break — a real
    -- data error worth surfacing instead of silently guessing).
    -- missing_teams / collisions are JSON arrays.
    CREATE TABLE IF NOT EXISTS ship_break_audit (
      break_number       INTEGER PRIMARY KEY,
      team_count         INTEGER,
      distinct_team_count INTEGER,
      max_teams          INTEGER,
      missing_count      INTEGER,
      missing_teams      TEXT,
      has_all            INTEGER,
      collisions         TEXT
    );

    -- Parse-time warnings (unmatched team names, duplicate slots, ...).
    CREATE TABLE IF NOT EXISTS ship_warnings (
      id       TEXT PRIMARY KEY,
      page     INTEGER,
      message  TEXT,
      raw_text TEXT
    );

    -- Nameable import log; survives re-imports. counts = JSON.
    CREATE TABLE IF NOT EXISTS ship_imports (
      id         TEXT PRIMARY KEY,
      name       TEXT,
      filename   TEXT,
      kind       TEXT,
      created_at TEXT,
      counts     TEXT
    );

    -- Dated capture of orders + shipments + sales for CSV export. payload =
    -- JSON; deliberately NOT cleared by an import.
    CREATE TABLE IF NOT EXISTS ship_snapshots (
      id         TEXT PRIMARY KEY,
      name       TEXT,
      created_at TEXT,
      payload    TEXT
    );

    CREATE TABLE IF NOT EXISTS ship_settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    -- v17: who is sorting which break ("who is doing break #12").
    --
    -- Operator state, NOT dataset rows: an import does NOT wipe this table, it
    -- only PRUNES rows whose break_id no longer exists in ship_breaks. Break ids
    -- are 'break_<n>' and stable across re-imports, so an assignment survives a
    -- re-upload of the same show and disappears when its break genuinely does.
    --
    -- No foreign keys, matching the rest of the ship_* tables (the import
    -- rewrites ship_breaks wholesale). employee_id is likewise unconstrained;
    -- the domain layer resolves it and marks an orphaned row as not-found rather
    -- than losing the record.
    --
    -- break_number is denormalised so a pruned row still reads as "break 12".
    CREATE TABLE IF NOT EXISTS ship_break_assignments (
      id           TEXT PRIMARY KEY,
      break_id     TEXT NOT NULL,
      break_number INTEGER,
      employee_id  TEXT NOT NULL,
      assigned_at  TEXT NOT NULL,
      assigned_by  TEXT,
      note         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ship_break_assign_break
      ON ship_break_assignments (break_id);
    CREATE INDEX IF NOT EXISTS idx_ship_break_assign_employee
      ON ship_break_assignments (employee_id);
    -- One row per (break, person): re-assigning somebody updates their row
    -- instead of stacking duplicates on the card.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ship_break_assign_pair
      ON ship_break_assignments (break_id, employee_id);

    -- v21: what has been pushed to QuickBooks, and as what.
    --
    -- This table is the entire double-post defence. QuickBooks has no bulk undo
    -- and no natural idempotency key on Bill/Purchase/SalesReceipt, so "did we
    -- already send this?" can only be answered locally. A retry after a network
    -- timeout is the common case and must not create a second bill.
    --
    -- realm_id is part of the unique key ON PURPOSE: the same purchase order
    -- pushed to a sandbox company has NOT been pushed to the real one, and
    -- collapsing those would silently skip every record the day production is
    -- connected.
    --
    -- payload_hash is what we last sent. A PO edited after syncing hashes
    -- differently, which is how an update is told apart from a no-op — rather
    -- than diffing against QuickBooks on every run.
    CREATE TABLE IF NOT EXISTS qbo_sync_log (
      id           TEXT PRIMARY KEY,
      entity       TEXT NOT NULL,
      local_id     TEXT NOT NULL,
      realm_id     TEXT NOT NULL,
      qbo_type     TEXT NOT NULL,
      qbo_id       TEXT,
      doc_number   TEXT,
      amount       REAL NOT NULL DEFAULT 0,
      status       TEXT NOT NULL DEFAULT 'pending',
      error        TEXT,
      payload_hash TEXT,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      synced_at    TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_qbo_sync_key
      ON qbo_sync_log (realm_id, entity, local_id);
    CREATE INDEX IF NOT EXISTS idx_qbo_sync_status
      ON qbo_sync_log (status);

    -- ===================================================================
    -- v22: Streaming — live show sessions, what was broken on them, and what
    -- was given away.
    --
    -- A session is an absolute time WINDOW. It also carries stream_date: the
    -- LOCAL calendar date it STARTED on, which is its business day. RM's shows
    -- routinely run past midnight, so a Monday-night show ending at 2am
    -- produces Tuesday-stamped sales; grouping those by the instant splits one
    -- show across two days and makes both wrong. The date is STORED rather than
    -- derived so the calendar never redoes timezone maths per query, and so a
    -- session keeps its own day if the machine's timezone later changes.
    -- ===================================================================
    CREATE TABLE IF NOT EXISTS stream_sessions (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL DEFAULT '',
      started_at  TEXT NOT NULL,
      ended_at    TEXT,
      stream_date TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'live',
      -- 'live' was clocked with Start stream; 'manual' was typed in afterwards
      -- because nobody remembered to. Both count identically in the P&L — the
      -- distinction only records which times were measured and which recalled.
      source      TEXT NOT NULL DEFAULT 'live',
      host_id     TEXT,
      note        TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      created_by  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_stream_sessions_date
      ON stream_sessions (stream_date);
    CREATE INDEX IF NOT EXISTS idx_stream_sessions_status
      ON stream_sessions (status);

    -- One thing consumed on a show. product_name / sku / category are
    -- DENORMALISED snapshots for the same reason inventory_scans denormalises
    -- them: this row records what happened and has to stay readable after the
    -- catalog product is deleted — which is also why product_id is SET NULL
    -- rather than CASCADE.
    CREATE TABLE IF NOT EXISTS stream_items (
      id           TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL,
      kind         TEXT NOT NULL,
      product_id   TEXT,
      product_name TEXT NOT NULL,
      sku          TEXT NOT NULL DEFAULT '',
      category     TEXT NOT NULL DEFAULT '',
      break_number INTEGER,
      recipient    TEXT,
      quantity     INTEGER NOT NULL,
      -- v25: what the operator TYPED, kept beside the converted quantity so a
      -- line reads back as "2 cases + 3 boxes" instead of as 2.375. NULL on a
      -- line entered directly in stock units and on every pre-v25 row.
      entered_cases REAL,
      entered_boxes REAL,
      entered_packs REAL,
      location     TEXT NOT NULL,
      unit_cost    REAL NOT NULL DEFAULT 0,
      cost_total   REAL NOT NULL DEFAULT 0,
      -- v25, giveaways only. pack_cost is what ONE pack cost, divided down from
      -- the layers this line consumed (NULL when a divisor is missing — never a
      -- guess). loss_value is POSITIVE and is the P&L cost of the prize; it is
      -- not double counting against cost_total, which is the balance-sheet
      -- movement. Zero on a break.
      pack_cost    REAL,
      loss_value   REAL NOT NULL DEFAULT 0,
      note         TEXT,
      created_at   TEXT NOT NULL,
      created_by   TEXT,
      FOREIGN KEY (session_id) REFERENCES stream_sessions (id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES inventory_products (id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_stream_items_session
      ON stream_items (session_id);

    -- The exact FIFO layers one line consumed. This is what makes the recorded
    -- cost the REAL cost rather than a moving average, and it is the only thing
    -- that lets a deleted line put back exactly what it took — those layers, at
    -- those costs. lot_id is deliberately NOT a foreign key: lots cascade away
    -- with their product and this row has to outlive that (see stream_items).
    CREATE TABLE IF NOT EXISTS stream_item_lots (
      id         TEXT PRIMARY KEY,
      item_id    TEXT NOT NULL,
      lot_id     TEXT NOT NULL,
      quantity   INTEGER NOT NULL,
      unit_cost  REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (item_id) REFERENCES stream_items (id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_stream_item_lots_item
      ON stream_item_lots (item_id);

    -- ===================================================================
    -- v23: Finance → Streaming. The Whatnot ledger, attributed to shows.
    --
    -- One upload of Whatnot's weekly CSV. rows_quarantined is the number that
    -- matters: a line this app could not read is kept verbatim in
    -- ledger_quarantine rather than dropped, and every total is labelled
    -- incomplete while it is non-zero. A vanished row is money with no trace.
    -- ===================================================================
    CREATE TABLE IF NOT EXISTS ledger_imports (
      id                TEXT PRIMARY KEY,
      filename          TEXT NOT NULL DEFAULT '',
      rows_parsed       INTEGER NOT NULL DEFAULT 0,
      rows_imported     INTEGER NOT NULL DEFAULT 0,
      rows_duplicate    INTEGER NOT NULL DEFAULT 0,
      rows_repaired     INTEGER NOT NULL DEFAULT 0,
      rows_quarantined  INTEGER NOT NULL DEFAULT 0,
      first_occurred_at TEXT,
      last_occurred_at  TEXT,
      warnings_json     TEXT NOT NULL DEFAULT '[]',
      created_at        TEXT NOT NULL,
      created_by        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_imports_created
      ON ledger_imports (created_at DESC);

    -- One money movement from the ledger.
    --
    -- fingerprint is the entire de-duplication guarantee: the sha256 of the
    -- SIX-tuple (created date, amount, listing id, order id, message,
    -- transaction type) — see ledgerFingerprintSource in
    -- @shared/financeStreaming. Every shorter key was measured against real
    -- exports and silently loses rows: (order, type, amount) drops 156 and
    -- (created, message, amount) drops 274, because 154 platform charges are
    -- identical -$4.15 rows and whole batches of $0.00 shipping subsidies share
    -- one timestamp. Status and Completed Date are deliberately NOT in the key,
    -- so a row that moves from pending to completed between two exports stays
    -- ONE row instead of being counted twice.
    --
    -- stream_date is COPIED from the matched session, never derived from
    -- occurred_at. RM's shows run past midnight and 24.5% of all money is
    -- stamped 00:00-02:59; the local date of the row would move a quarter of
    -- the business onto the following day.
    --
    -- session_id is ON DELETE SET NULL, NOT cascade. Deleting a show must
    -- orphan its ledger rows into "unattributed" where the operator can see and
    -- re-home them. Cascading would delete real money to tidy up a typo.
    --
    -- attribution records HOW a row got its day, and the distinction is not
    -- cosmetic. 'in_window' is the strong case. 'carried_back' is a settlement
    -- row — a shipping subsidy, a platform charge, giveaway postage — that
    -- Whatnot posted hours after the show that caused it, sitting in the gap
    -- between two sessions and owned by neither; it attaches to the show that
    -- most recently ended before it. Sales are NEVER carried back: RM runs two
    -- shows most days, so an unlogged afternoon show is a block of genuine sales
    -- in exactly that gap, and folding it into the previous night would hide the
    -- missing session instead of surfacing it.
    CREATE TABLE IF NOT EXISTS ledger_rows (
      id                 TEXT PRIMARY KEY,
      import_id          TEXT NOT NULL,
      occurred_at        TEXT NOT NULL,
      amount             REAL NOT NULL DEFAULT 0,
      order_id           TEXT,
      listing_id         TEXT,
      message            TEXT NOT NULL DEFAULT '',
      txn_type           TEXT NOT NULL DEFAULT '',
      bucket             TEXT NOT NULL DEFAULT 'unclassified',
      session_id         TEXT,
      stream_date        TEXT,
      attribution        TEXT NOT NULL DEFAULT 'unattributed',
      break_number       INTEGER,
      fingerprint        TEXT NOT NULL,
      repaired           INTEGER NOT NULL DEFAULT 0,
      classifier_version INTEGER NOT NULL DEFAULT 1,
      created_at         TEXT NOT NULL,
      FOREIGN KEY (import_id)  REFERENCES ledger_imports (id)  ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES stream_sessions (id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_rows_fingerprint
      ON ledger_rows (fingerprint);

    -- v26: EVERY import that has seen a row, not just the one that saw it first.
    --
    -- ledger_rows.import_id names the first import to insert a fingerprint;
    -- de-dup means a later overlapping export skips it and leaves no trace that
    -- it covered the same money. Deleting the older import then cascaded those
    -- rows away even though a file still sitting in the list contained them, and
    -- that file's card went on looking complete with its first days now empty.
    --
    -- With coverage recorded, deleting an import re-points anything another
    -- import still covers and only removes what nothing covers any more. The
    -- delete stays a real delete; it just stops taking rows that were never
    -- only its.
    CREATE TABLE IF NOT EXISTS ledger_row_imports (
      row_id    TEXT NOT NULL,
      import_id TEXT NOT NULL,
      PRIMARY KEY (row_id, import_id),
      FOREIGN KEY (row_id)    REFERENCES ledger_rows (id)     ON DELETE CASCADE,
      FOREIGN KEY (import_id) REFERENCES ledger_imports (id)  ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_ledger_row_imports_import
      ON ledger_row_imports (import_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_rows_stream_date
      ON ledger_rows (stream_date);
    CREATE INDEX IF NOT EXISTS idx_ledger_rows_session
      ON ledger_rows (session_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_rows_bucket
      ON ledger_rows (bucket);
    CREATE INDEX IF NOT EXISTS idx_ledger_rows_occurred
      ON ledger_rows (occurred_at);
    CREATE INDEX IF NOT EXISTS idx_ledger_rows_import
      ON ledger_rows (import_id);

    -- A line that could not be read, kept verbatim with the reason. Whatnot's
    -- export is not valid RFC4180 (it wraps show titles in unescaped quotes),
    -- so the importer parses strictly, repairs the known malformation, and
    -- quarantines whatever is left. It NEVER discards a line: the import still
    -- commits (partial data beats no data) but says out loud that it is short.
    CREATE TABLE IF NOT EXISTS ledger_quarantine (
      id          TEXT PRIMARY KEY,
      import_id   TEXT NOT NULL,
      line_number INTEGER NOT NULL DEFAULT 0,
      raw_line    TEXT NOT NULL DEFAULT '',
      reason      TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL,
      FOREIGN KEY (import_id) REFERENCES ledger_imports (id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_quarantine_import
      ON ledger_quarantine (import_id);
  `)

  if (getMeta(database, 'schema_version') === null) {
    setMeta(database, 'schema_version', '1')
  }

  // --- Migration to v2: geolocation on time entries -----------------------
  // Additive columns, applied idempotently so existing v0.0.0 databases
  // upgrade cleanly on first launch of a newer build.
  addColumnIfMissing(database, 'time_entries', 'clock_in_lat', 'REAL')
  addColumnIfMissing(database, 'time_entries', 'clock_in_lng', 'REAL')
  addColumnIfMissing(database, 'time_entries', 'clock_in_place', 'TEXT')
  addColumnIfMissing(database, 'time_entries', 'clock_out_lat', 'REAL')
  addColumnIfMissing(database, 'time_entries', 'clock_out_lng', 'REAL')
  addColumnIfMissing(database, 'time_entries', 'clock_out_place', 'TEXT')

  // v3 added the inventory tables (created idempotently in the block above).

  // v4: catalog + per-location stock. New installs already get the new schema
  // above; this upgrades any existing v0.0.2 inventory table in place.
  migrateInventoryV4(database)
  addColumnIfMissing(database, 'inventory_transactions', 'location', 'TEXT')
  // v5: high bid (market value per unit) on products.
  addColumnIfMissing(database, 'inventory_products', 'high_bid', 'REAL')
  // v6: FIFO cost lots. When a high bid was last set (pricing recency), and the
  // cost basis (COGS) recorded on each sale from the consumed lots.
  addColumnIfMissing(database, 'inventory_products', 'high_bid_at', 'TEXT')
  addColumnIfMissing(database, 'inventory_transactions', 'cost_basis', 'REAL')
  // v7: purchase orders (buy-side pipeline). Brand-new tables are created
  // idempotently in the schema-init block above for both fresh and existing DBs.
  // v8: destination stock location on a PO (where its cases will be checked in).
  addColumnIfMissing(database, 'purchase_orders', 'location', "TEXT NOT NULL DEFAULT 'RM'")
  // v9: scanned_at on purchase_orders (idempotent scan-in) + finance_cogs COGS ledger.
  addColumnIfMissing(database, 'purchase_orders', 'scanned_at', 'TEXT')
  // v10: employee profile picture (stored media filename).
  addColumnIfMissing(database, 'employees', 'avatar', 'TEXT')
  // v11: operating supplies / consumables (supplies + supply_transactions).
  // Brand-new tables created idempotently in the schema-init block above.
  // v12: supply photo + pack size (items per ordering unit), and the order
  // breakdown (units + items per unit) recorded on each purchase.
  addColumnIfMissing(database, 'supplies', 'image', 'TEXT')
  addColumnIfMissing(database, 'supplies', 'items_per_unit', 'INTEGER NOT NULL DEFAULT 1')
  addColumnIfMissing(database, 'supply_transactions', 'units', 'INTEGER')
  addColumnIfMissing(database, 'supply_transactions', 'items_per_unit', 'INTEGER')
  // v13: a reorder link (e.g. the Amazon product page) per supply — one-click
  // reorder today, and the hook for automated reordering once a purchasing API
  // (Amazon Business) is available.
  addColumnIfMissing(database, 'supplies', 'reorder_url', 'TEXT')
  // v14: supply_orders pipeline (Ordered → In-transit → Delivered). New table
  // created idempotently in the schema-init block above.
  // v18: how a supply order was placed. Supply orders now share the Purchase
  // Orders board with product POs, so a card has to be able to say whether a
  // person filled the form or the low-stock automation bought it. Existing
  // rows are all hand-entered, which is exactly what the default says.
  addColumnIfMissing(database, 'supply_orders', 'source', "TEXT NOT NULL DEFAULT 'manual'")
  // v15: UPC scanning — per-line receipt tracking on PO lines, a canonical
  // (GTIN-14) lookup key on products, and the inventory_scans log (created
  // idempotently in the schema-init block above).
  //
  // qty_received is the AUTHORITATIVE double-add guard: cumulative units already
  // folded into stock for that line, so `outstanding = quantity - qty_received`.
  // An integer rather than a boolean so a future phone client can receive
  // per-unit without another migration.
  addColumnIfMissing(database, 'purchase_order_lines', 'qty_received', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing(database, 'purchase_order_lines', 'received_at', 'TEXT')
  // v19: the FIFO lot each receipt opened, so cancelling a RECEIVED purchase
  // order can hand back exactly the stock it took in — that lot, at that cost —
  // instead of guessing which layer to unwind. Lines received before v19 have
  // no lot recorded and are refused rather than reversed by approximation.
  addColumnIfMissing(database, 'purchase_order_lines', 'lot_id', 'TEXT')
  // The canonical form of `upc` (which is free text the user typed, e.g.
  // "0 12345 67890 5", and so cannot be matched against directly). NOT unique:
  // dirty legacy data could normalise two rows to the same value and a UNIQUE
  // index would fail the migration on a live database — duplicates surface at
  // runtime as the 'ambiguous_product' resolve state instead.
  addColumnIfMissing(database, 'inventory_products', 'upc_norm', 'TEXT')
  // Created HERE, not in the schema-init block above: that block runs BEFORE the
  // addColumnIfMissing calls, so an index on upc_norm would throw "no such
  // column" on every upgrading database.
  database.exec(`CREATE INDEX IF NOT EXISTS idx_inv_products_upc_norm ON inventory_products (upc_norm)`)
  // POs already whole-PO scanned in under the pre-v15 code have their stock in
  // inventory but would default to qty_received = 0 — scanning any UPC on such a
  // PO would then add that line's stock a SECOND time. Only POs with scanned_at
  // set are backfilled: a PO with status='received' but scanned_at NULL never
  // wrote stock (see the deferred TODO in setPurchaseOrderStatus), so its lines
  // are genuinely still outstanding and must stay at 0.
  runOnce(database, 'po_lines_received_backfill_v1', () =>
    database
      .prepare(
        `UPDATE purchase_order_lines
            SET qty_received = quantity,
                received_at = (SELECT po.scanned_at FROM purchase_orders po WHERE po.id = purchase_order_lines.po_id)
          WHERE po_id IN (SELECT id FROM purchase_orders WHERE scanned_at IS NOT NULL)`
      )
      .run()
  )
  // v16: the Shipping workspace (ship_* tables + indexes), created idempotently
  // in the schema-init block above. Purely additive — no existing table changes,
  // so an upgrading v15 database gains the tables empty and the Upload tab is
  // the only thing that fills them.
  //
  // v17: break assignments (ship_break_assignments + its indexes), also created
  // idempotently in the schema-init block above. Purely additive.
  //
  // The History calendar shipped in v17 too and deliberately adds NO table: a
  // day's imports come from ship_imports.created_at, its fulfilment progress
  // from the live dataset (for the day still loaded) or from that day's newest
  // ship_snapshots capture. A per-day rollup would only duplicate rows that
  // already exist — and would drift the moment a snapshot or import is renamed
  // or deleted. See db/shippingCalendar.ts.
  //
  // v18: supply_orders.source ('manual' | 'auto'). Purely additive, and the
  // default makes every existing row correct — nothing has been bought
  // automatically yet.
  //
  // v19: purchase_order_lines.lot_id, so a received PO can be cancelled by
  // reversing the exact receipt. Purely additive; a NULL means "received before
  // v19", which the cancel path reports honestly instead of guessing.
  //
  // v20: po_line_receipts, because v19 got the cardinality wrong. A line can be
  // received in SEVERAL partial commits, each opening its own lot, so one
  // lot_id per line could only remember the last — and cancelling then tried to
  // reverse the full quantity against a partial lot and refused with a wrong
  // reason ("already sold"). Receipts are 1:N and are now stored that way.
  // lot_id is kept, and read as a single-receipt fallback for the brief window
  // where it was the only record.
  //
  // v21: qbo_sync_log, created idempotently in the schema-init block above.
  // Purely additive — an upgrading database gains the table empty, and an empty
  // sync log means "nothing has been pushed to QuickBooks", which is true.
  //
  // v22: streaming (stream_sessions / stream_items / stream_item_lots), also
  // created idempotently above. Purely additive — no existing table changes.
  //
  // The table that earns its keep is stream_item_lots. Opening a case on a
  // break costs whatever the SPECIFIC cases pulled off the shelf cost, not the
  // product's average, which drifts every time anything is bought. Naming the
  // consumed layers is also the only way a mis-typed line can be undone: the
  // units go back into the same lots at the same cost, whereas re-lotting them
  // at today's average would restate the basis of everything still on hand.
  //
  // Sessions may not overlap. That is enforced in db/streaming.ts rather than
  // by a constraint (SQLite has no exclusion constraints), and it is not a
  // nicety: an overlap leaves a sale with two candidate shows and no correct
  // way to pick one, which is exactly the attribution the module exists to fix.
  //
  // v23: the Whatnot ledger (ledger_imports / ledger_rows / ledger_quarantine),
  // created idempotently above. Purely additive — an upgrading v22 database
  // gains three empty tables, and no ledger rows means "nothing has been
  // uploaded yet", which is true.
  //
  // Two columns carry the whole design.
  //
  // ledger_rows.fingerprint (UNIQUE) is what makes re-uploading an overlapping
  // week safe. It hashes the SIX-tuple from ledgerFingerprintSource, and the
  // width is not defensive: measured against two real exports, a key of
  // (order id, type, amount) silently discards 156 genuine rows and
  // (created, message, amount) discards 274, because 154 platform charges are
  // byte-identical -$4.15 rows and batches of $0.00 shipping subsidies share a
  // timestamp. Order ID is definitively not a key — a sale and its shipping
  // subsidy share one.
  //
  // ledger_rows.stream_date is COPIED from the matched session, never computed
  // from the row's own instant. On real data 80% of a night show's money is
  // stamped after midnight and 24.5% of ALL money lands 00:00-02:59, so the
  // row's local date would file a quarter of the business on the wrong day
  // while every screen still looked right.
  //
  // And session_id is ON DELETE SET NULL rather than CASCADE, deliberately:
  // deleting a mistyped show must ORPHAN its ledger rows into "unattributed",
  // never delete money to tidy up a session.
  //
  // ledger_rows.attribution says HOW a row got its day: inside a session
  // ('in_window'), settled after one ('carried_back'), or owned by nothing
  // ('unattributed'). Whatnot posts a show's shipping economics hours later —
  // subsidies batch overnight, platform charges post next morning — so those
  // rows land in the gap between two shows and would otherwise be permanently
  // unassignable. Sales are deliberately never carried back; see the table
  // comment above.
  addColumnIfMissing(database, 'ledger_rows', 'attribution', "TEXT NOT NULL DEFAULT 'unattributed'")
  // Created HERE rather than in the schema block above, for the same reason
  // idx_inv_products_upc_norm is: that block runs BEFORE addColumnIfMissing, so
  // an index on a just-added column would throw "no such column" on any database
  // that predates it.
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_ledger_rows_attribution ON ledger_rows (attribution)`
  )
  // v24: re-key every ledger row.
  //
  // The de-dup fingerprint used to hash the RAW "Created Date" text. Whatnot has
  // already changed one column's formatting under us — negatives went from
  // "-$4.15" to "($4.15)" — and the same change to the timestamp would have made
  // every stored row look new and doubled the archive on the next upload. The
  // fingerprint now normalises the timestamp to wall-clock digits, so this pass
  // recomputes the stored hashes to match. Without it, the first import after
  // upgrading would re-insert every row it already had.
  runOnce(database, 'ledger_fingerprint_v2', () => reFingerprintLedger(database))

  // v25: cases, boxes and packs — the unit model reaches inventory and streaming.
  //
  // THE ONE COLUMN THAT MATTERS is inventory_products.giveaway_item.
  //
  // RM gives packs away on stream. A giveaway of three packs out of a
  // twelve-pack box genuinely leaves three quarters of a box on the shelf, so
  // stock has to be able to hold a fraction. Letting EVERY product do that would
  // be the wrong trade: rounding dust would accumulate across a 120-product
  // catalog and quietly move the cost basis of stock nobody is giving away, and
  // nothing on screen would look wrong. So the fractional path is opt-in per
  // product, defaults to 0, and every conversion in @shared/units refuses a
  // part-unit on a product that has not opted in — naming the field to fill in
  // rather than silently rounding.
  //
  // The fractional gate is in the CODE, not the schema. inventory_stock.quantity
  // and inventory_lots.qty_* are declared INTEGER, but SQLite's INTEGER affinity
  // stores a whole value as an integer and a genuine fraction as a REAL, which is
  // precisely what is wanted. What used to make fractions impossible was
  // Math.round() on every quantity in db/lots.ts and db/inventory.ts; those now
  // round to 4dp for a giveaway-flagged product and to a whole number for
  // everything else (see roundQty in db/lots.ts).
  //
  // stream_items gains the entered units (entered_cases / entered_boxes /
  // entered_packs) so a line reads back the way it was typed, plus pack_cost and
  // loss_value: the P&L value of a prize, which is a DIFFERENT cost from the
  // giveaway_shipping ledger rows (that is the postage, this is the prize). Both
  // belong on the day, and the ledger's treatment of giveaway_shipping is
  // unchanged.
  addColumnIfMissing(database, 'inventory_products', 'giveaway_item', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing(database, 'stream_items', 'entered_cases', 'REAL')
  addColumnIfMissing(database, 'stream_items', 'entered_boxes', 'REAL')
  addColumnIfMissing(database, 'stream_items', 'entered_packs', 'REAL')
  addColumnIfMissing(database, 'stream_items', 'pack_cost', 'REAL')
  addColumnIfMissing(database, 'stream_items', 'loss_value', 'REAL NOT NULL DEFAULT 0')
  setMeta(database, 'schema_version', '25')

  // v26: backfill row coverage from what we know.
  //
  // Only the FIRST importer of each row was ever recorded, so that is all this
  // can seed — the historical duplicate observations were never stored and
  // cannot be recovered here. Overlap from before this version therefore stays
  // at risk until the overlapping file is uploaded again, which re-registers its
  // coverage. Everything imported from now on is protected from the first
  // upload.
  database
    .prepare(
      `INSERT OR IGNORE INTO ledger_row_imports (row_id, import_id)
       SELECT id, import_id FROM ledger_rows`
    )
    .run()
  setMeta(database, 'schema_version', '26')

  // Seed the product catalog once, then apply the on-hand snapshot once.
  seedCatalogIfNeeded(database)
  seedSnapshotIfNeeded(database)

  // One-time data touch-ups (each guarded by a meta flag so they run once).
  runOnce(database, 'combat_to_ufc', () =>
    database.prepare("UPDATE inventory_products SET category = 'UFC' WHERE category = 'Combat'").run()
  )
  // Clear the per-product template fields for now; they're set later by supervisors.
  runOnce(database, 'blank_template_fields_v1', () =>
    database
      .prepare(
        `UPDATE inventory_products
           SET boxes_per_case = NULL, packs_per_box = NULL, sale_price = NULL, reorder_point = 0`
      )
      .run()
  )

  // Expand the catalog with more products (blank financials). Runs once.
  runOnce(database, 'catalog_expansion_v1', () => seedCatalogExpansion(database))

  // Merge legacy duplicate products (same name created twice by an early beta
  // build). Runs once; a clean catalog is a no-op.
  runOnce(database, 'dedupe_products_v1', () => dedupeProducts(database))

  // Seed FIFO cost lots from existing on-hand stock. Runs LAST, after seeds +
  // catalog expansion + dedupe have settled the final stock/cost, so the lots
  // match the aggregate quantities exactly.
  runOnce(database, 'inventory_lots_backfill_v1', () => backfillLots(database))

  // v15: fill upc_norm for the existing catalog. Deliberately placed after the
  // seeds / catalog expansion / dedupe above, all of which write `upc` with raw
  // SQL — a runOnce that ran before them would leave those rows permanently
  // unscannable. Normalisation (UPC-E expansion, leading-zero stripping,
  // GTIN-14 padding) isn't expressible in SQL, so it's a JS pass; ~122 rows is
  // instant. createProduct/updateProduct keep it in sync from here on.
  runOnce(database, 'upc_norm_backfill_v1', () => backfillUpcNorm(database, true))
  // Cheap self-heal (normally zero rows): any product whose upc was written by a
  // future seed batch that forgets upc_norm would otherwise never scan.
  backfillUpcNorm(database, false)

  // v25: read boxes_per_case out of the product NAME.
  //
  // The number has always been in the name ("…Hobby 8-Box Case") and never in
  // the field, and `blank_template_fields_v1` above nulled the column outright.
  // Every break entered in loose boxes is refused until it is filled in, so a
  // catalog-wide manual pass would be the alternative.
  //
  // Deliberately placed AFTER the seeds, the catalog expansion, the dedupe and
  // blank_template_fields_v1 — all of which write names or blank this column
  // with raw SQL — so it sees the settled catalog. It only ever fills a NULL,
  // and only from the explicit "N-Box" form; packs_per_box is NOT guessed at all
  // and stays NULL for the owner, because a wrong divisor there silently
  // distorts every giveaway valuation.
  runOnce(database, 'boxes_per_case_from_name_v1', () => {
    const filled = backfillBoxesPerCase(database)
    setMeta(database, 'boxes_per_case_from_name_count', String(filled))
  })
}

/**
 * Fill `boxes_per_case` from the product name for every product that has no
 * value and whose name yields one. Returns how many rows it set.
 *
 * Uses `boxesPerCaseFromName` from the unit contract rather than a local regex:
 * the number this writes divides every break cost and giveaway valuation for
 * that product, and two implementations of it would eventually disagree.
 */
export function backfillBoxesPerCase(database: Database.Database): number {
  const rows = database
    .prepare(
      `SELECT id, name FROM inventory_products
        WHERE boxes_per_case IS NULL AND name IS NOT NULL AND TRIM(name) <> ''`
    )
    .all() as Array<{ id: string; name: string }>
  if (rows.length === 0) return 0
  const upd = database.prepare('UPDATE inventory_products SET boxes_per_case = ? WHERE id = ?')
  let filled = 0
  database.transaction(() => {
    for (const r of rows) {
      const n = boxesPerCaseFromName(r.name)
      if (n === null) continue
      upd.run(n, r.id)
      filled++
    }
  })()
  return filled
}

/**
 * Recompute `upc_norm` from `upc`. `all` re-normalises every product carrying a
 * UPC (the one-time backfill); otherwise only rows still missing the canonical
 * form are touched. Wrapped in a transaction so a crash leaves nothing
 * half-normalised (and the runOnce flag unset, so it retries next launch).
 */
function backfillUpcNorm(database: Database.Database, all: boolean): void {
  const rows = database
    .prepare(
      `SELECT id, upc FROM inventory_products
        WHERE upc IS NOT NULL AND TRIM(upc) <> ''${all ? '' : ' AND upc_norm IS NULL'}`
    )
    .all() as Array<{ id: string; upc: string }>
  if (rows.length === 0) return
  const upd = database.prepare('UPDATE inventory_products SET upc_norm = ? WHERE id = ?')
  database.transaction(() => {
    for (const r of rows) upd.run(normalizeUpc(r.upc), r.id)
  })()
}


/**
 * Recompute `ledger_rows.fingerprint` under the current rules.
 *
 * Deliberately reuses the SAME function the importer calls, rather than a
 * migration-local copy — two implementations of an identity hash drift, and the
 * day they do, every row looks new.
 *
 * Wrapped in a transaction: a half-rekeyed table would de-duplicate against
 * itself inconsistently, and the runOnce flag stays unset so a crash retries.
 */
function reFingerprintLedger(database: Database.Database): void {
  const has = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ledger_rows'")
    .all()
  if (has.length === 0) return
  const rows = database
    .prepare('SELECT id, occurred_at, amount, listing_id, order_id, message, txn_type FROM ledger_rows')
    .all() as Array<{
      id: string; occurred_at: string; amount: number
      listing_id: string | null; order_id: string | null; message: string; txn_type: string
    }>
  if (rows.length === 0) return
  const upd = database.prepare('UPDATE ledger_rows SET fingerprint = ? WHERE id = ?')
  database.transaction(() => {
    for (const r of rows) {
      upd.run(
        fingerprintOf(
          r.occurred_at, r.amount, r.listing_id ?? '', r.order_id ?? '', r.message, r.txn_type
        ),
        r.id
      )
    }
  })()
}

/** Run `fn` once, ever, tracked by a meta flag. */
function runOnce(database: Database.Database, key: string, fn: () => void): void {
  if (getMeta(database, key) === '1') return
  fn()
  setMeta(database, key, '1')
}

/**
 * Rebuild a pre-v4 `inventory_products` table (single `quantity` column, unique
 * SKU, no `upc`) into the catalog shape, moving its stock into inventory_stock
 * at the default RM location. No-op when the table is already the new shape.
 */
function migrateInventoryV4(database: Database.Database): void {
  const cols = database
    .prepare(`PRAGMA table_info(inventory_products)`)
    .all() as Array<{ name: string }>
  const isOld = cols.some((c) => c.name === 'quantity') && !cols.some((c) => c.name === 'upc')
  if (!isOld) return

  // FK toggle must be outside the transaction (the pragma is a no-op inside
  // one); the DDL itself runs in a transaction so an interrupted migration
  // rolls back cleanly instead of leaving a half-built, unopenable database.
  database.pragma('foreign_keys = OFF')
  try {
    database.transaction(() => {
      database.exec(`
      DROP TABLE IF EXISTS inventory_products_v4;
      CREATE TABLE inventory_products_v4 (
        id             TEXT PRIMARY KEY,
        sku            TEXT NOT NULL DEFAULT '',
        upc            TEXT UNIQUE,
        name           TEXT NOT NULL,
        category       TEXT NOT NULL DEFAULT '',
        brand          TEXT NOT NULL DEFAULT '',
        set_name       TEXT NOT NULL DEFAULT '',
        year           TEXT NOT NULL DEFAULT '',
        unit_type      TEXT NOT NULL DEFAULT 'box',
        boxes_per_case INTEGER,
        packs_per_box  INTEGER,
        unit_cost      REAL NOT NULL DEFAULT 0,
        sale_price     REAL,
        reorder_point  INTEGER NOT NULL DEFAULT 0,
        notes          TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      INSERT INTO inventory_products_v4
        (id, sku, upc, name, category, brand, set_name, year, unit_type,
         boxes_per_case, packs_per_box, unit_cost, sale_price, reorder_point,
         notes, created_at, updated_at)
        SELECT id, sku, NULL, name, category, brand, set_name, year, unit_type,
               boxes_per_case, packs_per_box, unit_cost, sale_price, reorder_point,
               notes, created_at, updated_at
        FROM inventory_products;
      INSERT INTO inventory_stock (id, product_id, location, quantity)
        SELECT lower(hex(randomblob(16))), id, 'RM', quantity
        FROM inventory_products WHERE quantity <> 0;
      DROP TABLE inventory_products;
      ALTER TABLE inventory_products_v4 RENAME TO inventory_products;
    `)
    })()
  } finally {
    database.pragma('foreign_keys = ON')
  }
}

function seedCatalogIfNeeded(database: Database.Database): void {
  if (getMeta(database, 'catalog_seeded') === '1') return
  seedCatalog(database)
  setMeta(database, 'catalog_seeded', '1')
}

/**
 * Apply the current on-hand snapshot once: match each row to the catalog by
 * name, set its location quantity, high bid and average cost, creating any
 * product not already in the catalog. Gated so later manual edits are never
 * clobbered on subsequent launches.
 */
function seedSnapshotIfNeeded(database: Database.Database): void {
  if (getMeta(database, 'snapshot_v1_seeded') === '1') return
  seedSnapshot(database)
  setMeta(database, 'snapshot_v1_seeded', '1')
}

/** Add a column only if the table doesn't already have it (safe re-run). */
function addColumnIfMissing(
  database: Database.Database,
  table: string,
  column: string,
  type: string
): void {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
}

export function getMeta(database: Database.Database, key: string): string | null {
  const row = database.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row ? row.value : null
}

export function setMeta(database: Database.Database, key: string, value: string): void {
  database
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value)
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
