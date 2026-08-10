import { parseContactSheet, type ContactImportResult } from '@shared/contacts'
import { importContacts } from './db/contactImport'
import { gridFromFile } from './importFile'

/**
 * File bytes to imported buyers: the three steps, in order, and nothing else.
 *
 * Deliberately thin. The shape rules are in @shared/contacts where they can be
 * tested against a literal grid, the writes are in db/contactImport.ts, the
 * choice of reader is in importFile.ts (which the vendor importer shares), and
 * this is only the seam that puts the three together.
 */
export function importContactFile(bytes: Buffer, filename: string): ContactImportResult {
  const sheet = parseContactSheet(gridFromFile(bytes))
  if (sheet.error) throw new Error(sheet.error)
  return importContacts(sheet, filename || 'contact list')
}
