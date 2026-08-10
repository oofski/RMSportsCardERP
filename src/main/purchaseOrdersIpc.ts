import { ipcMain } from './ipcRegistry'
import { IPC } from '@shared/ipc'
import type {
  CogsEntry,
  InventoryProduct,
  NewPurchaseOrder,
  PurchaseOrder,
  PurchaseOrderDetail,
  PurchaseOrderStatus,
  Result
} from '@shared/types'
import { isPurchaseOrderStatus, type SupplierSuggestion } from '@shared/purchaseOrders'
import type { FreightPatch } from '@shared/freight'
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
  listPurchaseOrders,
  listSupplierSuggestions,
  scanInPurchaseOrder,
  setPurchaseOrderFreight,
  setPurchaseOrderStatus
} from './db/purchaseOrders'
import { listCogsEntries } from './db/finance'
import { getProduct, productThumbnails, searchCatalog } from './db/inventory'

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
