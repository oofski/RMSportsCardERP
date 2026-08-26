import { randomUUID } from 'crypto'
import { DEFAULT_INVOICE_TERMS, hasAddress, type InvoiceAddress } from '@shared/invoices'
import { emptyImportResult, type ContactImportResult } from '@shared/contacts'
import type { ParsedVendor, ParsedVendorSheet } from '@shared/vendors'
import { getDb } from './database'

/**
 * The owner's vendor list, written into the contact table.
 *
 * The parsing lives in @shared/vendors and is pure; this is the half that
 * touches the database. It is the deliberate mirror of db/contactImport.ts, and
 * every rule it shares with that file is shared on purpose rather than by
 * copying — read that file's header for the long form of each.
 *
 * ## The stable key is the NAME, case-insensitively — the same key as everything else
 *
 * Not the filing label (two of the real rows share one), not the bracketed code
 * (a third of the rows have none), not the row number (meaningless across two
 * exports of a list somebody adds to at the top). The name, COLLATE NOCASE,
 * because that is already how saveCustomer merges, how the QuickBooks contact
 * import merges, how listSupplierSuggestions matches and how listVendors folds
 * two spellings of one distributor into one row. A fifth notion of "the same
 * business" living inside this importer would be a bug the moment it disagreed
 * with the other four.
 *
 * ## Which is also what makes a contact able to be BOTH
 *
 * A vendor whose name already exists — because they are a customer, or because
 * an earlier import filed them — does not get a second row. The existing row is
 * marked is_vendor = 1 and keeps everything else it had. That is the whole
 * mechanism: being a supplier and being a buyer are two flags on one business,
 * so a phone number corrected anywhere is corrected everywhere.
 *
 * ## An import ADDS; it does not erase
 *
 * is_customer is never touched here. A business that buys from us and appears on
 * the vendor sheet is both, and an import that cleared the customer flag would
 * remove them from the customer list — and from the sales orders picker — as a
 * side effect of being told they also sell wax.
 *
 * Nor are email, phone, terms, class, the standing message or notes touched: the
 * vendor sheet has no such columns, and a re-import must not be able to blank a
 * field it has never heard of.
 *
 * ## A row that has not changed is not written
 *
 * Re-importing the same sheet writes nothing at all. invoice_customers is a
 * synced table (see syncTables), so touching updated_at on 151 unchanged rows
 * would push all 151 to every other machine on every import, for no change
 * anybody made.
 */

interface ExistingRow {
  id: string
  name: string
  is_vendor: number
  vendor_label: string | null
  bill_line1: string | null
  bill_line2: string | null
  bill_city: string | null
  bill_region: string | null
  bill_postal_code: string | null
  bill_country: string | null
}

/** The six address columns as one value, so they can be compared as one. */
function storedAddress(r: ExistingRow): InvoiceAddress {
  return {
    line1: r.bill_line1,
    line2: r.bill_line2,
    city: r.bill_city,
    region: r.bill_region,
    postalCode: r.bill_postal_code,
    country: r.bill_country
  }
}

function same(a: string | null, b: string | null): boolean {
  return (a ?? '') === (b ?? '')
}

function sameAddress(a: InvoiceAddress, b: InvoiceAddress): boolean {
  return (
    same(a.line1, b.line1) &&
    same(a.line2, b.line2) &&
    same(a.city, b.city) &&
    same(a.region, b.region) &&
    same(a.postalCode, b.postalCode) &&
    same(a.country, b.country)
  )
}

/** Longer than the contact screen accepts. Refused rather than truncated. */
const MAX_NAME = 200

export function importVendors(sheet: ParsedVendorSheet, source: string): ContactImportResult {
  const result = emptyImportResult(source)
  result.rowsSeen = sheet.rowsSeen
  result.skipped = [...sheet.skipped]
  if (sheet.error) throw new Error(sheet.error)

  const db = getDb()
  const stamp = new Date().toISOString()

  const find = db.prepare(
    `SELECT id, name, is_vendor, vendor_label,
            bill_line1, bill_line2, bill_city, bill_region, bill_postal_code, bill_country
       FROM invoice_customers
      WHERE name = ? COLLATE NOCASE`
  )
  // is_customer 0 on a brand-new row: this business has told us nothing about
  // buying from us, and putting them on the customer list would grow it by 151
  // suppliers who have never been sold a thing. Saving one from the buyer screen
  // or importing the QuickBooks contact list sets the flag the moment it is true.
  const insert = db.prepare(
    `INSERT INTO invoice_customers
       (id, name, terms, active, is_customer, is_vendor, vendor_label, created_at, updated_at,
        bill_line1, bill_line2, bill_city, bill_region, bill_postal_code, bill_country)
     VALUES (@id, @name, @terms, 1, 0, 1, @label, @stamp, @stamp,
             @line1, @line2, @city, @region, @postalCode, @country)`
  )
  const update = db.prepare(
    `UPDATE invoice_customers
        SET is_vendor        = 1,
            vendor_label     = @label,
            bill_line1       = @line1,
            bill_line2       = @line2,
            bill_city        = @city,
            bill_region      = @region,
            bill_postal_code = @postalCode,
            bill_country     = @country,
            updated_at       = @stamp
      WHERE id = @id`
  )

  const one = (vendor: ParsedVendor): void => {
    if (vendor.name.length > MAX_NAME) {
      result.skipped.push({
        row: vendor.row,
        label: vendor.name.slice(0, 60),
        reason: `that name is ${vendor.name.length} characters — longer than a contact name may be`
      })
      return
    }
    for (const note of vendor.warnings) {
      result.notes.push({ row: vendor.row, name: vendor.name, note })
    }

    const existing = find.get(vendor.name) as ExistingRow | undefined

    if (!existing) {
      const addr = vendor.address
      insert.run({
        id: randomUUID(),
        name: vendor.name,
        label: vendor.label,
        // THE BUSINESS DEFAULT, from the one constant, not a literal.
        //
        // This wrote `'Net 30'` straight into the SQL, which put every supplier
        // the sheet created — a hundred and fifty in one import — on a term the
        // picker had already stopped offering. `termsOptionsFor` then handed
        // Net 30 back on each of those records, so retiring it from the menu
        // had almost no visible effect. See the v88 migration, which moved the
        // ones already written.
        terms: DEFAULT_INVOICE_TERMS,
        stamp,
        line1: addr?.line1 ?? null,
        line2: addr?.line2 ?? null,
        city: addr?.city ?? null,
        region: addr?.region ?? null,
        postalCode: addr?.postalCode ?? null,
        country: addr?.country ?? null
      })
      result.added++
      return
    }

    // COALESCE semantics on the label: a sheet with the column left blank must
    // not erase a label an earlier import brought in.
    const label = vendor.label ?? existing.vendor_label
    // The address moves as a WHOLE or not at all, the same rule saveCustomer and
    // the contact import both state: six independent fallbacks would graft a new
    // street onto an old city the first time a sheet omitted one, producing an
    // address that was never anybody's.
    const address =
      vendor.address && hasAddress(vendor.address) ? vendor.address : storedAddress(existing)

    const unchanged =
      existing.is_vendor === 1 &&
      same(label, existing.vendor_label) &&
      sameAddress(address, storedAddress(existing))

    if (unchanged) {
      result.unchanged++
      return
    }

    update.run({
      id: existing.id,
      label,
      stamp,
      line1: address.line1,
      line2: address.line2,
      city: address.city,
      region: address.region,
      postalCode: address.postalCode,
      country: address.country
    })
    result.updated++
  }

  // One transaction for the whole sheet. A crash or a constraint failure halfway
  // through 151 rows must leave the contact list exactly as it was, not half
  // imported with no way to tell which half.
  db.transaction(() => {
    for (const vendor of sheet.vendors) one(vendor)
  })()

  return result
}
