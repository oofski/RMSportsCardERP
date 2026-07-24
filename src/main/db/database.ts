import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import Database from 'better-sqlite3'
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
  setMeta(database, 'schema_version', '10')

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
