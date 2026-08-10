import { randomUUID } from 'crypto'
import { hasAddress, type InvoiceAddress } from '@shared/invoices'
import {
  emptyImportResult,
  phoneDigits,
  type ContactImportResult,
  type ParsedContact,
  type ParsedContactSheet
} from '@shared/contacts'
import { getDb } from './database'

/**
 * The QuickBooks Customer Contact List, written into the buyer table.
 *
 * The parsing lives in @shared/contacts and is pure; this is the half that
 * touches the database, and everything interesting about it is a decision about
 * what an import is allowed to overwrite.
 *
 * ## The stable key is the QuickBooks DISPLAY NAME, case-insensitively
 *
 * Re-running the import has to update rather than duplicate, so it needs a key
 * that means "the same customer" across two exports. Of the four candidates in
 * the file, three are unusable and one is not:
 *
 *   the code in brackets   NOT UNIQUE. The real export has two different
 *     customers filed under the same code, and 41 rows carry no code at all.
 *     Keying on it would silently merge two businesses into one buyer.
 *
 *   the email             NOT UNIQUE either — two addresses repeat across
 *     different customers — and seven rows have none.
 *
 *   the row number        Meaningless across exports: one customer added at the
 *     top shifts every row below it, and the next import rewrites all 360.
 *
 *   the display name      Unique by construction. QuickBooks REFUSES to create
 *     two customers with the same display name, which is why every invoice in
 *     this app already has to match one exactly, and why saveCustomer has
 *     always merged on it. 360 rows, 360 distinct names.
 *
 * So: name, COLLATE NOCASE, which is the same key and the same collation the
 * buyer screen already uses. A second notion of "same buyer" living inside the
 * importer would be a bug the moment the two disagreed.
 *
 * ## An import ADDS; it does not erase
 *
 * Every field merges with COALESCE semantics: a blank cell leaves whatever is
 * stored. That is not politeness, it is the difference between a re-import and a
 * data loss. The operator types things into this app that QuickBooks has never
 * heard of — terms, a class, a standing message, an internal note — and a
 * spreadsheet that does not have those columns must not be able to blank them by
 * being imported twice.
 *
 * ## A row that has not changed is not written
 *
 * Re-importing the same file writes nothing at all. This matters because
 * invoice_customers is a synced table (see syncTables): touching updated_at on
 * 360 unchanged rows would push all 360 to every other machine on every import,
 * for no change anybody made.
 */

interface ExistingRow {
  id: string
  name: string
  is_customer: number
  email: string | null
  phone: string | null
  mobile: string | null
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

/**
 * Drop a mobile number that is the same number as the phone.
 *
 * Compared on DIGITS, because "(555) 010-1234" and "555-010-1234" are one
 * number written two ways and a string comparison would call them different.
 * On a real export the two columns agree on all but a handful of rows — the
 * operator typed one number and QuickBooks filled in both fields — so keeping
 * the copy would put the same digits in two columns for nine buyers in ten, and
 * every screen that showed them would then have to work out that they are one
 * number.
 */
function distinctMobile(phone: string | null, mobile: string | null): string | null {
  if (!mobile) return null
  if (phone && phoneDigits(phone) === phoneDigits(mobile)) return null
  return mobile
}

/** Longer than the buyer screen accepts. Refused rather than truncated. */
const MAX_NAME = 200

export function importContacts(sheet: ParsedContactSheet, source: string): ContactImportResult {
  const result = emptyImportResult(source)
  result.rowsSeen = sheet.rowsSeen
  result.skipped = [...sheet.skipped]
  if (sheet.error) throw new Error(sheet.error)

  const db = getDb()
  const stamp = new Date().toISOString()

  const find = db.prepare(
    `SELECT id, name, is_customer, email, phone, mobile,
            bill_line1, bill_line2, bill_city, bill_region, bill_postal_code, bill_country
       FROM invoice_customers
      WHERE name = ? COLLATE NOCASE`
  )
  // is_customer is stated rather than left to the column default, because since
  // v62 this table also holds the vendor directory and the default is only right
  // for a row nobody has classified. A business already on file as a VENDOR that
  // now turns up on the QuickBooks customer export is both, and the update below
  // says so — otherwise it would be imported successfully and still not appear on
  // the customer list, which looks exactly like the import having skipped it.
  const insert = db.prepare(
    `INSERT INTO invoice_customers
       (id, name, email, phone, mobile, terms, active, is_customer, created_at, updated_at,
        bill_line1, bill_line2, bill_city, bill_region, bill_postal_code, bill_country)
     VALUES (@id, @name, @email, @phone, @mobile, 'Net 30', 1, 1, @stamp, @stamp,
             @line1, @line2, @city, @region, @postalCode, @country)`
  )
  const update = db.prepare(
    `UPDATE invoice_customers
        SET is_customer      = 1,
            email            = @email,
            phone            = @phone,
            mobile           = @mobile,
            bill_line1       = @line1,
            bill_line2       = @line2,
            bill_city        = @city,
            bill_region      = @region,
            bill_postal_code = @postalCode,
            bill_country     = @country,
            updated_at       = @stamp
      WHERE id = @id`
  )

  const one = (contact: ParsedContact): void => {
    if (contact.name.length > MAX_NAME) {
      result.skipped.push({
        row: contact.row,
        label: contact.name.slice(0, 60),
        reason: `that name is ${contact.name.length} characters — longer than a buyer name may be`
      })
      return
    }
    for (const note of contact.warnings) {
      result.notes.push({ row: contact.row, name: contact.name, note })
    }

    const existing = find.get(contact.name) as ExistingRow | undefined
    const phone = contact.phone ?? contact.mobile ?? null
    const mobile = distinctMobile(phone, contact.mobile)

    if (!existing) {
      const addr = contact.billAddr
      insert.run({
        id: randomUUID(),
        name: contact.name,
        email: contact.email,
        phone,
        mobile,
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

    const merged = {
      email: contact.email ?? existing.email,
      phone: phone ?? existing.phone,
      mobile: mobile ?? existing.mobile
    }
    // The address moves as a WHOLE or not at all, the same rule saveCustomer
    // states: six independent fallbacks would graft a new street onto an old
    // city the first time an export omitted one, producing an address that was
    // never anybody's.
    const address =
      contact.billAddr && hasAddress(contact.billAddr)
        ? contact.billAddr
        : storedAddress(existing)

    const unchanged =
      existing.is_customer === 1 &&
      same(merged.email, existing.email) &&
      same(merged.phone, existing.phone) &&
      same(merged.mobile, existing.mobile) &&
      sameAddress(address, storedAddress(existing))

    if (unchanged) {
      result.unchanged++
      return
    }

    update.run({
      id: existing.id,
      email: merged.email,
      phone: merged.phone,
      mobile: merged.mobile,
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

  // One transaction for the whole file. A crash or a constraint failure halfway
  // through 360 rows must leave the buyer list exactly as it was, not half
  // imported with no way to tell which half.
  db.transaction(() => {
    for (const contact of sheet.contacts) one(contact)
  })()

  return result
}
