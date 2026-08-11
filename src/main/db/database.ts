import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import Database from 'better-sqlite3'
import { normalizeUpc } from '@shared/upc'
import { boxesPerCaseFromName } from '@shared/units'
import { seedCatalog } from './inventorySeed'
import { seedSnapshot } from './inventorySnapshot'
import { seedCatalogExpansion } from './inventoryCatalogV2'
import { seedCatalogV3 } from './inventoryCatalogV3'
import { dedupeProducts } from './dedupe'
import { backfillLots, resyncProductAvgCosts } from './lots'
import { backfillWorkLog } from './workLogStore'
import { installSyncTriggers } from './syncTriggers'
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

    -- v28: sessions for the shared-database server.
    --
    -- The desktop app keeps its signed-in user in memory, which is correct for
    -- one person at one computer. A server answering ten people needs a session
    -- each, and needs them to survive a restart — otherwise every deploy signs
    -- the whole warehouse out mid-count. Stored here rather than in memory for
    -- exactly that reason.
    --
    -- Only the token HASH is kept. A stolen database backup should not hand the
    -- thief a set of live sessions, and nothing ever needs the original value
    -- again: it is compared by hashing what the client presents.
    CREATE TABLE IF NOT EXISTS server_sessions (
      token_hash   TEXT PRIMARY KEY,
      employee_id  TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at   TEXT NOT NULL,
      client       TEXT,
      FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_server_sessions_employee
      ON server_sessions (employee_id);
    CREATE INDEX IF NOT EXISTS idx_server_sessions_expiry
      ON server_sessions (expires_at);

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

    -- v27: the record of one mass re-adjustment (Admin → Inventory reset).
    --
    -- Every individual movement a reset makes is already an ordinary row in
    -- inventory_transactions, so the stock ledger needs nothing from this table.
    -- What it adds is the RUN: which count sheet, on what date, moved the whole
    -- warehouse from these totals to those. A weekly reset is a periodic control,
    -- and a control nobody can look back at is not one.
    CREATE TABLE IF NOT EXISTS inventory_resets (
      id               TEXT PRIMARY KEY,
      source           TEXT NOT NULL DEFAULT '',
      rows_total       INTEGER NOT NULL DEFAULT 0,
      rows_applied     INTEGER NOT NULL DEFAULT 0,
      rows_skipped     INTEGER NOT NULL DEFAULT 0,
      products_created INTEGER NOT NULL DEFAULT 0,
      shelves_zeroed   INTEGER NOT NULL DEFAULT 0,
      units_before     REAL NOT NULL DEFAULT 0,
      units_after      REAL NOT NULL DEFAULT 0,
      cost_before      REAL NOT NULL DEFAULT 0,
      cost_after       REAL NOT NULL DEFAULT 0,
      market_before    REAL NOT NULL DEFAULT 0,
      market_after     REAL NOT NULL DEFAULT 0,
      options_json     TEXT NOT NULL DEFAULT '{}',
      detail_json      TEXT NOT NULL DEFAULT '[]',
      created_at       TEXT NOT NULL,
      created_by       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_inv_resets_created
      ON inventory_resets (created_at DESC);

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
    -- Keyed by the printed LABEL, not the number: a show that ran both #11 and
    -- #11A has two independent slates to measure, and a number PK would let the
    -- second overwrite the first.
    CREATE TABLE IF NOT EXISTS ship_break_audit (
      break_label        TEXT PRIMARY KEY,
      break_number       INTEGER,
      team_count         INTEGER,
      distinct_team_count INTEGER,
      max_teams          INTEGER,
      missing_count      INTEGER,
      missing_teams      TEXT,
      has_all            INTEGER,
      collisions         TEXT
    );

    -- The uploaded PDF itself.
    --
    -- Kept so the floor can work against the ORIGINAL paper: a picker with the
    -- slip open beside the pick list can see what the customer actually bought,
    -- in the layout they are used to reading. One row per import; the bytes are
    -- the file verbatim, which is ~1MB for a 136-page export.
    --
    -- Deliberately NOT in the cloud-sync manifest (see syncTables.ts): a
    -- multi-megabyte blob does not belong in a row-at-a-time relay. The parsed
    -- dataset — which is what the work is actually done against — syncs as
    -- normal, so a machine without the document loses the paper, not the job.
    CREATE TABLE IF NOT EXISTS ship_documents (
      id          TEXT PRIMARY KEY,
      import_id   TEXT,
      name        TEXT NOT NULL,
      page_count  INTEGER NOT NULL DEFAULT 0,
      byte_size   INTEGER NOT NULL DEFAULT 0,
      bytes       BLOB,
      created_at  TEXT NOT NULL
    );

    -- v46: the same slip, cut into pieces small enough to travel.
    --
    -- The table above is still not synced and still holds the whole file; this
    -- is how it GETS to the other machines. One row per slice, base64, each with
    -- its own id — which makes it an ordinary synced record that the existing
    -- relay carries without knowing it is carrying a PDF.
    --
    -- Why it had to exist: the slip is the paper the floor works against, and a
    -- packer on any machine but the one that uploaded it saw "No slip on this
    -- machine". The parsed dataset synced perfectly; the document did not, so
    -- every other person on the team — and the web app, where most of them now
    -- are — had the card list and no way to check it against the customer's own
    -- order.
    --
    -- Each part repeats the document's metadata rather than pointing at a second
    -- synced row for it. It is a few hundred bytes against a half-megabyte
    -- payload, and it means a machine that has all the parts can rebuild the
    -- document with nothing else having arrived — no ordering rule to get wrong
    -- between two tables, and no half-built document waiting on a header.
    --
    -- seq is 0-based and total is how many there are, so completeness is
    -- COUNT(*) = total and needs no other bookkeeping. Reassembly happens after
    -- a pull drains, exactly like inventory_stock: see rebuildShipDocument().
    CREATE TABLE IF NOT EXISTS ship_document_parts (
      id          TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      import_id   TEXT,
      name        TEXT NOT NULL,
      page_count  INTEGER NOT NULL DEFAULT 0,
      byte_size   INTEGER NOT NULL DEFAULT 0,
      seq         INTEGER NOT NULL,
      total       INTEGER NOT NULL,
      data        TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      UNIQUE (document_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_ship_doc_parts
      ON ship_document_parts (document_id, seq);

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

    -- What the platform charged, over a stretch of SHOW NIGHTS.
    --
    -- FOUR NUMBERS, not one. The ledger Amount is NET: Whatnot takes its cut
    -- before writing the row, so the item price the buyer bid is recovered from
    -- that net on READ. Recovering it needs the commission rate, the sales tax
    -- rate (because card processing is charged on a total that includes tax),
    -- the card percentage and the card flat charge. Changing any of them here
    -- moves every past show inside the range with no re-upload and no migration.
    --
    -- rate is the COMMISSION, kept under its original name so a row synced from
    -- a laptop on an older build still lands in the column it means.
    -- processing_flat_cents is CENTS -- 30, not 0.30 -- because money in this
    -- app is integer cents and a float flat charge would round differently on
    -- two machines.
    --
    -- Nothing constrains the ranges in SQL. SQLite has no exclusion constraint,
    -- so non-overlap is enforced in db/whatnotRates.ts inside the write
    -- transaction -- the same bargain stream_sessions makes, and for the same
    -- reason: two periods claiming one day would make a show's fee depend on
    -- which row was read first.
    --
    -- to_date NULL means open-ended. An empty table is the ordinary state: the
    -- defaults in the contract apply to every night nothing covers.
    CREATE TABLE IF NOT EXISTS whatnot_fee_periods (
      id                    TEXT PRIMARY KEY,
      from_date             TEXT NOT NULL,
      to_date               TEXT,
      rate                  REAL NOT NULL,
      -- These three defaults restate DEFAULT_FEE_RATES in the contract. They
      -- have to: a column default is DDL and cannot read TypeScript. The
      -- migration below adds the same columns with the same defaults to a
      -- database that predates them, and the contract's resolveFeeRates is what
      -- catches a row that somehow arrives without one.
      tax_rate              REAL NOT NULL DEFAULT 0.0518,
      processing_rate       REAL NOT NULL DEFAULT 0.029,
      processing_flat_cents INTEGER NOT NULL DEFAULT 30,
      note                  TEXT NOT NULL DEFAULT '',
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL,
      created_by            TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_whatnot_fee_periods_from
      ON whatnot_fee_periods (from_date);

    -- v44: costs somebody TYPED against a business day.
    --
    -- A DOLLAR AMOUNT, NOT A STOCK MOVEMENT. A pack opened for fun, a box given
    -- to a friend, a sleeve that walked. Recording an actual movement is what
    -- the streaming giveaway flow already does -- it consumes FIFO layers, drops
    -- the on-hand count and values itself at what those layers cost -- and this
    -- table deliberately does none of that. It is for the loose case where
    -- nobody is going to reconcile a pack against the shelf, and inventing a lot
    -- consumption for it would put the count further from the truth. THE TWO
    -- MUST NOT BE CONFLATED: a giveaway entered in Streaming and typed here as
    -- well books the same pack twice.
    --
    -- amount is POSITIVE, exactly as entered, and the P&L reports it negative --
    -- the same bargain stream_items makes with cost_total. A signed column would
    -- let a stray minus turn a write-off into income with nothing to catch it.
    --
    -- stream_date is a BUSINESS day, the same key the P&L groups by, so an entry
    -- against a night that ran past midnight sits with that night's takings.
    -- Unconstrained: an expense can precede the ledger import that gives its day
    -- any other rows, and refusing it then would mean the operator had to import
    -- before they could record what they already knew.
    CREATE TABLE IF NOT EXISTS finance_expenses (
      id          TEXT PRIMARY KEY,
      stream_date TEXT NOT NULL,
      amount      REAL NOT NULL DEFAULT 0,
      label       TEXT NOT NULL DEFAULT '',
      note        TEXT,
      created_at  TEXT NOT NULL,
      created_by  TEXT,
      updated_at  TEXT NOT NULL,
      updated_by  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_finance_expenses_day
      ON finance_expenses (stream_date);

    -- =====================================================================
    -- v29: cloud sync
    -- =====================================================================

    -- Rows waiting to go up.
    --
    -- A coalescing queue, not a log: one row per record, holding only its
    -- latest state. Editing the same product forty times leaves ONE entry, so
    -- a laptop that has been offline all week comes back with a queue the size
    -- of what it changed rather than of what it did.
    CREATE TABLE IF NOT EXISTS sync_outbox (
      kind       TEXT NOT NULL,
      id         TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (kind, id)
    ) WITHOUT ROWID;

    -- Local sync bookkeeping: cursor, device id, shared key, last error.
    CREATE TABLE IF NOT EXISTS sync_state (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    -- The echo brake.
    --
    -- Applying a pulled row is still an ordinary INSERT/UPDATE, so without this
    -- the capture triggers would queue it straight back up and two laptops
    -- would bounce the same row between them forever. Every trigger is guarded
    -- on applying = 0, and the apply path sets it to 1 for the duration of
    -- the batch. A table rather than a variable because SQLite triggers can
    -- only read tables.
    CREATE TABLE IF NOT EXISTS sync_control (
      id       INTEGER PRIMARY KEY CHECK (id = 1),
      applying INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO sync_control (id, applying) VALUES (1, 0);

    -- Rows the relay sent that this database would not accept.
    --
    -- Kept rather than dropped, and surfaced in the UI. A rejected row is
    -- almost always a genuine collision (two laptops inventing the same UPC
    -- offline), which is a business problem needing a person — not something to
    -- swallow. Keeping them also means one bad row can never wedge the queue.
    CREATE TABLE IF NOT EXISTS sync_rejects (
      kind   TEXT NOT NULL,
      id     TEXT NOT NULL,
      seq    INTEGER NOT NULL,
      reason TEXT NOT NULL,
      data   TEXT,
      at     TEXT NOT NULL,
      PRIMARY KEY (kind, id)
    ) WITHOUT ROWID;

    -- A public pre-registration link. One per event, revocable, unguessable.
    CREATE TABLE IF NOT EXISTS intake_links (
      id         TEXT PRIMARY KEY,
      token      TEXT NOT NULL UNIQUE,
      label      TEXT NOT NULL DEFAULT '',
      event_name TEXT NOT NULL DEFAULT '',
      event_date TEXT,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      created_by TEXT,
      updated_at TEXT NOT NULL
    );

    -- What a customer typed into that form.
    --
    -- No foreign key to intake_links on purpose: a submission and its link
    -- travel as independent rows, and a submission that lands one round before
    -- its link must not be refused. It carries the token so it can be matched
    -- either way.
    CREATE TABLE IF NOT EXISTS intake_submissions (
      id          TEXT PRIMARY KEY,
      link_id     TEXT NOT NULL DEFAULT '',
      token       TEXT NOT NULL DEFAULT '',
      handle      TEXT NOT NULL DEFAULT '',
      real_name   TEXT NOT NULL DEFAULT '',
      email       TEXT NOT NULL DEFAULT '',
      phone       TEXT NOT NULL DEFAULT '',
      address1    TEXT NOT NULL DEFAULT '',
      address2    TEXT NOT NULL DEFAULT '',
      city        TEXT NOT NULL DEFAULT '',
      state       TEXT NOT NULL DEFAULT '',
      postal_code TEXT NOT NULL DEFAULT '',
      country     TEXT NOT NULL DEFAULT 'US',
      request     TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'new',
      status_note TEXT,
      customer_id TEXT,
      reviewed_at TEXT,
      reviewed_by TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_intake_sub_link
      ON intake_submissions (link_id);
    CREATE INDEX IF NOT EXISTS idx_intake_sub_status
      ON intake_submissions (status, created_at DESC);
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

  // v27: inventory_resets, created by the schema block above. Nothing to
  // backfill — a reset that happened before the table existed did not happen.
  setMeta(database, 'schema_version', '27')

  // v28: server_sessions, likewise created above. Nothing to backfill — before
  // this version there was no server and therefore no sessions.
  setMeta(database, 'schema_version', '28')

  // v30: a flag can be marked handled.
  //
  // Warnings were write-once and read-only: the parser produced them, the Upload
  // tab listed them, and there was no way to say "I looked at this". So a slot
  // titled "#30" instead of a team — a real thing that happens, and correctly
  // NOT a blocker — stayed on the screen forever alongside every other flag from
  // every import, which is how a warning list becomes wallpaper nobody reads.
  addColumnIfMissing(database, 'ship_warnings', 'kind', "TEXT NOT NULL DEFAULT 'parse'")
  addColumnIfMissing(database, 'ship_warnings', 'status', "TEXT NOT NULL DEFAULT 'open'")
  addColumnIfMissing(database, 'ship_warnings', 'resolved_at', 'TEXT')
  addColumnIfMissing(database, 'ship_warnings', 'resolved_by', 'TEXT')
  addColumnIfMissing(database, 'ship_warnings', 'note', 'TEXT')
  setMeta(database, 'schema_version', '30')

  // v29: cloud sync. The tables came from the block above; the capture triggers
  // are installed at the very END of this function — see the note there.
  setMeta(database, 'schema_version', '29')

  // v31: a break is identified by its printed LABEL, not by its number.
  //
  // Shows really do run a "Break #11A". Reading that as 11 means a document
  // containing both #11 and #11A folds sixty cards into one break where every
  // team appears twice — thirty collisions that never happened, and a break
  // nobody can work. The number stays for ordering; two breaks may share it and
  // differ only by their letter.
  addColumnIfMissing(database, 'ship_breaks', 'break_label', 'TEXT')
  addColumnIfMissing(database, 'ship_team_slots', 'break_label', 'TEXT')
  database
    .prepare(
      `UPDATE ship_breaks SET break_label = CAST(break_number AS TEXT) WHERE break_label IS NULL`
    )
    .run()
  database
    .prepare(
      `UPDATE ship_team_slots
          SET break_label = (SELECT b.break_label FROM ship_breaks b WHERE b.id = ship_team_slots.break_id)
        WHERE break_label IS NULL`
    )
    .run()
  // The audit's PRIMARY KEY moves from the number to the label, which SQLite
  // cannot do in place. Rebuilt rather than dropped so the dataset currently on
  // the floor keeps its slate counts instead of going blank until the next
  // import. Guarded on the column, so a fresh database (created label-keyed by
  // the schema block above) skips it.
  const auditCols = database.prepare(`PRAGMA table_info(ship_break_audit)`).all() as Array<{
    name: string
  }>
  if (!auditCols.some((c) => c.name === 'break_label')) {
    database.exec(`
      ALTER TABLE ship_break_audit RENAME TO ship_break_audit_v30;
      CREATE TABLE ship_break_audit (
        break_label        TEXT PRIMARY KEY,
        break_number       INTEGER,
        team_count         INTEGER,
        distinct_team_count INTEGER,
        max_teams          INTEGER,
        missing_count      INTEGER,
        missing_teams      TEXT,
        has_all            INTEGER,
        collisions         TEXT
      );
      INSERT INTO ship_break_audit
        (break_label, break_number, team_count, distinct_team_count, max_teams,
         missing_count, missing_teams, has_all, collisions)
      SELECT CAST(break_number AS TEXT), break_number, team_count, distinct_team_count,
             max_teams, missing_count, missing_teams, has_all, collisions
        FROM ship_break_audit_v30;
      DROP TABLE ship_break_audit_v30;
    `)
  }
  setMeta(database, 'schema_version', '31')

  // v32: the slip stays with the show.
  //
  // Everything needed to work a break was in the database except the one thing
  // the floor actually reads — the printed slip. Two columns make that possible:
  // which pages of the upload belong to which customer, and the file itself.
  // Without the page map there is nothing to turn to when somebody hits "next
  // order", which is the whole point of having the document at all.
  addColumnIfMissing(database, 'ship_customers', 'pages', 'TEXT')
  setMeta(database, 'schema_version', '32')

  // v33: a supply can say WHICH consumable it is.
  //
  // Costing a show produces quantities per role — 390 team bags, 371 top
  // sleeves — and until now nothing connected a role to a row in the supplies
  // list. Matching on the name would be the obvious shortcut and the wrong one:
  // somebody renames "Top sleeves (1000ct)" and the link silently dies.
  //
  // Nullable, because most supplies (tape, boxes, printer ink) are not part of
  // a show's per-pack arithmetic and must stay unlinked. The unique index is
  // partial for the same reason: any number of rows may have no role, but two
  // rows cannot both claim to be the team bags.
  addColumnIfMissing(database, 'supplies', 'ship_role', 'TEXT')
  database.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_supplies_ship_role
       ON supplies (ship_role) WHERE ship_role IS NOT NULL`
  )
  setMeta(database, 'schema_version', '33')

  // v34: the floor's checklist, and the stock it actually moved.
  //
  // RETIRED. The checklist was removed in a later release and nothing reads or
  // writes either table now — they are not in the sync manifest either. They
  // stay in the schema on purpose: dropping a table on somebody's machine cannot
  // be undone, and the rows are the only surviving record of what a past show
  // took off the shelf. The migration is left exactly as it ran, because a
  // migration that changes shape after the fact is a migration nobody can
  // reason about.
  //
  // Two tables, because they answer two different questions and only one of them
  // is allowed to be forgotten.
  //
  // ship_sop_steps is WHERE THE NIGHT IS UP TO — seven ticks against a show.
  // ship_supply_usage is WHAT LEFT THE SHELF — the immutable half. It is what the
  // P&L reads, which is why it is keyed by the show's DATE rather than tied to
  // the active dataset: the day after the next import, last week's packing cost
  // still has to be there.
  //
  // Both ids are DERIVED, not random: 'date|step' and 'date|step|role'. Two
  // laptops ticking the same step off the same show produce the same row id, so
  // the relay merges them into one instead of double-booking the night. The
  // quantity stored is the ABSOLUTE total for that step, never a delta, for the
  // same reason — an absolute converges under last-write-wins, a delta does not.
  database.exec(
    `CREATE TABLE IF NOT EXISTS ship_sop_steps (
       id         TEXT PRIMARY KEY,
       event_date TEXT NOT NULL,
       step       TEXT NOT NULL,
       done       INTEGER NOT NULL DEFAULT 0,
       done_at    TEXT,
       done_by    TEXT,
       updated_at TEXT NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_ship_sop_steps_date ON ship_sop_steps (event_date);

     CREATE TABLE IF NOT EXISTS ship_supply_usage (
       id          TEXT PRIMARY KEY,
       event_date  TEXT NOT NULL,
       step        TEXT NOT NULL,
       role        TEXT NOT NULL,
       supply_id   TEXT,
       supply_name TEXT,
       quantity    INTEGER NOT NULL DEFAULT 0,
       unit_cost   REAL NOT NULL DEFAULT 0,
       total_cost  REAL NOT NULL DEFAULT 0,
       actor_id    TEXT,
       created_at  TEXT NOT NULL,
       updated_at  TEXT NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_ship_supply_usage_date ON ship_supply_usage (event_date);`
  )
  setMeta(database, 'schema_version', '34')

  // v35: which SHOW a checklist row belongs to, not just which day.
  //
  // Both tables key on the date, which is what the P&L needs. It is not enough
  // to say whose night it was. Two shows on one date share every row id, so the
  // second one's ticks overwrite the first's and hand back stock the first show
  // physically used — and correcting a mistyped date strands the old rows where
  // no screen can reach them, so the same night gets deducted twice.
  //
  // The name lets both be caught: a re-key on a date change knows what it is
  // moving, and a second show on an occupied day is refused instead of silently
  // eating the first one. Nullable, because rows written by v0.0.69 have no name
  // and must not lock anybody out of a night they have already half-ticked.
  addColumnIfMissing(database, 'ship_sop_steps', 'event_name', 'TEXT')
  addColumnIfMissing(database, 'ship_supply_usage', 'event_name', 'TEXT')
  setMeta(database, 'schema_version', '35')

  // v36: which catalog product a whole-product sale was.
  //
  // A sale that is a sealed box rather than a break spot names the product in
  // its message — "2025-26 Topps Chrome Cactus Jack Basketball Hobby Box" — and
  // that is a row in the catalog. Resolving it at import time and storing the id
  // is what lets the sale be costed against what the box actually cost, instead
  // of being revenue with no cost of goods behind it.
  //
  // Nullable and unconstrained on purpose. A product that is not in the catalog
  // yet, or a name nobody can match, must leave the sale intact and unmatched
  // rather than refuse the import — and a product later deleted must not take
  // the sale with it, which is why there is no foreign key.
  addColumnIfMissing(database, 'ledger_rows', 'product_id', 'TEXT')
  addColumnIfMissing(database, 'ledger_rows', 'product_name', 'TEXT')
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_ledger_rows_product ON ledger_rows (product_id)`
  )
  setMeta(database, 'schema_version', '36')

  // v37: notes the floor sends to the owner.
  //
  // The one thing on the owner's board that is not a view of something else.
  // Kept as small as it can be on purpose: a body, who sent it, and whether it
  // has been dealt with. No threads and no replies — the ask was an inbox, and
  // the first schema that carries a `parent_id` is a messaging product nobody
  // asked for.
  //
  // `from_id` is unconstrained for the same reason every other actor column in
  // this database is: an employee leaving must not delete what they told
  // somebody, it should just stop naming them.
  database.exec(
    `CREATE TABLE IF NOT EXISTS reminders (
       id         TEXT PRIMARY KEY,
       body       TEXT NOT NULL,
       from_id    TEXT,
       status     TEXT NOT NULL DEFAULT 'open',
       due_date   TEXT,
       urgent     INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL,
       done_at    TEXT,
       done_by    TEXT
     );
     CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders (status, created_at);`
  )
  setMeta(database, 'schema_version', '37')

  // v38: an account that is a COMPUTER rather than a person.
  //
  // The shipping benches share machines. Making each packer an employee row
  // with an email address they do not have is how a floor ends up with six
  // people signed in as whoever set the laptop up — so a station is its own
  // kind of account: a name, a code and a password, no email, and only the
  // permissions the bench needs.
  //
  // The email column stays NOT NULL rather than being rebuilt. Rebuilding the
  // root table every other table points at, to make one column nullable, is a
  // real risk taken for a cosmetic gain; a station stores a synthetic
  // `station:<code>` value that cannot be confused for an address, and
  // `account_kind` is what any screen actually reads to decide what it is
  // looking at.
  //
  // SINCE RETIRED, and the column deliberately kept. The shipping ROLE replaced
  // this: it gives a person the packing floor and nothing else, which is the
  // same outcome with one mechanism instead of two, so nothing writes 'station'
  // any longer. What is left is a column that still reads 'person' for every
  // new row and 'station' for the handful written while the idea existed — and
  // dropping it would mean the very table rebuild the paragraph above declined,
  // for a column that costs nothing. Those rows are not deleted either: they can
  // own time entries and picked cards, and stationRoster() in shipStations.ts still
  // reads this column to keep a computer out of the picking roster.
  addColumnIfMissing(database, 'employees', 'account_kind', "TEXT NOT NULL DEFAULT 'person'")
  setMeta(database, 'schema_version', '38')

  // v39: who has which order right now — the pick → pack handoff.
  //
  // ## The claim is ADVISORY, and that is the safety property
  //
  // Delete every row in `ship_work_claims` and the night is unchanged. The pick
  // work lives in ship_team_slots.checked_off; the pack work lives in
  // ship_shipments.packed_at. Both already exist and already sync. A claim only
  // answers "who has this right now" — so the worst a race can do is two people
  // briefly on one order, never a card that loses its finder or an order that
  // vanishes from both queues.
  //
  // ## Why not a lock
  //
  // The relay has no compare-and-swap: /v1/push is an unconditional upsert
  // guarded by a timestamp. A lock is not available, and pretending otherwise
  // is how you get a design that only works on one laptop.
  //
  // So: EVERY COLUMN HERE IS WRITTEN BY EXACTLY ONE DEVICE — the station named
  // in station_id, which created the row. No row is ever written by two
  // machines, so last-write-wins has nothing to arbitrate; the relay only ever
  // compares a row against an older copy of itself from the same writer. Who
  // holds an order is DERIVED from the row set by a pure function every machine
  // evaluates identically. That is inventory_stock's bargain — publish the
  // authored facts, derive the contended answer — applied to a lock we cannot
  // have.
  //
  // ## Why the id is random rather than derived
  //
  // The SOP tables converge by deriving ids so two benches asserting the same
  // fact write the SAME row. That works because their fact is shared and
  // single-valued ("sleeving is done"). A claim is the opposite: two machines
  // assert mutually exclusive things, so a derived id would make them collide
  // ON PURPOSE and let two wall clocks pick the winner — with the loser's row
  // REPLACED, leaving no record it ever existed.
  //
  // Keying on (order|role|station) would be collision-free, and is still wrong:
  // it makes the row mutable in place, and `supersedes` then admits cycles — A
  // displaced B while B's row still names A — after which two machines disagree
  // about who is dead, permanently.
  //
  // Operator state, NOT dataset rows: an import does not wipe this. A claim is
  // made INERT by falling off the carry-forward chain, never by a write — see
  // ship_imports.carried_from below.
  database.exec(
    `CREATE TABLE IF NOT EXISTS ship_work_claims (
       id            TEXT PRIMARY KEY,
       order_id      TEXT NOT NULL,
       customer_id   TEXT NOT NULL,
       import_id     TEXT NOT NULL,
       role          TEXT NOT NULL,
       station_id    TEXT NOT NULL,
       operator_id   TEXT,
       login_user_id TEXT,
       claimed_at    TEXT NOT NULL,
       heartbeat_at  TEXT NOT NULL,
       finished_at   TEXT,
       released_at   TEXT,
       supersedes    TEXT,
       note          TEXT
     );
     CREATE INDEX IF NOT EXISTS idx_ship_claims_order  ON ship_work_claims (order_id, role);
     CREATE INDEX IF NOT EXISTS idx_ship_claims_import ON ship_work_claims (import_id);
     CREATE INDEX IF NOT EXISTS idx_ship_claims_station ON ship_work_claims (station_id);

     -- Who is standing at THIS machine, and which job they picked.
     --
     -- Deliberately NOT synced — the same category as server_sessions, machine
     -- local by definition. What travels is the CONSEQUENCE: operator_id
     -- denormalised onto every claim row and into checked_off_by / packed_by,
     -- so another laptop still sees "Maria, picking" without this table ever
     -- leaving the machine and without two stations' choices arbitrating.
     CREATE TABLE IF NOT EXISTS ship_station_sessions (
       station_id    TEXT PRIMARY KEY,
       operator_id   TEXT NOT NULL,
       role          TEXT NOT NULL,
       login_user_id TEXT,
       started_at    TEXT NOT NULL,
       seen_at       TEXT NOT NULL,
       ended_at      TEXT
     );`
  )

  // Which import an import CARRIED FORWARD FROM.
  //
  // `counts` already records carriedForward as a boolean, which says that it
  // happened and not what it happened FROM. The pipeline needs the edge: a
  // claim is live only while its import is on the chain of carry-forwards
  // ending at the import on the floor now.
  //
  // That makes "does this in-flight claim survive the import" a walk over
  // immutable rows rather than a write onto everyone else's claims mid-shift —
  // and the difference matters, because closing a claim by writing to a row a
  // station is concurrently heartbeating puts the two in an LWW contest the
  // close can simply lose.
  //
  // Written once, by the machine that imports, in the same transaction as the
  // row, and never updated. Two machines never mint the same import id.
  addColumnIfMissing(database, 'ship_imports', 'carried_from', 'TEXT')

  // The same scoping, applied to a bug that has been live since assignments
  // shipped.
  //
  // Break ids are `break_<label>` and labels RECUR — every show has a break 3,
  // a break 4, a break 11. The prune only removes an assignment whose break is
  // ABSENT, so assigning somebody to break 11 tonight and importing next
  // Tuesday's show, which also has a break 11, silently carries them onto a
  // different pile of cards. Nobody is told, and the board looks correct.
  //
  // Stamping the import an assignment was made against turns "is this still
  // mine" into the same chain walk the work claims use. Rows written before
  // this column existed carry NULL and are treated as belonging to the current
  // show, so an upgrade mid-shift does not wipe the board.
  addColumnIfMissing(database, 'ship_break_assignments', 'import_id', 'TEXT')

  // One flag was doing two jobs.
  //
  // SOP step 1 is "Sleeving and top loading" and consumes TWO supplies at two
  // different rates — a top sleeve on 95% of packs, a toploader on 50%. There
  // was a single `top_sleeved` boolean per card, so the floor could record that
  // a card had been "done" and nothing could say which of the two things had
  // happened. It also recorded no WHO and no WHEN, unlike checked_off beside
  // it, so per-card sleeve attribution did not exist at all.
  //
  // `top_sleeved` is left in place and keeps its meaning as the toploader flag.
  // Renaming a column on a synced table to gain a clearer name would strand
  // every laptop on an older build, and the value already means "top loaded" to
  // every row that has one.
  addColumnIfMissing(database, 'ship_team_slots', 'sleeved', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing(database, 'ship_team_slots', 'sleeved_at', 'TEXT')
  addColumnIfMissing(database, 'ship_team_slots', 'sleeved_by', 'TEXT')
  addColumnIfMissing(database, 'ship_team_slots', 'top_sleeved_at', 'TEXT')
  addColumnIfMissing(database, 'ship_team_slots', 'top_sleeved_by', 'TEXT')
  // A card already marked top-loaded was sleeved too — that is what the single
  // flag meant when it was written. Backfilling keeps the history honest rather
  // than showing a night's work as half done.
  runOnce(database, 'sleeved_from_top_sleeved_v1', () =>
    database.prepare(`UPDATE ship_team_slots SET sleeved = 1 WHERE top_sleeved = 1`).run()
  )
  setMeta(database, 'schema_version', '39')

  // v40: what the stock on a RECONCILED show actually cost.
  //
  // A line added to a show that is already history is not a stock movement. The
  // cases were broken weeks ago and left the shelf weeks ago, so there is
  // nothing on hand to consume and no cost layer to read a price off — the
  // ordinary path would either drive the count negative or, worse, quietly eat
  // layers bought since, and cost a two-month-old show at this month's prices.
  //
  // What the person entering it DOES know is what those cases were bought at.
  // They state it, and this column keeps that assertion beside the line, which
  // makes `cost_total` a fact somebody asserted rather than an average the app
  // inferred.
  //
  // It is also the switch. A row with a price here moved no stock and consumed
  // no lot, so removing it must hand nothing back; `restoreItemStock` reads
  // exactly this column to decide. NULL on every ordinary line and on every row
  // written before this shipped — which is precisely what those lines are, stock
  // movements valued at the layers they took.
  addColumnIfMissing(database, 'stream_items', 'stated_case_price', 'REAL')
  setMeta(database, 'schema_version', '40')

  // v42: what Whatnot's commission was, by date range.
  //
  // The table is created idempotently above and this version adds nothing else.
  // There is deliberately NO backfill and no seed row: an empty table means
  // "6% everywhere", which is what the app assumed before this shipped and what
  // it still assumes for any day no period covers. Seeding a 6% row spanning
  // history would look like a decision somebody made and would have to be edited
  // around the first time a real rate change was entered.
  //
  // The correction that came WITH it is not a migration either, because nothing
  // stored was wrong: the ledger's Amount was always the net figure. What was
  // wrong was the code reading it as gross and taking 8.9% off it a second time,
  // which understated a ten-day export's revenue by about $35,000. Fees are
  // derived on read, so every stored row starts reporting correctly the moment
  // this build opens the database. Nothing to re-import.
  setMeta(database, 'schema_version', '42')

  // v43: a rate period carries ALL FOUR of the platform's terms.
  //
  // The commission alone could never reproduce a payout. Whatnot charges card
  // processing on the ORDER TOTAL — item price plus shipping plus sales tax —
  // so the tax rate is an input to the fee even though the tax itself is
  // neither revenue nor a cost, and the flat charge per order is the other half
  // of a card fee that a percentage alone gets wrong on every small spot.
  //
  // Existing rows take the defaults, which is exactly what they were being
  // priced at before this shipped: the rates were constants in the contract
  // rather than columns, so nothing about a stored period changes meaning. The
  // commission stays in `rate` under its original name — renaming a column on a
  // SYNCED table would strand every laptop still on the older build.
  //
  // Still no backfill and still no seed row. An empty table means the contract's
  // defaults everywhere, which is what the app assumes for any night no period
  // covers, and a seeded row would look like a decision somebody made.
  addColumnIfMissing(database, 'whatnot_fee_periods', 'tax_rate', 'REAL NOT NULL DEFAULT 0.0518')
  addColumnIfMissing(database, 'whatnot_fee_periods', 'processing_rate', 'REAL NOT NULL DEFAULT 0.029')
  addColumnIfMissing(
    database, 'whatnot_fee_periods', 'processing_flat_cents', 'INTEGER NOT NULL DEFAULT 30'
  )
  setMeta(database, 'schema_version', '43')

  // v44: general expenses — the one figure on a day nobody imported.
  //
  // The table is created idempotently above and this version adds nothing else.
  // There is deliberately no backfill: an empty table means no write-offs were
  // recorded, which is the truth for every day that has ever been imported, and
  // inferring one from a giveaway line would double-count the very stock movement
  // this is explicitly NOT for.
  // v45: the clock-in portal's PIN.
  //
  // A SECOND credential beside password_hash, not a replacement for it. The
  // portal runs in a Cloudflare Worker on the free plan, where an invocation is
  // killed after 10ms of CPU and one bcrypt-cost-12 verification is thirty
  // times that. So the portal gets a PBKDF2 hash it can actually check, and the
  // app password is left exactly as it was — see @shared/portalPin.
  //
  // Ordinary employees columns on purpose: `employees` is already tier 0 in the
  // sync manifest, so a PIN set on any laptop reaches the relay — and therefore
  // the portal — through machinery that already exists. Nothing portal-specific
  // had to be added to sync at all.
  //
  // Null for everybody until somebody sets one, and a null hash means the
  // portal refuses that employee. No backfill: a PIN nobody chose is a PIN
  // nobody was told, and inventing one would put a live credential on every
  // account in the company without anyone asking for it.
  addColumnIfMissing(database, 'employees', 'portal_pin_hash', 'TEXT')
  addColumnIfMissing(database, 'employees', 'portal_pin_set_at', 'TEXT')
  setMeta(database, 'schema_version', '45')

  // v46: the packing slip reaches everybody.
  //
  // The table is created idempotently above, so this version adds no column and
  // no backfill — and the absence of a backfill is deliberate. Slicing the slip
  // already on THIS machine would queue several megabytes to the relay from
  // whichever laptop happened to open the app first after updating, for a show
  // that is very likely finished. The next import publishes itself, which is the
  // moment the paper is actually wanted.
  setMeta(database, 'schema_version', '46')

  // v47: the to-do list on the home page.
  //
  // A checklist somebody keeps for themselves — payroll, hire a breaker, call
  // the supplier — and deliberately NOT the same thing as `reminders`, which is
  // an inbox: notes the floor sends TO the owner, carrying who sent them. One is
  // "somebody asked me to"; the other is "I said I would". Folding them into one
  // table would mean a screen that cannot tell a request apart from a plan.
  //
  // PER PERSON, keyed by owner_id. A single shared list would put "Payroll" in
  // front of every packer, and a packer's own list in front of the owner. Each
  // row therefore has exactly one author and one reader, which is also what makes
  // it safe to sync: last-write-wins only ever compares a row against an older
  // copy of ITSELF, from the same person, on their other machine.
  database.exec(
    `CREATE TABLE IF NOT EXISTS todos (
       id         TEXT PRIMARY KEY,
       owner_id   TEXT NOT NULL,
       body       TEXT NOT NULL,
       done       INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       done_at    TEXT
     );
     CREATE INDEX IF NOT EXISTS idx_todos_owner ON todos (owner_id, done, created_at);`
  )
  setMeta(database, 'schema_version', '47')

  // v48: jobs on a clock.
  //
  // Payroll every second Wednesday is a real obligation that no table in this
  // app can observe — nothing records that it happened, so nothing can notice
  // that it did not. A note somebody writes once is worse than useless: it is
  // ticked, disappears, and the next fortnight arrives unannounced.
  //
  // So the SERIES is stored and each occurrence is derived from it. anchor_date
  // is any date the job IS due and every_days is the stride; ticking records
  // WHICH occurrence was done in last_done_on, which is what makes the next one
  // come back on its own. See recurringDue() in @shared/homeTasks for the
  // arithmetic, and note the deliberate rule there: an occurrence nobody ticked
  // stays on the list rather than rolling forward, because a payroll run missed
  // on Wednesday is not less due on Thursday.
  database.exec(
    `CREATE TABLE IF NOT EXISTS recurring_tasks (
       id           TEXT PRIMARY KEY,
       owner_id     TEXT NOT NULL,
       title        TEXT NOT NULL,
       every_days   INTEGER NOT NULL,
       anchor_date  TEXT NOT NULL,
       lead_days    INTEGER NOT NULL DEFAULT 2,
       last_done_on TEXT,
       active       INTEGER NOT NULL DEFAULT 1,
       created_at   TEXT NOT NULL,
       updated_at   TEXT NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_recurring_owner ON recurring_tasks (owner_id, active);`
  )
  setMeta(database, 'schema_version', '48')

  // v49: the rota. Who is DUE in, as opposed to who has clocked in.
  //
  // The app could answer the second question and not the first, and said so on
  // the home page rather than guessing — an open time entry proves somebody is
  // standing in the building, and nothing anywhere recorded an intention. A
  // packer asking what shifts they have next week is asking the first question,
  // so the first question needed a table.
  //
  // WALL CLOCK, not an instant, and this is the load-bearing decision. A shift
  // is a local calendar day plus local HH:MM: "you are in at 4pm on Thursday"
  // stays 4pm across a daylight-saving boundary and stays Thursday. Storing it
  // as a UTC instant would slide the rota by an hour twice a year and would put
  // a 7pm Chicago shift on the following day's screen — which is precisely the
  // bug the "employees today" card had to be fixed for, reintroduced somewhere
  // far harder to notice. time_entries stays the opposite and stays an instant,
  // because a clock-in is a physical event rather than a plan.
  //
  // No foreign key on employee_id, matching every other table here: the sync
  // relay applies rows one at a time on the recovery path, and a shift arriving
  // before the employee row it names must land rather than be rejected.
  database.exec(
    `CREATE TABLE IF NOT EXISTS shifts (
       id          TEXT PRIMARY KEY,
       employee_id TEXT NOT NULL,
       shift_date  TEXT NOT NULL,
       start_time  TEXT,
       end_time    TEXT,
       note        TEXT,
       created_by  TEXT,
       created_at  TEXT NOT NULL,
       updated_at  TEXT NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_shifts_person ON shifts (employee_id, shift_date);
     CREATE INDEX IF NOT EXISTS idx_shifts_day    ON shifts (shift_date);`
  )
  setMeta(database, 'schema_version', '49')

  // v50: availability — what somebody says about a day BEFORE anybody is put
  // on it.
  //
  // The other half of the rota, and the half that decides whether the rota is
  // any good. A lead filling Thursday is guessing unless the people who work
  // Thursday have said something, and the way that gets said today is a text
  // message nobody can see a week later.
  //
  // TWO STATEMENTS, not one flag. "I can work Thursday" and "I cannot work
  // Thursday" are both things somebody chose to say, and a day they have said
  // NOTHING about is a third state that must stay distinct from both — a
  // boolean would make silence mean either "nobody may be rostered until they
  // opt in" or "nobody's day off is ever respected", and both are wrong.
  //
  // THE ID IS DERIVED from the person and the day, not a UUID, and that is what
  // makes this safe to sync. Two machines recording the same person's answer
  // for the same day mint the SAME id, so last-write-wins compares a row
  // against an older copy of itself and the later answer wins — which is
  // exactly the right outcome for somebody changing their mind. A UUID here
  // would produce two rows saying opposite things with nothing to choose
  // between them. Same pattern as the supply-usage rows.
  database.exec(
    `CREATE TABLE IF NOT EXISTS availability (
       id          TEXT PRIMARY KEY,
       employee_id TEXT NOT NULL,
       day         TEXT NOT NULL,
       status      TEXT NOT NULL,
       start_time  TEXT,
       end_time    TEXT,
       note        TEXT,
       created_at  TEXT NOT NULL,
       updated_at  TEXT NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_avail_person ON availability (employee_id, day);
     CREATE INDEX IF NOT EXISTS idx_avail_day    ON availability (day);`
  )
  setMeta(database, 'schema_version', '50')

  // v51: the USUAL WEEK — a repeating availability pattern.
  //
  // v50 let somebody answer for a date. It turns out that is not how anybody
  // thinks about their own life: they think "I work Mondays, Wednesdays and
  // Fridays, and I have class on Tuesday" — a shape that repeats — and asking
  // them to express that by tapping thirty squares a month is asking them to do
  // arithmetic on their own routine. They would do it once and never again,
  // which is the same as not having the feature at all.
  //
  // So this is the PRIMARY way to answer and a dated row is now the EXCEPTION:
  // "I normally do Thursdays, but not this Thursday."
  //
  // EVALUATED, NEVER EXPANDED. The pattern is not turned into dated rows.
  // Expanding "every Monday" would write hundreds of records, make changing
  // your mind mean rewriting all of them, and hand the relay hundreds of rows
  // to arbitrate where one fact changed. The answer for a day is worked out at
  // read time — see effectiveAvailability in @shared/schedule — which is also
  // what keeps the three states honest: a day nobody has spoken about is still
  // silent whether the silence is a missing override or an empty pattern.
  //
  // Seven rows per person at most, with the same derived id as v50 and for the
  // same reason: two machines editing the same weekday write the same row, so
  // last-write-wins compares it against an older copy of itself.
  database.exec(
    `CREATE TABLE IF NOT EXISTS availability_pattern (
       id          TEXT PRIMARY KEY,
       employee_id TEXT NOT NULL,
       weekday     INTEGER NOT NULL,
       status      TEXT NOT NULL,
       start_time  TEXT,
       end_time    TEXT,
       note        TEXT,
       created_at  TEXT NOT NULL,
       updated_at  TEXT NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_avpat_person ON availability_pattern (employee_id);`
  )
  setMeta(database, 'schema_version', '51')

  // v52: invoices — the SELL side, and the mirror image of a purchase order.
  //
  // A PO is money committed to a supplier. An invoice is money owed TO this
  // business: a buyer, what they bought, the price agreed, a total. Same shape,
  // opposite direction.
  //
  // THE COLUMNS ARE INTUIT'S. The owner supplied QuickBooks' own invoice-import
  // template, and its fields are modelled here verbatim — not because a CSV
  // should drive a schema, but because those columns ARE an invoice as
  // QuickBooks understands one, and the whole purpose of this module is to
  // produce something QuickBooks will accept. Inventing a different set and
  // mapping it afterwards is how an export ends up with a column nobody can
  // fill in.
  database.exec(
    `CREATE TABLE IF NOT EXISTS invoice_customers (
       id         TEXT PRIMARY KEY,
       name       TEXT NOT NULL,
       email      TEXT,
       terms      TEXT NOT NULL DEFAULT 'Net 30',
       location   TEXT,
       class_name TEXT,
       message    TEXT,
       notes      TEXT,
       qbo_id     TEXT,
       active     INTEGER NOT NULL DEFAULT 1,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_inv_cust_name ON invoice_customers (name);

     -- customer_name is SNAPSHOTTED, not joined. A buyer renamed next year must
     -- not silently rewrite a document that has already been sent: an invoice is
     -- a record of what was said, not a view of who somebody is now. The id is
     -- kept alongside so "their other invoices" still works, and is allowed to
     -- go null when the buyer record is deleted.
     CREATE TABLE IF NOT EXISTS invoices (
       id             TEXT PRIMARY KEY,
       invoice_number TEXT,
       customer_id    TEXT,
       customer_name  TEXT NOT NULL,
       email          TEXT,
       terms          TEXT NOT NULL DEFAULT 'Net 30',
       invoice_date   TEXT NOT NULL,
       due_date       TEXT NOT NULL,
       location       TEXT,
       memo           TEXT,
       message        TEXT,
       send_later     INTEGER NOT NULL DEFAULT 0,
       class_name     TEXT,
       status         TEXT NOT NULL DEFAULT 'draft',
       qbo_id         TEXT,
       qbo_doc_number TEXT,
       qbo_synced_at  TEXT,
       total          REAL NOT NULL DEFAULT 0,
       created_by     TEXT,
       created_at     TEXT NOT NULL,
       updated_at     TEXT NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices (customer_id);
     CREATE INDEX IF NOT EXISTS idx_invoices_date     ON invoices (invoice_date);
     CREATE INDEX IF NOT EXISTS idx_invoices_number   ON invoices (invoice_number);

     -- The amount column is stored rather than derived, and that is deliberate:
     -- the agreed price is the fact and is ALLOWED to disagree with qty x rate.
     -- A buyer talked down to a round number is a real thing on this floor, and
     -- an invoice that silently recomputed it would quietly overcharge them.
     CREATE TABLE IF NOT EXISTS invoice_lines (
       id          TEXT PRIMARY KEY,
       invoice_id  TEXT NOT NULL,
       position    INTEGER NOT NULL DEFAULT 0,
       item        TEXT NOT NULL,
       description TEXT,
       quantity    REAL NOT NULL DEFAULT 1,
       rate        REAL NOT NULL DEFAULT 0,
       amount      REAL NOT NULL DEFAULT 0,
       tax_rate    TEXT,
       class_name  TEXT,
       created_at  TEXT NOT NULL,
       updated_at  TEXT NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_invoice_lines_inv ON invoice_lines (invoice_id, position);`
  )
  setMeta(database, 'schema_version', '52')

  // v53: an invoice can be PAID, and this app is allowed to say so.
  //
  // The first cut deliberately stopped at Sent, on the argument that QuickBooks
  // knows when money arrived and this does not. That was right about the
  // plumbing and wrong about the job: the owner's question is "which ones are
  // paid", and a board that cannot answer it sends him to a second system to
  // find out. So paid is an OPERATOR-RECORDED fact — somebody ticks it when the
  // money lands — with paid_at recording when, and the screen says plainly that
  // it is a note rather than a bank feed.
  addColumnIfMissing(database, 'invoices', 'paid_at', 'TEXT')
  addColumnIfMissing(database, 'invoices', 'paid_by', 'TEXT')
  setMeta(database, 'schema_version', '53')

  // v54: how it travels, and when it gets paid for.
  //
  // The same four facts on BOTH sides of the money — a purchase order ships a
  // box in and an invoice ships one out, and each settles at some point. Two
  // separate sets of columns would drift the first time a carrier was added, so
  // the vocabulary lives in @shared/freight and both tables carry the same
  // names.
  //
  // TRACKING IS A NUMBER, NOT A FEED. Real carrier status needs a developer
  // account, an OAuth dance and a set of secrets per carrier, on every machine
  // — three integrations to save a click on fifteen packages a day. So the
  // number is stored, the carrier is DETECTED from it, and the carrier's own
  // tracking page is one click away: live and authoritative because it is
  // theirs, rather than copied here where it can go stale. If per-package
  // status ever earns its keep, these two columns are already its only inputs.
  for (const table of ['purchase_orders', 'invoices']) {
    addColumnIfMissing(database, table, 'carrier', 'TEXT')
    addColumnIfMissing(database, table, 'service', 'TEXT')
    addColumnIfMissing(database, table, 'tracking_number', 'TEXT')
    // 'front' | 'delivery' | NULL. Null is a real third state: plenty of orders
    // are placed before anybody has decided, and defaulting to either answer
    // would put a claim on the record that nobody made.
    addColumnIfMissing(database, table, 'payment_timing', 'TEXT')
  }
  setMeta(database, 'schema_version', '54')

  // v55: the bench checklist — what happens to a break before anything ships.
  //
  // Three steps per break: sleeve and top-load, sort into trays by team, then
  // team-bag and sticker each team against its buyer. See @shared/breakSteps
  // for why the first two are one tick each and the third is thirty.
  //
  // Steps 1 and 2 are stamps on the break itself. A boolean would say the pile
  // was sleeved without saying by whom, and the one question asked about a
  // mis-sleeved break is who had it.
  addColumnIfMissing(database, 'ship_breaks', 'sleeved_at', 'TEXT')
  addColumnIfMissing(database, 'ship_breaks', 'sleeved_by', 'TEXT')
  addColumnIfMissing(database, 'ship_breaks', 'sorted_at', 'TEXT')
  addColumnIfMissing(database, 'ship_breaks', 'sorted_by', 'TEXT')

  // Step 3 for the teams NOBODY BOUGHT.
  //
  // All thirty teams are physically in the box and all thirty get bagged, but
  // only the sold ones have a ship_team_slots row to carry the tick — an unsold
  // team exists solely in the import's slate audit. Rather than fabricate card
  // rows for them (which would land in sales and the ledger as phantom orders
  // at zero, and corrupt every count derived from slots), the unsold ones get
  // this small side record. Sold teams keep using the pick list's existing
  // checkmark, so nothing is ticked twice.
  //
  // The id is DERIVED from the break and the team, never random: two laptops
  // bagging the same team must write the SAME row, so last-write-wins compares
  // a row against an older copy of itself instead of choosing between two rows
  // that describe one bag. Same rule as the availability and shift ids.
  database.exec(`
    CREATE TABLE IF NOT EXISTS ship_break_team_bags (
      id         TEXT PRIMARY KEY,
      break_id   TEXT NOT NULL,
      team_name  TEXT NOT NULL,
      bagged_at  TEXT,
      bagged_by  TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ship_bags_break ON ship_break_team_bags (break_id);
  `)

  // Where a team printed, so the on-screen list walks in the same order as the
  // stack of paper. Null on anything imported before this, and null forever for
  // a team nobody bought — it appears on no slip — and both sort last rather
  // than claiming a position they do not have.
  addColumnIfMissing(database, 'ship_team_slots', 'slip_page', 'INTEGER')
  addColumnIfMissing(database, 'ship_team_slots', 'slip_position', 'INTEGER')
  setMeta(database, 'schema_version', '55')

  // v56: where the package has got to, read off the carrier's own page.
  //
  // Four columns rather than one, because a status without provenance is a
  // status nobody can judge:
  //   tracking_status        one of ShipStatusCode — the seven words already
  //                          used by the shipping tracker, not a second set
  //   tracking_status_detail the carrier's own sentence, kept verbatim so a
  //                          human can see what the parse was based on
  //   tracking_status_at     when the CARRIER says it happened
  //   tracking_checked_at    when WE last managed to read the page
  //
  // The last one is the important one. A reading that fails must never
  // overwrite one that worked — stale-but-true beats fresh-and-wrong when the
  // question is whether somebody's cards arrived — so the screen shows how old
  // the answer is instead of implying it is current.
  for (const table of ['purchase_orders', 'invoices']) {
    addColumnIfMissing(database, table, 'tracking_status', 'TEXT')
    addColumnIfMissing(database, table, 'tracking_status_detail', 'TEXT')
    addColumnIfMissing(database, table, 'tracking_status_at', 'TEXT')
    addColumnIfMissing(database, table, 'tracking_checked_at', 'TEXT')
  }
  setMeta(database, 'schema_version', '56')

  // v57: why the last read failed, and when it was attempted.
  //
  // A failed read still writes nothing to the STATUS — that rule stands, and it
  // is what keeps a working answer from being replaced by a bad afternoon at a
  // carrier. But writing nothing at all left the card blank, and a blank card
  // cannot tell "nobody has checked yet" from "we checked and FedEx refused".
  // Those need different reactions from a person, so they are now different
  // things on screen.
  //
  // Separate from tracking_checked_at on purpose: `checked_at` means "we got an
  // answer", `attempted_at` means "we asked". Merging them would make a card
  // claim the carrier confirmed something it never said.
  for (const table of ['purchase_orders', 'invoices']) {
    addColumnIfMissing(database, table, 'tracking_error', 'TEXT')
    addColumnIfMissing(database, table, 'tracking_attempted_at', 'TEXT')
  }
  setMeta(database, 'schema_version', '57')

  // v58: everything the QuickBooks invoice FORM has that this app was not
  // sending, plus an honest record of whether the push worked.
  //
  // ## The bill-to address
  //
  // Their invoice screen shows a name, a street, and a city/state/zip, and this
  // app held none of it. Two places, on purpose: the buyer record carries the
  // address they use, and the invoice SNAPSHOTS it — the same rule that already
  // applies to customer_name. A buyer who moves next year must not rewrite where
  // last year's document says it went.
  //
  // Nullable throughout, and a partial address is legal. A buyer with a city and
  // no street is a real record here, and refusing to store one only means the
  // address gets typed into the memo instead. The posting code falls back to the
  // address QuickBooks already holds for the matched customer, which is exactly
  // what their own form does when you pick somebody.
  for (const table of ['invoice_customers', 'invoices']) {
    addColumnIfMissing(database, table, 'bill_line1', 'TEXT')
    addColumnIfMissing(database, table, 'bill_line2', 'TEXT')
    addColumnIfMissing(database, table, 'bill_city', 'TEXT')
    // State or province. Intuit calls this CountrySubDivisionCode; nothing on a
    // screen in this app should have to.
    addColumnIfMissing(database, table, 'bill_region', 'TEXT')
    addColumnIfMissing(database, table, 'bill_postal_code', 'TEXT')
    addColumnIfMissing(database, table, 'bill_country', 'TEXT')
  }

  // ## The line's product, and its SKU
  //
  // An invoice line was free text: a product name somebody typed. That is the
  // reason posting could only ever match a QuickBooks item BY NAME, which fails
  // the moment an item is renamed there — and fails silently in the worse
  // direction if a different item has since taken the old name.
  //
  // product_id links the line to the catalog. sku is SNAPSHOTTED beside it, not
  // joined, for the same reason the buyer's name is: a SKU corrected next year
  // must not rewrite a document already sent. The posting code matches on the
  // SKU first and only falls back to the name.
  //
  // Both stay nullable, and that is not laziness. Plenty of what gets billed
  // here is a service or a one-off that was never stock, and a line typed
  // freehand has to keep working exactly as it did.
  addColumnIfMissing(database, 'invoice_lines', 'product_id', 'TEXT')
  addColumnIfMissing(database, 'invoice_lines', 'sku', 'TEXT')

  // ## Whether the push worked
  //
  // An invoice now goes to QuickBooks on save, and the local write happens
  // FIRST. That ordering is the whole point: a refused push must leave a saved
  // invoice somebody can retry, never a lost one. These columns are what make a
  // retry possible instead of a re-type.
  //
  // qbo_push_state is none / pending / ok / failed. Pending is written before
  // the network call and cleared after it, so a crash between the two leaves a
  // row saying "we may have posted this" rather than one saying "never tried" —
  // the difference between checking QuickBooks and creating the invoice twice.
  addColumnIfMissing(database, 'invoices', 'qbo_push_state', "TEXT NOT NULL DEFAULT 'none'")
  addColumnIfMissing(database, 'invoices', 'qbo_push_error', 'TEXT')
  addColumnIfMissing(database, 'invoices', 'qbo_push_attempted_at', 'TEXT')
  addColumnIfMissing(database, 'invoices', 'qbo_push_attempts', 'INTEGER NOT NULL DEFAULT 0')

  // Anything already in QuickBooks was pushed successfully, whenever that was.
  // Without this every historic invoice reads as never-attempted and would show
  // up on a retry list that would then post it a second time.
  database
    .prepare(`UPDATE invoices SET qbo_push_state = 'ok' WHERE qbo_id IS NOT NULL AND qbo_id != ''`)
    .run()

  // ## What QuickBooks says about it now
  //
  // Read back, never written by us. Stored with the same provenance discipline
  // as the carrier tracking columns above, and for the same reason: the answer
  // comes from somebody else's system over a network allowed to be down, so a
  // reading that FAILS must not overwrite one that worked. checked_at means we
  // got an answer; attempted_at means we asked.
  //
  // Three of the five states the owner asked for are genuinely in this API and
  // two are not. Sent is EmailStatus / DeliveryInfo, paid is Balance against
  // TotalAmt, open is the absence of both. VIEWED BY THE PAYER IS NOT EXPOSED AT
  // ALL — it is an e-invoicing signal in their web UI with no field behind it —
  // and PAYOUT SENT belongs to QuickBooks Payments, a different API behind a
  // scope this app does not request. There are deliberately no columns for those
  // two: a column that can never be filled is a promise the screen would make
  // and the API would break. See @shared/invoices for the full accounting.
  addColumnIfMissing(database, 'invoices', 'qbo_email_status', 'TEXT')
  addColumnIfMissing(database, 'invoices', 'qbo_delivered_at', 'TEXT')
  addColumnIfMissing(database, 'invoices', 'qbo_balance', 'REAL')
  addColumnIfMissing(database, 'invoices', 'qbo_total_amt', 'REAL')
  // v3 has no status field for a voided invoice. The recognised signature is a
  // zeroed invoice whose private note begins with the word Voided, which is a
  // heuristic and is only ever allowed to move an invoice INTO void.
  addColumnIfMissing(database, 'invoices', 'qbo_voided', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing(database, 'invoices', 'qbo_status_checked_at', 'TEXT')
  addColumnIfMissing(database, 'invoices', 'qbo_status_attempted_at', 'TEXT')
  addColumnIfMissing(database, 'invoices', 'qbo_status_error', 'TEXT')
  setMeta(database, 'schema_version', '58')

  // v59: a buyer has a phone number.
  //
  // Added for the QuickBooks Customer Contact List importer, which is the first
  // thing in this app that has ever had one to store — the buyer record was
  // built from Intuit's INVOICE template, and an invoice has no phone field on
  // it. Their customer record does, and that is what the contact export is a
  // rendering of.
  //
  // Two columns rather than one because the export labels them separately and
  // they are separate facts. In practice the two are the same number on almost
  // every row of a real export, so the importer stores the mobile only when it
  // differs from the phone — a second copy of the same digits is a second thing
  // to keep in step and buys nothing. See importContacts.
  //
  // Deliberately NOT on the invoices table. An invoice snapshots the buyer's
  // name, email and address because those print on the document; a phone number
  // does not appear on it, so a per-invoice copy would only ever go stale.
  addColumnIfMissing(database, 'invoice_customers', 'phone', 'TEXT')
  addColumnIfMissing(database, 'invoice_customers', 'mobile', 'TEXT')
  setMeta(database, 'schema_version', '59')

  // v60: the floor's work log — the only durable record of who did what, when.
  //
  // ## Why a new table was unavoidable
  //
  // Every stamp the bench writes lives on a DATASET table: sleeved_at and
  // sorted_at on ship_breaks, the bag tick on ship_team_slots, packed_at and
  // the manual status on ship_shipments. DATASET_TABLES (db/shipping.ts) is
  // deleted wholesale by the next import. So the night before last has no
  // stamps at all — not stale ones, none — and a performance screen offering a
  // date range would have answered every question about every past show with
  // silence, or worse, with the current show's figures under an old heading.
  //
  // ship_imports survives and carries counts, but a count of what was IMPORTED
  // is not a record of what anybody DID, and it has no names on it.
  //
  // ## Why both endpoints are stored, rather than derived on read
  //
  // A completion stamp is not a duration. Each of the five steps derives its
  // start from something else that is stamped — the previous step, the earliest
  // per-card sleeve tick, a pick/pack station claim — and every one of those
  // lives on a dataset table too. The derivation is therefore only possible
  // WHILE THE SHOW IS STILL LOADED, which is exactly when the event is written.
  // Resolving it later is not merely slower, it is impossible.
  //
  // start_basis travels with the row for the same reason: by the time anything
  // reads this, the evidence for which rule produced started_at is gone. A NULL
  // started_at with basis 'none' is the honest statement that no start could be
  // established, and it is what lets the screen print a dash instead of a zero.
  //
  // ## The id is DERIVED, never random
  //
  // wl_<kind>_<subject id>. One subject has one outcome per step, so two
  // laptops recording the same tick write the SAME row and last-write-wins
  // compares that row against an older copy of itself — the same rule as the
  // availability, shift and team-bag ids. A UUID here would let one bench's
  // copy of a tick and another's both survive, and every average would count
  // the same team twice.
  //
  // Un-ticking a step DELETES its row rather than blanking it. A step that was
  // ticked by mistake did not take a measurable time; it did not happen. The
  // delete is captured by the sync trigger like any other, so it travels.
  //
  // ## Operator state, not dataset state
  //
  // Deliberately absent from DATASET_TABLES: this is the one shipping table an
  // import must not touch. break_id and break_label are denormalised onto every
  // row precisely so a row still reads as "break 11A" long after that break has
  // been overwritten by next Tuesday's break 11A.
  database.exec(`
    CREATE TABLE IF NOT EXISTS ship_work_log (
      id          TEXT PRIMARY KEY,
      -- sleeve | sort | bag | pack | ship | break_done. See @shared/performance.
      kind        TEXT NOT NULL,
      -- The break, card slot, unsold-team bag or shipment this is about.
      subject_id  TEXT NOT NULL,
      break_id    TEXT,
      break_label TEXT,
      import_id   TEXT,
      -- NULL is a real state: a stamp nobody's name was attached to.
      employee_id TEXT,
      -- NULL when no earlier instant could be established. NOT a zero.
      started_at  TEXT,
      start_basis TEXT NOT NULL DEFAULT 'none',
      finished_at TEXT NOT NULL,
      -- Teams, packages or a break's whole slate, so a per-team step and a
      -- per-break step can be compared without a second table saying how many.
      units       INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    -- The range query is always a window on finished_at, and the per-person
    -- table is that window grouped by employee. Both are covered here rather
    -- than scanning a log that grows by a few thousand rows a show.
    CREATE INDEX IF NOT EXISTS idx_ship_work_log_time
      ON ship_work_log (finished_at);
    CREATE INDEX IF NOT EXISTS idx_ship_work_log_person
      ON ship_work_log (employee_id, finished_at);
  `)

  // Seed it from the show currently on the floor.
  //
  // Without this the module opens empty on the day it ships and stays empty
  // until the next import, which reads as "nobody did anything" rather than as
  // "we only started recording this today". The backfill can only see the one
  // dataset that still exists — every earlier show is genuinely unrecoverable,
  // and the screen says so rather than implying the range was quiet.
  //
  // runOnce, so a re-run cannot double-count. It would not anyway (the ids are
  // derived and the write is an upsert), but the flag also stops it re-creating
  // rows an operator has since had un-ticked.
  runOnce(database, 'ship_work_log_backfill_v1', () => {
    const n = backfillWorkLog(database)
    setMeta(database, 'ship_work_log_backfill_v1_rows', String(n))
  })
  setMeta(database, 'schema_version', '60')

  // v61: the cost-lot picker — which layer a consumption actually came out of.
  //
  // ## What was wrong
  //
  // Three cases at $1,400, five at $1,550, two at $1,600. Taking stock out
  // consumed the oldest layer and told nobody. Rip the $1,600 case, book $1,400,
  // and that break's margin is wrong — and so is the per-break P&L built on it,
  // which sums exactly the cost each line recorded. The figure that is wrong is
  // one nobody was ever shown, so nobody looks.
  //
  // The operator is now asked, and may split a consumption across layers. Three
  // schema pieces make that answer durable rather than cosmetic.
  //
  // ## vendor on a cost layer
  //
  // The picker has to let somebody tell two layers apart, and price alone does
  // not do it once two suppliers happen to charge the same. Only a purchase-order
  // receipt knows a supplier, so the column is nullable and stays null for an
  // opening balance, a count-sheet correction or a found-stock adjustment —
  // see lotLabel in @shared/costLots for what those print instead. A default of
  // "Unknown" would have been a value, and a value is something a report can sum.
  addColumnIfMissing(database, 'inventory_lots', 'vendor', 'TEXT')

  // Which layers one ledger movement took, and whether a human chose them.
  //
  // inventory_transactions already carries the COST of a sale or an adjustment.
  // What it never carried is the composition of that cost, and without it the
  // three things that have to agree — the P&L, the valuation, and the layers
  // themselves — agree only by re-deriving the same FIFO walk, which is exactly
  // the assumption the picker breaks. These rows are written from the same slice
  // list whose cost was booked and whose qty_remaining was decremented, so the
  // three cannot drift.
  //
  // picked separates "an operator allocated this" from "nothing had to be
  // decided, so FIFO ran". Investigating a wrong margin months later, those are
  // the two cases that need telling apart, and they are indistinguishable from
  // the amounts alone.
  //
  // lot_id is deliberately NOT a foreign key, for the same reason
  // stream_item_lots does without one: layers cascade away with their product and
  // the record of what a movement took has to outlive that.
  //
  // Streaming lines are absent on purpose — stream_item_lots already holds their
  // slices, and it does a second job this table does not (handing back exactly
  // what a removed line took).
  database.exec(`
    CREATE TABLE IF NOT EXISTS inventory_txn_lots (
      id         TEXT PRIMARY KEY,
      txn_id     TEXT NOT NULL,
      lot_id     TEXT NOT NULL,
      quantity   REAL NOT NULL,
      unit_cost  REAL NOT NULL DEFAULT 0,
      -- 1 when an operator allocated it in the picker, 0 when FIFO ran unasked.
      picked     INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (txn_id) REFERENCES inventory_transactions (id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_inv_txn_lots_txn
      ON inventory_txn_lots (txn_id);
  `)

  // The same flag on the streaming side. A break line already names its layers;
  // what it could not say is whether the operator picked them, and a giveaway
  // booked at the oldest layer looks identical either way.
  addColumnIfMissing(database, 'stream_item_lots', 'picked', 'INTEGER NOT NULL DEFAULT 0')

  // Fill in the vendor for every layer a purchase order opened.
  //
  // po_line_receipts is the authoritative record of which lot a receipt created,
  // and its PO carries the supplier — so this is a join, not a guess. Every other
  // layer keeps its null, which is the truth about it. Without this pass the
  // picker would show a blank vendor column for the entire existing warehouse and
  // read as broken on the day it shipped.
  runOnce(database, 'inventory_lots_vendor_backfill_v1', () => {
    database
      .prepare(
        `UPDATE inventory_lots
            SET vendor = (
              SELECT TRIM(po.supplier)
                FROM po_line_receipts r
                JOIN purchase_orders po ON po.id = r.po_id
               WHERE r.lot_id = inventory_lots.id
               ORDER BY r.created_at ASC
               LIMIT 1
            )
          WHERE vendor IS NULL
            AND EXISTS (
              SELECT 1
                FROM po_line_receipts r
                JOIN purchase_orders po ON po.id = r.po_id
               WHERE r.lot_id = inventory_lots.id
                 AND TRIM(COALESCE(po.supplier, '')) <> ''
            )`
      )
      .run()
  })
  setMeta(database, 'schema_version', '61')

  // v62: a contact can be somebody we buy from, somebody we sell to, or BOTH.
  //
  // ## Why the vendor directory landed on invoice_customers and not a new table
  //
  // The alternative was a vendors table with its own id, its own name and its
  // own address columns. @shared/purchaseOrders already carries the written
  // rejection of that, and the reason is not tidiness: several of the businesses
  // on the owner's vendor list are also on the customer list, so a second table
  // means the same shop exists twice, under two ids, with two addresses. The
  // first time somebody corrects a phone number on one copy the other is wrong,
  // silently, and nothing in the schema can even notice.
  //
  // One table, one row per business, one place to correct it.
  //
  // ## Two independent flags, NOT one kind column
  //
  // The obvious shape is a single kind TEXT holding customer / vendor / both.
  // It is wrong, and specifically it is wrong in the direction that loses data:
  // it makes "both" a THIRD value that every query has to remember, so the
  // natural predicate for the customer list — kind = 'customer' — silently drops
  // every business that also sells to us. That failure is invisible on the
  // screen that has it (the list still looks like a list) and it is exactly the
  // overlap this change exists to represent.
  //
  // Two booleans make each question one predicate that CANNOT forget the
  // overlap: is_customer = 1 is the customer list, is_vendor = 1 is the vendor
  // directory, and a business that is both matches both without anybody writing
  // an OR.
  //
  // is_customer defaults to 1 because every row already in this table got here
  // as a buyer — through the invoice screen, the buyer form or the QuickBooks
  // contact import — and a default of 0 would empty the customer list on upgrade.
  // is_vendor defaults to 0 for the mirror-image reason: nothing in the table
  // has ever been asserted to be a supplier.
  addColumnIfMissing(database, 'invoice_customers', 'is_customer', 'INTEGER NOT NULL DEFAULT 1')
  addColumnIfMissing(database, 'invoice_customers', 'is_vendor', 'INTEGER NOT NULL DEFAULT 0')
  // What the OWNER files them under, which is not always what the business calls
  // itself: a shorthand, an initialism, sometimes a bracketed filing code. Kept
  // in its own column rather than folded into the name because the name is the
  // KEY — it has to match what somebody types on a purchase order — and rewriting
  // it to include a filing label would stop that match working. Kept rather than
  // dropped because it is the only column in the owner's sheet that says
  // something the others do not, and it is how they recognise the row.
  //
  // NOT notes: notes is typed in this app and an import must never overwrite it.
  addColumnIfMissing(database, 'invoice_customers', 'vendor_label', 'TEXT')
  setMeta(database, 'schema_version', '62')

  // v63: a show that has not happened yet.
  //
  // Nothing in this app could say "we are streaming on Friday at nine". A
  // stream_sessions row is the RECORD of a night — an absolute window, opened by
  // Start stream or typed in afterwards — and every reader of that table assumes
  // its start is in the past. The reminders the owner asked for need the other
  // fact, so the other fact needs a table.
  //
  // ## Why not a 'scheduled' status on stream_sessions
  //
  // It looks like the smaller change and it is the more expensive one.
  //
  // sessionsOverlap treats a session with no end as running to the END OF TIME,
  // because a live show does. A plan parked in that table with no end would
  // therefore collide with every later window — Start stream would be refused
  // with "that overlaps ..." from tonight onwards, and it would be refused on
  // laptops that have not updated too, because the overlap rule is theirs as
  // well.
  //
  // And the P&L, the calendar totals and the ledger attribution all range over
  // stream_sessions. A plan has no stock, no cost and no revenue, so every one
  // of those readers would need a new exclusion — and the one that gets missed
  // reports a night that has not happened.
  //
  // ## WALL CLOCK AND INSTANT, both, on purpose
  //
  // stream_date + start_time is the INTENTION: "9:00 PM on Friday", which stays
  // 9:00 PM across a daylight-saving boundary. That is what the screen shows and
  // what somebody would say out loud, and it is the same shape as `shifts`.
  //
  // starts_at is the same moment as an INSTANT, converted once on the machine
  // that scheduled it, where the local zone is known. It exists because the
  // relay does the arithmetic — "one hour before" — and a Cloudflare Worker runs
  // in UTC with no idea what zone this business is in. Asking it to read
  // "21:00" would put every reminder out by the local offset, and it would look
  // like the notification system was broken rather than a date conversion. See
  // @shared/streamReminders.
  //
  // No foreign key on host_id or session_id, matching every other synced table
  // here: the relay applies rows one at a time on the recovery path, and a plan
  // naming an employee whose row has not landed yet must still land.
  database.exec(
    `CREATE TABLE IF NOT EXISTS stream_schedule (
       id          TEXT PRIMARY KEY,
       title       TEXT NOT NULL DEFAULT '',
       stream_date TEXT NOT NULL,
       start_time  TEXT NOT NULL,
       starts_at   TEXT NOT NULL,
       host_id     TEXT,
       note        TEXT,
       status      TEXT NOT NULL DEFAULT 'planned',
       session_id  TEXT,
       created_at  TEXT NOT NULL,
       updated_at  TEXT NOT NULL,
       created_by  TEXT
     );
     CREATE INDEX IF NOT EXISTS idx_stream_schedule_when
       ON stream_schedule (status, starts_at);
     CREATE INDEX IF NOT EXISTS idx_stream_schedule_day
       ON stream_schedule (stream_date);`
  )
  setMeta(database, 'schema_version', '63')

  // v64: BAGGED AND PICKED ARE TWO DIFFERENT FACTS ABOUT THE SAME CARD.
  //
  // ship_team_slots.checked_off was doing both jobs, and the two are not the
  // same job on this floor:
  //
  //   BAGGED (step 3, per BREAK)  — this team is out of the tray, in a bag,
  //                                 stickered with the buyer's handle.
  //   PICKED (step 4, per ORDER)  — that bag has been gathered out of the break
  //                                 trays and into this buyer's package.
  //
  // A break's bags stay scattered across the bench until somebody walks the
  // order and collects them, so one does not imply the other. Sharing a column
  // meant the break bench's "Check all" — one click, every card in the break —
  // reported every order it touched as fully picked. A floor with the breaks
  // bagged and nothing packed read as 57 of 83 orders waiting at the mailing
  // bench, and the owner's dashboard showed 0 cards left on each of them.
  //
  // So picking gets a column of its own. checked_off keeps its meaning and
  // every break-side screen keeps reading it; the picking station, the order
  // rows and the dashboard move onto this one.
  //
  // ## The backfill starts everything unpicked, deliberately
  //
  // Existing checked_off values cannot be trusted to mean "picked" — the whole
  // reason for this migration is that most of them do not. The only rows that
  // certainly WERE picked are the ones whose package already went out: a packed
  // shipment cannot have been packed without its cards being gathered. Those
  // keep their timestamp and their attribution. Everything else starts at zero,
  // which is the true state of a floor whose breaks are bagged and whose orders
  // are not yet collected.
  addColumnIfMissing(database, 'ship_team_slots', 'picked_at', 'TEXT')
  addColumnIfMissing(database, 'ship_team_slots', 'picked_by', 'TEXT')
  runOnce(database, 'ship_slots_picked_split_v1', () => {
    database
      .prepare(
        `UPDATE ship_team_slots
            SET picked_at = checked_off_at,
                picked_by = checked_off_by
          WHERE checked_off = 1
            AND customer_id IN (
              SELECT customer_id FROM ship_shipments WHERE packed_at IS NOT NULL
            )`
      )
      .run()
  })
  setMeta(database, 'schema_version', '64')

  // Payroll, once, for whoever owns the company.
  //
  // Seeded rather than left to be typed because the owner named it, named its
  // cadence and named the date: every second Wednesday, 5 August 2026. Guarded
  // by runOnce and by the row not already existing, so it lands once and never
  // comes back if it is deleted — and it is an ordinary row, so deleting or
  // editing it works exactly as it does for one somebody added.
  // NOT runOnce. On a brand-new database this migration runs BEFORE the owner
  // account exists — createOwner opens the database, which migrates it, and only
  // then inserts the row — so the seed would find nobody, do nothing, and
  // runOnce would stamp its flag anyway. The job would then never appear on any
  // fresh install, with no screen to add one from.
  //
  // So it is idempotent and retried every boot, and the flag is set only once a
  // row has actually been written. A deliberate deletion still sticks, because
  // the flag is what stops it coming back.
  if (getMeta(database, 'seed_payroll_recurring_v1') === null) {
    const owner = database
      .prepare(`SELECT id FROM employees WHERE role = 'owner' ORDER BY created_at ASC LIMIT 1`)
      .get() as { id: string } | undefined
    if (owner) {
      const stamp = new Date().toISOString()
      database
        .prepare(
          `INSERT OR IGNORE INTO recurring_tasks
             (id, owner_id, title, every_days, anchor_date, lead_days, last_done_on, active,
              created_at, updated_at)
           VALUES (?, ?, 'Run payroll', 14, '2026-08-05', 2, NULL, 1, ?, ?)`
        )
        .run(`rt_payroll_${owner.id}`, owner.id, stamp, stamp)
      setMeta(database, 'seed_payroll_recurring_v1', '1')
    }
  }

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

  // v40: the owner's own product list, 306 rows, added where the catalog is
  // missing them.
  //
  // Placed here on purpose — AFTER `blank_template_fields_v1` (which nulls
  // boxes_per_case for everything) and after the v1 backfill, so the boxes each
  // of these cases holds survives instead of being wiped by a migration that
  // runs later. Placed BEFORE installSyncTriggers for the reason spelled out
  // below: a starter catalog is not work anyone did on this machine.
  //
  // Inserts only. Anything already in the catalog, by name or by a real SKU,
  // keeps its stock, cost basis, UPC, images and every edit made to it.
  runOnce(database, 'catalog_import_v3', () => {
    const r = seedCatalogV3(database)
    setMeta(database, 'catalog_import_v3_inserted', String(r.inserted))
    setMeta(database, 'catalog_import_v3_skipped', String(r.skippedByName + r.skippedBySku))
  })

  // v41: re-derive every product's average cost from its remaining cost layers.
  //
  // The average used to be stored rounded to the cent, back when every total in
  // the app was reconstructed as on-hand × that number. Totals now come from the
  // layers (db/valuation.ts) and the average is a per-unit figure kept at
  // UNIT_DP — but it is still the fallback basis for a shelf that has stock and
  // no layer, so an old cent-rounded value left in place would keep costing that
  // stock real money. Reads nothing but the layers, so a catalog whose costs are
  // all whole cents comes out of it byte-for-byte unchanged.
  //
  // Placed after the lot backfill and the catalog import, because it can only be
  // as right as the layers it reads, and before the sync triggers, because a
  // migration re-deriving a number from data every machine already has is not
  // work anyone did on this one.
  runOnce(database, 'product_avg_cost_unit_dp_v1', () => resyncProductAvgCosts(database))

  // v29: install the sync capture triggers LAST, after every seed, backfill and
  // one-time fixup above.
  //
  // Placement is the point. Installed earlier, a fresh install's starter catalog
  // and every migration touch-up would be captured as "changes this machine
  // made" and queued for upload — so the second laptop would try to publish 160
  // rows of boilerplate it invented locally, under ids nobody else has. What
  // travels should be work someone did, and the one deliberate exception is
  // seedRelay(), which queues the whole database on purpose from the machine
  // that holds the real data.
  //
  // Re-applied on every launch rather than once: a new app version can add a
  // synced table, and these triggers are generated from the manifest.
  installSyncTriggers(database)
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
