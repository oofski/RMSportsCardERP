import type {
  InventoryProduct,
  ScanCommitInput,
  ScanCommitKind,
  ScanCommitResult,
  ScanDirection,
  ScanMode,
  ScanRecord,
  ScanResolution
} from '@shared/types'
import { LOCATION_IDS, isLocation } from '@shared/inventory'
import { cleanScan, normalizeUpc } from '@shared/upc'
import { getDb } from './database'
import {
  addStock,
  adjustStock,
  findProductsByUpc,
  getProduct,
  productThumbnail,
  reverseStockReceipt
} from './inventory'
import {
  completePoIfFullyReceived,
  getPurchaseOrder,
  outstandingLinesForProduct,
  receivePoLine
} from './purchaseOrders'
import { newId, nowIso } from '../util'

/**
 * UPC scanning. Deliberately TWO steps:
 *
 *   resolveScan  — pure read: what does this barcode mean?
 *   commitScan   — the single confirmed action, in one transaction.
 *
 * The split is what makes camera scanning safe (the decoder fires many times a
 * second and must never write), keeps a future phone client on exactly the same
 * contract, and means no stock ever moves without a human confirming it.
 *
 * Everything that adds stock goes through addStock / receivePoLine so FIFO lots,
 * moving weighted-average cost, inventory value and spread stay consistent.
 * Everything that takes stock out goes through adjustStock, the outbound path
 * shrinkage and corrections already use: it consumes FIFO lots, so a scan-out
 * cannot invent a second way to decrement stock and cannot roll the average cost.
 *
 * A repeat-scanned item is ONE commit carrying the accumulated quantity — the
 * renderer merges repeat scans onto a single pending line, and quantity has
 * always been part of this contract, so nothing here needed a batch endpoint.
 */

const money = (n: number): string => `$${n.toFixed(2)}`

/** Short, human-quotable form of a scan id (for the reversing ledger note). */
const short = (id: string): string => id.slice(0, 8)

const SCAN_MODES: ScanMode[] = ['wedge', 'camera', 'manual']
const toMode = (mode: unknown): ScanMode => (SCAN_MODES.includes(mode as ScanMode) ? (mode as ScanMode) : 'wedge')

// ---------------------------------------------------------------------------
// Step A — resolve (READ ONLY: this function must never write)
// ---------------------------------------------------------------------------

const toDirection = (d: unknown): ScanDirection => (d === 'out' ? 'out' : 'in')

/** The location holding the most of this product — what an outbound scan should
 * default to taking from. Ties keep LOCATION_IDS order. */
function fullestLocation(product: InventoryProduct): string {
  let best = LOCATION_IDS[0]
  for (const loc of LOCATION_IDS) {
    if ((product.quantityByLocation[loc] ?? 0) > (product.quantityByLocation[best] ?? 0)) best = loc
  }
  return best
}

export function resolveScan(rawCode: string, dir: ScanDirection = 'in'): ScanResolution {
  const raw = typeof rawCode === 'string' ? rawCode : ''
  const direction = toDirection(dir)
  const normalized = normalizeUpc(raw)
  const base: ScanResolution = {
    status: 'unknown',
    direction,
    rawCode: raw,
    normalizedCode: normalized,
    cleanedCode: cleanScan(raw),
    product: null,
    imageUrl: null,
    candidates: [],
    defaultLineId: null,
    productMatches: [],
    suggestedQuantity: 1,
    suggestedUnitCost: null,
    suggestedLocation: LOCATION_IDS[0],
    message: ''
  }

  // Nothing usable (empty / whitespace / a bare wedge terminator). The renderer
  // must NOT log-miss this one — there is no code to log.
  if (!normalized) return { ...base, normalizedCode: null, message: 'Nothing was scanned.' }

  const products = findProductsByUpc(normalized)
  if (products.length === 0) {
    return { ...base, message: `“${base.cleanedCode}” isn’t in the catalog.` }
  }
  // Two catalog rows normalise to the same UPC (only possible from legacy data —
  // upcExists now compares on upc_norm). Ask rather than guess.
  if (products.length > 1) {
    return {
      ...base,
      status: 'ambiguous_product',
      productMatches: products.map((p) => ({ id: p.id, name: p.name, sku: p.sku, upc: p.upc })),
      message: 'More than one product carries this barcode — pick which one.'
    }
  }

  const product = products[0]
  const found: ScanResolution = {
    ...base,
    product,
    imageUrl: productThumbnail(product.id),
    suggestedUnitCost: product.unitCost > 0 ? product.unitCost : null
  }

  // Taking stock OUT never looks at purchase orders — a PO is a promise about
  // stock coming in, and nothing about it changes when stock leaves. There is no
  // cost input either: the FIFO lots already say what the units cost.
  if (direction === 'out') {
    const location = fullestLocation(product)
    return {
      ...found,
      status: 'product',
      suggestedUnitCost: null,
      suggestedLocation: location,
      message:
        product.quantity > 0
          ? `${product.quantity} on hand — confirm the count to take stock out of ${location}.`
          : 'None of this is on hand, so there is nothing to take out.'
    }
  }

  const candidates = outstandingLinesForProduct(product.id)
  if (candidates.length === 0) {
    return {
      ...found,
      status: 'product',
      message: 'No open purchase order — confirm quantity and cost to add stock.'
    }
  }
  // Oldest PO first. The UI preselects it and only asks when there is more than
  // one; commit always sends back an explicit lineId.
  const first = candidates[0]
  return {
    ...found,
    status: 'po_line',
    candidates,
    defaultLineId: first.lineId,
    message: `${first.poNumber} · receive ${first.qtyOutstanding} × at ${money(first.unitPrice)} into ${first.location}`
  }
}

// ---------------------------------------------------------------------------
// The scan log
// ---------------------------------------------------------------------------

interface ScanRow {
  id: string
  raw_code: string
  normalized_code: string | null
  mode: string
  outcome: string
  product_id: string | null
  product_name: string | null
  sku: string | null
  po_id: string | null
  po_number: string | null
  po_line_id: string | null
  location: string | null
  quantity: number
  unit_cost: number | null
  lot_id: string | null
  txn_id: string | null
  po_completed: number
  po_prev_status: string | null
  po_prev_received_at: string | null
  client_token: string | null
  actor_id: string | null
  created_at: string
  undone_at: string | null
  undone_by: string | null
  actor_name: string | null
  /** qty_remaining on the lot this scan created — null once it is gone. */
  lot_remaining: number | null
}

const SCAN_SELECT = `
  SELECT s.*, (e.first_name || ' ' || e.last_name) AS actor_name, l.qty_remaining AS lot_remaining
  FROM inventory_scans s
  LEFT JOIN employees e ON e.id = s.actor_id
  LEFT JOIN inventory_lots l ON l.id = s.lot_id
`

function toRecord(r: ScanRow): ScanRecord {
  return {
    id: r.id,
    rawCode: r.raw_code,
    normalizedCode: r.normalized_code,
    mode: toMode(r.mode),
    outcome: r.outcome as ScanRecord['outcome'],
    productId: r.product_id,
    productName: r.product_name,
    sku: r.sku,
    poId: r.po_id,
    poNumber: r.po_number,
    poLineId: r.po_line_id,
    location: r.location,
    quantity: r.quantity,
    unitCost: r.unit_cost,
    poCompleted: r.po_completed === 1,
    actorName: r.actor_name,
    createdAt: r.created_at,
    undoneAt: r.undone_at,
    // Undoable only while the exact lot this scan created still holds all of the
    // stock it added — once any has been sold the reversal cannot be clean, so
    // the UI disables the button instead of offering a doomed action.
    undoable:
      (r.outcome === 'po_line' || r.outcome === 'add_stock') &&
      !r.undone_at &&
      !!r.lot_id &&
      (r.lot_remaining ?? -1) >= r.quantity
  }
}

/** Recent scans, newest first (includes unrecognised ones). The rowid tiebreak
 * keeps the order stable for two scans in the same millisecond — a wedge burst
 * plus its commit routinely land inside one — matching the FIFO lot ordering
 * convention in lots.ts. */
export function listScans(limit = 50): ScanRecord[] {
  const rows = getDb()
    .prepare(`${SCAN_SELECT} ORDER BY s.created_at DESC, s.rowid DESC LIMIT ?`)
    .all(Math.max(1, Math.round(limit))) as ScanRow[]
  return rows.map(toRecord)
}

function getScanRow(id: string): ScanRow | undefined {
  return getDb().prepare(`${SCAN_SELECT} WHERE s.id = ?`).get(id) as ScanRow | undefined
}

interface ScanInsert {
  rawCode: string
  normalizedCode: string | null
  mode: ScanMode
  outcome: ScanCommitKind | 'unknown'
  productId?: string | null
  productName?: string | null
  sku?: string | null
  poId?: string | null
  poNumber?: string | null
  poLineId?: string | null
  location?: string | null
  quantity?: number
  unitCost?: number | null
  lotId?: string | null
  txnId?: string | null
  poCompleted?: boolean
  poPrevStatus?: string | null
  poPrevReceivedAt?: string | null
  clientToken?: string | null
  actorId: string | null
}

/** Write one audit row. Called inside the caller's transaction. */
function insertScan(args: ScanInsert): string {
  const id = newId()
  getDb()
    .prepare(
      `INSERT INTO inventory_scans
         (id, raw_code, normalized_code, mode, outcome, product_id, product_name, sku,
          po_id, po_number, po_line_id, location, quantity, unit_cost, lot_id, txn_id,
          po_completed, po_prev_status, po_prev_received_at, client_token, actor_id, created_at)
       VALUES
         (@id, @raw_code, @normalized_code, @mode, @outcome, @product_id, @product_name, @sku,
          @po_id, @po_number, @po_line_id, @location, @quantity, @unit_cost, @lot_id, @txn_id,
          @po_completed, @po_prev_status, @po_prev_received_at, @client_token, @actor_id, @created_at)`
    )
    .run({
      id,
      raw_code: args.rawCode,
      normalized_code: args.normalizedCode,
      mode: args.mode,
      outcome: args.outcome,
      product_id: args.productId ?? null,
      product_name: args.productName ?? null,
      sku: args.sku ?? null,
      po_id: args.poId ?? null,
      po_number: args.poNumber ?? null,
      po_line_id: args.poLineId ?? null,
      location: args.location ?? null,
      quantity: args.quantity ?? 0,
      unit_cost: args.unitCost ?? null,
      lot_id: args.lotId || null,
      txn_id: args.txnId || null,
      po_completed: args.poCompleted ? 1 : 0,
      po_prev_status: args.poPrevStatus ?? null,
      po_prev_received_at: args.poPrevReceivedAt ?? null,
      client_token: args.clientToken || null,
      actor_id: args.actorId,
      created_at: nowIso()
    })
  return id
}

/**
 * Log a barcode that matched nothing. An EXPLICIT channel rather than having
 * resolveScan write, so the read path stays side-effect free and the renderer
 * owns debouncing (it calls this once, when it first shows "not recognised").
 * Answers "I scanned it and nothing happened" in the history.
 */
export function logScanMiss(rawCode: string, mode: ScanMode, actorId: string | null): ScanRecord | null {
  const raw = typeof rawCode === 'string' ? rawCode : ''
  const normalized = normalizeUpc(raw)
  if (!normalized) return null // nothing was actually scanned
  const id = insertScan({
    rawCode: raw,
    normalizedCode: normalized,
    mode: toMode(mode),
    outcome: 'unknown',
    quantity: 0,
    actorId
  })
  const row = getScanRow(id)
  return row ? toRecord(row) : null
}

// ---------------------------------------------------------------------------
// Step B — commit (the only path that writes stock)
// ---------------------------------------------------------------------------

/** Rebuild the result of an earlier commit for a replayed clientToken. */
function replayResult(row: ScanRow): ScanCommitResult {
  const out = row.outcome === 'remove_stock'
  return {
    scanId: row.id,
    kind: row.outcome as ScanCommitKind,
    product: row.product_id ? getProduct(row.product_id) : null,
    quantity: row.quantity,
    unitCost: row.unit_cost,
    location: row.location ?? LOCATION_IDS[0],
    po: row.po_id ? getPurchaseOrder(row.po_id) : null,
    poCompleted: row.po_completed === 1,
    replayed: true,
    // The count is the LINE's count, so a replayed 5 says 5 — not "counted once".
    message: `Already scanned ${out ? 'out' : 'in'} — ${row.quantity} × ${
      row.product_name ?? 'item'
    } counted once.`
  }
}

export function commitScan(
  input: ScanCommitInput,
  actorId: string | null
): { result?: ScanCommitResult; error?: string } {
  const db = getDb()
  const raw = typeof input?.rawCode === 'string' ? input.rawCode : ''
  const mode = toMode(input?.mode)
  const normalized = normalizeUpc(raw)
  const token = input?.clientToken?.trim() || null

  // ONE transaction for the whole commit: stock, lot, cost, PO line, PO header
  // and the audit row commit together or not at all. better-sqlite3 nests
  // addStock's own transaction as a SAVEPOINT, so this composes cleanly.
  const run = db.transaction((): ScanCommitResult => {
    // Retry / double-submit of the SAME confirmed action: return the original
    // outcome and write nothing.
    if (token) {
      const prior = db.prepare(`${SCAN_SELECT} WHERE s.client_token = ?`).get(token) as ScanRow | undefined
      if (prior) return replayResult(prior)
    }

    if (input.kind === 'po_line') {
      // Commit NEVER re-resolves and re-picks a candidate: the client must say
      // which line, which is what removes any resolve→commit race.
      const lineId = input.lineId?.trim()
      if (!lineId) throw new Error('No purchase order line specified.')
      const qty = Number.isFinite(input.quantity as number)
        ? Number(input.quantity)
        : Number.POSITIVE_INFINITY // "receive the rest" — receivePoLine clamps
      const received = receivePoLine(db, lineId, qty, input.note ?? null, actorId)
      const done = completePoIfFullyReceived(db, received.poId)
      const product = getProduct(received.productId)
      const scanId = insertScan({
        rawCode: raw,
        normalizedCode: normalized,
        mode,
        outcome: 'po_line',
        productId: received.productId,
        productName: received.productName,
        sku: product?.sku ?? null,
        poId: received.poId,
        poNumber: received.poNumber,
        poLineId: received.lineId,
        location: received.location,
        quantity: received.quantity,
        unitCost: received.unitCost,
        lotId: received.lotId,
        txnId: received.txnId,
        poCompleted: done.completed,
        poPrevStatus: done.completed ? done.prevStatus : null,
        poPrevReceivedAt: done.completed ? done.prevReceivedAt : null,
        clientToken: token,
        actorId
      })
      const message =
        `Received ${received.quantity} × ${received.productName} into ${received.location} for ${received.poNumber}.` +
        (done.completed ? ` ${received.poNumber} is complete.` : '')
      return {
        scanId,
        kind: 'po_line',
        product,
        quantity: received.quantity,
        unitCost: received.unitCost,
        location: received.location,
        po: getPurchaseOrder(received.poId),
        poCompleted: done.completed,
        replayed: false,
        message
      }
    }

    // --- Direct product line (no PO): add stock, or take it out -------------
    const productId = input.productId?.trim()
    if (!productId) throw new Error('Select a product.')
    const location = isLocation(input.location) ? input.location : LOCATION_IDS[0]
    const quantity = input.quantity ?? 1
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new Error('Quantity must be a whole number of at least 1.')
    }

    if (input.kind === 'remove_stock') {
      // THE outbound path, unchanged and unduplicated: adjustStock consumes the
      // oldest FIFO lots and re-derives the average from what is LEFT, so taking
      // stock out never rolls the cost basis. No purchase order is read or
      // written here — an outbound scan has nothing to do with one.
      const res = adjustStock(productId, location, -quantity, input.note ?? 'Scanned out', actorId)
      // adjustStock RETURNS its errors ("would make stock negative", "not found");
      // throwing turns that into a rollback, so no scan row is written either.
      if (res.error) throw new Error(res.error)
      const removed = res.product as InventoryProduct
      const scanId = insertScan({
        rawCode: raw,
        normalizedCode: normalized,
        mode,
        outcome: 'remove_stock',
        productId: removed.id,
        productName: removed.name,
        sku: removed.sku,
        location,
        // Stored positive; 'remove_stock' is what says which way it went.
        quantity,
        clientToken: token,
        actorId
      })
      return {
        scanId,
        kind: 'remove_stock',
        product: removed,
        unitCost: null,
        quantity,
        location,
        po: null,
        poCompleted: false,
        replayed: false,
        message: `Took ${quantity} × ${removed.name} out of ${location}.`
      }
    }

    const unitCost = input.unitCost ?? null
    if (unitCost != null && (!Number.isFinite(unitCost) || unitCost < 0)) {
      throw new Error('Enter a valid unit cost.')
    }
    const res = addStock(productId, location, quantity, unitCost, input.note ?? 'Scanned in', actorId)
    // A product deleted between resolve and commit lands here; throwing rolls
    // the transaction back so no scan row is written either.
    if (res.error) throw new Error(res.error)
    const product = res.product as InventoryProduct
    const scanId = insertScan({
      rawCode: raw,
      normalizedCode: normalized,
      mode,
      outcome: 'add_stock',
      productId: product.id,
      productName: product.name,
      sku: product.sku,
      location,
      quantity,
      unitCost,
      lotId: res.lotId,
      txnId: res.txnId,
      clientToken: token,
      actorId
    })
    return {
      scanId,
      kind: 'add_stock',
      product,
      quantity,
      unitCost,
      location,
      po: null,
      poCompleted: false,
      replayed: false,
      message: `Added ${quantity} × ${product.name} to ${location}.`
    }
  })

  try {
    return { result: run() }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/**
 * Reverse a scan completely: the exact FIFO lot it created, the stock, the
 * average cost, the PO line's qty_received and — when this scan auto-completed
 * the PO — the header state it overwrote (returning the box to the Incoming
 * panel). One transaction, so a partial undo is impossible.
 */
export function undoScan(scanId: string, actorId: string | null): { record?: ScanRecord; error?: string } {
  const db = getDb()
  const run = db.transaction((): ScanRecord => {
    // Read inside the transaction so a double undo cannot slip through.
    const row = db.prepare('SELECT * FROM inventory_scans WHERE id = ?').get(scanId) as ScanRow | undefined
    if (!row) throw new Error('That scan is no longer in the log.')
    if (row.undone_at) throw new Error('That scan was already undone.')
    if (row.outcome === 'unknown') throw new Error('There is nothing to undo for an unrecognised scan.')
    // An outbound scan consumed FIFO lots that may since have been re-consumed or
    // re-layered; putting the units back would have to invent a cost for them.
    // The honest answer is to scan them back IN (or adjust), which prices the
    // return explicitly instead of silently.
    if (row.outcome === 'remove_stock') {
      throw new Error('A scan-out cannot be undone automatically — scan the items back in instead.')
    }
    if (!row.lot_id || !row.product_id || !row.location || row.quantity <= 0) {
      throw new Error('That scan cannot be undone automatically — adjust the stock manually instead.')
    }

    // Targets the exact lot this scan created, never FIFO-oldest: undoing an old
    // scan must not cannibalise a newer cost layer. Throws (rolling everything
    // back) when part of that stock has already been sold.
    reverseStockReceipt(db, {
      productId: row.product_id,
      location: row.location,
      quantity: row.quantity,
      lotId: row.lot_id,
      note: `Undo scan ${short(row.id)}`,
      actorId
    })

    if (row.po_line_id) {
      db.prepare(
        'UPDATE purchase_order_lines SET qty_received = MAX(0, qty_received - ?), received_at = NULL WHERE id = ?'
      ).run(row.quantity, row.po_line_id)
      // This receipt's lot has just been reversed, so its row must go too —
      // otherwise cancelling the PO later would try to hand back stock that is
      // already gone, and refuse for a reason that is not the real one.
      db.prepare('DELETE FROM po_line_receipts WHERE po_line_id = ? AND lot_id = ?').run(
        row.po_line_id,
        row.lot_id
      )
    }
    // Reopen the PO this scan auto-completed, restoring the exact prior header.
    if (row.po_completed === 1 && row.po_id) {
      db.prepare(
        `UPDATE purchase_orders
            SET status = @status, received_at = @received_at, scanned_at = NULL, updated_at = @ts
          WHERE id = @id`
      ).run({
        status: row.po_prev_status ?? 'ordered',
        received_at: row.po_prev_received_at,
        ts: nowIso(),
        id: row.po_id
      })
    } else if (row.po_id && row.po_line_id) {
      // A DIFFERENT scan completed this PO (possible when a line was received in
      // two partial commits and the earlier one is undone). Clearing scanned_at
      // returns the box to the Incoming panel and makes the units scannable
      // again, instead of leaving a PO stamped complete with an open line. The
      // status is left alone rather than inventing one this scan never recorded:
      // 'received' with scanned_at NULL is exactly the "pipeline stage, stock
      // not taken in yet" state the eligibility query already understands.
      const open = db
        .prepare('SELECT COUNT(*) AS n FROM purchase_order_lines WHERE po_id = ? AND qty_received < quantity')
        .get(row.po_id) as { n: number }
      if (open.n > 0) {
        db.prepare(
          'UPDATE purchase_orders SET scanned_at = NULL, updated_at = ? WHERE id = ? AND scanned_at IS NOT NULL'
        ).run(nowIso(), row.po_id)
      }
    }

    db.prepare('UPDATE inventory_scans SET undone_at = ?, undone_by = ? WHERE id = ?').run(
      nowIso(),
      actorId,
      row.id
    )
    return toRecord(getScanRow(row.id) as ScanRow)
  })

  try {
    return { record: run() }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
