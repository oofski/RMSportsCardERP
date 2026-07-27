import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import Database from 'better-sqlite3'
import { normalizeUpc } from '@shared/upc'
import { seedCatalog } from './inventorySeed'
import { seedSnapshot } from './inventorySnapshot'
import { seedCatalogExpansion } from './inventoryCatalogV2'
import { dedupeProducts } from './dedupe'
import { backfillLots } from './lots'

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
      unit_cost      REAL NOT NULL DEFAULT 0,
      high_bid       REAL,
      sale_price     REAL,
      reorder_point  INTEGER NOT NULL DEFAULT 0,
      notes          TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );

    -- On-hand quantity per product per location (RM / AM).
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
  setMeta(database, 'schema_version', '17')

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
