import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  InventoryProduct,
  NewPurchaseOrder,
  PurchaseOrder,
  PurchaseOrderDetail,
  PurchaseOrderStatus,
  Result
} from '@shared/types'
import { isPurchaseOrderStatus } from '@shared/purchaseOrders'
import type { Permission } from '@shared/permissions'
import { currentUser } from './services/auth'
import {
  createPurchaseOrder,
  getPurchaseOrder,
  listActivePurchaseOrderBoxes,
  listPurchaseOrders,
  setPurchaseOrderStatus
} from './db/purchaseOrders'
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
  ipcMain.handle(IPC.poThumbnails, (): Record<string, string> =>
    can('module.invoicing') ? productThumbnails() : {}
  )
  // Incoming PO "boxes" for the Inventory module — visible to inventory users too
  // (they see the shipments landing), not just invoicing users.
  ipcMain.handle(IPC.poIncomingBoxes, (): PurchaseOrderDetail[] =>
    can('module.inventory') || can('module.invoicing') ? listActivePurchaseOrderBoxes() : []
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
}
