/**
 * The vendor list importer, and the two-sided contact record it writes into.
 *
 * ## EVERY NAME AND ADDRESS BELOW IS INVENTED
 *
 * The real sheet is 151 of the owner's actual suppliers with their street
 * addresses, and this repository is PUBLIC. Not one row of it is here, in any
 * form. The SHAPES are real — they were measured against the file on the
 * owner's machine and written down as rules — but every value is made up and
 * none of the addresses is a place. If a bug ever needs a regression test,
 * describe the SHAPE that broke and invent a row with it; do not paste the row
 * that found it.
 *
 * ## What is pinned here, and how each one fails
 *
 *   1. THE SHEET IS A TABLE, and its two header collisions are the whole reason
 *      the matcher order is what it is. "Full Address" and "Street Address" both
 *      contain "address"; "Vendor Label" contains "vendor". Resolve either the
 *      wrong way round and every row imports with its columns swapped, which
 *      looks like data and is not.
 *
 *   2. THE NAME IS THE KEY, and it is the SAME key the customer list uses. That
 *      is what lets one business be a vendor and a customer at once instead of
 *      existing twice with two addresses, one of which is about to go stale.
 *
 *   3. NOTHING IS DROPPED. A row this parser cannot fully understand is still
 *      imported and carries a warning naming what could not be filed. A vendor
 *      with no address is still an answer to "who can we buy from".
 *
 *   4. THE DERIVATION SURVIVES. Admin → Vendors was a list derived from purchase
 *      orders and cost layers. Adding an imported directory must not remove a
 *      vendor who only exists because somebody bought from them, and the two
 *      must merge on the name rather than appear twice.
 *
 *   5. AN IMPORT ADDS, IT DOES NOT ERASE. Re-running writes nothing at all, and
 *      a vendor import must never clear the customer flag or anything typed in
 *      this app.
 *
 * Run: npm run test:vendors
 */
import { mkdirSync, rmSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/vendors-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const {
  findVendorHeaderRow,
  mapVendorColumns,
  parseStateCell,
  parseVendorSheet,
  parseZipCell
} = require('../src/shared/vendors')
const { xlsxToGrid } = require('../src/main/xlsxGrid')
const { importVendorFile } = require('../src/main/vendorsImport')
const { importContactFile } = require('../src/main/contactsImport')
const po = require('../src/main/db/purchaseOrders')
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

interface Warned {
  row: number
  name: string
  label: string | null
  address: {
    line1: string | null
    line2: string | null
    city: string | null
    region: string | null
    postalCode: string | null
    country: string | null
  } | null
  warnings: string[]
}

const HEADER = [
  'List Label',
  'Name / Business',
  'Street Address',
  'City',
  'State',
  'ZIP',
  'Full Address',
  'Source Order'
]

/** street, city ST zip — the concatenation the real sheet's last column is. */
const full = (street: string, city: string, state: string, zip: string): string =>
  `${street}, ${city} ${state} ${zip}`

const row = (
  label: string,
  name: string,
  street: string,
  city: string,
  state: string,
  zip: string,
  order: string
): string[] => [label, name, street, city, state, zip, full(street, city, state, zip), order]

// ---------------------------------------------------------------------------
console.log('=== 1. the sheet is a table, and the header order is load-bearing ===')
// ---------------------------------------------------------------------------

const cols = mapVendorColumns(HEADER)
ok(cols.name === 1, 'the business name is column 1, not the list label', String(cols.name))
ok(cols.label === 0, 'and the list label is its own field', String(cols.label))
ok(cols.street === 2, 'Street Address is the street', String(cols.street))
ok(cols.city === 3 && cols.state === 4 && cols.zip === 5, 'city, state and ZIP land in order')
// THE COLLISION. Both headers contain "address". Test street first and the
// redundant concatenation becomes the street line on all 151 rows.
ok(cols.full === 6, 'Full Address is claimed by `full`, never by `street`', String(cols.full))

// The other collision, from the other direction: a sheet whose label column is
// called "Vendor Label" contains "vendor", which is a NAME matcher. Claim it as
// the name and every business imports under a filing shorthand.
const relabelled = mapVendorColumns(['Vendor Label', 'Business', 'Address', 'City', 'State', 'Zip'])
ok(relabelled.label === 0, 'a column called "Vendor Label" is a label', String(relabelled.label))
ok(relabelled.name === 1, 'and the business beside it is the name', String(relabelled.name))

// Column ORDER in the file must not matter — only the titles.
// The same collision with the two columns the other way round in the file, which
// is what proves the ORDER OF THE MATCHERS is doing the work rather than the
// order of the columns happening to save it.
const flipped = mapVendorColumns(['Full Address', 'Street Address', 'Vendor'])
ok(flipped.full === 0 && flipped.street === 1, 'even with Full Address first in the file', JSON.stringify(flipped))

const shuffled = mapVendorColumns(['Full Address', 'ZIP', 'State', 'City', 'Address', 'Supplier'])
ok(
  shuffled.full === 0 && shuffled.street === 4 && shuffled.name === 5,
  'the columns can be in any order',
  JSON.stringify(shuffled)
)

const found = findVendorHeaderRow([['Some Vendor Sheet'], [], HEADER, row('A', 'B', '1 X St', 'Y', 'NY', '10001', '1')])
ok(found?.index === 2, 'a title above the table does not become the header', String(found?.index))

// A name column with no address column at all is not this sheet. Accepting it
// would make a one-column list of names import as a vendor directory with 151
// blank addresses, which is indistinguishable from a successful import.
ok(findVendorHeaderRow([['Name'], ['Bramble Wholesale']]) === null, 'names alone are not a vendor sheet')
ok(findVendorHeaderRow([['Widget', 'Qty']]) === null, 'and neither is a sheet with no name column')

// ---------------------------------------------------------------------------
console.log('\n=== 2. states and ZIPs ===')
// ---------------------------------------------------------------------------

ok(parseStateCell('ny') === 'NY', 'a two-letter state is upper-cased — Intuit rejects "Ny"')
ok(parseStateCell('New York') === 'NY', 'and a spelled-out one is looked up')
ok(parseStateCell('Ontario') === null, 'a region this app has no code for is null, not a guess')
ok(parseStateCell('   ') === null, 'and a blank cell is nobody')

ok(parseZipCell('10001').postalCode === '10001', 'a five-digit ZIP passes through')
const plus4 = parseZipCell('60455-9021')
ok(plus4.postalCode === '60455-9021', 'ZIP+4 is kept WHOLE — truncating it changes the walk')
ok(plus4.warning === null, 'and is not flagged, because it is the normal case here')

// Excel stores a ZIP-looking cell as a NUMBER unless it is explicitly text, and
// a number cannot carry a leading zero. Every Massachusetts and New Jersey ZIP
// comes back short the moment somebody re-saves the sheet.
const short = parseZipCell('2134')
ok(short.postalCode === '02134', 'a four-digit ZIP gets its leading zero back', String(short.postalCode))
ok(!!short.warning && /leading zero/.test(short.warning), 'and says so, so the export gets fixed')
ok(parseZipCell('501').postalCode === '00501', 'three digits are padded too — 005xx is a real range')

// Not a repair this time: there is no rule that turns this into a US ZIP, so it
// is kept exactly as written rather than mangled or dropped.
const odd = parseZipCell('SW1A 1AA')
ok(odd.postalCode === 'SW1A 1AA', 'anything else survives verbatim', String(odd.postalCode))
ok(!!odd.warning, 'and is flagged for a human')

// ---------------------------------------------------------------------------
console.log('\n=== 3. a row is parsed, and nothing about it is guessed ===')
// ---------------------------------------------------------------------------

const SHEET = [
  HEADER,
  // The ordinary row: a filing label that is not the name, a bracketed code
  // inside the name, and ZIP+4.
  row('BR-WHOLE', 'Bramble Wholesale (NY-BRAM)', '12 Alder Way', 'Ashfield', 'NY', '10001-2233', '1'),
  // A label that merely repeats the name. Storing it would print the name twice.
  row('Larkin Supply', 'Larkin Supply', '4 Quarry Rd Suite 200', 'Redhill', 'CA', '90210', '2'),
  // A state nobody recognises and a ZIP that is not one. Imported, both flagged.
  row('OV-1', 'Overseas Trading Co', '9 Harbour Row', 'Wrenmouth', 'Hampshire', 'PO1 3AX', '3'),
  // No address at all. THE ROW IS STILL IMPORTED: a vendor with no address is
  // still an answer to "who can we buy from", which is what this list is for.
  ['NA-1', 'Nameless Yard', '', '', '', '', '', '4'],
  // No name. Nothing to key on, so it is skipped — and SAID, not dropped quietly.
  ['ZZ-1', '', '1 Nowhere St', 'Nowhere', 'TX', '75001', '1 Nowhere St, Nowhere TX 75001', '5'],
  // An unclosed bracket in the name. The name is stored whole either way; the
  // flag is so the owner can fix it at source.
  row('AN-DIST', 'Anvil Distribution (NY-ANVI', '77 Forge Ln', 'Kettleby', 'NY', '10002', '6'),
  // The same business twice with the same address — a harmless duplicate.
  row('BR-2', 'Bramble Wholesale (NY-BRAM)', '12 Alder Way', 'Ashfield', 'NY', '10001-2233', '7'),
  // And the same NAME with a DIFFERENT address, which is not harmless at all:
  // one of the two businesses is about to be unreachable and only a person can
  // say which.
  row('LK-2', 'Larkin Supply', '88 Other Rd', 'Elsewhere', 'CA', '90211', '8')
]

const parsed = parseVendorSheet(SHEET)
ok(parsed.error === null, 'the sheet reads', String(parsed.error))
ok(parsed.rowsSeen === 8, 'every row below the header is seen', String(parsed.rowsSeen))
ok(parsed.vendors.length === 5, 'five of them become vendors', String(parsed.vendors.length))

const byName = (re: RegExp): Warned | undefined =>
  parsed.vendors.find((v: Warned) => re.test(v.name))

const bramble = byName(/Bramble/)
ok(bramble?.name === 'Bramble Wholesale (NY-BRAM)', 'the name is stored VERBATIM, code and all', String(bramble?.name))
ok(bramble?.label === 'BR-WHOLE', 'the filing label is kept beside it', String(bramble?.label))
ok(bramble?.address?.line1 === '12 Alder Way', 'the street is the street', String(bramble?.address?.line1))
ok(bramble?.address?.city === 'Ashfield', 'the city column is the city — no comma-counting', String(bramble?.address?.city))
ok(bramble?.address?.region === 'NY' && bramble?.address?.postalCode === '10001-2233', 'state and ZIP+4 land')
// Not "United States". Every other importer leaves a domestic country null, and
// a country only this one wrote would make every row compare as changed on
// every re-import and push all 151 to every other machine.
ok(bramble?.address?.country === null, 'the country stays null for a domestic address', String(bramble?.address?.country))
ok(bramble?.warnings.length === 0, 'a row that parsed cleanly says nothing', JSON.stringify(bramble?.warnings))

const larkin = byName(/Larkin/)
ok(larkin?.label === null, 'a label that only repeats the name is not stored twice', String(larkin?.label))

const overseas = byName(/Overseas/)
ok(!!overseas, 'a row this parser only half understands is still IMPORTED')
ok(overseas?.address?.line1 === '9 Harbour Row', 'with everything it did understand')
ok(overseas?.address?.region === null, 'and no invented state code')
ok(overseas?.address?.postalCode === 'PO1 3AX', 'and the postcode exactly as written')
ok(overseas!.warnings.length === 2, 'and two flags on it', JSON.stringify(overseas?.warnings))

const nameless = byName(/Nameless/)
ok(!!nameless, 'a vendor with no address at all is still a vendor')
ok(nameless?.address === null, 'with no address')
ok(
  nameless!.warnings.some((w: string) => /no address/.test(w)),
  'and a flag saying so',
  JSON.stringify(nameless?.warnings)
)

const anvil = byName(/Anvil/)
ok(anvil?.name === 'Anvil Distribution (NY-ANVI', 'an unclosed bracket does not change the name')
ok(
  anvil!.warnings.some((w: string) => /unclosed bracket/.test(w)),
  'but it is flagged',
  JSON.stringify(anvil?.warnings)
)

// Skipped rows are REPORTED, with the reason, never silently dropped.
ok(parsed.skipped.length === 3, 'three rows produced nothing', JSON.stringify(parsed.skipped))
const noName = parsed.skipped.find((s: { reason: string }) => /no vendor name/.test(s.reason))
ok(!!noName && noName.row === 6, 'a nameless row is skipped by row number', JSON.stringify(noName))
const dupSame = parsed.skipped.find((s: { row: number }) => s.row === 8)
ok(
  !!dupSame && /same name and address/.test(dupSame.reason),
  'a duplicate that agrees is called harmless',
  JSON.stringify(dupSame)
)
const dupDiff = parsed.skipped.find((s: { row: number }) => s.row === 9)
ok(
  !!dupDiff && /DIFFERENT address/.test(dupDiff.reason),
  'a duplicate that does NOT agree says so in capitals — only a person can pick',
  JSON.stringify(dupDiff)
)
ok(
  !!dupDiff && /row 3/.test(dupDiff.reason),
  'and both duplicate messages name the row that won',
  JSON.stringify(dupDiff)
)

// ---------------------------------------------------------------------------
console.log('\n=== 4. Full Address is redundant, which makes it a checksum ===')
// ---------------------------------------------------------------------------

// The one internal consistency this sheet has. Somebody corrects a street in the
// parts and not in the concatenation (or the other way round) and NOTHING on
// screen looks wrong — eight columns, 151 rows. The parts win, and it is flagged.
const drifted = parseVendorSheet([
  HEADER,
  ['DR-1', 'Drift Cards', '5 Moor St', 'Tamworth', 'TX', '75002', '9 Old Rd, Tamworth TX 75002', '1']
])
ok(drifted.vendors.length === 1, 'the row still imports')
ok(drifted.vendors[0].address.line1 === '5 Moor St', 'the separate columns win', String(drifted.vendors[0].address.line1))
ok(
  drifted.vendors[0].warnings.some((w: string) => /Full Address/.test(w)),
  'and the disagreement is flagged',
  JSON.stringify(drifted.vendors[0].warnings)
)

// Where the commas go is a FORMATTING choice, not a fact, so a different
// join must not be reported as a disagreement — 151 spurious flags is the same
// as none at all.
const rejoined = parseVendorSheet([
  HEADER,
  ['RJ-1', 'Rejoin Ltd', '5 Moor St', 'Tamworth', 'TX', '75002', '5 Moor St, Tamworth, TX, 75002', '1']
])
ok(rejoined.vendors[0].warnings.length === 0, 'a differently punctuated concatenation is not a disagreement', JSON.stringify(rejoined.vendors[0].warnings))

// A sheet with ONLY the concatenation. The block parser from @shared/contacts is
// borrowed rather than reimplemented, so this app has ONE answer to "where does
// the city stop" — and that answer is "do not guess", which is why the city
// comes back null with a note rather than wrong.
const onlyFull = parseVendorSheet([
  ['Vendor', 'Full Address'],
  ['Solo Supply', '5 Moor St, Tamworth TX 75002']
])
ok(onlyFull.vendors.length === 1, 'a sheet with only a full address still imports')
ok(onlyFull.vendors[0].address.postalCode === '75002', 'the ZIP is unambiguous and is taken')
ok(onlyFull.vendors[0].address.region === 'TX', 'and so is the state in front of it')
ok(onlyFull.vendors[0].address.city === null, 'the city is NOT guessed at from a comma')
ok(onlyFull.vendors[0].warnings.length > 0, 'and the row is flagged for a human')

// ---------------------------------------------------------------------------
console.log('\n=== 5. the reader takes the real file shape: INLINE strings ===')
// ---------------------------------------------------------------------------

/**
 * A minimal .xlsx whose cells are inline strings and which has NO shared-string
 * table at all.
 *
 * That is the real sheet's shape, and it is the shape the customer export does
 * not have — so the shared-string path being exercised in tests/contacts.test.ts
 * proves nothing about it. A reader that only understood `t="s"` would return a
 * grid of empty strings here: no exception, no error, just 151 blank rows and an
 * import that reports "no header row" about a perfectly good file.
 */
function buildInlineXlsx(rows: string[][]): Buffer {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const col = (n: number): string => {
    let s = ''
    let x = n
    while (x >= 0) {
      s = String.fromCharCode(65 + (x % 26)) + s
      x = Math.floor(x / 26) - 1
    }
    return s
  }
  const body = rows
    .map((cells, r) => {
      const inner = cells
        .map((v, c) =>
          v === ''
            ? ''
            : `<c r="${col(c)}${r + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`
        )
        .join('')
      return inner ? `<row r="${r + 1}">${inner}</row>` : ''
    })
    .join('')
  const sheet =
    '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${body}</sheetData></worksheet>`
  const workbook =
    '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    // Three sheets, as the real file has, and the FIRST is the one wanted. A
    // reader that sorted the worksheet filenames instead of following the
    // workbook's own order would open "By State" and import a summary.
    '<sheets><sheet name="All Vendors" sheetId="1" r:id="rId1"/>' +
    '<sheet name="By State" sheetId="2" r:id="rId2"/></sheets></workbook>'
  const rels =
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="worksheet" Target="worksheets/sheet2.xml"/></Relationships>'
  const other =
    '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>State</t></is></c></row></sheetData></worksheet>'

  // Deliberately NO xl/sharedStrings.xml.
  const files: Array<[string, Buffer]> = [
    ['xl/workbook.xml', Buffer.from(workbook, 'utf8')],
    ['xl/_rels/workbook.xml.rels', Buffer.from(rels, 'utf8')],
    ['xl/worksheets/sheet1.xml', Buffer.from(sheet, 'utf8')],
    ['xl/worksheets/sheet2.xml', Buffer.from(other, 'utf8')]
  ]

  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, raw] of files) {
    const deflated = deflateRawSync(raw)
    const nameBuf = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(deflated.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    nameBuf.copy(local, 30)
    locals.push(local, deflated)

    const cen = Buffer.alloc(46 + nameBuf.length)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(8, 10)
    cen.writeUInt32LE(deflated.length, 20)
    cen.writeUInt32LE(raw.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(offset, 42)
    nameBuf.copy(cen, 46)
    central.push(cen)
    offset += local.length + deflated.length
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

const IMPORTABLE = [
  HEADER,
  row('BR-WHOLE', 'Bramble Wholesale (NY-BRAM)', '12 Alder Way', 'Ashfield', 'NY', '10001-2233', '1'),
  row('Larkin Supply', 'Larkin Supply', '4 Quarry Rd', 'Redhill', 'CA', '90210', '2'),
  row('TH-FORGE', 'Thistle Forge', '3 Kiln Rd', 'Bellhurst', 'OH', '43001', '3')
]

const book = buildInlineXlsx(IMPORTABLE)
const grid = xlsxToGrid(book)
ok(grid.length === 4, 'a workbook with no shared-string table still reads', String(grid.length))
ok(grid[0][1] === 'Name / Business', 'and its inline header comes back as text', String(grid[0][1]))
ok(grid[1][6] === '12 Alder Way, Ashfield NY 10001-2233', 'and so does every cell', String(grid[1][6]))
ok(grid[3][1] === 'Thistle Forge', 'including the last row', String(grid[3][1]))

// ---------------------------------------------------------------------------
console.log('\n=== 6. the import: added, updated, unchanged ===')
// ---------------------------------------------------------------------------

const first = importVendorFile(book, 'vendors.xlsx')
ok(first.source === 'vendors.xlsx', 'the file is named in the report', first.source)
ok(first.rowsSeen === 3, 'three rows read', String(first.rowsSeen))
ok(first.added === 3, 'three vendors added', String(first.added))
ok(first.updated === 0 && first.unchanged === 0, 'and nothing else happened')

// THE ASSERTION THE WHOLE IMPORTER RESTS ON. A second run of the same sheet must
// find the same businesses and write NOTHING — invoice_customers is synced, so
// touching updated_at on every row would push the whole directory to every other
// machine on every import, for no change anybody made.
const again = importVendorFile(book, 'vendors.xlsx')
ok(again.added === 0, 're-importing adds nobody', String(again.added))
ok(again.updated === 0, 'and updates nobody', String(again.updated))
ok(again.unchanged === 3, 'all three are already up to date', String(again.unchanged))

const stamps = db
  .prepare(`SELECT name, updated_at FROM invoice_customers WHERE is_vendor = 1 ORDER BY name`)
  .all() as Array<{ name: string; updated_at: string }>
ok(stamps.length === 3, 'and there are still exactly three of them', String(stamps.length))

// A moved address IS a change, and lands whole.
const moved = importVendorFile(
  buildInlineXlsx([
    HEADER,
    row('TH-FORGE', 'Thistle Forge', '9 Anvil Way', 'Bellhurst', 'OH', '43002', '3')
  ]),
  'vendors.xlsx'
)
ok(moved.updated === 1, 'a moved vendor is one update', String(moved.updated))
const thistle = db
  .prepare(`SELECT bill_line1, bill_postal_code FROM invoice_customers WHERE name = 'Thistle Forge'`)
  .get() as { bill_line1: string; bill_postal_code: string }
ok(thistle.bill_line1 === '9 Anvil Way', 'the new street landed', thistle.bill_line1)
ok(thistle.bill_postal_code === '43002', 'and so did the new ZIP — the address moves as a WHOLE')

// A sheet listing a vendor with NO address must not erase the address they
// already have. An import adds; it does not erase — and this is the case that
// actually costs something, because a directory row with its street silently
// blanked still looks like a directory row.
const addressless = importVendorFile(
  buildInlineXlsx([['Vendor', 'Street Address'], ['Thistle Forge', '']]),
  'vendors.xlsx'
)
ok(addressless.unchanged === 1, 'a row with no address changes nothing', JSON.stringify(addressless))
const keptAddress = db
  .prepare(`SELECT bill_line1, bill_city, bill_postal_code FROM invoice_customers WHERE name = 'Thistle Forge'`)
  .get() as { bill_line1: string; bill_city: string; bill_postal_code: string }
ok(
  keptAddress.bill_line1 === '9 Anvil Way' && keptAddress.bill_city === 'Bellhurst' && keptAddress.bill_postal_code === '43002',
  'and the stored address survives whole',
  JSON.stringify(keptAddress)
)

// A sheet with the label column blank must not ERASE a label an earlier import
// brought in. An import adds; it does not erase.
const noLabel = importVendorFile(
  buildInlineXlsx([HEADER, row('', 'Bramble Wholesale (NY-BRAM)', '12 Alder Way', 'Ashfield', 'NY', '10001-2233', '1')]),
  'vendors.xlsx'
)
ok(noLabel.unchanged === 1, 'a blank label changes nothing', JSON.stringify(noLabel))
const brambleRow = db
  .prepare(`SELECT vendor_label FROM invoice_customers WHERE name = 'Bramble Wholesale (NY-BRAM)'`)
  .get() as { vendor_label: string | null }
ok(brambleRow.vendor_label === 'BR-WHOLE', 'and the stored label survives it', String(brambleRow.vendor_label))

// A .csv of the same sheet is the same import. It is the documented escape
// hatch for the day the .xlsx reader meets a writer it does not understand.
const csv = Buffer.from(
  [HEADER, row('TH-FORGE', 'Thistle Forge', '9 Anvil Way', 'Bellhurst', 'OH', '43002', '3')]
    .map((r) => r.map((c) => `"${c}"`).join(','))
    .join('\n'),
  'utf8'
)
const fromCsv = importVendorFile(csv, 'vendors.csv')
ok(fromCsv.unchanged === 1, 'the same list as CSV is recognised as the same list', JSON.stringify(fromCsv))

// Flags reach the operator. A row imported with something unfiled is in `notes`,
// which the report panel shows — the whole point of not dropping it.
const flagged = importVendorFile(
  buildInlineXlsx([HEADER, ['NA-2', 'Quarry Yard', '', '', '', '', '', '9']]),
  'vendors.xlsx'
)
ok(flagged.added === 1, 'a vendor with no address is imported', String(flagged.added))
ok(
  flagged.notes.some((n: { name: string; note: string }) => n.name === 'Quarry Yard' && /no address/.test(n.note)),
  'and the operator is told which row and why',
  JSON.stringify(flagged.notes)
)

// ---------------------------------------------------------------------------
console.log('\n=== 7. one business, both sides ===')
// ---------------------------------------------------------------------------

// The reason the vendor directory landed on the contact table rather than in a
// vendors table of its own: some businesses buy AND sell. Two tables means two
// rows, two addresses, and a phone number corrected on the copy nobody else
// opens.
repo.saveCustomer({
  name: 'Copperpot Cards',
  email: 'buy@example.com',
  phone: '(555) 010-0101',
  terms: 'Net 30',
  notes: 'pays fast'
})

// Deliberately a DIFFERENT capitalisation, because that is how the same business
// gets typed twice. Matched case-sensitively this would mint a second record.
const both = importVendorFile(
  buildInlineXlsx([HEADER, row('CP-CARDS', 'copperpot cards', '2 Kiln Row', 'Bellhurst', 'OH', '43003', '1')]),
  'vendors.xlsx'
)
ok(both.added === 0 && both.updated === 1, 'a customer who also sells to us is UPDATED, not duplicated', JSON.stringify(both))

const copper = db
  .prepare(
    `SELECT id, name, is_customer, is_vendor, email, phone, notes, bill_line1
       FROM invoice_customers WHERE name = ? COLLATE NOCASE`
  )
  .all('Copperpot Cards') as Array<Record<string, unknown>>
ok(copper.length === 1, 'there is exactly ONE record for them', JSON.stringify(copper.map((c) => c.name)))
ok(copper[0].is_customer === 1 && copper[0].is_vendor === 1, 'flagged as both', JSON.stringify(copper[0]))
ok(copper[0].name === 'Copperpot Cards', 'and they keep the name they were already filed under', String(copper[0].name))
// The vendor sheet has no email, phone or notes column. A field the import has
// never heard of must not be blankable by running the import.
ok(copper[0].email === 'buy@example.com', 'their email survived the vendor import', String(copper[0].email))
ok(copper[0].phone === '(555) 010-0101', 'and their phone number', String(copper[0].phone))
ok(copper[0].notes === 'pays fast', 'and the note somebody typed in this app', String(copper[0].notes))
ok(copper[0].bill_line1 === '2 Kiln Row', 'while the vendor address did land', String(copper[0].bill_line1))

// And the other direction: the QuickBooks contact import finding a vendor-only
// record must mark them a customer rather than leave them off the customer list.
const asCustomer = importContactFile(
  Buffer.from(
    'Customer full name,Phone numbers,Email,Bill address\n' +
      '"Thistle Forge","Phone:(555) 010-7788","forge@example.com","9 Anvil Way\nBellhurst OH 43002"\n',
    'utf8'
  ),
  'contacts.csv'
)
ok(asCustomer.updated === 1, 'a vendor who starts buying is updated in place', JSON.stringify(asCustomer))
const forge = db
  .prepare(`SELECT is_customer, is_vendor, vendor_label FROM invoice_customers WHERE name = 'Thistle Forge'`)
  .get() as { is_customer: number; is_vendor: number; vendor_label: string | null }
ok(forge.is_customer === 1 && forge.is_vendor === 1, 'and is now both', JSON.stringify(forge))
ok(forge.vendor_label === 'TH-FORGE', 'with their vendor label untouched by the customer import', String(forge.vendor_label))

// THE COUNT ON THE CUSTOMERS TILE. A vendor nobody has sold anything to is not a
// customer, and 151 suppliers appearing on the buyer list — and in the sales
// order picker — is the failure the two flags exist to prevent.
const customers = repo.listCustomers() as Array<{ name: string }>
const names = customers.map((c) => c.name)
ok(names.includes('Copperpot Cards'), 'a business that is both IS on the customer list')
ok(names.includes('Thistle Forge'), 'and so is a vendor who has started buying')
ok(!names.includes('Bramble Wholesale (NY-BRAM)'), 'a vendor-only record is NOT', JSON.stringify(names))
ok(!names.includes('Quarry Yard'), 'nor is another one', JSON.stringify(names))

// Removing a buyer who is also a vendor must not delete the vendor. This screen
// never mentions vendors, so a delete that took one out would be invisible.
const removed = repo.removeCustomer(String(copper[0].id)) as { deleted: boolean; keptAsVendor: boolean }
ok(removed.deleted === false && removed.keptAsVendor === true, 'they are kept, and the caller is told why', JSON.stringify(removed))
const stillThere = db
  .prepare(`SELECT is_customer, is_vendor, bill_line1 FROM invoice_customers WHERE id = ?`)
  .get(copper[0].id) as { is_customer: number; is_vendor: number; bill_line1: string }
ok(stillThere.is_customer === 0, 'they stop being a customer', JSON.stringify(stillThere))
ok(stillThere.is_vendor === 1 && stillThere.bill_line1 === '2 Kiln Row', 'and stay a vendor, address and all')

// ---------------------------------------------------------------------------
console.log('\n=== 8. the derived list and the directory, merged ===')
// ---------------------------------------------------------------------------

// Documents, so there is something to derive. Bramble is in the directory AND
// has orders; Sable is on no list at all and exists only because somebody bought
// from them — which is how most of the regular distributors got here.
db.prepare(
  `INSERT INTO purchase_orders (id, po_number, supplier, status, location, total, created_at, updated_at, ordered_at)
   VALUES ('po_v_1', 'PO-V-1', 'BRAMBLE WHOLESALE (NY-BRAM)', 'ordered', 'RM', 1200, ?, ?, ?)`
).run('2026-08-05T12:00:00.000Z', '2026-08-05T12:00:00.000Z', '2026-08-05T12:00:00.000Z')
db.prepare(
  `INSERT INTO purchase_orders (id, po_number, supplier, status, location, total, created_at, updated_at, ordered_at)
   VALUES ('po_v_2', 'PO-V-2', 'Sable Trading', 'ordered', 'RM', 300, ?, ?, ?)`
).run('2026-08-06T12:00:00.000Z', '2026-08-06T12:00:00.000Z', '2026-08-06T12:00:00.000Z')

const vendors = po.listVendors() as Array<{
  name: string
  detail: string | null
  onFile: boolean
  label: string | null
  orders: number
  ordered: number
  receipts: number
  lastAt: string | null
}>
const find = (re: RegExp) => vendors.find((v) => re.test(v.name))

// BOTH HALVES, and neither one swallowed the other.
const vBramble = find(/Bramble/i)
ok(!!vBramble, 'a vendor in the directory with orders appears once')
ok(vendors.filter((v) => /Bramble/i.test(v.name)).length === 1, 'exactly once — the caps on the PO are the same business')
ok(vBramble?.orders === 1 && vBramble?.ordered === 1200, 'carrying its derived figures', JSON.stringify(vBramble))
ok(vBramble?.onFile === true, 'and marked as on the list')
ok(vBramble?.label === 'BR-WHOLE', 'with the label only the directory could supply', String(vBramble?.label))
// The directory's spelling wins over the purchase order's SHOUTED one. A PO's
// supplier is free text typed at speed; the directory is curated, and taking the
// PO's would make this name change spelling every time somebody raised an order.
ok(vBramble?.name === 'Bramble Wholesale (NY-BRAM)', 'and the curated spelling, not the shouted one', String(vBramble?.name))

const vSable = find(/Sable/)
ok(!!vSable, 'a vendor known ONLY from a purchase order still appears — the derivation was not thrown away')
ok(vSable?.onFile === false, 'and is marked as not on the list', JSON.stringify(vSable))
ok(vSable?.orders === 1, 'with its order counted', String(vSable?.orders))

// The one thing the derived half could never hold. No purchase order carries an
// address, so before the directory existed this column was a dash for every
// vendor in the list; a city and a state in it is the whole visible payoff of
// the import.
ok(!!vBramble?.detail && /Ashfield/.test(vBramble.detail), 'and a way to place them, which no document could supply', String(vBramble?.detail))
ok(vSable === undefined || vSable.detail === null, 'while a vendor nobody has filed shows nothing rather than a guess', String(vSable?.detail))

const vQuarry = find(/Quarry/)
ok(!!vQuarry, 'a directory vendor with no activity at all still appears')
ok(vQuarry?.onFile === true && vQuarry?.orders === 0 && vQuarry?.receipts === 0, 'with nothing derived', JSON.stringify(vQuarry))
// Null, not a date. Anything formatting this has to say "never" — a blank cell
// reads as a date the app failed to find rather than a thing that has not
// happened.
ok(vQuarry?.lastAt === null, 'and no last-dealt-with date at all', String(vQuarry?.lastAt))

// The two who have been bought from sort above everyone who has not, most recent
// first; the rest fall to the bottom in a stable alphabetical order rather than
// whatever SQLite felt like, or they would be unfindable.
ok(/Sable/.test(vendors[0].name), 'the most recently dealt-with vendor is first', vendors[0].name)
ok(/Bramble/i.test(vendors[1].name), 'then the next', vendors[1].name)
const tailNames = vendors.filter((v) => v.lastAt === null).map((v) => v.name)
const sortedTail = [...tailNames].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
ok(tailNames.length > 1 && JSON.stringify(tailNames) === JSON.stringify(sortedTail), 'and the never-ordered-from run alphabetically', JSON.stringify(tailNames))

// A customer who has never sold us anything is STILL not a vendor. That is the
// line between this list and listSupplierSuggestions, and the reason the Admin
// tile can print this length.
repo.saveCustomer({ name: 'Marlow Collectibles', email: 'marlow@example.com' })
ok(
  !po.listVendors().some((v: { name: string }) => /Marlow/.test(v.name)),
  'a plain customer never becomes a vendor'
)

// Retiring a contact takes them off both lists. A deletion that only takes
// effect on the screen it was performed on is not a deletion.
db.prepare(`UPDATE invoice_customers SET active = 0 WHERE name = 'Quarry Yard'`).run()
ok(
  !po.listVendors().some((v: { name: string }) => /Quarry/.test(v.name)),
  'a retired vendor leaves the vendor list too'
)

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
