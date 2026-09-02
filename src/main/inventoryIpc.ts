import { SHIP_SUPPLY_ROLES } from '@shared/shippingSupplies'
import {
  BrowserWindow,
  dialog,
  type OpenDialogOptions,
  type SaveDialogOptions
} from 'electron'
import { ipcMain } from './ipcRegistry'
import { writeFileSync } from 'node:fs'
import { IPC } from '@shared/ipc'
import type { StockLocation } from '@shared/inventory'
import {
  listStockLocations,
  saveStockLocation,
  setStockLocationPinned,
  setStockLocationRetired
} from './db/stockLocations'
import type {
  ResetApplyResult,
  ResetField,
  ResetRunSummary
} from '@shared/inventoryReset'
import type { StockProvenance } from '@shared/provenance'
import { productProvenance, shopBuys,
  shopShelf,
  shopSales
} from './db/provenance'
import type { ProductAvailability, ShopBuy, StockAtLocationRow, ShopShelfRow, ShopSale } from '@shared/availability'
import { productAvailability, stockAtLocation } from './db/inventory'
import type { Consignment, NewConsignment } from '@shared/consignment'
import {
  consignmentsForProduct,
  listOpenConsignments,
  sendOnConsignment,
  settleConsignment
} from './db/consignment'
import type { StockMoveRequest } from '@shared/stockMove'
import type {
  AddStockInput,
  AdjustStockInput,
  CategorySummary,
  CostBasisFix,
  IncomingShipment,
  InventoryProduct,
  InventoryStats,
  InventoryTransaction,
  LotPickerData,
  NewIncomingShipment,
  NewInventoryProduct,
  NewSupply,
  NewSupplyOrder,
  PricingRow,
  ProductImage,
  ProductLot,
  RecordSaleInput,
  Result,
  SalesPoint,
  ScanCommitInput,
  ScanCommitKind,
  ScanCommitResult,
  ScanDirection,
  ScanMode,
  ScanRecord,
  ScanResolution,
  Supply,
  SupplyOrder,
  SupplyOrderStatus,
  SupplyPurchaseInput,
  SupplyStats,
  SupplyUseInput,
  UnitType,
  UpdateInventoryProduct,
  UpdateSupply,
  UploadedFile
} from '@shared/types'
import { isLocation } from '@shared/inventory'
import { tidyPicks } from '@shared/costLots'
import type { Permission } from '@shared/permissions'
import { currentUser } from './services/auth'
import { IMAGE_EXTENSIONS } from './services/media'
import { uploadedBytes, uploadedName, uploadedText } from './util'
import {
  addProductImage,
  addStock,
  adjustStock,
  moveStock,
  categorySummaries,
  createProduct,
  deleteProduct,
  getProduct,
  inventoryStats,
  listLots,
  lotOptions,
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
  setZeroCostBasis,
  updateHighBid,
  updateProduct,
  upcExists
} from './db/inventory'
import { addIncoming, cancelIncoming, listIncoming, receiveIncoming } from './db/incoming'
import { auditStock } from './db/stockAudit'
import type { StockAudit } from '@shared/stockAudit'
import { commitScan, listScans, logScanMiss, resolveScan, undoScan } from './db/scanning'
import type { ResetApplyInput, ResetPreview, ResetPreviewInput } from './db/inventoryReset'
import {
  applyReset,
  buildResetExport,
  listResetRuns,
  previewReset,
  readSheetFile,
  readSheetText,
  resetRunDetail
} from './db/inventoryReset'
import {
  SUPPLY_UNITS,
  adjustSupply,
  setSupplyShipRole,
  clearSupplyImage,
  createSupply,
  createSupplyOrder,
  deleteSupply,
  deleteSupplyOrder,
  listSupplies,
  listSupplyOrders,
  purchaseSupply,
  setSupplyImage,
  setSupplyOrderStatus,
  supplyStats,
  updateSupply,
  useSupply
} from './db/supplies'

const UNIT_TYPES: UnitType[] = ['case', 'box', 'pack', 'single', 'other']

/**
 * Is this a name we are willing to store an image under?
 *
 * Checked on the UPLOAD path only — the desktop picker already filters by
 * extension. Without it a browser could name a file anything at all, and
 * media.ts would fall back to .png rather than refusing, which turns an
 * obviously wrong upload into a broken thumbnail nobody can explain.
 */
function hasImageExtension(filename: string): boolean {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  return IMAGE_EXTENSIONS.includes(ext)
}

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

/** A reorder link is optional, but when given must be a web URL we can open. */
function validateReorderUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim()
  if (!trimmed) return null
  if (!/^https?:\/\//i.test(trimmed)) {
    return 'Reorder link must start with http:// or https://'
  }
  return null
}

export function registerInventoryIpc(): void {
  // ---- Reads (module.inventory) -------------------------------------------
  /**
   * The places stock can sit.
   *
   * The LIST is readable by anyone who can see inventory — every picker in the
   * app needs it, and it is a list of shop names. Changing the set is gated on
   * `inventory.manage`, because adding a shelf changes what counts as a dropship
   * and therefore what draws stock.
   */
  ipcMain.handle(IPC.invLocationsList, (): StockLocation[] =>
    can('module.inventory') ? listStockLocations() : []
  )

  ipcMain.handle(
    IPC.invLocationSave,
    (_e, input: { id?: string | null; label: string; pinned?: boolean }): Result<StockLocation[]> => {
      if (!can('inventory.manage')) return { ok: false, error: 'Not yours to change.' }
      return saveStockLocation(input ?? { label: '' }, currentUser()?.id ?? null)
    }
  )

  ipcMain.handle(
    IPC.invLocationRetire,
    (_e, input: { id: string; retired: boolean }): Result<StockLocation[]> => {
      if (!can('inventory.manage')) return { ok: false, error: 'Not yours to change.' }
      return setStockLocationRetired(String(input?.id ?? ''), !!input?.retired)
    }
  )

  ipcMain.handle(
    IPC.invLocationPin,
    (_e, input: { id: string; pinned: boolean }): Result<StockLocation[]> => {
      if (!can('inventory.manage')) return { ok: false, error: 'Not yours to change.' }
      return setStockLocationPinned(String(input?.id ?? ''), !!input?.pinned)
    }
  )

  ipcMain.handle(IPC.invProductsList, (): InventoryProduct[] =>
    can('module.inventory') ? listProducts() : []
  )
  // Streaming needs this too: recording a break means picking the product that
  // was opened, and gating the search on inventory alone would leave a
  // streaming-only operator able to read every session but unable to add a
  // single line to one. Read-only catalog lookup either way.
  ipcMain.handle(IPC.invCatalogSearch, (_e, query: string): InventoryProduct[] =>
    can('module.inventory') || can('module.streaming') ? searchCatalog(query ?? '') : []
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
  // READS ONLY. The audit names what disagrees; the repairs are the buttons that
  // already exist on the orders and the shelves. See @shared/stockAudit.
  ipcMain.handle(IPC.invStockAudit, (): StockAudit =>
    can('module.inventory')
      ? auditStock()
      : { findings: [], ordersChecked: 0, shelvesChecked: 0, checkedAt: new Date().toISOString() }
  )
  ipcMain.handle(IPC.invPricingList, (): PricingRow[] =>
    can('module.inventory') ? pricingList() : []
  )
  ipcMain.handle(IPC.invProductLots, (_e, productId: string): ProductLot[] =>
    can('module.inventory') ? listLots(String(productId ?? '')) : []
  )

  /**
   * WHERE THIS PRODUCT IS, place by place. See productAvailability.
   *
   * Gated on `module.invoicing` as well as inventory, because the screen that
   * needs it is the sales-order line: somebody writing an invoice has to be
   * able to see whether the seven exist without also being given the inventory
   * module. It names quantities and places and no money at all, which is what
   * makes that widening safe.
   */
  /**
   * What one place is holding. The shop board's whole read.
   *
   * Same gate as every other inventory read: a shelf's contents is stock
   * information and is not offered to somebody without the module.
   */
  /**
   * The dates and the order numbers behind one tile.
   *
   * Read on demand — when somebody opens a tile — rather than with the board:
   * four shops of twenty products would be eighty queries to answer a question
   * about one of them.
   */
  ipcMain.handle(
    IPC.invShopBuys,
    (_e, payload: { location: string; productId: string }): ShopBuy[] => {
      if (!can('module.inventory')) return []
      return shopBuys(String(payload?.location ?? ''), String(payload?.productId ?? ''))
    }
  )

  ipcMain.handle(IPC.invStockAtLocation, (_e, location: string): StockAtLocationRow[] => {
    if (!can('module.inventory')) return []
    return stockAtLocation(String(location ?? ''))
  })

  /**
   * WHAT A SHOP HANDED OVER AND WHAT BECAME OF IT — bought, here, sold.
   *
   * A read, gated like every other inventory read. Bare array on the empty case,
   * matching stockAtLocation beside it.
   */
  ipcMain.handle(IPC.invShopShelf, (_e, location: unknown): ShopShelfRow[] =>
    can('module.inventory') ? shopShelf(String(location ?? '')) : []
  )

  /** Where this product went from this shop. See shopSales. */
  ipcMain.handle(
    IPC.invShopSales,
    (_e, payload: { location?: string; productId?: string }): ShopSale[] =>
      can('module.inventory')
        ? shopSales(String(payload?.location ?? ''), String(payload?.productId ?? ''))
        : []
  )

  ipcMain.handle(IPC.invProductAvailability, (_e, productId: string): ProductAvailability => {
    if (!can('module.inventory') && !can('module.invoicing')) {
      return { productId: '', places: [] }
    }
    return productAvailability(String(productId ?? ''))
  })

  /**
   * Where these cases came from, and what is still on order.
   *
   * Gated on module.inventory alone. It names SUPPLIERS AND PRICES — what the
   * business pays, and who it buys from — which is not floor information the way
   * a pick list is, and the cost-lot picker's wider gate would hand it to a
   * streaming-only operator who has no reason to see it.
   */
  ipcMain.handle(IPC.invProductProvenance, (_e, productId: string): StockProvenance | null =>
    can('module.inventory') ? productProvenance(String(productId ?? '')) : null
  )
  // The cost-lot picker's read. Gated like the catalog search rather than like
  // the rest of Inventory: a streaming-only operator is exactly who this dialog
  // is for — they are the one ripping the case — and locking it behind
  // module.inventory would leave them recording breaks with no way to say which
  // case they opened, which is the whole complaint this answers.
  ipcMain.handle(
    IPC.invLotOptions,
    (_e, input: { productId: string; location: string }): LotPickerData | null => {
      if (!can('module.inventory') && !can('module.streaming')) return null
      const productId = String(input?.productId ?? '')
      const location = String(input?.location ?? '')
      if (!productId || !isLocation(location)) return null
      return lotOptions(productId, location)
    }
  )

  // ---- UPC scanning -------------------------------------------------------
  // Looking a barcode up is a read (a view-only user may check what a box is);
  // committing, logging a miss and undoing all write stock and cost, so they go
  // through requireManage(). Deliberately stricter than poScanIn, which also
  // accepts module.invoicing: 'inventory.manage' is the app's single gate for
  // writing stock and cost, and this path writes both.
  // The direction rides the EXISTING channel as a second argument rather than a
  // new one: an outbound resolve is the same question ("what is this barcode?")
  // asked with purchase orders and cost out of the picture.
  ipcMain.handle(
    IPC.invScanResolve,
    (_e, rawCode: string, direction?: ScanDirection): ScanResolution | null =>
      can('module.inventory') ? resolveScan(String(rawCode ?? ''), direction === 'out' ? 'out' : 'in') : null
  )
  ipcMain.handle(IPC.invScanHistory, (_e, limit?: number): ScanRecord[] =>
    can('module.inventory') ? listScans(limit ?? 50) : []
  )

  ipcMain.handle(IPC.invScanCommit, (_e, input: ScanCommitInput): Result<ScanCommitResult> => {
    try {
      const actor = requireManage()
      // Every kind `commitScan` implements. 'so_line' was missing, so scanning
      // stock OUT against a sales order was refused here — "Nothing to scan." —
      // before the backend that implements it correctly was ever reached. The
      // scanning suite passed throughout because it calls commitScan directly
      // and never crosses this boundary, which both transports do.
      const kinds: ScanCommitKind[] = ['po_line', 'so_line', 'add_stock', 'remove_stock']
      if (!kinds.includes(input?.kind)) {
        return { ok: false, error: 'Nothing to scan.' }
      }
      if (input.kind === 'po_line' && !input.lineId) {
        return { ok: false, error: 'No purchase order line specified.' }
      }
      if (input.kind === 'add_stock' || input.kind === 'remove_stock') {
        if (!input.productId) return { ok: false, error: 'Select a product.' }
        if (input.location != null && !isLocation(input.location)) {
          return { ok: false, error: 'Choose a location.' }
        }
      }
      // A quantity is optional on a PO line ("receive the rest"), but when given
      // it must be a whole number of at least 1 on either path.
      if (input.quantity != null && (!Number.isInteger(input.quantity) || input.quantity < 1)) {
        return { ok: false, error: 'Quantity must be a whole number of at least 1.' }
      }
      if (input.unitCost != null && (!Number.isFinite(input.unitCost) || input.unitCost < 0)) {
        return { ok: false, error: 'Enter a valid unit cost.' }
      }
      const res = commitScan(input, actor.id)
      return res.error ? { ok: false, error: res.error } : { ok: true, data: res.result as ScanCommitResult }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    IPC.invScanLogMiss,
    (_e, payload: { rawCode: string; mode: ScanMode }): Result<ScanRecord | null> => {
      try {
        const actor = requireManage()
        return { ok: true, data: logScanMiss(String(payload?.rawCode ?? ''), payload?.mode ?? 'wedge', actor.id) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.invScanUndo, (_e, payload: { id: string }): Result<ScanRecord> => {
    try {
      const actor = requireManage()
      if (!payload?.id) return { ok: false, error: 'No scan specified.' }
      const res = undoScan(String(payload.id), actor.id)
      return res.error ? { ok: false, error: res.error } : { ok: true, data: res.record as ScanRecord }
    } catch (err) {
      return fail(err)
    }
  })

  // ---- Mass re-adjustment (Admin → Inventory reset) ------------------------
  //
  // Preview is a READ: it parses the sheet, matches it against the catalog and
  // works out the before→after, touching nothing. It is gated on the same
  // 'inventory.manage' as the apply anyway — the plan names every product and
  // its cost, which is not something a view-only account should be able to
  // assemble by pasting a guess.
  ipcMain.handle(IPC.invResetPreview, (_e, input: ResetPreviewInput): ResetPreview | null => {
    if (!can('inventory.manage')) return null
    return previewReset({
      text: String(input?.text ?? ''),
      mapping: Array.isArray(input?.mapping) ? (input.mapping as ResetField[]) : null,
      defaultLocation: input?.defaultLocation
    })
  })

  /**
   * Get a count sheet's text.
   *
   * A browser sends the CONTENT it read locally and this echoes it back — which
   * looks redundant until you notice that the round trip is what makes the
   * permission check above run. Skipping it client-side would let anyone paste
   * a sheet into the preview; the apply is checked again either way, but a
   * preview nobody is allowed to see is still a disclosure.
   */
  ipcMain.handle(
    IPC.invResetPickFile,
    async (e, upload?: UploadedFile): Promise<Result<{ text: string; filename: string }>> => {
      try {
        requireManage()
        const text = uploadedText(upload)
        if (text !== null) return readSheetText(text, uploadedName(upload, 'count-sheet.csv'))
        const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow()
        const opts: OpenDialogOptions = {
          title: 'Choose the count sheet',
          properties: ['openFile'],
          filters: [
            { name: 'Spreadsheet export', extensions: ['csv', 'tsv', 'txt'] },
            { name: 'All files', extensions: ['*'] }
          ]
        }
        const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
        if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: 'No file selected.' }
        return readSheetFile(picked.filePaths[0])
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.invResetApply, (_e, input: ResetApplyInput): Result<ResetApplyResult> => {
    try {
      const actor = requireManage()
      if (!Array.isArray(input?.mapping)) return { ok: false, error: 'No column mapping supplied.' }
      return applyReset(
        {
          text: String(input.text ?? ''),
          mapping: input.mapping as ResetField[],
          defaultLocation: input.defaultLocation,
          source: input.source
        },
        actor.id
      )
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.invResetHistory, (_e, limit?: number): ResetRunSummary[] =>
    can('inventory.manage') ? listResetRuns(limit ?? 12) : []
  )

  ipcMain.handle(IPC.invResetRunDetail, (_e, id: string): string[] =>
    can('inventory.manage') ? resetRunDetail(String(id ?? '')) : []
  )

  ipcMain.handle(IPC.invResetExport, async (e): Promise<Result<{ path: string }>> => {
    try {
      requireManage()
      const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow()
      const stamp = new Date().toISOString().slice(0, 10)
      const opts: SaveDialogOptions = {
        title: 'Export the current count',
        defaultPath: `rm-inventory-count-${stamp}.tsv`,
        filters: [{ name: 'Tab-separated', extensions: ['tsv'] }]
      }
      const picked = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (picked.canceled || !picked.filePath) return { ok: false, error: 'Export cancelled.' }
      writeFileSync(picked.filePath, buildResetExport(), 'utf8')
      return { ok: true, data: { path: picked.filePath } }
    } catch (err) {
      return fail(err)
    }
  })

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
      // deleteProduct owns the refusal reason now — it knows which purchase
      // orders are blocking, and "Product not found" would hide that.
      return deleteProduct(payload.id)
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
      const res = addStock(
        input.productId,
        input.location,
        input.quantity,
        input.unitCost ?? null,
        input.note ?? null,
        actor.id,
        input.vendor ?? null
      )
      return res.error ? { ok: false, error: res.error } : { ok: true, data: res.product as InventoryProduct }
    } catch (err) {
      return fail(err)
    }
  })

  // ---- Consignment ---------------------------------------------------------
  //
  // Gated on `inventory.manage`, the same permission that adjusts stock — which
  // is exactly what sending a case out on consignment IS: units leave the shelf
  // and the cost layers they came from are consumed. See @shared/consignment for
  // why that is the design rather than a flag.
  ipcMain.handle(
    IPC.invConsignSend,
    (_e, input: NewConsignment): Result<Consignment> => {
      try {
        const actor = requireManage()
        const res = sendOnConsignment(input, actor.id)
        if (res.error) return { ok: false, error: res.error }
        if (!res.consignment) return { ok: false, error: 'Could not send that.' }
        return { ok: true, data: res.consignment }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.invConsignSettle,
    (_e, payload: { id?: unknown; outcome?: unknown }): Result<Consignment> => {
      try {
        const actor = requireManage()
        // Anything that is not the word "sold" settles as RETURNED, which is the
        // safe half: a return puts the units back and can be corrected by
        // sending them again, while a wrongly-recorded sale leaves a case
        // written off that is sitting in somebody's shop.
        const outcome = String(payload?.outcome ?? '') === 'sold' ? 'sold' : 'returned'
        const res = settleConsignment(String(payload?.id ?? ''), outcome, actor.id)
        if (res.error) return { ok: false, error: res.error }
        if (!res.consignment) return { ok: false, error: 'Could not settle that.' }
        return { ok: true, data: res.consignment }
      } catch (err) {
        return fail(err)
      }
    }
  )

  // Reads, gated like every other inventory read rather than like a write.
  ipcMain.handle(IPC.invConsignForProduct, (_e, productId: unknown): Consignment[] =>
    can('module.inventory') ? consignmentsForProduct(String(productId ?? '')) : []
  )
  ipcMain.handle(IPC.invConsignOpen, (): Consignment[] =>
    can('module.inventory') ? listOpenConsignments() : []
  )

  ipcMain.handle(IPC.invStockAdjust, (_e, input: AdjustStockInput): Result<InventoryProduct> => {
    try {
      const actor = requireManage()
      if (!input.productId) return { ok: false, error: 'Select a product.' }
      if (!isLocation(input.location)) return { ok: false, error: 'Choose a location.' }
      if (!Number.isFinite(input.quantityChange) || input.quantityChange === 0) {
        return { ok: false, error: 'Enter a non-zero quantity.' }
      }
      // Tidied here rather than trusted: the dialog holds a row for every layer
      // on screen and most are zero, and a zero slice would claim a layer
      // supplied nothing. An allocation that tidies to empty is the same as none
      // given, which is the no-choice case and runs FIFO.
      const allocation = tidyPicks(Array.isArray(input.allocation) ? input.allocation : [])
      const res = adjustStock(
        input.productId,
        input.location,
        input.quantityChange,
        input.note ?? null,
        actor.id,
        allocation
      )
      return res.error ? { ok: false, error: res.error } : { ok: true, data: res.product as InventoryProduct }
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * CARRY UNITS TO ANOTHER SHELF. See moveStock, and @shared/stockMove for why
   * this is neither a re-route nor a pair of adjustments.
   *
   * Both shelves are checked against the registry, not just the destination: a
   * move OFF a name that is not a place could only ever be a move off nothing,
   * and the honest answer is to say so rather than to silently succeed at
   * changing no stock.
   */
  ipcMain.handle(IPC.invStockMove, (_e, input: StockMoveRequest): Result<InventoryProduct> => {
    try {
      const actor = requireManage()
      if (!input?.productId) return { ok: false, error: 'Select a product.' }
      if (!isLocation(input?.from)) return { ok: false, error: 'Choose where these are coming from.' }
      if (!isLocation(input?.to)) return { ok: false, error: 'Choose where these are going.' }
      const res = moveStock(
        {
          productId: String(input.productId),
          from: String(input.from),
          to: String(input.to),
          quantity: Number(input.quantity),
          note: input.note ?? null
        },
        actor.id
      )
      return res.error ? { ok: false, error: res.error } : { ok: true, data: res.product as InventoryProduct }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    IPC.invImageAdd,
    async (e, productId: string, upload?: UploadedFile): Promise<Result<ProductImage[]>> => {
      try {
        requireManage()
        if (!productId) return { ok: false, error: 'Select a product.' }
        // Browser: the bytes are already here. Desktop: open the picker.
        const bytes = uploadedBytes(upload)
        if (bytes) {
          const filename = uploadedName(upload, 'image.png')
          if (!hasImageExtension(filename)) return { ok: false, error: 'Choose a PNG, JPG, WEBP or GIF.' }
          return { ok: true, data: addProductImage(productId, { filename, bytes }) }
        }
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
    }
  )

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

  // Behind `inventory.manage`, not `inventory.pricing`: this writes COST, and it
  // rewrites cost layers to do it. Pricing is what the stock is worth on the
  // market; this is what it cost, which is the other half of every margin.
  ipcMain.handle(
    IPC.invCostBasisFix,
    (_e, input: { productId: string; unitCost: number }): Result<CostBasisFix> => {
      try {
        requireManage()
        if (!input?.productId) return { ok: false, error: 'Select a product.' }
        // Zero is refused rather than accepted-and-ignored. The whole point of
        // this call is to move stock OFF a zero basis, and a form that quietly
        // accepted a 0 would report success and clear nothing.
        if (!Number.isFinite(input.unitCost) || input.unitCost <= 0) {
          return { ok: false, error: 'Enter what one unit cost — more than $0.00.' }
        }
        const fixed = setZeroCostBasis(input.productId, input.unitCost)
        return fixed ? { ok: true, data: fixed } : { ok: false, error: 'Product not found.' }
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
      const res = recordSale(
        input.productId,
        input.location,
        input.quantity,
        input.unitPrice,
        input.client,
        input.note ?? null,
        actor.id,
        tidyPicks(Array.isArray(input.allocation) ? input.allocation : [])
      )
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
      const urlErr = validateReorderUrl(input.reorderUrl)
      if (urlErr) return { ok: false, error: urlErr }
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
      const urlErr = validateReorderUrl(input.reorderUrl)
      if (urlErr) return { ok: false, error: urlErr }
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

  ipcMain.handle(
    IPC.supplySetImage,
    async (e, payload: { id: string; upload?: UploadedFile }): Promise<Result<Supply>> => {
      try {
        requireManage()
        if (!payload?.id) return { ok: false, error: 'No supply specified.' }
        const bytes = uploadedBytes(payload.upload)
        if (bytes) {
          const filename = uploadedName(payload.upload, 'image.png')
          if (!hasImageExtension(filename)) return { ok: false, error: 'Choose a PNG, JPG, WEBP or GIF.' }
          const saved = setSupplyImage(payload.id, { filename, bytes })
          return saved ? { ok: true, data: saved } : { ok: false, error: 'Supply not found.' }
        }
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
    }
  )

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

  /**
   * Link a supply row to the job it does when a show is costed — or clear it.
   *
   * A write, so it needs inventory.manage: deciding which product IS the team
   * bags moves money once the P&L reads it.
   */
  ipcMain.handle(
    IPC.supplySetShipRole,
    (_e, payload: { id: string; role: string | null }): Result<Supply> => {
      try {
        requireManage()
        if (!payload?.id) return { ok: false, error: 'No supply specified.' }
        const role = payload.role ?? null
        if (role !== null && !SHIP_SUPPLY_ROLES.includes(role as never)) {
          return { ok: false, error: 'That is not a supply role.' }
        }
        const supply = setSupplyShipRole(payload.id, role)
        return supply ? { ok: true, data: supply } : { ok: false, error: 'Supply not found.' }
      } catch (err) {
        return fail(err)
      }
    }
  )

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

  // ---- Supply orders (Ordered → In-transit → Delivered) -------------------
  ipcMain.handle(IPC.supplyOrdersList, (): SupplyOrder[] =>
    can('module.inventory') ? listSupplyOrders() : []
  )

  ipcMain.handle(IPC.supplyOrderCreate, (_e, input: NewSupplyOrder): Result<SupplyOrder> => {
    try {
      const actor = requireManage()
      if (!input?.supplyId) return { ok: false, error: 'Choose a supply.' }
      if (!Number.isFinite(input.units) || input.units <= 0) {
        return { ok: false, error: 'Enter at least 1 unit.' }
      }
      if (!Number.isFinite(input.itemsPerUnit) || input.itemsPerUnit < 1) {
        return { ok: false, error: 'Items per unit must be at least 1.' }
      }
      if (!Number.isFinite(input.total) || input.total < 0) {
        return { ok: false, error: 'Enter the order total.' }
      }
      const res = createSupplyOrder(input, actor.id)
      return res.error ? { ok: false, error: res.error } : { ok: true, data: res.order as SupplyOrder }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    IPC.supplyOrderSetStatus,
    (_e, payload: { id: string; status: SupplyOrderStatus }): Result<SupplyOrder> => {
      try {
        const actor = requireManage()
        if (!payload?.id) return { ok: false, error: 'No order specified.' }
        const valid: SupplyOrderStatus[] = ['ordered', 'in_transit', 'delivered', 'cancelled']
        if (!valid.includes(payload.status)) return { ok: false, error: 'Invalid status.' }
        const res = setSupplyOrderStatus(payload.id, payload.status, actor.id)
        return res.error ? { ok: false, error: res.error } : { ok: true, data: res.order as SupplyOrder }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.supplyOrderDelete, (_e, payload: { id: string }): Result => {
    try {
      requireManage()
      if (!payload?.id) return { ok: false, error: 'No order specified.' }
      return deleteSupplyOrder(payload.id) ? { ok: true } : { ok: false, error: 'Order not found.' }
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
  if (input.highBid != null && (!Number.isFinite(input.highBid) || input.highBid < 0)) {
    return 'High bid must be 0 or more.'
  }
  // Whole numbers only — these are divisors. A blank (null) is legitimate and
  // means "unknown"; @shared/units then refuses the conversion by name instead
  // of dividing by a guess, which is the behaviour the owner asked for.
  for (const [label, value] of [
    ['Boxes per case', input.boxesPerCase],
    ['Packs per box', input.packsPerBox]
  ] as const) {
    if (value != null && (!Number.isInteger(value) || value < 0)) return `${label} must be 0 or more.`
  }
  return null
}
