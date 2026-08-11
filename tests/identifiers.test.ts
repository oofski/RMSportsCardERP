/**
 * Which products the app cannot find by machine.
 *
 * @shared/identifiers decides what the inventory dashboard's "Missing
 * identifiers" tile counts and what the screen behind it lists. It is pure, so
 * all of it can be driven from objects — and it is worth driving hard, because
 * every defect in a classifier like this one produces a PLAUSIBLE screen rather
 * than an error. A tile reading 184 when the truth is 198, a "neither" bucket
 * that is quietly the intersection of the other two, a whitespace SKU counted as
 * a SKU: none of those look wrong, and all of them send somebody away believing
 * a product can be scanned when it cannot.
 *
 * What is pinned here, and how each fails if it is not:
 *
 *   1. EMPTY MEANS EMPTY, IN ALL THREE OF ITS SPELLINGS. `sku` is
 *      `TEXT NOT NULL DEFAULT ''` and `upc` is nullable, so NULL, '' and '   '
 *      all arrive from different write paths meaning the same thing to a
 *      person. Trim before judging or the tile reports a number nobody can
 *      reproduce by looking at the field.
 *
 *   2. A SKU THAT IDENTIFIES NOTHING IS NOT A SKU. `BOX` is a placeholder 27
 *      catalog rows share, and the catalog importer has always refused to match
 *      on it. If this file disagreed, those rows would report as complete on the
 *      one screen built to find them — and it is the SAME function, not a
 *      second copy, which is what section 5 checks.
 *
 *   3. THE THREE STATES ARE MUTUALLY EXCLUSIVE AND THEY ADD UP. 'both' is not
 *      the intersection. If it were, the three numbers on the tile would double-
 *      count and the operator would be left reconciling them by hand.
 *
 *   4. THE COUNT AND THE LIST CANNOT DISAGREE. They are one rule over one array;
 *      this proves it by counting the list.
 *
 *   5. CLASSIFYING NEVER TOUCHES THE PRODUCT. This is a view, not a category: a
 *      product listed under "Neither" is still a Football product afterwards,
 *      with the same category, name and object identity it went in with.
 *
 * EVERY PRODUCT NAME AND CODE BELOW IS INVENTED. This repository is public.
 *
 * Run: npm run test:identifiers
 */
import {
  MIN_SKU_LENGTH,
  PLACEHOLDER_SKUS,
  countIdentifierGaps,
  hasUpc,
  identifierGap,
  isMatchableSku,
  productsMissingIdentifiers,
  skuGap,
  type ProductIdentifiers
} from '../src/shared/identifiers'
import { isMatchableSku as importerRule } from '../src/main/db/inventoryCatalogV3'

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
console.log('=== 1. what counts as empty ===')
// ---------------------------------------------------------------------------
// The three spellings of "the operator left it blank", one per write path:
// NULL from a catalog seed, '' from ScanNewProduct, whitespace from a paste.
ok(skuGap(null) === 'blank', 'a NULL SKU is blank')
ok(skuGap(undefined) === 'blank', 'so is a missing one')
ok(skuGap('') === 'blank', 'so is the empty string the schema defaults to')
ok(skuGap('   ') === 'blank', 'and so is a SKU of three spaces — trimmed before judging')
ok(skuGap('\t\n ') === 'blank', 'including the whitespace a pasted cell brings with it')

ok(!hasUpc(null), 'a NULL barcode is no barcode')
ok(!hasUpc(undefined), 'nor is a missing one')
ok(!hasUpc(''), 'nor an empty string')
ok(!hasUpc('  '), 'nor two spaces')
ok(hasUpc('887521144600'), 'a real barcode is one')
// No format check on purpose: @shared/upc already folds UPC-E, EAN-13, GTIN-14
// and Code-128 shop labels onto one key, and this screen must not tell the
// operator their own printed label is "wrong".
ok(hasUpc('RM-INTERNAL-0042'), 'and so is a Code-128 internal shop label')
ok(hasUpc('  887521144600  '), 'padding does not stop a real barcode being one')

// ---------------------------------------------------------------------------
console.log('\n=== 2. a SKU that identifies nothing is not a SKU ===')
// ---------------------------------------------------------------------------
ok(skuGap('BOX') === 'placeholder', '"BOX" is a placeholder, not an identifier')
ok(skuGap('box') === 'placeholder', 'and the check is case-insensitive')
ok(skuGap('  n/a ') === 'placeholder', 'so is "n/a", padding and all')
ok(skuGap('NONE') === 'placeholder', 'and "NONE"')
ok(skuGap('-') === 'placeholder', 'and a lone dash')
ok(skuGap('12') === 'placeholder', `and anything under ${MIN_SKU_LENGTH} characters`)
ok(skuGap('6578') === null, 'a real numeric SKU identifies something')
ok(skuGap('100-10623') === null, 'so does a hyphenated vendor SKU')
ok(skuGap('  FS6260  ') === null, 'and an alphanumeric one that arrived padded')
ok(isMatchableSku('6578') && !isMatchableSku('BOX'), 'isMatchableSku is skuGap read as a yes/no')
ok(PLACEHOLDER_SKUS.has('BOX'), 'the placeholder set is exported so callers can say WHY')

// ---------------------------------------------------------------------------
console.log('\n=== 3. the three states, and that they are three ===')
// ---------------------------------------------------------------------------
ok(identifierGap({ sku: '6578', upc: '887521144600' }) === null, 'both present is not a gap')
ok(identifierGap({ sku: '', upc: '887521144600' }) === 'sku', 'no SKU, has barcode → sku')
ok(identifierGap({ sku: '6578', upc: null }) === 'upc', 'has SKU, no barcode → upc')
ok(identifierGap({ sku: '', upc: null }) === 'both', 'neither → both')
// The case the whole placeholder rule exists for: the field is not empty, and
// the product still cannot be told apart from twenty-six others.
ok(identifierGap({ sku: 'BOX', upc: null }) === 'both', 'a placeholder SKU and no barcode is "both"')
ok(identifierGap({ sku: 'BOX', upc: '887521144600' }) === 'sku', 'a placeholder SKU alone is "sku"')

// ---------------------------------------------------------------------------
console.log('\n=== 4. counting a catalog ===')
// ---------------------------------------------------------------------------
/** A stand-in catalog. Shapes, not real products — the repo is public. */
interface Row extends ProductIdentifiers {
  id: string
  category: string
}
const catalog: Row[] = [
  { id: 'a', category: 'Football', sku: '6578', upc: '000000000001' }, // fine
  { id: 'b', category: 'Football', sku: '6579', upc: '000000000002' }, // fine
  { id: 'c', category: 'Baseball', sku: '', upc: '000000000003' }, // no SKU
  { id: 'd', category: 'Baseball', sku: '   ', upc: '000000000004' }, // no SKU
  { id: 'e', category: 'Pokemon', sku: 'BOX', upc: '000000000005' }, // no SKU (placeholder)
  { id: 'f', category: 'Football', sku: '6580', upc: null }, // no barcode
  { id: 'g', category: 'Hockey', sku: '6581', upc: '' }, // no barcode
  { id: 'h', category: 'Hockey', sku: '6582', upc: '   ' }, // no barcode
  { id: 'i', category: 'Soccer', sku: '', upc: null }, // neither
  { id: 'j', category: 'Soccer', sku: 'BOX', upc: '  ' } // neither
]
const counts = countIdentifierGaps(catalog)
ok(counts.sku === 3, 'three products have a barcode and no SKU', String(counts.sku))
ok(counts.upc === 3, 'three have a SKU and no barcode', String(counts.upc))
ok(counts.both === 2, 'two have neither', String(counts.both))
ok(counts.total === 8, 'eight products need work in all', String(counts.total))
// The property that makes the tile readable. If 'both' were the intersection
// rather than its own state, this would be 10 against a list of 8.
ok(
  counts.sku + counts.upc + counts.both === counts.total,
  'and the three states add up to the total — none of them overlaps'
)
ok(counts.total === catalog.length - 2, 'the two complete products are counted nowhere')
ok(
  countIdentifierGaps([]).total === 0,
  'an empty catalog reports zero rather than throwing'
)

// ---------------------------------------------------------------------------
console.log('\n=== 5. the count and the list are the same rule ===')
// ---------------------------------------------------------------------------
const all = productsMissingIdentifiers(catalog)
ok(all.length === counts.total, 'the list is exactly as long as the tile promised', String(all.length))
ok(
  all.filter((r) => r.gap === 'both').length === counts.both &&
    all.filter((r) => r.gap === 'sku').length === counts.sku &&
    all.filter((r) => r.gap === 'upc').length === counts.upc,
  'and each state holds exactly the number the tile printed'
)
ok(
  productsMissingIdentifiers(catalog, 'both').every((r) => r.gap === 'both'),
  'a narrowed list holds only that state'
)
ok(
  productsMissingIdentifiers(catalog, 'sku').length === counts.sku,
  'and holds all of it'
)
ok(
  !all.some((r) => r.product.id === 'a' || r.product.id === 'b'),
  'a product with both identifiers is never listed'
)
// Worst first: a product that can be neither scanned nor billed leads, because
// it is the one the operator should spend their first ten minutes on.
ok(all[0].gap === 'both' && all[1].gap === 'both', 'the two worst rows come first')
ok(
  all.map((r) => r.gap).join(',') === 'both,both,sku,sku,sku,upc,upc,upc',
  'then no-SKU, then no-barcode',
  all.map((r) => r.gap).join(',')
)
// Stable inside a state, so the row somebody is typing into does not jump when
// a sibling row is saved and the list re-derives.
ok(
  all
    .filter((r) => r.gap === 'sku')
    .map((r) => r.product.id)
    .join('') === 'cde',
  'and catalog order survives inside each state'
)
// Why the row is listed, carried on the row: a SKU field reading "BOX" has to
// explain itself or the screen looks wrong.
ok(
  all.find((r) => r.product.id === 'e')?.sku === 'placeholder',
  'a placeholder SKU is reported as a placeholder, not as blank'
)
ok(all.find((r) => r.product.id === 'c')?.sku === 'blank', 'and a blank one as blank')
ok(all.find((r) => r.product.id === 'f')?.sku === null, 'a real SKU reports no SKU problem at all')

// ---------------------------------------------------------------------------
console.log('\n=== 6. this is a view, not a category ===')
// ---------------------------------------------------------------------------
// The whole design rests on this: a product with a data gap is still whatever
// kind of product it was. Nothing here may write, re-file or copy it.
const before = catalog.map((r) => ({ ...r }))
countIdentifierGaps(catalog)
productsMissingIdentifiers(catalog)
ok(
  catalog.every((r, i) => JSON.stringify(r) === JSON.stringify(before[i])),
  'classifying leaves every product byte-for-byte as it was'
)
ok(
  all.every((r) => catalog.includes(r.product)),
  'the rows hand back the SAME objects, not copies the caller would edit in vain'
)
ok(
  all.find((r) => r.product.id === 'i')?.product.category === 'Soccer',
  'and a product with NEITHER identifier is still filed under its own category'
)

// ---------------------------------------------------------------------------
console.log('\n=== 7. the importer and the dashboard agree ===')
// ---------------------------------------------------------------------------
// db/inventoryCatalogV3.ts re-exports this rather than keeping its own copy.
// Two copies would be two things that must change together forever, and the
// day they drift the import silently swallows a product while the dashboard
// reports it as fully identified.
ok(importerRule === isMatchableSku, 'the catalog importer matches on the very same function')
for (const sku of ['BOX', 'n/a', '12', '6578', '100-10623', '']) {
  ok(importerRule(sku) === isMatchableSku(sku), `and answers identically for ${JSON.stringify(sku)}`)
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
