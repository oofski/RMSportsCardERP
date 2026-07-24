import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  AddStockInput,
  AdjustStockInput,
  CategorySummary,
  IncomingShipment,
  InventoryProduct,
  InventoryStats,
  InventoryTransaction,
  NewIncomingShipment,
  NewInventoryProduct,
  NewSupply,
  PricingRow,
  ProductImage,
  ProductLot,
  RecordSaleInput,
  Result,
  SalesPoint,
  Supply,
  SupplyPurchaseInput,
  SupplyStats,
  SupplyUseInput,
  UnitType,
  UpdateInventoryProduct,
  UpdateSupply
} from '@shared/types'
import { isLocation } from '@shared/inventory'
import type { Permission } from '@shared/permissions'
import { currentUser } from './services/auth'
import { IMAGE_EXTENSIONS } from './services/media'
import {
  addProductImage,
  addStock,
  adjustStock,
  categorySummaries,
  createProduct,
  deleteProduct,
  getProduct,
  inventoryStats,
  listLots,
  listProductImages,
  listProducts,
  listTransactions,
  pricingList,
  productThumbnails,
  productsByCategory,
  recentSales,
  recordSale,
  removeProductImage,
  salesSeries,
  searchCatalog,
  updateHighBid,
  updateProduct,
  upcExists
} from './db/inventory'
import { addIncoming, cancelIncoming, listIncoming, receiveIncoming } from './db/incoming'
import {
  SUPPLY_UNITS,
  adjustSupply,
  clearSupplyImage,
  createSupply,
  deleteSupply,
  listSupplies,
  purchaseSupply,
  setSupplyImage,
  supplyStats,
  updateSupply,
  useSupply
} from './db/supplies'

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

/** Pricing updates are allowed for inventory managers or holders of the
 * individually-granted `inventory.pricing` permission. */
function requirePricing(): { id: string } {
  const user = currentUser()
  if (!user) throw new Error('You are not signed in.')
  if (!user.permissions.includes('inventory.pricing') && !user.permissions.includes('inventory.manage')) {
    throw new Error('You do not have permission to update pricing.')
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
  ipcMain.handle(IPC.invThumbnails, (): Record<string, string> =>
    can('module.inventory') ? productThumbnails() : {}
  )
  ipcMain.handle(IPC.invImageList, (_e, productId: string): ProductImage[] =>
    can('module.inventory') ? listProductImages(productId) : []
  )
  ipcMain.handle(IPC.invIncomingList, (): IncomingShipment[] =>
    can('module.inventory') ? listIncoming() : []
  )
  ipcMain.handle(IPC.invPricingList, (): PricingRow[] =>
    can('module.inventory') ? pricingList() : []
  )
  ipcMain.handle(IPC.invProductLots, (_e, productId: string): ProductLot[] =>
    can('module.inventory') ? listLots(String(productId ?? '')) : []
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
        ['High bid', input.highBid],
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

  ipcMain.handle(IPC.invImageAdd, async (e, productId: string): Promise<Result<ProductImage[]>> => {
    try {
      requireManage()
      if (!productId) return { ok: false, error: 'Select a product.' }
      const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow()
      const opts: OpenDialogOptions = {
        title: 'Add product image',
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: IMAGE_EXTENSIONS }]
      }
      const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: 'No image selected.' }
      return { ok: true, data: addProductImage(productId, picked.filePaths[0]) }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.invImageRemove, (_e, imageId: string): Result<ProductImage[]> => {
    try {
      requireManage()
      if (!imageId) return { ok: false, error: 'No image specified.' }
      return { ok: true, data: removeProductImage(imageId).images }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.invIncomingAdd, (_e, input: NewIncomingShipment): Result<IncomingShipment> => {
    try {
      requireManage()
      if (!input.productId) return { ok: false, error: 'Select a product.' }
      if (!getProduct(input.productId)) return { ok: false, error: 'Select a valid product.' }
      if (!isLocation(input.location)) return { ok: false, error: 'Choose a destination location.' }
      if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
        return { ok: false, error: 'Quantity must be a whole number of at least 1.' }
      }
      if (input.unitCost != null && (!Number.isFinite(input.unitCost) || input.unitCost < 0)) {
        return { ok: false, error: 'Enter a valid unit cost.' }
      }
      if (input.expectedDate != null && input.expectedDate !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(input.expectedDate)) {
        return { ok: false, error: 'Enter the expected date as YYYY-MM-DD.' }
      }
      return { ok: true, data: addIncoming(input) }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.invIncomingReceive, (_e, payload: { id: string }): Result => {
    try {
      const actor = requireManage()
      if (!payload?.id) return { ok: false, error: 'No shipment specified.' }
      const res = receiveIncoming(payload.id, actor.id)
      return res.ok ? { ok: true } : { ok: false, error: res.error }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.invIncomingCancel, (_e, payload: { id: string }): Result => {
    try {
      requireManage()
      if (!payload?.id) return { ok: false, error: 'No shipment specified.' }
      return cancelIncoming(payload.id) ? { ok: true } : { ok: false, error: 'Shipment not found.' }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    IPC.invHighBidUpdate,
    (_e, input: { productId: string; highBid: number | null }): Result<InventoryProduct> => {
      try {
        requirePricing()
        if (!input?.productId) return { ok: false, error: 'Select a product.' }
        if (input.highBid != null && (!Number.isFinite(input.highBid) || input.highBid < 0)) {
          return { ok: false, error: 'High bid must be 0 or more.' }
        }
        const updated = updateHighBid(input.productId, input.highBid)
        return updated ? { ok: true, data: updated } : { ok: false, error: 'Product not found.' }
      } catch (err) {
        return fail(err)
      }
    }
  )

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

  // ---- Supplies (operating consumables) -----------------------------------
  ipcMain.handle(IPC.suppliesList, (): Supply[] => (can('module.inventory') ? listSupplies() : []))
  ipcMain.handle(IPC.suppliesStats, (): SupplyStats | null =>
    can('module.inventory') ? supplyStats() : null
  )

  ipcMain.handle(IPC.supplyCreate, (_e, input: NewSupply): Result<Supply> => {
    try {
      const actor = requireManage()
      if (!input?.name?.trim()) return { ok: false, error: 'A supply name is required.' }
      if (!SUPPLY_UNITS.includes(input.unit)) return { ok: false, error: 'Choose a unit.' }
      if (input.unitCost != null && (!Number.isFinite(input.unitCost) || input.unitCost < 0)) {
        return { ok: false, error: 'Unit cost must be 0 or more.' }
      }
      if (input.reorderPoint != null && (!Number.isFinite(input.reorderPoint) || input.reorderPoint < 0)) {
        return { ok: false, error: 'Reorder point must be 0 or more.' }
      }
      if (input.itemsPerUnit != null && (!Number.isFinite(input.itemsPerUnit) || input.itemsPerUnit < 1)) {
        return { ok: false, error: 'Items per unit must be at least 1.' }
      }
      if (
        input.openingQuantity != null &&
        (!Number.isFinite(input.openingQuantity) || input.openingQuantity < 0)
      ) {
        return { ok: false, error: 'Opening quantity must be 0 or more.' }
      }
      return { ok: true, data: createSupply(input, actor.id) }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.supplyUpdate, (_e, input: UpdateSupply): Result<Supply> => {
    try {
      requireManage()
      if (!input?.id) return { ok: false, error: 'No supply specified.' }
      if (input.name !== undefined && !input.name.trim()) {
        return { ok: false, error: 'A supply name is required.' }
      }
      if (input.unit !== undefined && !SUPPLY_UNITS.includes(input.unit)) {
        return { ok: false, error: 'Invalid unit.' }
      }
      if (input.unitCost != null && (!Number.isFinite(input.unitCost) || input.unitCost < 0)) {
        return { ok: false, error: 'Unit cost must be 0 or more.' }
      }
      if (input.reorderPoint != null && (!Number.isFinite(input.reorderPoint) || input.reorderPoint < 0)) {
        return { ok: false, error: 'Reorder point must be 0 or more.' }
      }
      if (input.itemsPerUnit != null && (!Number.isFinite(input.itemsPerUnit) || input.itemsPerUnit < 1)) {
        return { ok: false, error: 'Items per unit must be at least 1.' }
      }
      const updated = updateSupply(input)
      return updated ? { ok: true, data: updated } : { ok: false, error: 'Supply not found.' }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.supplyDelete, (_e, payload: { id: string }): Result => {
    try {
      requireManage()
      if (!payload?.id) return { ok: false, error: 'No supply specified.' }
      return deleteSupply(payload.id) ? { ok: true } : { ok: false, error: 'Supply not found.' }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    IPC.supplyPurchase,
    (_e, payload: { id: string } & SupplyPurchaseInput): Result<Supply> => {
      try {
        const actor = requireManage()
        if (!payload?.id) return { ok: false, error: 'No supply specified.' }
        if (!Number.isFinite(payload.units) || payload.units <= 0) {
          return { ok: false, error: 'Enter at least 1 unit.' }
        }
        if (!Number.isFinite(payload.itemsPerUnit) || payload.itemsPerUnit < 1) {
          return { ok: false, error: 'Items per unit must be at least 1.' }
        }
        if (!Number.isFinite(payload.total) || payload.total < 0) {
          return { ok: false, error: 'Enter the order total.' }
        }
        const res = purchaseSupply(
          payload.id,
          {
            units: payload.units,
            itemsPerUnit: payload.itemsPerUnit,
            total: payload.total,
            note: payload.note ?? null
          },
          actor.id
        )
        return res.error ? { ok: false, error: res.error } : { ok: true, data: res.supply as Supply }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.supplySetImage, async (e, payload: { id: string }): Promise<Result<Supply>> => {
    try {
      requireManage()
      if (!payload?.id) return { ok: false, error: 'No supply specified.' }
      const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow()
      const opts: OpenDialogOptions = {
        title: 'Add supply photo',
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: IMAGE_EXTENSIONS }]
      }
      const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: 'No image selected.' }
      const updated = setSupplyImage(payload.id, picked.filePaths[0])
      return updated ? { ok: true, data: updated } : { ok: false, error: 'Supply not found.' }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.supplyRemoveImage, (_e, payload: { id: string }): Result<Supply> => {
    try {
      requireManage()
      if (!payload?.id) return { ok: false, error: 'No supply specified.' }
      const updated = clearSupplyImage(payload.id)
      return updated ? { ok: true, data: updated } : { ok: false, error: 'Supply not found.' }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.supplyUse, (_e, payload: { id: string } & SupplyUseInput): Result<Supply> => {
    try {
      const actor = requireManage()
      if (!payload?.id) return { ok: false, error: 'No supply specified.' }
      if (!Number.isFinite(payload.quantity) || payload.quantity <= 0) {
        return { ok: false, error: 'Quantity must be at least 1.' }
      }
      const res = useSupply(payload.id, { quantity: payload.quantity, note: payload.note ?? null }, actor.id)
      return res.error ? { ok: false, error: res.error } : { ok: true, data: res.supply as Supply }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    IPC.supplyAdjust,
    (_e, payload: { id: string; quantityChange: number; note?: string | null }): Result<Supply> => {
      try {
        const actor = requireManage()
        if (!payload?.id) return { ok: false, error: 'No supply specified.' }
        if (!Number.isFinite(payload.quantityChange) || payload.quantityChange === 0) {
          return { ok: false, error: 'Enter a non-zero quantity.' }
        }
        const res = adjustSupply(payload.id, payload.quantityChange, payload.note ?? null, actor.id)
        return res.error ? { ok: false, error: res.error } : { ok: true, data: res.supply as Supply }
      } catch (err) {
        return fail(err)
      }
    }
  )
}

function validateProduct(input: NewInventoryProduct): string | null {
  if (!input.name?.trim()) return 'A product name is required.'
  if (!UNIT_TYPES.includes(input.unitType)) return 'Choose a unit type.'
  if (!Number.isFinite(input.unitCost) || input.unitCost < 0) return 'Unit cost must be 0 or more.'
  if (!Number.isFinite(input.reorderPoint) || input.reorderPoint < 0) return 'Low-stock alert must be 0 or more.'
  if (input.salePrice != null && (!Number.isFinite(input.salePrice) || input.salePrice < 0)) {
    return 'Sale price must be 0 or more.'
  }
  if (input.highBid != null && (!Number.isFinite(input.highBid) || input.highBid < 0)) {
    return 'High bid must be 0 or more.'
  }
  for (const [label, value] of [
    ['Boxes per case', input.boxesPerCase],
    ['Packs per box', input.packsPerBox]
  ] as const) {
    if (value != null && (!Number.isInteger(value) || value < 0)) return `${label} must be 0 or more.`
  }
  return null
}
