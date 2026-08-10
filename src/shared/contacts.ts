import type { InvoiceAddress } from './invoices'

/**
 * The QuickBooks "Customer Contact List" report, turned into buyers.
 *
 * ## Why this is a runtime importer and not a seed
 *
 * The owner's list is ~360 real people: names, mobile numbers, home and business
 * addresses, personal email. THIS REPOSITORY IS PUBLIC. So there is no fixture,
 * no seed migration and no sample file anywhere in the tree — the operator picks
 * the export off their own disk, it is parsed here, and the rows land in their
 * local database and travel over the existing cloud sync like anything else they
 * type. Every test in tests/contacts.test.ts uses invented names for the same
 * reason. If you are tempted to check "just one row" in to reproduce a bug:
 * don't. Describe its SHAPE instead, which is all any of these rules needed.
 *
 * ## What the report actually looks like
 *
 * It is a report, not a table, and the difference is the first three rows: a
 * company name, a report title, a blank, and only THEN the header. Below the
 * header it is genuinely tabular — one customer per row, six columns — and the
 * last row is a print timestamp with nothing beside it.
 *
 *   Customer full name | Phone numbers | Email | Full name | Bill address | Ship address
 *
 * Every one of those cells is a rendered string rather than a field:
 *
 *   name      "Ada Fenwick (NC-FENCO) Fenwick Cards"   — person, optional code
 *                                                        in parens, optional
 *                                                        company after it
 *   phones    "Phone:(555) 010-1234 Mobile:(555) 010-1234"
 *   email     one address
 *   address   a multi-line block, last line usually "City ST ZIP"
 *
 * ## The rule that governs the whole file: never guess
 *
 * Everything here either recognises a shape exactly or hands the text back
 * unchanged with a warning attached. A row is never dropped for being odd — the
 * one thing worse than an address this app could not split is an address it
 * split wrongly and nobody noticed, because a wrong city looks right until a
 * parcel goes missing. So an unrecognised address is stored VERBATIM in line1 /
 * line2 with a note saying so: every character survives, the invoice still
 * prints, and the operator can see exactly which ones want a human.
 */

// ---------------------------------------------------------------------------
// Text → grid
// ---------------------------------------------------------------------------

/**
 * Split delimited text into a grid, honouring RFC4180 quoting.
 *
 * A second CSV splitter, and deliberately not the one in @shared/inventoryReset:
 * that one works a LINE at a time, which is correct for a count sheet and fatal
 * here. This report's address cell contains real newlines, so a CSV re-export
 * quotes them inside a single field — split the text into lines first and one
 * customer becomes three broken rows before the parser ever sees them.
 *
 * Tab wins when the first line has one, for the reason spelled out in
 * inventoryReset: text pasted or exported from a spreadsheet leaves `$8,600.00`
 * unquoted, and splitting THAT on commas shatters a money column in two.
 */
export function parseDelimitedGrid(text: string): string[][] {
  // A byte-order mark survives Excel's "Save as CSV" and would otherwise become
  // part of the first header cell, so "Customer full name" stops matching and
  // the whole sheet reads as headerless.
  const body = text.replace(/^\uFEFF/, '')
  const delimiter = detectDelimiter(body)

  const grid: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  const endCell = (): void => {
    row.push(cell)
    cell = ''
  }
  const endRow = (): void => {
    endCell()
    grid.push(row)
    row = []
  }

  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
      continue
    }
    if (ch === '"' && cell === '') {
      quoted = true
    } else if (ch === delimiter) {
      endCell()
    } else if (ch === '\r') {
      // \r\n is one break, a lone \r (old Mac exports) is also one.
      if (body[i + 1] === '\n') i++
      endRow()
    } else if (ch === '\n') {
      endRow()
    } else {
      cell += ch
    }
  }
  // A file that does not end in a newline still has a last row; one that does
  // must not gain an empty one.
  if (cell !== '' || row.length > 0) endRow()
  return grid
}

function detectDelimiter(text: string): '\t' | ',' {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    return line.includes('\t') ? '\t' : ','
  }
  return ','
}

// ---------------------------------------------------------------------------
// Grid → columns
// ---------------------------------------------------------------------------

type ContactField = 'name' | 'fullName' | 'phones' | 'email' | 'company' | 'billAddr' | 'shipAddr'

/**
 * Which header means which field, in resolution order.
 *
 * ORDER IS THE WHOLE POINT. This report has two columns whose names both end in
 * "full name" — "Customer full name" (the QuickBooks display name, which is the
 * one that matters) and "Full name" (given + family, filled in on a handful of
 * rows). Test for "customer" first and they land correctly; test for "name"
 * first and the display-name column is claimed by the wrong field, every buyer
 * imports under a bare person name, and the match against QuickBooks that the
 * whole invoicing module depends on quietly stops working.
 */
const HEADER_MATCHERS: Array<{ field: ContactField; test: (h: string) => boolean }> = [
  { field: 'shipAddr', test: (h) => h.includes('addr') && h.includes('ship') },
  { field: 'billAddr', test: (h) => h.includes('addr') },
  { field: 'phones', test: (h) => h.includes('phone') || h.includes('mobile') || h.includes('tel') },
  { field: 'email', test: (h) => h.includes('email') || h.includes('e-mail') },
  { field: 'company', test: (h) => h.includes('company') || h.includes('organi') },
  { field: 'name', test: (h) => h.includes('customer') || h.includes('display name') },
  { field: 'fullName', test: (h) => h.includes('name') }
]

function normalizeHeader(cell: string): string {
  return cell.replace(/[*:]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

export type ColumnMap = Partial<Record<ContactField, number>>

/** Resolve one row of headers to column indexes. Each field is claimed once. */
export function mapColumns(header: string[]): ColumnMap {
  const map: ColumnMap = {}
  header.forEach((raw, index) => {
    const h = normalizeHeader(raw)
    if (!h) return
    for (const m of HEADER_MATCHERS) {
      if (map[m.field] !== undefined) continue
      if (m.test(h)) {
        map[m.field] = index
        return
      }
    }
  })
  // A hand-made sheet may only have "Name". Promoting it is safe precisely
  // because the branch above already proved there is no "Customer ..." column
  // for it to collide with.
  if (map.name === undefined && map.fullName !== undefined) {
    map.name = map.fullName
    delete map.fullName
  }
  return map
}

/**
 * Find the header row, ignoring whatever the report printed above it.
 *
 * Two conditions, and the second one is what keeps the report TITLE out. "RM
 * Sports Collectibles LLC" resolves nothing; "Customer Contact List" resolves
 * `name`, because it contains the word customer, and a one-field match would
 * make the title the header and the real header the first buyer. So a header
 * has to name at least two different fields AND one of them has to be the name.
 */
export function findHeaderRow(grid: string[][]): { index: number; columns: ColumnMap } | null {
  const limit = Math.min(grid.length, 25)
  for (let i = 0; i < limit; i++) {
    const columns = mapColumns(grid[i])
    const found = Object.keys(columns).length
    if (found >= 2 && columns.name !== undefined) return { index: i, columns }
  }
  return null
}

// ---------------------------------------------------------------------------
// The display name
// ---------------------------------------------------------------------------

export interface SplitName {
  /** The whole cell, whitespace-normalised. This is the QuickBooks display name. */
  displayName: string
  /** Text before the first bracket, when there is one. */
  person: string | null
  /** The customer code QuickBooks files them under, e.g. "NC-FENCO". */
  code: string | null
  /** The business, from the text after the brackets or from a bracket itself. */
  company: string | null
}

/** No space, nothing exotic: what a filing code looks like and a company does not. */
const CODE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._&/+-]{0,23}$/

/**
 * Pull the parts out of "Ada Fenwick (NC-FENCO) Fenwick Cards".
 *
 * The PARTS ARE NEVER STORED — see importContacts, which writes `displayName`
 * verbatim as the buyer's name. They exist so the import report can say "Ada
 * Fenwick" instead of the full filing string, and so a row with an unexpected
 * shape can be described without quoting it. Nothing downstream depends on the
 * split being right, which is the only reason a heuristic is acceptable here at
 * all.
 *
 * A few rows carry two bracketed groups. Taking the FIRST code-shaped one and
 * treating the rest as company text handles them without a special case.
 */
export function splitDisplayName(raw: string): SplitName {
  const displayName = collapse(raw)
  const groups: string[] = []
  const re = /\(([^)]*)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(displayName)) !== null) groups.push(m[1].trim())

  const open = displayName.indexOf('(')
  const close = displayName.lastIndexOf(')')
  const person = open > 0 ? collapse(displayName.slice(0, open)) : groups.length ? null : displayName
  const trailing = close >= 0 ? collapse(displayName.slice(close + 1)) : ''

  const code = groups.find((g) => CODE_SHAPE.test(g)) ?? null
  const company = trailing || groups.find((g) => g !== code) || null

  return {
    displayName,
    person: person || null,
    code,
    company: company || null
  }
}

/**
 * Trim, and squeeze runs of whitespace to one space.
 *
 * Non-breaking spaces are folded in too: they arrive in this export inside
 * addresses, they are invisible on screen, and left alone they make two copies
 * of the same buyer name compare as different — which is exactly the duplicate
 * this importer exists to avoid.
 *
 * Exported because @shared/vendors folds names with it as well. ONE definition
 * on purpose: both importers key on a name COLLATE NOCASE, and two slightly
 * different ideas of what whitespace to fold would let the same business be
 * filed twice — once by the customer list and once by the vendor list — which
 * is the exact duplicate a single contact table was chosen to prevent.
 */
export function collapse(v: string | undefined | null): string {
  // JS regex \s already covers the non-breaking spaces this export carries
  // inside addresses, so one pass folds every kind of whitespace at once.
  return (v ?? '').replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// Phones
// ---------------------------------------------------------------------------

export interface SplitPhones {
  phone: string | null
  mobile: string | null
  /** Anything under a label this app has no column for, as "Fax: 555 0100". */
  other: string[]
}

const PHONE_LABELS: Record<string, 'phone' | 'mobile'> = {
  phone: 'phone',
  telephone: 'phone',
  primaryphone: 'phone',
  work: 'phone',
  workphone: 'phone',
  business: 'phone',
  businessphone: 'phone',
  mobile: 'mobile',
  cell: 'mobile',
  cellphone: 'mobile',
  mobilephone: 'mobile'
}

/**
 * "Phone:(555) 010-1234 Mobile:(555) 010-1234" → the two numbers.
 *
 * NUMBERS COME OUT EXACTLY AS THEY WENT IN. The real file holds fourteen
 * different formats — bare digits, dotted, bracketed, `+44` with spaces, an
 * eight-digit overseas number — and any attempt to normalise them to a US
 * ten-digit shape mangles the international ones. A phone number is a string
 * somebody dials, not a quantity.
 *
 * An unlabelled cell that contains digits is taken as the phone: a hand-made CSV
 * with a plain "Phone" column and a plain number in it is the obvious fallback
 * export, and refusing it would fail the one case this was built to survive.
 */
export function splitPhones(raw: string): SplitPhones {
  const text = collapse(raw)
  const out: SplitPhones = { phone: null, mobile: null, other: [] }
  if (!text) return out

  const labelRe = /([A-Za-z][A-Za-z .]{0,16}?)\s*:\s*/g
  const hits: Array<{ label: string; start: number; end: number }> = []
  let m: RegExpExecArray | null
  while ((m = labelRe.exec(text)) !== null) {
    hits.push({ label: m[1], start: m.index, end: m.index + m[0].length })
  }

  if (hits.length === 0) {
    if (/\d/.test(text)) out.phone = text
    else out.other.push(text)
    return out
  }

  hits.forEach((hit, i) => {
    const value = text.slice(hit.end, i + 1 < hits.length ? hits[i + 1].start : text.length).trim()
    if (!value) return
    const key = hit.label.replace(/[^A-Za-z]/g, '').toLowerCase()
    const slot = PHONE_LABELS[key]
    if (slot === 'phone' && !out.phone) out.phone = value
    else if (slot === 'mobile' && !out.mobile) out.mobile = value
    else out.other.push(`${hit.label.trim()}: ${value}`)
  })
  return out
}

/** Digits only, so "(555) 010-1234" and "555-010-1234" compare equal. */
export function phoneDigits(v: string | null | undefined): string {
  return (v ?? '').replace(/\D/g, '')
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

const EMAIL_SHAPE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/

export interface SplitEmails {
  email: string | null
  /** Second and later addresses. Kept out of the record; reported, not dropped. */
  extras: string[]
  /** Text that was in the cell and is not an address at all. */
  rejected: string[]
}

/**
 * The first address wins and the rest are reported.
 *
 * QuickBooks itself sends an invoice to ONE address, so a second one has nowhere
 * to go — but a cell holding two is a fact about the buyer that the operator
 * should be told about rather than have silently halved.
 */
export function splitEmails(raw: string): SplitEmails {
  const out: SplitEmails = { email: null, extras: [], rejected: [] }
  const text = collapse(raw)
  if (!text) return out
  for (const token of text.split(/[,;\s]+/)) {
    if (!token) continue
    if (EMAIL_SHAPE.test(token)) {
      if (!out.email) out.email = token
      else out.extras.push(token)
    } else {
      out.rejected.push(token)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * The countries this list actually reaches, plus the ways they get written.
 *
 * A closed list, not a heuristic. "The last line is a country" is only knowable
 * by recognising the country — anything cleverer would eat the last line of a
 * domestic address whose city happens to be two words. A country nobody here
 * sells to simply stays in the address text, which is the correct failure.
 */
const COUNTRY_ALIASES: Array<[string, string]> = [
  ['united states of america', 'United States'],
  ['united states', 'United States'],
  ['u.s.a.', 'United States'],
  ['u.s.', 'United States'],
  ['usa', 'United States'],
  ['us', 'United States'],
  ['united kingdom', 'United Kingdom'],
  ['great britain', 'United Kingdom'],
  ['england', 'United Kingdom'],
  ['scotland', 'United Kingdom'],
  ['wales', 'United Kingdom'],
  ['u.k.', 'United Kingdom'],
  ['uk', 'United Kingdom'],
  ['canada', 'Canada'],
  ['hong kong', 'Hong Kong'],
  ['china', 'China'],
  ['taiwan', 'Taiwan'],
  ['japan', 'Japan'],
  ['south korea', 'South Korea'],
  ['korea', 'South Korea'],
  ['singapore', 'Singapore'],
  ['malaysia', 'Malaysia'],
  ['philippines', 'Philippines'],
  ['thailand', 'Thailand'],
  ['vietnam', 'Vietnam'],
  ['india', 'India'],
  ['australia', 'Australia'],
  ['new zealand', 'New Zealand'],
  ['ireland', 'Ireland'],
  ['germany', 'Germany'],
  ['france', 'France'],
  ['netherlands', 'Netherlands'],
  ['belgium', 'Belgium'],
  ['spain', 'Spain'],
  ['italy', 'Italy'],
  ['switzerland', 'Switzerland'],
  ['sweden', 'Sweden'],
  ['norway', 'Norway'],
  ['denmark', 'Denmark'],
  ['poland', 'Poland'],
  ['portugal', 'Portugal'],
  ['mexico', 'Mexico'],
  ['brazil', 'Brazil'],
  ['argentina', 'Argentina'],
  ['israel', 'Israel'],
  ['united arab emirates', 'United Arab Emirates'],
  ['saudi arabia', 'Saudi Arabia'],
  ['south africa', 'South Africa']
]

/** Longest first, so "united states" is tried before "us". */
const COUNTRIES = [...COUNTRY_ALIASES].sort((a, b) => b[0].length - a[0].length)

export const US_STATES: Record<string, string> = {
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  'district of columbia': 'DC',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'puerto rico': 'PR',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY'
}

const STATE_NAMES = Object.keys(US_STATES).sort((a, b) => b.length - a.length)

export interface ParsedAddress {
  address: InvoiceAddress | null
  /** Sentences for the operator. Empty means every part was recognised. */
  warnings: string[]
}

/**
 * A rendered address block → the six columns QuickBooks wants.
 *
 * ## What is recognised, and what is refused
 *
 * The last line of a US block is "City ST ZIP", and that is the only thing here
 * taken as structure. A two-letter token in front of a five-digit ZIP is a state
 * (upper-cased, because CountrySubDivisionCode is upper case and "Mi" would be
 * rejected by Intuit); a spelled-out state name in the same position is looked
 * up in a closed table. Anything else and region and city stay null.
 *
 * ## The single-line case is deliberately left half-parsed
 *
 * Roughly one row in nine has the whole address on one line: street, city, state
 * and ZIP with no separator that says where one ends. The state and the ZIP are
 * still unambiguous — they are anchored to the END of the string — so those are
 * taken, and EVERYTHING ELSE goes into line1 untouched with a warning naming the
 * row.
 *
 * The tempting rule is "the city is whatever follows the last comma". It is
 * wrong often enough to matter: "1200 Market St, Suite 400" would file Suite 400
 * as the city, and a wrong city is invisible on screen and expensive in the
 * post. Left as line1 the address still prints correctly on an invoice, still
 * posts to QuickBooks (City is optional there), and shows up on a list the
 * operator can work through. A wrong city does none of those things.
 */
export function parsePostalAddress(raw: string): ParsedAddress {
  const warnings: string[] = []
  const lines = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(collapse)
    .filter((l) => l !== '')

  if (lines.length === 0) return { address: null, warnings }

  let country: string | null = null
  const last = lines.length - 1
  const stripped = stripCountry(lines[last])
  if (stripped.country) {
    country = stripped.country
    if (stripped.rest) lines[last] = stripped.rest
    else lines.pop()
  }

  if (lines.length === 0) {
    // The block was nothing but a country name. Real, and not an error.
    return { address: { ...blank(), country }, warnings }
  }

  const tail = lines[lines.length - 1]
  const placed = parseCityStateZip(tail)

  if (!placed) {
    warnings.push('no city, state or ZIP was recognised — the address was kept exactly as written')
    return {
      address: {
        ...blank(),
        line1: lines[0],
        line2: lines.slice(1).join(', ') || null,
        country
      },
      warnings
    }
  }

  const street = lines.slice(0, -1)

  if (street.length === 0) {
    // Everything on one line. See the note above on why the city is not guessed.
    if (placed.city) {
      warnings.push(
        'the whole address was on one line, so the street and the city were not separated'
      )
    }
    return {
      address: {
        line1: placed.city || null,
        line2: null,
        city: null,
        region: placed.region,
        postalCode: placed.postalCode,
        country
      },
      warnings
    }
  }

  if (!placed.region) {
    warnings.push('the state was not recognised, so only the ZIP was filed')
  }

  return {
    address: {
      line1: street[0],
      // QuickBooks has two street lines and this report has up to three. Joining
      // the extras beats dropping one: a suite number that vanishes is a parcel
      // that reaches the building and stops.
      line2: street.slice(1).join(', ') || null,
      city: placed.city || null,
      region: placed.region,
      postalCode: placed.postalCode,
      country
    },
    warnings
  }
}

function blank(): InvoiceAddress {
  return { line1: null, line2: null, city: null, region: null, postalCode: null, country: null }
}

/** Take a country off the end of a line, if one of the known ones is there. */
function stripCountry(line: string): { rest: string; country: string | null } {
  const low = line.toLowerCase()
  for (const [alias, canonical] of COUNTRIES) {
    if (!low.endsWith(alias)) continue
    const cut = line.length - alias.length
    // A word boundary, or "Columbus" ends in "us" and every Ohio address
    // suddenly claims to be in a country of its own.
    if (cut > 0 && /[A-Za-z0-9]/.test(line[cut - 1])) continue
    return { rest: line.slice(0, cut).replace(/[\s,.]+$/, ''), country: canonical }
  }
  return { rest: line, country: null }
}

interface CityStateZip {
  city: string
  region: string | null
  postalCode: string
}

/**
 * "Lexington SC 29072" → the three parts, or null when it is not that shape.
 *
 * The ZIP is matched first and anchored to the end, because it is the only part
 * of a US address that cannot be mistaken for anything else. Five digits, or
 * five-four. A six-digit postcode is NOT accepted: it is an overseas one, and
 * filing it as a US ZIP would put a foreign address into a US-shaped record.
 */
function parseCityStateZip(line: string): CityStateZip | null {
  const zip = /(?:^|[\s,])(\d{5}(?:-\d{4})?)$/.exec(line)
  if (!zip) return null
  const head = line.slice(0, line.length - zip[1].length).replace(/[\s,.]+$/, '')
  if (!head) return { city: '', region: null, postalCode: zip[1] }

  const abbrev = /^(.*?)[\s,]+([A-Za-z]{2})$/.exec(head)
  if (abbrev && !/\d$/.test(abbrev[1])) {
    return {
      city: abbrev[1].replace(/[\s,.]+$/, ''),
      region: abbrev[2].toUpperCase(),
      postalCode: zip[1]
    }
  }

  const low = head.toLowerCase()
  for (const name of STATE_NAMES) {
    if (!low.endsWith(name)) continue
    const cut = head.length - name.length
    if (cut > 0 && /[A-Za-z]/.test(head[cut - 1])) continue
    return {
      city: head.slice(0, cut).replace(/[\s,.]+$/, ''),
      region: US_STATES[name],
      postalCode: zip[1]
    }
  }

  // A ZIP with no state in front of it. Real — plenty of these rows put the
  // state on the line above — so the ZIP is kept and the rest stays as city.
  return { city: head, region: null, postalCode: zip[1] }
}

// ---------------------------------------------------------------------------
// Rows → contacts
// ---------------------------------------------------------------------------

export interface ParsedContact {
  /** 1-based row number in the source sheet, so a warning can name it. */
  row: number
  /** The QuickBooks display name, verbatim. The buyer is stored under this. */
  name: string
  person: string | null
  code: string | null
  company: string | null
  email: string | null
  phone: string | null
  mobile: string | null
  billAddr: InvoiceAddress | null
  /** Recognised but unstorable detail, and anything parsed with a caveat. */
  warnings: string[]
}

export interface SkippedRow {
  row: number
  /** What the row said, short enough to find it by. Empty when there was nothing. */
  label: string
  reason: string
}

export interface ParsedContactSheet {
  contacts: ParsedContact[]
  skipped: SkippedRow[]
  /** Non-empty when the sheet could not be read at all. Nothing is imported then. */
  error: string | null
  /** Rows below the header, whatever became of them. */
  rowsSeen: number
}

/**
 * The whole sheet, in one pure pass.
 *
 * Takes a grid rather than a file or a path so it can be tested with a literal —
 * which is what makes it possible to have a real test suite for a parser whose
 * only real input is 360 rows of somebody's customers that must never be
 * committed. tests/contacts.test.ts calls this with invented names.
 */
export function parseContactSheet(grid: string[][]): ParsedContactSheet {
  const header = findHeaderRow(grid)
  if (!header) {
    return {
      contacts: [],
      skipped: [],
      rowsSeen: 0,
      error:
        'No header row was found. Export the Customer Contact List from QuickBooks with its ' +
        'column titles — the importer looks for a row naming the customer, phone, email and address columns.'
    }
  }

  const cols = header.columns
  const contacts: ParsedContact[] = []
  const skipped: SkippedRow[] = []
  const seenNames = new Map<string, number>()
  let rowsSeen = 0

  for (let i = header.index + 1; i < grid.length; i++) {
    const cells = grid[i]
    const rowNumber = i + 1
    const at = (field: ContactField): string => {
      const index = cols[field]
      return index === undefined ? '' : (cells[index] ?? '')
    }
    if (cells.every((c) => collapse(c) === '')) continue
    rowsSeen++

    const split = splitDisplayName(at('name') || at('fullName'))
    if (!split.displayName) {
      skipped.push({ row: rowNumber, label: '', reason: 'no customer name in the row' })
      continue
    }

    const phones = splitPhones(at('phones'))
    const emails = splitEmails(at('email'))
    const bill = parsePostalAddress(at('billAddr'))
    const ship = parsePostalAddress(at('shipAddr'))

    // A name with nothing beside it is not a contact. This is also, precisely,
    // what catches the print timestamp QuickBooks puts on the last row of every
    // report — one cell holding a date and five empty ones — without this file
    // having to know anything about how that stamp is formatted.
    const hasDetail = !!(
      emails.email ||
      phones.phone ||
      phones.mobile ||
      phones.other.length ||
      bill.address ||
      ship.address
    )
    if (!hasDetail) {
      skipped.push({
        row: rowNumber,
        label: split.displayName,
        reason: 'no email, phone or address — nothing to import'
      })
      continue
    }

    // Case-insensitive, because that is how the buyer table matches names, and a
    // sheet that lists somebody twice under two capitalisations must not import
    // as one added row and one immediate overwrite of it.
    const key = split.displayName.toLowerCase()
    const earlier = seenNames.get(key)
    if (earlier !== undefined) {
      skipped.push({
        row: rowNumber,
        label: split.displayName,
        reason: `the same name is already on row ${earlier}`
      })
      continue
    }
    seenNames.set(key, rowNumber)

    const warnings = [...bill.warnings]
    if (emails.extras.length) {
      warnings.push(
        `${emails.extras.length} extra email ${emails.extras.length === 1 ? 'address was' : 'addresses were'} in the cell and ${emails.extras.length === 1 ? 'was' : 'were'} not imported`
      )
    }
    if (emails.rejected.length && !emails.email) {
      warnings.push('the email cell did not contain an address, so no email was imported')
    }
    for (const other of phones.other) warnings.push(`not imported: ${other}`)

    // The ship address is read but never stored: this table has one address, the
    // bill-to. It is used only when the bill-to is missing, which beats leaving a
    // buyer with no address at all because the export happened to fill in the
    // other column.
    let billAddr = bill.address
    if (!billAddr && ship.address) {
      billAddr = ship.address
      warnings.push('there was no billing address, so the shipping address was used')
    }

    contacts.push({
      row: rowNumber,
      name: split.displayName,
      person: split.person,
      code: split.code,
      company: split.company || collapse(at('company')) || null,
      email: emails.email,
      phone: phones.phone,
      mobile: phones.mobile,
      billAddr,
      warnings
    })
  }

  return { contacts, skipped, rowsSeen, error: null }
}

// ---------------------------------------------------------------------------
// What the import did
// ---------------------------------------------------------------------------

export interface ContactImportResult {
  /** The file the operator chose, for the toast and for the record. */
  source: string
  rowsSeen: number
  added: number
  updated: number
  /** Matched a buyer who already had exactly this. Not an error; not a write. */
  unchanged: number
  skipped: SkippedRow[]
  notes: Array<{ row: number; name: string; note: string }>
}

export function emptyImportResult(source = ''): ContactImportResult {
  return { source, rowsSeen: 0, added: 0, updated: 0, unchanged: 0, skipped: [], notes: [] }
}

/** One line for a toast: what happened, without the detail. */
export function summarizeImport(r: ContactImportResult): string {
  const parts: string[] = []
  if (r.added) parts.push(`${r.added} added`)
  if (r.updated) parts.push(`${r.updated} updated`)
  if (r.unchanged) parts.push(`${r.unchanged} already up to date`)
  if (r.skipped.length) parts.push(`${r.skipped.length} skipped`)
  return parts.length ? parts.join(', ') + '.' : 'Nothing to import.'
}
