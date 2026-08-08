import { writeFileSync } from 'fs'
import { BrowserWindow, dialog, shell } from 'electron'
import { ipcMain } from './ipcRegistry'
import { IPC } from '@shared/ipc'
import type { ExportResult, Result } from '@shared/types'
import type {
  Invoice,
  InvoiceCustomer,
  InvoiceDetail,
  InvoiceStatus,
  NewInvoice
} from '@shared/invoices'
import { invoicesToCsv } from '@shared/invoices'
import { currentUser } from './services/auth'
import {
  deleteInvoice,
  getInvoice,
  getInvoices,
  invoiceStats,
  listCustomers,
  listInvoices,
  markPosted,
  removeCustomer,
  saveCustomer,
  saveInvoice,
  setInvoiceStatus,
  suggestInvoiceNumber,
  type CustomerInput
} from './db/invoices'
import { openInvoicePdf, saveInvoicePdf } from './invoicePdf'
import {
  createQboInvoice,
  fetchQboCustomers,
  fetchQboItems,
  sendQboInvoice,
  type QboCustomerRef,
  type QboItemRef
} from './quickbooks/invoices'

/**
 * Invoices — the sell side.
 *
 * ## One permission, and it is the one that already spends money
 *
 * `module.invoicing` gates the whole surface, reads and writes alike. It is
 * already the permission that raises a purchase order, and an invoice is the
 * same authority pointed the other way: somebody who may commit this business
 * to paying a supplier may also bill a buyer. Splitting it would produce a role
 * that can spend but not collect, which is not a job anybody has.
 *
 * ## The QuickBooks calls are separated from the local ones on purpose
 *
 * Everything that touches Intuit is async, can fail for reasons outside this
 * app, and — in one case — WRITES TO SOMEBODY'S BOOKS. Those handlers do the
 * local write only after the remote one has come back with an id, so a network
 * failure leaves a draft rather than an invoice this app claims exists and
 * QuickBooks has never heard of.
 */

function can(): boolean {
  const user = currentUser()
  return !!user && user.permissions.includes('module.invoicing')
}

function requireInvoicing(): { id: string } {
  const user = currentUser()
  if (!user) throw new Error('You are not signed in.')
  if (!user.permissions.includes('module.invoicing')) {
    throw new Error('You do not have permission to work with invoices.')
  }
  return { id: user.id }
}

function fail(err: unknown): Result<never> {
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

export function registerInvoicesIpc(): void {
  // ---- Buyers -------------------------------------------------------------
  ipcMain.handle(IPC.invoiceCustomersList, (): InvoiceCustomer[] =>
    can() ? listCustomers() : []
  )

  ipcMain.handle(IPC.invoiceCustomerSave, (_e, input: CustomerInput): Result<InvoiceCustomer> => {
    try {
      requireInvoicing()
      return { ok: true, data: saveCustomer(input) }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.invoiceCustomerDelete, (_e, id: unknown): Result<{ deleted: boolean }> => {
    try {
      requireInvoicing()
      return { ok: true, data: removeCustomer(str(id)) }
    } catch (err) {
      return fail(err)
    }
  })

  // ---- Invoices -----------------------------------------------------------
  ipcMain.handle(IPC.invoicesList, (): Invoice[] => (can() ? listInvoices() : []))

  ipcMain.handle(IPC.invoiceGet, (_e, id: unknown): InvoiceDetail | null =>
    can() ? getInvoice(str(id)) : null
  )

  ipcMain.handle(IPC.invoiceStats, () =>
    can()
      ? invoiceStats()
      : { draft: 0, created: 0, sent: 0, paid: 0, outstanding: 0, paidTotal: 0, thisMonth: 0 }
  )

  ipcMain.handle(IPC.invoiceNextNumber, (): string => (can() ? suggestInvoiceNumber() : ''))

  ipcMain.handle(
    IPC.invoiceSave,
    (_e, input: NewInvoice & { id?: string | null }): Result<InvoiceDetail> => {
      try {
        const actor = requireInvoicing()
        return { ok: true, data: saveInvoice(input, actor.id) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.invoiceDelete, (_e, id: unknown): Result<{ id: string }> => {
    try {
      requireInvoicing()
      const target = str(id)
      deleteInvoice(target)
      return { ok: true, data: { id: target } }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    IPC.invoiceSetStatus,
    (_e, payload: { id?: unknown; status?: unknown }): Result<{ id: string }> => {
      try {
        const actor = requireInvoicing()
        const id = str(payload?.id)
        const raw = str(payload?.status)
        const status: InvoiceStatus =
          raw === 'created' || raw === 'sent' || raw === 'paid' || raw === 'void' ? raw : 'draft'
        if (!setInvoiceStatus(id, status, actor.id)) {
          return { ok: false, error: 'That invoice is gone.' }
        }
        return { ok: true, data: { id } }
      } catch (err) {
        return fail(err)
      }
    }
  )

  // ---- The document a buyer reads -----------------------------------------
  //
  // Both are READS of an invoice — they change nothing — so they are gated like
  // `invoiceGet` rather than like a write.
  ipcMain.handle(IPC.invoiceOpenPdf, async (_e, id: unknown) => {
    try {
      requireInvoicing()
      const invoice = getInvoice(str(id))
      if (!invoice) return { ok: false, error: 'That invoice is gone.' }
      return await openInvoicePdf(invoice)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.invoiceSavePdf, async (_e, id: unknown) => {
    try {
      requireInvoicing()
      const invoice = getInvoice(str(id))
      if (!invoice) return { ok: false, error: 'That invoice is gone.' }
      return await saveInvoicePdf(invoice)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * Intuit's own import template, on disk.
   *
   * The path that ALWAYS works: no connection, no OAuth, no item lookup. It
   * exists because the API route has four ways to fail that are outside this
   * app's control, and an invoice somebody cannot get out of the building is
   * worse than one they have to import by hand.
   */
  ipcMain.handle(IPC.invoiceExportCsv, async (_e, ids: unknown): Promise<ExportResult> => {
    try {
      requireInvoicing()
      const list = Array.isArray(ids) ? ids.map((i) => str(i)) : []
      const invoices = list.length > 0 ? getInvoices(list) : getInvoices(listInvoices().map((i) => i.id))
      if (invoices.length === 0) return { ok: false, error: 'There is nothing to export.' }

      const csv = invoicesToCsv(invoices)
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: 'Export invoices for QuickBooks',
        defaultPath:
          invoices.length === 1
            ? `invoice-${invoices[0].invoiceNumber || 'draft'}.csv`
            : `invoices-${new Date().toISOString().slice(0, 10)}.csv`,
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      })
      if (canceled || !filePath) return { ok: false, canceled: true }
      writeFileSync(filePath, csv, 'utf8')
      return { ok: true, path: filePath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---- QuickBooks ---------------------------------------------------------
  //
  // The reference lists behind the buyer and item pickers. Read-only, and they
  // are what make the create button trustworthy: an invoice built from names
  // QuickBooks actually knows is one it will accept.
  ipcMain.handle(IPC.invoiceQboCustomers, async (): Promise<Result<QboCustomerRef[]>> => {
    try {
      requireInvoicing()
      return { ok: true, data: await fetchQboCustomers() }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.invoiceQboItems, async (): Promise<Result<QboItemRef[]>> => {
    try {
      requireInvoicing()
      return { ok: true, data: await fetchQboItems() }
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * Create it in QuickBooks, then open the browser on it.
   *
   * ORDER MATTERS. The remote write happens first and the local row is only
   * stamped once an id has come back, so a network failure leaves a draft that
   * can be tried again rather than a record claiming a document QuickBooks has
   * never heard of. The reverse order is the one that produces an invoice this
   * app insists exists and nobody can find.
   *
   * The browser opens on the created invoice rather than this app rendering a
   * copy of it: QuickBooks is where it will be sent from, where the numbering
   * is decided, and where somebody is going to look anyway.
   */
  ipcMain.handle(
    IPC.invoiceCreateInQbo,
    async (
      _e,
      payload: { id?: unknown; open?: unknown }
    ): Promise<Result<{ url: string; docNumber: string | null; numberChanged: boolean }>> => {
      try {
        requireInvoicing()
        const id = str(payload?.id)
        const invoice = getInvoice(id)
        if (!invoice) return { ok: false, error: 'That invoice is gone.' }
        if (invoice.status === 'void') {
          return { ok: false, error: 'That invoice is void.' }
        }

        const res = await createQboInvoice(invoice)
        markPosted(id, { id: res.qboId, docNumber: res.docNumber }, 'created')

        // Opening the browser is a convenience, not the operation. A blocked
        // pop-up or a machine with no default browser must not turn a
        // successfully created invoice into a reported failure.
        if (payload?.open !== false) {
          try {
            await shell.openExternal(res.url)
          } catch {
            /* the URL comes back either way, so the screen can offer it */
          }
        }

        return {
          ok: true,
          data: { url: res.url, docNumber: res.docNumber, numberChanged: res.numberChanged }
        }
      } catch (err) {
        return fail(err)
      }
    }
  )

  /** Ask QuickBooks to email it. Separate from creating it — see the note there. */
  ipcMain.handle(IPC.invoiceSendFromQbo, async (_e, id: unknown): Promise<Result<{ id: string }>> => {
    try {
      requireInvoicing()
      const target = str(id)
      const invoice = getInvoice(target)
      if (!invoice) return { ok: false, error: 'That invoice is gone.' }
      if (!invoice.qboId) {
        return { ok: false, error: 'Create it in QuickBooks first — there is nothing to send yet.' }
      }
      if (!invoice.email) {
        return {
          ok: false,
          error: 'That buyer has no email address, so QuickBooks has nowhere to send it.'
        }
      }
      await sendQboInvoice(invoice.qboId, invoice.email)
      setInvoiceStatus(target, 'sent')
      return { ok: true, data: { id: target } }
    } catch (err) {
      return fail(err)
    }
  })

  /** Reopen an already-created invoice in QuickBooks. */
  ipcMain.handle(IPC.invoiceOpenInQbo, async (_e, id: unknown): Promise<Result<{ url: string }>> => {
    try {
      requireInvoicing()
      const invoice = getInvoice(str(id))
      if (!invoice?.qboId) {
        return { ok: false, error: 'That invoice is not in QuickBooks yet.' }
      }
      const { qboInvoiceUrl } = await import('@shared/invoices')
      const { getQboConfig } = await import('./quickbooks/store')
      const url = qboInvoiceUrl(getQboConfig()?.environment ?? 'production', invoice.qboId)
      await shell.openExternal(url)
      return { ok: true, data: { url } }
    } catch (err) {
      return fail(err)
    }
  })
}
