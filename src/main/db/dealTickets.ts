import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { DealTicket, DealTicketKind, DealTicketRow } from '@shared/dealTickets'
import {
  DEAL_TICKET_FLOOR,
  dropshipKindFor,
  formatDealTicket,
  parseDealTicketSeq
} from '@shared/dealTickets'
import { getDb, getMeta, setMeta } from './database'

/**
 * Issuing and reading deal tickets.
 *
 * See @shared/dealTickets for what a deal ticket IS and why numbering starts at
 * 337, and src/main/db/database.ts v74 for the schema.
 *
 * ## Every write in here takes a `db`
 *
 * A ticket is struck in the SAME transaction that creates the document it
 * names. That is the whole correctness argument: a purchase order that exists
 * without a ticket, or a ticket pointing at a purchase order that was rolled
 * back, are both states the register can never recover from on its own, because
 * nothing afterwards knows a number was owed. Passing the caller's handle is
 * what makes the pair atomic — the same reason `recordOrderEvent` takes one.
 *
 * ## Issuing NEVER throws
 *
 * A register is bookkeeping. It must not be able to fail a purchase order —
 * refusing to let somebody buy stock because a numbering table misbehaved is a
 * far worse outcome than a movement that is missing its ticket. So the issue
 * path swallows, and the read path reports what is there.
 */

/**
 * The next number to hand out.
 *
 * Two sources, and the answer is the higher of them plus one:
 *
 *   - a counter in `meta`, which is the FLOOR. Seeded at 336 by the v74
 *     migration so the first issue is 337, and it only ever climbs — so a run of
 *     deleted tickets cannot hand the same number out twice.
 *   - MAX over the table, which catches numbers that arrived from ANOTHER
 *     machine through sync. That laptop advanced its own counter, not this
 *     one's, so without this term two machines trading offline would both keep
 *     issuing from wherever they each got to and collide on every ticket.
 *
 * GLOB rather than LIKE, for the reason `nextPoNumber` gives: LIKE is
 * case-insensitive here and '[0-9]' is not a LIKE wildcard, so it would match
 * any number-shaped string this app never minted. CAST stops at the first
 * non-digit and yields 0 for anything unparseable.
 *
 * The integer is recovered from the LABEL rather than read from a column beside
 * it, because relabelling is exactly what happens on a sync collision and a
 * stored copy would be the thing that stopped agreeing. See the v74 migration.
 */
/**
 * The highest number considered spent, from all three sources at once.
 *
 * ONE function so the issuer and the peek cannot drift. They previously
 * computed this separately, which meant a change to one left the other quoting
 * a number the register would not actually hand out — and the peek is what the
 * empty state prints, so the screen would have promised the wrong thing.
 *
 * DEAL_TICKET_FLOOR is a term here rather than a fallback for the counter,
 * because a database that predates the seed (or one whose meta row was lost)
 * must still never issue 336 or below.
 */
function ceilingSeq(db: Database.Database): number {
  const fromCounter = Number(getMeta(db, 'deal_ticket_seq') ?? '') || 0
  const row = db
    .prepare(
      `SELECT MAX(CAST(SUBSTR(number, 4) AS INTEGER)) AS n
         FROM deal_tickets WHERE number GLOB 'DT-[0-9]*'`
    )
    .get() as { n: number | null } | undefined
  return Math.max(DEAL_TICKET_FLOOR, fromCounter, Number(row?.n ?? 0) || 0)
}

export function nextDealTicketSeq(db: Database.Database): number {
  const seq = ceilingSeq(db) + 1
  // Written back BEFORE the caller inserts anything, so the number is spent the
  // moment it is handed out. A caller that goes on to fail leaves a gap, which
  // is the safe direction: a gap is explainable, a reissue is not.
  setMeta(db, 'deal_ticket_seq', String(seq))
  return seq
}

/** The next number, formatted. The relabel hook sync calls on a collision. */
export function nextDealTicketNumber(db: Database.Database): string {
  return formatDealTicket(nextDealTicketSeq(db))
}

export interface IssueDealTicketInput {
  kind: DealTicketKind
  documentKind: 'po' | 'so'
  documentId: string
  documentNumber?: string | null
  party?: string | null
  amount?: number | null
  issuedAt?: string | null
  actorId?: string | null
}

const clean = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim()
  return s === '' ? null : s
}

/**
 * Strike a ticket for a document, or hand back the one it already has.
 *
 * IDEMPOTENT PER DOCUMENT, and that is load-bearing rather than defensive.
 * `saveInvoice` is one statement that inserts or updates, dropship linking runs
 * over documents that already exist, and sync replays rows. Each of those can
 * reach this function twice for one order, and a second number would mean the
 * same deal answering to two names — which is precisely the thing a register
 * exists to prevent.
 *
 * The existing-row check and the insert are one statement apiece inside the
 * caller's transaction, and the unique index on (document_kind, document_id) is
 * what makes the pair safe rather than the SELECT: two connections racing here
 * both see nothing and both insert, and the index makes the loser lose.
 *
 * Returns null only when the register could not be written at all, which is
 * reported by the caller getting nothing rather than by an exception — see the
 * note at the top of this file about never failing a purchase.
 */
export function issueDealTicket(
  db: Database.Database,
  input: IssueDealTicketInput
): DealTicket | null {
  const documentId = clean(input.documentId)
  if (!documentId) return null
  try {
    const existing = readTicketFor(db, input.documentKind, documentId)
    if (existing) return existing

    const stamp = new Date().toISOString()
    const issuedAt = clean(input.issuedAt) ?? stamp
    const seq = nextDealTicketSeq(db)
    const ticket: DealTicket = {
      id: randomUUID(),
      number: formatDealTicket(seq),
      seq,
      kind: input.kind,
      documentKind: input.documentKind,
      documentId,
      documentNumber: clean(input.documentNumber),
      party: clean(input.party),
      amount: Math.round((Number(input.amount) || 0) * 100) / 100,
      pairedTicketId: null,
      issuedAt,
      issuedBy: clean(input.actorId)
    }
    db.prepare(
      `INSERT INTO deal_tickets
         (id, number, kind, document_kind, document_id, document_number,
          party, amount, paired_ticket_id, issued_at, issued_by, created_at, updated_at)
       VALUES
         (@id, @number, @kind, @documentKind, @documentId, @documentNumber,
          @party, @amount, NULL, @issuedAt, @issuedBy, @stamp, @stamp)`
      // Bound field by field rather than by spreading the ticket: `seq` is a
      // property of the SHAPE and not a column, and better-sqlite3 rejects a
      // named parameter the statement does not mention.
    ).run({
      id: ticket.id,
      number: ticket.number,
      kind: ticket.kind,
      documentKind: ticket.documentKind,
      documentId: ticket.documentId,
      documentNumber: ticket.documentNumber,
      party: ticket.party,
      amount: ticket.amount,
      issuedAt: ticket.issuedAt,
      issuedBy: ticket.issuedBy,
      stamp
    })
    return ticket
  } catch {
    // A document without a ticket is a gap in a register. A document that could
    // not be SAVED is lost work. This swallows so the second never happens
    // because of the first.
    return null
  }
}

function rowToTicket(r: Record<string, unknown>): DealTicket {
  const number = String(r.number)
  return {
    id: String(r.id),
    number,
    // Recovered from the label, which is the only stored truth. A ticket
    // relabelled by sync therefore reports the seq it now HAS, not the one it
    // was struck with.
    seq: parseDealTicketSeq(number) ?? 0,
    kind: String(r.kind) as DealTicketKind,
    documentKind: r.document_kind === 'po' ? 'po' : 'so',
    documentId: String(r.document_id),
    documentNumber: (r.document_number as string | null) ?? null,
    party: (r.party as string | null) ?? null,
    amount: Number(r.amount) || 0,
    pairedTicketId: (r.paired_ticket_id as string | null) ?? null,
    issuedAt: String(r.issued_at),
    issuedBy: (r.issued_by as string | null) ?? null
  }
}

/** The ticket a document already holds, or null. */
export function readTicketFor(
  db: Database.Database,
  documentKind: 'po' | 'so',
  documentId: string
): DealTicket | null {
  const r = db
    .prepare(`SELECT * FROM deal_tickets WHERE document_kind = ? AND document_id = ?`)
    .get(documentKind, documentId) as Record<string, unknown> | undefined
  return r ? rowToTicket(r) : null
}

/**
 * Declare two documents to be the two halves of one dropship.
 *
 * The tickets are RE-LABELLED, never re-issued. Both numbers were struck when
 * the documents were created and may already be written on paperwork; changing
 * them because a link was made afterwards would break the one promise the
 * register makes. So the kind moves to its dropship counterpart and the two
 * rows point at each other, and the numbers stand.
 *
 * Safe to call repeatedly — linking is a fact, not an event, and re-running it
 * lands on the same two rows in the same state. A half that has no ticket (a
 * document created before v74) is skipped rather than invented, because a
 * number issued today would sit out of sequence among tickets from months ago.
 */
export function markDropshipPair(
  db: Database.Database,
  poId: string,
  invoiceId: string
): void {
  try {
    const buy = readTicketFor(db, 'po', poId)
    const sell = readTicketFor(db, 'so', invoiceId)
    if (!buy || !sell) return
    const stamp = new Date().toISOString()
    const update = db.prepare(
      `UPDATE deal_tickets SET kind = ?, paired_ticket_id = ?, updated_at = ? WHERE id = ?`
    )
    update.run(dropshipKindFor(buy.kind), sell.id, stamp, buy.id)
    update.run(dropshipKindFor(sell.kind), buy.id, stamp, sell.id)
  } catch {
    // Same reasoning as issueDealTicket: the LINK is the operator's real intent
    // and it lives on the documents. A register that failed to relabel is a
    // cosmetic loss; a dropship that refused to link is not.
  }
}

/**
 * The register, newest first.
 *
 * Both live joins are LEFT, so a ticket whose document was deleted still comes
 * back — with `documentMissing` set rather than silently absent. A register that
 * hid its own voided numbers would present a sequence full of unexplainable
 * gaps.
 *
 * The year filter is on `issued_at`, the moment the deal was struck, rather than
 * on any date the document carries. A purchase order back-dated to December and
 * raised in January is a January deal; the ticket records when the number was
 * taken, and that is the only reading under which the sequence and the calendar
 * agree.
 */
export function listDealTickets(year?: number | null): DealTicketRow[] {
  const db = getDb()
  const where: string[] = []
  const params: Record<string, string> = {}
  if (year !== null && year !== undefined && Number.isFinite(Number(year))) {
    where.push(`t.issued_at >= @from AND t.issued_at < @to`)
    params.from = `${Math.trunc(Number(year))}-01-01`
    params.to = `${Math.trunc(Number(year)) + 1}-01-01`
  }
  const rows = db
    .prepare(
      `SELECT t.*,
              po.po_number      AS po_live_number,
              po.status         AS po_live_status,
              po.total          AS po_live_total,
              inv.invoice_number AS so_live_number,
              inv.status         AS so_live_status,
              inv.total          AS so_live_total,
              (po.id IS NULL AND inv.id IS NULL) AS gone
         FROM deal_tickets t
         LEFT JOIN purchase_orders po
                ON t.document_kind = 'po' AND po.id = t.document_id
         LEFT JOIN invoices inv
                ON t.document_kind = 'so' AND inv.id = t.document_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        -- Newest first. The zero-padding is what makes the string order the
        -- numeric order, which is the whole reason it is padded.
        ORDER BY t.number DESC`
    )
    .all(params) as Array<Record<string, unknown>>

  return rows.map((r) => {
    const isPo = r.document_kind === 'po'
    const liveNumber = (isPo ? r.po_live_number : r.so_live_number) as string | null
    const liveStatus = (isPo ? r.po_live_status : r.so_live_status) as string | null
    const liveTotal = isPo ? r.po_live_total : r.so_live_total
    return {
      ...rowToTicket(r),
      liveNumber: liveNumber ?? null,
      liveStatus: liveStatus ?? null,
      liveAmount: liveTotal === null || liveTotal === undefined ? null : Number(liveTotal) || 0,
      // Derived from the JOIN rather than from a null number, because an invoice
      // that has not been given a number yet is present with a NULL in that
      // column — reading it as a missing document would call every unposted
      // sales order deleted.
      documentMissing: Number(r.gone) === 1
    }
  })
}

/**
 * The years the register covers, newest first.
 *
 * Always includes the CURRENT year even when nothing has been issued in it, so
 * the sub-tab opens on a real year with an empty state that can explain itself,
 * rather than on nothing at all.
 */
export function dealTicketYears(): number[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT DISTINCT CAST(SUBSTR(issued_at, 1, 4) AS INTEGER) AS y
         FROM deal_tickets WHERE issued_at IS NOT NULL ORDER BY y DESC`
    )
    .all() as Array<{ y: number | null }>
  const years = new Set<number>()
  for (const r of rows) if (r.y) years.add(r.y)
  years.add(new Date().getFullYear())
  return [...years].sort((a, b) => b - a)
}

/** What the register would call the next movement. Shown in the empty state. */
export function peekNextDealTicket(): string {
  // The same ceiling the issuer uses, WITHOUT the write-back — this is the one
  // place that reads the counter and does not spend it.
  return formatDealTicket(ceilingSeq(getDb()) + 1)
}
