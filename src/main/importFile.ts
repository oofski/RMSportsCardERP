import { parseDelimitedGrid } from '@shared/contacts'
import { xlsxToGrid } from './xlsxGrid'

/**
 * File bytes → a grid of cells, for every list the operator imports off disk.
 *
 * One function rather than one per importer, because everything below is about
 * the CONTAINER and nothing about what is inside it — and the two places that
 * got this wrong would get it wrong identically.
 *
 * ## Why .csv is supported at all
 *
 * Because a spreadsheet that will not parse is the failure this has to survive.
 * The .xlsx reader is a few hundred lines of zip and regex; the moment a
 * spreadsheet writer changes something it could stop working — at which point
 * the operator opens the file, saves it as CSV, and the import still runs. It is
 * the same list either way; only the container changes. A single supported
 * format would make one bad export a dead end.
 */
export function gridFromFile(bytes: Buffer): string[][] {
  return looksLikeZip(bytes) ? xlsxToGrid(bytes) : parseDelimitedGrid(decodeText(bytes))
}

/**
 * The bytes decide, not the extension.
 *
 * "PK" is the zip magic every .xlsx starts with. Trusting the name instead is
 * how a CSV somebody renamed to .xlsx reaches the zip reader and comes back as
 * "not a zip archive" — a true sentence about a file that would have imported
 * perfectly. The extension is a hint from a human; the first two bytes are a
 * fact.
 */
function looksLikeZip(bytes: Buffer): boolean {
  return bytes.length > 2 && bytes[0] === 0x50 && bytes[1] === 0x4b
}

/**
 * Decode a text export, including the UTF-16 one Excel calls "Unicode Text".
 *
 * Excel on Windows will happily write UTF-16LE with a byte-order mark, and
 * reading that as UTF-8 yields a string with a NUL between every character —
 * which parses without throwing, matches no header, and reports "no header row"
 * about a file that is perfectly good. Two bytes of sniffing turns a baffling
 * refusal into an import.
 */
function decodeText(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.toString('utf16le')
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // Big-endian: swap the pairs, because Node has no utf16be decoder.
    const swapped = Buffer.from(bytes)
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  return bytes.toString('utf8')
}
