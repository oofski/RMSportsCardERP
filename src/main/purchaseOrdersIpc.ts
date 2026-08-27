import { BrowserWindow, dialog, type OpenDialogOptions } from 'electron'
import { readFileSync } from 'fs'
import { basename } from 'path'
import { ipcMain } from './ipcRegistry'
import { IPC } from '@shared/ipc'
import type {
  CogsEntry,
  InventoryProduct,
  NewPurchaseOrder,
  NewPurchaseOrderLine,
  PoRoutingPatch,
  PurchaseOrder,
  PurchaseOrderDetail,
  PurchaseOrderStatus,
  Result,
  UploadedFile
} from '@shared/types'
import type { ContactImportResult } from '@shared/contacts'
import {
  isPurchaseOrderStatus,
  type OrderParty,
  type SupplierSuggestion,
  type VendorSummary
} from '@shared/purchaseOrders'
import type { FreightPatch } from '@shared/freight'
import type { SupplyingOrder } from '@shared/poStock'
import type { InvoiceDetail } from '@shared/invoices'
import { supplyingOrders } from './db/provenance'
import { salesFromPoStock } from './db/invoices'
import { sweepTracking, type SweepResult } from './tracking/poller'
import { canRead } from './tracking/read'
import type { Permission } from '@shared/permissions'
import { currentUser } from './services/auth'
import { openPoPdf, savePoPdf } from './poPdf'
import {
  createPurchaseOrder,
  deletePurchaseOrder,
  forceDeletePurchaseOrder,
  getPurchaseOrder,
  listActivePurchaseOrderBoxes,
  listOrderParties,
  listPurchaseOrders,
  listSupplierSuggestions,
  listVendors,
  receivePurchaseOrderLines,
  scanInPurchaseOrder,
  setPartyPinned,
  setPurchaseOrderFreight,
  setPurchaseOrderRouting,
  addPurchaseOrderLines,
  updatePurchaseOrderHeader,
  updatePurchaseOrderLine,
  removePurchaseOrderLine,
  setPurchaseOrderPaid,
  setPurchaseOrderStatus,
  listOpenRoadshowTabs,
  setPurchaseOrderLinePrice,
  closeRoadshowTab,
  settleRoadshowTab
} from './db/purchaseOrders'
import type { PoReceiptItem } from './db/purchaseOrders'
import { listCogsEntries } from './db/finance'
import { getProduct, productThumbnails, searchCatalog } from './db/inventory'
import { importVendorFile } from './vendorsImport'
import { uploadedBytes, uploadedName } from './util'

function can(permission: Permission): boolean {
  const user = currentUser()
  return !!user && user.permissions.includes(permission)
}

/** Every PO operation is gated on the single `module.invoicing` permission. */
function requireInvoicing(): { id: string } {
  const user = currentUser()
  if (!user) throw new Error('You are not signed in.')
  if (!user.permissions.includes('module.invoicing')) {
    throw new Error('You do not have access to Invoicing & POs.')
  }
  return { id: user.id }
}

function fail(err: unknown): Result<never> {
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

export function registerPurchaseOrdersIpc(): void {
  // ---- Reads (module.invoicing) -------------------------------------------
  ipcMain.handle(IPC.poList, (): PurchaseOrder[] =>
    can('module.invoicing') ? listPurchaseOrders() : []
  )
  ipcMain.handle(IPC.poGet, (_e, id: string): PurchaseOrderDetail | null =>
    can('module.invoicing') ? getPurchaseOrder(String(id ?? '')) : null
  )
  // Lets a module.invoicing-only user search the catalog without module.inventory.
  ipcMain.handle(IPC.poCatalogSearch, (_e, query: string): InventoryProduct[] =>
    can('module.invoicing') ? searchCatalog(query ?? '') : []
  )
  // Names for the supplier box. Gated on the same single permission as the rest
  // of the module, and that is not a shortcut: the list is drawn partly from the
  // contact records, so it is the same disclosure as opening the Buyers tab —
  // which module.invoicing already grants.
  ipcMain.handle(IPC.poSuppliers, (): SupplierSuggestion[] =>
    can('module.invoicing') ? listSupplierSuggestions() : []
  )
  /**
   * Everywhere units can be SENT — the destination picker's whole list.
   *
   * Gated on the same single permission as poSuppliers and for the identical
   * stated reason: it discloses contact detail, which module.invoicing already
   * grants via the Buyers tab. A read, so an empty list is the honest answer to
   * a caller who is not permitted rather than a thrown error.
   */
  ipcMain.handle(IPC.poParties, (): OrderParty[] =>
    can('module.invoicing') ? listOrderParties() : []
  )

  /**
   * Pin or unpin a destination. A WRITE — it adds a row to a synced table — so
   * it takes requireInvoicing rather than the softer `can` the reads use.
   */
  ipcMain.handle(
    IPC.poPartyPin,
    (_e, payload: { name: string; pinned: boolean }): Result<OrderParty[]> => {
      try {
        requireInvoicing()
        const name = String(payload?.name ?? '').trim()
        if (!name) return { ok: false, error: 'Pick a name to pin.' }
        return { ok: true, data: setPartyPinned(name, !!payload?.pinned) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  /**
   * Re-route an existing order's lines or splits.
   *
   * Gated exactly like every other PO write. What makes it safe is not a
   * stricter gate but the refusal inside setPurchaseOrderRouting: a line with
   * units already checked in cannot be re-routed, because that would mean moving
   * stock, which is Inventory's job.
   */
  ipcMain.handle(
    IPC.poSetRouting,
    (_e, payload: { id: string; patch: PoRoutingPatch }): Result<PurchaseOrderDetail> => {
      try {
        requireInvoicing()
        const id = String(payload?.id ?? '')
        if (!id) return { ok: false, error: 'No purchase order specified.' }
        const res = setPurchaseOrderRouting(id, payload?.patch ?? {})
        return res.error
          ? { ok: false, error: res.error }
          : { ok: true, data: res.po as PurchaseOrderDetail }
      } catch (err) {
        return fail(err)
      }
    }
  )

  // Admin → Vendors. Same single permission, and for the same reason the line
  // above gives: the list carries contact detail for anyone who has one, so it
  // is the same disclosure as the customer list, which module.invoicing already
  // grants. Standing inside Admin is NOT what authorises it — an administrator
  // without the invoicing permission gets an empty list here, and the Admin tile
  // that leads to it is hidden by the same check in the renderer.
  ipcMain.handle(IPC.poVendors, (): VendorSummary[] =>
    can('module.invoicing') ? listVendors() : []
  )
  /**
   * Import the owner's vendor sheet.
   *
   * Two ways in and one importer, the same arrangement the contact import and
   * the ledger import both use: a browser sends the file's CONTENT because it
   * has no path it could send and a server that opened one would be reading its
   * own disk on a caller's say-so; the desktop sends nothing and gets the native
   * picker, because that is where the window is.
   *
   * BYTES EITHER WAY, even for CSV. A .xlsx has to arrive as bytes, and having
   * one path for both formats means the format is decided in exactly one place —
   * from the file's first two bytes, in importFile.ts — rather than by which
   * branch the caller took.
   *
   * A WRITE, so it takes requireInvoicing rather than the softer `can` the reads
   * above use: this one adds contact records to a synced table, and an empty
   * list is a reasonable answer to a read that is not permitted while silently
   * doing nothing is not a reasonable answer to an import.
   *
   * Re-running it is safe by construction: vendors are matched on the name and
   * every field merges, so a second import of the same sheet writes nothing at
   * all. See importVendors.
   */
  ipcMain.handle(
    IPC.poVendorsImport,
    async (e, upload?: UploadedFile): Promise<Result<ContactImportResult>> => {
      try {
        requireInvoicing()
        const bytes = uploadedBytes(upload)
        if (bytes) return { ok: true, data: importVendorFile(bytes, uploadedName(upload, '')) }

        const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow()
        const opts: OpenDialogOptions = {
          title: 'Choose the vendor list',
          properties: ['openFile'],
          filters: [
            { name: 'Spreadsheet', extensions: ['xlsx', 'csv', 'tsv', 'txt'] },
            { name: 'All files', extensions: ['*'] }
          ]
        }
        const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
        if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: 'No file selected.' }
        const path = picked.filePaths[0]
        return { ok: true, data: importVendorFile(readFileSync(path), basename(path)) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.poThumbnails, (): Record<string, string> =>
    can('module.invoicing') ? productThumbnails() : {}
  )
  // Incoming PO "boxes" for the Inventory module — visible to inventory users too
  // (they see the shipments landing), not just invoicing users.
  ipcMain.handle(IPC.poIncomingBoxes, (): PurchaseOrderDetail[] =>
    can('module.inventory') || can('module.invoicing') ? listActivePurchaseOrderBoxes() : []
  )
  // COGS ledger read — visible to finance or invoicing users.
  ipcMain.handle(IPC.poCogsList, (): CogsEntry[] =>
    can('module.finance') || can('module.invoicing') ? listCogsEntries() : []
  )

  // ---- Writes (module.invoicing) ------------------------------------------
  ipcMain.handle(IPC.poCreate, (_e, input: NewPurchaseOrder): Result<PurchaseOrderDetail> => {
    try {
      const actor = requireInvoicing()
      if (!Array.isArray(input?.lines) || input.lines.length === 0) {
        return { ok: false, error: 'Add at least one line item.' }
      }
      for (const line of input.lines) {
        if (!getProduct(line.productId)) {
          return { ok: false, error: 'A line references a product that is not in the catalog.' }
        }
        if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
          return { ok: false, error: 'Each line quantity must be a whole number of at least 1.' }
        }
        if (!Number.isFinite(line.unitPrice) || line.unitPrice < 0) {
          return { ok: false, error: 'Each line price must be 0 or more.' }
        }
      }
      return { ok: true, data: createPurchaseOrder(input, actor.id) }
    } catch (err) {
      return fail(err)
    }
  })

  // Scan-in folds a PO's cases into stock — same audience as poIncomingBoxes.
  ipcMain.handle(IPC.poScanIn, (_e, payload: { id: string }): Result<PurchaseOrderDetail> => {
    try {
      if (!can('module.inventory') && !can('module.invoicing'))
        return { ok: false, error: 'You do not have access to receive purchase orders.' }
      const id = String(payload?.id ?? '')
      if (!id) return { ok: false, error: 'No purchase order specified.' }
      const res = scanInPurchaseOrder(id, currentUser()?.id ?? null)
      return res.error ? { ok: false, error: res.error } : { ok: true, data: res.po as PurchaseOrderDetail }
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * A partial delivery: how many of each line arrived today.
   *
   * Same audience as poScanIn — the person unpacking boxes is on the inventory
   * side, not necessarily the one who raised the order — because this is the
   * same physical act, only counted.
   */
  ipcMain.handle(
    IPC.poReceiveLines,
    (_e, payload: { id: string; items: PoReceiptItem[] }): Result<PurchaseOrderDetail> => {
      try {
        if (!can('module.inventory') && !can('module.invoicing'))
          return { ok: false, error: 'You do not have access to receive purchase orders.' }
        const id = String(payload?.id ?? '')
        if (!id) return { ok: false, error: 'No purchase order specified.' }
        if (!Array.isArray(payload?.items) || payload.items.length === 0) {
          return { ok: false, error: 'Enter how many of at least one item arrived.' }
        }
        const res = receivePurchaseOrderLines(id, payload.items, currentUser()?.id ?? null)
        return res.error
          ? { ok: false, error: res.error }
          : { ok: true, data: res.po as PurchaseOrderDetail }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.poSetStatus,
    (_e, payload: { id: string; status: PurchaseOrderStatus }): Result<PurchaseOrderDetail> => {
      try {
        const actor = requireInvoicing()
        if (!payload?.id) return { ok: false, error: 'No purchase order specified.' }
        if (!isPurchaseOrderStatus(payload.status)) return { ok: false, error: 'Invalid stage.' }
        const res = setPurchaseOrderStatus(payload.id, payload.status, actor.id)
        return res.error
          ? { ok: false, error: res.error }
          : { ok: true, data: res.po as PurchaseOrderDetail }
      } catch (err) {
        return fail(err)
      }
    }
  )

  // Marking an order paid is a PO write like any other, so it sits behind the
  // same single permission every other one does — no new gate, nothing extra to
  // grant, and nobody who can move a PO along the board is unable to say it was
  // paid.
  ipcMain.handle(
    IPC.poSetPaid,
    (_e, payload: { id: string; paid: boolean }): Result<PurchaseOrderDetail> => {
      try {
        const actor = requireInvoicing()
        if (!payload?.id) return { ok: false, error: 'No purchase order specified.' }
        const res = setPurchaseOrderPaid(payload.id, payload.paid !== false, actor?.id ?? null)
        return res.error
          ? { ok: false, error: res.error }
          : { ok: true, data: res.po as PurchaseOrderDetail }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.poAddLines,
    (_e, payload: { id: string; lines: NewPurchaseOrderLine[] }): Result<PurchaseOrderDetail> => {
      try {
        // The actor is carried now because adding to a running tab CHECKS THE
        // CASES IN — see takeTabDelivery — and a receipt with nobody's name on
        // it is a stock movement the log cannot explain.
        const actor = requireInvoicing()
        if (!payload?.id) return { ok: false, error: 'No purchase order specified.' }
        const res = addPurchaseOrderLines(payload.id, payload.lines ?? [], actor.id)
        return res.error
          ? { ok: false, error: res.error }
          : { ok: true, data: res.po as PurchaseOrderDetail }
      } catch (err) {
        return fail(err)
      }
    }
  )

  // Who the order is from, and the note on it. No status gate: this edits
  // nothing that has money attached, and the commonest moment to notice the
  // supplier is missing is while filing an order that is already closed.
  ipcMain.handle(
    IPC.poSetHeader,
    (
      _e,
      payload: { id: string; supplier?: string | null; notes?: string | null }
    ): Result<PurchaseOrderDetail> => {
      try {
        requireInvoicing()
        if (!payload?.id) return { ok: false, error: 'No purchase order specified.' }
        const patch: { supplier?: string | null; notes?: string | null } = {}
        if ('supplier' in payload) patch.supplier = payload.supplier ?? null
        if ('notes' in payload) patch.notes = payload.notes ?? null
        const res = updatePurchaseOrderHeader(payload.id, patch)
        return res.error
          ? { ok: false, error: res.error }
          : { ok: true, data: res.po as PurchaseOrderDetail }
      } catch (err) {
        return fail(err)
      }
    }
  )

  // Quantity and price on a line that already exists. The repository decides
  // what may move — quantity never below what landed, price frozen once
  // anything has — and returns the reason in words rather than a refusal code.
  ipcMain.handle(
    IPC.poUpdateLine,
    (
      _e,
      payload: { id: string; lineId: string; quantity?: number; unitPrice?: number }
    ): Result<PurchaseOrderDetail> => {
      try {
        requireInvoicing()
        if (!payload?.id) return { ok: false, error: 'No purchase order specified.' }
        if (!payload?.lineId) return { ok: false, error: 'No line specified.' }
        const patch: { quantity?: number; unitPrice?: number } = {}
        if (payload.quantity !== undefined) patch.quantity = Number(payload.quantity)
        if (payload.unitPrice !== undefined) patch.unitPrice = Number(payload.unitPrice)
        const res = updatePurchaseOrderLine(payload.id, payload.lineId, patch)
        return res.error
          ? { ok: false, error: res.error }
          : { ok: true, data: res.po as PurchaseOrderDetail }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.poRemoveLine,
    (_e, payload: { id: string; lineId: string }): Result<PurchaseOrderDetail> => {
      try {
        requireInvoicing()
        if (!payload?.id) return { ok: false, error: 'No purchase order specified.' }
        if (!payload?.lineId) return { ok: false, error: 'No line specified.' }
        const res = removePurchaseOrderLine(payload.id, payload.lineId)
        return res.error
          ? { ok: false, error: res.error }
          : { ok: true, data: res.po as PurchaseOrderDetail }
      } catch (err) {
        return fail(err)
      }
    }
  )

  /**
   * WHICH OPEN ROADSHOW ORDER STILL HOLDS THIS PRODUCT.
   *
   * A read, drawn on a sales order line. Bare arrays like every other read on
   * this channel family — see the note on IPC.poOpenTabs for what a Result
   * envelope does here.
   */
  ipcMain.handle(
    IPC.poSupplyingOrders,
    (_e, payload: { productId: string; location?: string | null }): SupplyingOrder[] =>
      can('module.invoicing')
        ? supplyingOrders(String(payload?.productId ?? ''), payload?.location ?? null)
        : []
  )

  ipcMain.handle(IPC.poStockSales, (_e, poId: string): InvoiceDetail[] =>
    can('module.invoicing') ? salesFromPoStock(String(poId ?? '')) : []
  )

  /**
   * THE ROADSHOW TAB: open it, price a line, settle the week.
   *
   * All three behind the same invoicing permission every other PO write uses.
   * A tab is an ordinary purchase order in every respect except that it does not
   * close itself, so somebody who may raise a PO may run a tab — a separate
   * grant would be a second thing to remember to give the person doing the
   * buying.
   */
  ipcMain.handle(IPC.poOpenTabs, (): PurchaseOrder[] =>
    can('module.invoicing') ? listOpenRoadshowTabs() : []
  )

  ipcMain.handle(
    IPC.poSetLinePrice,
    (
      _e,
      payload: { id: string; lineId: string; unitPrice: number | null }
    ): Result<PurchaseOrderDetail> => {
      try {
        const actor = requireInvoicing()
        if (!payload?.id) return { ok: false, error: 'No purchase order specified.' }
        if (!payload?.lineId) return { ok: false, error: 'No line specified.' }
        // NULL SURVIVES THE WIRE. `?? null` rather than a truthiness check,
        // because 0 is a price a roadshow really gives and folding it to
        // "unknown" here would be the exact confusion the column exists to stop.
        const price =
          payload.unitPrice === null || payload.unitPrice === undefined
            ? null
            : Number(payload.unitPrice)
        const res = setPurchaseOrderLinePrice(payload.id, payload.lineId, price, actor?.id ?? null)
        return res.error
          ? { ok: false, error: res.error }
          : { ok: true, data: res.po as PurchaseOrderDetail }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.poCloseTab,
    (_e, payload: { id: string }): Result<PurchaseOrderDetail> => {
      try {
        const actor = requireInvoicing()
        if (!payload?.id) return { ok: false, error: 'No purchase order specified.' }
        const res = closeRoadshowTab(payload.id, actor?.id ?? null)
        return res.error
          ? { ok: false, error: res.error }
          : { ok: true, data: res.po as PurchaseOrderDetail }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.poSettleTab,
    (_e, payload: { id: string }): Result<PurchaseOrderDetail> => {
      try {
        const actor = requireInvoicing()
        if (!payload?.id) return { ok: false, error: 'No purchase order specified.' }
        const res = settleRoadshowTab(payload.id, actor?.id ?? null)
        return res.error
          ? { ok: false, error: res.error }
          : { ok: true, data: res.po as PurchaseOrderDetail }
      } catch (err) {
        return fail(err)
      }
    }
  )

  // Shipping and payment details, editable for the life of the PO — the
  // tracking number turns up long after the order is placed.
  ipcMain.handle(
    IPC.poSetFreight,
    (_e, payload: { id: string } & FreightPatch): Result<PurchaseOrderDetail> => {
      try {
        requireInvoicing()
        if (!payload?.id) return { ok: false, error: 'No purchase order specified.' }
        const res = setPurchaseOrderFreight(payload.id, payload)
        return res.error
          ? { ok: false, error: res.error }
          : { ok: true, data: res.po as PurchaseOrderDetail }
      } catch (err) {
        return fail(err)
      }
    }
  )

  // Read every active order's carrier page now, rather than waiting for the
  // hour. Gated like the rest of the module; it is a read of somebody else's
  // public page, but it writes our records.
  ipcMain.handle(IPC.trackingCheckNow, async (): Promise<Result<SweepResult>> => {
    try {
      requireInvoicing()
      return { ok: true, data: await sweepTracking(true) }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.trackingCanRead, (): boolean => canRead())

  ipcMain.handle(IPC.poDelete, (_e, id: string): Result<null> => {
    try {
      const actor = requireInvoicing()
      if (!id) return { ok: false, error: 'No purchase order specified.' }
      const res = deletePurchaseOrder(id, actor.id)
      return res.ok ? { ok: true, data: null } : { ok: false, error: res.error }
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * The escape hatch for a PO that can be neither cancelled nor deleted.
   *
   * Gated exactly like poDelete — same permission, no extra ceremony — because
   * it is the same intent ("this order should not exist"), just for an order the
   * ordinary path cannot reach. What makes it safe is not a stricter gate but
   * that the CALLER states what happens to the stock, and the UI makes that
   * choice explicit before it is sent.
   */
  ipcMain.handle(
    IPC.poForceDelete,
    (_e, args: { id: string; removeStock: boolean }): Result<{ removedUnits: number; soldUnits: number }> => {
      try {
        const actor = requireInvoicing()
        if (!args?.id) return { ok: false, error: 'No purchase order specified.' }
        const res = forceDeletePurchaseOrder(args.id, !!args.removeStock, actor.id)
        return res.ok
          ? { ok: true, data: { removedUnits: res.removedUnits ?? 0, soldUnits: res.soldUnits ?? 0 } }
          : { ok: false, error: res.error }
      } catch (err) {
        return fail(err)
      }
    }
  )

  // Both PDF paths are READS of a PO — they change nothing — so they are gated
  // like poGet rather than like a write.
  ipcMain.handle(IPC.poOpenPdf, async (_e, id: string) => {
    try {
      requireInvoicing()
      const po = getPurchaseOrder(id)
      if (!po) return { ok: false, error: 'Purchase order not found.' }
      return await openPoPdf(po)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.poSavePdf, async (_e, id: string) => {
    try {
      requireInvoicing()
      const po = getPurchaseOrder(id)
      if (!po) return { ok: false, error: 'Purchase order not found.' }
      return await savePoPdf(po)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
