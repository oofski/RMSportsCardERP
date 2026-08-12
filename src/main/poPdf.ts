/**
 * Purchase-order PDF export.
 *
 * The receipt used to be "printed" with window.print() and a stack of
 * @media print rules that hid the whole app and un-hid `.po-receipt`. That is
 * fragile by construction: the receipt lives inside a modal inside the app
 * shell, which is a fixed-height overflow:hidden scroll container, so the print
 * layout was clipped to one viewport and long POs came out blank or truncated.
 *
 * So this does not print the screen at all. It builds a self-contained A4
 * document from the PO's data and renders it in an offscreen window, which
 * means the output is a real, paginated PDF whose layout owes nothing to the
 * app's stylesheet or how far the modal happened to be scrolled.
 */
import { BrowserWindow, dialog, shell } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { PurchaseOrderDetail } from '@shared/types'
import { displayOrderNumber } from '@shared/purchaseOrders'
import { productThumbnails } from './db/inventory'
import { lookupPartyAddress } from './db/purchaseOrders'
import { RM_LOGO_DATA_URI } from './brand'
import { shipMeta } from './freightPdf'

const money = (n: number): string =>
  (Number.isFinite(n) ? n : 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const date = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

/** Everything interpolated below is user-entered, so nothing goes in raw. */
function esc(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const STATUS_LABEL: Record<string, string> = {
  ordered: 'Ordered',
  paid: 'Paid',
  received: 'Received',
  cancelled: 'Cancelled'
}

/**
 * A print document, not a screen. Deliberately plain: black on white, real
 * points, and a table head that repeats across pages so a 40-line PO is
 * readable on paper rather than losing its column headings after page one.
 */
/**
 * Every destination this order's units are going to, and every supplier they
 * are bought from — after inheritance, in line order, deduped.
 *
 * Read off the detail rather than re-derived from the header: the header is only
 * the DEFAULT now, and a line or an allocation may say otherwise.
 */
function routingOf(po: PurchaseOrderDetail): { destinations: string[]; suppliers: string[] } {
  const destinations = new Set<string>()
  const suppliers = new Set<string>()
  for (const line of po.lines) {
    if (line.allocations.length) {
      for (const a of line.allocations) {
        destinations.add(a.destination)
        if (a.supplier) suppliers.add(a.supplier)
      }
    } else {
      destinations.add(line.destination ?? po.location)
      if (line.supplier ?? po.supplier) suppliers.add((line.supplier ?? po.supplier) as string)
    }
  }
  if (destinations.size === 0) destinations.add(po.location)
  if (suppliers.size === 0 && po.supplier) suppliers.add(po.supplier)
  return { destinations: [...destinations], suppliers: [...suppliers] }
}

/**
 * A print document, not a screen. Deliberately plain: black on white, real
 * points, and a table head that repeats across pages so a 40-line PO is
 * readable on paper rather than losing its column headings after page one.
 */
export function buildPoHtml(po: PurchaseOrderDetail): string {
  // Product photos, keyed by product id. Read once for the whole document —
  // these are base64 data URLs and re-reading per line would balloon a 40-line
  // PO. A product with no photo simply gets no cell content.
  const thumbs = productThumbnails()

  // THE NUMBER ON THE DOCUMENT, which is not always the number in the database.
  // purchase_orders.po_number stores PO-0042 for a dropship too — one counter,
  // no gaps, no branches — and the Drop spelling is computed here and stored
  // nowhere.
  const number = displayOrderNumber(po.poNumber, po.orderKind)
  const { destinations, suppliers } = routingOf(po)
  const drop = po.orderKind === 'drop' || po.orderKind === 'mixed'
  /**
   * The extra columns appear ONLY when the document would otherwise be
   * ambiguous — more than one destination, or more than one supplier.
   *
   * A single-supplier, single-destination order — which is every purchase order
   * raised before this feature — renders the existing five-column table,
   * unchanged, because two columns repeating the same two words on every row
   * make a document harder to read, not easier.
   */
  const routed = destinations.length > 1 || suppliers.length > 1
  const shipTo = destinations.length > 1 ? 'Multiple — see lines' : destinations[0]
  const address = destinations.length === 1 ? lookupPartyAddress(destinations[0]) : null
  const span = routed ? 7 : 5

  const rows = po.lines
    .map((l, i) => {
      const dest = l.destination ?? (l.allocations.length ? 'Multiple' : po.location)
      const supplier = l.supplier ?? po.supplier ?? (l.allocations.length ? 'Multiple' : '')
      // A split line prints its allocations underneath, with no repeated money:
      // the quantity, who it comes from and where it goes are what the supplier
      // needs, and repeating the price per row invites it being read as an extra
      // charge.
      const splits = routed
        ? l.allocations
            .map(
              (a) => `
      <tr class="alloc">
        <td></td>
        <td class="sub">↳ ${a.quantity} × ${esc(a.destination)}</td>
        <td class="num sub">${a.quantity}</td>
        <td class="sub">${esc(a.supplier ?? supplier ?? '—')}</td>
        <td class="sub">${esc(a.destination)}</td>
        <td></td>
        <td></td>
      </tr>`
            )
            .join('')
        : ''
      return `
      <tr>
        <td class="num">${i + 1}</td>
        <td>
          <div class="item">
            <div class="itxt">
              <div class="pname">${esc(l.productName)}</div>
              ${l.sku ? `<div class="psku">${esc(l.sku)}</div>` : ''}
            </div>
            ${thumbs[l.productId] ? `<img class="pimg" src="${thumbs[l.productId]}" alt="">` : ''}
          </div>
        </td>
        <td class="num">${l.quantity}</td>
        ${routed ? `<td>${esc(supplier || '—')}</td><td>${esc(dest)}</td>` : ''}
        <td class="num">${money(l.unitPrice)}</td>
        <td class="num strong">${money(l.quantity * l.unitPrice)}</td>
      </tr>${splits}`
    })
    .join('')

  // The whole order, drop lines included — the same figure it has always been.
  const units = po.lines.reduce((sum, l) => sum + l.quantity, 0)

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(number)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 10.5pt;
    color: #111;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .head { display: flex; align-items: center; gap: 12pt; border-bottom: 2px solid #111; padding-bottom: 10pt; }
  .head .logo { width: 46pt; height: 46pt; flex-shrink: 0; }
  .head h1 { margin: 0 0 2pt; font-size: 19pt; letter-spacing: -0.3pt; }
  .head .org { font-size: 9pt; color: #555; text-transform: uppercase; letter-spacing: 1pt; }
  .head .right { margin-left: auto; text-align: right; }
  .status {
    display: inline-block; padding: 3pt 9pt; border-radius: 999pt;
    border: 1pt solid #111; font-size: 9pt; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.5pt;
  }
  .paidmark {
    display: block; margin-top: 5pt; font-size: 8pt; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.5pt; color: #060;
  }
  .status.cancelled { border-color: #b00; color: #b00; }
  .status.received { border-color: #060; color: #060; }

  .meta { display: flex; gap: 26pt; margin: 12pt 0 14pt; }
  .meta div { font-size: 9.5pt; }
  .meta .k { color: #666; text-transform: uppercase; letter-spacing: 0.6pt; font-size: 8pt; }
  .meta .v { font-weight: 600; margin-top: 1pt; }

  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }        /* repeat on every page */
  tr { page-break-inside: avoid; }
  th {
    text-align: left; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.6pt;
    color: #444; border-bottom: 1pt solid #999; padding: 0 6pt 5pt;
  }
  td { padding: 7pt 6pt; border-bottom: 0.5pt solid #ddd; vertical-align: top; }
  .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  th.num { text-align: right; }
  .strong { font-weight: 700; }
  .pname { font-weight: 600; }
  .psku { font-size: 8.5pt; color: #666; margin-top: 1pt; }
  /* The product photo sits to the RIGHT of the name, inside the item cell, so
     the qty/unit/amount columns stay in the same place whether or not a product
     has a picture. */
  .item { display: flex; align-items: flex-start; gap: 8pt; }
  .itxt { flex: 1 1 auto; min-width: 0; }
  .pimg {
    flex: 0 0 auto; width: 34pt; height: 34pt; object-fit: cover;
    border: 0.5pt solid #ddd; border-radius: 3pt; background: #fafafa;
  }

  .totals { margin-top: 12pt; display: flex; }
  .totals .box { margin-left: auto; min-width: 180pt; }
  .totals .line { display: flex; justify-content: space-between; padding: 4pt 0; font-size: 10pt; }
  .totals .grand {
    border-top: 1.5pt solid #111; margin-top: 4pt; padding-top: 7pt;
    font-size: 13pt; font-weight: 700;
  }
  /* The dropship banner and the address block under it. Bordered rather than
     filled, so it survives a black-and-white printer and a fax. */
  .drop-banner {
    margin: 12pt 0 10pt; padding: 8pt 10pt; border: 1.5pt solid #111; border-radius: 3pt;
  }
  .drop-banner .t { font-size: 11pt; font-weight: 700; letter-spacing: 0.6pt; text-transform: uppercase; }
  .drop-banner .s { font-size: 9.5pt; margin-top: 3pt; }
  .shipto { margin: 0 0 14pt; font-size: 10pt; }
  .shipto .k { color: #666; text-transform: uppercase; letter-spacing: 0.6pt; font-size: 8pt; margin-bottom: 3pt; }
  .shipto .who { font-weight: 700; font-size: 11.5pt; }
  .shipto .addr { margin-top: 2pt; white-space: pre-line; }
  .alloc td { border-bottom: 0.5pt dotted #ddd; padding-top: 3pt; padding-bottom: 3pt; }
  .sub { color: #555; font-size: 9pt; }

  .notes { margin-top: 18pt; font-size: 9.5pt; }
  .notes .k { color: #666; text-transform: uppercase; letter-spacing: 0.6pt; font-size: 8pt; margin-bottom: 3pt; }
  .notes p { margin: 0; white-space: pre-wrap; }
  .foot { margin-top: 22pt; padding-top: 8pt; border-top: 0.5pt solid #ccc; font-size: 8pt; color: #777; }
</style></head>
<body>
  <div class="head">
    <img class="logo" src="${RM_LOGO_DATA_URI}" alt="RM Sportscards">
    <div>
      <div class="org">RM Sportscards</div>
      <h1>${esc(number)}</h1>
    </div>
    <div class="right">
      <span class="status ${esc(po.status)}">${esc(STATUS_LABEL[po.status] ?? po.status)}</span>
      ${
        // The stage says where the order is; this says whether it has been paid
        // for, and since stock often lands before the invoice is settled those
        // are different facts. Printed under the stage rather than beside it so
        // a long status word cannot push it off the edge of the page.
        po.paidAt ? `<span class="paidmark">Paid ${date(po.paidAt)}</span>` : ''
      }
    </div>
  </div>

  <div class="meta">
    <div><div class="k">Supplier</div><div class="v">${esc(po.supplier || '—')}</div></div>
    <div><div class="k">Ordered</div><div class="v">${date(po.orderedAt ?? po.createdAt)}</div></div>
    <div><div class="k">Ship to</div><div class="v">${esc(shipTo)}</div></div>
    ${shipMeta(po, { key: 'k', value: 'v' })}
  </div>

  ${
    drop
      ? `<div class="drop-banner">
    <div class="t">Drop ship</div>
    <div class="s">Ship directly to the address below. Do not ship to RM Sportscards.</div>
  </div>
  <div class="shipto">
    <div class="k">Ship to</div>
    <div class="who">${esc(shipTo)}</div>
    ${address ? `<div class="addr">${esc(address.join('\n'))}</div>` : ''}
  </div>`
      : ''
  }

  <table>
    <thead>
      <tr>
        <th class="num" style="width:22pt">#</th>
        <th>Item</th>
        <th class="num" style="width:46pt">Qty</th>
        ${routed ? '<th style="width:90pt">Supplier</th><th style="width:90pt">Destination</th>' : ''}
        <th class="num" style="width:70pt">Unit</th>
        <th class="num" style="width:80pt">Amount</th>
      </tr>
    </thead>
    <tbody>${rows || `<tr><td colspan="${span}" style="color:#777;padding:14pt 6pt">No lines on this purchase order.</td></tr>`}</tbody>
  </table>

  <div class="totals">
    <div class="box">
      <div class="line"><span>Units</span><span class="num">${units}</span></div>
      <div class="line grand"><span>Total</span><span class="num">${money(po.total)}</span></div>
    </div>
  </div>

  ${po.notes ? `<div class="notes"><div class="k">Notes</div><p>${esc(po.notes)}</p></div>` : ''}

  <div class="foot">${esc(number)} · generated ${date(new Date().toISOString())} · RM Sportscards</div>
</body></html>`
}

/**
 * Render the document to PDF bytes. The window is offscreen and always
 * destroyed, including on failure — a leaked BrowserWindow keeps the whole app
 * alive after its last real window closes.
 */
async function renderPdf(html: string): Promise<Buffer> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, javascript: false, sandbox: true }
  })
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    return await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { marginType: 'default' }
    })
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

/** What the document turned into, and what to call the file it lands in. */
export interface RenderedDocument {
  bytes: Buffer
  extension: '.pdf' | '.html'
  mime: string
}

/**
 * How the A4 document becomes bytes.
 *
 * Electron prints it with Chromium, which is the only thing in this app that
 * can produce a PDF. A headless server has no Chromium and never will — a
 * container carrying a browser to lay out one purchase order is a hundred
 * megabytes and a monthly CVE feed for a feature the viewer's own browser
 * already has.
 *
 * So the server installs a renderer that hands back the SAME html and lets the
 * browser print it (File → Print → Save as PDF). The document is
 * byte-identical; only who paginates it changes. Installed as a hook rather
 * than branched on an environment variable so the desktop path cannot take the
 * server's route by accident — nothing sets it unless a server is running.
 */
export type DocumentRenderer = (html: string) => Promise<RenderedDocument>

let renderDocument: DocumentRenderer = async (html) => ({
  bytes: await renderPdf(html),
  extension: '.pdf',
  mime: 'application/pdf'
})

export function setDocumentRenderer(next: DocumentRenderer): void {
  renderDocument = next
}

/**
 * The same renderer, for other documents.
 *
 * Exported so the invoice PDF goes through the ONE hook the server replaces.
 * A second copy of this indirection is a second thing to remember when a
 * headless build has no Chromium — and the failure mode of forgetting is a
 * server that throws on a button somebody presses in front of a customer.
 */
export function renderDocumentForExport(html: string): Promise<RenderedDocument> {
  return renderDocument(html)
}

/** What this document is called: Drop-0042 for a pure dropship, PO-0042 else. */
export function documentName(po: PurchaseOrderDetail): string {
  return displayOrderNumber(po.poNumber, po.orderKind)
}

export interface PoPdfResult {
  ok: boolean
  path?: string
  canceled?: boolean
  error?: string
}

/**
 * Open the PO as a PDF: render it, drop it in temp, and hand it to the OS
 * viewer. Nothing is saved to a chosen location — this is the "let me look at
 * it / print it from the viewer" path, which is what the Print button was
 * always trying and failing to be.
 */
export async function openPoPdf(po: PurchaseOrderDetail): Promise<PoPdfResult> {
  try {
    const doc = await renderDocument(buildPoHtml(po))
    // The FILENAME follows the document, so a dropship saved to a desktop is
    // findable by the number printed on it.
    const file = join(tmpdir(), `${documentName(po).replace(/[^\w.-]/g, '_')}${doc.extension}`)
    writeFileSync(file, doc.bytes)
    const err = await shell.openPath(file)
    // openPath resolves to a NON-EMPTY string when it failed — an empty string
    // is success, which is easy to invert by accident.
    if (err) return { ok: false, error: err }
    return { ok: true, path: file }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Render and save wherever the user chooses. */
export async function savePoPdf(po: PurchaseOrderDetail): Promise<PoPdfResult> {
  try {
    const doc = await renderDocument(buildPoHtml(po))
    const win = BrowserWindow.getFocusedWindow()
    const opts = {
      title: `Save ${documentName(po)}`,
      defaultPath: `${documentName(po).replace(/[^\w.-]/g, '_')}${doc.extension}`,
      filters: [{ name: doc.extension === '.pdf' ? 'PDF' : 'Web page', extensions: [doc.extension.slice(1)] }]
    }
    const picked = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true }
    writeFileSync(picked.filePath, doc.bytes)
    return { ok: true, path: picked.filePath }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
