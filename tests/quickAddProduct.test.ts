/**
 * Adding a product to the catalog from the line you are already typing.
 *
 * The owner's words: "if a product is not recognized can we just have a quick
 * add button that lets us add the product like we would if we added to it if we
 * were in the catalog."
 *
 * Most of this is a component, and this repository has no DOM to render one in.
 * What IS worth pinning are the two facts that live in two files at once, where
 * changing one and not the other produces something that looks fine and is not:
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

const typeahead = read('src/renderer/src/modules/invoicing/POCatalogTypeahead.tsx')
const inventoryIpc = read('src/main/inventoryIpc.ts')
const productForm = read('src/renderer/src/modules/inventory/ProductFormModal.tsx')
const ui = read('src/renderer/src/components/ui.tsx')

// ---------------------------------------------------------------------------
console.log('\n=== 1. the way out of the dead end exists ===')
// ---------------------------------------------------------------------------

ok(
  /No match in the catalog/.test(typeahead),
  'the empty state is still the one the operator sees'
)
ok(
  /ProductFormModal/.test(typeahead),
  'AND IT OPENS THE CATALOG’S OWN FORM — "like we would if we were in the catalog", not a second one to keep in step'
)
ok(
  /presetName=\{creating\}/.test(typeahead),
  'prefilled with what was already typed, so nobody types the name twice'
)
ok(
  /onSelect\(p\)/.test(typeahead),
  'and the new product goes straight onto the line'
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. the button and the handler agree on who may press it ===')
// ---------------------------------------------------------------------------

// What the SERVER demands to create a product.
const createHandler = /IPC\.invProductCreate[\s\S]{0,400}?requireManage\(\)/.test(inventoryIpc)
ok(createHandler, 'creating a product still goes through requireManage on the main side')
const managePermission = /function requireManage[\s\S]{0,300}?'(inventory\.manage)'/.exec(inventoryIpc)
ok(!!managePermission, 'and requireManage is the inventory.manage gate', String(managePermission?.[1]))

ok(
  /can\('inventory\.manage'\)/.test(typeahead),
  'THE BUTTON IS GATED ON THE SAME PERMISSION, not on the one the search runs under'
)
ok(
  /canCreate && \(/.test(typeahead),
  'and the gate actually wraps the button rather than being computed and ignored'
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
