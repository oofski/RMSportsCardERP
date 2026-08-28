import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type {
  DeletedOrder,
  NewOrderShipment,
  OrderDocument,
  OrderEvent,
  OrderEventKind,
  OrderShipment,
  OrderShipmentLine,
  OrderSide
} from '@shared/orders'
import { validateOrderDocument, validateShipment } from '@shared/orders'
import { asCarrier, detectCarrier } from '@shared/freight'
import { asShipStatus } from '@shared/tracking'
import { getDb } from './database'

/**
 * The things a purchase order and a sales order both have.
 *
 * Four tables, one module, and the pair `(side, orderId)` is the reference
 * throughout. See @shared/orders for why they are shared rather than duplicated
 * per side, and src/main/db/database.ts v73 for the schema.
 *
 * ## Nothing in here decides anything about an order
 *
 * This module records; it does not move stages, take stock or touch money. A
 * caller that wants an event written after moving a card writes it after moving
 * the card, in the same transaction if it has one. That separation is what lets
 * the log be hooked into three different status-writing paths on the buy side —
 * two of which do not go through setPurchaseOrderStatus at all — without any of
 * them having to know what a log is beyond one function call.
 */

function nowIso(): string {
  return new Date().toISOString()
}

function clean(v: string | null | undefined): string | null {
  const s = String(v ?? '').trim()
  return s === '' ? null : s
}

// ---------------------------------------------------------------------------
// What happened
// ---------------------------------------------------------------------------

interface EventRow {
  id: string
  order_kind: string
  order_id: string
  kind: string
  from_stage: string | null
  to_stage: string | null
  detail: string | null
  actor_id: string | null
  actor_name: string | null
  created_at: string
}

function toEvent(r: EventRow): OrderEvent {
  return {
    id: r.id,
    side: r.order_kind === 'po' ? 'po' : 'so',
    orderId: r.order_id,
    kind: r.kind as OrderEventKind,
    fromStage: r.from_stage,
    toStage: r.to_stage,
    detail: r.detail,
    actorId: r.actor_id,
    actorName: r.actor_name,
    createdAt: r.created_at
  }
}

/**
 * The person's name, looked up once at the moment they act.
 *
 * SNAPSHOTTED, not joined. A log is a record of what happened and somebody
 * leaving next year must not silently rewrite who did what — the same rule an
 * invoice's customer name follows. Null when the id names nobody, which happens
 * for work the app did on its own (an order completing itself when the last box
 * is scanned in) and reads correctly as "not a person".
 */
function actorNameOf(db: Database.Database, actorId: string | null): string | null {
  const id = clean(actorId)
  if (!id) return null
  const row = db
    .prepare(`SELECT first_name AS first, last_name AS last FROM employees WHERE id = ?`)
    .get(id) as { first: string | null; last: string | null } | undefined
  if (!row) return null
  return `${row.first ?? ''} ${row.last ?? ''}`.trim() || null
}

/**
 * Write down that something happened to an order.
 *
 * Takes an optional `db` so it can join a transaction the caller already has
 * open. That is not a convenience: a stage move and the record of it must commit
 * together or the log is a second source of truth that disagrees with the board
 * exactly when somebody is trying to work out what went wrong.
 *
 * Never throws for want of an actor. This is called from the middle of stock
 * movements and status changes, and a log that could fail a receive because it
 * could not resolve a name would be a liability rather than a record.
 */
export function recordOrderEvent(
  side: OrderSide,
  orderId: string,
  kind: OrderEventKind,
  input: {
    fromStage?: string | null
    toStage?: string | null
    detail?: string | null
    actorId?: string | null
    db?: Database.Database
  } = {}
): void {
  const db = input.db ?? getDb()
  const id = clean(orderId)
  if (!id) return
  db.prepare(
    `INSERT INTO order_events
       (id, order_kind, order_id, kind, from_stage, to_stage, detail,
        actor_id, actor_name, created_at)
     VALUES (@id, @side, @orderId, @kind, @from, @to, @detail, @actorId, @actorName, @at)`
  ).run({
    id: `evt_${randomUUID()}`,
    side,
    orderId: id,
    kind,
    from: clean(input.fromStage),
    to: clean(input.toStage),
    detail: clean(input.detail),
    actorId: clean(input.actorId),
    actorName: actorNameOf(db, input.actorId ?? null),
    at: nowIso()
  })
}

/**
 * Everything that has happened to one order, NEWEST FIRST.
 *
 * Newest first because the question is almost always "what just happened" — the
 * log is opened when something looks wrong, and the thing that looks wrong is
 * the most recent thing. A chronological list would put it at the bottom of a
 * panel somebody has to scroll.
 */
export function listOrderEvents(side: OrderSide, orderId: string, limit = 200): OrderEvent[] {
  return (
    getDb()
      .prepare(
        `SELECT id, order_kind, order_id, kind, from_stage, to_stage, detail,
                actor_id, actor_name, created_at
           FROM order_events
          WHERE order_kind = ? AND order_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?`
      )
      .all(side, orderId, Math.max(1, Math.min(1000, limit))) as EventRow[]
  ).map(toEvent)
}

/**
 * EVERY ORDER SOMEBODY DELETED, newest first. The backlog.
 *
 * The owner's question, which had no answer anywhere in the app: "can you see if
 * we deleted any POs, or where I can see what the issue is."
 *
 * A board shows what EXISTS. An order somebody removed left a gap in the number
 * sequence and nothing else — no name, no date, no total, no author. The
 * deal-ticket register knew a number had been handed out and could say "order
 * deleted", which is the fact but not the story.
 *
 * ## Read off the events, which is the only place left to read
 *
 * There is no deleted_orders table and there should not be: a second table would
 * need writing at exactly the same moment for exactly the same reason, and two
 * records of one act is how they come to disagree. `deleteOrderExtras` already
 * leaves order_events standing for precisely this — the comment saying so
 * predates anything actually writing the line.
 *
 * ## Deliberately UNFILTERED by year at this level
 *
 * "Did we delete any POs?" is not a question about a calendar year, and a
 * backlog that hid last December's deletion behind a year picker would answer
 * "no" to somebody who needed "yes, in December". The screen can narrow it; the
 * read does not decide for it.
 */
export function listDeletedOrders(limit = 500): DeletedOrder[] {
  const rows = getDb()
    .prepare(
      `SELECT id, order_kind, order_id, from_stage, detail, actor_id, actor_name, created_at
         FROM order_events
        WHERE kind = 'deleted'
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`
    )
    .all(Math.max(1, Math.min(5000, limit))) as Array<{
    id: string
    order_kind: string
    order_id: string
    from_stage: string | null
    detail: string | null
    actor_id: string | null
    actor_name: string | null
    created_at: string
  }>
  return rows.map((r) => {
    const parsed = parseDeletionDetail(r.detail)
    return {
      id: String(r.id),
      side: (r.order_kind === 'so' ? 'so' : 'po') as OrderSide,
      orderId: String(r.order_id),
      number: parsed.number,
      party: parsed.party,
      total: parsed.total,
      units: parsed.units,
      stage: clean(r.from_stage) || null,
      actorName: clean(r.actor_name) || null,
      actorId: clean(r.actor_id) || null,
      deletedAt: String(r.created_at),
      detail: r.detail ?? null
    }
  })
}

/**
 * Pull the figures back out of the sentence the deletion wrote.
 *
 * ## Why the sentence is the storage
 *
 * `order_events` has one free-text column and no schema of its own, and giving
 * it five more columns that only ONE of nine event kinds would ever fill is a
 * worse trade than parsing a string this module also wrote. The format is not
 * discovered or guessed at: `describeDeletion` composes it, this reads it, and
 * the round trip is pinned by a test.
 *
 * EVERY FIELD FAILS SOFT. A row written before this existed, or by a future
 * version that words it differently, still yields its date, its author and its
 * whole sentence — which is most of the value — rather than being dropped from
 * the list for failing to match a pattern. A backlog that silently omits what it
 * cannot parse is worse than one that shows a line with blanks in it.
 */
function parseDeletionDetail(detail: string | null): {
  number: string | null
  party: string | null
  total: number
  units: number
} {
  const text = String(detail ?? '')
  const head = /^Deleted\s+(.+?)(?:\s+·|$)/.exec(text)
  const lead = head ? head[1].trim() : ''
  const withParty = /\s+with\s+(.+)$/.exec(lead)
  const number = (withParty ? lead.slice(0, withParty.index) : lead).trim()
  const money = /·\s*\$([0-9]+(?:\.[0-9]+)?)/.exec(text)
  const units = /·\s*([0-9]+)\s+units?\b/.exec(text)
  return {
    number: number && number !== 'An unnumbered order' ? number : null,
    party: withParty ? withParty[1].trim() : null,
    total: money ? Number(money[1]) : 0,
    units: units ? Number(units[1]) : 0
  }
}

// ---------------------------------------------------------------------------
// Parcels
// ---------------------------------------------------------------------------

interface ShipmentRow {
  id: string
  order_kind: string
  order_id: string
  position: number
  carrier: string | null
  service: string | null
  tracking_number: string | null
  label_cost: number | null
  tracking_status: string | null
  tracking_status_detail: string | null
  tracking_status_at: string | null
  tracking_checked_at: string | null
  tracking_error: string | null
  tracking_attempted_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

const SHIPMENT_COLS = `id, order_kind, order_id, position, carrier, service, tracking_number,
                       label_cost, tracking_status, tracking_status_detail, tracking_status_at,
                       tracking_checked_at, tracking_error, tracking_attempted_at,
                       created_by, created_at, updated_at`

function toShipment(r: ShipmentRow, lines: OrderShipmentLine[]): OrderShipment {
  return {
    id: r.id,
    side: r.order_kind === 'po' ? 'po' : 'so',
    orderId: r.order_id,
    position: r.position,
    carrier: asCarrier(r.carrier),
    service: r.service,
    trackingNumber: r.tracking_number,
    // Null and zero are different answers — see the note on labelCost.
    labelCost: r.label_cost === null || r.label_cost === undefined ? null : Number(r.label_cost),
    status: asShipStatus(r.tracking_status),
    statusDetail: r.tracking_status_detail,
    statusAt: r.tracking_status_at,
    checkedAt: r.tracking_checked_at,
    error: r.tracking_error,
    attemptedAt: r.tracking_attempted_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lines
  }
}

/** Every parcel on an order, in draw order, each carrying its line assignments. */
export function listShipments(side: OrderSide, orderId: string): OrderShipment[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT ${SHIPMENT_COLS} FROM order_shipments
        WHERE order_kind = ? AND order_id = ?
        ORDER BY position ASC, created_at ASC`
    )
    .all(side, orderId) as ShipmentRow[]
  if (rows.length === 0) return []

  const lineRows = db
    .prepare(
      `SELECT id, shipment_id, line_id, quantity FROM order_shipment_lines
        WHERE order_kind = ? AND order_id = ?`
    )
    .all(side, orderId) as Array<{
    id: string
    shipment_id: string
    line_id: string
    quantity: number
  }>
  const byShipment = new Map<string, OrderShipmentLine[]>()
  for (const l of lineRows) {
    const list = byShipment.get(l.shipment_id) ?? []
    list.push({ id: l.id, shipmentId: l.shipment_id, lineId: l.line_id, quantity: l.quantity })
    byShipment.set(l.shipment_id, list)
  }
  return rows.map((r) => toShipment(r, byShipment.get(r.id) ?? []))
}

export function getShipment(id: string): OrderShipment | null {
  const db = getDb()
  const row = db.prepare(`SELECT ${SHIPMENT_COLS} FROM order_shipments WHERE id = ?`).get(id) as
    | ShipmentRow
    | undefined
  if (!row) return null
  const lines = db
    .prepare(`SELECT id, shipment_id, line_id, quantity FROM order_shipment_lines WHERE shipment_id = ?`)
    .all(id) as Array<{ id: string; shipment_id: string; line_id: string; quantity: number }>
  return toShipment(
    row,
    lines.map((l) => ({
      id: l.id,
      shipmentId: l.shipment_id,
      lineId: l.line_id,
      quantity: l.quantity
    }))
  )
}

/**
 * Keep the order's own carrier columns pointing at the FIRST parcel.
 *
 * ## Why the legacy columns are still written at all
 *
 * `purchase_orders.carrier` / `invoices.carrier` and their two siblings predate
 * this table by a long way, and a good deal reads them: both board cards, both
 * receipts, the tracking sweep, an older copy of the app on somebody's laptop,
 * and the sync manifest, which carries them whether or not anything looks at
 * them. Dropping them would have been a change to every one of those on the day
 * this landed.
 *
 * So they are a MIRROR of the first parcel, written in exactly one place — here
 * — and never edited directly again. That is the whole discipline that stops
 * them becoming a second source of truth: one writer, derived, always after the
 * shipments have settled.
 */
function mirrorPrimaryShipment(db: Database.Database, side: OrderSide, orderId: string): void {
  const table = side === 'po' ? 'purchase_orders' : 'invoices'
  const first = db
    .prepare(
      `SELECT carrier, service, tracking_number FROM order_shipments
        WHERE order_kind = ? AND order_id = ?
        ORDER BY position ASC, created_at ASC LIMIT 1`
    )
    .get(side, orderId) as Record<string, string | null> | undefined

  /**
   * ONLY THE THREE FIELDS SOMEBODY TYPES. The six tracking_* columns beside them
   * are deliberately NOT mirrored, and that is a correctness rule rather than an
   * optimisation.
   *
   * Those columns are written by the carrier-tracking sweep, which reads a real
   * answer off a real carrier — "Delivered, Memphis TN, Tuesday". A parcel row
   * carries its own copies and they are NULL until that sweep has run against
   * that parcel. Mirroring them across would copy six nulls over a true reading
   * every time anybody touched an unrelated field, so typing a postage figure
   * would wipe a delivery confirmation — and if the carrier has since aged the
   * number out of its system, it never comes back.
   *
   * The status the ORDER shows therefore stays whatever the sweep last wrote,
   * which is the only thing that ever had the right to write it.
   */
  db.prepare(
    `UPDATE ${table}
        SET carrier = @carrier, service = @service, tracking_number = @tracking,
            updated_at = @at
      WHERE id = @id`
  ).run({
    carrier: first?.carrier ?? null,
    service: first?.service ?? null,
    tracking: first?.tracking_number ?? null,
    at: nowIso(),
    id: orderId
  })
}

/** Renumber positions so they are 0..n-1 with no gaps, whatever was deleted. */
function repackPositions(db: Database.Database, side: OrderSide, orderId: string): void {
  const rows = db
    .prepare(
      `SELECT id FROM order_shipments WHERE order_kind = ? AND order_id = ?
        ORDER BY position ASC, created_at ASC`
    )
    .all(side, orderId) as Array<{ id: string }>
  const set = db.prepare(`UPDATE order_shipments SET position = ? WHERE id = ?`)
  rows.forEach((r, i) => set.run(i, r.id))
}

/**
 * Add a parcel, or change one.
 *
 * ## The carrier is GUESSED from the number, once
 *
 * A tracking number carries its carrier in its shape, and `detectCarrier`
 * already knows how to read it — the same function the shipping module uses. So
 * the ordinary gesture is to paste a number and be done: the carrier fills
 * itself in and the service list that depends on it appears with it.
 *
 * The guess is only ever made when nobody has said. An explicit carrier always
 * wins, including one somebody corrected after the guess was wrong, because a
 * screen that re-guesses on every keystroke is one you cannot override.
 *
 * ## Changing the carrier clears the service
 *
 * Services belong to a carrier — "Ground Advantage" is USPS and means nothing to
 * FedEx — so a service left behind by a carrier change is a value the new
 * carrier's list has no option for, which renders as blank and reads as the
 * service having been wiped. Clearing it deliberately says so.
 */
export function saveShipment(
  side: OrderSide,
  orderId: string,
  input: NewOrderShipment & { id?: string | null },
  actorId: string | null
): OrderShipment {
  const db = getDb()
  const run = db.transaction((): string => {
    const stamp = nowIso()
    const existingId = clean(input.id)
    const existing = existingId
      ? (db.prepare(`SELECT ${SHIPMENT_COLS} FROM order_shipments WHERE id = ?`).get(existingId) as
          | ShipmentRow
          | undefined)
      : undefined

    /**
     * AN OMITTED FIELD KEEPS WHAT IT HAD; AN EXPLICIT NULL CLEARS IT.
     *
     * The distinction is the whole of this function's contract and it is not
     * decoration. Callers send partial updates constantly — the screen that
     * assigns line items to a parcel sends `{ id, lines }` and nothing else, and
     * the one that fills in a label cost sends `{ id, labelCost }` — and reading
     * `undefined` as "clear it" would have those two screens silently wipe the
     * tracking number every time they were used.
     *
     * `undefined` and `null` are therefore different values here, which is
     * unusual enough to say out loud: `undefined` means "I am not talking about
     * this field", `null` means "empty it".
     */
    const keep = <T>(given: T | null | undefined, held: T | null): T | null =>
      given === undefined ? held : (given ?? null)

    const tracking = keep(input.trackingNumber === undefined ? undefined : clean(input.trackingNumber), existing?.tracking_number ?? null)
    // Explicit beats guessed; guessed beats nothing. A number that changes to
    // one of a different shape re-guesses only when the carrier was never
    // stated, so a hand-corrected carrier survives a corrected number.
    const held = existing?.carrier ? asCarrier(existing.carrier) : null
    const carrier =
      (input.carrier === undefined ? held : (input.carrier ?? null)) ??
      (tracking ? detectCarrier(tracking) : null)

    // CHANGING THE CARRIER CLEARS THE SERVICE. Services belong to a carrier —
    // "Ground Advantage" is USPS and means nothing to FedEx — so a service left
    // behind by a carrier change is a value the new carrier's list has no option
    // for, which renders blank and reads as the service having been wiped by
    // itself. Clearing it deliberately says so instead.
    const carrierChanged = !!existing && held !== null && held !== carrier
    const service =
      input.service !== undefined
        ? clean(input.service)
        : carrierChanged
          ? null
          : (existing?.service ?? null)

    const cost =
      input.labelCost === undefined
        ? (existing?.label_cost ?? null)
        : input.labelCost === null || !Number.isFinite(input.labelCost)
          ? null
          : Math.round(Number(input.labelCost) * 100) / 100

    // Validated against the MERGED result rather than the patch. A patch that
    // only assigns line items carries no tracking number and no carrier, and
    // refusing it for that would make "say what is in this parcel" impossible on
    // a parcel that already exists.
    const problem = validateShipment({
      trackingNumber: tracking,
      carrier,
      service,
      labelCost: cost,
      lines: input.lines
    })
    if (problem) throw new Error(problem)

    const id = existing?.id ?? `shp_${randomUUID()}`
    if (existing) {
      db.prepare(
        `UPDATE order_shipments
            SET carrier = @carrier, service = @service, tracking_number = @tracking,
                label_cost = @cost, updated_at = @at
          WHERE id = @id`
      ).run({ carrier, service, tracking, cost, at: stamp, id })
    } else {
      const next = db
        .prepare(
          `SELECT COALESCE(MAX(position) + 1, 0) AS n FROM order_shipments
            WHERE order_kind = ? AND order_id = ?`
        )
        .get(side, orderId) as { n: number }
      db.prepare(
        `INSERT INTO order_shipments
           (id, order_kind, order_id, position, carrier, service, tracking_number,
            label_cost, created_by, created_at, updated_at)
         VALUES (@id, @side, @orderId, @position, @carrier, @service, @tracking,
                 @cost, @actor, @at, @at)`
      ).run({
        id,
        side,
        orderId,
        position: next.n,
        carrier,
        service,
        tracking,
        cost,
        actor: clean(actorId),
        at: stamp
      })
    }

    // Line assignments are REPLACED wholesale rather than patched. A parcel's
    // contents are decided as a set — "these three boxes go in this one" — and
    // merging two sets is how a line ends up in two parcels with nothing to say
    // which is right.
    if (input.lines) {
      db.prepare(`DELETE FROM order_shipment_lines WHERE shipment_id = ?`).run(id)
      const add = db.prepare(
        `INSERT INTO order_shipment_lines
           (id, shipment_id, order_kind, order_id, line_id, quantity, created_at)
         VALUES (@id, @shipmentId, @side, @orderId, @lineId, @quantity, @at)`
      )
      for (const l of input.lines) {
        const lineId = clean(l.lineId)
        if (!lineId || !(l.quantity > 0)) continue
        add.run({
          // Derived from the parcel and the line, so two machines assigning the
          // same line to the same parcel write the SAME row rather than two.
          id: `shl_${id}_${lineId}`,
          shipmentId: id,
          side,
          orderId,
          lineId,
          quantity: l.quantity,
          at: stamp
        })
      }
    }

    repackPositions(db, side, orderId)
    mirrorPrimaryShipment(db, side, orderId)
    return id
  })

  const id = run()
  return getShipment(id) as OrderShipment
}

/** Remove a parcel and everything assigned to it. */
export function deleteShipment(id: string): { side: OrderSide; orderId: string } | null {
  const db = getDb()
  const run = db.transaction((): { side: OrderSide; orderId: string } | null => {
    const row = db
      .prepare(`SELECT order_kind, order_id FROM order_shipments WHERE id = ?`)
      .get(id) as { order_kind: string; order_id: string } | undefined
    if (!row) return null
    const side: OrderSide = row.order_kind === 'po' ? 'po' : 'so'
    db.prepare(`DELETE FROM order_shipment_lines WHERE shipment_id = ?`).run(id)
    // The label attached to a parcel outlives it, re-pointed at the order. The
    // file is a real thing somebody uploaded and deleting a tracking number is
    // not a decision to throw it away.
    db.prepare(`UPDATE order_documents SET shipment_id = NULL WHERE shipment_id = ?`).run(id)
    db.prepare(`UPDATE order_document_parts SET shipment_id = NULL WHERE shipment_id = ?`).run(id)
    db.prepare(`DELETE FROM order_shipments WHERE id = ?`).run(id)
    repackPositions(db, side, row.order_id)
    mirrorPrimaryShipment(db, side, row.order_id)
    return { side, orderId: row.order_id }
  })
  return run()
}

/** Write down what a carrier said about one parcel. Facts only. */
export function recordShipmentTracking(
  id: string,
  reading: {
    status: string | null
    detail: string | null
    at: string | null
  }
): void {
  const stamp = nowIso()
  const db = getDb()
  db.prepare(
    `UPDATE order_shipments
        SET tracking_status = ?, tracking_status_detail = ?, tracking_status_at = ?,
            tracking_checked_at = ?, tracking_attempted_at = ?, tracking_error = NULL,
            updated_at = ?
      WHERE id = ?`
  ).run(reading.status, reading.detail, reading.at, stamp, stamp, stamp, id)
  const row = db.prepare(`SELECT order_kind, order_id FROM order_shipments WHERE id = ?`).get(id) as
    | { order_kind: string; order_id: string }
    | undefined
  if (row) mirrorPrimaryShipment(db, row.order_kind === 'po' ? 'po' : 'so', row.order_id)
}

/**
 * We asked a carrier and could not get an answer.
 *
 * Touches attempted_at and the error and NOTHING else — the same stale-but-true
 * rule the order-level tracking columns already follow. A package that was in
 * Memphis yesterday is still in Memphis during an outage, and blanking the
 * reading because the network was down takes a true answer off the screen and
 * replaces it with nothing.
 */
export function recordShipmentTrackingFailure(id: string, error: string): void {
  const stamp = nowIso()
  const db = getDb()
  db.prepare(
    `UPDATE order_shipments
        SET tracking_attempted_at = ?, tracking_error = ?, updated_at = ?
      WHERE id = ?`
  ).run(stamp, error.slice(0, 2000), stamp, id)
  const row = db.prepare(`SELECT order_kind, order_id FROM order_shipments WHERE id = ?`).get(id) as
    | { order_kind: string; order_id: string }
    | undefined
  if (row) mirrorPrimaryShipment(db, row.order_kind === 'po' ? 'po' : 'so', row.order_id)
}

/**
 * Turn freight typed on an ORDER FORM into the parcel it describes.
 *
 * ## Why this exists, and what breaks without it
 *
 * Both order forms carry a carrier / service / tracking box, and they predate
 * parcels by a long way — they write `carrier`, `service` and `tracking_number`
 * straight onto the order. Those three columns are now a MIRROR of the first
 * parcel, maintained by exactly one writer.
 *
 * That left a hole at creation. An order raised with a tracking number wrote the
 * columns and no parcel; the Parcels panel then showed nothing; and the moment
 * anybody added a parcel the mirror overwrote those columns from it, silently
 * destroying the number somebody had typed. The same hole swallowed a number
 * typed into the old editor on a receipt.
 *
 * So freight entered on a form becomes a parcel here, at the point the order is
 * saved, and from then on there is one store and one writer.
 *
 * IDEMPOTENT, and that is what makes it safe to call from a save that runs
 * repeatedly: it does nothing at all when the order already has any parcel, so
 * editing an order that has since been split into three boxes cannot resurrect
 * a fourth from the header.
 */
export function adoptLegacyFreight(
  side: OrderSide,
  orderId: string,
  freight: { carrier?: string | null; service?: string | null; trackingNumber?: string | null },
  actorId: string | null,
  db?: Database.Database
): void {
  const database = db ?? getDb()
  const tracking = clean(freight.trackingNumber)
  const carrier = asCarrier(freight.carrier ?? null)
  const service = clean(freight.service)
  if (!tracking && !carrier && !service) return

  const existing = database
    .prepare(
      `SELECT COUNT(*) AS n FROM order_shipments WHERE order_kind = ? AND order_id = ?`
    )
    .get(side, orderId) as { n: number }
  if (existing.n > 0) return

  const stamp = nowIso()
  database
    .prepare(
      `INSERT INTO order_shipments
         (id, order_kind, order_id, position, carrier, service, tracking_number,
          created_by, created_at, updated_at)
       VALUES (@id, @side, @orderId, 0, @carrier, @service, @tracking, @actor, @at, @at)`
    )
    .run({
      // Derived from the order, so two machines saving the same order mint the
      // SAME row rather than two parcels where there is one.
      id: `shp_${side}_${orderId}_0`,
      side,
      orderId,
      carrier: carrier ?? (tracking ? detectCarrier(tracking) : null),
      service,
      tracking,
      actor: clean(actorId),
      at: stamp
    })
}

/** Every parcel anywhere that carries a number worth asking a carrier about. */
export function listTrackableShipments(limit = 400): OrderShipment[] {
  const rows = getDb()
    .prepare(
      `SELECT ${SHIPMENT_COLS} FROM order_shipments
        WHERE tracking_number IS NOT NULL AND tracking_number != ''
        ORDER BY updated_at DESC LIMIT ?`
    )
    .all(Math.max(1, Math.min(2000, limit))) as ShipmentRow[]
  return rows.map((r) => toShipment(r, []))
}

// ---------------------------------------------------------------------------
// Paperwork
// ---------------------------------------------------------------------------

/**
 * How big one slice is.
 *
 * The same 512KB the packing slip uses, and for the same reason: it is small
 * enough that a slice is an ordinary synced row the relay carries without
 * knowing it is carrying a PDF, and large enough that an eight-megabyte ceiling
 * is sixteen rows rather than several hundred.
 */
const SLICE_BYTES = 512 * 1024

interface DocumentRow {
  id: string
  order_kind: string
  order_id: string
  shipment_id: string | null
  kind: string
  name: string
  mime_type: string
  byte_size: number
  uploaded_by: string | null
  uploaded_at: string
}

function toDocument(r: DocumentRow, present: boolean): OrderDocument {
  return {
    id: r.id,
    side: r.order_kind === 'po' ? 'po' : 'so',
    orderId: r.order_id,
    shipmentId: r.shipment_id,
    kind: r.kind === 'other' ? 'other' : 'label',
    name: r.name,
    mimeType: r.mime_type,
    byteSize: r.byte_size,
    uploadedBy: r.uploaded_by,
    uploadedAt: r.uploaded_at,
    present
  }
}

/**
 * Store a file against an order, and cut it into slices that travel.
 *
 * BOTH WRITES HAPPEN OR NEITHER DOES. The whole-file row is what this machine
 * reads and the slices are what every other machine rebuilds from; a document
 * saved without its slices is one only the uploader can ever open, which is the
 * exact failure the packing slip had before it was sliced — everybody else saw
 * "no document on this machine" while the metadata sat there insisting one
 * existed.
 */
export function saveOrderDocument(
  side: OrderSide,
  orderId: string,
  input: {
    name: string
    mimeType: string
    bytes: Buffer
    kind?: 'label' | 'other'
    shipmentId?: string | null
  },
  actorId: string | null
): OrderDocument {
  const problem = validateOrderDocument({
    name: input.name,
    mimeType: input.mimeType,
    byteSize: input.bytes.byteLength
  })
  if (problem) throw new Error(problem)

  const db = getDb()
  const id = `doc_${randomUUID()}`
  const stamp = nowIso()
  const kind = input.kind ?? 'label'
  const shipmentId = clean(input.shipmentId)
  const total = Math.max(1, Math.ceil(input.bytes.byteLength / SLICE_BYTES))

  db.transaction(() => {
    db.prepare(
      `INSERT INTO order_documents
         (id, order_kind, order_id, shipment_id, kind, name, mime_type, byte_size,
          bytes, uploaded_by, uploaded_at)
       VALUES (@id, @side, @orderId, @shipmentId, @kind, @name, @mime, @size,
               @bytes, @actor, @at)`
    ).run({
      id,
      side,
      orderId,
      shipmentId,
      kind,
      name: input.name.trim(),
      mime: input.mimeType,
      size: input.bytes.byteLength,
      bytes: input.bytes,
      actor: clean(actorId),
      at: stamp
    })

    const addPart = db.prepare(
      `INSERT INTO order_document_parts
         (id, document_id, order_kind, order_id, shipment_id, kind, name, mime_type,
          byte_size, uploaded_by, uploaded_at, seq, total, data, created_at)
       VALUES (@id, @documentId, @side, @orderId, @shipmentId, @kind, @name, @mime,
               @size, @actor, @at, @seq, @total, @data, @at)`
    )
    for (let seq = 0; seq < total; seq++) {
      const slice = input.bytes.subarray(seq * SLICE_BYTES, (seq + 1) * SLICE_BYTES)
      addPart.run({
        id: `dpt_${id}_${seq}`,
        documentId: id,
        side,
        orderId,
        shipmentId,
        kind,
        name: input.name.trim(),
        mime: input.mimeType,
        size: input.bytes.byteLength,
        actor: clean(actorId),
        at: stamp,
        seq,
        total,
        data: slice.toString('base64')
      })
    }
  })()

  return getOrderDocument(id) as OrderDocument
}

/**
 * The documents on an order, newest first, each saying whether its bytes are
 * actually on this machine.
 *
 * The presence test is a LEFT JOIN against the whole-file table rather than a
 * flag, because presence is per-machine and a flag would sync — telling every
 * other laptop that a file it has never received is present.
 */
export function listOrderDocuments(side: OrderSide, orderId: string): OrderDocument[] {
  const db = getDb()
  // Read from the PARTS, because those are what travel. A machine that has
  // received slices but not yet rebuilt them still knows the document exists,
  // which is the whole point of saying "not on this machine" rather than
  // pretending there is nothing.
  const rows = db
    .prepare(
      `SELECT p.document_id AS id, MAX(p.order_kind) AS order_kind, MAX(p.order_id) AS order_id,
              MAX(p.shipment_id) AS shipment_id, MAX(p.kind) AS kind, MAX(p.name) AS name,
              MAX(p.mime_type) AS mime_type, MAX(p.byte_size) AS byte_size,
              MAX(p.uploaded_by) AS uploaded_by, MAX(p.uploaded_at) AS uploaded_at,
              (SELECT COUNT(*) FROM order_documents d WHERE d.id = p.document_id) AS present
         FROM order_document_parts p
        WHERE p.order_kind = ? AND p.order_id = ?
        GROUP BY p.document_id
        ORDER BY uploaded_at DESC`
    )
    .all(side, orderId) as Array<DocumentRow & { present: number }>
  return rows.map((r) => toDocument(r, r.present > 0))
}

export function getOrderDocument(id: string): OrderDocument | null {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT id, order_kind, order_id, shipment_id, kind, name, mime_type, byte_size,
              uploaded_by, uploaded_at
         FROM order_documents WHERE id = ?`
    )
    .get(id) as DocumentRow | undefined
  return row ? toDocument(row, true) : null
}

/** The file itself, or null when this machine does not hold it yet. */
export function getOrderDocumentBytes(id: string): { name: string; mimeType: string; bytes: Buffer } | null {
  const row = getDb()
    .prepare(`SELECT name, mime_type, bytes FROM order_documents WHERE id = ?`)
    .get(id) as { name: string; mime_type: string; bytes: Buffer | null } | undefined
  if (!row?.bytes) return null
  return { name: row.name, mimeType: row.mime_type, bytes: Buffer.from(row.bytes) }
}

/**
 * Remove a document — the file AND its slices.
 *
 * The slices have to go or the next sync rebuilds the file from them, which
 * reads as a delete that did not work. That is the mirror of the rule above:
 * both writes happen or neither does, in both directions.
 */
export function deleteOrderDocument(id: string): { side: OrderSide; orderId: string } | null {
  const db = getDb()
  const run = db.transaction((): { side: OrderSide; orderId: string } | null => {
    const row = db
      .prepare(
        `SELECT order_kind, order_id FROM order_document_parts WHERE document_id = ? LIMIT 1`
      )
      .get(id) as { order_kind: string; order_id: string } | undefined
    db.prepare(`DELETE FROM order_document_parts WHERE document_id = ?`).run(id)
    const gone = db.prepare(`DELETE FROM order_documents WHERE id = ?`).run(id)
    if (!row && gone.changes === 0) return null
    return { side: row?.order_kind === 'po' ? 'po' : 'so', orderId: row?.order_id ?? '' }
  })
  return run()
}

/**
 * Rebuild every document whose slices have all arrived.
 *
 * The counterpart to rebuildShipDocument and, deliberately, the same shape. The
 * thing that travels is the set of small immutable rows; the big artefact is
 * reconstructed by whoever receives them, because a file is not a value two
 * machines can arbitrate — it is either whole or it is not.
 *
 * WAITS FOR EVERY SLICE. A label assembled from four of five is a corrupt file
 * that opens to a blank page, and somebody hands that to a courier. Until the
 * count matches, this does nothing at all and the screen says the label is still
 * arriving.
 *
 * Returns how many were rebuilt — 0 in the overwhelmingly common case where
 * nothing changed.
 */
export function rebuildOrderDocuments(): number {
  const db = getDb()
  const ready = db
    .prepare(
      `SELECT p.document_id AS id, p.total AS total,
              MAX(p.order_kind) AS order_kind, MAX(p.order_id) AS order_id,
              MAX(p.shipment_id) AS shipment_id, MAX(p.kind) AS kind, MAX(p.name) AS name,
              MAX(p.mime_type) AS mime_type, MAX(p.byte_size) AS byte_size,
              MAX(p.uploaded_by) AS uploaded_by, MAX(p.uploaded_at) AS uploaded_at
         FROM order_document_parts p
        WHERE NOT EXISTS (SELECT 1 FROM order_documents d WHERE d.id = p.document_id)
        GROUP BY p.document_id, p.total
       HAVING COUNT(*) = p.total`
    )
    .all() as Array<DocumentRow & { total: number }>
  if (ready.length === 0) return 0

  let rebuilt = 0
  for (const doc of ready) {
    const slices = db
      .prepare(`SELECT data FROM order_document_parts WHERE document_id = ? ORDER BY seq ASC`)
      .all(doc.id) as Array<{ data: string }>
    const bytes = Buffer.concat(slices.map((s) => Buffer.from(s.data, 'base64')))
    // A length that disagrees with what the sender recorded means a slice is
    // truncated or a seq is missing in a way COUNT could not see. Refusing is
    // the only safe answer for a document somebody prints and sticks on a box.
    if (doc.byte_size > 0 && bytes.byteLength !== doc.byte_size) continue
    db.prepare(
      `INSERT OR REPLACE INTO order_documents
         (id, order_kind, order_id, shipment_id, kind, name, mime_type, byte_size,
          bytes, uploaded_by, uploaded_at)
       VALUES (@id, @side, @orderId, @shipmentId, @kind, @name, @mime, @size,
               @bytes, @actor, @at)`
    ).run({
      id: doc.id,
      side: doc.order_kind,
      orderId: doc.order_id,
      shipmentId: doc.shipment_id,
      kind: doc.kind,
      name: doc.name,
      mime: doc.mime_type,
      size: bytes.byteLength,
      bytes,
      actor: doc.uploaded_by,
      at: doc.uploaded_at
    })
    rebuilt++
  }
  return rebuilt
}

/** Every document on an order goes when the order does. */
export function deleteOrderExtras(side: OrderSide, orderId: string, db?: Database.Database): void {
  const database = db ?? getDb()
  database.prepare(`DELETE FROM order_document_parts WHERE order_kind = ? AND order_id = ?`).run(side, orderId)
  database.prepare(`DELETE FROM order_documents WHERE order_kind = ? AND order_id = ?`).run(side, orderId)
  database.prepare(`DELETE FROM order_shipment_lines WHERE order_kind = ? AND order_id = ?`).run(side, orderId)
  database.prepare(`DELETE FROM order_shipments WHERE order_kind = ? AND order_id = ?`).run(side, orderId)
  // The EVENTS are deliberately left. A deleted order is itself a thing that
  // happened, and the log is the only place that would still say so.
}
