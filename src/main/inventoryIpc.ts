import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  AddStockInput,
  AdjustStockInput,
  CategorySummary,
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
import { isLocation } from '@shared/inventory'
import type { Permission } from '@shared/permissions'
import { currentUser } from './services/auth'
import {
  addStock,
  adjustStock,
  categorySummaries,
  createProduct,
  deleteProduct,
  inventoryStats,
  listProducts,
  listTransactions,
  productsByCategory,
  recentSales,
  recordSale,
  salesSeries,
  searchCatalog,
  updateProduct,
  upcExists
} from './db/inventory'

const UNIT_TYPES: UnitType[] = ['case', 'box', 'pack', 'single', 'other']

function can(permission: Permission): boolean {
  const user = currentUser()
  return !!user && user.permissions.includes(permission)
}

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
  ipcMain.handle(IPC.invProductsList, (): InventoryProduct[] =>
    can('module.inventory') ? listProducts() : []
  )
  ipcMain.handle(IPC.invCatalogSearch, (_e, query: string): InventoryProduct[] =>
    can('module.inventory') ? searchCatalog(query ?? '') : []
  )
  ipcMain.handle(IPC.invStats, (): InventoryStats | null =>
    can('module.inventory') ? inventoryStats() : null
  )
  ipcMain.handle(IPC.invCategories, (): CategorySummary[] =>
    can('module.inventory') ? categorySummaries() : []
  )
  ipcMain.handle(IPC.invByCategory, (_e, category: string): InventoryProduct[] =>
    can('module.inventory') ? productsByCategory(String(category ?? '')) : []
  )
  ipcMain.handle(IPC.invRecentSales, (_e, limit?: number): InventoryTransaction[] =>
    can('module.inventory') ? recentSales(limit ?? 8) : []
  )
  ipcMain.handle(IPC.invTransactions, (_e, limit?: number): InventoryTransaction[] =>
    can('module.inventory') ? listTransactions(limit ?? 200) : []
  )
  ipcMain.handle(IPC.invSalesSeries, (_e, days?: number): SalesPoint[] =>
    can('module.inventory') ? salesSeries(days ?? 14) : []
  )

  // ---- Writes (inventory.manage) ------------------------------------------
  ipcMain.handle(IPC.invProductCreate, (_e, input: NewInventoryProduct): Result<InventoryProduct> => {
    try {
      const actor = requireManage()
      const err = validateProduct(input)
      if (err) return { ok: false, error: err }
      if (input.upc && upcExists(input.upc)) {
        return { ok: false, error: 'That UPC is already in the catalog.' }
      }
      if (input.openingQuantity && input.openingQuantity > 0 && !isLocation(input.openingLocation)) {
        return { ok: false, error: 'Choose a location for the opening stock.' }
      }
      return { ok: true, data: createProduct(input, actor.id) }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.invProductUpdate, (_e, input: UpdateInventoryProduct): Result<InventoryProduct> => {
    try {
      requireManage()
      if (input.name !== undefined && !input.name.trim()) {
        return { ok: false, error: 'A product name is required.' }
      }
      if (input.unitType && !UNIT_TYPES.includes(input.unitType)) {
        return { ok: false, error: 'Invalid unit type.' }
      }
      if (input.upc && upcExists(input.upc, input.id)) {
        return { ok: false, error: 'That UPC is already in the catalog.' }
      }
      for (const [label, value] of [
        ['Unit cost', input.unitCost],
        ['Sale price', input.salePrice],
        ['Low-stock alert', input.reorderPoint]
      ] as const) {
        if (value != null && (!Number.isFinite(value) || value < 0)) {
          return { ok: false, error: `${label} must be 0 or more.` }
        }
      }
      for (const [label, value] of [
        ['Boxes per case', input.boxesPerCase],
        ['Packs per box', input.packsPerBox]
      ] as const) {
        if (value != null && (!Number.isInteger(value) || value < 0)) {
          return { ok: false, error: `${label} must be 0 or more.` }
        }
      }
      const updated = updateProduct(input)
      return updated ? { ok: true, data: updated } : { ok: false, error: 'Product not found.' }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.invProductDelete, (_e, payload: { id: string }): Result => {
    try {
      requireManage()
      return deleteProduct(payload.id) ? { ok: true } : { ok: false, error: 'Product not found.' }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.invStockAdd, (_e, input: AddStockInput): Result<InventoryProduct> => {
    try {
      const actor = requireManage()
      if (!input.productId) return { ok: false, error: 'Select a product.' }
      if (!isLocation(input.location)) return { ok: false, error: 'Choose a location.' }
      if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
        return { ok: false, error: 'Quantity must be at least 1.' }
      }
      if (input.unitCost != null && (!Number.isFinite(input.unitCost) || input.unitCost < 0)) {
        return { ok: false, error: 'Enter a valid unit cost.' }
      }
      const res = addStock(input.productId, input.location, input.quantity, input.unitCost ?? null, input.note ?? null, actor.id)
      return res.error ? { ok: false, error: res.error } : { ok: true, data: res.product as InventoryProduct }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.invStockAdjust, (_e, input: AdjustStockInput): Result<InventoryProduct> => {
    try {
      const actor = requireManage()
      if (!input.productId) return { ok: false, error: 'Select a product.' }
      if (!isLocation(input.location)) return { ok: false, error: 'Choose a location.' }
      if (!Number.isFinite(input.quantityChange) || input.quantityChange === 0) {
        return { ok: false, error: 'Enter a non-zero quantity.' }
      }
      const res = adjustStock(input.productId, input.location, input.quantityChange, input.note ?? null, actor.id)
      return res.error ? { ok: false, error: res.error } : { ok: true, data: res.product as InventoryProduct }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.invSaleRecord, (_e, input: RecordSaleInput): Result<InventoryProduct> => {
    try {
      const actor = requireManage()
      if (!input.productId) return { ok: false, error: 'Select a product.' }
      if (!isLocation(input.location)) return { ok: false, error: 'Choose a location to sell from.' }
      if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
        return { ok: false, error: 'Quantity must be at least 1.' }
      }
      if (!Number.isFinite(input.unitPrice) || input.unitPrice < 0) {
        return { ok: false, error: 'Enter a valid sale price.' }
      }
      if (!input.client?.trim()) return { ok: false, error: 'Enter the client name.' }
      const res = recordSale(input.productId, input.location, input.quantity, input.unitPrice, input.client, input.note ?? null, actor.id)
      return res.error ? { ok: false, error: res.error } : { ok: true, data: res.product as InventoryProduct }
    } catch (err) {
      return fail(err)
    }
  })
}

function validateProduct(input: NewInventoryProduct): string | null {
  if (!input.name?.trim()) return 'A product name is required.'
  if (!UNIT_TYPES.includes(input.unitType)) return 'Choose a unit type.'
  if (!Number.isFinite(input.unitCost) || input.unitCost < 0) return 'Unit cost must be 0 or more.'
  if (!Number.isFinite(input.reorderPoint) || input.reorderPoint < 0) return 'Low-stock alert must be 0 or more.'
  if (input.salePrice != null && (!Number.isFinite(input.salePrice) || input.salePrice < 0)) {
    return 'Sale price must be 0 or more.'
  }
  for (const [label, value] of [
    ['Boxes per case', input.boxesPerCase],
    ['Packs per box', input.packsPerBox]
  ] as const) {
    if (value != null && (!Number.isInteger(value) || value < 0)) return `${label} must be 0 or more.`
  }
  return null
}
