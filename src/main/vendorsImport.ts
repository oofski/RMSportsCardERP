import type { ContactImportResult } from '@shared/contacts'
import { parseVendorSheet } from '@shared/vendors'
import { importVendors } from './db/vendorImport'
import { gridFromFile } from './importFile'

/**
 * File bytes to imported vendors: the three steps, in order, and nothing else.
 *
 * The mirror of contactsImport.ts, and thin for the same reason: the shape rules
 * are in @shared/vendors where they can be tested against a literal grid, the
 * writes are in db/vendorImport.ts, and the container is worked out in
 * importFile.ts — the same code path the customer list takes, so a CSV that
 * imports as customers cannot fail to import as vendors for a reason that has
 * nothing to do with vendors.
 */
export function importVendorFile(bytes: Buffer, filename: string): ContactImportResult {
  const sheet = parseVendorSheet(gridFromFile(bytes))
  if (sheet.error) throw new Error(sheet.error)
  return importVendors(sheet, filename || 'vendor list')
}
