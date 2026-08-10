/**
 * The QuickBooks Customer Contact List importer.
 *
 * ## EVERY NAME, NUMBER AND ADDRESS BELOW IS INVENTED
 *
 * The real export is ~360 of the owner's actual customers, and this repository
 * is PUBLIC. Not one row of it is here, in any form. The shapes are real — they
 * were measured against the file on the owner's machine and written down as
 * rules — but every value is made up, the phone numbers are all in the 555
 * range reserved for fiction, and the addresses are not places. If a bug ever
 * needs a regression test, describe the SHAPE that broke and invent a row with
 * it; do not paste the row that found it.
 *
 * ## What is pinned here, and how each one fails
 *
 *   1. THE REPORT'S FURNITURE IS NOT DATA. Two title rows, a blank, then the
 *      header, and a print timestamp at the bottom. Treat the title as the
 *      header and every buyer imports into the wrong column; treat the
 *      timestamp as a customer and the buyer list grows a new junk row on every
 *      single import.
 *
 *   2. THE DISPLAY NAME IS THE KEY. It is what QuickBooks matches an invoice
 *      on, it is unique there, and it is the only field in the export that is.
 *      Re-importing must find the same buyer and update them; a second import
 *      that duplicated 360 rows would be discovered a week later with invoices
 *      already attached to both copies.
 *
 *   3. AN IMPORT ADDS, IT DOES NOT ERASE. Terms, class, notes and a standing
 *      message are typed in this app and are in no spreadsheet. A re-import
 *      that blanked them would destroy work with no undo.
 *
 *   4. NOTHING IS GUESSED. An address this parser cannot take apart is stored
 *      verbatim and reported, never split on a hunch. A wrong city looks right
 *      on screen and is expensive in the post.
 *
 * Run: npm run test:contacts
 */
import { mkdirSync, rmSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/contacts-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const {
  findHeaderRow,
  mapColumns,
  parseContactSheet,
  parseDelimitedGrid,
  parsePostalAddress,
  phoneDigits,
  splitDisplayName,
  splitEmails,
  splitPhones,
  summarizeImport
} = require('../src/shared/contacts')
const { xlsxToGrid } = require('../src/main/xlsxGrid')
const { importContactFile } = require('../src/main/contactsImport')
const repo = require('../src/main/db/invoices')
const { getDb } = require('../src/main/db/database')
const db = getDb()

let pass = 0
let fail = 0
const ok = (c: boolean, n: string, e = ''): void => {
  if (c) {
    pass++
    console.log('  ok   ' + n)
  } else {
    fail++
    console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`)
  }
}

// ---------------------------------------------------------------------------
console.log('=== 1. the report is not a table ===')
// ---------------------------------------------------------------------------
const HEADER = [
  'Customer full name',
  'Phone numbers',
  'Email',
  'Full name',
  'Bill address',
  'Ship address'
]

/** The furniture QuickBooks prints around the data, with invented rows inside. */
const REPORT: string[][] = [
  ['Fictional Cards LLC', '', '', '', '', ''],
  ['Customer Contact List', '', '', '', '', ''],
  [],
  HEADER,
  [
    'Ada Fenwick (NC-FENCO) Fenwick Cards',
    'Phone:(555) 010-1234 Mobile:(555) 010-1234',
    'ada@example.com',
    '',
    '12 Larkspur Way\nSTE 4\nGreenbank NC 27000',
    ''
  ],
  [
    'Bo Ferreira (Ferreira Sports Ltd)',
    'Phone:555-010-7788',
    'bo@example.org',
    '',
    '9 Harbour Road\nWestcliff QLD 4000 Australia',
    ''
  ],
  ['Cal Ohashi', '', 'cal@example.net', '', '4400 Wren Ave Apt 2 Marlow OH 43000', ''],
  // The last row of every QuickBooks report: a timestamp, alone.
  [' Sunday, August 09, 2026 04:04 PM GMT-05:00', '', '', '', '', '']
]

const header = findHeaderRow(REPORT)
ok(header !== null && header.index === 3, 'the header is found below the title rows', String(header?.index))
ok(header?.columns.name === 0, 'the display name is column 0')
// "Customer full name" and "Full name" both contain "full name". Resolve them
// the wrong way round and every buyer imports under a bare person name.
ok(header?.columns.fullName === 3, 'and "Full name" is a DIFFERENT column', String(header?.columns.fullName))
ok(header?.columns.phones === 1 && header?.columns.email === 2, 'phones and email land')
ok(header?.columns.billAddr === 4 && header?.columns.shipAddr === 5, 'bill and ship do not swap')

// The title row contains the word "customer" and would resolve exactly one
// field. One is not a header.
ok(findHeaderRow([['Customer Contact List'], HEADER])?.index === 1, 'a one-word title is not a header')
ok(
  mapColumns(['Name', 'Phone', 'Email']).name === 0,
  'a plain "Name" column is promoted when there is no "Customer" one'
)
ok(parseContactSheet([['a', 'b'], ['c', 'd']]).error !== null, 'a sheet with no header is refused, loudly')

const sheet = parseContactSheet(REPORT)
ok(sheet.error === null, 'the report parses', String(sheet.error))
ok(sheet.contacts.length === 3, 'three customers', String(sheet.contacts.length))
ok(sheet.rowsSeen === 4, 'four non-blank rows were read', String(sheet.rowsSeen))
ok(sheet.skipped.length === 1, 'and one row was skipped')
ok(
  sheet.skipped[0].row === 8 && /nothing to import/.test(sheet.skipped[0].reason),
  'the print timestamp is skipped WITH A REASON, not silently dropped',
  JSON.stringify(sheet.skipped[0])
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. the display name ===')
// ---------------------------------------------------------------------------
const fenwick = splitDisplayName('Ada Fenwick (NC-FENCO) Fenwick Cards')
ok(fenwick.displayName === 'Ada Fenwick (NC-FENCO) Fenwick Cards', 'the whole cell is the name')
ok(fenwick.person === 'Ada Fenwick', 'the person is what comes first')
ok(fenwick.code === 'NC-FENCO', 'the code is the bracketed part')
ok(fenwick.company === 'Fenwick Cards', 'the company is what follows')

// A bracketed part with a space in it is a company, not a filing code.
const ferreira = splitDisplayName('Bo Ferreira (Ferreira Sports Ltd)')
ok(ferreira.code === null, 'a bracketed phrase is not mistaken for a code')
ok(ferreira.company === 'Ferreira Sports Ltd', 'it is the company')

const bare = splitDisplayName('Cal Ohashi')
ok(bare.person === 'Cal Ohashi' && bare.code === null && bare.company === null, 'a bare name is a bare name')

// Two bracketed groups happen. The code-shaped one wins and the tail is the
// company; nothing is dropped either way.
const two = splitDisplayName('Dee Marek (Marek Family Trust) (VA-MAREK) Marek Cards')
ok(two.code === 'VA-MAREK' && two.company === 'Marek Cards', 'two brackets resolve', JSON.stringify(two))

ok(splitDisplayName('  Eli   Novak  ').displayName === 'Eli Novak', 'stray whitespace is squeezed')
// A non-breaking space is invisible and would otherwise make two copies of one
// buyer compare as different.
ok(
  splitDisplayName('Fay\u00a0Okonkwo').displayName === 'Fay Okonkwo',
  'and so is a non-breaking one'
)

// ---------------------------------------------------------------------------
console.log('\n=== 3. phones ===')
// ---------------------------------------------------------------------------
const both = splitPhones('Phone:(555) 010-1234 Mobile:(555) 010-9999')
ok(both.phone === '(555) 010-1234', 'the phone comes out verbatim', String(both.phone))
ok(both.mobile === '(555) 010-9999', 'and so does the mobile', String(both.mobile))

// The formats in a real export vary wildly and NONE of them may be normalised:
// a rule that tidies a US number mangles an international one.
ok(splitPhones('Phone:5550101234').phone === '5550101234', 'bare digits survive')
ok(splitPhones('Phone:+44 20 7946 0000').phone === '+44 20 7946 0000', 'a +44 number is not reformatted')
ok(splitPhones('Mobile:(555) 010-2222').phone === null, 'a mobile-only cell leaves the phone empty')
ok(splitPhones('Mobile:(555) 010-2222').mobile === '(555) 010-2222', 'and fills the mobile')
ok(splitPhones('Cell: 555 010 3333').mobile === '555 010 3333', '"Cell" is a mobile')
ok(splitPhones('(555) 010-4444').phone === '(555) 010-4444', 'an unlabelled number is the phone')
ok(splitPhones('').phone === null, 'an empty cell is empty')
// A label with no column of its own is REPORTED, never dropped in silence.
const faxed = splitPhones('Phone:555 010 5555 Fax:555 010 6666')
ok(faxed.phone === '555 010 5555' && faxed.other.length === 1, 'a fax number is kept aside')
ok(/Fax/.test(faxed.other[0]), 'and named in the report', faxed.other[0])

ok(phoneDigits('(555) 010-1234') === phoneDigits('555-010-1234'), 'two notations of one number compare equal')
ok(phoneDigits('(555) 010-1234') !== phoneDigits('555-010-9999'), 'two different numbers do not')

// ---------------------------------------------------------------------------
console.log('\n=== 4. email ===')
// ---------------------------------------------------------------------------
ok(splitEmails('ada@example.com').email === 'ada@example.com', 'one address')
const many = splitEmails('ada@example.com, ops@example.com')
ok(many.email === 'ada@example.com' && many.extras.length === 1, 'the first wins, the rest are reported')
const junk = splitEmails('call them')
ok(junk.email === null, 'text that is not an address yields no email')
ok(junk.rejected.length === 2, 'and is reported rather than stored', JSON.stringify(junk.rejected))

// ---------------------------------------------------------------------------
console.log('\n=== 5. addresses — what is recognised ===')
// ---------------------------------------------------------------------------
const usa = parsePostalAddress('12 Larkspur Way\nSTE 4\nGreenbank NC 27000')
ok(usa.address?.line1 === '12 Larkspur Way', 'line 1')
ok(usa.address?.line2 === 'STE 4', 'line 2')
ok(usa.address?.city === 'Greenbank', 'the city')
ok(usa.address?.region === 'NC', 'the state')
ok(usa.address?.postalCode === '27000', 'the ZIP')
ok(usa.warnings.length === 0, 'and nothing to report')

// QuickBooks writes up to three street lines; Intuit's record has two. The
// extra is JOINED rather than dropped — a suite number that vanishes is a
// parcel that reaches the building and stops.
const three = parsePostalAddress('1 Mill Lane\nUnit 6\nDock B\nGreenbank NC 27000')
ok(three.address?.line2 === 'Unit 6, Dock B', 'a third street line is joined, never dropped', String(three.address?.line2))

ok(parsePostalAddress('4 Vine St\nMarlow, OH 43000').address?.city === 'Marlow', 'a comma before the state is fine')
ok(parsePostalAddress('4 Vine St\nMarlow Oh 43000').address?.region === 'OH', 'a lower-case state is upper-cased')
ok(
  parsePostalAddress('4 Vine St\nMarlow Ohio 43000').address?.region === 'OH',
  'a spelled-out state is looked up'
)
ok(
  parsePostalAddress('4 Vine St\nWest Marlow North Carolina 27000').address?.city === 'West Marlow',
  'including a two-word one'
)
ok(parsePostalAddress('4 Vine St\nMarlow OH 43000-1234').address?.postalCode === '43000-1234', 'ZIP+4')

// The country comes off the end whether it is on its own line or trailing the
// ZIP, and "United States" / "USA" mean the same thing.
ok(parsePostalAddress('4 Vine St\nMarlow OH 43000 United States').address?.country === 'United States', 'a trailing country')
ok(parsePostalAddress('4 Vine St\nMarlow OH 43000\nUSA').address?.country === 'United States', 'or one on its own line')
ok(parsePostalAddress('4 Vine St\nMarlow OH 43000 USA').address?.city === 'Marlow', 'and the city survives it')
// "Columbus" ends in "us" and "Norfolk" ends in "uk". A country match without a
// word boundary eats the last four letters of the town and files the buyer in
// the wrong country — and the address that comes out still looks plausible.
const columbus = parsePostalAddress('4 Vine St\nColumbus OH 43000')
ok(columbus.address?.country === null, 'a city ending in "us" is not a country', String(columbus.address?.country))
ok(columbus.address?.city === 'Columbus', 'and keeps its name')
// Here the alias really is the last thing on the line, which is the only place
// the boundary check can be tested from.
const noZip = parsePostalAddress('88 Anvil Way\nColumbus')
ok(noZip.address?.country === null, 'even with nothing after it', String(noZip.address?.country))
ok(noZip.address?.line2 === 'Columbus', 'and the town keeps all of its letters', String(noZip.address?.line2))
const norfolk = parsePostalAddress('88 Anvil Way\nNorfolk')
ok(norfolk.address?.line2 === 'Norfolk', 'the same for a town ending in "uk"', String(norfolk.address?.line2))

// ---------------------------------------------------------------------------
console.log('\n=== 6. addresses — what is REFUSED, and reported ===')
// ---------------------------------------------------------------------------
// One line, no separator. The state and ZIP are anchored to the end so they are
// certain; where the street stops and the city starts is not, and guessing it
// would file "Apt 2" as a city. Everything else is kept verbatim in line 1.
const flat = parsePostalAddress('4400 Wren Ave Apt 2 Marlow OH 43000')
ok(flat.address?.region === 'OH' && flat.address?.postalCode === '43000', 'the certain parts are still taken')
ok(flat.address?.city === null, 'the city is NOT guessed at')
ok(flat.address?.line1 === '4400 Wren Ave Apt 2 Marlow', 'the rest is kept exactly as written')
ok(flat.warnings.length === 1, 'and the row is reported', JSON.stringify(flat.warnings))

// An overseas address has no US city/state/ZIP to find. Every character
// survives; nothing is invented.
const uk = parsePostalAddress('7 Cavendish Row,\nMarlowe, Essex CM9 4YD United Kingdom')
ok(uk.address?.country === 'United Kingdom', 'the country is recognised')
ok(uk.address?.region === null && uk.address?.postalCode === null, 'and nothing is forced into a US shape')
ok(uk.address?.line1 === '7 Cavendish Row,', 'the street is kept')
ok(uk.address?.line2 === 'Marlowe, Essex CM9 4YD', 'and so is the rest of it')
ok(uk.warnings.length === 1, 'reported, not silently half-parsed')

// A six-digit overseas postcode is NOT a ZIP.
const six = parsePostalAddress('12 Peony Street\nSomewhere 123456')
ok(six.address?.postalCode === null, 'six digits is not a US ZIP', String(six.address?.postalCode))
ok(parsePostalAddress('').address === null, 'an empty address is absent, not an object of nulls')

// ---------------------------------------------------------------------------
console.log('\n=== 7. CSV, including the newlines inside a cell ===')
// ---------------------------------------------------------------------------
// The address cell has real newlines in it. Split the file into lines FIRST —
// the obvious implementation — and one customer becomes three broken rows.
const csv =
  'Customer full name,Phone numbers,Email,Full name,Bill address,Ship address\n' +
  '"Ada Fenwick (NC-FENCO) Fenwick Cards","Phone:(555) 010-1234","ada@example.com",,' +
  '"12 Larkspur Way\nSTE 4\nGreenbank NC 27000",\n' +
  '"Gus ""Doc"" Halvorsen",,"gus@example.com",,"9 Anvil Rd\nMarlow OH 43000",\n'
const csvGrid = parseDelimitedGrid(csv)
ok(csvGrid.length === 3, 'a quoted newline does not end the row', String(csvGrid.length))
ok(csvGrid[1][4].split('\n').length === 3, 'the address keeps its three lines')
ok(csvGrid[2][0] === 'Gus "Doc" Halvorsen', 'a doubled quote is one quote')

const csvSheet = parseContactSheet(csvGrid)
ok(csvSheet.contacts.length === 2, 'and both customers parse', String(csvSheet.contacts.length))
ok(csvSheet.contacts[0].billAddr?.city === 'Greenbank', 'with the address taken apart')

// Tabs win when they are there: a spreadsheet paste leaves $8,600.00 unquoted.
const tsv = parseDelimitedGrid('Customer\tPhone\tEmail\nAda Fenwick\t555 010 1234\tada@example.com')
ok(tsv[1].length === 3, 'a tab-separated export is read as TSV', JSON.stringify(tsv[1]))

// A byte-order mark survives Excel's "Save as CSV" and would otherwise stick to
// the first header cell, so the sheet reads as headerless.
ok(parseDelimitedGrid('\ufeffCustomer,Phone')[0][0] === 'Customer', 'a BOM is stripped')

// ---------------------------------------------------------------------------
console.log('\n=== 8. .xlsx, built here from invented rows ===')
// ---------------------------------------------------------------------------
/** A minimal .xlsx: one worksheet, shared strings, deflated like a real one. */
function buildXlsx(rows: string[][]): Buffer {
  const strings: string[] = []
  const indexOf = (v: string): number => {
    const at = strings.indexOf(v)
    if (at >= 0) return at
    strings.push(v)
    return strings.length - 1
  }
  const esc = (v: string): string =>
    v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const col = (n: number): string => {
    let s = ''
    let x = n + 1
    while (x > 0) {
      const r = (x - 1) % 26
      s = String.fromCharCode(65 + r) + s
      x = Math.floor((x - r) / 26)
    }
    return s
  }
  const body = rows
    .map((cells, r) => {
      const inner = cells
        .map((v, c) =>
          v === '' ? '' : `<c r="${col(c)}${r + 1}" t="s"><v>${indexOf(v)}</v></c>`
        )
        .join('')
      // A row with nothing in it is not written out at all, exactly as Excel
      // does — which is why the reader has to honour the r= attribute.
      return inner ? `<row r="${r + 1}">${inner}</row>` : ''
    })
    .join('')
  const sheet =
    '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${body}</sheetData></worksheet>`
  const sst =
    '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('') +
    '</sst>'
  const workbook =
    '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'
  const rels =
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>'

  const files: Array<[string, Buffer]> = [
    ['xl/workbook.xml', Buffer.from(workbook, 'utf8')],
    ['xl/_rels/workbook.xml.rels', Buffer.from(rels, 'utf8')],
    ['xl/sharedStrings.xml', Buffer.from(sst, 'utf8')],
    ['xl/worksheets/sheet1.xml', Buffer.from(sheet, 'utf8')]
  ]

  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, raw] of files) {
    // Deflated, like a real writer's output — a STORED-only test would never
    // exercise the inflate path the actual file needs.
    const deflated = deflateRawSync(raw)
    const nameBuf = Buffer.from(name, 'utf8')
    // A local extra field, which real writers emit (Excel writes an extended
    // timestamp) and the CENTRAL directory here does not. The two lengths are
    // allowed to differ, so a reader that skips the central one's is a few
    // bytes early into the compressed data and inflates garbage.
    const extra = Buffer.alloc(9)
    extra.writeUInt16LE(0x5455, 0)
    extra.writeUInt16LE(5, 2)
    extra.writeUInt8(1, 4)
    const local = Buffer.alloc(30 + nameBuf.length + extra.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    // Bit 3: "the sizes are in a data descriptor after the data". This is what a
    // one-pass writer emits, and it means the LOCAL header's size fields are
    // zero. A reader that slices by them gets an empty buffer and a sheet with
    // no rows in it — which is why xlsxGrid reads the central directory.
    local.writeUInt16LE(0x0008, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(0, 18)
    local.writeUInt32LE(0, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(extra.length, 28)
    nameBuf.copy(local, 30)
    extra.copy(local, 30 + nameBuf.length)
    const descriptor = Buffer.alloc(16)
    descriptor.writeUInt32LE(0x08074b50, 0)
    descriptor.writeUInt32LE(deflated.length, 8)
    descriptor.writeUInt32LE(raw.length, 12)
    locals.push(local, deflated, descriptor)

    const cen = Buffer.alloc(46 + nameBuf.length)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x0008, 8)
    cen.writeUInt16LE(8, 10)
    cen.writeUInt32LE(deflated.length, 20)
    cen.writeUInt32LE(raw.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(offset, 42)
    nameBuf.copy(cen, 46)
    central.push(cen)
    offset += local.length + deflated.length + descriptor.length
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

const book = buildXlsx(REPORT)
const grid = xlsxToGrid(book)
ok(grid.length === 8, 'every row of the sheet comes back', String(grid.length))
ok(grid[3][0] === 'Customer full name', 'the header is where the file says it is')
// Row 3 is empty and Excel omits it entirely. A reader that packed rows would
// pull the header up one and the mapping would land on the title.
ok(grid[2].length === 0, 'the blank row is preserved as blank')
ok(grid[4][4].split('\n').length === 3, 'newlines inside a cell survive')
ok(xlsxToGrid(book)[4][0] === 'Ada Fenwick (NC-FENCO) Fenwick Cards', 'shared strings resolve')
// The archive above is written the way a one-pass writer writes one: the
// local headers claim a size of zero and only the central directory knows
// the truth. Getting this back at all is the assertion.
ok(grid[6][2] === 'cal@example.net', 'a zip with a data descriptor still decodes', String(grid[6][2]))

let threw = ''
try {
  xlsxToGrid(Buffer.from('Customer full name,Phone\nAda Fenwick,555', 'utf8'))
} catch (err) {
  threw = err instanceof Error ? err.message : String(err)
}
ok(/not an .xlsx/.test(threw), 'a file that is not a spreadsheet says so in a sentence', threw)

// ---------------------------------------------------------------------------
console.log('\n=== 9. importing, and importing again ===')
// ---------------------------------------------------------------------------
const first = importContactFile(book, 'contacts.xlsx')
ok(first.added === 3, 'three buyers added', JSON.stringify(first))
ok(first.updated === 0 && first.unchanged === 0, 'nothing to update on a first run')
ok(first.skipped.length === 1, 'the timestamp row is still reported as skipped')
ok(first.notes.length === 2, 'two rows imported with a note', JSON.stringify(first.notes))

const saved = repo.listCustomers()
ok(saved.length === 3, 'the buyer list has three names', String(saved.length))
const ada = saved.find((c) => c.name.startsWith('Ada'))
ok(!!ada, 'Ada is there')
// THE WHOLE CELL IS THE NAME. QuickBooks matches an invoice on the display
// name, so storing only "Ada Fenwick" would break every posting.
ok(ada.name === 'Ada Fenwick (NC-FENCO) Fenwick Cards', 'stored under the full display name', ada.name)
ok(ada.email === 'ada@example.com', 'with the email')
ok(ada.phone === '(555) 010-1234', 'and the phone')
// The export repeats one number in both columns on almost every row. A second
// copy of the same digits is a second thing to keep in step.
ok(ada.mobile === null, 'a mobile identical to the phone is not stored twice', String(ada.mobile))
ok(ada.billAddr?.city === 'Greenbank' && ada.billAddr?.region === 'NC', 'and the address')
ok(ada.terms === 'Net 30', 'terms default rather than being invented from the sheet')

// RE-IMPORTING THE SAME FILE MUST DO NOTHING AT ALL. Not "add them again", and
// not "rewrite 360 rows with identical values" either — invoice_customers is a
// synced table, and touching updated_at would push every row to every machine.
const before = db
  .prepare('SELECT id, updated_at FROM invoice_customers ORDER BY name')
  .all() as Array<{ id: string; updated_at: string }>
const second = importContactFile(book, 'contacts.xlsx')
ok(second.added === 0, 'a second import adds nobody', JSON.stringify(second))
ok(second.unchanged === 3, 'all three read as already up to date')
ok(second.updated === 0, 'and nothing is rewritten')
ok(repo.listCustomers().length === 3, 'still three buyers')
const after = db
  .prepare('SELECT id, updated_at FROM invoice_customers ORDER BY name')
  .all() as Array<{ id: string; updated_at: string }>
ok(
  JSON.stringify(before) === JSON.stringify(after),
  'no row was touched, so nothing is pushed to the other machines'
)

// ---------------------------------------------------------------------------
console.log('\n=== 10. an import adds; it does not erase ===')
// ---------------------------------------------------------------------------
// Everything below is typed in THIS app and appears in no spreadsheet. An
// import that blanked it would destroy work with no undo.
repo.saveCustomer({
  id: ada.id,
  name: ada.name,
  email: ada.email,
  terms: 'Net 60',
  className: 'Wholesale',
  message: 'Thanks as always',
  notes: 'Pays on the day'
})
const withExtras = repo.getCustomer(ada.id)
ok(withExtras.terms === 'Net 60', 'the operator set terms')
// saveCustomer was called with no phone key at all, which is what the invoice
// screen does. That must leave the imported number alone.
ok(withExtras.phone === '(555) 010-1234', 'and saving without a phone key kept the number')

importContactFile(book, 'contacts.xlsx')
const afterReimport = repo.getCustomer(ada.id)
ok(afterReimport.terms === 'Net 60', 'a re-import does not reset terms')
ok(afterReimport.className === 'Wholesale', 'nor the class')
ok(afterReimport.message === 'Thanks as always', 'nor the standing message')
ok(afterReimport.notes === 'Pays on the day', 'nor the internal note')
ok(afterReimport.id === ada.id, 'and it is the same record, not a second one')

// A CELL THAT IS BLANK LEAVES WHAT IS STORED. The contact list has no notes
// column; neither has it an email for everybody.
const cal = repo.listCustomers().find((c) => c.name === 'Cal Ohashi')
repo.saveCustomer({ id: cal.id, name: cal.name, email: cal.email, phone: '555 010 8888' })
importContactFile(book, 'contacts.xlsx')
ok(
  repo.getCustomer(cal.id).phone === '555 010 8888',
  'a row with no phone in the sheet does not blank the stored one',
  String(repo.getCustomer(cal.id).phone)
)

// A NEW FACT IN THE SHEET IS TAKEN. That is what an import is for.
const moved = REPORT.map((r) => [...r])
moved[6][1] = 'Phone:(555) 010-4321'
moved[6][4] = '77 Kestrel Lane\nMarlow OH 43000'
const third = importContactFile(buildXlsx(moved), 'contacts.xlsx')
ok(third.updated === 1, 'one buyer changed', JSON.stringify(third))
ok(third.unchanged === 2, 'and the other two did not')
const movedCal = repo.getCustomer(cal.id)
ok(movedCal.phone === '(555) 010-4321', 'the new number is taken')
ok(movedCal.billAddr?.city === 'Marlow' && movedCal.billAddr?.line1 === '77 Kestrel Lane', 'and the new address')

// ---------------------------------------------------------------------------
console.log('\n=== 11. the same list as CSV ===')
// ---------------------------------------------------------------------------
// The fallback that has to work when a spreadsheet will not: the same rows, in
// the other container, must reach the same buyers.
const asCsv = REPORT.map((r) =>
  (r.length ? r : ['', '', '', '', '', '']).map((c) => '"' + c.replace(/"/g, '""') + '"').join(',')
).join('\n')
const csvRun = importContactFile(Buffer.from(asCsv, 'utf8'), 'contacts.csv')
ok(csvRun.added === 0, 'the CSV finds the same buyers, not new ones', JSON.stringify(csvRun))
ok(csvRun.skipped.length === 1, 'and skips the same footer row')
ok(repo.listCustomers().length === 3, 'the list is still three long')

// A CSV renamed .xlsx must still import: the bytes decide, not the name.
const misnamed = importContactFile(Buffer.from(asCsv, 'utf8'), 'contacts.xlsx')
ok(misnamed.rowsSeen === 4, 'a CSV called .xlsx is read as a CSV', JSON.stringify(misnamed.rowsSeen))

// THE KEY IS CASE-INSENSITIVE. QuickBooks will not create two customers whose
// display names differ only in capitalisation, so neither may this: a sheet
// that spells one name differently must find the buyer, not add a second.
const recased = REPORT.map((r) => [...r])
recased[4] = [...recased[4]]
recased[4][0] = 'ADA FENWICK (NC-FENCO) Fenwick Cards'
const recasedRun = importContactFile(buildXlsx(recased), 'contacts.xlsx')
ok(recasedRun.added === 0, 'a differently-capitalised name is the same buyer', JSON.stringify(recasedRun))
ok(repo.listCustomers().length === 3, 'and no fourth record appears')
// THE STORED NAME IS NOT RESTYLED. Matching case-insensitively must not mean
// adopting the sheet's capitalisation — that would rewrite a buyer's name as a
// side effect of an import, on every document raised for them afterwards.
ok(
  repo.getCustomer(ada.id).name === 'Ada Fenwick (NC-FENCO) Fenwick Cards',
  'and their own capitalisation is left alone',
  repo.getCustomer(ada.id).name
)

// A duplicate name inside ONE file is not an add-then-overwrite.
const dupe = [...REPORT.map((r) => [...r])]
dupe.splice(6, 0, [
  'ada fenwick (NC-FENCO) Fenwick Cards',
  'Phone:(555) 010-0000',
  'other@example.com',
  '',
  '',
  ''
])
const dupeRun = importContactFile(buildXlsx(dupe), 'contacts.xlsx')
ok(
  dupeRun.skipped.some((s) => /already on row/.test(s.reason)),
  'a name repeated in one sheet is skipped with a reason',
  JSON.stringify(dupeRun.skipped)
)
ok(repo.listCustomers().length === 3, 'and no fourth buyer appears')

ok(/added/.test(summarizeImport(first)), 'the one-line summary says what happened', summarizeImport(first))
ok(summarizeImport({ ...first, added: 0, updated: 0, unchanged: 0, skipped: [] }) === 'Nothing to import.', 'and says so when there was nothing')

// ---------------------------------------------------------------------------
console.log('\n=== 12. suppliers on a purchase order ===')
// ---------------------------------------------------------------------------
const po = require('../src/main/db/purchaseOrders')
const suggestions = po.listSupplierSuggestions()
// Every contact is offered on the supplier box. A PO's supplier stays free
// text; this is a search over the same people, not a foreign key.
ok(suggestions.length === 3, 'the contact list is offered as suppliers', String(suggestions.length))
ok(
  suggestions.every((s: { source: string }) => s.source === 'contact'),
  'all from the contact list while no PO has named anyone'
)
ok(
  suggestions.some((s: { name: string }) => s.name === 'Ada Fenwick (NC-FENCO) Fenwick Cards'),
  'under the same display name the buyer list uses'
)
ok(
  suggestions.every((s: { usedOnOrders: number }) => s.usedOnOrders === 0),
  'and none has been used on an order yet'
)

// A supplier typed straight onto a PO — most of the regular distributors are
// only ever known this way — has to appear too, or the box is worse than the
// plain text field it replaced.
db.prepare(
  `INSERT INTO purchase_orders (id, po_number, supplier, status, location, total, created_at, updated_at, ordered_at)
   VALUES ('po_test_1', 'PO-TEST-1', 'Anvil Distribution', 'ordered', 'RM', 0, ?, ?, ?)`
).run('2026-08-01T12:00:00.000Z', '2026-08-01T12:00:00.000Z', '2026-08-01T12:00:00.000Z')
db.prepare(
  `INSERT INTO purchase_orders (id, po_number, supplier, status, location, total, created_at, updated_at, ordered_at)
   VALUES ('po_test_2', 'PO-TEST-2', 'ada fenwick (NC-FENCO) Fenwick Cards', 'ordered', 'RM', 0, ?, ?, ?)`
).run('2026-08-02T12:00:00.000Z', '2026-08-02T12:00:00.000Z', '2026-08-02T12:00:00.000Z')

db.prepare(
  `INSERT INTO purchase_orders (id, po_number, supplier, status, location, total, created_at, updated_at, ordered_at)
   VALUES ('po_test_3', 'PO-TEST-3', 'ANVIL DISTRIBUTION', 'ordered', 'RM', 0, ?, ?, ?)`
).run('2026-07-30T12:00:00.000Z', '2026-07-30T12:00:00.000Z', '2026-07-30T12:00:00.000Z')

const merged = po.listSupplierSuggestions()
ok(merged.length === 4, 'a name known only from a PO joins the list', String(merged.length))
// Typed in caps on one order and mixed case on another. Grouped case-sensitively
// they are two entries for one distributor, and the count on each is wrong.
const anvil = merged.filter((s: { name: string }) => /anvil/i.test(s.name))
ok(anvil.length === 1, 'one supplier typed two ways is one entry', JSON.stringify(anvil))
ok(anvil[0].usedOnOrders === 2, 'and its order count adds both up', String(anvil[0].usedOnOrders))
// Recently used first: that ordering is the whole value of a suggestion box.
ok(merged[0].name === 'Ada Fenwick (NC-FENCO) Fenwick Cards', 'the most recent supplier is first', merged[0].name)
ok(merged[0].source === 'contact' && merged[0].usedOnOrders === 1, 'and is recognised as a contact')
ok(
  /^anvil distribution$/i.test(merged[1].name) && merged[1].source === 'history',
  'then the one only a PO knows',
  merged[1].name
)
// The PO spelled her name in lower case. Matched case-sensitively she would
// appear twice, and picking the wrong one would look like it did nothing.
ok(
  merged.filter((s: { name: string }) => /Fenwick/i.test(s.name)).length === 1,
  'a differently-capitalised supplier is not listed twice'
)

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
