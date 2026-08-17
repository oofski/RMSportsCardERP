/**
 * The Gusto Smart Import sheet, and the one property that makes it safe.
 *
 * ## Gusto's own two rules, which are not symmetrical
 *
 *   · "Zeros override previously entered information — if your spreadsheet has
 *     any, the zeros will replace any existing info."
 *   · "Blank values have no impact on previously entered information."
 *
 * A zero is therefore an ERASE instruction, not a way of saying "nothing to
 * report". That asymmetry is the whole subject of this file, because the export
 * had no way to express the difference: `toFixed(2)` renders no-hours and
 * zero-hours identically, so every upload wrote `0.00` into Overtime for every
 * employee — wiping any overtime entered or corrected inside Gusto, silently,
 * from a file that looked completely ordinary.
 *
 * Worse at the row level: the caller hands the builder EVERY employee on the
 * books, not every employee who clocked in. So a salaried manager, somebody on
 * leave, and anybody whose hours are keyed straight into Gusto all got a row of
 * zeros — the export erasing the hours of precisely the people it knew least
 * about.
 *
 * What is pinned here:
 *
 *   1. No cell that this app did not measure is ever written as zero.
 *   2. Real figures still travel, unchanged and to two decimals.
 *   3. An employee with nothing to report is left out of the file entirely.
 *   4. The blank test is on the RENDERED figure, so a few seconds of drift
 *      cannot smuggle a destructive "0.00" through.
 *
 * Every name here is invented.
 *
 * Run: npm run test:gusto
 */
/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const { gustoCsv, computePayroll } = require('../src/main/services/csv')

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

const START = '2026-08-03T00:00:00.000Z'
const END = '2026-08-16T23:59:59.000Z'

const emp = (first: string, companyId: string): any => ({
  id: `id_${companyId}`,
  firstName: first,
  lastName: 'Invented',
  email: `${companyId.toLowerCase()}@example.invalid`,
  companyId
})

const row = (first: string, companyId: string, regular: number, overtime: number): any => ({
  employee: emp(first, companyId),
  totals: {
    regularMinutes: regular,
    overtimeMinutes: overtime,
    totalMinutes: regular + overtime
  }
})

/** The sheet as a grid, header included. Cells are raw — '' means blank. */
const grid = (csv: string): string[][] =>
  csv.split('\r\n').filter((l) => l.length > 0).map((l) => l.split(','))

// ---------------------------------------------------------------------------
console.log('=== 1. a zero is never written where nothing was measured ===')
// ---------------------------------------------------------------------------
// The ordinary fortnight: somebody worked their hours and did no overtime.
const plain = grid(gustoCsv([row('Ada', 'RM-100', 40 * 60, 0)], START, END))
ok(plain.length === 2, 'the sheet has a header and one row', String(plain.length))

const head = plain[0]
const iReg = head.indexOf('Regular hours')
const iOt = head.indexOf('Overtime hours')
const iTot = head.indexOf('Total hours')
ok(iReg >= 0 && iOt >= 0 && iTot >= 0, 'the hours columns are named', head.join('|'))

ok(plain[1][iReg] === '40.00', 'the regular hours are written as measured', plain[1][iReg])
ok(
  plain[1][iOt] === '',
  'AND THE OVERTIME CELL IS BLANK, NOT 0.00 — a zero would erase what Gusto holds',
  JSON.stringify(plain[1][iOt])
)
ok(plain[1][iTot] === '40.00', 'while the total, which is real, still travels', plain[1][iTot])

// The blank has to be a genuinely empty cell, not a quoted empty string or a
// space — either of those is a value, and Gusto would treat it as one.
ok(
  gustoCsv([row('Ada', 'RM-100', 40 * 60, 0)], START, END).includes(',,'),
  'the blank is an empty cell, with nothing in it at all'
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. real overtime is not suppressed ===')
// ---------------------------------------------------------------------------
// The mirror of section 1, and the assertion that stops "write blanks" being
// implemented as "write blanks".
const ot = grid(gustoCsv([row('Ben', 'RM-200', 40 * 60, 6 * 60 + 30)], START, END))
ok(ot[1][iReg] === '40.00', 'regular hours survive', ot[1][iReg])
ok(ot[1][iOt] === '6.50', 'AND REAL OVERTIME IS WRITTEN, to the half hour', ot[1][iOt])
ok(ot[1][iTot] === '46.50', 'with the total agreeing', ot[1][iTot])

// ---------------------------------------------------------------------------
console.log('\n=== 3. an employee with nothing to report is left out ===')
// ---------------------------------------------------------------------------
// The caller passes every employee on the books. A salaried manager, somebody
// on leave, and anybody keyed straight into Gusto all arrive here with zeros —
// and a row of zeros for them is the export erasing hours it never measured.
const mixed = grid(
  gustoCsv(
    [
      row('Ada', 'RM-100', 40 * 60, 0),
      row('Quiet', 'RM-900', 0, 0),
      row('Ben', 'RM-200', 32 * 60, 0)
    ],
    START,
    END
  )
)
ok(mixed.length === 3, 'three rows in, two rows out — the header and the two who worked', String(mixed.length))
const names = mixed.slice(1).map((r) => r[0])
ok(names.join(',') === 'Ada,Ben', 'the two who worked are both there', names.join(','))
ok(
  !gustoCsv([row('Quiet', 'RM-900', 0, 0)], START, END).includes('RM-900'),
  'AND THE ONE WHO DID NOT IS NOT IN THE FILE AT ALL'
)

// A file with nobody in it is a header and nothing else, not a file of zeros.
const empty = gustoCsv([row('Quiet', 'RM-900', 0, 0)], START, END)
ok(grid(empty).length === 1, 'an export where nobody worked is just the header', String(grid(empty).length))
ok(!empty.includes('0.00'), 'and contains no zero anywhere', empty)

// ---------------------------------------------------------------------------
console.log('\n=== 4. the blank test is on what PRINTS, not on the raw minutes ===')
// ---------------------------------------------------------------------------
// Six seconds of clock drift is a real, non-zero number of minutes that formats
// as "0.00" — anything under eighteen seconds does. Testing the raw value would
// let that through as a destructive zero in order to report a fraction of a
// minute nobody is paid for.
const drift = grid(gustoCsv([row('Cai', 'RM-300', 40 * 60, 0.1)], START, END))
ok(
  drift[1][iOt] === '',
  'A FIGURE THAT ROUNDS TO ZERO IS BLANK TOO — it must not erase anything either',
  JSON.stringify(drift[1][iOt])
)

// And the first figure that genuinely rounds to something is written.
// Eighteen seconds is exactly 0.005h, which rounds up — the first figure that
// survives.
const smallest = grid(gustoCsv([row('Cai', 'RM-300', 40 * 60, 0.3)], START, END))
ok(
  smallest[1][iOt] === '0.01',
  'while the smallest figure that does round up is reported',
  smallest[1][iOt]
)

// ---------------------------------------------------------------------------
console.log('\n=== 5. nothing else about the sheet moved ===')
// ---------------------------------------------------------------------------
// The columns are what Gusto maps on, so they are pinned by name and order —
// a rename here is a silent import failure, not a compile error.
ok(
  head.join(',') ===
    'First name,Last name,Employee email,Company ID,Regular hours,Overtime hours,Total hours,Pay period start,Pay period end',
  'the header row is unchanged',
  head.join(',')
)
ok(plain[1][0] === 'Ada' && plain[1][1] === 'Invented', 'the name columns still identify the person')
ok(plain[1][3] === 'RM-100', 'the company ID still travels', plain[1][3])
ok(
  plain[1][head.indexOf('Pay period start')] === '2026-08-03' ||
    plain[1][head.indexOf('Pay period start')] === '2026-08-02',
  'and the pay period is a plain local date',
  plain[1][head.indexOf('Pay period start')]
)
// CRLF, because a Windows spreadsheet is the thing that opens this.
ok(gustoCsv([row('Ada', 'RM-100', 60, 0)], START, END).includes('\r\n'), 'the file is still CRLF')

// The other export is a REPORT for a person to read, not an import, so zeros
// there mean "zero" and are not touched by any of this.
ok(typeof computePayroll === 'function', 'and computePayroll is untouched')

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
