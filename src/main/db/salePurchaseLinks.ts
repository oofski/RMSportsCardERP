import type Database from 'better-sqlite3'
import type { SaleSourceLink } from '@shared/orders'
import { getDb } from './database'
import { recordOrderEvent } from './orderExtras'
import { newId, nowIso } from '../util'

/**
 * WHICH PURCHASES SUPPLIED A SALE — the many-to-many the pair always needed.
 *
 * The owner's ask: "allow for multiple POs to be added to one sales order", and
 * "a way to link POs to SOs that are in history or active, in case of drop
 * shipping".
 *
 * ## The relationship was already one-to-many, pointing the wrong way
 *
 * One purchase supplying several sales has worked since multi-shipment landed,
 * because that direction reads off `invoices.source_po_id` — the MANY side. The
 * other direction had no room at all: one column, and `linkDropshipPair` refused
 * outright with "that sales order already came from another purchase order". A
 * sale of ten cases sourced from three purchases is ordinary trade here and
 * could not be recorded at all.
 *
 * ## Three different questions, and they stay three different answers
 *
 *   sale_purchase_links      WHICH PURCHASES supplied this sale, as a document.
 *                            The operator's claim. This file.
 *   invoice_lines.source_po_id      which purchase THIS LINE's units came out
 *                            of, so the cost is that order's layers.
 *   invoice_line_allocations.source_po_id
 *                            the same, per SLICE, when one line is split across
 *                            several purchases. See @shared/invoiceAllocations.
 *
 * Linking a purchase here does NOT re-cost anything, and must not. Cost of goods
 * follows the line and the slice, where somebody said which units came from
 * where; this says who supplied the sale, which is what the histories and the
 * dropship chase need and is a claim a person makes rather than one derived from
 * stock. Keeping them separate is what lets a sale be linked to a purchase whose
 * stock it never drew — the dropship case, which is the whole reason for the ask.
 *
 * ## AND A SALE WITH NO LINK AT ALL IS STILL THE ORDINARY CASE
 *
 * "It should still handle not having an associated PO, where the order is being
 * fulfilled in-house." Zero rows here is exactly that: the sale walks ordinary
 * FIFO, nothing is claimed about where the cases came from, and nothing on any
 * screen asks. Every sale in the database that names no purchase goes on
 * behaving byte for byte as it did.
 */

/** The purchases this sale is linked to, oldest link first. */
export function listSaleLinks(db: Database.Database, invoiceId: string): SaleSourceLink[] {
  const rows = db
    .prepare(
      `SELECT l.po_id, l.created_at, po.po_number, po.supplier, po.status, po.total,
              COALESCE(po.ordered_at, po.created_at) AS ordered_at
         FROM sale_purchase_links l
         JOIN purchase_orders po ON po.id = l.po_id
        WHERE l.invoice_id = ?
        ORDER BY l.created_at ASC, po.po_number ASC`
    )
    .all(invoiceId) as Array<{
    po_id: string
    created_at: string
    po_number: string
    supplier: string | null
    status: string
    total: number
    ordered_at: string | null
  }>
  return rows.map((r) => ({
    poId: r.po_id,
    poNumber: r.po_number,
    supplier: (r.supplier ?? '').trim() || null,
    status: r.status,
    total: Math.round((Number(r.total) || 0) * 100) / 100,
    orderedOn: r.ordered_at ? r.ordered_at.slice(0, 10) : null,
    linkedAt: r.created_at
  }))
}

/**
 * KEEP `invoices.source_po_id` HONEST — the sole link, or nothing.
 *
 * That column predates this table and is read by a great deal: the dropship
 * gate, the deal-ticket fold, the purchase board's buyer count, every card that
 * names who is shipping. Rather than migrate all of it at once, the column is
 * kept as an ANSWER derived from this table: the one purchase when there is
 * exactly one, and NULL when there are several.
 *
 * NULL rather than the first, and that is the whole point. Naming one of three
 * purchases as if it were the only one is a half-truth, and a half-truth in a
 * column that drives a gate is worse than an absence — the absence is visible
 * and makes a reader come here for the real list. Exactly the rule
 * `soleSourceOrder` already applies to a sale's LINES, applied to the sale.
 *
 * MUST be called inside the caller's transaction, after any link change.
 */
export function syncSaleSourcePo(
  db: Database.Database,
  invoiceId: string,
  stamp: string
): string | null {
  const rows = db
    .prepare(`SELECT po_id FROM sale_purchase_links WHERE invoice_id = ?`)
    .all(invoiceId) as Array<{ po_id: string }>
  const sole = rows.length === 1 ? rows[0].po_id : null
  db.prepare(`UPDATE invoices SET source_po_id = ?, updated_at = ? WHERE id = ?`).run(
    sole,
    stamp,
    invoiceId
  )
  return sole
}

/** True when the pair is already linked. Idempotence is the point — see below. */
export function saleLinksPurchase(
  db: Database.Database,
  invoiceId: string,
  poId: string
): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sale_purchase_links WHERE invoice_id = ? AND po_id = ?`)
    .get(invoiceId, poId)
}

/**
 * Attach one purchase to one sale.
 *
 * IDEMPOTENT, and deliberately not an error the second time. Two people on two
 * benches attaching the same purchase to the same sale is a race, not a mistake,
 * and the second one being told off for it would be the app inventing a problem.
 * `INSERT OR IGNORE` plus the UNIQUE does the work; the history entry is skipped
 * when nothing changed, so a log cannot gain a line for a no-op.
 *
 * Returns whether a link was actually created, which the caller uses to decide
 * whether anything else needs saying.
 *
 * MUST be called inside the caller's transaction.
 */
export function addSaleLink(
  db: Database.Database,
  invoiceId: string,
  poId: string,
  actorId: string | null,
  stamp: string
): boolean {
  if (saleLinksPurchase(db, invoiceId, poId)) return false
  db.prepare(
    `INSERT OR IGNORE INTO sale_purchase_links (id, invoice_id, po_id, created_at, created_by)
     VALUES (?, ?, ?, ?, ?)`
  ).run(newId(), invoiceId, poId, stamp, actorId)
  syncSaleSourcePo(db, invoiceId, stamp)
  return true
}

/** Detach one purchase from one sale. Returns whether anything was removed. */
export function removeSaleLink(
  db: Database.Database,
  invoiceId: string,
  poId: string,
  stamp: string
): boolean {
  const res = db
    .prepare(`DELETE FROM sale_purchase_links WHERE invoice_id = ? AND po_id = ?`)
    .run(invoiceId, poId)
  if (res.changes === 0) return false
  syncSaleSourcePo(db, invoiceId, stamp)
  return true
}

/**
 * Attach a purchase to a sale, with both histories saying so. The public write.
 *
 * ## Why it refuses so little
 *
 * Two documents being one deal is a claim a person makes, not something to be
 * second-guessed — the same reasoning `linkPurchaseRefusal` is written on. A
 * supplier that does not match, a date months apart, a purchase long since
 * closed: all ordinary shapes of real trade, and the ask was explicitly to allow
 * linking to purchases "in history or active". So a cancelled order is refused,
 * because nothing on it is being bought, and nothing else is.
 */
export function linkSaleToPurchase(
  invoiceId: string,
  poId: string,
  actorId: string | null
): { ok: boolean; error?: string } {
  const db = getDb()
  const run = db.transaction((): { ok: boolean; error?: string } => {
    const po = db
      .prepare(`SELECT po_number, supplier, status FROM purchase_orders WHERE id = ?`)
      .get(poId) as { po_number: string; supplier: string | null; status: string } | undefined
    if (!po) return { ok: false, error: 'That purchase order is gone.' }
    if (po.status === 'cancelled') {
      return { ok: false, error: `${po.po_number} was cancelled, so nothing on it is being bought.` }
    }
    const sale = db
      .prepare(`SELECT invoice_number, customer_name, status FROM invoices WHERE id = ?`)
      .get(invoiceId) as
      | { invoice_number: string | null; customer_name: string; status: string }
      | undefined
    if (!sale) return { ok: false, error: 'That sales order is gone.' }
    if (sale.status === 'void') return { ok: false, error: 'That sales order was voided.' }

    const stamp = nowIso()
    if (!addSaleLink(db, invoiceId, poId, actorId, stamp)) {
      // Already linked. Not an error — see addSaleLink.
      return { ok: true }
    }
    const soLabel = (sale.invoice_number ?? '').trim()
      ? `sales order ${(sale.invoice_number ?? '').trim()}`
      : 'a sales order'
    recordOrderEvent('po', poId, 'link', {
      detail: `Supplies ${soLabel} for ${sale.customer_name}`,
      actorId,
      db
    })
    recordOrderEvent('so', invoiceId, 'link', {
      detail: `Supplied by ${po.po_number}${po.supplier ? ` (${po.supplier})` : ''}`,
      actorId,
      db
    })
    return { ok: true }
  })
  return run()
}

/**
 * Detach a purchase from a sale, with both histories saying so.
 *
 * A log that only ever gains claims is a wrong log — the same rule
 * `setInvoiceLineRouting` keeps when a line stops taking an order's cases.
 */
export function unlinkSaleFromPurchase(
  invoiceId: string,
  poId: string,
  actorId: string | null
): { ok: boolean; error?: string } {
  const db = getDb()
  const run = db.transaction((): { ok: boolean; error?: string } => {
    const po = db.prepare(`SELECT po_number FROM purchase_orders WHERE id = ?`).get(poId) as
      | { po_number: string }
      | undefined
    const sale = db.prepare(`SELECT invoice_number FROM invoices WHERE id = ?`).get(invoiceId) as
      | { invoice_number: string | null }
      | undefined
    if (!sale) return { ok: false, error: 'That sales order is gone.' }
    const stamp = nowIso()
    if (!removeSaleLink(db, invoiceId, poId, stamp)) return { ok: true }
    const soLabel = (sale.invoice_number ?? '').trim()
      ? `sales order ${(sale.invoice_number ?? '').trim()}`
      : 'a sales order'
    // The purchase may itself have been deleted — the link is not a foreign key
    // precisely so that a deleted purchase cannot take the sale with it — so the
    // entry that can still be written is written and the other is skipped.
    if (po) {
      recordOrderEvent('po', poId, 'link', {
        detail: `No longer supplies ${soLabel}`,
        actorId,
        db
      })
    }
    recordOrderEvent('so', invoiceId, 'link', {
      detail: `No longer supplied by ${po?.po_number ?? 'a purchase order'}`,
      actorId,
      db
    })
    return { ok: true }
  })
  return run()
}
