import { BrowserWindow, dialog, shell } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { InvoiceDetail } from '@shared/invoices'
import { RM_LOGO_DATA_URI } from './brand'
import { shipMeta } from './freightPdf'
import { renderDocumentForExport, type PoPdfResult } from './poPdf'

/**
 * The invoice as a document you can send somebody.
 *
 * The CSV is for QuickBooks and the API call is for QuickBooks; this is for the
 * BUYER. It is the only artefact in the module a human is meant to read, which
 * is why it carries the things a machine does not need — who it is for, where
 * to send the money conversation, what each line was, and what the total comes
 * to in words a person recognises.
 *
 * Built as a self-contained A4 document rather than by printing the screen. The
 * editor lives inside a fixed-height scroll container, so `window.print()`
 * would clip it to one viewport and a long invoice would come out truncated —
 * which is exactly the bug the PO receipt had before `poPdf.ts` was written.
 * This mirrors that file deliberately, including the renderer hook that lets a
 * headless server hand back HTML instead (no server carries Chromium).
 */

const money = (n: number): string =>
  (Number.isFinite(n) ? n : 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const longDate = (day: string | null | undefined): string => {
  if (!day) return '—'
  const t = Date.parse(`${day}T12:00:00Z`)
  if (!Number.isFinite(t)) return '—'
  return new Date(t).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  })
}

/** Everything interpolated below is operator-entered, so nothing goes in raw. */
function esc(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  created: 'Invoice',
  sent: 'Invoice',
  paid: 'Paid',
  void: 'Void'
}

export function buildInvoiceHtml(invoice: InvoiceDetail): string {
  const rows = invoice.lines
    .map(
      (l, i) => `
      <tr>
        <td class="num">${i + 1}</td>
        <td>
          <div class="pname">${esc(l.item)}</div>
          ${l.description ? `<div class="pdesc">${esc(l.description)}</div>` : ''}
        </td>
        <td class="num">${l.quantity}</td>
        <td class="num">${money(l.rate)}</td>
        <td class="num strong">${money(l.amount)}</td>
      </tr>`
    )
    .join('')

  // DRAFT and VOID are stamped across the page. An unfinished or cancelled
  // invoice that looks exactly like a real one is the single most damaging
  // thing this file could produce — somebody pays it, or chases it.
  const watermark =
    invoice.status === 'draft' || invoice.status === 'void'
      ? `<div class="mark">${esc(STATUS_LABEL[invoice.status])}</div>`
      : ''

  return `<!doctype html>
<html><head><meta charset="utf-8">
<title>Invoice ${esc(invoice.invoiceNumber)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 10.5pt;
    color: #111;
    position: relative;
  }
  .head { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 22px; }
  .logo { height: 46px; }
  .who { margin-left: auto; text-align: right; }
  .doc { font-size: 22pt; font-weight: 700; letter-spacing: -0.01em; margin: 0; }
  .docnum { font-size: 11pt; color: #555; margin-top: 2px; }
  .paidchip {
    display: inline-block; margin-top: 6px; padding: 2px 9px; border-radius: 999px;
    background: #e6f4ec; color: #0d7a3c; font-size: 9pt; font-weight: 700;
    letter-spacing: 0.04em;
  }

  .parties { display: flex; gap: 28px; margin-bottom: 20px; }
  .party { flex: 1; }
  .plabel {
    font-size: 8pt; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
    color: #777; margin-bottom: 4px;
  }
  .pname-lg { font-size: 12pt; font-weight: 600; }
  .pline { color: #444; }

  /* Four cells always, and up to three more when the invoice carries shipping
     and payment details — so this wraps rather than squeezing a 22-digit
     tracking number into a seventh of the page. The row-gap borders come from
     .fact itself so a wrapped row still reads as part of the same strip. */
  .facts {
    display: flex; flex-wrap: wrap; gap: 0; margin-bottom: 18px;
    border: 1px solid #ddd; border-radius: 6px; overflow: hidden;
  }
  .fact { flex: 1 1 128px; min-width: 0; padding: 8px 12px; border-left: 1px solid #ddd; }
  .fact:first-child { border-left: 0; }
  .fkey { font-size: 8pt; letter-spacing: 0.06em; text-transform: uppercase; color: #777; }
  .fval { font-size: 10.5pt; font-weight: 600; margin-top: 2px; overflow-wrap: anywhere; }

  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  th {
    text-align: left; font-size: 8.5pt; letter-spacing: 0.06em; text-transform: uppercase;
    color: #666; border-bottom: 1.5px solid #333; padding: 0 8px 6px;
  }
  td { padding: 8px; border-bottom: 1px solid #eee; vertical-align: top; }
  tr { break-inside: avoid; }
  .num { text-align: right; white-space: nowrap; }
  th.num { text-align: right; }
  .strong { font-weight: 700; }
  .pname { font-weight: 600; }
  .pdesc { color: #666; font-size: 9.5pt; margin-top: 2px; }

  .totals { margin-top: 14px; display: flex; justify-content: flex-end; }
  .totals table { width: auto; min-width: 240px; }
  .totals td { border: none; padding: 3px 8px; }
  .totals .grand td {
    border-top: 1.5px solid #333; padding-top: 8px; font-size: 13pt; font-weight: 700;
  }

  .notes { margin-top: 26px; }
  .note { margin-top: 10px; }
  .foot {
    margin-top: 30px; padding-top: 10px; border-top: 1px solid #eee;
    color: #777; font-size: 9pt;
  }

  /* Draft and void, unmistakably. */
  .mark {
    position: fixed; top: 42%; left: 0; right: 0; text-align: center;
    font-size: 76pt; font-weight: 800; letter-spacing: 0.1em;
    color: rgba(190, 30, 30, 0.13); transform: rotate(-22deg);
    pointer-events: none; text-transform: uppercase;
  }
</style></head>
<body>
${watermark}

<div class="head">
  <img class="logo" src="${RM_LOGO_DATA_URI}" alt="RM Cardz">
  <div class="who">
    <p class="doc">${esc(STATUS_LABEL[invoice.status] ?? 'Invoice')}</p>
    <div class="docnum">${esc(invoice.qboDocNumber || invoice.invoiceNumber || '')}</div>
    ${
      invoice.status === 'paid'
        ? `<div class="paidchip">PAID${invoice.paidAt ? ` ${esc(invoice.paidAt.slice(0, 10))}` : ''}</div>`
        : ''
    }
  </div>
</div>

<div class="parties">
  <div class="party">
    <div class="plabel">From</div>
    <div class="pname-lg">RM Cardz</div>
  </div>
  <div class="party">
    <div class="plabel">Bill to</div>
    <div class="pname-lg">${esc(invoice.customerName)}</div>
    ${invoice.email ? `<div class="pline">${esc(invoice.email)}</div>` : ''}
    ${invoice.location ? `<div class="pline">${esc(invoice.location)}</div>` : ''}
  </div>
</div>

<div class="facts">
  <div class="fact"><div class="fkey">Invoice date</div><div class="fval">${longDate(invoice.invoiceDate)}</div></div>
  <div class="fact"><div class="fkey">Due</div><div class="fval">${longDate(invoice.dueDate)}</div></div>
  <div class="fact"><div class="fkey">Terms</div><div class="fval">${esc(invoice.terms)}</div></div>
  <div class="fact"><div class="fkey">Total</div><div class="fval">${money(invoice.total)}</div></div>
  ${shipMeta(invoice, { cell: 'fact', key: 'fkey', value: 'fval' })}
</div>

<table>
  <thead>
    <tr>
      <th style="width:26px">#</th>
      <th>Item</th>
      <th class="num" style="width:56px">Qty</th>
      <th class="num" style="width:82px">Rate</th>
      <th class="num" style="width:96px">Amount</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>

<div class="totals">
  <table>
    <tr class="grand"><td>Total</td><td class="num">${money(invoice.total)}</td></tr>
  </table>
</div>

${
  invoice.message
    ? `<div class="notes"><div class="note">${esc(invoice.message)}</div></div>`
    : ''
}

<div class="foot">
  ${esc(invoice.customerName)} · ${esc(invoice.terms)} · due ${longDate(invoice.dueDate)}
</div>
</body></html>`
}

/** A filename that is safe on every platform and still recognisable. */
function fileBase(invoice: InvoiceDetail): string {
  const num = invoice.qboDocNumber || invoice.invoiceNumber || 'draft'
  const who = invoice.customerName.replace(/[^\w -]/g, '').trim().replace(/\s+/g, '-')
  return `invoice-${num}${who ? `-${who}` : ''}`.replace(/[^\w.-]/g, '_')
}

/** Render it and hand it to the OS viewer, so somebody can look at it or print. */
export async function openInvoicePdf(invoice: InvoiceDetail): Promise<PoPdfResult> {
  try {
    const doc = await renderDocumentForExport(buildInvoiceHtml(invoice))
    const file = join(tmpdir(), `${fileBase(invoice)}${doc.extension}`)
    writeFileSync(file, doc.bytes)
    // openPath resolves to a NON-EMPTY string when it FAILED — an empty string
    // is success, which is easy to invert by accident.
    const err = await shell.openPath(file)
    if (err) return { ok: false, error: err }
    return { ok: true, path: file }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Render and save wherever they choose. */
export async function saveInvoicePdf(invoice: InvoiceDetail): Promise<PoPdfResult> {
  try {
    const doc = await renderDocumentForExport(buildInvoiceHtml(invoice))
    const win = BrowserWindow.getFocusedWindow()
    const opts = {
      title: `Save invoice ${invoice.invoiceNumber}`,
      defaultPath: `${fileBase(invoice)}${doc.extension}`,
      filters: [
        {
          name: doc.extension === '.pdf' ? 'PDF' : 'Web page',
          extensions: [doc.extension.slice(1)]
        }
      ]
    }
    const picked = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true }
    writeFileSync(picked.filePath, doc.bytes)
    return { ok: true, path: picked.filePath }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
