import { readFileSync, writeFileSync } from 'fs'
import { basename } from 'path'
import { BrowserWindow, dialog, shell, type OpenDialogOptions } from 'electron'
import { ipcMain } from './ipcRegistry'
import { IPC } from '@shared/ipc'
import type { ExportResult, Result, UploadedFile } from '@shared/types'
import type { ContactImportResult } from '@shared/contacts'
import type {
  Invoice,
  InvoiceCustomer,
  InvoiceDetail,
  InvoiceStatus,
  NewInvoice
} from '@shared/invoices'
import type {
  InvoicePushResult,
  QboInvoiceObservation,
  QboInvoicePreflight
} from '@shared/invoices'
import { invoicesToCsv, nextStageFromQbo } from '@shared/invoices'
import { currentUser } from './services/auth'
import {
  deleteInvoice,
  getInvoice,
  getInvoices,
  invoiceStats,
  listCustomers,
  listInvoices,
  listInvoicesNeedingPush,
  listPostedInvoices,
  markPosted,
  markPushFailed,
  markPushPending,
  recordQboObservation,
  recordQboStatusFailure,
  removeCustomer,
  saveCustomer,
  saveInvoice,
  setInvoiceStatus,
  suggestInvoiceNumber,
  type CustomerInput
} from './db/invoices'
import { importContactFile } from './contactsImport'
import { uploadedBytes, uploadedName } from './util'
import { openInvoicePdf, saveInvoicePdf } from './invoicePdf'
import {
  createQboCustomer,
  createQboInvoice,
  createQboItem,
  deleteQboInvoice,
  fetchQboCustomers,
  fetchQboItems,
  preflightQboInvoice,
  sendQboInvoice,
  setQboItemSku,
  type QboCustomerRef,
  type QboItemRef
} from './quickbooks/invoices'
import { fetchQboInvoiceStatuses } from './quickbooks/invoiceStatus'

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

/**
 * Put a saved invoice into QuickBooks, recording how it went either way.
 *
 * ## The local row is never harmed by a remote failure
 *
 * This is only ever called with an invoice that is ALREADY committed. It writes
 * three things to the local row — pending before, then posted or failed after —
 * and touches nothing else. So the worst outcome of a dead network, an expired
 * grant, a missing item or an Intuit outage is an invoice sitting in draft with
 * a sentence saying why, which is a thing somebody can retry.
 *
 * ## Why 'pending' is stamped BEFORE the call
 *
 * A process killed between the request leaving and the reply arriving leaves the
 * row reading 'pending', which means "this may be in QuickBooks". That is the
 * state that makes somebody look before pushing again. Stamped after the call it
 * would read 'none' — "never tried" — and that claim leads straight to the same
 * invoice existing twice in a real company's books.
 */
async function pushToQbo(invoice: InvoiceDetail, open: boolean): Promise<InvoicePushResult> {
  const base = {
    invoice,
    pushed: false,
    url: null,
    docNumber: null,
    numberChanged: false,
    notes: [] as string[]
  }
  if (invoice.status === 'void') {
    return { ...base, error: 'That invoice is void, so it was not sent to QuickBooks.' }
  }
  if (invoice.qboId) {
    return { ...base, error: 'That invoice is already in QuickBooks.' }
  }

  markPushPending(invoice.id)
  try {
    const res = await createQboInvoice(invoice)
    markPosted(invoice.id, { id: res.qboId, docNumber: res.docNumber }, 'created')

    // Opening the browser is a convenience, not the operation. A blocked pop-up
    // or a machine with no default browser must not turn a successfully created
    // invoice into a reported failure.
    if (open) {
      try {
        await shell.openExternal(res.url)
      } catch {
        /* the URL comes back either way, so the screen can offer it */
      }
    }

    return {
      // Re-read: markPosted has moved the status and stamped the ids, and the
      // caller is going to render this. Handing back the pre-push copy would
      // show a draft that the database no longer agrees is one.
      invoice: getInvoice(invoice.id) ?? invoice,
      pushed: true,
      url: res.url,
      docNumber: res.docNumber,
      numberChanged: res.numberChanged,
      error: null,
      notes: res.notes
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    markPushFailed(invoice.id, message)
    return { ...base, invoice: getInvoice(invoice.id) ?? invoice, error: message }
  }
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

  ipcMain.handle(
    IPC.invoiceCustomerDelete,
    (_e, id: unknown): Result<{ deleted: boolean; keptAsVendor: boolean }> => {
      try {
        requireInvoicing()
        return { ok: true, data: removeCustomer(str(id)) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  /**
   * Import the QuickBooks Customer Contact List.
   *
   * Two ways in and one importer, the same arrangement the ledger import uses: a
   * browser sends the file's CONTENT because it has no path it could send and a
   * server that opened one would be reading its own disk on a caller's say-so;
   * the desktop sends nothing and gets the native picker, because that is where
   * the window is.
   *
   * BYTES EITHER WAY, even for CSV. A .xlsx has to arrive as bytes, and having
   * one path for both formats means the format is decided in exactly one place —
   * by the file name, below — rather than by which branch the caller took.
   *
   * Re-running it is safe by construction: matching is on the QuickBooks display
   * name and every field merges, so a second import of the same file writes
   * nothing at all. See importContacts.
   */
  ipcMain.handle(
    IPC.invoiceContactsImport,
    async (e, upload?: UploadedFile): Promise<Result<ContactImportResult>> => {
      try {
        requireInvoicing()
        const bytes = uploadedBytes(upload)
        if (bytes) return { ok: true, data: importContactFile(bytes, uploadedName(upload, '')) }

        const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow()
        const opts: OpenDialogOptions = {
          title: 'Choose the QuickBooks Customer Contact List',
          properties: ['openFile'],
          filters: [
            { name: 'Spreadsheet', extensions: ['xlsx', 'csv', 'tsv', 'txt'] },
            { name: 'All files', extensions: ['*'] }
          ]
        }
        const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
        if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: 'No file selected.' }
        const path = picked.filePaths[0]
        return { ok: true, data: importContactFile(readFileSync(path), basename(path)) }
      } catch (err) {
        return fail(err)
      }
    }
  )

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

  /**
   * Delete an invoice. Here always; in QuickBooks if it will allow it.
   *
   * The order is still QuickBooks first, but its refusal no longer stops
   * anything — it is reported instead. Intuit will not delete an invoice that
   * has a payment applied, and answers with a 401 AuthorizationFailure that
   * reads like a broken connection rather than a business rule. Letting that
   * block the local delete meant the button did nothing at all on precisely
   * the invoices somebody wanted gone.
   *
   * `removedFromQbo` comes back so the screen can say which of the two
   * happened. A copy left on the books is a real consequence and belongs on
   * screen, not in a log.
   */
  ipcMain.handle(
    IPC.invoiceDelete,
    async (_e, id: unknown): Promise<Result<{ id: string; removedFromQbo: boolean; qboError: string | null }>> => {
      try {
        requireInvoicing()
        const target = str(id)
        const invoice = getInvoice(target)
        if (!invoice) return { ok: false, error: 'That invoice is already gone.' }

        let removedFromQbo = false
        let qboError: string | null = null
        if (invoice.qboId) {
          try {
            await deleteQboInvoice(invoice.qboId)
            removedFromQbo = true
          } catch (err) {
            qboError = err instanceof Error ? err.message : String(err)
          }
        }
        deleteInvoice(target)
        return { ok: true, data: { id: target, removedFromQbo, qboError } }
      } catch (err) {
        return fail(err)
      }
    }
  )

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
   * What QuickBooks would refuse about this invoice, before it is sent.
   *
   * Takes the invoice AS TYPED rather than an id, which is the whole point: the
   * answer is wanted while the form is still open and before anything has been
   * saved, so there is no row to point at yet.
   */
  ipcMain.handle(
    IPC.invoiceQboPreflight,
    async (
      _e,
      payload: { customerName?: unknown; lines?: unknown }
    ): Promise<Result<QboInvoicePreflight>> => {
      try {
        requireInvoicing()
        const raw = Array.isArray(payload?.lines) ? payload.lines : []
        const lines = raw
          .map((l) => {
            const line = (l ?? {}) as { item?: unknown; sku?: unknown }
            return { item: str(line.item), sku: str(line.sku) || null }
          })
          // A blank row in a half-typed form is not a missing product, and
          // reporting it as one would put a scary red panel in front of somebody
          // for the entirely normal state of not having finished.
          .filter((l) => l.item !== '')
        return {
          ok: true,
          data: await preflightQboInvoice({ customerName: str(payload?.customerName), lines })
        }
      } catch (err) {
        return fail(err)
      }
    }
  )

  /**
   * Create the missing Product/Service, then answer with what QuickBooks made.
   *
   * Deliberately not folded into the send. See createQboItem for the reason —
   * briefly, an invoice that silently invents six items in somebody's books is
   * not something an error message can take back.
   */
  ipcMain.handle(
    IPC.invoiceQboCreateItem,
    async (
      _e,
      payload: { name?: unknown; sku?: unknown; rate?: unknown; description?: unknown }
    ): Promise<Result<QboItemRef>> => {
      try {
        requireInvoicing()
        const rate = Number(payload?.rate)
        return {
          ok: true,
          data: await createQboItem({
            name: str(payload?.name),
            sku: str(payload?.sku) || null,
            rate: Number.isFinite(rate) && rate > 0 ? rate : null,
            description: str(payload?.description) || null
          })
        }
      } catch (err) {
        return fail(err)
      }
    }
  )

  /**
   * Fill in a blank Item.Sku from ours. Refuses if QuickBooks has since been
   * given a different one — checked against the live record, not the screen.
   */
  ipcMain.handle(
    IPC.invoiceQboSetItemSku,
    async (_e, payload: { itemId?: unknown; sku?: unknown }): Promise<Result<QboItemRef>> => {
      try {
        requireInvoicing()
        return { ok: true, data: await setQboItemSku(str(payload?.itemId), str(payload?.sku)) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.invoiceQboCreateCustomer,
    async (
      _e,
      payload: { name?: unknown; email?: unknown }
    ): Promise<Result<QboCustomerRef>> => {
      try {
        requireInvoicing()
        return {
          ok: true,
          data: await createQboCustomer({
            name: str(payload?.name),
            email: str(payload?.email) || null
          })
        }
      } catch (err) {
        return fail(err)
      }
    }
  )

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
    ): Promise<
      Result<{
        url: string
        docNumber: string | null
        numberChanged: boolean
        notes: string[]
      }>
    > => {
      try {
        requireInvoicing()
        const id = str(payload?.id)
        const invoice = getInvoice(id)
        if (!invoice) return { ok: false, error: 'That invoice is gone.' }

        const res = await pushToQbo(invoice, payload?.open !== false)
        // This channel keeps its original contract — a failed push IS a failed
        // operation here, because the caller asked for one thing and it did not
        // happen. That differs from `invoiceSaveAndPush`, where the save
        // succeeded and only the push did not, and reporting THAT as a failure
        // would tell somebody their invoice was lost when it is on disk.
        if (!res.pushed) return { ok: false, error: res.error ?? 'QuickBooks refused the invoice.' }

        return {
          ok: true,
          data: {
            url: res.url ?? '',
            docNumber: res.docNumber,
            numberChanged: res.numberChanged,
            notes: res.notes
          }
        }
      } catch (err) {
        return fail(err)
      }
    }
  )

  /**
   * Save it, then put it in QuickBooks — the everyday gesture, with no separate
   * send step.
   *
   * TWO WRITES, AND THE ORDER IS THE FEATURE. The local save is committed first
   * and on its own; only then is QuickBooks called. So the failure modes split
   * cleanly: a bad invoice is refused before anything is written, and a bad
   * NETWORK leaves a perfectly good saved invoice with `qboPushState = 'failed'`
   * and a sentence saying why.
   *
   * A failed push therefore comes back `ok: true` with `pushed: false`. That
   * reads oddly for a second and is the only honest answer: the thing the
   * operator did — write an invoice — worked.
   */
  ipcMain.handle(
    IPC.invoiceSaveAndPush,
    async (
      _e,
      payload: NewInvoice & { id?: string | null; open?: boolean }
    ): Promise<Result<InvoicePushResult>> => {
      try {
        const actor = requireInvoicing()
        // Throws on an invalid invoice, before any of it is written. A refusal
        // here is a genuine failure — there is nothing saved to reassure anybody
        // about.
        const saved = saveInvoice(payload, actor.id)
        const res = await pushToQbo(saved, payload?.open === true)
        return { ok: true, data: res }
      } catch (err) {
        return fail(err)
      }
    }
  )

  /** Try a failed push again. Same path, same guards — nothing special. */
  ipcMain.handle(
    IPC.invoiceRetryQboPush,
    async (_e, payload: { id?: unknown; open?: unknown }): Promise<Result<InvoicePushResult>> => {
      try {
        requireInvoicing()
        const invoice = getInvoice(str(payload?.id))
        if (!invoice) return { ok: false, error: 'That invoice is gone.' }
        return { ok: true, data: await pushToQbo(invoice, payload?.open === true) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  /**
   * The invoices that tried to reach QuickBooks and did not.
   *
   * A local read — no connection needed — because the whole point is that it
   * still answers when QuickBooks is the thing that is down.
   */
  ipcMain.handle(IPC.invoiceQboPending, (): Invoice[] =>
    can() ? listInvoicesNeedingPush() : []
  )

  /**
   * Ask QuickBooks where these invoices have got to.
   *
   * Reads only. What comes back is RECORDED in full and only then allowed to
   * move a card, and only forwards along a legal transition — see
   * nextStageFromQbo, which is where the two rules that matter live: a locally
   * paid invoice is never dragged back (paid is operator-recorded here, and
   * plenty settle in cash QuickBooks never sees), and an answer we could not
   * read moves nothing.
   *
   * `checked` counts invoices QuickBooks answered for. `missing` counts ones it
   * did not — an invoice deleted in QuickBooks comes back as silence, and that
   * is worth a number on a screen rather than being rounded into the errors.
   */
  ipcMain.handle(
    IPC.invoiceSyncQboStatus,
    async (
      _e,
      payload?: { id?: unknown }
    ): Promise<
      Result<{
        checked: number
        missing: number
        moved: Array<{ id: string; from: InvoiceStatus; to: InvoiceStatus }>
      }>
    > => {
      try {
        requireInvoicing()
        const one = str(payload?.id)
        const targets = one
          ? [getInvoice(one)].filter((i): i is InvoiceDetail => !!i?.qboId)
          : listPostedInvoices()
        if (targets.length === 0) {
          return { ok: true, data: { checked: 0, missing: 0, moved: [] } }
        }

        let observations: Map<string, QboInvoiceObservation>
        try {
          observations = await fetchQboInvoiceStatuses(
            targets.map((i) => i.qboId).filter((v): v is string => !!v)
          )
        } catch (err) {
          // One network failure, not one per invoice. Recorded against every
          // invoice we asked about so each card can say when it was last tried
          // — and, critically, WITHOUT touching the readings that already
          // worked. Stale-but-true beats fresh-and-wrong.
          const message = err instanceof Error ? err.message : String(err)
          for (const invoice of targets) recordQboStatusFailure(invoice.id, message)
          return { ok: false, error: message }
        }

        const moved: Array<{ id: string; from: InvoiceStatus; to: InvoiceStatus }> = []
        let checked = 0
        let missing = 0
        for (const invoice of targets) {
          const observed = invoice.qboId ? observations.get(invoice.qboId) : undefined
          if (!observed) {
            missing++
            recordQboStatusFailure(
              invoice.id,
              'QuickBooks did not return this invoice. It may have been deleted there.'
            )
            continue
          }
          checked++
          recordQboObservation(invoice.id, observed)
          const next = nextStageFromQbo(invoice.status, observed)
          if (next && setInvoiceStatus(invoice.id, next)) {
            moved.push({ id: invoice.id, from: invoice.status, to: next })
          }
        }
        return { ok: true, data: { checked, missing, moved } }
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
