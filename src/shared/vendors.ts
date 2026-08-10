import type { InvoiceAddress } from './invoices'
import { collapse, parsePostalAddress, US_STATES, type SkippedRow } from './contacts'

/**
 * The owner's vendor list, turned into contact records.
 *
 * ## Why this is a runtime importer and not a seed
 *
 * The same reason @shared/contacts is one, and it is worth writing twice. The
 * owner's list is ~151 real businesses with street addresses. THIS REPOSITORY IS
 * PUBLIC. So there is no fixture, no seed migration and no sample file anywhere
 * in the tree — the operator picks the sheet off their own disk, it is parsed
 * here, and the rows land in their local database and travel over the existing
 * cloud sync like anything else they type. Every value in tests/vendors.test.ts
 * is invented. If a bug ever needs a regression test, describe the SHAPE that
 * broke and invent a row with it; do not paste the row that found it.
 *
 * ## What the sheet actually looks like
 *
 * Unlike the QuickBooks customer export this one is a genuine TABLE — a header
 * on the first row, one vendor per row after it, no title block, no print
 * timestamp, no blank cells at all:
 *
 *   List Label | Name / Business | Street Address | City | State | ZIP | Full Address | Source Order
 *
 * and the parts are already separated, which is the whole difference from the
 * customer importer. That one gets a rendered address BLOCK and has to work out
 * where the city ends; this one is handed a City column. So the rule that file
 * spends two hundred lines on — never guess where a city stops — simply does not
 * arise here, and the code is correspondingly short. Where a sheet turns out NOT
 * to have the parts, the block parser is borrowed rather than reimplemented.
 *
 * Four things about the real file drove the rules below:
 *
 *   THE LABEL IS NOT THE NAME. `List Label` is what the owner files them under —
 *     sometimes the business name, more often a shorthand, sometimes carrying a
 *     bracketed code. It is a second fact, not a second copy, so it is kept.
 *
 *   THE CODE LIVES IN THE NAME. Around a third of the names carry a bracketed
 *     filing code. It is stored as part of the name, verbatim, exactly as the
 *     customer importer stores the QuickBooks display name verbatim — because
 *     the name is the key that has to match what somebody types on a purchase
 *     order, and a name this app quietly rewrote would stop matching.
 *
 *   `Full Address` IS REDUNDANT — and that makes it a CHECKSUM. It is the other
 *     four columns concatenated. So when both are present they are compared, and
 *     a disagreement is flagged: it means somebody edited one and not the other,
 *     which is invisible in a spreadsheet and is the only way this sheet can be
 *     internally wrong.
 *
 *   ZIPS ARE ZIP+4. Almost every one. Both forms are accepted and neither is
 *     rewritten — see the note on the four-digit case, which is the one place
 *     this file repairs rather than reports.
 *
 * ## The rule that governs the whole file: never guess, never drop
 *
 * A row that cannot be fully parsed is still IMPORTED, and carries a warning
 * naming what could not be filed. That is stricter than the customer importer,
 * which drops a row with a name and nothing else — and deliberately so. A buyer
 * with no way to reach them is a row with nothing in it; a VENDOR with no
 * address is still an answer to "who can we buy from", which is the question
 * this directory exists to answer.
 */

// ---------------------------------------------------------------------------
// Grid → columns
// ---------------------------------------------------------------------------

type VendorField = 'name' | 'label' | 'street' | 'city' | 'state' | 'zip' | 'full'

/**
 * Which header means which field, in resolution order.
 *
 * ORDER IS THE WHOLE POINT, the same way it is in @shared/contacts, and there
 * are two collisions in this sheet alone:
 *
 *   `full` BEFORE `street`. "Full Address" and "Street Address" both contain
 *     "address". Test street first and the redundant concatenation is imported
 *     as the street line, so every vendor's address line reads "12 Elm St,
 *     Marchwood IL 60455" and the city column is filled in twice.
 *
 *   `label` BEFORE `name`. A sheet that calls the column "Vendor Label" contains
 *     "vendor", which is a name matcher. Testing name first would claim the
 *     label column as the vendor's name, and every record would import under a
 *     filing shorthand instead of the business name a purchase order says.
 */
const HEADER_MATCHERS: Array<{ field: VendorField; test: (h: string) => boolean }> = [
  { field: 'full', test: (h) => h.includes('full') && h.includes('address') },
  { field: 'street', test: (h) => h.includes('street') || h.includes('address') },
  { field: 'city', test: (h) => h.includes('city') || h.includes('town') },
  { field: 'state', test: (h) => h.includes('state') || h.includes('province') },
  { field: 'zip', test: (h) => h.includes('zip') || h.includes('postal') || h.includes('post code') },
  { field: 'label', test: (h) => h.includes('label') },
  {
    field: 'name',
    test: (h) =>
      h.includes('name') ||
      h.includes('business') ||
      h.includes('vendor') ||
      h.includes('supplier') ||
      h.includes('company')
  }
]

function normalizeHeader(cell: string): string {
  return cell.replace(/[*:]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

export type VendorColumnMap = Partial<Record<VendorField, number>>

/** Resolve one row of headers to column indexes. Each field is claimed once. */
export function mapVendorColumns(header: string[]): VendorColumnMap {
  const map: VendorColumnMap = {}
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
  return map
}

/** The fields that make a row an ADDRESS rather than a bare list of names. */
const ADDRESS_FIELDS: VendorField[] = ['street', 'city', 'state', 'zip', 'full']

/**
 * Find the header row.
 *
 * A name column AND at least one address column, because a single-field match
 * is how a title or a stray note above the table gets mistaken for the header —
 * the failure @shared/contacts documents at length and which costs the same here
 * (the real header becomes the first vendor, and every column is off by a row).
 *
 * Scanned from the top and the FIRST qualifying row wins, so a data row that
 * happens to look header-ish can never outrank the real header above it.
 */
export function findVendorHeaderRow(
  grid: string[][]
): { index: number; columns: VendorColumnMap } | null {
  const limit = Math.min(grid.length, 25)
  for (let i = 0; i < limit; i++) {
    const columns = mapVendorColumns(grid[i])
    if (columns.name === undefined) continue
    if (ADDRESS_FIELDS.some((f) => columns[f] !== undefined)) return { index: i, columns }
  }
  return null
}

// ---------------------------------------------------------------------------
// State and ZIP
// ---------------------------------------------------------------------------

/**
 * A State cell → the two-letter code Intuit wants, or null.
 *
 * UPPER-CASED because CountrySubDivisionCode is upper case and Intuit rejects
 * "Mi" — the same rule and the same reason as parsePostalAddress. A spelled-out
 * state is looked up in the closed table that file already owns; anything else
 * returns null and the caller warns, because a region column this app cannot
 * recognise is a fact about the sheet, not something to invent a code for.
 */
export function parseStateCell(raw: string): string | null {
  const text = collapse(raw)
  if (!text) return null
  if (/^[A-Za-z]{2}$/.test(text)) return text.toUpperCase()
  return US_STATES[text.toLowerCase()] ?? null
}

export interface ParsedZip {
  postalCode: string | null
  warning: string | null
}

/**
 * A ZIP cell → a ZIP, and the one place in this file that REPAIRS rather than reports.
 *
 * Five digits or ZIP+4 pass through untouched — a postal code is a string
 * somebody writes on a parcel, not a quantity, and reformatting it is how
 * "60455-9021" becomes "60455" and a parcel goes to the wrong walk.
 *
 * The repair is for three and four digits. Excel stores a ZIP-looking cell as a
 * NUMBER unless it is explicitly text, and a number cannot carry a leading zero:
 * every Massachusetts, New Jersey, Puerto Rico and northern-New-England ZIP
 * comes back one or two characters short of itself the moment somebody re-saves
 * this sheet. There is no such thing as a four-digit ZIP, so padding is not a
 * guess about which place is meant — it is putting back a character the
 * spreadsheet destroyed. It still WARNS, because the operator should know their
 * export is lossy and fix the column format rather than rely on this.
 *
 * Anything else is kept exactly as written and flagged. An overseas postcode, a
 * ZIP with a note beside it — refusing to store it would lose the only thing the
 * sheet knew, and rewriting it would make it wrong.
 */
export function parseZipCell(raw: string): ParsedZip {
  const text = collapse(raw)
  if (!text) return { postalCode: null, warning: null }
  if (/^\d{5}(-\d{4})?$/.test(text)) return { postalCode: text, warning: null }
  if (/^\d{3,4}$/.test(text)) {
    const padded = text.padStart(5, '0')
    return {
      postalCode: padded,
      warning: `the ZIP was ${text.length} digits — a spreadsheet drops the leading zero on a numeric cell, so it was read as ${padded}`
    }
  }
  return {
    postalCode: text,
    warning: `the ZIP "${text}" is not five digits or ZIP+4, so it was kept exactly as written`
  }
}

// ---------------------------------------------------------------------------
// Rows → vendors
// ---------------------------------------------------------------------------

export interface ParsedVendor {
  /** 1-based row number in the source sheet, so a warning can name it. */
  row: number
  /** The business name, verbatim. The vendor is stored and matched under this. */
  name: string
  /** The owner's filing label, when it says something the name does not. */
  label: string | null
  /** Null when the row carried no address at all — which is imported, and flagged. */
  address: InvoiceAddress | null
  /** Sentences for the operator. Empty means every part of the row was filed. */
  warnings: string[]
}

export interface ParsedVendorSheet {
  vendors: ParsedVendor[]
  skipped: SkippedRow[]
  /** Non-empty when the sheet could not be read at all. Nothing is imported then. */
  error: string | null
  /** Rows below the header, whatever became of them. */
  rowsSeen: number
}

/**
 * The whole sheet, in one pure pass.
 *
 * Takes a grid rather than a file or a path for the same reason parseContactSheet
 * does: it is what makes a real test suite possible for a parser whose only real
 * input is 151 of somebody's suppliers that must never be committed.
 */
export function parseVendorSheet(grid: string[][]): ParsedVendorSheet {
  const header = findVendorHeaderRow(grid)
  if (!header) {
    return {
      vendors: [],
      skipped: [],
      rowsSeen: 0,
      error:
        'No header row was found. The vendor sheet needs column titles — the importer looks for a ' +
        'row naming the vendor and at least one of its street, city, state, ZIP or full address.'
    }
  }

  const cols = header.columns
  const vendors: ParsedVendor[] = []
  const skipped: SkippedRow[] = []
  const seenNames = new Map<string, { row: number; full: string }>()
  let rowsSeen = 0

  for (let i = header.index + 1; i < grid.length; i++) {
    const cells = grid[i]
    const rowNumber = i + 1
    const at = (field: VendorField): string => {
      const index = cols[field]
      return index === undefined ? '' : (cells[index] ?? '')
    }
    if (cells.every((c) => collapse(c) === '')) continue
    rowsSeen++

    const name = collapse(at('name'))
    if (!name) {
      skipped.push({ row: rowNumber, label: collapse(at('label')), reason: 'no vendor name in the row' })
      continue
    }

    const warnings: string[] = []

    // A name with an unclosed bracket. Nothing downstream depends on the code
    // inside the brackets — the name is stored whole — so this cannot corrupt
    // anything, but it is a typo in the source sheet that only ever shows up as
    // a slightly odd-looking name, and the operator is the only one who can fix
    // it at source.
    const opens = (name.match(/\(/g) ?? []).length
    const closes = (name.match(/\)/g) ?? []).length
    if (opens !== closes) {
      warnings.push('the name has an unclosed bracket — it was imported exactly as written')
    }

    const { address, warnings: addressWarnings } = readAddress(
      at('street'),
      at('city'),
      at('state'),
      at('zip'),
      at('full')
    )
    warnings.push(...addressWarnings)

    // Case-insensitive, because that is the key the contact table matches on. A
    // sheet listing the same shop twice must not import as one added row and one
    // immediate overwrite of it — which looks like a successful import and quietly
    // keeps only whichever copy happened to be last.
    //
    // Whether the two copies AGREE is the useful part of the message: two
    // identical rows are a harmless duplicate somebody can delete, while two rows
    // under one name with different addresses mean one of the two businesses is
    // about to be unreachable, and only a person can say which.
    const key = name.toLowerCase()
    const earlier = seenNames.get(key)
    const fullText = collapse(at('full')) || addressText(address)
    if (earlier !== undefined) {
      skipped.push({
        row: rowNumber,
        label: name,
        reason:
          earlier.full === fullText
            ? `the same name and address are already on row ${earlier.row}`
            : `the same name is already on row ${earlier.row}, with a DIFFERENT address — only the first was imported`
      })
      continue
    }
    seenNames.set(key, { row: rowNumber, full: fullText })

    // A label that merely repeats the name is not a second fact, and storing it
    // would print every vendor's name twice on the one screen that lists them.
    const rawLabel = collapse(at('label'))
    const label = rawLabel && rawLabel.toLowerCase() !== key ? rawLabel : null

    vendors.push({ row: rowNumber, name, label, address, warnings })
  }

  return { vendors, skipped, rowsSeen, error: null }
}

/** The address as one comparable string, for the duplicate message above. */
function addressText(a: InvoiceAddress | null): string {
  if (!a) return ''
  return [a.line1, a.line2, a.city, a.region, a.postalCode, a.country].filter(Boolean).join(', ')
}

interface ReadAddress {
  address: InvoiceAddress | null
  warnings: string[]
}

/**
 * The address columns → the six fields the contact table stores.
 *
 * ## The parts win over the concatenation, and the concatenation audits them
 *
 * When both are present the parts are used, because they are already separated
 * and the concatenation is not — using it would throw away the split this sheet
 * hands over for free and then try to recover it with a heuristic.
 *
 * What the concatenation is good for is CHECKING. It is the only redundancy in
 * the sheet, so a part that does not appear inside it means somebody corrected
 * one and not the other. That is undetectable by eye in a spreadsheet with 151
 * rows and eight columns, and it is exactly the state in which an address looks
 * fine on screen and is wrong on a parcel. Containment rather than exact
 * reassembly, deliberately: where the commas go is a formatting choice, but a
 * missing city is a disagreement about a fact.
 *
 * ## When there are no parts, the block parser is borrowed
 *
 * A hand-made sheet with only a "Full Address" column is the obvious way this
 * gets re-exported, and @shared/contacts already knows how to take an address
 * block apart AND how to refuse to guess when it cannot. Reimplementing that
 * here would give this app two answers to "where does the city stop".
 *
 * ## Country stays null
 *
 * The sheet has no country column, and every state in it is a US state code, so
 * "United States" would be a true inference — and filing it anyway would make
 * every imported vendor's address compare UNEQUAL to the same address typed by
 * hand or brought in by the customer importer, both of which leave a domestic
 * country null. That is not cosmetic: the import writes only when something
 * changed, so a country nobody else stores would make every vendor look changed
 * on every re-import and push all 151 rows to every other machine.
 */
function readAddress(
  street: string,
  city: string,
  state: string,
  zip: string,
  full: string
): ReadAddress {
  const warnings: string[] = []
  const streetText = collapse(street)
  const cityText = collapse(city)
  const stateText = collapse(state)
  const zipText = collapse(zip)
  const fullText = collapse(full)
  const parts = [streetText, cityText, stateText, zipText].filter((p) => p !== '')

  if (parts.length === 0) {
    if (!fullText) {
      warnings.push('the row had no address — the vendor was imported without one')
      return { address: null, warnings }
    }
    const block = parsePostalAddress(fullText)
    return { address: block.address, warnings: block.warnings }
  }

  // A "street" cell holding a whole rendered block rather than one line. It
  // happens when a sheet is really a contact export wearing a vendor sheet's
  // headers, and stored as-is it would put three lines of address into the one
  // field that prints on an invoice's first line.
  if (/[\r\n]/.test(street)) {
    const block = parsePostalAddress(street)
    const blank: InvoiceAddress = {
      line1: null,
      line2: null,
      city: null,
      region: null,
      postalCode: null,
      country: null
    }
    const merged: InvoiceAddress = {
      ...(block.address ?? blank),
      // The block's own answer wins where it found one — it read the line the
      // city was actually written on. The separate columns only fill the gaps.
      city: block.address?.city || cityText || null,
      region: block.address?.region || parseStateCell(stateText),
      postalCode: block.address?.postalCode || parseZipCell(zipText).postalCode
    }
    warnings.push(
      'the street column held a whole address block, so it was taken apart rather than stored as one line'
    )
    warnings.push(...block.warnings)
    return { address: merged, warnings }
  }

  const region = parseStateCell(stateText)
  if (stateText && !region) {
    warnings.push(`the state "${stateText}" was not recognised, so no state was filed`)
  }
  const zipResult = parseZipCell(zipText)
  if (zipResult.warning) warnings.push(zipResult.warning)

  if (fullText) {
    const haystack = fullText.toLowerCase()
    const missing = parts.filter((p) => !haystack.includes(p.toLowerCase()))
    if (missing.length > 0) {
      warnings.push(
        'the Full Address column does not contain every other column — one of them has been edited ' +
          'and the other has not. The separate columns were used.'
      )
    }
  }

  return {
    address: {
      line1: streetText || null,
      // One street line in, one street line out. This sheet has no second line
      // and inventing one from the first is how a suite number moves.
      line2: null,
      city: cityText || null,
      region,
      postalCode: zipResult.postalCode,
      country: null
    },
    warnings
  }
}
