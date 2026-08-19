/**
 * Deal tickets — one number per commercial movement, issued automatically.
 *
 * ## What a deal ticket is
 *
 * Every time goods are committed to come IN or to go OUT, the movement gets a
 * number: purchase orders, sales orders, and both halves of a dropship. It is a
 * register, not a workflow. Nobody opens a screen to raise one, nobody approves
 * one, nothing is blocked waiting for one — the number is struck at the moment
 * the document is created and then it simply exists, for ever, so any movement
 * can be named in one token across a phone call, an email or a spreadsheet.
 *
 * That is the whole reason it is separate from `po_number` and
 * `invoice_number`. Those two are per-side sequences that each start at 1, so
 * "0042" is ambiguous until you also say which side of the business you mean.
 * A deal ticket is ONE sequence across both sides, so DT-000412 is a complete
 * answer on its own.
 *
 * ## Numbering starts at 337, and history is NOT backfilled
 *
 * The business has been issuing these by hand and has reached 336. The app
 * takes over at 337, which means the counter's floor is 336 and existing orders
 * get NOTHING. Minting numbers onto documents raised before the app knew about
 * deal tickets would produce a second, conflicting register over the same
 * period — the app claiming DT-000337 for a purchase order that the operator's
 * own book already calls something else. An empty first day is the honest
 * reading, and it fills itself within a day of trading.
 *
 * ## Six digits, and it is a LABEL not a quantity
 *
 * `DT-000337`. Zero-padded to six so the strings sort the way the numbers do,
 * which is what lets a spreadsheet, a filename and a SQL `ORDER BY` all agree
 * without anybody parsing anything. Past 999999 the padding simply stops
 * applying rather than truncating: a wrong number is worse than a wide one, and
 * at RM's rate that is roughly two thousand years away.
 */

/** The prefix every ticket carries. */
export const DEAL_TICKET_PREFIX = 'DT-'

/** How many digits the number is padded to. */
export const DEAL_TICKET_DIGITS = 6

/**
 * The first number this app will ever issue.
 *
 * The counter floor is one BELOW this (see `DEAL_TICKET_FLOOR`), because the
 * generator's contract is "hand back the next one", and the next one after 336
 * is 337.
 */
export const DEAL_TICKET_FIRST = 337

/** The highest number considered already spent. Never issued by this app. */
export const DEAL_TICKET_FLOOR = DEAL_TICKET_FIRST - 1

/**
 * What kind of movement a ticket names.
 *
 * The two dropship kinds are DELIBERATELY separate values rather than a flag on
 * the plain kinds. A dropship is one deal with two documents — stock bought
 * from a supplier that never touches a shelf and is billed straight on — and
 * the operator asking "what did we dropship in July" is asking a different
 * question from "what did we buy". Keeping it in the kind means that question
 * is a filter rather than a join.
 */
export type DealTicketKind =
  | 'purchase_order'
  | 'sales_order'
  | 'dropship_purchase'
  | 'dropship_sale'

export const DEAL_TICKET_KINDS: readonly DealTicketKind[] = [
  'purchase_order',
  'sales_order',
  'dropship_purchase',
  'dropship_sale'
]

/** Which way the goods move. Derived from the kind — never stored twice. */
export type DealTicketSide = 'in' | 'out'

/**
 * A purchase brings goods in; a sale sends them out. A dropship does BOTH, but
 * each of its two tickets is one leg, so each leg still has one honest
 * direction. That is exactly why the pair is two tickets and not one.
 */
export function dealTicketSide(kind: DealTicketKind): DealTicketSide {
  return kind === 'purchase_order' || kind === 'dropship_purchase' ? 'in' : 'out'
}

/** True for the two halves of a dropship. */
export function isDropshipKind(kind: DealTicketKind): boolean {
  return kind === 'dropship_purchase' || kind === 'dropship_sale'
}

/**
 * The dropship counterpart of an ordinary kind.
 *
 * Called when a purchase order and a sales order are linked as one deal, so the
 * two tickets already issued are RE-LABELLED rather than replaced. Re-issuing
 * would burn two numbers and, worse, change the number on a document somebody
 * may already have written down.
 */
export function dropshipKindFor(kind: DealTicketKind): DealTicketKind {
  if (kind === 'purchase_order') return 'dropship_purchase'
  if (kind === 'sales_order') return 'dropship_sale'
  return kind
}

/** What the sub-tab prints in the Kind column. */
export function describeDealTicketKind(kind: DealTicketKind): string {
  switch (kind) {
    case 'purchase_order':
      return 'Purchase order'
    case 'sales_order':
      return 'Sales order'
    case 'dropship_purchase':
      return 'Dropship — bought'
    case 'dropship_sale':
      return 'Dropship — sold'
    default:
      return kind
  }
}

/** One row of the register. */
export interface DealTicket {
  id: string
  /** "DT-000337". Unique across the whole business, both sides. */
  number: string
  /** The integer inside the number, so callers sort and compare without parsing. */
  seq: number
  kind: DealTicketKind
  /** 'po' or 'so' — which table `documentId` points into. */
  documentKind: 'po' | 'so'
  documentId: string
  /**
   * "PO-0042" / "1174", snapshotted at issue.
   *
   * A COPY on purpose. Sync rewrites `po_number` when two offline machines mint
   * the same one (RELABEL_ON_CONFLICT), and an invoice number can be edited
   * before posting. The ticket records what the document was called when the
   * deal was struck, which is what somebody reading the register a year later
   * is actually asking. The live number is joined in for display.
   */
  documentNumber: string | null
  /** Supplier on the way in, customer on the way out. Snapshotted for the same reason. */
  party: string | null
  /** The document total at issue, in dollars. */
  amount: number
  /** The ticket this one is paired with — the other half of a dropship. */
  pairedTicketId: string | null
  /**
   * The ticket that now speaks for this one, or null when it speaks for itself.
   *
   * A deal is often several movements — cases bought from one supplier and sold
   * on to three shops is four documents and one piece of business. Combining
   * them points the absorbed tickets HERE rather than renumbering or deleting
   * anything: the row keeps its number, its document and its issue date, so the
   * register still accounts for every number it ever handed out, and the
   * grouping can be undone.
   *
   * EXACTLY ONE LEVEL. A ticket that is itself absorbed can never be a target;
   * the write path resolves to the root first. A tree would turn "what does this
   * document answer to" into a walk of unknown length that every screen would
   * have to get right.
   */
  mergedInto: string | null
  /** When the deal was struck, ISO. */
  issuedAt: string
  issuedBy: string | null
}

/**
 * A register row with what the document says TODAY joined on.
 *
 * The snapshot fields answer "what was this when it was struck"; these answer
 * "where did it end up". Both are wanted at once — a ticket whose order was
 * cancelled is still a ticket, and the register must say so rather than quietly
 * showing the figures from the day it was raised as though they still stood.
 */
export interface DealTicketRow extends DealTicket {
  /** The document's CURRENT number, or null once the document is gone. */
  liveNumber: string | null
  /** The document's current stage, or null once it is gone. */
  liveStatus: string | null
  /** The document's current total. Null once it is gone. */
  liveAmount: number | null
  /**
   * True when nothing sits at `documentId` any more.
   *
   * The ticket is KEPT. A number that was issued was issued — reusing it would
   * make two deals share a name, and deleting the row would make the sequence
   * gap unexplainable. A voided ticket is a normal thing for a register to hold.
   */
  documentMissing: boolean
}

/** Format an integer as a ticket number. */
export function formatDealTicket(seq: number): string {
  const n = Math.trunc(Number(seq))
  if (!Number.isFinite(n) || n < 0) return DEAL_TICKET_PREFIX + '0'.repeat(DEAL_TICKET_DIGITS)
  return DEAL_TICKET_PREFIX + String(n).padStart(DEAL_TICKET_DIGITS, '0')
}

const TICKET_RE = /^DT-(\d+)$/i

/**
 * The integer inside a ticket number, or null if it is not one.
 *
 * Tolerant of case and surrounding space because this also backs the search box,
 * where somebody pastes "dt-000337 " out of an email. Not tolerant of a missing
 * prefix: a bare "337" is far more likely to be a purchase order number or a
 * quantity than a deal ticket, and guessing wrong sends the reader to the wrong
 * document.
 */
export function parseDealTicketSeq(value: string): number | null {
  const m = TICKET_RE.exec((value ?? '').trim())
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

/**
 * Does this row match what was typed?
 *
 * Matched against the ticket number, both document numbers (the snapshot and
 * the live one, which can differ after a sync relabel) and the party. Case and
 * space insensitive; an empty query matches everything.
 */
export function dealTicketMatches(row: DealTicketRow, query: string): boolean {
  const q = (query ?? '').trim().toLowerCase()
  if (!q) return true
  const fields = [row.number, row.documentNumber, row.liveNumber, row.party]
  for (const f of fields) {
    if ((f ?? '').toLowerCase().includes(q)) return true
  }
  return false
}

/** Newest ticket first. The register is read from the top. */
export function compareDealTicketsDesc(a: DealTicket, b: DealTicket): number {
  return b.seq - a.seq
}

/** Register totals, for the strip above the table. */
export interface DealTicketSummary {
  count: number
  /** Money committed to come in — the two purchase-side kinds. */
  inbound: number
  /** Money committed to go out — the two sales-side kinds. */
  outbound: number
  first: string | null
  last: string | null
}

export function summariseDealTickets(rows: readonly DealTicketRow[]): DealTicketSummary {
  let inbound = 0
  let outbound = 0
  let lo: number | null = null
  let hi: number | null = null
  for (const r of rows) {
    // The LIVE amount when the document still exists, so a cancelled order that
    // was zeroed stops being counted as committed money; the snapshot only
    // stands in once there is nothing left to ask.
    const amount = r.liveAmount ?? r.amount
    if (dealTicketSide(r.kind) === 'in') inbound += amount
    else outbound += amount
    if (lo === null || r.seq < lo) lo = r.seq
    if (hi === null || r.seq > hi) hi = r.seq
  }
  return {
    count: rows.length,
    inbound: Math.round(inbound * 100) / 100,
    outbound: Math.round(outbound * 100) / 100,
    first: lo === null ? null : formatDealTicket(lo),
    last: hi === null ? null : formatDealTicket(hi)
  }
}

// ---------------------------------------------------------------------------
// Combining several documents under one ticket
// ---------------------------------------------------------------------------

/**
 * Can these tickets be combined under `targetId`?
 *
 * Returns the reason they cannot, or null. Every branch names something the
 * operator can see on the screen they are looking at, because a refusal on a
 * bulk action is worthless if it does not say which row caused it.
 */
export function validateMerge(
  target: DealTicket | undefined,
  chosen: readonly DealTicket[]
): string | null {
  if (!target) return 'Pick the ticket the others should join.'
  if (target.mergedInto) {
    return `${target.number} is already part of another deal ticket, so it cannot be the one others join.`
  }
  const others = chosen.filter((t) => t.id !== target.id)
  if (others.length === 0) return 'Choose at least two tickets to combine.'
  for (const t of others) {
    if (t.mergedInto && t.mergedInto !== target.id) {
      return `${t.number} is already part of another deal ticket. Separate it first.`
    }
  }
  return null
}

/** One deal ticket and every document answering to it. */
export interface DealTicketGroup {
  /** The ticket that speaks for the group. */
  root: DealTicketRow
  /**
   * Every row in the group, root first, then the absorbed ones by number.
   *
   * The root is included rather than kept separate so a group of one and a group
   * of four render through the same code — the single-document case is the
   * overwhelming majority, and a screen that treats it as a special shape grows
   * two layouts that drift.
   */
  rows: DealTicketRow[]
  /** Money on the way in across the whole group. */
  inbound: number
  /** Money on the way out across the whole group. */
  outbound: number
}

/**
 * Fold a flat register into groups.
 *
 * An absorbed row whose root is NOT in the list — filtered out by a year, or by
 * a search — becomes its own group rather than vanishing. Dropping it would make
 * a search for its number return nothing while the number plainly exists, which
 * is the worst answer a register can give.
 */
export function groupDealTickets(rows: readonly DealTicketRow[]): DealTicketGroup[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const groups = new Map<string, DealTicketGroup>()
  const rootIdOf = (r: DealTicketRow): string =>
    r.mergedInto && byId.has(r.mergedInto) ? r.mergedInto : r.id

  for (const r of rows) {
    const rootId = rootIdOf(r)
    const root = byId.get(rootId) ?? r
    let g = groups.get(rootId)
    if (!g) {
      g = { root, rows: [], inbound: 0, outbound: 0 }
      groups.set(rootId, g)
    }
    g.rows.push(r)
    const amount = r.liveAmount ?? r.amount
    if (dealTicketSide(r.kind) === 'in') g.inbound += amount
    else g.outbound += amount
  }

  for (const g of groups.values()) {
    g.rows.sort((a, b) => (a.id === g.root.id ? -1 : b.id === g.root.id ? 1 : b.seq - a.seq))
    g.inbound = Math.round(g.inbound * 100) / 100
    g.outbound = Math.round(g.outbound * 100) / 100
  }
  return [...groups.values()].sort((a, b) => b.root.seq - a.root.seq)
}

/** True when this group holds more than the one document it started as. */
export function isCombined(group: DealTicketGroup): boolean {
  return group.rows.length > 1
}
