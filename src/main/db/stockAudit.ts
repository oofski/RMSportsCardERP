/**
 * The stock audit's reads. See @shared/stockAudit for what each check is FOR
 * and why the normal case has to stay silent.
 *
 * ## The one design rule here
 *
 * THE EXPECTED FIGURE IS COMPUTED BY THE ENGINE'S OWN FUNCTION, never by a
 * query written to match it. `stockDrawingLines` is what `rederiveInvoiceStock`
 * hands to `applyInvoiceStock`, so "what should have been booked" and "what the
 * booking code would book" cannot drift apart. A hand-rolled
 * `WHERE destination IN (...)` would be a second copy of the rule, and the first
 * time a destination rule moved, this would start reporting every dropship as
 * broken — which is how a report gets switched off and stops finding the real
 * thing.
 *
 * ## Why it walks orders one at a time
 *
 * Because the allocations do. A line split six-off-RM and four-to-a-dropship is
 * two different answers from one row, and there is no single join that gets
 * that right. This is a check somebody runs when they want to know, not
 * something on a hot path, so clarity wins over a clever query.
 */
import type Database from 'better-sqlite3'
import { getDb } from './database'
import { readLineAllocations, stockDrawingLines } from './invoices'
import { invoiceStockLocation } from './invoiceStock'
import { AUDIT_EPS, describeShortBooking, rankFindings } from '@shared/stockAudit'
import type { StockAudit, StockFinding } from '@shared/stockAudit'

interface InvoiceRow {
  id: string
  invoice_number: string | null
  customer_name: string | null
  location: string | null
  status: string
}

interface LineRow {
  id: string
  position: number
  product_id: string | null
  quantity: number
  destination: string | null
  supplier: string | null
  source_po_id: string | null
}

const nameOf = (r: InvoiceRow): string => {
  const num = (r.invoice_number ?? '').trim()
  const who = (r.customer_name ?? '').trim()
  if (num && who) return `${num} (${who})`
  return num || who || 'An order with no number'
}

/**
 * Orders whose stock never came off the shelf, or only partly did.
 *
 * ONLY VOIDS ARE EXCLUDED, and the first cut of this excluded drafts too and was
 * WRONG — a mistake the tests caught before it shipped. In this app a draft
 * takes stock at save like anything else: `saveInvoice` runs the stock engine
 * whatever the status, and `listWholesaleSales` counts any order that is not
 * void. So a draft sold before its goods landed is untied in exactly the same
 * way and missing from exactly the same three screens, and skipping drafts here
 * would have hidden the very fault this was built to find.
 *
 * A void is different and is correctly skipped: it handed its stock back on
 * purpose, so having no moves is it working.
 */
function auditOrders(db: Database.Database): { findings: StockFinding[]; checked: number } {
  const invoices = db
    .prepare(
      `SELECT id, invoice_number, customer_name, location, status
         FROM invoices
        WHERE status <> 'void'
        ORDER BY invoice_date DESC, invoice_number DESC`
    )
    .all() as InvoiceRow[]

  const linesFor = db.prepare(
    `SELECT id, position, product_id, quantity, destination, supplier, source_po_id
       FROM invoice_lines WHERE invoice_id = ? ORDER BY position`
  )
  const bookedFor = db.prepare(
    `SELECT COALESCE(SUM(quantity), 0) AS n FROM invoice_stock_moves WHERE invoice_id = ?`
  )

  const findings: StockFinding[] = []
  for (const inv of invoices) {
    const lines = linesFor.all(inv.id) as LineRow[]
    if (lines.length === 0) continue
    const shelf = invoiceStockLocation(inv.location)
    const splits = readLineAllocations(db, inv.id)
    // The engine's own answer. See the header.
    const drawing = stockDrawingLines(
      lines.map((l) => ({ ...l, allocations: splits.get(l.id) })),
      shelf
    )
    const expected = drawing.reduce((sum, l) => sum + l.quantity, 0)
    // An order that should draw nothing — every line a dropship — is correct
    // with no moves, and must never be reported.
    if (!(expected > AUDIT_EPS)) continue

    const booked = Number((bookedFor.get(inv.id) as { n: number }).n) || 0
    if (booked >= expected - AUDIT_EPS) continue

    const said = describeShortBooking(nameOf(inv), expected, booked)
    findings.push({
      kind: booked <= AUDIT_EPS ? 'sold-not-booked' : 'sold-part-booked',
      subject: nameOf(inv),
      invoiceId: inv.id,
      productId: null,
      location: shelf,
      units: Math.round((expected - booked) * 1000) / 1000,
      sentence: said.sentence,
      remedy: said.remedy
    })
  }
  return { findings, checked: invoices.length }
}

/**
 * Shelves whose count and whose cost layers describe different amounts of
 * stock, and shelves holding less than nothing.
 *
 * The same comparison `assertStockLotsConsistent` makes, reported rather than
 * thrown — a fault that only ever surfaces as a crash halfway through somebody's
 * save is one nobody can go looking for on a quiet afternoon.
 */
function auditShelves(db: Database.Database): { findings: StockFinding[]; checked: number } {
  const rows = db
    .prepare(
      `SELECT s.product_id AS pid, s.location AS loc, s.quantity AS stock,
              COALESCE((SELECT SUM(l.qty_remaining) FROM inventory_lots l
                         WHERE l.product_id = s.product_id AND l.location = s.location), 0) AS lots,
              (SELECT p.name FROM inventory_products p WHERE p.id = s.product_id) AS name
         FROM inventory_stock s`
    )
    .all() as Array<{ pid: string; loc: string; stock: number; lots: number; name: string | null }>

  const findings: StockFinding[] = []
  for (const r of rows) {
    const what = (r.name ?? '').trim() || r.pid
    if (r.stock < -AUDIT_EPS) {
      findings.push({
        kind: 'negative-shelf',
        subject: `${what} at ${r.loc}`,
        invoiceId: null,
        productId: r.pid,
        location: r.loc,
        units: Math.abs(r.stock),
        sentence:
          `${what} is showing ${r.stock} at ${r.loc}. A shelf cannot hold less than nothing, so ` +
          'something was sold twice or a receipt was undone after the units had already gone.',
        remedy: 'Count the shelf and set it right in Inventory; the cost layers will follow.'
      })
      continue
    }
    const gap = r.stock - r.lots
    if (Math.abs(gap) > AUDIT_EPS) {
      findings.push({
        kind: 'shelf-vs-layers',
        subject: `${what} at ${r.loc}`,
        invoiceId: null,
        productId: r.pid,
        location: r.loc,
        units: Math.abs(gap),
        sentence:
          `${what} at ${r.loc} counts ${r.stock} on the shelf but its cost layers add up to ${r.lots}. ` +
          'The count and the money are describing different amounts of the same stock, so the margin ' +
          'on anything sold off this shelf is wrong.',
        remedy: 'Re-count this product at this location — saving the count rebuilds the layers to match.'
      })
    }
  }
  return { findings, checked: rows.length }
}

/**
 * Units checked in against a purchase order that opened no cost layer.
 *
 * They are on the shelf and they cost nothing, so everything they sell into
 * reports pure profit. `price_pending` lines are excluded on purpose: a roadshow
 * case whose price is genuinely not known yet is uncosted BY DESIGN and is
 * already chased elsewhere, so listing it here would be a second nag for a
 * thing that is not wrong.
 */
function auditReceipts(db: Database.Database): StockFinding[] {
  const rows = db
    .prepare(
      `SELECT l.id, l.qty_received AS got, po.po_number AS po,
              (SELECT p.name FROM inventory_products p WHERE p.id = l.product_id) AS name,
              l.product_id AS pid, l.destination AS dest
         FROM purchase_order_lines l
         JOIN purchase_orders po ON po.id = l.po_id
        WHERE l.qty_received > 0
          AND COALESCE(l.price_pending, 0) = 0
          AND NOT EXISTS (SELECT 1 FROM po_line_receipts r WHERE r.po_line_id = l.id)`
    )
    .all() as Array<{ id: string; got: number; po: string | null; name: string | null; pid: string; dest: string | null }>

  return rows.map((r) => {
    const what = (r.name ?? '').trim() || r.pid
    return {
      kind: 'received-uncosted' as const,
      subject: `${what} on ${(r.po ?? '').trim() || 'a purchase order'}`,
      invoiceId: null,
      productId: r.pid,
      location: (r.dest ?? '').trim() || null,
      units: r.got,
      sentence:
        `${r.got} of ${what} were checked in against ${(r.po ?? '').trim() || 'a purchase order'} but no cost ` +
        'layer was opened for them. They are on the shelf carrying nothing, so anything they sell into ' +
        'reports the whole price as profit.',
      remedy: 'Undo the receipt on that purchase order and check the units in again.'
    }
  })
}

/** Run every check. Reads only — see the note in @shared/stockAudit. */
export function auditStock(): StockAudit {
  const db = getDb()
  const orders = auditOrders(db)
  const shelves = auditShelves(db)
  const receipts = auditReceipts(db)
  return {
    findings: rankFindings([...orders.findings, ...shelves.findings, ...receipts]),
    ordersChecked: orders.checked,
    shelvesChecked: shelves.checked,
    checkedAt: new Date().toISOString()
  }
}
