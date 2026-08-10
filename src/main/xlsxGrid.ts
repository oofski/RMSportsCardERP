import { inflateRawSync } from 'zlib'

/**
 * Read an .xlsx into a grid of strings, with no dependency.
 *
 * ## Why this exists rather than a library
 *
 * The alternative was pulling in a spreadsheet package to read ONE report the
 * owner exports from QuickBooks. Every dependency in this app is also a thing
 * electron-builder has to rebuild, notarise and ship to every machine, and the
 * popular xlsx readers carry a parser surface far larger than "give me the
 * cells". What is actually needed is a zip reader and two regexes, because an
 * .xlsx is a zip of XML and nothing more.
 *
 * ## What is deliberately NOT implemented
 *
 * Number formats, dates, styles, merged cells, formulas, multiple sheets. This
 * reads the first worksheet and returns what each cell says as text. A date cell
 * would come back as Excel's serial number — which is exactly why the importer
 * accepts .csv as well, and why nothing this reads is ever interpreted as a
 * number. Every field the contact importer wants is a string.
 *
 * ## The failure mode this file is careful about
 *
 * A file that is not really a spreadsheet — a .xlsx extension on a PDF, a
 * download that truncated — must produce a SENTENCE, not a stack trace out of
 * zlib. Every step below checks its signature and throws something a person can
 * act on, because the operator sees this text in a toast.
 */

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  localHeaderOffset: number
}

/**
 * Locate the end-of-central-directory record.
 *
 * Scanned BACKWARDS from the end, because the record sits at the very end of the
 * file unless there is a zip comment — and a forward scan would find the first
 * four bytes that happen to look like the signature inside somebody's compressed
 * data instead. 64KB is the furthest back it can legally be (the comment length
 * field is 16 bits).
 */
function findEndOfCentralDirectory(buf: Buffer): number {
  const earliest = Math.max(0, buf.length - 0x10000 - 22)
  for (let i = buf.length - 22; i >= earliest; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i
  }
  return -1
}

function readEntries(buf: Buffer): Map<string, ZipEntry> {
  const eocd = findEndOfCentralDirectory(buf)
  if (eocd < 0) throw new Error('That file is not a spreadsheet — it is not a zip archive at all.')

  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const entries = new Map<string, ZipEntry>()

  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break
    const method = buf.readUInt16LE(offset + 10)
    // The CENTRAL directory's sizes, never the local header's. A zip written in
    // one pass leaves the local sizes zeroed and puts the real ones in a data
    // descriptor AFTER the compressed bytes; trusting the local header there
    // reads an empty slice and the sheet comes back blank.
    const compressedSize = buf.readUInt32LE(offset + 20)
    const nameLength = buf.readUInt16LE(offset + 28)
    const extraLength = buf.readUInt16LE(offset + 30)
    const commentLength = buf.readUInt16LE(offset + 32)
    const localHeaderOffset = buf.readUInt32LE(offset + 42)
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength)
    entries.set(name, { name, method, compressedSize, localHeaderOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function readFile(buf: Buffer, entry: ZipEntry): string {
  const head = entry.localHeaderOffset
  if (head + 30 > buf.length || buf.readUInt32LE(head) !== LOCAL_SIGNATURE) {
    throw new Error(`That spreadsheet is damaged — ${entry.name} could not be located.`)
  }
  // The local header carries its OWN name and extra-field lengths, and they are
  // allowed to differ from the central directory's. Reading the central one's
  // extra length here is the classic off-by-a-few that yields garbage.
  const nameLength = buf.readUInt16LE(head + 26)
  const extraLength = buf.readUInt16LE(head + 28)
  const start = head + 30 + nameLength + extraLength
  const body = buf.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return body.toString('utf8')
  if (entry.method === 8) return inflateRawSync(body).toString('utf8')
  throw new Error(`That spreadsheet uses an unsupported compression method (${entry.method}).`)
}

// ---------------------------------------------------------------------------
// XML, to the depth this needs and no further
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
}

function decodeXml(text: string): string {
  return text.replace(/&(#x?[0-9A-Fa-f]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body] ?? whole
  })
}

/** Every <t> in a fragment, joined. Runs of formatting split one string into many. */
function textOf(fragment: string): string {
  // Phonetic guides (Japanese locales write them) sit in <rPh> as their own <t>
  // elements. Left in, every character of the reading is appended to the value
  // and the cell reads as itself twice.
  const clean = fragment.replace(/<rPh[\s\S]*?<\/rPh>/g, '')
  let out = ''
  const re = /<t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/t>)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(clean)) !== null) out += decodeXml(m[1] ?? '')
  return out
}

function sharedStrings(xml: string): string[] {
  const out: string[] = []
  const re = /<si(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/si>)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) out.push(textOf(m[1] ?? ''))
  return out
}

/** "AA7" -> 26. Column letters are base-26 with no zero. */
function columnIndex(ref: string): number {
  let n = 0
  for (const ch of ref) {
    const code = ch.charCodeAt(0)
    if (code < 65 || code > 90) break
    n = n * 26 + (code - 64)
  }
  return n - 1
}

/**
 * Which worksheet is the first one.
 *
 * The order in workbook.xml is the order of the TABS, which is what a person
 * means by "the first sheet"; the file names inside xl/worksheets are in
 * whatever order the writer felt like. So the relationship id from the workbook
 * is resolved through the rels file, and only if that fails does this fall back
 * to picking a worksheet by name.
 */
function firstSheetPath(entries: Map<string, ZipEntry>, buf: Buffer): string {
  const workbook = entries.get('xl/workbook.xml')
  const rels = entries.get('xl/_rels/workbook.xml.rels')
  if (workbook && rels) {
    const sheet = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(readFile(buf, workbook))
    if (sheet) {
      const relXml = readFile(buf, rels)
      const re = new RegExp(`<Relationship\\b[^>]*\\bId="${sheet[1]}"[^>]*>`)
      const rel = re.exec(relXml)
      const target = rel ? /\bTarget="([^"]+)"/.exec(rel[0]) : null
      if (target) {
        const path = target[1].replace(/^\/?(xl\/)?/, '')
        if (entries.has(`xl/${path}`)) return `xl/${path}`
      }
    }
  }
  const names = [...entries.keys()].filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n)).sort()
  if (names.length === 0) throw new Error('That spreadsheet has no worksheets in it.')
  return names[0]
}

/**
 * The first worksheet of an .xlsx, as rows of strings.
 *
 * Rows come back padded to their widest cell so a caller can index by column
 * without checking length, and blank cells are '' rather than missing — a report
 * whose "Full name" column is filled in on eight rows out of 360 would otherwise
 * shift every other row's columns left by one.
 */
export function xlsxToGrid(bytes: Buffer): string[][] {
  if (bytes.length < 4 || bytes.readUInt16LE(0) !== 0x4b50) {
    throw new Error('That file is not an .xlsx spreadsheet. Try exporting it again, or use CSV.')
  }
  const entries = readEntries(bytes)
  const stringsEntry = entries.get('xl/sharedStrings.xml')
  const strings = stringsEntry ? sharedStrings(readFile(bytes, stringsEntry)) : []
  const sheetEntry = entries.get(firstSheetPath(entries, bytes))
  if (!sheetEntry) throw new Error('That spreadsheet has no worksheets in it.')
  const sheet = readFile(bytes, sheetEntry)

  const grid: string[][] = []
  const rowRe = /<row\b([^>]*)(?:\/>|>([\s\S]*?)<\/row>)/g
  let rowMatch: RegExpExecArray | null
  while ((rowMatch = rowRe.exec(sheet)) !== null) {
    const declared = /\br="(\d+)"/.exec(rowMatch[1])
    // Empty rows are not written out at all, and the report puts a blank line
    // between its title and its header. Honouring r= keeps the header where the
    // file says it is instead of pulling it up a row.
    const rowIndex = declared ? parseInt(declared[1], 10) - 1 : grid.length
    const cells: string[] = []
    const cellRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g
    let cellMatch: RegExpExecArray | null
    let cursor = 0
    while ((cellMatch = cellRe.exec(rowMatch[2] ?? '')) !== null) {
      const attrs = cellMatch[1]
      const body = cellMatch[2] ?? ''
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)
      const at = ref ? columnIndex(ref[1]) : cursor
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n'
      let value = ''
      if (type === 's') {
        const index = parseInt(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '', 10)
        value = Number.isInteger(index) ? (strings[index] ?? '') : ''
      } else if (type === 'inlineStr') {
        value = textOf(body)
      } else {
        value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '')
      }
      while (cells.length < at) cells.push('')
      cells[at] = value
      cursor = at + 1
    }
    while (grid.length < rowIndex) grid.push([])
    grid[rowIndex] = cells
  }
  return grid
}
