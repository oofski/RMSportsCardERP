/**
 * Mass inventory re-adjustment — the pure half.
 *
 * A periodic count (weekly / monthly / quarterly) arrives as a spreadsheet: one
 * row per product per location, carrying the counted quantity and the money that
 * goes with it. Rather than opening 120 products one at a time, the operator
 * pastes the sheet in and the app works out what would change, shows it, and
 * then applies the whole thing in one transaction.
 *
 * THE SHEET IS THE WHOLE WAREHOUSE. There is one mode and no toggles: after an
 * adjust, on-hand equals the sheet exactly, and every catalog product the sheet
 * does not mention holds nothing. That is the owner's decision and the reason
 * this screen exists — a partial update that leaves 266 uncounted products
 * carrying their old numbers reads, correctly, as "it added instead of
 * replacing", and no amount of arithmetic downstream can make the totals agree
 * with the paper.
 *
 * Because a bad paste can now write off the entire warehouse, a row this file
 * cannot resolve is a BLOCKING problem rather than a skipped line. Zeroing what
 * the sheet did not name is only defensible when everything the sheet DID name
 * was understood; otherwise a naming problem silently becomes a write-off.
 *
 * The other blocker is quieter and does more damage: stock the run would leave
 * carried at NO cost. A blank quantity has always been fatal — a row naming a
 * product with no count is an unfinished sheet — and a cost that would leave a
 * CASE on the shelf at zero is the same class of problem, except that it fails
 * silently and manufactures profit out of the whole market value while it does.
 *
 * BOXES ARE THE EXCEPTION, and only boxes: there it warns and applies. Two
 * reasons, and both have to hold. A box is the thing that gets picked up with no
 * price to hand, which is why the cost field on the add-stock form is optional
 * at all; and the dashboard now leaves an uncosted box OUT of the Spread rather
 * than reporting its market value as profit (PRODUCT_TOTALS in db/inventory.ts),
 * so the damage this check exists to prevent does not happen to one. A case is a
 * deliberate four-figure purchase whose price is known at the moment it is
 * bought — nothing that size may slip through on "the sheet did not say".
 *
 * A cost cell holding an explicit 0 is a THIRD thing, and it is not a blank. It
 * is the operator stating that cost is not tracked for that product, so it is
 * written as stated and CLEARS any basis the shelf was carrying — which is the
 * only way to say "stop tracking this one". A blank still means "not stated" and
 * still keeps whatever the product already had. The two must never be collapsed
 * into each other. See the uncosted-stock check near the end of
 * `buildResetPlan`.
 *
 * EVERYTHING that decides *what would change* lives here, with no database and
 * no Electron: parsing, column mapping, product matching and the before→after
 * plan. db/inventoryReset.ts supplies the catalog snapshot and performs the
 * writes; the renderer renders the plan this file builds. That split is the
 * point — a mass write to stock and cost is exactly the kind of thing that has
 * to be testable without a running app, and the preview the operator approves is
 * then computed by the same code that the apply re-runs.
 */

import type { Location } from './inventory'
import { LOCATION_IDS, isLocation } from './inventory'
import { normalizeUpc } from './upc'

// ---------------------------------------------------------------------------
// Column roles
// ---------------------------------------------------------------------------

/**
 * What one spreadsheet column means. `ignore` is a first-class answer: a real
 * sheet carries totals, notes and blank spacer columns that must not be read as
 * data, and the mapping UI defaults anything it cannot identify to `ignore`
 * rather than guessing.
 *
 * `marketTotal` / `costTotal` are never WRITTEN. They are extended columns
 * (each × qty) and are used only to cross-check the row: a total that disagrees
 * with its own quantity and unit price means the sheet is stale somewhere, and
 * saying so before the write is the whole value of having them.
 */
export type ResetField =
  | 'ignore'
  | 'name'
  | 'sku'
  | 'upc'
  | 'category'
  | 'location'
  | 'quantity'
  | 'marketEach'
  | 'marketTotal'
  | 'costEach'
  | 'costTotal'

export interface ResetFieldDef {
  id: ResetField
  label: string
  /** May at most one column carry this role? (Two "quantity" columns is a bug.) */
  unique: boolean
}

export const RESET_FIELDS: ResetFieldDef[] = [
  { id: 'ignore', label: 'Ignore', unique: false },
  { id: 'name', label: 'Product name', unique: true },
  { id: 'sku', label: 'SKU', unique: true },
  { id: 'upc', label: 'UPC / barcode', unique: true },
  { id: 'category', label: 'Category', unique: true },
  { id: 'location', label: 'Location (RM / AM)', unique: true },
  { id: 'quantity', label: 'Quantity on hand', unique: true },
  { id: 'marketEach', label: 'Market value (each)', unique: true },
  { id: 'marketTotal', label: 'Market value (total)', unique: true },
  { id: 'costEach', label: 'Cost (each)', unique: true },
  { id: 'costTotal', label: 'Cost (total)', unique: true }
]

export function resetFieldLabel(field: ResetField): string {
  return RESET_FIELDS.find((f) => f.id === field)?.label ?? field
}

// ---------------------------------------------------------------------------
// What an adjust does, and what it deliberately does not
// ---------------------------------------------------------------------------
//
// These used to be six checkboxes. They are now the definition of the operation,
// written down here because the two that are OFF are decisions, not omissions.
//
//   quantity, cost, market  ON — the three numbers the sheet states, written
//     exactly as stated, for every row; and zero for every shelf the sheet does
//     not name. This is the baseline.
//
//   catalog details        OFF — SKU, UPC and category are NEVER written back.
//     This is a stock-and-value operation; the catalog is curated by hand and
//     an existing product record must not be edited as a side effect of a
//     count. A sheet whose SKU column has drifted would otherwise rewrite 306
//     product records on the way past.
//
//   create products        OFF — a row matching nothing does not invent a
//     product. It BLOCKS the whole run instead (see the unresolved-rows check
//     in buildResetPlan). Creating would let a typo or a mis-mapped name column
//     quietly grow the catalog, and — worse — it would let the run *succeed*,
//     which is the silent failure. Refusing is the loud one: the row is named
//     in the preview, nothing is written, and the fix (correct the sheet, or
//     add the product deliberately in the catalog screen) is a small, explicit
//     act. The cost of being wrong in that direction is a re-paste; the cost of
//     being wrong in the other is a phantom product carrying real money.

// ---------------------------------------------------------------------------
// Text → grid
// ---------------------------------------------------------------------------

export type Delimiter = '\t' | ','

/**
 * Tab wins whenever a tab is present.
 *
 * Copying a block of cells out of Excel or Google Sheets gives TAB-separated
 * text in which `$8,600.00` is NOT quoted. Split that on commas and every money
 * column shatters into two, so the delimiter question has exactly one safe
 * answer: if the header-or-first line contains a tab, it is TSV.
 */
export function detectDelimiter(text: string): Delimiter {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    if (line.includes('\t')) return '\t'
    return ','
  }
  return '\t'
}

/** Split one delimited line, honouring RFC4180 double-quoting. */
function splitLine(line: string, delimiter: Delimiter): string[] {
  const out: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
    } else if (ch === '"' && cell === '') {
      quoted = true
    } else if (ch === delimiter) {
      out.push(cell)
      cell = ''
    } else cell += ch
  }
  out.push(cell)
  return out.map((c) => c.trim())
}

export interface ParsedSheet {
  /** Data rows, ragged (a real paste carries a summary block off to the side). */
  rows: string[][]
  /** The header row, when one was detected; otherwise null. */
  header: string[] | null
  /** Widest row seen — the column count the mapping is sized to. */
  columns: number
  delimiter: Delimiter
}

const HEADER_WORDS = [
  'product',
  'name',
  'item',
  'description',
  'sku',
  'upc',
  'barcode',
  'category',
  'location',
  'qty',
  'quantity',
  'count',
  'on hand',
  'cost',
  'market',
  'value',
  'price',
  'bid',
  'total'
]

/**
 * Does this look like a header rather than data?
 *
 * A header row is all text and its words are the vocabulary of a header. The
 * test insists on BOTH — "2026 Panini Prizm ... Soccer ... RM" is all text too,
 * but none of its cells is a column name, and mistaking the first product for a
 * header silently drops a real count row.
 */
function looksLikeHeader(cells: string[]): boolean {
  const filled = cells.filter((c) => c !== '')
  if (filled.length < 2) return false
  const numeric = filled.filter((c) => parseMoney(c) != null).length
  if (numeric > 0) return false
  const hits = filled.filter((c) => {
    const low = c.toLowerCase()
    return HEADER_WORDS.some((w) => low.includes(w))
  }).length
  return hits >= 2
}

export function parseSheet(text: string): ParsedSheet {
  const delimiter = detectDelimiter(text)
  const lines = text.split(/\r?\n/)
  const grid: string[][] = []
  for (const line of lines) {
    if (!line.trim()) continue
    const cells = splitLine(line, delimiter)
    if (cells.every((c) => c === '')) continue
    grid.push(cells)
  }
  let header: string[] | null = null
  if (grid.length > 0 && looksLikeHeader(grid[0])) header = grid.shift() ?? null
  const columns = Math.max(header?.length ?? 0, ...grid.map((r) => r.length), 0)
  return { rows: grid, header, columns, delimiter }
}

/** Cell at `index`, or '' — rows are ragged and indexing past the end is normal. */
export function cellAt(row: string[], index: number): string {
  return index >= 0 && index < row.length ? row[index] : ''
}

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

/**
 * Read a money cell. Accepts `$8,600.00`, `8600`, `(900.00)` (accounting
 * negative), a leading minus, and a stray non-breaking space. Blank, a lone
 * dash and anything unreadable come back NULL — which everywhere downstream
 * means "the sheet did not state this", never "zero". Writing a zero the
 * operator never typed is how a mass update destroys a cost basis.
 */
export function parseMoney(raw: string | null | undefined): number | null {
  if (raw == null) return null
  let s = String(raw).replace(/ /g, ' ').trim()
  if (s === '' || s === '-' || s === '–' || s === '—' || s === 'N/A' || s === 'n/a') return null
  let negative = false
  if (/^\(.*\)$/.test(s)) {
    negative = true
    s = s.slice(1, -1).trim()
  }
  s = s.replace(/[$,\s]/g, '')
  if (s.startsWith('-')) {
    negative = true
    s = s.slice(1)
  }
  if (s === '' || !/^\d*\.?\d+$/.test(s)) return null
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return negative ? -n : n
}

/** Read a quantity cell. Same rules as money, minus the currency. */
export function parseQty(raw: string | null | undefined): number | null {
  return parseMoney(raw)
}

/** Fold a name for matching: case, punctuation and spacing all stop mattering. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function normalizeSku(sku: string): string {
  return sku.trim().toLowerCase()
}

const CENTS = 100

/** Round to cents the way the rest of the app does, without float dust. */
export function money(n: number): number {
  return Math.round(n * CENTS) / CENTS
}

/**
 * Round a PER-UNIT figure — matching UNIT_DP in db/lots.ts, which is the
 * precision a cost layer and a product average are stored at.
 *
 * A total is money and belongs in cents; a unit cost is a rate that gets
 * multiplied by a quantity again. A sheet that states "$110.00 for 7" is stating
 * $15.7143 each, and cent-rounding that on the way in would write $15.71 to the
 * layers and make the shelf worth $109.97 the moment it was applied — the exact
 * arithmetic this whole screen exists to reproduce faithfully.
 */
export function unitMoney(n: number): number {
  return Math.round(n * 10_000) / 10_000
}

// ---------------------------------------------------------------------------
// Mapping guess
// ---------------------------------------------------------------------------

interface ColumnStats {
  index: number
  filled: number
  numeric: number
  money: number
  /** Values that are 11–14 straight digits — a UPC/EAN, not a price. */
  barcode: number
  location: number
  category: number
  /** Mean character length of the non-empty cells. */
  length: number
  /** Every non-empty value looks like a whole number. */
  wholeNumbers: boolean
}

function statsFor(rows: string[][], index: number, categories: Set<string>): ColumnStats {
  let filled = 0
  let numeric = 0
  let moneyish = 0
  let barcode = 0
  let location = 0
  let category = 0
  let chars = 0
  let whole = true
  for (const row of rows) {
    const cell = cellAt(row, index)
    if (cell === '') continue
    filled++
    chars += cell.length
    const n = parseMoney(cell)
    if (n != null) {
      numeric++
      if (/[$,]/.test(cell) || /\.\d{2}$/.test(cell) || /^\(.*\)$/.test(cell)) moneyish++
      if (!Number.isInteger(n)) whole = false
    } else whole = false
    if (/^\d{11,14}$/.test(cell.replace(/[\s-]/g, ''))) barcode++
    if (isLocation(cell.trim().toUpperCase())) location++
    if (categories.has(cell.trim().toLowerCase())) category++
  }
  return {
    index,
    filled,
    numeric,
    money: moneyish,
    barcode,
    location,
    category,
    length: filled ? chars / filled : 0,
    wholeNumbers: whole && filled > 0
  }
}

/** Is `total` the extension of `each` across `qty`, within a cent of rounding? */
function extendsTo(each: number, qty: number, total: number): boolean {
  const expected = each * qty
  const tolerance = Math.max(0.02, Math.abs(expected) * 0.005)
  return Math.abs(expected - total) <= tolerance
}

/**
 * Guess what each column is.
 *
 * The identity columns fall out of their content (a barcode is 12 digits, a
 * location is RM or AM, a category is one of the ones already in the catalog).
 * The MONEY columns are the interesting ones, because a sheet like RM's carries
 * five of them — market each, market total, cost each, cost total and the spread
 * — and nothing about a lone number says which is which.
 *
 * So they are identified by ARITHMETIC rather than by position: a column that
 * multiplies up to another column across the quantity is a unit price, and the
 * column it multiplies to is that price extended. Whichever extended column the
 * remaining spread column is measured FROM is the market side (spread = market −
 * cost). If there is no spread column to break the tie, the left pair is taken
 * as market, which is the order every sheet of this shape has used.
 *
 * A guess is a starting point, never a commitment: every column is overridable
 * in the UI and the preview shows the resulting before→after per row, so a
 * mis-guess is visible before anything is written.
 */
export function guessMapping(sheet: ParsedSheet, knownCategories: string[] = []): ResetField[] {
  const { rows, columns, header } = sheet
  const mapping: ResetField[] = new Array(columns).fill('ignore')
  if (columns === 0) return mapping
  const categories = new Set(knownCategories.map((c) => c.trim().toLowerCase()))

  // A header, when present, beats every heuristic — it is the operator telling
  // us directly.
  if (header) {
    for (let i = 0; i < columns; i++) {
      const guess = fieldFromHeader(cellAt(header, i))
      if (guess) mapping[i] = guess
    }
  }

  const taken = (field: ResetField): boolean => mapping.includes(field)
  const stats: ColumnStats[] = []
  for (let i = 0; i < columns; i++) stats.push(statsFor(rows, i, categories))
  // A column filled on only a handful of rows is the summary block off to the
  // side of a pasted selection, not data.
  const substantial = stats.filter((s) => s.filled >= Math.max(2, rows.length * 0.4))

  const claim = (field: ResetField, index: number | undefined): void => {
    if (index == null || taken(field) || mapping[index] !== 'ignore') return
    mapping[index] = field
  }

  const best = (pick: (s: ColumnStats) => number): ColumnStats | undefined => {
    let top: ColumnStats | undefined
    let score = 0
    for (const s of substantial) {
      if (mapping[s.index] !== 'ignore') continue
      const v = pick(s)
      if (v > score) {
        score = v
        top = s
      }
    }
    return top
  }

  claim('location', best((s) => (s.location / Math.max(1, s.filled) >= 0.6 ? s.location : 0))?.index)
  claim('upc', best((s) => (s.barcode / Math.max(1, s.filled) >= 0.6 ? s.barcode : 0))?.index)
  claim('category', best((s) => (s.category / Math.max(1, s.filled) >= 0.5 ? s.category : 0))?.index)

  // Money columns: numeric AND written like money ($, thousands separators, two
  // decimal places, accounting parentheses). A bare integer column is not money,
  // which is what keeps the quantity out of this set.
  const numericCols = substantial.filter(
    (s) => mapping[s.index] === 'ignore' && s.numeric >= s.filled * 0.8 && s.barcode < s.filled * 0.5
  )
  const moneyCols = numericCols.filter((s) => s.money >= s.filled * 0.5)
  const notMoney = numericCols.filter((s) => !moneyCols.includes(s))

  // Quantity and the money pairs are found TOGETHER, because each proves the
  // other: the quantity is whichever column makes `unit price × qty = extended
  // total` come out true, and a money pair is one that a quantity connects. A
  // quantity guessed on its own — "the small integer column" — loses to a SKU
  // like 6392 the moment the sheet has one, and a pair guessed on its own has
  // nothing to test against.
  const pairsFor = (
    qtyIndex: number
  ): { hits: number; kept: Array<{ each: number; total: number }>; used: Set<number> } => {
    const found: Array<{ each: number; total: number; hits: number }> = []
    for (const a of moneyCols) {
      for (const b of moneyCols) {
        if (a.index === b.index) continue
        let hits = 0
        let tested = 0
        for (const row of rows) {
          const qty = parseQty(cellAt(row, qtyIndex))
          const each = parseMoney(cellAt(row, a.index))
          const total = parseMoney(cellAt(row, b.index))
          // Quantity 1 is skipped: at qty 1 every column trivially "extends" to
          // every other, which proves nothing about either.
          if (qty == null || qty <= 1 || each == null || total == null) continue
          tested++
          if (extendsTo(each, qty, total)) hits++
        }
        if (tested >= 2 && hits >= tested * 0.8) found.push({ each: a.index, total: b.index, hits })
      }
    }
    found.sort((x, y) => y.hits - x.hits || x.each - y.each)
    const used = new Set<number>()
    const kept: Array<{ each: number; total: number }> = []
    let hits = 0
    for (const p of found) {
      if (used.has(p.each) || used.has(p.total)) continue
      used.add(p.each)
      used.add(p.total)
      kept.push({ each: p.each, total: p.total })
      hits += p.hits
    }
    kept.sort((x, y) => x.each - y.each)
    return { hits, kept, used }
  }

  let qtyIndex = taken('quantity') ? mapping.indexOf('quantity') : -1
  let pairs = qtyIndex >= 0 ? pairsFor(qtyIndex) : { hits: 0, kept: [], used: new Set<number>() }
  if (qtyIndex < 0) {
    let bestHits = 0
    for (const candidate of notMoney) {
      const result = pairsFor(candidate.index)
      if (result.hits > bestHits) {
        bestHits = result.hits
        qtyIndex = candidate.index
        pairs = result
      }
    }
    // No money to triangulate against — fall back to the whole-number column
    // holding the smallest values, a count rather than an identifier.
    if (qtyIndex < 0) {
      let smallest = Number.POSITIVE_INFINITY
      for (const candidate of notMoney) {
        if (!candidate.wholeNumbers) continue
        let sum = 0
        let n = 0
        for (const row of rows) {
          const v = parseQty(cellAt(row, candidate.index))
          if (v == null) continue
          sum += Math.abs(v)
          n++
        }
        const mean = n ? sum / n : Number.POSITIVE_INFINITY
        if (mean < smallest && mean < 10000) {
          smallest = mean
          qtyIndex = candidate.index
        }
      }
    }
    claim('quantity', qtyIndex >= 0 ? qtyIndex : undefined)
  }

  const { kept, used } = pairs
  if (kept.length >= 2) {
    let [marketPair, costPair] = kept
    // A spread column (market total − cost total) settles which pair is which.
    // Without one, the left pair is taken as market — the order every sheet of
    // this shape has used — and the preview makes a wrong call obvious.
    const spread = moneyCols.find((s) => !used.has(s.index))
    if (spread) {
      let forward = 0
      let backward = 0
      for (const row of rows) {
        const a = parseMoney(cellAt(row, kept[0].total))
        const b = parseMoney(cellAt(row, kept[1].total))
        const d = parseMoney(cellAt(row, spread.index))
        if (a == null || b == null || d == null) continue
        if (Math.abs(a - b - d) <= 0.02) forward++
        if (Math.abs(b - a - d) <= 0.02) backward++
      }
      if (backward > forward) [marketPair, costPair] = [kept[1], kept[0]]
    }
    claim('marketEach', marketPair.each)
    claim('marketTotal', marketPair.total)
    claim('costEach', costPair.each)
    claim('costTotal', costPair.total)
  } else if (kept.length === 1) {
    claim('marketEach', kept[0].each)
    claim('marketTotal', kept[0].total)
  } else if (moneyCols.length === 2) {
    // Two money columns and no extension between them: unit market and unit
    // cost side by side, which is what a hand-typed sheet usually looks like.
    claim('marketEach', moneyCols[0].index)
    claim('costEach', moneyCols[1].index)
  } else if (moneyCols.length === 1) {
    claim('marketEach', moneyCols[0].index)
  }

  // Whatever is left: the name is the widest mostly-text column, the SKU the
  // narrowest remaining one that is not money.
  claim('name', best((s) => (s.numeric < s.filled * 0.5 ? s.length : 0))?.index)
  claim(
    'sku',
    best((s) => (moneyCols.some((m) => m.index === s.index) ? 0 : Math.max(1, 40 - s.length)))?.index
  )

  return mapping
}

const HEADER_ALIASES: Array<{ field: ResetField; test: RegExp }> = [
  { field: 'name', test: /^(product|item|name|description|product name|item name)$/i },
  { field: 'sku', test: /^(sku|code|item ?#|item no|part ?#)$/i },
  { field: 'upc', test: /^(upc|barcode|bar code|ean|gtin|upc ?\/ ?barcode)$/i },
  { field: 'category', test: /^(category|cat|sport|type)$/i },
  { field: 'location', test: /^(location|loc|warehouse|site|room)$/i },
  { field: 'quantity', test: /^(qty|quantity|count|on hand|on-hand|units|stock)$/i },
  { field: 'marketEach', test: /^(market|market value|market each|high bid|bid|market ?\/ ?ea)$/i },
  { field: 'marketTotal', test: /^(market total|total market|market value total|ext market)$/i },
  { field: 'costEach', test: /^(cost|unit cost|cost each|avg cost|average cost|cost ?\/ ?ea)$/i },
  { field: 'costTotal', test: /^(cost total|total cost|extended cost|ext cost)$/i }
]

function fieldFromHeader(raw: string): ResetField | null {
  const label = raw.trim()
  if (!label) return null
  for (const alias of HEADER_ALIASES) if (alias.test.test(label)) return alias.field
  return null
}

/**
 * A mapping is usable once it can identify a product and state all three of the
 * numbers a baseline carries.
 *
 * Quantity, cost and market are all REQUIRED now that there is no way to turn
 * any of them off. A sheet missing one of them cannot be the warehouse — it
 * would set the quantities and leave the money reading whatever it read before,
 * which is the half-replaced state this screen was rewritten to eliminate. An
 * individual CELL may still be blank; that is "the sheet did not state this for
 * this row", it is warned about per row, and it never writes a zero nobody
 * typed.
 */
export function mappingProblems(mapping: ResetField[]): string[] {
  const problems: string[] = []
  const has = (f: ResetField): boolean => mapping.includes(f)
  const count = (f: ResetField): number => mapping.filter((m) => m === f).length
  for (const def of RESET_FIELDS) {
    if (def.unique && count(def.id) > 1) {
      problems.push(`Two columns are set to “${def.label}”. Only one can be.`)
    }
  }
  if (!has('name') && !has('upc') && !has('sku')) {
    problems.push('Set one column to Product name, UPC or SKU so rows can be matched to products.')
  }
  if (!has('quantity')) {
    problems.push('Set a column to Quantity on hand — the count is what this sheet is for.')
  }
  if (!has('costEach') && !has('costTotal')) {
    problems.push('Set a column to Cost. A baseline states what the stock on hand is worth.')
  }
  if (!has('marketEach') && !has('marketTotal')) {
    problems.push('Set a column to Market value. A baseline states what the stock would sell for.')
  }
  return problems
}

// ---------------------------------------------------------------------------
// The catalog, as the planner sees it
// ---------------------------------------------------------------------------

export interface ResetCatalogProduct {
  id: string
  name: string
  sku: string
  upc: string | null
  category: string
  unitType: string
  giveawayItem: boolean
  /** The product-wide weighted average — what the catalog screen shows. */
  unitCost: number
  highBid: number | null
  /** On-hand by location, every location present. */
  quantityByLocation: Record<string, number>
  /**
   * Average cost of the stock at each location.
   *
   * Needed because a count REVALUES one shelf, not the whole product: after
   * re-basing RM's cost layers the product's average comes out as the blend of
   * RM's new cost and whatever AM is still carrying. Without these the preview
   * would promise the sheet's number and the write would land on the blend —
   * and a preview that is wrong about cost is worse than no preview.
   */
  costByLocation: Record<string, number>
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * There is no 'new'. A row matching nothing is 'unmatched', and 'unmatched' is
 * fatal to the whole run — see the header.
 */
export type ResetRowStatus = 'change' | 'same' | 'unmatched' | 'ambiguous' | 'invalid'

export interface ResetRowPlan {
  /** 1-based line number within the pasted data rows. */
  line: number
  status: ResetRowStatus
  /** Why a row is unmatched / ambiguous / invalid. Empty otherwise. */
  message: string
  /** Non-fatal notes: the row still applies. */
  warnings: string[]

  sheetName: string
  sheetSku: string
  sheetUpc: string
  sheetCategory: string
  location: Location

  productId: string | null
  productName: string
  /** For an unmatched row: the closest catalog name, purely as a hint. */
  suggestion: string | null

  quantityBefore: number | null
  quantityAfter: number | null
  /** The product-wide average, before and after — what the catalog displays. */
  costBefore: number | null
  costAfter: number | null
  /**
   * The counted unit cost for THIS shelf, or null when the sheet did not state
   * one (or cost updates are off). This is what the write re-bases the cost
   * layers to; `costAfter` is the product average that then falls out of it,
   * and the two differ whenever a product is held at more than one location.
   */
  shelfCostAfter: number | null
  marketBefore: number | null
  marketAfter: number | null
}

/** A (product, location) that holds stock the sheet never mentions — and will
 *  therefore be written down to zero. */
export interface ResetMissingRow {
  productId: string
  productName: string
  location: string
  quantity: number
  /**
   * THIS shelf's cost basis per unit, off its own cost layers — not the
   * product-wide average. A product held in two places at two prices loses a
   * different amount depending on which shelf goes.
   */
  unitCost: number
  /**
   * Valued the way every widget values it: the high bid when there is one, the
   * cost basis otherwise. So the money the preview says is about to be written
   * off is the money the dashboard is about to lose, not a second opinion.
   */
  unitMarket: number
}

export interface ResetTotals {
  unitsBefore: number
  unitsAfter: number
  /**
   * Cost basis across the whole catalog, summed SHELF BY SHELF — the same way
   * db/valuation.ts sums it for the dashboard. Never on-hand × an average: a
   * product counted 3 @ $10 and 4 @ $20 is worth $110.00, and no single per-unit
   * figure multiplied by 7 says so.
   */
  costBefore: number
  costAfter: number
  /** Market value: quantity × high bid where priced, the cost basis where not. */
  marketBefore: number
  marketAfter: number
}

export interface ResetPlan {
  mapping: ResetField[]
  rows: ResetRowPlan[]
  /** Shelves holding stock the sheet does not mention. All of them are zeroed. */
  missing: ResetMissingRow[]
  counts: {
    total: number
    change: number
    same: number
    unmatched: number
    ambiguous: number
    invalid: number
    warnings: number
  }
  /** Totals across the whole CATALOG, so the widgets read like the dashboard. */
  totals: ResetTotals
  /** Blocking problems with the mapping itself. */
  problems: string[]
}

interface MatchIndex {
  byUpc: Map<string, ResetCatalogProduct[]>
  byName: Map<string, ResetCatalogProduct[]>
  bySku: Map<string, ResetCatalogProduct[]>
}

function buildIndex(catalog: ResetCatalogProduct[]): MatchIndex {
  const byUpc = new Map<string, ResetCatalogProduct[]>()
  const byName = new Map<string, ResetCatalogProduct[]>()
  const bySku = new Map<string, ResetCatalogProduct[]>()
  const push = (map: Map<string, ResetCatalogProduct[]>, key: string, p: ResetCatalogProduct): void => {
    if (!key) return
    const list = map.get(key)
    if (list) list.push(p)
    else map.set(key, [p])
  }
  for (const p of catalog) {
    push(byUpc, normalizeUpc(p.upc) ?? '', p)
    push(byName, normalizeName(p.name), p)
    push(bySku, normalizeSku(p.sku), p)
  }
  return { byUpc, byName, bySku }
}

interface MatchResult {
  product: ResetCatalogProduct | null
  status: 'ok' | 'unmatched' | 'ambiguous'
  message: string
}

/**
 * Find the product a sheet row is talking about.
 *
 * UPC first because it is the catalog's natural key, then the full name, then
 * the SKU. SKU comes LAST and only when it is unique, because SKUs here are
 * deliberately shared — nineteen different products carry the SKU "BOX" — and
 * matching on one would point a count at whichever product happened to sort
 * first. A shared SKU therefore reports ambiguity instead of picking.
 */
export function matchRow(
  index: MatchIndex,
  sheetUpc: string,
  sheetName: string,
  sheetSku: string
): MatchResult {
  const upc = normalizeUpc(sheetUpc)
  if (upc) {
    const hits = index.byUpc.get(upc) ?? []
    if (hits.length === 1) return { product: hits[0], status: 'ok', message: '' }
    if (hits.length > 1) {
      return {
        product: null,
        status: 'ambiguous',
        message: `${hits.length} products share UPC ${sheetUpc}.`
      }
    }
  }
  const name = normalizeName(sheetName)
  if (name) {
    const hits = index.byName.get(name) ?? []
    if (hits.length === 1) return { product: hits[0], status: 'ok', message: '' }
    if (hits.length > 1) {
      return {
        product: null,
        status: 'ambiguous',
        message: `${hits.length} products are named “${sheetName}”.`
      }
    }
  }
  const sku = normalizeSku(sheetSku)
  if (sku) {
    const hits = index.bySku.get(sku) ?? []
    if (hits.length === 1) return { product: hits[0], status: 'ok', message: '' }
    if (hits.length > 1) {
      return {
        product: null,
        status: 'ambiguous',
        message: `${hits.length} products share SKU ${sheetSku} — add the UPC or the full name.`
      }
    }
  }
  return {
    product: null,
    status: 'unmatched',
    message: sheetName
      ? 'No product in the catalog matches this row.'
      : 'This row has no product name, UPC or SKU.'
  }
}

/**
 * The catalog product an unmatched row most likely meant, or null.
 *
 * Scored on shared words rather than edit distance, because the misses that
 * actually happen here are a word added or dropped — "Hobby Jumbo 8-Box Case"
 * against "Hobby 8-Box Case" — not a typo. Deliberately advisory: it is shown
 * beside the row so the operator can tell a renamed product from a genuinely new
 * one, and it never selects anything on its own.
 */
export function suggestProduct(
  catalog: ResetCatalogProduct[],
  sheetName: string
): { product: ResetCatalogProduct; score: number } | null {
  const wanted = normalizeName(sheetName).split(' ').filter(Boolean)
  if (wanted.length < 2) return null
  const wantedSet = new Set(wanted)
  let best: { product: ResetCatalogProduct; score: number } | null = null
  for (const product of catalog) {
    const have = normalizeName(product.name).split(' ').filter(Boolean)
    if (have.length === 0) continue
    let shared = 0
    for (const word of new Set(have)) if (wantedSet.has(word)) shared++
    // Jaccard over the two word sets, so a long name does not win by length.
    const union = new Set([...wantedSet, ...have]).size
    const score = union ? shared / union : 0
    if (!best || score > best.score) best = { product, score }
  }
  return best && best.score >= 0.5 ? best : null
}

/** Total on-hand across every location. */
function totalQty(p: ResetCatalogProduct): number {
  return Object.values(p.quantityByLocation).reduce((a, b) => a + b, 0)
}

/**
 * Build the whole before→after picture.
 *
 * Pure and total: it never throws, and every row lands in exactly one status.
 * The apply step re-runs this against a freshly-read catalog and writes what it
 * says, so what the operator approves and what happens cannot drift.
 */
export function buildResetPlan(
  sheet: ParsedSheet,
  mapping: ResetField[],
  catalog: ResetCatalogProduct[],
  defaultLocation: Location = LOCATION_IDS[0]
): ResetPlan {
  const problems = mappingProblems(mapping)
  const index = buildIndex(catalog)
  const col = (field: ResetField): number => mapping.indexOf(field)
  const ci = {
    name: col('name'),
    sku: col('sku'),
    upc: col('upc'),
    category: col('category'),
    location: col('location'),
    quantity: col('quantity'),
    marketEach: col('marketEach'),
    marketTotal: col('marketTotal'),
    costEach: col('costEach'),
    costTotal: col('costTotal')
  }

  const rows: ResetRowPlan[] = []
  /** Every (product, location) the sheet speaks for — drives the missing list. */
  const covered = new Set<string>()
  /** Detects two rows counting the same shelf. */
  const seen = new Map<string, number>()
  /** Running on-hand per (product, location) as the plan is applied in order. */
  const projectedQty = new Map<string, number>()
  /** Counted unit cost per (product, location) — a shelf revaluation. */
  const projectedShelfCost = new Map<string, number>()
  /**
   * Lines whose cost cell STATED a number, an explicit 0 included.
   *
   * Kept because a stated zero and a blank end in the same place — stock with no
   * basis — and only one of them is a surprise. The uncosted-box note below is
   * for the operator who did not say; it has nothing to tell the one who did.
   */
  const statedCost = new Set<number>()
  const projectedMarket = new Map<string, number | null>()

  const key = (productId: string, location: string): string => `${productId}::${location}`

  for (let i = 0; i < sheet.rows.length; i++) {
    const raw = sheet.rows[i]
    const sheetName = cellAt(raw, ci.name)
    const sheetSku = cellAt(raw, ci.sku)
    const sheetUpc = cellAt(raw, ci.upc)
    const sheetCategory = cellAt(raw, ci.category)
    const rawLocation = cellAt(raw, ci.location).trim().toUpperCase()
    const location: Location = isLocation(rawLocation) ? rawLocation : defaultLocation
    const warnings: string[] = []

    const plan: ResetRowPlan = {
      line: i + 1,
      status: 'same',
      message: '',
      warnings,
      sheetName,
      sheetSku,
      sheetUpc,
      sheetCategory,
      location,
      productId: null,
      productName: sheetName,
      suggestion: null,
      quantityBefore: null,
      quantityAfter: null,
      costBefore: null,
      costAfter: null,
      shelfCostAfter: null,
      marketBefore: null,
      marketAfter: null
    }

    // A row that names nothing is the summary block at the bottom of a paste,
    // not a count. Skip it silently rather than reporting it as a failure.
    if (!sheetName && !sheetSku && !sheetUpc) continue
    if (ci.location >= 0 && cellAt(raw, ci.location) !== '' && !isLocation(rawLocation)) {
      warnings.push(`“${cellAt(raw, ci.location)}” is not a location — counted at ${location}.`)
    }

    // A row with no readable quantity is REJECTED, not carried through with the
    // shelf left alone. Under a baseline every row states an on-hand number, so
    // a blank or unreadable one is a sheet that is not finished — and finishing
    // it is a great deal cheaper than reconciling a warehouse that was written
    // from a half-typed count.
    const qtyCell = ci.quantity >= 0 ? cellAt(raw, ci.quantity) : ''
    const quantity = ci.quantity >= 0 ? parseQty(qtyCell) : null
    if (quantity == null) {
      plan.status = 'invalid'
      plan.message =
        qtyCell === ''
          ? 'This row states no quantity. Every row of a baseline count has to say how many.'
          : `“${qtyCell}” is not a quantity.`
      rows.push(plan)
      continue
    }
    if (quantity < 0) {
      plan.status = 'invalid'
      plan.message = 'Quantity cannot be negative.'
      rows.push(plan)
      continue
    }

    let costEach = ci.costEach >= 0 ? parseMoney(cellAt(raw, ci.costEach)) : null
    let marketEach = ci.marketEach >= 0 ? parseMoney(cellAt(raw, ci.marketEach)) : null
    const costTotal = ci.costTotal >= 0 ? parseMoney(cellAt(raw, ci.costTotal)) : null
    const marketTotal = ci.marketTotal >= 0 ? parseMoney(cellAt(raw, ci.marketTotal)) : null

    // A total with no unit price still states the unit price, as long as there
    // is a quantity to divide by.
    if (costEach == null && costTotal != null && quantity > 0) {
      costEach = unitMoney(costTotal / quantity)
    }
    if (marketEach == null && marketTotal != null && quantity > 0) {
      marketEach = money(marketTotal / quantity)
    }
    // Where BOTH are stated, they have to agree. A stale extended column is the
    // single most common thing wrong with a hand-kept sheet, and it means one of
    // the two numbers on the row is not what the operator thinks it is.
    if (costEach != null && costTotal != null && quantity > 0) {
      if (!extendsTo(costEach, quantity, costTotal)) {
        warnings.push(
          `Cost total ${fmt(costTotal)} does not match ${fmt(costEach)} × ${quantity} — using the unit cost.`
        )
      }
    }
    if (marketEach != null && marketTotal != null && quantity > 0) {
      if (!extendsTo(marketEach, quantity, marketTotal)) {
        warnings.push(
          `Market total ${fmt(marketTotal)} does not match ${fmt(marketEach)} × ${quantity} — using the unit value.`
        )
      }
    }
    if (costEach != null && costEach < 0) {
      warnings.push('Negative cost ignored.')
      costEach = null
    }
    if (marketEach != null && marketEach < 0) {
      warnings.push('Negative market value ignored.')
      marketEach = null
    }

    const match = matchRow(index, sheetUpc, sheetName, sheetSku)
    if (!match.product) {
      plan.status = match.status === 'ambiguous' ? 'ambiguous' : 'unmatched'
      plan.message = match.message
      // Offered for an ambiguous row too: a row that fell through to a shared
      // SKU got there because its NAME matched nothing, and the closest name is
      // exactly what tells the operator whether to fix the sheet or add the
      // product.
      if (sheetName) plan.suggestion = suggestProduct(catalog, sheetName)?.product.name ?? null
      rows.push(plan)
      continue
    }

    const product = match.product
    plan.productId = product.id
    plan.productName = product.name

    const shelf = key(product.id, location)
    const dup = seen.get(shelf)
    if (dup != null) {
      plan.status = 'invalid'
      plan.message = `Row ${dup} already counts ${product.name} at ${location}.`
      rows.push(plan)
      continue
    }
    seen.set(shelf, plan.line)
    covered.add(shelf)

    // Quantity ------------------------------------------------------------
    const before = projectedQty.has(shelf)
      ? (projectedQty.get(shelf) as number)
      : (product.quantityByLocation[location] ?? 0)
    plan.quantityBefore = before
    const rounded = product.giveawayItem ? Math.round(quantity * 1e4) / 1e4 : Math.round(quantity)
    if (!product.giveawayItem && rounded !== quantity) {
      warnings.push(
        `${quantity} rounded to ${rounded} — this product is not flagged for fractional units.`
      )
    }
    plan.quantityAfter = rounded
    projectedQty.set(shelf, rounded)

    // Cost ----------------------------------------------------------------
    // Only the SHELF's cost is decided here. The product's resulting average is
    // worked out in the second pass below, once every row has had its say —
    // two rows can revalue two locations of the same product, and the average
    // depends on both.
    plan.costBefore = product.unitCost
    if (costEach != null) {
      if (rounded <= 0) {
        if (money(costEach) !== money(product.unitCost)) {
          warnings.push('Cost not applied: nothing on hand to value once this count is applied.')
        }
      } else {
        // Kept at UNIT_DP, not cents: a cost column that came from an extended
        // total ("$110.00 for 7") is a rate, and this is the number that gets
        // written onto the layers and multiplied by the quantity again.
        plan.shelfCostAfter = unitMoney(costEach)
        projectedShelfCost.set(shelf, unitMoney(costEach))
        statedCost.add(plan.line)
        // A typed 0 is a DECLARATION — cost is not tracked for this product —
        // and it is honoured exactly as any other stated cost is, which means it
        // CLEARS a basis the shelf was carrying. That is the whole point of it,
        // and it is also the one destructive thing a cost cell can do, so it is
        // named on the row. Typing 0 over nothing loses nothing and says
        // nothing: silence is the right answer when the operator has already
        // said what they mean.
        if (costEach === 0) {
          const had = product.costByLocation[location] ?? product.unitCost
          if (had > 0) {
            warnings.push(
              `Cost set to $0.00 — that clears the ${fmt(had)} basis on this shelf, and the stock ` +
                'sits outside the spread until a cost is set again.'
            )
          }
        }
      }
    } else if (rounded > 0) {
      // A row that counts stock but states no money for it. Nothing is written —
      // a blank cell is never a zero — so the shelf keeps whatever basis it
      // already had, and the dashboard will not read back what was pasted. Said
      // out loud per row, because it is invisible in the totals.
      //
      // Whether that is a note or a BLOCKER depends on what the shelf is keeping,
      // and that cannot be decided here: the answer is the product's basis after
      // the whole sheet has had its say, including the shelves this run is about
      // to empty. Decided in the second pass below.
      const kept = product.costByLocation[location] ?? product.unitCost
      warnings.push(
        kept > 0
          ? `The sheet states no cost — this stock keeps its current basis of ${fmt(kept)}.`
          : 'The sheet states no cost and there is none on file — this stock has no cost basis.'
      )
    }

    // Market value --------------------------------------------------------
    plan.marketBefore = product.highBid
    if (marketEach != null) {
      const after = money(marketEach)
      plan.marketAfter = after
      projectedMarket.set(product.id, after)
    } else {
      plan.marketAfter = product.highBid
      if (rounded > 0 && product.highBid != null && product.highBid > 0) {
        warnings.push(
          `The sheet states no market value — the ${fmt(product.highBid)} high bid on file stands.`
        )
      }
    }

    rows.push(plan)
  }

  // ---- Second pass: what each product's AVERAGE cost actually becomes ------
  //
  // syncProductAvgCost recomputes the average from every remaining cost layer
  // the product has, at every location. So a count that revalues RM leaves the
  // product carrying the weighted blend of RM's new cost and AM's old one. This
  // reproduces that arithmetic exactly, so the number on screen is the number
  // that will be stored.
  // Which shelves a product ends up holding anything on — only the ones the
  // sheet counted, because every other shelf it owns is going to zero. Indexed
  // once rather than scanned per product: this plan is rebuilt on every keystroke
  // and the sheet is now expected to name the whole catalog, not forty rows.
  const countedShelves = new Map<string, string[]>()
  for (const shelf of projectedQty.keys()) {
    const split = shelf.indexOf('::')
    const id = shelf.slice(0, split)
    const list = countedShelves.get(id)
    if (list) list.push(shelf.slice(split + 2))
    else countedShelves.set(id, [shelf.slice(split + 2)])
  }
  // The sheet is the whole warehouse, so this is the whole rule: a shelf it
  // counted holds what it counted, and a shelf it did not name holds nothing.
  // There is no third case and no condition on it any more — it IS the operation.
  const afterQtyAt = (p: ResetCatalogProduct, location: string): number =>
    projectedQty.get(key(p.id, location)) ?? 0
  const afterCostAt = (p: ResetCatalogProduct, location: string): number => {
    const shelf = key(p.id, location)
    if (projectedShelfCost.has(shelf)) return projectedShelfCost.get(shelf) as number
    return p.costByLocation[location] ?? p.unitCost
  }
  const afterAvgCost = new Map<string, number>()
  const afterQtyTotal = new Map<string, number>()
  /**
   * What each product is WORTH after the run, shelf by shelf.
   *
   * Accumulated as a sum of per-shelf extensions and kept as a total, never
   * collapsed to an average and multiplied back up. A product counted at two
   * locations at different costs — 3 @ $10 and 4 @ $20 — is worth $110.00, and
   * no single per-unit average can carry that: $15.7142… is not expressible, so
   * seven of it is not $110. The dashboard reads the same shelves the same way
   * (db/valuation.ts), which is what makes the number promised here and the
   * number displayed afterwards the same number rather than two opinions.
   */
  const afterCostValue = new Map<string, number>()
  for (const p of catalog) {
    let qty = 0
    let value = 0
    for (const location of countedShelves.get(p.id) ?? []) {
      const q = afterQtyAt(p, location)
      if (!(q > 0)) continue
      qty += q
      value += q * afterCostAt(p, location)
    }
    afterQtyTotal.set(p.id, Math.round(qty * 1e4) / 1e4)
    afterCostValue.set(p.id, value)
    // Nothing left on hand: syncProductAvgCost returns early and the last known
    // average stays on the product, so that is what is reported here too. The
    // average is reported at UNIT_DP because that is the precision it is stored
    // at — it is a per-unit rate, and it is used for display only.
    afterAvgCost.set(p.id, qty > 0 ? unitMoney(value / qty) : p.unitCost)
  }

  for (const row of rows) {
    if (row.status === 'invalid' || row.status === 'unmatched' || row.status === 'ambiguous') continue
    if (!row.productId) continue
    row.costAfter = afterAvgCost.get(row.productId) ?? row.costBefore
    const qtyMoved = (row.quantityAfter ?? 0) !== (row.quantityBefore ?? 0)
    const costMoved = money(row.costAfter ?? 0) !== money(row.costBefore ?? 0)
    const marketMoved = normMarket(row.marketAfter) !== normMarket(row.marketBefore)
    row.status = qtyMoved || costMoved || marketMoved ? 'change' : 'same'
  }

  // Every shelf holding stock that the sheet never spoke for. All of it is
  // written off — this list IS the destructive half of the run, and the preview
  // leads with it rather than filing it at the bottom.
  const missing: ResetMissingRow[] = []
  for (const p of catalog) {
    for (const [location, quantity] of Object.entries(p.quantityByLocation)) {
      if (!(quantity > 0)) continue
      if (covered.has(key(p.id, location))) continue
      // THIS shelf's basis, not the product-wide average. A product held at two
      // locations at two costs loses a different amount depending on which shelf
      // goes, and the write-off panel has to say which — the product average
      // would understate one shelf and overstate the other by the same money.
      const unitCost = p.costByLocation[location] ?? p.unitCost
      missing.push({
        productId: p.id,
        productName: p.name,
        location,
        quantity,
        unitCost,
        unitMarket: p.highBid && p.highBid > 0 ? p.highBid : unitCost
      })
    }
  }
  missing.sort((a, b) => b.quantity * b.unitMarket - a.quantity * a.unitMarket)

  // ---- Stock this run would leave carried at nothing -----------------------
  //
  // A blank cost cell means "the sheet did not state this", so the shelf keeps
  // what it had. That is right, and harmless, as long as what it had is a real
  // number. When it is not, the run books counted stock onto a shelf with NO
  // cost basis, and every dashboard total then reads its whole market value as
  // profit: on the paste that produced this check, $16,039.93 of invented spread
  // across four real products with real quantities.
  //
  // BLOCKING, like an unmatched row, and for a stronger reason. Under a baseline
  // the sheet is the truth about the warehouse, so "I did not say" is not a
  // usable answer to "what is this worth". An unmatched row at least announces
  // itself; this one succeeds — the counts come out right, the paste reports no
  // trouble, and the profit is wrong somewhere nobody is looking.
  //
  // THE TEST IS THE OUTCOME, NOT THE CELL. A blank cost against a product that
  // already has a basis passes straight through and keeps it, so an ordinary
  // recount never makes anybody retype costs that are already set. What is
  // refused is stock that would END at nothing — which is also why a cell
  // stating a literal 0 is refused, and why a shelf counted at 0 units is not
  // (there is nothing on it to value).
  //
  // Per PRODUCT rather than per shelf, deliberately, because that is what the
  // dashboard banner tests: `zeroCost` in db/inventory.ts is `qty > 0 AND
  // cost_value <= 0` summed over a product's shelves. Testing per shelf here
  // would refuse sheets the banner would never have complained about; testing
  // per product means the two are looking at the same thing.
  //
  // AND IT SPLITS BY UNIT TYPE, because what a zero basis costs depends on what
  // the stock is. For a case the paragraphs above hold unchanged — it blocks.
  // For a BOX the dashboard no longer counts the market value as profit; it
  // holds the box out of the Spread entirely and says how much it is holding
  // (PRODUCT_TOTALS in db/inventory.ts). So the failure is no longer silent, and
  // it is no longer a lie — it is an incomplete figure that the app states in
  // full. That is a warning, not a refusal, and refusing it would be refusing
  // the ordinary way boxes arrive: picked up with no price to hand, which is the
  // reason the cost field is optional on the add-stock form in the first place.
  //
  // A run that passes can therefore leave a banner row after all — but only an
  // uncosted BOX, and only the kind the banner reports as excluded rather than
  // as fictional profit.
  const uncosted: Array<{ id: string; name: string; quantity: number }> = []
  const uncostedBoxes: Array<{ id: string; name: string; quantity: number }> = []
  for (const p of catalog) {
    const qty = afterQtyTotal.get(p.id) ?? 0
    if (!(qty > 0)) continue
    // `!(value > 0)` rather than `value <= 0` so a NaN — a cost column that
    // parsed into something unusable — lands on the refusing side.
    if ((afterCostValue.get(p.id) ?? 0) > 0) continue
    const entry = { id: p.id, name: p.name, quantity: qty }
    if (p.unitType === 'box') uncostedBoxes.push(entry)
    else uncosted.push(entry)
  }
  const worstFirst = (
    a: { quantity: number; name: string },
    b: { quantity: number; name: string }
  ): number => b.quantity - a.quantity || a.name.localeCompare(b.name)
  uncosted.sort(worstFirst)
  uncostedBoxes.sort(worstFirst)

  if (uncosted.length > 0) {
    // Named with their counts, exactly like the write-off panel names what it is
    // about to destroy: a number on its own sends the operator hunting through
    // three hundred rows for the four that are wrong.
    const SHOWN = 6
    const named = uncosted
      .slice(0, SHOWN)
      .map((u) => `${u.name} (${qtyLabel(u.quantity)})`)
      .join(', ')
    const rest = uncosted.length - SHOWN
    problems.push(
      `${uncosted.length} product${uncosted.length === 1 ? '' : 's'} would be left on the shelf ` +
        `with no cost: ${named}${rest > 0 ? `, and ${rest} more` : ''}. A blank cost cell keeps ` +
        `whatever the product already had, and these have nothing — so their full market value ` +
        `would count as profit. State a cost for them on the sheet, or set one in the catalog ` +
        `first, and paste again.`
    )
    // And on the rows themselves, so the operator can see WHICH line of a
    // three-hundred-row sheet to go and fix.
    const blocked = new Set(uncosted.map((u) => u.id))
    for (const row of rows) {
      if (!row.productId || !blocked.has(row.productId)) continue
      if (row.status === 'unmatched' || row.status === 'ambiguous' || row.status === 'invalid') continue
      row.warnings.push('This row is holding the count up: it would leave this stock at $0.00 cost.')
    }
  }

  // The box half: a note on the rows, and the run goes through. Said per row
  // rather than as one summary line because that is where the fix is — the same
  // reason the write-off panel names shelves instead of counting them.
  //
  // A row that STATED its cost is skipped even though it ends at nothing. A
  // typed 0 means cost is not tracked for that product, and telling somebody
  // that what they just typed had the effect they typed it for is noise.
  if (uncostedBoxes.length > 0) {
    const noted = new Set(uncostedBoxes.map((u) => u.id))
    for (const row of rows) {
      if (!row.productId || !noted.has(row.productId)) continue
      if (row.status === 'unmatched' || row.status === 'ambiguous' || row.status === 'invalid') continue
      if (statedCost.has(row.line)) continue
      // A row counting the shelf empty is not the row leaving stock uncosted —
      // the stock is somewhere else on the sheet.
      if (!(row.quantityAfter != null && row.quantityAfter > 0)) continue
      row.warnings.push(
        'No cost for this box — it goes on the shelf carrying nothing and stays outside the ' +
          'spread until one is set.'
      )
    }
  }

  // A shelf the sheet skipped for a product it DID count somewhere else is the
  // shape of a location typo — and under a baseline that shelf is written off
  // rather than left alone, so naming it on the row is the difference between a
  // corrected typo and a silent write-off of real stock.
  const missingByProduct = new Map<string, ResetMissingRow[]>()
  for (const m of missing) {
    const list = missingByProduct.get(m.productId)
    if (list) list.push(m)
    else missingByProduct.set(m.productId, [m])
  }
  for (const row of rows) {
    if (!row.productId || row.status === 'unmatched' || row.status === 'ambiguous') continue
    const others = missingByProduct.get(row.productId)
    if (!others?.length) continue
    const where = others.map((o) => `${o.quantity} at ${o.location}`).join(', ')
    row.warnings.push(
      `Also holds ${where} — not on this sheet, so ${
        others.length === 1 ? 'that shelf goes' : 'those shelves go'
      } to zero.`
    )
  }

  // Catalog-wide totals, before and after ---------------------------------
  const totals: ResetTotals = {
    unitsBefore: 0,
    unitsAfter: 0,
    costBefore: 0,
    costAfter: 0,
    marketBefore: 0,
    marketAfter: 0
  }
  //
  // Both sides are summed SHELF BY SHELF, never as on-hand × an average. That is
  // what the dashboard does (db/valuation.ts: quantity × the shelf's layer-
  // weighted unit cost), down to the same division and the same multiplication,
  // so "what this reset promises" and "what the dashboard reads afterwards" are
  // one arithmetic evaluated twice rather than two that happen to be close.
  for (const p of catalog) {
    const qtyBefore = totalQty(p)
    const qtyAfter = afterQtyTotal.get(p.id) ?? qtyBefore
    let costBefore = 0
    for (const [location, quantity] of Object.entries(p.quantityByLocation)) {
      costBefore += quantity * (p.costByLocation[location] ?? p.unitCost)
    }
    const costAfter = afterCostValue.get(p.id) ?? costBefore
    // The dashboard values unpriced stock at cost, and these widgets have to
    // read the same way or the operator is comparing two different numbers. A
    // high bid IS a per-unit number somebody typed, so the market side of a
    // priced product stays a multiplication and is exact.
    const bidBefore = p.highBid && p.highBid > 0 ? p.highBid : null
    const marketAfterRaw = projectedMarket.has(p.id) ? projectedMarket.get(p.id) : p.highBid
    const bidAfter = marketAfterRaw && marketAfterRaw > 0 ? marketAfterRaw : null
    totals.unitsBefore += qtyBefore
    totals.unitsAfter += qtyAfter
    totals.costBefore += costBefore
    totals.costAfter += costAfter
    totals.marketBefore += bidBefore != null ? qtyBefore * bidBefore : costBefore
    totals.marketAfter += bidAfter != null ? qtyAfter * bidAfter : costAfter
  }
  totals.costBefore = money(totals.costBefore)
  totals.costAfter = money(totals.costAfter)
  totals.marketBefore = money(totals.marketBefore)
  totals.marketAfter = money(totals.marketAfter)
  totals.unitsBefore = Math.round(totals.unitsBefore * 1e4) / 1e4
  totals.unitsAfter = Math.round(totals.unitsAfter * 1e4) / 1e4

  const counts = {
    total: rows.length,
    change: rows.filter((r) => r.status === 'change').length,
    same: rows.filter((r) => r.status === 'same').length,
    unmatched: rows.filter((r) => r.status === 'unmatched').length,
    ambiguous: rows.filter((r) => r.status === 'ambiguous').length,
    invalid: rows.filter((r) => r.status === 'invalid').length,
    warnings: rows.reduce((n, r) => n + r.warnings.length, 0)
  }

  // A baseline writes off everything it did not find. That is only defensible
  // if every row on the sheet was actually understood — an unmatched, ambiguous
  // or rejected row is stock the operator DID count, and zeroing everything
  // else because the app could not read that row turns a naming problem into a
  // write-off. BLOCKED, not warned: there is no longer a checkbox to fall back
  // on, and a partly-understood sheet cannot be the truth about a warehouse.
  const unresolved = counts.unmatched + counts.ambiguous + counts.invalid
  if (unresolved > 0) {
    problems.push(
      `${unresolved} of ${counts.total} rows could not be read as a count. ` +
        'This sheet replaces the whole warehouse, so applying it would write off the stock those ' +
        'rows are counting. Fix them on the sheet — or add the product to the catalog first — ' +
        'and paste again.'
    )
  }

  return { mapping, rows, missing, counts, totals, problems }
}

function normMarket(value: number | null): number | null {
  return value == null ? null : money(value)
}

function fmt(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** A count for a sentence: "12", or "2.25" for a giveaway product's part boxes.
 *  Rounded at UNIT_DP so float dust never reads as a fourteen-decimal count. */
function qtyLabel(n: number): string {
  return String(Math.round(n * 1e4) / 1e4)
}

/** Rows this plan would actually write. */
export function applicableRows(plan: ResetPlan): ResetRowPlan[] {
  return plan.rows.filter((r) => r.status === 'change')
}

/** Is there anything at all to do? */
export function hasWork(plan: ResetPlan): boolean {
  if (plan.problems.length > 0) return false
  return applicableRows(plan).length > 0 || plan.missing.length > 0
}

// ---------------------------------------------------------------------------
// The record of a run
// ---------------------------------------------------------------------------

export interface ResetRunSummary {
  id: string
  source: string
  rowsTotal: number
  rowsApplied: number
  rowsSkipped: number
  productsCreated: number
  shelvesZeroed: number
  unitsBefore: number
  unitsAfter: number
  costBefore: number
  costAfter: number
  marketBefore: number
  marketAfter: number
  createdAt: string
  createdBy: string | null
  actorName: string | null
}

export interface ResetApplyResult {
  run: ResetRunSummary
  /** Human-readable lines describing what moved, newest work first. */
  applied: string[]
}
