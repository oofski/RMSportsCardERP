/**
 * The packing slip reaches everybody.
 *
 * The failure this exists to stop, reported from the floor: somebody imports the
 * night's slips on one computer and every other person — and the web app, where
 * most of them now are — opens the walk to "No slip on this machine". The parsed
 * dataset synced perfectly. The paper the whole screen is built around did not,
 * because ship_documents is one row holding several megabytes of BLOB and the
 * relay carries rows in a JSON body it refuses past 8 MB.
 *
 * So the file travels as slices, and the receiver puts it back together. What is
 * asserted here is the part that has to be exactly right: a document assembled
 * from SOME of its slices is a corrupt PDF that opens to a blank pane, which
 * somebody reads as "this order has nothing on it" and seals the box.
 *
 * Run: npm run test:doc-sync
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/docsync-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const shipping = require('../src/main/db/shipping')
const sync = require('../src/main/db/sync')
const { SYNCED_BY_TABLE } = require('../src/main/db/syncTables')
getDb()

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

const db = getDb()

// A stand-in for the night's slips: 1.3 MB of bytes that are not all the same,
// so a slice landing out of order or a boundary being dropped changes the
// result rather than hiding inside a run of zeroes.
const SIZE = 1_300_000
const pdf = Buffer.alloc(SIZE)
for (let i = 0; i < SIZE; i++) pdf[i] = (i * 31 + (i >> 9)) & 0xff

// ---------------------------------------------------------------------------
console.log('=== 1. the slip is sliced on import, and the slices are synced ===')
// ---------------------------------------------------------------------------
const doc = shipping.putShipDocument({
  importId: 'imp_1',
  name: 'packing-slips.pdf',
  pageCount: 97,
  bytes: pdf
})
ok(doc.byteSize === SIZE, 'the document records its size', String(doc.byteSize))
ok(
  shipping.getShipDocumentBytes()?.equals(pdf) === true,
  'and the uploading machine holds the file itself'
)

const parts = db
  .prepare('SELECT seq, total, byte_size, document_id, LENGTH(data) AS n FROM ship_document_parts ORDER BY seq')
  .all() as Array<{ seq: number; total: number; byte_size: number; document_id: string; n: number }>
const expectedParts = Math.ceil(SIZE / shipping.SHIP_DOC_PART_BYTES)
ok(parts.length === expectedParts, `it is cut into ${expectedParts} slices`, String(parts.length))
ok(
  parts.every((p, i) => p.seq === i && p.total === expectedParts),
  'each slice knows its place and how many there are'
)
ok(parts.every((p) => p.document_id === doc.id), 'and which document it belongs to')
// The relay refuses a body over 8 MB and D1 refuses a row over 2 MB. A slice
// must sit inside both with room for the batch to hold more than one.
ok(
  parts.every((p) => p.n < 1_000_000),
  'and is small enough for the relay to carry',
  String(Math.max(...parts.map((p) => p.n)))
)
ok(SYNCED_BY_TABLE.has('ship_document_parts'), 'the slices are in the sync manifest')
ok(!SYNCED_BY_TABLE.has('ship_documents'), 'and the multi-megabyte row still is not')

// ---------------------------------------------------------------------------
console.log('\n=== 2. a second machine rebuilds it from the slices alone ===')
// ---------------------------------------------------------------------------
// Stand in for the receiving machine by taking the rows off the wire and then
// removing the local document, which is exactly the state a laptop that never
// did the import is in: every slice, no file.
const wire = db.prepare('SELECT * FROM ship_document_parts ORDER BY seq').all() as Array<
  Record<string, unknown>
>
db.prepare('DELETE FROM ship_documents').run()
db.prepare('DELETE FROM ship_document_parts').run()
ok(shipping.getShipDocument() === null, 'the receiving machine starts with no slip')

const land = (rows: Array<Record<string, unknown>>, from = 0): void => {
  sync.applyRows(
    rows.map((r, i) => ({
      kind: 'ship_document_parts',
      id: String(r.id),
      seq: from + i + 1,
      updated_at: String(r.created_at),
      deleted: 0 as const,
      data: JSON.stringify(r)
    }))
  )
}

// THE CASE THAT MATTERS. Slices arrive across several batches, because that is
// what a 4 MB push cap means for a document this size. A rebuild that ran on
// what had arrived so far would write a truncated PDF and stop, and every screen
// downstream would show a blank page beside a real order.
land(wire.slice(0, 1))
ok(shipping.rebuildShipDocument() === 0, 'one slice of three rebuilds nothing')
ok(shipping.getShipDocument() === null, 'and leaves the machine honestly empty')

land(wire.slice(1, 2), 1)
ok(shipping.rebuildShipDocument() === 0, 'two of three still rebuilds nothing')

land(wire.slice(2), 2)
ok(shipping.rebuildShipDocument() === 1, 'the last slice completes it')
const rebuilt = shipping.getShipDocumentBytes() as Buffer | null
ok(rebuilt !== null, 'and the file is on this machine now')
ok(rebuilt?.byteLength === SIZE, 'at the right length', String(rebuilt?.byteLength))
ok(rebuilt?.equals(pdf) === true, 'and byte for byte the file that was uploaded')

const meta = shipping.getShipDocument()
ok(meta?.pageCount === 97, 'with its page count', String(meta?.pageCount))
ok(meta?.id === doc.id, 'under the same id, so both machines agree which slip it is')

// ---------------------------------------------------------------------------
console.log('\n=== 3. it settles, and does not churn ===')
// ---------------------------------------------------------------------------
// The rebuild runs after every pull that carried a slice. Rewriting a megabyte
// row every four seconds because nothing changed is the easy way to make a sync
// loop expensive.
ok(shipping.rebuildShipDocument() === 0, 'a second rebuild is a no-op')
ok(shipping.getShipDocumentBytes()?.equals(pdf) === true, 'and the file is untouched')

// ---------------------------------------------------------------------------
console.log('\n=== 4. a truncated slice is refused, not written ===')
// ---------------------------------------------------------------------------
// COUNT(*) = total says every slice ARRIVED. It does not say each one is whole.
// A short slice makes a PDF that opens to a blank pane, which reads on the floor
// as an order with nothing on it.
db.prepare('DELETE FROM ship_documents').run()
db.prepare("UPDATE ship_document_parts SET data = substr(data, 1, 40) WHERE seq = 1").run()
ok(shipping.rebuildShipDocument() === 0, 'a short slice rebuilds nothing')
ok(shipping.getShipDocument() === null, 'and no half-file is left behind')

// ---------------------------------------------------------------------------
console.log('\n=== 5. putting the slip away takes the slices with it ===')
// ---------------------------------------------------------------------------
// Otherwise the next pull hands the slices back and rebuilds a document somebody
// deliberately deleted.
db.prepare('DELETE FROM ship_document_parts').run()
shipping.putShipDocument({ importId: 'imp_2', name: 'again.pdf', pageCount: 4, bytes: pdf })
ok(
  (db.prepare('SELECT COUNT(*) AS n FROM ship_document_parts').get() as { n: number }).n ===
    expectedParts,
  'a new import replaces the slices rather than adding to them'
)
shipping.clearShipDocument()
ok(shipping.getShipDocument() === null, 'clearing removes the document')
ok(
  (db.prepare('SELECT COUNT(*) AS n FROM ship_document_parts').get() as { n: number }).n === 0,
  'and every slice with it'
)
ok(shipping.rebuildShipDocument() === 0, 'so nothing brings it back')

// ---------------------------------------------------------------------------
console.log('\n=== 6. the outbox stops before the relay would refuse the body ===')
// ---------------------------------------------------------------------------
// 300 slices in one push is 200 MB against a relay that refuses anything over 8.
shipping.putShipDocument({ importId: 'imp_3', name: 'big.pdf', pageCount: 97, bytes: pdf })
const queued = db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get() as { n: number }
ok(queued.n >= expectedParts, 'the slices are queued to go up', String(queued.n))
const batch = sync.takeOutbox(300) as Array<{ data: string | null }>
const bodyBytes = batch.reduce((n, r) => n + (r.data ? r.data.length : 0), 0)
ok(bodyBytes <= 8 * 1024 * 1024, 'and one push stays inside the relay limit', String(bodyBytes))
ok(batch.length > 0, 'while still sending something', String(batch.length))

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
