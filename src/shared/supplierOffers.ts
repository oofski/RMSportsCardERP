/**
 * Reading a supplier's text message as purchase-order lines.
 *
 * The offers this business buys against arrive as a plain-text message — nine
 * or ten lines of the same terse shape — and were being retyped into the PO
 * form by hand, at a price per line. This module turns the paste into rows a
 * person can check.
 *
 * ## It is a parser, not an assistant
 *
 * Deterministic string work, no model, no network, no clock. That is the
 * feature and not a limitation:
 *
 *   - it works with the machine offline and costs nothing per paste;
 *   - the same text always produces the same rows, so a wrong reading can be
 *     reproduced, pinned in tests/supplierOffers.test.ts and fixed;
 *   - and it CANNOT INVENT A PRICE. Everything below either reads a number out
 *     of the operator's text or refuses the line. Nothing is inferred from
 *     anything except the characters on it.
 *
 * Every function here is pure: no DB, no DOM, no Electron. The catalog is
 * reached through the SAME search the PO typeahead already uses — this module
 * only says what to search for (catalogQueriesFor) and how to rank what comes
 * back (matchOfferLine).
 *
 * ## The shape being read
 *
 *   25 Reflector FB Crest-$3150 per (4cs)
 *   25/6 Reflector BKB Vault-$9,250 (2cs)
 *   26 Halo Baseball-$1450 (6cs)
 *
 * i.e. {season} {product}-${price} [per] ({qty}cs) — with every part of that
 * optional in practice, because it is typed by a person into a phone.
 *
 * ## "PER" IS NOISE. EVERY LINE IS PER-CASE.
 *
 * Some lines carry the word "per" and some do not, and the difference is worth
 * real money — on a $7200 four-case line the two readings are $7,200 a case and
 * $1,800 a case, a 4x error that produces a plausible-looking purchase order
 * either way. It cannot be settled by parsing, because it is a fact about what
 * the supplier meant.
 *
 * SO IT WAS ASKED. The owner's answer: "per" is inconsistent typing, and every
 * line on these lists is priced per case. That is now the rule — `basis` comes
 * out of the parser as 'per-unit' on every line, whatever words are on it, and
 * the presence or absence of "per" changes nothing at all. The word is stripped
 * from the product name as the noise it turned out to be.
 *
 * `basis` STAYS SETTABLE, and that is not hedging. A supplier will eventually
 * quote a lot price, and a review that could not express it would make the
 * operator retype a whole line to fix one number — the sort of small trap that
 * makes somebody stop pasting and go back to typing everything. One control per
 * row flips that row to a total, and its figures recompute from the flipped
 * reading (see unitPriceOf / lineTotalOf).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What the operator's "(4cs)" counted. Cases and boxes are both bought here. */
export type OfferUnit = 'case' | 'box'

/** Whether the money on the line is one unit's price or the whole line's. */
export type PriceBasis = 'per-unit' | 'total'

/**
 * A release season, expanded.
 *
 * ## The century rule, written down
 *
 * A two-digit year resolves to 20YY. Always, with no clock involved.
 *
 * The alternative — a sliding window against today's date — makes the parser
 * depend on when it runs, which means the same paste parses differently next
 * decade and a test has to freeze time to say anything. And it buys nothing:
 * this business buys sealed card product by release season, the trade has
 * written two-digit years as 20YY since the year 2000, and a supplier offering
 * "97 Reflector" does not exist here.
 *
 * A FOUR-digit year is honoured exactly as typed — "1997" stays 1997 — so the
 * rule only ever applies where there is genuinely no century on the line, and
 * the expanded label is printed back on the review row so a wrong reading is
 * visible rather than buried.
 */
export interface OfferSeason {
  /** Exactly the characters the operator typed: "25", "25/6", "2025-26". */
  raw: string
  startYear: number
  /** The second year of a split season, or null for a single-year release. */
  endYear: number | null
  /** "2025" or "2025-26" — what the row shows back to the operator. */
  label: string
}

/** One abbreviation this module expanded, so the row can show its working. */
export interface OfferExpansion {
  /** The operator's token, as typed: "FB". */
  from: string
  /** What it was searched as: "Football". */
  to: string
}

/** A line that produced a buyable row. */
export interface ParsedOfferLine {
  ok: true
  /** 1-based position in the pasted text, so nine lines in read as nine rows. */
  lineNumber: number
  /** The operator's line, VERBATIM. Never normalised — the review prints it. */
  raw: string
  season: OfferSeason | null
  /**
   * The product in the operator's own words, with only the season, price,
   * quantity and pricing words taken out. Not expanded, not title-cased, not
   * corrected: this is what the row displays, and a supplier's own wording is
   * how the operator recognises the line they are checking.
   */
  productText: string
  /**
   * The same words with sport abbreviations expanded — what the catalog is
   * searched with. Carries NO year: catalogQueriesFor adds it, because the year
   * is the first term worth dropping when a search comes back empty.
   */
  searchText: string
  /** Expansions applied, for a row that wants to show FB → Football. */
  expansions: OfferExpansion[]
  /**
   * The number after the "$", in dollars. Whether it is a unit price or a line
   * total is `basis` — this field is deliberately just "the money on the line".
   */
  price: number
  /**
   * ALWAYS 'per-unit' as parsed — see the module header. Settable afterwards so
   * a review row can be flipped to a lot price without retyping the line.
   */
  basis: PriceBasis
  /**
   * Pricing words taken off the tail of the line and thrown away: "per", "per
   * case", "total". Kept only so a row can mention one it removed. NONE OF THEM
   * CHANGES `basis` — that is the owner's ruling, and this field exists so that
   * removing a word is not the same as pretending it was never typed.
   */
  pricingWords: string[]
  quantity: number
  /**
   * True when the line carried no quantity and 1 was used. Harmless for money
   * (one unit's price and one unit's total are the same number) and visible on
   * the row, but it must not read as a quantity the supplier stated.
   */
  quantityAssumed: boolean
  unit: OfferUnit
}

/** A line that looked like an offer and could not be read. Never dropped. */
export interface UnparsedOfferLine {
  ok: false
  lineNumber: number
  raw: string
  /** Plain words for the review row — what was missing, not a parser code. */
  reason: string
}

export type OfferLine = ParsedOfferLine | UnparsedOfferLine

/** A line deliberately left out of the list: a greeting, a header, a sign-off. */
export interface IgnoredOfferLine {
  lineNumber: number
  raw: string
  reason: string
}

export interface OfferParse {
  /** Rows for the review table, in the order they were pasted. */
  lines: OfferLine[]
  /**
   * Lines judged not to be part of the list. Shown as a count with the text
   * available, never as order rows — but never silently discarded either, so an
   * offer wrongly classed as a greeting is still findable.
   */
  ignored: IgnoredOfferLine[]
  /** Non-blank lines seen. lines.length + ignored.length always equals it. */
  consideredLines: number
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * A CENT-valued figure — a price as typed, a line total.
 *
 * Matches what the rest of the app does with money (see `cents` in
 * @shared/costLots and @shared/financeStreaming): dollars in a number, snapped
 * to two places at every step so float dust cannot accumulate into a cent.
 */
const cents = (n: number): number => Math.round(n * 100) / 100

/**
 * A PER-UNIT figure, at four places.
 *
 * Mirrors UNIT_DP in src/main/db/lots.ts, restated here because the renderer
 * cannot import from main. It matters on exactly one path: a line the operator
 * flips to "order total", where the unit price is the total divided by the
 * count and $10,000 over 3 cases is $3,333.3333… At two places that stores
 * $3,333.33 and multiplies back to $9,999.99 — a purchase order a cent short of
 * the number the supplier quoted, for no reason anybody could find later.
 */
const perUnit = (n: number): number => Math.round(n * 10000) / 10000

/**
 * What one case (or box) costs, given how the line is currently being read.
 *
 * This is the number the purchase order stores — api.purchaseOrders.create
 * takes a unitPrice per line and multiplies — so everything the review shows is
 * derived from it rather than computed alongside it. See lineTotalOf.
 */
export function unitPriceOf(line: ParsedOfferLine): number {
  if (line.basis === 'per-unit') return cents(line.price)
  // Guard the divide: the review lets the operator type in the quantity box,
  // and an empty box is a 0 for one keystroke. Returning 0 keeps the row
  // rendering; Infinity would put "$Infinity" on a purchase order screen.
  if (!(line.quantity > 0)) return 0
  return perUnit(line.price / line.quantity)
}

/**
 * What the line costs in total.
 *
 * Computed from unitPriceOf ON PURPOSE, not from `price` directly, so that WHAT
 * THE REVIEW SHOWS IS WHAT THE PO STORES. Deriving the displayed total straight
 * from a stated total would let the screen show $10,000.00 while the saved PO
 * — which only keeps a unit price — came to something else. Rounding a
 * four-place unit price back up over its own quantity lands on the stated total
 * again for every real case, and where it cannot, the review is showing the
 * truth instead of a comforting number.
 */
export function lineTotalOf(line: ParsedOfferLine): number {
  return cents(unitPriceOf(line) * line.quantity)
}

/** Σ of the lines the operator is actually going to order. */
export function offerTotal(lines: ParsedOfferLine[]): number {
  return cents(lines.reduce((sum, l) => sum + lineTotalOf(l), 0))
}

// ---------------------------------------------------------------------------
// Sport abbreviations
// ---------------------------------------------------------------------------

/**
 * The shorthand suppliers write inside product names.
 *
 * EXPANSION IS FOR SEARCHING ONLY. The catalog spells the sport out
 * ("…Football Hobby…") and this app's catalog search requires every term to
 * match, so "FB" would find nothing. The operator's own text is kept untouched
 * in `productText` and is what the review row displays — correcting somebody's
 * message back at them makes the row harder to check against the phone it came
 * from, not easier.
 *
 * ## What is deliberately NOT here
 *
 * "BB" is baseball to half this trade and basketball to the other half, and the
 * two are different products at different prices from the same brands in the
 * same week. An expansion that is right most of the time is worse than none at
 * all here: it would put a confident match on a row that deserves a question,
 * and cost basis follows the product. So ambiguous shorthand stays verbatim,
 * fails to match, and reaches a person. Same reasoning for "BK" and "FT".
 */
const SPORT_ABBREVIATIONS: Record<string, string> = {
  fb: 'Football',
  ftbl: 'Football',
  fball: 'Football',
  bkb: 'Basketball',
  bskb: 'Basketball',
  bktb: 'Basketball',
  bball: 'Basketball',
  bsbl: 'Baseball',
  bsb: 'Baseball',
  hky: 'Hockey',
  hkey: 'Hockey',
  sccr: 'Soccer'
}

/**
 * Shorthand this module refuses to expand, and why, so the list is a decision
 * rather than an oversight. Exported because the test pins it: somebody adding
 * "bb" to the table above should have to delete a line that explains the cost.
 */
export const AMBIGUOUS_ABBREVIATIONS: Record<string, string> = {
  bb: 'Baseball or Basketball — both are bought here, from the same brands.',
  bk: 'Basketball or a break — too little to go on.',
  ft: 'Football or a fraction of a case.'
}

// ---------------------------------------------------------------------------
// Tokenising
// ---------------------------------------------------------------------------

/**
 * Words that carry no identifying weight in a card-product name.
 *
 * Short on purpose. A configuration name — "Crest", "Vault", "Standard" — looks
 * like filler and is the entire difference between two products at different
 * prices, so those stay significant and are allowed to stop a match.
 */
const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'and', 'new', 'release', 'sealed', 'x', 'per'])

/**
 * Quantity language, which is never product identity. Stripped from BOTH sides
 * of a comparison: a catalog row called "…Hobby Case" and a supplier line that
 * counted its cases separately are describing the same thing.
 */
const UNIT_WORDS = new Set(['case', 'cases', 'cs', 'box', 'boxes', 'bx', 'ct'])

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 0)
}

/** A four-digit year token — handled by the year gate, never by the word floor. */
const isYearToken = (t: string): boolean => /^(19|20)\d{2}$/.test(t)

function significant(list: string[]): string[] {
  return list.filter((t) => !STOPWORDS.has(t) && !UNIT_WORDS.has(t) && !isYearToken(t))
}

/** Every four-digit year mentioned in a string. "2025-26" yields just 2025. */
function yearsIn(s: string): Set<string> {
  return new Set(s.match(/\b(19|20)\d{2}\b/g) ?? [])
}

// ---------------------------------------------------------------------------
// Line classification
// ---------------------------------------------------------------------------

/**
 * Openings and sign-offs that wrap a list in a real message.
 *
 * Matched at the START of a line only. A product named "Best" would otherwise
 * be unreachable, and "Thanks" appearing mid-sentence is not a sign-off.
 */
const COURTESY =
  /^(hi|hey|hello|yo|good (morning|afternoon|evening)|thanks|thank you|thx|ty|cheers|best|regards|talk soon|lmk|let me know|please|pls|sent from|here('| i)s|attached|as (always|discussed)|call me|hit me)\b/i

/**
 * Is this line part of the list at all?
 *
 * Returns a reason to IGNORE it, or null to keep going. The bar is set so that
 * anything carrying money or a count survives to be parsed — a line wrongly
 * ignored disappears from a review the operator is using to check that nine
 * lines produced nine rows, which is the one failure this screen cannot have.
 * A line wrongly kept just shows up as a row nobody ticks.
 */
function courtesyOrHeader(line: string, hasMoney: boolean, hasQty: boolean): string | null {
  // Money or a count outranks everything below. A supplier who writes "Best
  // price I have: 25 Halo FB-$4200 (5cs)" is still quoting a price.
  if (hasMoney || hasQty) return null
  if (COURTESY.test(line)) return 'Reads as a greeting or a sign-off.'
  // No digit anywhere: a name, a "Thanks!", a bare category header ("Football").
  if (!/\d/.test(line)) return 'No numbers on it — not an order line.'
  // "New releases this week:" — a header that happens to carry a year.
  if (/:\s*$/.test(line)) return 'Ends in a colon — reads as a heading.'
  return 'No price and no quantity on it.'
}

// ---------------------------------------------------------------------------
// The pieces of a line
// ---------------------------------------------------------------------------

/**
 * A quantity and its unit: "(5cs)", "5 cases", "2 bx".
 *
 * The `(?<![\d.])` is load-bearing. Without it "(1.5cs)" matches on the "5" and
 * silently orders five cases instead of refusing an amount this app cannot
 * stock — the digits before a decimal point are not a separate number.
 */
const QUANTITY_RE = /\(?\s*(?<![\d.])(\d+)\s*(cs|cases|case|bx|boxes|box)\b\.?\s*\)?/gi

/**
 * The fraction QUANTITY_RE just refused to read.
 *
 * Without this the leftover "1.5cs" falls through into the product name and the
 * row quietly becomes a quantity of 1 — an order for one case where somebody
 * offered one and a half, which nothing downstream would ever question. Stock
 * here is whole cases and boxes (see @shared/units: fractional holdings are
 * opt-in per product and exist only for giveaway material), so the honest
 * answer is to refuse the line and say why.
 */
const FRACTIONAL_QUANTITY_RE = /\d+\.\d+\s*(cs|cases|case|bx|boxes|box)\b/i

/**
 * Money. The "$" is REQUIRED and that is the whole design.
 *
 * A supplier line carries up to three numbers — a season, a price and a count —
 * and with the "$" gone there is no way to tell which is which that does not
 * amount to guessing. "25 Halo FB 4200 5cs" could be $4,200 for 5 cases or
 * (someone typing badly) 25 cases at $4,200. So a line with no "$" is reported
 * unparsed and reaches a person, rather than being read by a rule that is right
 * most of the time and puts a wrong price on a purchase order the rest.
 */
const PRICE_RE = /\$\s*([0-9][0-9,]*(?:\.\d+)?)/

/**
 * The words that qualify a price rather than name a product.
 *
 * ALL OF THEM ARE THROWN AWAY. "per" changes nothing (see the module header:
 * every line is a case price), and neither does anything else here — the price
 * reading is a fixed rule now, not something a word on the line can move. What
 * this pattern is for is keeping "per" and "total" OUT OF THE PRODUCT NAME,
 * where they would poison both the display and the catalog search.
 *
 * Only ever looked for AFTER the "$" amount, which is what makes it safe to
 * delete them. There are real sets called "Total"; one written before the price
 * is the product, and stripping it there would search the catalog for a name
 * the supplier never used. A qualifier on the money sits with the money.
 *
 * A bare "ea" is deliberately absent. It would be read out of "26 EA Sports
 * FC", a real licensed set this business buys, and eat the brand out of a
 * product name — for no gain at all, since nothing here changes the price.
 */
const PRICING_WORDS_RE =
  /\bper\s*(?:case|cases|cs|box|boxes|bx|unit)?\b|\beach\b|\btotal\b|\ball[- ]in\b|\bfor (?:all|the lot)\b/gi

/**
 * Of those, the ones that say the money is for the WHOLE line.
 *
 * Nothing acts on this — `basis` is per-unit regardless. It exists so the
 * review can mention a word it deleted: a supplier who writes "total" has said
 * something, and silently removing it would be the app deciding that what they
 * said did not matter. See pricingNote.
 */
const LOT_WORD_RE = /^(?:total|all[- ]in|for (?:all|the lot))$/i

/**
 * Read the amount out of a "$…" match.
 *
 * Both refusals below are 100x errors dressed as typos:
 *
 *   COMMA GROUPING must be thousands. "$10,80" strips to 1080, and if the
 *   supplier meant $10.80 the line is wrong by a factor of a hundred with
 *   nothing on screen to show for it. Only 1–3 digits then groups of exactly 3
 *   are accepted; anything else is refused and reaches a person.
 *
 *   AT MOST TWO DECIMALS. "$4,250.500" is not a price; whatever it is, reading
 *   it as $4,250.50 is a decision this module has no basis for.
 */
function readPrice(
  text: string
): { price: number; index: number; length: number } | { error: string } {
  const m = PRICE_RE.exec(text)
  if (!m) return { error: 'No "$" price on the line.' }
  const literal = m[1]
  if (literal.includes(',') && !/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(literal)) {
    return { error: `Cannot tell what "$${literal}" means — the commas are not thousands.` }
  }
  const bare = literal.replace(/,/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(bare)) {
    return { error: `"$${literal}" has more decimal places than money has.` }
  }
  const price = Number(bare)
  if (!Number.isFinite(price)) return { error: `Could not read "$${literal}" as an amount.` }
  if (price <= 0) return { error: 'The price on the line reads as zero.' }
  return { price: cents(price), index: m.index, length: m[0].length }
}

/**
 * Expand a two-digit year. See OfferSeason for why this is 20YY and not a
 * window around the current date.
 */
const CENTURY = 2000
const fourDigit = (yy: number): number => CENTURY + yy

/**
 * The second year of a split season, from however many digits were typed.
 *
 * "25/6" gives one digit, and the answer is the next year whose last digit is
 * 6 — 2026. "2025-26" gives two, and the answer is the next year ending in 26
 * — also 2026, and 1999-00 correctly rolls to 2000 rather than back to 1900.
 * Both are "the next year that ends this way", which is what a person reading
 * a season means.
 */
function endYearFrom(startYear: number, digits: string): number {
  const step = 10 ** digits.length
  const tail = Number(digits)
  let end = Math.floor(startYear / step) * step + tail
  while (end <= startYear) end += step
  return end
}

/**
 * Pull a season off the FRONT of the remaining text.
 *
 * Anchored at the start because that is where a season goes and because a bare
 * two-digit number anywhere else is part of a product name — "Topps 206" is a
 * set, not the 2006 season. A single leading digit is not a season either: "3
 * Halo cases" is a count somebody wrote first.
 */
function readSeason(text: string): { season: OfferSeason; rest: string } | null {
  const patterns: Array<{ re: RegExp; build: (m: RegExpExecArray) => OfferSeason }> = [
    // 2025-26 / 2025/26
    {
      re: /^((\d{4})\s*[-/–]\s*(\d{2})(?!\d))/,
      build: (m) => season(m[1], Number(m[2]), endYearFrom(Number(m[2]), m[3]))
    },
    // 25-26 / 25/26
    {
      re: /^((\d{2})\s*[-/–]\s*(\d{2})(?!\d))/,
      build: (m) => season(m[1], fourDigit(Number(m[2])), fourDigit(Number(m[3])))
    },
    // 25/6 — one digit of the second year
    {
      re: /^((\d{2})\s*[-/–]\s*(\d)(?!\d))/,
      build: (m) => {
        const start = fourDigit(Number(m[2]))
        return season(m[1], start, endYearFrom(start, m[3]))
      }
    },
    // 2025
    { re: /^((\d{4})(?!\d))/, build: (m) => season(m[1], Number(m[2]), null) },
    // 25
    { re: /^((\d{2})(?!\d))/, build: (m) => season(m[1], fourDigit(Number(m[2])), null) }
  ]
  const head = text.trimStart()
  for (const p of patterns) {
    const m = p.re.exec(head)
    if (m) return { season: p.build(m), rest: head.slice(m[1].length) }
  }
  return null
}

function season(raw: string, startYear: number, endYear: number | null): OfferSeason {
  return {
    raw,
    startYear,
    endYear,
    label: endYear === null ? String(startYear) : `${startYear}-${String(endYear).slice(-2)}`
  }
}

/** Trim the separators a name is left wearing once its neighbours are removed. */
function tidy(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:,.]+/, '')
    .replace(/[\s\-–—:,.]+$/, '')
    .trim()
}

/** Expand sport shorthand, whole tokens only, keeping everything else as typed. */
function expandAbbreviations(text: string): { text: string; expansions: OfferExpansion[] } {
  const expansions: OfferExpansion[] = []
  const out = text.replace(/[A-Za-z]+/g, (word) => {
    const full = SPORT_ABBREVIATIONS[word.toLowerCase()]
    if (!full) return word
    expansions.push({ from: word, to: full })
    return full
  })
  return { text: out, expansions }
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

/**
 * Read a pasted message into review rows.
 *
 * Never creates anything. The output is a list the operator confirms line by
 * line — this is a buy, and the app's opinion about what a message meant is not
 * good enough to open a purchase order on its own.
 */
export function parseSupplierOffer(text: string): OfferParse {
  const lines: OfferLine[] = []
  const ignored: IgnoredOfferLine[] = []
  let considered = 0

  const source = (text ?? '').split(/\r\n|\r|\n/)
  for (let i = 0; i < source.length; i++) {
    const raw = source[i]
    const lineNumber = i + 1
    // Blank lines are not evidence of anything and are not counted. A pasted
    // message is full of them and a review that listed each one would bury the
    // rows it exists to show.
    if (!raw.trim()) continue
    considered++

    const result = parseOfferLine(raw, lineNumber)
    if ('ignoredReason' in result) {
      ignored.push({ lineNumber, raw, reason: result.ignoredReason })
    } else {
      lines.push(result.line)
    }
  }

  return { lines, ignored, consideredLines: considered }
}

/** One line. Exported for tests; the review always goes through parseSupplierOffer. */
export function parseOfferLine(
  raw: string,
  lineNumber = 1
): { line: OfferLine } | { ignoredReason: string } {
  const trimmed = raw.trim()
  const unparsed = (reason: string): { line: UnparsedOfferLine } => ({
    line: { ok: false, lineNumber, raw, reason }
  })

  // A leading bullet or list number is formatting, not content. Only stripped
  // when whitespace or punctuation follows, so a product starting with a digit
  // survives.
  let work = trimmed.replace(/^[-–—*•·]+\s+/, '').replace(/^\d{1,2}[.)]\s+/, '')

  const hasMoney = /\$/.test(work)
  QUANTITY_RE.lastIndex = 0
  const quantityMatches = [...work.matchAll(QUANTITY_RE)]
  const ignoredReason = courtesyOrHeader(work, hasMoney, quantityMatches.length > 0)
  if (ignoredReason) return { ignoredReason }

  const fraction = FRACTIONAL_QUANTITY_RE.exec(work)
  if (fraction) {
    return unparsed(`"${fraction[0]}" is not a whole count — stock is whole cases and boxes.`)
  }

  // QUANTITY — the LAST one on the line. A product name can carry a number
  // ("6 Pack Bundle"); the count the supplier is selling comes at the end.
  let quantity = 1
  let quantityAssumed = true
  let unit: OfferUnit = 'case'
  const qtyMatch = quantityMatches[quantityMatches.length - 1]
  if (qtyMatch) {
    const n = Number(qtyMatch[1])
    if (n > 0) {
      quantity = n
      quantityAssumed = false
      unit = /^b/i.test(qtyMatch[2]) ? 'box' : 'case'
      work = work.slice(0, qtyMatch.index) + ' ' + work.slice(qtyMatch.index + qtyMatch[0].length)
    }
  }

  // PRICE. Everything before it is what is being sold; everything after it is
  // a qualifier ON the money, which is the only place the per/total markers are
  // read from — see PRICING_WORDS_RE.
  const priced = readPrice(work)
  if ('error' in priced) return unparsed(priced.error)
  const head = work.slice(0, priced.index)
  const tail = work.slice(priced.index + priced.length)

  // PRICING WORDS. Collected, then deleted. Not one of them moves `basis`,
  // which is 'per-unit' on every line this parser produces — see the module
  // header for the owner's ruling and why the review can still flip a row.
  PRICING_WORDS_RE.lastIndex = 0
  const pricingWords = [...tail.matchAll(PRICING_WORDS_RE)].map((m) => m[0].trim())
  work = head + ' ' + tail.replace(PRICING_WORDS_RE, ' ')

  // SEASON, off the front of what is left.
  const seasonRead = readSeason(work)
  const seasonValue = seasonRead ? seasonRead.season : null
  const productText = tidy(seasonRead ? seasonRead.rest : work)
  if (!productText) return unparsed('No product name left once the price and count were read.')

  const expanded = expandAbbreviations(productText)
  return {
    line: {
      ok: true,
      lineNumber,
      raw,
      season: seasonValue,
      productText,
      searchText: expanded.text,
      expansions: expanded.expansions,
      price: priced.price,
      basis: 'per-unit',
      pricingWords,
      quantity,
      quantityAssumed,
      unit
    }
  }
}

// ---------------------------------------------------------------------------
// Finding the product in the catalog
// ---------------------------------------------------------------------------

/**
 * The fields matching reads off a catalog product.
 *
 * A structural subset of InventoryProduct, so the real thing can be passed
 * straight in and a test can build a candidate without a database or the twenty
 * other columns a product carries.
 */
export interface MatchableProduct {
  id: string
  name: string
  sku: string
  year?: string
  brand?: string
  setName?: string
  category?: string
  /** 'case' | 'box' | 'pack' | 'single' | 'other' — see UnitType in types.ts. */
  unitType?: string
  unitCost?: number
}

export type MatchConfidence = 'confident' | 'uncertain' | 'none'

/**
 * Generic over the product type so the renderer gets its InventoryProducts back
 * as InventoryProducts. Widening them to MatchableProduct here would force a
 * cast at every use, and a cast is how the wrong object eventually gets past
 * the compiler on a screen whose whole job is not attaching the wrong product.
 */
export interface OfferMatchOption<T extends MatchableProduct = MatchableProduct> {
  product: T
  /** 0–1: how much of the CATALOG name the supplier's words accounted for. */
  score: number
  /** True when every significant word on the line is in this product. */
  complete: boolean
  /**
   * The line counted cases and this product is stocked in boxes (or the other
   * way round). Not disqualifying — plenty of catalog rows are stocked in the
   * other unit on purpose — but it is exactly how a case price gets entered
   * against a box, so it can never be pre-selected silently.
   */
  unitMismatch: boolean
}

export interface OfferMatch<T extends MatchableProduct = MatchableProduct> {
  confidence: MatchConfidence
  /** Pre-selected product. NON-NULL ONLY when confidence is 'confident'. */
  selected: T | null
  /** Ranked, best first. May be non-empty even when confidence is 'none'. */
  options: OfferMatchOption<T>[]
  /** What the operator has to decide, in words. Null when nothing is wrong. */
  note: string | null
}

/**
 * How much of the catalog name a lone survivor has to account for before it is
 * offered pre-selected.
 *
 * A catalog row whose name says far more than the line did is not the same
 * claim as one that matches it: "26 Halo" against "2026 Halo Football Crest
 * Vault Case" is one word of five, and the four words nobody said are where the
 * price difference lives.
 */
export const CONFIDENT_MIN_SCORE = 0.4

/** How many alternatives a row offers before the list stops being a help. */
const MAX_OPTIONS = 6

/**
 * Search terms for this line, most specific first.
 *
 * The caller runs them through the SAME catalog search the PO typeahead uses
 * (api.purchaseOrders.searchCatalog → searchCatalog in db/inventory.ts) and
 * stops at the first one that returns anything. That search requires EVERY term
 * to appear, so a ladder is the only way a partly-recognised line produces
 * candidates at all:
 *
 *   1. year + the whole name — the query that finds the right row outright;
 *   2. the name without the year — the catalog does not always carry one;
 *   3. the name shortened from the RIGHT, one word at a time. Suppliers write
 *      the configuration last ("…FB Crest") and the brand first, and it is the
 *      trailing shorthand that most often has no counterpart in the catalog.
 *
 * Never narrower than two words: a one-word search returns a page of products
 * and answers nothing.
 */
export function catalogQueriesFor(line: ParsedOfferLine): string[] {
  const words = line.searchText.split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const queries: string[] = []
  const push = (q: string): void => {
    const t = q.trim()
    if (t && !queries.includes(t)) queries.push(t)
  }
  if (line.season) push(`${line.season.startYear} ${words.join(' ')}`)
  push(words.join(' '))
  for (let n = words.length - 1; n >= 2; n--) push(words.slice(0, n).join(' '))
  return queries.slice(0, 5)
}

/**
 * Decide which catalog product a line is describing — or refuse to.
 *
 * ## The floor runs the OTHER WAY to matchProductByName, on purpose
 *
 * db/inventory.ts matches a Whatnot listing title by requiring every word of
 * the CATALOG NAME to appear in the title, because a listing title is the
 * longer, chattier string. A supplier's offer line is the opposite: four words
 * of shorthand against a catalog name that spells out brand, sport,
 * configuration and pack size. Requiring the catalog's words to appear in the
 * line would match nothing at all.
 *
 * So here every significant word THE SUPPLIER WROTE must appear somewhere in
 * the product. That is what stops "Halo Football" attaching to "Halo
 * Basketball", and it is a floor rather than a score because a missing word is
 * not a weaker match — it is a different product.
 *
 * ## The year is decisive
 *
 * Two seasons of the same product differ in nothing else and cost different
 * money. When both sides name a year and they disagree, the product is out.
 * When only one side has one, nothing is claimed.
 *
 * ## Confident means there is nothing to decide
 *
 * One survivor, accounting for enough of its own name, in the unit the line
 * counted. Anything else — two survivors, a thin one, a unit that does not line
 * up — is offered as a CHOICE with nothing pre-selected. A wrong product on a
 * PO line prices stock at another product's cost and corrupts the basis of both
 * for as long as either is on the shelf; a question on screen costs a click.
 */
export function matchOfferLine<T extends MatchableProduct>(
  line: ParsedOfferLine,
  products: T[]
): OfferMatch<T> {
  const lineWords = significant(tokens(line.searchText))
  const lineYears = new Set<string>()
  if (line.season) {
    lineYears.add(String(line.season.startYear))
    if (line.season.endYear !== null) lineYears.add(String(line.season.endYear))
  }

  const scored: OfferMatchOption<T>[] = []
  for (const product of products) {
    const haystack = [product.name, product.brand, product.setName, product.category, product.year]
      .filter(Boolean)
      .join(' ')
    const haystackTokens = new Set(tokens(haystack))
    const nameWords = significant(tokens(product.name))

    // The year gate, before anything else — a different season is a different
    // product however well the words line up.
    const productYears = yearsIn(haystack)
    if (lineYears.size > 0 && productYears.size > 0) {
      let shared = false
      for (const y of productYears) if (lineYears.has(y)) shared = true
      if (!shared) continue
    }

    const complete = lineWords.length > 0 && lineWords.every((w) => haystackTokens.has(w))
    const lineSet = new Set(lineWords)
    const covered = nameWords.filter((w) => lineSet.has(w)).length
    // Fall back to the line's own word count when the catalog name is nothing
    // but stopwords, so the divide cannot be by zero.
    const denominator = nameWords.length || lineWords.length || 1
    const score = Math.round((covered / denominator) * 1000) / 1000
    if (!complete && covered === 0) continue

    scored.push({
      product,
      score,
      complete,
      unitMismatch: !!product.unitType && product.unitType !== line.unit
    })
  }

  // Complete matches first, then by how much of their own name they account
  // for, then by the shorter name — between two products that both fit, the one
  // saying less is the one saying only what the supplier said.
  scored.sort(
    (a, b) =>
      Number(b.complete) - Number(a.complete) ||
      b.score - a.score ||
      a.product.name.length - b.product.name.length
  )

  const survivors = scored.filter((s) => s.complete)
  const options = scored.slice(0, MAX_OPTIONS)

  if (survivors.length === 0) {
    return {
      confidence: 'none',
      selected: null,
      options,
      note:
        options.length > 0
          ? 'No catalog product carries every word on this line — pick one or search.'
          : 'Nothing in the catalog matches this line. Search for the product.'
    }
  }
  if (survivors.length > 1) {
    return {
      confidence: 'uncertain',
      selected: null,
      options,
      note: `${survivors.length} catalog products fit this line — pick the right one.`
    }
  }
  const only = survivors[0]
  if (only.score < CONFIDENT_MIN_SCORE) {
    return {
      confidence: 'uncertain',
      selected: null,
      options,
      note: 'The catalog name says a good deal more than this line does — check it.'
    }
  }
  if (only.unitMismatch) {
    return {
      confidence: 'uncertain',
      selected: null,
      options,
      note: `The line counts ${plural(line.unit)} and this product is stocked in ${plural(
        String(only.product.unitType)
      )} — check the quantity.`
    }
  }
  return { confidence: 'confident', selected: only.product, options, note: null }
}

// ---------------------------------------------------------------------------
// Wording shared by the review screen
// ---------------------------------------------------------------------------

/**
 * A word this line used that the fixed per-case reading does not honour.
 *
 * Null for almost every line, INCLUDING every line carrying "per" — that word
 * agrees with how the line is being read, so saying so would be noise, and
 * marking those rows differently from the rest would invite somebody to "fix" a
 * line that was already right. It is only non-null when the supplier wrote
 * something that means the opposite ("total"), which is a fact worth one
 * sentence next to a control that can act on it.
 */
export function pricingNote(line: ParsedOfferLine): string | null {
  if (line.basis !== 'per-unit') return null
  const lot = line.pricingWords.find((w) => LOT_WORD_RE.test(w))
  if (!lot) return null
  return `This line says "${lot}". It is being read as a price per ${line.unit} — switch it to Order total if that is wrong.`
}

/** "case" / "cases" — English, so a row reads as a sentence and not a schema. */
export function unitLabel(unit: OfferUnit, quantity: number): string {
  return quantity === 1 ? unit : plural(unit)
}

/** Plurals for the five stock units. "box" is the one that is not just +s. */
function plural(unit: string): string {
  return unit === 'box' ? 'boxes' : `${unit}s`
}
