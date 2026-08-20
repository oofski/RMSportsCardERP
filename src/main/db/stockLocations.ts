import type Database from 'better-sqlite3'
import type { StockLocation } from '@shared/inventory'
import { BUILTIN_LOCATION_IDS, setKnownLocations } from '@shared/inventory'
import type { Result } from '@shared/types'
import { getDb } from './database'

/**
 * The places this business holds stock.
 *
 * See the v79 migration for why the set is data rather than the two constants it
 * used to be, and @shared/inventory for the registry every shelf test reads.
 *
 * ## Hydration is not optional
 *
 * `destinationHoldsStock` decides whether a line draws inventory down, and it
 * answers from the shared registry. If this module never runs, that registry is
 * the two built-ins and a Roadshow shop reads as a dropship — the exact bug this
 * feature exists to fix. So `hydrateLocations` is called as the database opens,
 * before anything can ask, and again after every write here.
 */

function rowsFrom(db: Database.Database): StockLocation[] {
  try {
    const rows = db
      .prepare(
        `SELECT id, label, pinned, retired FROM stock_locations
          ORDER BY pinned DESC, position ASC, label ASC`
      )
      .all() as Array<{ id: string; label: string; pinned: number; retired: number }>
    return rows.map((r) => ({
      id: r.id,
      label: r.label || r.id,
      pinned: r.pinned === 1,
      retired: r.retired === 1
    }))
  } catch {
    // A database opened before v79, or mid-migration. The registry keeps its
    // built-ins, which is exactly how this app behaved for its whole life —
    // failing to an empty world would make RM itself stop being a shelf.
    return []
  }
}

/** Read the table into the shared registry. Called as the database opens. */
export function hydrateLocations(db: Database.Database): void {
  setKnownLocations(rowsFrom(db))
}

/** Everywhere, retired included, for a screen that manages them. */
export function listStockLocations(): StockLocation[] {
  return rowsFrom(getDb())
}

const clean = (v: unknown): string => String(v ?? '').trim()

/**
 * Add a place, or rename one that already exists.
 *
 * The id is the NAME. That is deliberate: a location is written onto every
 * stock row, every FIFO layer and every order line as a plain string, and has
 * been since v1. Minting a surrogate id now would leave every one of those rows
 * pointing at a name while the registry keyed on something else, and the two
 * would have to be reconciled on every read for ever.
 *
 * Case-insensitive on the way in, so "Roadshow Dallas" and "roadshow dallas" are
 * one shelf rather than two holding half the stock each.
 */
export function saveStockLocation(
  input: { id?: string | null; label: string; pinned?: boolean },
  actorId: string | null
): Result<StockLocation[]> {
  const label = clean(input.label)
  if (!label) return { ok: false, error: 'Give the place a name.' }
  if (label.length > 60) return { ok: false, error: 'That name is too long.' }
  const db = getDb()
  const stamp = new Date().toISOString()
  const existingId = clean(input.id)
  try {
    const clash = db
      .prepare(`SELECT id FROM stock_locations WHERE LOWER(id) = LOWER(?) AND id <> ?`)
      .get(label, existingId || label) as { id: string } | undefined
    if (clash) return { ok: false, error: `${clash.id} is already a place stock can sit.` }

    if (existingId) {
      // A RENAME MOVES STOCK. The name is the key on every stock row and layer,
      // so the rows have to travel with it or the shelf empties itself.
      const run = db.transaction(() => {
        db.prepare(
          `UPDATE stock_locations SET id = ?, label = ?, pinned = ?, updated_at = ? WHERE id = ?`
        ).run(label, label, input.pinned ? 1 : 0, stamp, existingId)
        if (label.toLowerCase() !== existingId.toLowerCase()) {
          for (const table of ['inventory_stock', 'inventory_lots', 'inventory_transactions']) {
            db.prepare(`UPDATE ${table} SET location = ? WHERE location = ?`).run(label, existingId)
          }
        }
      })
      run()
    } else {
      const pos = db.prepare(`SELECT COALESCE(MAX(position), 0) + 1 AS n FROM stock_locations`).get() as {
        n: number
      }
      db.prepare(
        `INSERT INTO stock_locations
           (id, label, pinned, retired, position, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?)`
      ).run(label, label, input.pinned ? 1 : 0, pos.n, actorId, stamp, stamp)
    }
    hydrateLocations(db)
    return { ok: true, data: rowsFrom(db) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Stop offering a place, without taking it out of the world.
 *
 * It keeps holding stock as far as `destinationHoldsStock` is concerned — see
 * StockLocation.retired. RM and AM cannot be retired: a blank destination has
 * resolved to RM since v1, so a database where RM is not a shelf is one where
 * every default is wrong.
 */
export function setStockLocationRetired(id: string, retired: boolean): Result<StockLocation[]> {
  const wanted = clean(id)
  if (BUILTIN_LOCATION_IDS.some((b) => b.toLowerCase() === wanted.toLowerCase())) {
    return { ok: false, error: `${wanted} is one of the two original shelves and has to stay.` }
  }
  const db = getDb()
  try {
    if (retired) {
      const held = db
        .prepare(
          `SELECT COALESCE(SUM(quantity), 0) AS n FROM inventory_stock WHERE location = ?`
        )
        .get(wanted) as { n: number }
      // Refused rather than hidden. Stock at a place nobody can pick from is
      // stock nobody can sell, and it would still be counted in the valuation.
      if ((Number(held.n) || 0) > 0) {
        return {
          ok: false,
          error: `${wanted} still holds ${held.n} unit${held.n === 1 ? '' : 's'}. Move or sell them first.`
        }
      }
    }
    db.prepare(`UPDATE stock_locations SET retired = ?, updated_at = ? WHERE id = ?`).run(
      retired ? 1 : 0,
      new Date().toISOString(),
      wanted
    )
    hydrateLocations(db)
    return { ok: true, data: rowsFrom(db) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Keep a place near the top of every picker, or stop. */
export function setStockLocationPinned(id: string, pinned: boolean): Result<StockLocation[]> {
  const db = getDb()
  try {
    db.prepare(`UPDATE stock_locations SET pinned = ?, updated_at = ? WHERE id = ?`).run(
      pinned ? 1 : 0,
      new Date().toISOString(),
      clean(id)
    )
    hydrateLocations(db)
    return { ok: true, data: rowsFrom(db) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
