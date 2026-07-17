import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  AdjustStockInput,
  CategoryValue,
  InventoryProduct,
  InventoryStats,
  InventoryTransaction,
  NewInventoryProduct,
  RecordSaleInput,
  Result,
  SalesPoint,
  UnitType,
  UpdateInventoryProduct
} from '@shared/types'
import type { Permission } from '@shared/permissions'
import { currentUser } from './services/auth'
import {
  adjustStock,
  createProduct,
  deleteProduct,
  inventoryStats,
  listProducts,
  listTransactions,
  recentSales,
  recordSale,
  salesSeries,
  skuExists,
  updateProduct,
  valueByCategory
} from './db/inventory'

const UNIT_TYPES: UnitType[] = ['case', 'box', 'pack', 'single', 'other']

function can(permission: Permission): boolean {
  const user = currentUser()
  return !!user && user.permissions.includes(permission)
}

/** Require a permission or throw a message the renderer surfaces as an error. */
function requireManage(): { id: string } {
  const user = currentUser()
  if (!user) throw new Error('You are not signed in.')
  if (!user.permissions.includes('inventory.manage')) {
    throw new Error('You do not have permission to manage inventory.')
  }
  return { id: user.id }
}

function fail(err: unknown): Result<never> {
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

export function registerInventoryIpc(): void {
  // ---- Reads (module.inventory) -------------------------------------------
  ipcMain.handle(IPC.invProductsList, (): InventoryProduct[] => {
    return can('module.inventory') ? listProducts() : []
  })

  ipcMain.handle(IPC.invStats, (): InventoryStats | null => {
    return can('module.inventory') ? inventoryStats() : null
  })

  ipcMain.handle(IPC.invRecentSales, (_e, limit?: number): InventoryTransaction[] => {
    return can('module.inventory') ? recentSales(limit ?? 8) : []
  })

  ipcMain.handle(IPC.invTransactions, (_e, limit?: number): InventoryTransaction[] => {
    return can('module.inventory') ? listTransactions(limit ?? 200) : []
  })

  ipcMain.handle(IPC.invValueByCategory, (): CategoryValue[] => {
    return can('module.inventory') ? valueByCategory() : []
  })

  ipcMain.handle(IPC.invSalesSeries, (_e, days?: number): SalesPoint[] => {
    return can('module.inventory') ? salesSeries(days ?? 14) : []
  })

  // ---- Writes (inventory.manage) ------------------------------------------
  ipcMain.handle(
    IPC.invProductCreate,
    (_e, input: NewInventoryProduct): Result<InventoryProduct> => {
      try {
        const actor = requireManage()
        const validation = validateProduct(input)
        if (validation) return { ok: false, error: validation }
        if (skuExists(input.sku)) return { ok: false, error: 'That SKU is already in use.' }
        return { ok: true, data: createProduct(input, actor.id) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.invProductUpdate,
    (_e, input: UpdateInventoryProduct): Result<InventoryProduct> => {
      try {
        requireManage()
        if (input.sku && skuExists(input.sku, input.id)) {
          return { ok: false, error: 'That SKU is already in use.' }
        }
        if (input.unitType && !UNIT_TYPES.includes(input.unitType)) {
          return { ok: false, error: 'Invalid unit type.' }
        }
        const updated = updateProduct(input)
        return updated ? { ok: true, data: updated } : { ok: false, error: 'Product not found.' }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.invProductDelete, (_e, payload: { id: string }): Result => {
    try {
      requireManage()
      return deleteProduct(payload.id)
        ? { ok: true }
        : { ok: false, error: 'Product not found.' }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.invSaleRecord, (_e, input: RecordSaleInput): Result<InventoryProduct> => {
    try {
      const actor = requireManage()
      if (!input.productId) return { ok: false, error: 'Select a product.' }
      if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
        return { ok: false, error: 'Quantity must be at least 1.' }
      }
      if (!Number.isFinite(input.unitPrice) || input.unitPrice < 0) {
        return { ok: false, error: 'Enter a valid sale price.' }
      }
      if (!input.client?.trim()) return { ok: false, error: 'Enter the client name.' }
      const res = recordSale(
        input.productId,
        input.quantity,
        input.unitPrice,
        input.client,
        input.note ?? null,
        actor.id
      )
      return res.error ? { ok: false, error: res.error } : { ok: true, data: res.product }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.invStockAdjust, (_e, input: AdjustStockInput): Result<InventoryProduct> => {
    try {
      const actor = requireManage()
      if (!input.productId) return { ok: false, error: 'Select a product.' }
      if (!Number.isFinite(input.quantityChange) || input.quantityChange === 0) {
        return { ok: false, error: 'Enter a non-zero quantity.' }
      }
      const type = input.type === 'adjustment' ? 'adjustment' : 'restock'
      const res = adjustStock(
        input.productId,
        type,
        input.quantityChange,
        input.unitCost ?? null,
        input.note ?? null,
        actor.id
      )
      return res.error ? { ok: false, error: res.error } : { ok: true, data: res.product }
    } catch (err) {
      return fail(err)
    }
  })
}

function validateProduct(input: NewInventoryProduct): string | null {
  if (!input.sku?.trim()) return 'A SKU is required.'
  if (!input.name?.trim()) return 'A product name is required.'
  if (!UNIT_TYPES.includes(input.unitType)) return 'Choose a unit type.'
  if (!Number.isFinite(input.quantity) || input.quantity < 0) return 'Quantity must be 0 or more.'
  if (!Number.isFinite(input.unitCost) || input.unitCost < 0) return 'Unit cost must be 0 or more.'
  return null
}
