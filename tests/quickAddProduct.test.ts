/**
 * Adding a product to the catalog from the line you are already typing.
 *
 * The owner's words: "if a product is not recognized can we just have a quick
 * add button that lets us add the product like we would if we added to it if we
 * were in the catalog."
 *
 * Most of this is a component, and this repository has no DOM to render one in.
 * What IS worth pinning are the facts that live in more than one file at once,
 * where changing one and not the others produces something that looks fine and
 * is not:
 *
 *   0. ALL THREE CATALOG SEARCHES OFFER IT, AND ALL THREE OFFER THE SAME ONE.
 *      There are three — sales and purchase orders, logging an incoming
 *      shipment, and adding an item to a stream — and they are separate
 *      components because each reads differently and describes a result
 *      differently. Pasting the escape hatch into all three would be a third
 *      thing to keep in step, and AddItemForm's own header already warns what
 *      that costs. So the dead end is one component, and this checks nobody has
 *      quietly grown a second copy of it.
 *
 *   1. THE BUTTON AND THE HANDLER MUST AGREE ON THE PERMISSION. The catalog
 *      SEARCH runs on `module.invoicing`, deliberately, so somebody who raises
 *      orders can find products without holding the catalog. Creating one needs
 *      `inventory.manage`. Those are different sets of people, and a button
 *      drawn for the difference between them fills in a whole product form and
 *      is then refused by the handler at the end of it. Gating the button on the
 *      permission the handler actually requires is the whole of the fix.
 *
 *   2. ESCAPE MUST CLOSE ONE DIALOG. Every Modal listens on `window`, so this
 *      is the first place in the app with two open at once — and one press ran
 *      both handlers: the quick-add form shut and the half-filled sales order
 *      behind it went too. Everything typed was gone, and nothing on screen
 *      suggested it would be.
 *
 * Source-reading assertions, and they are stated as that. They cannot prove the
 * button works; they can prove it is not being offered to somebody the server
 * will refuse, which is the failure that would reach the floor.
 *
 * Run: npm run test:quick-add
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

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

const empty = read('src/renderer/src/modules/inventory/CatalogEmpty.tsx')
const inventoryIpc = read('src/main/inventoryIpc.ts')

/**
 * Every catalog search in the app. They are separate components because each
 * reads differently and describes a result differently — but the DEAD END has
 * to be the same one, or the button drifts out of step with the permission it
 * is gated on in whichever copy nobody remembered to update.
 */
const SEARCHES: Array<[string, string]> = [
  ['sales and purchase orders', 'src/renderer/src/modules/invoicing/POCatalogTypeahead.tsx'],
  ['logging an incoming shipment', 'src/renderer/src/modules/inventory/IncomingModal.tsx'],
  ['adding an item to a stream', 'src/renderer/src/modules/streaming/AddItemForm.tsx']
]
const productForm = read('src/renderer/src/modules/inventory/ProductFormModal.tsx')
const ui = read('src/renderer/src/components/ui.tsx')

// ---------------------------------------------------------------------------
console.log('\n=== 1. the way out of the dead end exists ===')
// ---------------------------------------------------------------------------

ok(
  /No match in the catalog/.test(empty),
  'the empty state is still the one the operator sees'
)
ok(
  /ProductFormModal/.test(empty),
  'AND IT OPENS THE CATALOG’S OWN FORM — "like we would if we were in the catalog", not a second one to keep in step'
)
ok(
  /presetName=\{creating\}/.test(empty),
  'prefilled with what was already typed, so nobody types the name twice'
)
ok(/onCreated\(p\)/.test(empty), 'and hands the new product back to whoever asked')

// EVERY search offers it, and every one of them offers the SAME one.
for (const [where, file] of SEARCHES) {
  const src = read(file)
  ok(/<CatalogEmpty/.test(src), `${where} offers the quick add`)
  ok(
    !/className="ta-empty">No match in the catalog/.test(src),
    `${where} has no second copy of the dead end left behind`,
    file
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. the button and the handler agree on who may press it ===')
// ---------------------------------------------------------------------------

// What the SERVER demands to create a product.
const createHandler = /IPC\.invProductCreate[\s\S]{0,400}?requireManage\(\)/.test(inventoryIpc)
ok(createHandler, 'creating a product still goes through requireManage on the main side')
const managePermission = /function requireManage[\s\S]{0,300}?'(inventory\.manage)'/.exec(inventoryIpc)
ok(!!managePermission, 'and requireManage is the inventory.manage gate', String(managePermission?.[1]))

ok(
  /can\('inventory\.manage'\)/.test(empty),
  'THE BUTTON IS GATED ON THE SAME PERMISSION, not on the one a search runs under'
)
ok(
  /if \(!can\('inventory\.manage'\)\) \{[\s\S]{0,140}?No match in the catalog[\s\S]{0,40}?\}/.test(empty),
  'and somebody without it still gets the plain sentence, not a button that refuses'
)
// Gated in ONE place. Three copies of this check is three chances for one of
// them to be the loose one.
ok(
  SEARCHES.every(([, f]) => !/inventory\.manage/.test(read(f))),
  'no search re-implements the permission check for itself'
)
// The search's own gate is the looser one, and it must stay looser or the
// feature this typeahead exists for — invoicing without the catalog — breaks.
ok(
  /poCatalogSearch[\s\S]{0,200}?can\('module\.invoicing'\)/.test(read('src/main/purchaseOrdersIpc.ts')),
  'while the SEARCH stays on module.invoicing, which is why the two gates differ at all'
)

// ---------------------------------------------------------------------------
console.log('\n=== 3. the form hands back what it saved ===')
// ---------------------------------------------------------------------------

ok(
  /onSaved: \(product: InventoryProduct\) => void \| Promise<void>/.test(productForm),
  'onSaved carries the product, so the caller does not go looking for it by name'
)
ok(
  /await onSaved\(res\.data\)/.test(productForm),
  'and it is the row the save returned, not a refetch that might find a different one'
)
ok(
  /if \(!res\.ok \|\| !res\.data\)/.test(productForm),
  'a save that returned nothing is an error, not a product-shaped undefined passed on'
)
ok(
  /name: product\?\.name \?\? presetName \?\? ''/.test(productForm),
  'an explicit product still wins over the preset — editing is unaffected'
)

// ---------------------------------------------------------------------------
console.log('\n=== 4. escape closes one dialog, not everything behind it ===')
// ---------------------------------------------------------------------------

ok(/const openModals/.test(ui), 'the modals keep a stack of what is open')
ok(
  /openModals\[openModals\.length - 1\] === token\.current/.test(ui),
  'AND ONLY THE TOPMOST ANSWERS ESCAPE — otherwise one press takes the order behind the form with it'
)
ok(
  /openModals\.push\(me\)/.test(ui) && /openModals\.splice\(at, 1\)/.test(ui),
  'pushed on open and removed on close, so the stack cannot leak a dialog that is gone'
)
ok(
  /lastIndexOf\(me\)/.test(ui),
  'removed by identity rather than by popping, so closing an inner dialog out of order is safe'
)
// The overlay click is safe by DOM nesting — the outer .modal stops the
// mousedown before it reaches the outer overlay — and that only holds while the
// dialog keeps that handler.
ok(
  /onMouseDown=\{\(e\) => e\.stopPropagation\(\)\}/.test(ui),
  'and a click inside a dialog still stops there, which is what keeps a nested overlay click from closing both'
)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
