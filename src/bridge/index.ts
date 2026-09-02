/**
 * The one definition of the app's client-side API surface.
 *
 * Every screen calls this object; nothing in the renderer knows how a call
 * reaches the backend. That is deliberate, because there are now TWO ways it
 * can:
 *
 *   · Electron — the preload passes Electron's own `ipcRenderer`, and each
 *     method is an IPC invoke, exactly as before.
 *   · A browser — `renderer/src/lib/httpTransport.ts` passes an object with the
 *     same three methods that POSTs to the server instead.
 *
 * It lives here rather than in src/preload because a browser has no preload to
 * import, and copying ~300 method definitions into a second file is the one
 * change guaranteed to drift: the copy that drifts is the one that quietly
 * sends the wrong argument shape to a handler that writes to the ledger.
 *
 * Deliberately imports NOTHING from Electron — only `@shared` types and the
 * channel names. That is the property that lets it be bundled into a browser.
 */
import { IPC, type AppInfo } from '@shared/ipc'
import type { RelayDiagnosis } from '@shared/relayDiagnosis'
import type { Permission } from '@shared/permissions'
import type { OrderResetInput, OrderResetPreview, OrderResetResult } from '@shared/orderReset'
import type { RestoreCheck, RestoreStatus } from '@shared/restore'
import type { RevenueCheck, StatementInput, WhatnotStatement } from '@shared/statementFit'
import type { FreightPatch } from '@shared/freight'
import type { SupplyingOrder } from '@shared/poStock'
import type { BreakBenchDetail, BreakStepState } from '@shared/breakSteps'
import type { ShippingPerformanceView } from '@shared/performance'
/** Mirrors SweepResult in main; named here so the bridge stays off the main side. */
interface TrackingSweep {
  checked: number
  updated: number
  failed: number
  error: string | null
}
import type { NewReminder, OwnerBoard, Reminder, Todo } from '@shared/ownerDashboard'
import type { StaffBoard } from '@shared/staffBoard'
import type {
  Availability,
  AvailabilityPattern,
  EffectiveAvailabilityWithPerson,
  NewAvailability,
  NewShift,
  PatternDayInput,
  Shift,
  ShiftWithPerson,
  TeamScheduleOverview
} from '@shared/schedule'
import type { RecurringTask } from '@shared/homeTasks'
import type {
  Invoice,
  InvoiceAddress,
  InvoiceCustomer,
  InvoiceDetail,
  InvoiceMatchScan,
  InvoicePaymentInput,
  InvoicePushResult,
  InvoiceStatus,
  InvoiceTerms,
  NewInvoice,
  QboInvoicePreflight,
  WholesaleSaleRow
} from '@shared/invoices'
import type { InvoiceAllocationInput } from '@shared/invoiceAllocations'
import type {
  LinkablePurchaseOrder,
  NewOrderShipment,
  OrderDocument,
  OrderEvent,
  OrderShipment,
  OrderSide
} from '@shared/orders'
import type { EmailSettings, RedactedEmailSettings } from '@shared/emailSettings'
import type { InvoiceDelivery } from '@shared/invoiceDelivery'
import type { Consignment, NewConsignment } from '@shared/consignment'
import type { StockMoveRequest } from '@shared/stockMove'
import type { ContactImportResult } from '@shared/contacts'
import type { ClockPushState, PushSubscriptionInput } from '@shared/webPush'
import type { OrderParty, SupplierSuggestion, VendorSummary } from '@shared/purchaseOrders'
import type { NewPurchaseOrderLine, PoRoutingPatch } from '@shared/types'
import type { BackupPreview } from '@shared/backup'
import type {
  ShipPickAdvanced,
  ShipStationBoard,
  ShipStationOrder,
  ShipStationRole
} from '@shared/shipStations'
import type { ShipSupplyPlan, ShipSupplyPlanCosted } from '@shared/shippingSupplies'
import type {
  ParsedSheet,
  ResetApplyResult,
  ResetField,
  ResetPlan,
  ResetRunSummary
} from '@shared/inventoryReset'
import type {
  QboAccount,
  QboAccountMap,
  QboEnvironment,
  QboStatus,
  QboSyncRow
} from '@shared/quickbooks'
import type {
  IntakeLink,
  IntakeLinkInput,
  IntakeStatus,
  IntakeSubmission,
  StockDrift,
  SyncConfig,
  SyncReject,
  SyncStatus
} from '@shared/sync'
import type {
  AddStockInput,
  AdjustStockInput,
  AuthResult,
  CategorySummary,
  ClockStatus,
  CogsEntry,
  CostBasisFix,
  ComposedEmail,
  Employee,
  EmployeeHoursSummary,
  EmployeeInvite,
  ExportRequest,
  ExportResult,
  IncomingShipment,
  InventoryProduct,
  InventoryStats,
  InventoryTransaction,
  LotPickerData,
  NewEmployeeInput,
  NewIncomingShipment,
  NewInventoryProduct,
  NewPurchaseOrder,
  NewSupply,
  NewSupplyOrder,
  NewTimeEntryInput,
  PricingRow,
  ProductImage,
  ProductLot,
  PurchaseOrder,
  PurchaseOrderDetail,
  PurchaseOrderStatus,
  RecordSaleInput,
  RememberedCredentials,
  Result,
  SalesPoint,
  ScanCommitInput,
  ScanCommitResult,
  ScanDirection,
  ScanMode,
  ScanRecord,
  ScanResolution,
  SessionUser,
  Supply,
  SupplyOrder,
  SupplyOrderStatus,
  SupplyPurchaseInput,
  SupplyStats,
  SupplyUseInput,
  TimeEntry,
  UpdateEmployeeInput,
  UpdateInventoryProduct,
  UpdateSupply,
  UpdateStatus,
  UploadedFile
} from '@shared/types'
import type { StockProvenance } from '@shared/provenance'
import type {
  ProductAvailability,
  ShopBuy,
  ShopSale,
  ShopShelfRow,
  StockAtLocationRow
} from '@shared/availability'
import type {
  ShipBatchUrl,
  ShipBreakAudit,
  ShipBreakStatus,
  ShipDocument,
  ShipEvent,
  ShipImportRecord,
  ShipSnapshot,
  ShipSnapshotSummary,
  ShipSport,
  ShipStatusCode,
  ShipWarning
} from '@shared/shippingTypes'
import type {
  ShipAssignmentBoard,
  ShipBreakAssignee,
  ShipBreakAssignmentUpdate,
  ShipBreakDetail,
  ShipBreakSummary,
  ShipBulkStatusEntry,
  ShipBulkStatusResult,
  ShipCalendarDayDetail,
  ShipCalendarMonth,
  ShipCustomerRow,
  ShipExportKind,
  ShipFinishResult,
  ShipFulfillmentStage,
  ShipImportDeletePlan,
  ShipImportDeleteResult,
  ShipLedgerRow,
  ShipOrderRow,
  ShipParseJob,
  ShipParseRequest,
  ShipParseStart,
  ShipQueueDirection,
  ShipSalesSummary,
  ShipShipmentRow,
  ShipSlotUpdate,
  ShipWorkspaceSummary
} from '@shared/shippingViews'
import type {
  NewStreamItem,
  NewStreamSession,
  SetStreamItemCost,
  StreamCalendarMonth,
  StreamSession,
  StreamSessionDetail,
  UpdateStreamSession
} from '@shared/streaming'
import type { NewScheduledStream, ScheduledStream } from '@shared/streamReminders'
import type {
  GeneralExpense,
  GeneralExpenseInput,
  GeneralExpenseResult,
  ImportDeleteImpact,
  LedgerImport,
  LedgerImportResult,
  LedgerRow,
  RatePeriodInput,
  StreamingFinanceView,
  WhatnotRatePeriod
} from '@shared/financeStreaming'
import type {
  Contact,
  NewThreadInput,
  SendResult,
  ThreadDetail,
  ThreadSummary
} from '@shared/messages'
import type {
  HistorySource,
  OrderHistoryYears,
  PurchaseOrderHistoryRow,
  SalesOrderHistoryRow
} from '@shared/orderHistory'
import type { DealTicketRow } from '@shared/dealTickets'
import type { DeletedOrder } from '@shared/orders'
import type { NumberSeries, SeriesState } from '@shared/numbering'
import type { StockLocation } from '@shared/inventory'
import type { PnlDetail, PnlDrillRequest } from '@shared/pnlDrill'
import type { BreakPnlSplit } from '@shared/breakPnl'

/**
 * What a transport has to provide. Electron's `ipcRenderer` satisfies this
 * structurally, which is why the parameter below keeps its name — the ~300
 * call sites read identically on both transports.
 */
export interface BridgeTransport {
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  invoke(channel: string, ...args: any[]): Promise<any>
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  on(channel: string, listener: (event: any, ...args: any[]) => void): unknown
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  removeListener(channel: string, listener: (event: any, ...args: any[]) => void): unknown
  /**
   * Ask the USER for a file, when the backend cannot ask for itself.
   *
   * Six operations begin by choosing a file. On the desktop the main process
   * opens a native dialog, which is why those six take no argument. A server has
   * no screen to put a dialog on and no business reading its own disk on a
   * caller's say-so, so in a browser the picking happens HERE and the file's
   * content travels with the call.
   *
   * Absent on the Electron transport — `ipcRenderer` has no such method — which
   * is exactly how each method below decides which path it is on. One optional
   * function, six `if`s, and no screen changed.
   *
   * Resolves to null when the person cancelled.
   */
  pickFile?(options: {
    /** An `accept` attribute: '.csv,.tsv,.txt', '.pdf', 'image/*'. */
    accept: string
    /** Text for sheets, bytes for PDFs and images. */
    as: 'text' | 'bytes'
  }): Promise<UploadedFile | null>
  /**
   * The same picker, reading every file chosen. Only the packing-slip upload
   * needs it — a night can be several slips — and it is optional for the same
   * reason `pickFile` is: Electron has neither, and its absence is how each
   * method decides which transport it is on.
   */
  pickFiles?(options: {
    accept: string
    as: 'text' | 'bytes'
    multiple?: boolean
  }): Promise<UploadedFile[]>
  /**
   * Choose a backup and stream it to the server, bypassing the JSON body.
   *
   * Browser-only, and optional for the same reason the pickers are: Electron
   * does not have it, and its absence is how `restore.stage` knows to open a
   * native dialog instead. A database is far too large to travel as base64
   * inside an ordinary request — see the /api/restore route.
   */
  uploadRestore?(): Promise<Result<RestoreCheck>>
}

export function createBridge(ipcRenderer: BridgeTransport) {
  const api = {
    app: {
      info: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.appInfo)
    },
    auth: {
      setupState: (): Promise<{ needsSetup: boolean }> => ipcRenderer.invoke(IPC.authSetupState),
      createOwner: (input: {
        firstName: string
        lastName: string
        companyId: string
        email: string
        title: string
        password: string
      }): Promise<AuthResult> => ipcRenderer.invoke(IPC.authCreateOwner, input),
      login: (identifier: string, password: string): Promise<AuthResult> =>
        ipcRenderer.invoke(IPC.authLogin, { identifier, password }),
      logout: (): Promise<Result> => ipcRenderer.invoke(IPC.authLogout),
      current: (): Promise<SessionUser | null> => ipcRenderer.invoke(IPC.authCurrent),
      changePassword: (currentPassword: string, newPassword: string): Promise<Result> =>
        ipcRenderer.invoke(IPC.authChangePassword, { currentPassword, newPassword })
    },
    employees: {
      list: (): Promise<Employee[]> => ipcRenderer.invoke(IPC.employeesList),
      create: (input: NewEmployeeInput): Promise<Result<EmployeeInvite>> =>
        ipcRenderer.invoke(IPC.employeesCreate, input),
      update: (input: UpdateEmployeeInput): Promise<Result<Employee>> =>
        ipcRenderer.invoke(IPC.employeesUpdate, input),
      resetPassword: (id: string): Promise<Result<EmployeeInvite>> =>
        ipcRenderer.invoke(IPC.employeesResetPassword, { id }),
      setPermissions: (id: string, permissions: Permission[]): Promise<Result<Employee>> =>
        ipcRenderer.invoke(IPC.employeesSetPermissions, { id, permissions }),
      setPortalPin: (id: string, pin: string): Promise<Result<Employee>> =>
        ipcRenderer.invoke(IPC.employeesSetPortalPin, { id, pin }),
      clearPortalPin: (id: string): Promise<Result<Employee>> =>
        ipcRenderer.invoke(IPC.employeesClearPortalPin, { id }),
      /** Desktop: main opens the picker. Browser: the picture goes up with the call. */
      setAvatar: async (id: string): Promise<Result<Employee>> => {
        if (!ipcRenderer.pickFile) return ipcRenderer.invoke(IPC.employeesSetAvatar, id)
        const upload = await ipcRenderer.pickFile({ accept: 'image/*', as: 'bytes' })
        if (!upload) return { ok: false, error: 'No image selected.' }
        return ipcRenderer.invoke(IPC.employeesSetAvatar, id, upload)
      },
      removeAvatar: (id: string): Promise<Result<Employee>> =>
        ipcRenderer.invoke(IPC.employeesRemoveAvatar, id)
    },
    hours: {
      /**
       * Hours per employee, optionally bounded to a period.
       *
       * The bound is not decoration: the Team tab's period picker and its
       * "Export team to Gusto" button have to describe the same window, and for
       * a long time they did not — the table showed all-time totals while the
       * export honoured the picker.
       */
      summary: (range?: { start: string; end: string }): Promise<EmployeeHoursSummary[]> =>
        ipcRenderer.invoke(IPC.hoursSummary, range),
      list: (employeeId?: string): Promise<TimeEntry[]> =>
        ipcRenderer.invoke(IPC.hoursList, employeeId),
      create: (input: NewTimeEntryInput): Promise<Result<TimeEntry>> =>
        ipcRenderer.invoke(IPC.hoursCreate, input),
      delete: (id: string): Promise<Result> => ipcRenderer.invoke(IPC.hoursDelete, { id }),
      timesheet: (employeeId: string, start: string, end: string): Promise<TimeEntry[]> =>
        ipcRenderer.invoke(IPC.hoursTimesheet, { employeeId, start, end }),
      export: (req: ExportRequest): Promise<ExportResult> => ipcRenderer.invoke(IPC.hoursExport, req)
    },
    /**
     * A copy of the database the owner can keep.
     *
     * OWNER ONLY, enforced in the handler rather than here — the file carries
     * the QuickBooks token and the payment instructions, so it is credential
     * material. `preview` answers null to anybody else, which is what makes the
     * panel render an empty state instead of throwing a banner.
     *
     * `download` needs no transport branch: it is the save-dialog shape every
     * other exporter uses, which the server turns into a download token on its
     * own. See src/main/backupIpc.ts.
     */
    backup: {
      preview: (): Promise<BackupPreview | null> => ipcRenderer.invoke(IPC.backupPreview),
      download: (): Promise<ExportResult> => ipcRenderer.invoke(IPC.backupDownload)
    },
    /**
     * Putting a backup back.
     *
     * `stage` is the one method here with a transport branch, and it is the same
     * branch `pickFile` uses: the ABSENCE of a browser-only capability is how a
     * method knows it is on the desktop. Electron opens a native dialog inside
     * the handler and reads the path directly. A browser has no path to give, so
     * `uploadRestore` streams the bytes to the server — deliberately not through
     * `invoke`, because every ordinary call is JSON and a database base64'd into
     * a JSON body would hit the request cap at around 35 MB.
     *
     * The other three are ordinary calls on both transports. Only the delivery
     * of the file differs; the judging and the swapping are identical.
     */
    restore: {
      stage: (): Promise<Result<RestoreCheck>> =>
        ipcRenderer.uploadRestore
          ? ipcRenderer.uploadRestore()
          : ipcRenderer.invoke(IPC.restoreStage),
      status: (): Promise<RestoreStatus | null> => ipcRenderer.invoke(IPC.restoreStatus),
      confirm: (input: { stageId: string; typed: string }): Promise<Result<{ filename: string }>> =>
        ipcRenderer.invoke(IPC.restoreConfirm, input),
      cancel: (): Promise<Result<true>> => ipcRenderer.invoke(IPC.restoreCancel)
    },
    clock: {
      status: (): Promise<ClockStatus> => ipcRenderer.invoke(IPC.clockStatus),
      in: (): Promise<Result<ClockStatus>> => ipcRenderer.invoke(IPC.clockIn),
      out: (): Promise<Result<ClockStatus>> => ipcRenderer.invoke(IPC.clockOut)
    },
    credentials: {
      get: (): Promise<RememberedCredentials | null> => ipcRenderer.invoke(IPC.credGet),
      set: (creds: RememberedCredentials): Promise<Result> => ipcRenderer.invoke(IPC.credSet, creds),
      clear: (): Promise<Result> => ipcRenderer.invoke(IPC.credClear)
    },
    inventory: {
      /** Everywhere stock can sit, retired included. */
      locations: (): Promise<StockLocation[]> => ipcRenderer.invoke(IPC.invLocationsList),
      /** Add a place, or rename one — a rename moves its stock with it. */
      saveLocation: (input: {
        id?: string | null
        label: string
        pinned?: boolean
      }): Promise<Result<StockLocation[]>> => ipcRenderer.invoke(IPC.invLocationSave, input),
      /** Stop offering a place. It keeps holding the stock it already holds. */
      retireLocation: (id: string, retired: boolean): Promise<Result<StockLocation[]>> =>
        ipcRenderer.invoke(IPC.invLocationRetire, { id, retired }),
      /** Keep a place near the top of every picker. */
      pinLocation: (id: string, pinned: boolean): Promise<Result<StockLocation[]>> =>
        ipcRenderer.invoke(IPC.invLocationPin, { id, pinned }),
      list: (): Promise<InventoryProduct[]> => ipcRenderer.invoke(IPC.invProductsList),
      search: (query: string): Promise<InventoryProduct[]> =>
        ipcRenderer.invoke(IPC.invCatalogSearch, query),
      stats: (): Promise<InventoryStats | null> => ipcRenderer.invoke(IPC.invStats),
      categories: (): Promise<CategorySummary[]> => ipcRenderer.invoke(IPC.invCategories),
      byCategory: (category: string): Promise<InventoryProduct[]> =>
        ipcRenderer.invoke(IPC.invByCategory, category),
      recentSales: (limit?: number): Promise<InventoryTransaction[]> =>
        ipcRenderer.invoke(IPC.invRecentSales, limit),
      transactions: (limit?: number): Promise<InventoryTransaction[]> =>
        ipcRenderer.invoke(IPC.invTransactions, limit),
      salesSeries: (days?: number): Promise<SalesPoint[]> =>
        ipcRenderer.invoke(IPC.invSalesSeries, days),
      create: (input: NewInventoryProduct): Promise<Result<InventoryProduct>> =>
        ipcRenderer.invoke(IPC.invProductCreate, input),
      update: (input: UpdateInventoryProduct): Promise<Result<InventoryProduct>> =>
        ipcRenderer.invoke(IPC.invProductUpdate, input),
      delete: (id: string): Promise<Result> => ipcRenderer.invoke(IPC.invProductDelete, { id }),
      addStock: (input: AddStockInput): Promise<Result<InventoryProduct>> =>
        ipcRenderer.invoke(IPC.invStockAdd, input),
      adjustStock: (input: AdjustStockInput): Promise<Result<InventoryProduct>> =>
        ipcRenderer.invoke(IPC.invStockAdjust, input),
      /**
       * Carry units to another shelf WITHOUT touching what they are worth — the
       * layer travels with them. See @shared/stockMove for why two adjustments
       * are not the same thing.
       */
      moveStock: (input: StockMoveRequest): Promise<Result<InventoryProduct>> =>
        ipcRenderer.invoke(IPC.invStockMove, input),
      /**
       * Stock we own and no longer have. Sending CONSUMES the cost lots, which
       * is what makes consigned units unsellable and unbreakable — see
       * @shared/consignment.
       */
      sendOnConsignment: (input: NewConsignment): Promise<Result<Consignment>> =>
        ipcRenderer.invoke(IPC.invConsignSend, input),
      settleConsignment: (
        id: string,
        outcome: 'returned' | 'sold'
      ): Promise<Result<Consignment>> =>
        ipcRenderer.invoke(IPC.invConsignSettle, { id, outcome }),
      consignmentsFor: (productId: string): Promise<Consignment[]> =>
        ipcRenderer.invoke(IPC.invConsignForProduct, productId),
      openConsignments: (): Promise<Consignment[]> =>
        ipcRenderer.invoke(IPC.invConsignOpen),
      recordSale: (input: RecordSaleInput): Promise<Result<InventoryProduct>> =>
        ipcRenderer.invoke(IPC.invSaleRecord, input),
      thumbnails: (): Promise<Record<string, string>> => ipcRenderer.invoke(IPC.invThumbnails),
      listImages: (productId: string): Promise<ProductImage[]> =>
        ipcRenderer.invoke(IPC.invImageList, productId),
      addImage: async (productId: string): Promise<Result<ProductImage[]>> => {
        if (!ipcRenderer.pickFile) return ipcRenderer.invoke(IPC.invImageAdd, productId)
        const upload = await ipcRenderer.pickFile({ accept: 'image/*', as: 'bytes' })
        if (!upload) return { ok: false, error: 'No image selected.' }
        return ipcRenderer.invoke(IPC.invImageAdd, productId, upload)
      },
      removeImage: (imageId: string): Promise<Result<ProductImage[]>> =>
        ipcRenderer.invoke(IPC.invImageRemove, imageId),
      listIncoming: (): Promise<IncomingShipment[]> => ipcRenderer.invoke(IPC.invIncomingList),
      addIncoming: (input: NewIncomingShipment): Promise<Result<IncomingShipment>> =>
        ipcRenderer.invoke(IPC.invIncomingAdd, input),
      receiveIncoming: (id: string): Promise<Result> =>
        ipcRenderer.invoke(IPC.invIncomingReceive, { id }),
      cancelIncoming: (id: string): Promise<Result> =>
        ipcRenderer.invoke(IPC.invIncomingCancel, { id }),
      pricingList: (): Promise<PricingRow[]> => ipcRenderer.invoke(IPC.invPricingList),
      updateHighBid: (productId: string, highBid: number | null): Promise<Result<InventoryProduct>> =>
        ipcRenderer.invoke(IPC.invHighBidUpdate, { productId, highBid }),
      // Not `update({ unitCost })`: this also re-bases the cost layers that are
      // carrying nothing, because the valuation reads layers first and the average
      // alone would leave the zero-cost banner exactly where it was.
      fixCostBasis: (productId: string, unitCost: number): Promise<Result<CostBasisFix>> =>
        ipcRenderer.invoke(IPC.invCostBasisFix, { productId, unitCost }),
      productLots: (productId: string): Promise<ProductLot[]> =>
        ipcRenderer.invoke(IPC.invProductLots, productId),
      /**
       * WHERE THESE CASES CAME FROM, and which purchase orders are still
       * bringing more. One read for both halves: the panel opens on a click and
       * two round trips over the web transport is a visible pause.
       */
      productProvenance: (productId: string): Promise<StockProvenance | null> =>
        ipcRenderer.invoke(IPC.invProductProvenance, productId),
      /**
       * Where a product is, place by place — our shelves and the roadshow shops.
       *
       * Drawn on a sales-order line as the quantity is typed, so somebody asking
       * for seven can see the four here and the three at the shop. See
       * @shared/availability.
       */
      productAvailability: (productId: string): Promise<ProductAvailability> =>
        ipcRenderer.invoke(IPC.invProductAvailability, productId),
      /** Everything standing at one place. See stockAtLocation. */
      stockAtLocation: (location: string): Promise<StockAtLocationRow[]> =>
        ipcRenderer.invoke(IPC.invStockAtLocation, location),
      /** Everything a shop has handed over, and what became of it. */
      shopShelf: (location: string): Promise<ShopShelfRow[]> =>
        ipcRenderer.invoke(IPC.invShopShelf, location),
      /** Which sales took this product off this shop's shelf. */
      shopSales: (location: string, productId: string): Promise<ShopSale[]> =>
        ipcRenderer.invoke(IPC.invShopSales, { location, productId }),
      /** The dates and order numbers behind one product at one shop. */
      shopBuys: (location: string, productId: string): Promise<ShopBuy[]> =>
        ipcRenderer.invoke(IPC.invShopBuys, { location, productId }),
      // What the cost-lot picker draws itself from. A pure READ: the operator's
      // answer is carried on the write that follows (adjustStock / recordSale /
      // streaming.addItem), so closing the dialog leaves nothing behind to undo.
      lotOptions: (productId: string, location: string): Promise<LotPickerData | null> =>
        ipcRenderer.invoke(IPC.invLotOptions, { productId, location }),
      // UPC scanning. resolve is read-only and safe to call repeatedly (the camera
      // decoder fires many times a second); commit performs the one confirmed
      // action. The raw code is sent un-trimmed — the backend does the cleaning so
      // wedge, camera and a future phone client cannot drift apart.
      //
      // `direction` says which way the session moves stock; 'out' resolves the
      // barcode with purchase orders and cost basis out of the picture. Repeat
      // scans of one code are merged by the renderer into a single commit carrying
      // the accumulated quantity, so no extra channel exists (or is needed).
      scanResolve: (rawCode: string, direction: ScanDirection = 'in'): Promise<ScanResolution | null> =>
        ipcRenderer.invoke(IPC.invScanResolve, rawCode, direction),
      scanCommit: (input: ScanCommitInput): Promise<Result<ScanCommitResult>> =>
        ipcRenderer.invoke(IPC.invScanCommit, input),
      scanLogMiss: (rawCode: string, mode: ScanMode): Promise<Result<ScanRecord | null>> =>
        ipcRenderer.invoke(IPC.invScanLogMiss, { rawCode, mode }),
      scanHistory: (limit?: number): Promise<ScanRecord[]> =>
        ipcRenderer.invoke(IPC.invScanHistory, limit),
      scanUndo: (id: string): Promise<Result<ScanRecord>> => ipcRenderer.invoke(IPC.invScanUndo, { id }),

      // Mass re-adjustment from a count sheet. The renderer holds the sheet TEXT
      // and sends it with every preview; main holds no draft state, so a reload
      // mid-review loses nothing but the paste itself and there is no half-built
      // import sitting in the database waiting to be finished.
      resetPreview: (input: {
        text: string
        mapping: ResetField[] | null
        defaultLocation?: string
      }): Promise<{ sheet: ParsedSheet; plan: ResetPlan; guessed: boolean } | null> =>
        ipcRenderer.invoke(IPC.invResetPreview, input),
      resetPickFile: async (): Promise<Result<{ text: string; filename: string }>> => {
        if (!ipcRenderer.pickFile) return ipcRenderer.invoke(IPC.invResetPickFile)
        const upload = await ipcRenderer.pickFile({ accept: '.csv,.tsv,.txt', as: 'text' })
        if (!upload) return { ok: false, error: 'No file selected.' }
        return ipcRenderer.invoke(IPC.invResetPickFile, upload)
      },
      resetApply: (input: {
        text: string
        mapping: ResetField[]
        defaultLocation?: string
        source?: string
      }): Promise<Result<ResetApplyResult>> => ipcRenderer.invoke(IPC.invResetApply, input),
      resetHistory: (limit?: number): Promise<ResetRunSummary[]> =>
        ipcRenderer.invoke(IPC.invResetHistory, limit),
      resetRunDetail: (id: string): Promise<string[]> => ipcRenderer.invoke(IPC.invResetRunDetail, id),
      resetExport: (): Promise<Result<{ path: string }>> => ipcRenderer.invoke(IPC.invResetExport)
    },
    supplies: {
      list: (): Promise<Supply[]> => ipcRenderer.invoke(IPC.suppliesList),
      stats: (): Promise<SupplyStats | null> => ipcRenderer.invoke(IPC.suppliesStats),
      create: (input: NewSupply): Promise<Result<Supply>> =>
        ipcRenderer.invoke(IPC.supplyCreate, input),
      update: (input: UpdateSupply): Promise<Result<Supply>> =>
        ipcRenderer.invoke(IPC.supplyUpdate, input),
      delete: (id: string): Promise<Result> => ipcRenderer.invoke(IPC.supplyDelete, { id }),
      purchase: (id: string, input: SupplyPurchaseInput): Promise<Result<Supply>> =>
        ipcRenderer.invoke(IPC.supplyPurchase, { id, ...input }),
      use: (id: string, input: SupplyUseInput): Promise<Result<Supply>> =>
        ipcRenderer.invoke(IPC.supplyUse, { id, ...input }),
      adjust: (id: string, quantityChange: number, note?: string | null): Promise<Result<Supply>> =>
        ipcRenderer.invoke(IPC.supplyAdjust, { id, quantityChange, note: note ?? null }),
      /** Say which consumable this row IS when a show is costed. Null unlinks. */
      setShipRole: (id: string, role: string | null): Promise<Result<Supply>> =>
        ipcRenderer.invoke(IPC.supplySetShipRole, { id, role }),
      setImage: async (id: string): Promise<Result<Supply>> => {
        if (!ipcRenderer.pickFile) return ipcRenderer.invoke(IPC.supplySetImage, { id })
        const upload = await ipcRenderer.pickFile({ accept: 'image/*', as: 'bytes' })
        if (!upload) return { ok: false, error: 'No image selected.' }
        return ipcRenderer.invoke(IPC.supplySetImage, { id, upload })
      },
      removeImage: (id: string): Promise<Result<Supply>> =>
        ipcRenderer.invoke(IPC.supplyRemoveImage, { id }),
      listOrders: (): Promise<SupplyOrder[]> => ipcRenderer.invoke(IPC.supplyOrdersList),
      createOrder: (input: NewSupplyOrder): Promise<Result<SupplyOrder>> =>
        ipcRenderer.invoke(IPC.supplyOrderCreate, input),
      setOrderStatus: (id: string, status: SupplyOrderStatus): Promise<Result<SupplyOrder>> =>
        ipcRenderer.invoke(IPC.supplyOrderSetStatus, { id, status }),
      deleteOrder: (id: string): Promise<Result> =>
        ipcRenderer.invoke(IPC.supplyOrderDelete, { id })
    },
    quickbooks: {
      status: (): Promise<QboStatus | null> => ipcRenderer.invoke(IPC.qboStatus),
      saveConfig: (
        clientId: string,
        clientSecret: string,
        environment: QboEnvironment,
        redirectUri?: string
      ): Promise<Result<QboStatus>> =>
        ipcRenderer.invoke(IPC.qboSaveConfig, { clientId, clientSecret, environment, redirectUri }),
      /** Finish consent from a code pasted out of the browser's address bar. */
      exchangeCode: (code: string, realmId: string): Promise<Result<QboStatus>> =>
        ipcRenderer.invoke(IPC.qboExchangeCode, { code, realmId }),
      connect: (): Promise<Result<QboStatus>> => ipcRenderer.invoke(IPC.qboConnect),
      disconnect: (): Promise<Result<QboStatus>> => ipcRenderer.invoke(IPC.qboDisconnect),
      forget: (): Promise<Result<QboStatus>> => ipcRenderer.invoke(IPC.qboForget),
      /** The owner's one-time move of an existing local connection to the relay. */
      promote: (): Promise<
        Result<{ status: QboStatus; companyName: string; localCleared: boolean }>
      > => ipcRenderer.invoke(IPC.qboPromote),
      test: (): Promise<Result<{ companyName: string; realmId: string }>> =>
        ipcRenderer.invoke(IPC.qboTest),
      /** Time each hop and name the one that failed. See @shared/relayDiagnosis. */
      diagnoseRelay: (): Promise<Result<RelayDiagnosis>> =>
        ipcRenderer.invoke(IPC.qboDiagnoseRelay),
      authorizeUrl: (): Promise<Result<{ url: string; redirectUri: string }>> =>
        ipcRenderer.invoke(IPC.qboAuthorizeUrl),
      pasteTokens: (
        accessToken: string,
        refreshToken: string,
        realmId: string
      ): Promise<Result<QboStatus>> =>
        ipcRenderer.invoke(IPC.qboPasteTokens, { accessToken, refreshToken, realmId }),
      accounts: (): Promise<Result<{ accounts: QboAccount[]; suggested: QboAccountMap }>> =>
        ipcRenderer.invoke(IPC.qboAccounts),
      getMapping: (): Promise<Result<{ realmId: string; map: QboAccountMap }>> =>
        ipcRenderer.invoke(IPC.qboMappingGet),
      saveMapping: (map: QboAccountMap): Promise<Result<{ map: QboAccountMap }>> =>
        ipcRenderer.invoke(IPC.qboMappingSave, { map }),
      syncLog: (): Promise<Result<QboSyncRow[]>> => ipcRenderer.invoke(IPC.qboSyncLog)
    },

    /**
     * Employee performance. `null` means the account may not see it — the same
     * shape the QuickBooks status uses, and for the same reason: a report about
     * named people should not announce its own existence with an error.
     *
     * The range is two LOCAL day keys, inclusive. Main converts them to a UTC
     * window; nothing in the renderer does that arithmetic, because a wall
     * clock and an instant are different things and there should be exactly one
     * place in the app that turns one into the other.
     */
    performance: {
      shipping: (from: string, to: string): Promise<ShippingPerformanceView | null> =>
        ipcRenderer.invoke(IPC.perfShipping, { from, to })
    },

    purchaseOrders: {
      list: (): Promise<PurchaseOrder[]> => ipcRenderer.invoke(IPC.poList),
      get: (id: string): Promise<PurchaseOrderDetail | null> =>
        ipcRenderer.invoke(IPC.poGet, id),
      create: (input: NewPurchaseOrder): Promise<Result<PurchaseOrderDetail>> =>
        ipcRenderer.invoke(IPC.poCreate, input),
      setStatus: (id: string, status: PurchaseOrderStatus): Promise<Result<PurchaseOrderDetail>> =>
        ipcRenderer.invoke(IPC.poSetStatus, { id, status }),
      /**
       * Mark an order paid, or take the mark back off. Does NOT move it.
       *
       * Payment is a date on the order, not a place in the pipeline: goods
       * regularly arrive before the invoice is settled, and an order that has
       * been received and then paid has not gone backwards. Reversible, because
       * a payment recorded against the wrong order has to come off without
       * cancelling the order and handing back stock that is really on the shelf.
       */
      setPaid: (id: string, paid: boolean): Promise<Result<PurchaseOrderDetail>> =>
        ipcRenderer.invoke(IPC.poSetPaid, { id, paid }),
      /**
       * Add products to an order that already exists.
       *
       * Refused on a cancelled order (its cost is out of the ledger) and on a
       * received one (closed, so the line could never be checked in). The
       * header total and the COGS row move with it.
       */
      addLines: (id: string, lines: NewPurchaseOrderLine[]): Promise<Result<PurchaseOrderDetail>> =>
        ipcRenderer.invoke(IPC.poAddLines, { id, lines }),
      /**
       * Correct the header: who the order is from, its note, and the freight
       * the supplier charged.
       *
       * No status gate — the supplier and the note touch nothing with money
       * attached, and the commonest moment to notice the supplier is missing is
       * while filing an order that is already closed. Lines that never named
       * their own supplier follow the header automatically, because they store
       * the inheritance rather than a copy.
       *
       * SHIPPING COST does move money: it restates the order total and the COGS
       * row behind it. It is still ungated, because the carrier's invoice
       * usually arrives after the boxes and freight never enters a FIFO cost
       * lot — so a late correction cannot leave the document and the shelf
       * disagreeing, which is the risk that freezes a line price.
       *
       * Omit a field to leave it alone; an explicit null clears it.
       */
      setHeader: (
        id: string,
        patch: { supplier?: string | null; notes?: string | null; shippingCost?: number | null }
      ): Promise<Result<PurchaseOrderDetail>> =>
        ipcRenderer.invoke(IPC.poSetHeader, { id, ...patch }),
      /**
       * Change what a line says. Quantity may not fall below what has already
       * been checked in, and the unit price is frozen once ANY unit has been —
       * the stock on the shelf is costed against a lot carrying the old price,
       * and moving one without the other would leave the two disagreeing.
       */
      updateLine: (
        id: string,
        lineId: string,
        patch: { quantity?: number; unitPrice?: number }
      ): Promise<Result<PurchaseOrderDetail>> =>
        ipcRenderer.invoke(IPC.poUpdateLine, { id, lineId, ...patch }),
      /** Take a line off. Refused once anything on it has landed, and on the last one. */
      removeLine: (id: string, lineId: string): Promise<Result<PurchaseOrderDetail>> =>
        ipcRenderer.invoke(IPC.poRemoveLine, { id, lineId }),
      /** Undo something added at a shop — see removeTabLine. */
      removeTabLine: (id: string, lineId: string): Promise<Result<PurchaseOrderDetail>> =>
        ipcRenderer.invoke(IPC.poRemoveTabLine, { id, lineId }),
      /** Shipping + payment details. Omitted keys are left as they are. */
      setFreight: (id: string, patch: FreightPatch): Promise<Result<PurchaseOrderDetail>> =>
        ipcRenderer.invoke(IPC.poSetFreight, { id, ...patch }),
      /**
       * Which open roadshow orders still have this product on a given shelf.
       *
       * Drawn on a sales order line so the operator can sell THAT order's cases.
       * Empty on almost every product, which is what keeps the chooser off
       * almost every line — see @shared/poStock.
       */
      supplyingOrders: (productId: string, location?: string | null): Promise<SupplyingOrder[]> =>
        ipcRenderer.invoke(IPC.poSupplyingOrders, { productId, location: location ?? null }),
      /** The sales that took units out of this order's stock, oldest first. */
      stockSales: (poId: string): Promise<InvoiceDetail[]> =>
        ipcRenderer.invoke(IPC.poStockSales, poId),
      /**
       * Every ongoing order still running, oldest first.
       *
       * Read by the create form so it can warn when the supplier being typed
       * already has one open — a second week's buying landing on a second
       * document is how a shop expecting one payment ends up owed two.
       */
      openTabs: (): Promise<PurchaseOrder[]> => ipcRenderer.invoke(IPC.poOpenTabs),
      /**
       * Say what a line cost, or that nobody knows yet.
       *
       * `unitPrice: null` is the second of those and is a REAL ANSWER, not a
       * missing argument — it is why this exists beside `updateLine`, which
       * cannot express it. Zero means the shop threw it in free.
       */
      setLinePrice: (
        id: string,
        lineId: string,
        unitPrice: number | null
      ): Promise<Result<PurchaseOrderDetail>> =>
        ipcRenderer.invoke(IPC.poSetLinePrice, { id, lineId, unitPrice }),
      /**
       * Settle the week: close the tab and mark it paid, in one act.
       *
       * Refused while any line still has no price. A total nobody can work out
       * is not a bill anybody can pay, and a tab settled with unpriced cases on
       * it would under-report a week of cost of goods for ever.
       */
      settleTab: (id: string): Promise<Result<PurchaseOrderDetail>> =>
        ipcRenderer.invoke(IPC.poSettleTab, { id }),
      /**
       * Stop buying against the week, without paying it.
       *
       * Allowed with prices still unknown — "we have stopped buying" is a fact
       * about the shop, not about the bill. Closing also settles where every
       * case is going: a closed tab's routing can no longer be changed. See
       * closeRoadshowTab.
       */
      closeTab: (id: string): Promise<Result<PurchaseOrderDetail>> =>
        ipcRenderer.invoke(IPC.poCloseTab, { id }),
      searchCatalog: (query: string): Promise<InventoryProduct[]> =>
        ipcRenderer.invoke(IPC.poCatalogSearch, query),
      /**
       * Names for the supplier box: the contact list, plus every supplier
       * already used on a PO, ordered with the recently used first.
       *
       * A PO's supplier remains free text and picking one only fills the box in.
       * See @shared/purchaseOrders for why suppliers and buyers are not forced
       * into one record.
       */
      suppliers: (): Promise<SupplierSuggestion[]> => ipcRenderer.invoke(IPC.poSuppliers),
      /**
       * Everywhere units can be SENT — the destination picker's whole list.
       *
       * Not `suppliers()` under another name. A dropship destination is very
       * often somebody this business SELLS to, so this merges the vendor and
       * customer directories into one list, case-insensitively, and marks a
       * business that is both as one row rather than two.
       *
       * RM and AM come back first and are the only entries with holdsStock
       * true. Every downstream stock decision reads that flag rather than
       * re-testing the name, so there is one place for the rule to live.
       */
      parties: (): Promise<OrderParty[]> => ipcRenderer.invoke(IPC.poParties),
      /** Pin a party to the top of the picker, or take the pin off. */
      pinParty: (name: string, pinned: boolean): Promise<Result<OrderParty[]>> =>
        ipcRenderer.invoke(IPC.poPartyPin, { name, pinned }),
      /**
       * Re-route an existing order: a line's supplier or destination, or its
       * split across destinations.
       *
       * Refused when the PO is cancelled or any affected line has already been
       * received — see setPurchaseOrderRouting for why moving received units is
       * an Inventory adjustment and not a paperwork edit.
       */
      setRouting: (id: string, patch: PoRoutingPatch): Promise<Result<PurchaseOrderDetail>> =>
        ipcRenderer.invoke(IPC.poSetRouting, { id, patch }),
      /**
       * Who this business buys from — Admin → Vendors.
       *
       * NOT `suppliers()` filtered in the renderer. That call deliberately
       * offers every contact whether or not anything was ever bought from
       * them, so counting its result would put the size of the contact list on
       * a tile labelled Vendors. This one merges what was actually bought —
       * purchase orders and stock receipts — with the contacts explicitly
       * flagged as vendors by the directory import, and says on each row which
       * of the two it came from.
       */
      vendors: (): Promise<VendorSummary[]> => ipcRenderer.invoke(IPC.poVendors),

      /**
       * Load the owner's vendor sheet off their own disk.
       *
       * Read as BYTES for both formats, for the reason the contact import gives:
       * a .xlsx has no choice, and taking the same route for a .csv means the
       * format is worked out once, from the file's first two bytes, rather than
       * differently on each of the two transports.
       *
       * Safe to run twice: vendors are matched on their name and every field
       * merges, so a repeat import of the same sheet writes nothing.
       */
      importVendors: async (): Promise<Result<ContactImportResult>> => {
        if (!ipcRenderer.pickFile) return ipcRenderer.invoke(IPC.poVendorsImport)
        const upload = await ipcRenderer.pickFile({ accept: '.xlsx,.csv,.tsv,.txt', as: 'bytes' })
        if (!upload) return { ok: false, error: 'No file selected.' }
        return ipcRenderer.invoke(IPC.poVendorsImport, upload)
      },
      thumbnails: (): Promise<Record<string, string>> => ipcRenderer.invoke(IPC.poThumbnails),
      incomingBoxes: (): Promise<PurchaseOrderDetail[]> => ipcRenderer.invoke(IPC.poIncomingBoxes),
      scanIn: (id: string): Promise<Result<PurchaseOrderDetail>> =>
        ipcRenderer.invoke(IPC.poScanIn, { id }),
      /**
       * Record a partial delivery — how many of each line turned up today.
       *
       * Lines left at zero are simply absent from `items`; "none of that one
       * came" is an ordinary answer, not something to send a zero for.
       */
      receiveLines: (
        id: string,
        items: Array<{ lineId: string; quantity: number }>
      ): Promise<Result<PurchaseOrderDetail>> =>
        ipcRenderer.invoke(IPC.poReceiveLines, { id, items }),
      cogsList: (): Promise<CogsEntry[]> => ipcRenderer.invoke(IPC.poCogsList),
      remove: (id: string): Promise<Result<null>> => ipcRenderer.invoke(IPC.poDelete, id),
      /** Delete a PO the ordinary path refuses. `removeStock` decides whether its
       *  received units come back out of inventory or stay on the shelf. */
      forceRemove: (
        id: string,
        removeStock: boolean
      ): Promise<Result<{ removedUnits: number; soldUnits: number }>> =>
        ipcRenderer.invoke(IPC.poForceDelete, { id, removeStock }),
      /** Read every active order's carrier page now. Shared by both boards —
       *  one sweep covers purchase orders and invoices together. */
      checkTracking: (): Promise<Result<TrackingSweep>> =>
        ipcRenderer.invoke(IPC.trackingCheckNow),
      canReadTracking: (): Promise<boolean> => ipcRenderer.invoke(IPC.trackingCanRead),
      openPdf: (id: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> =>
        ipcRenderer.invoke(IPC.poOpenPdf, id),
      savePdf: (id: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> =>
        ipcRenderer.invoke(IPC.poSavePdf, id)
    },
    /**
     * RM Cardz Shipping Workspace. Reads resolve to an empty value when the user
     * lacks `module.fulfillment`; every write returns `Result<T>` carrying the
     * freshly derived row so a screen can reconcile without a refetch.
     */
    shipping: {
      // ---- Workspace ---------------------------------------------------------
      summary: (): Promise<ShipWorkspaceSummary | null> => ipcRenderer.invoke(IPC.shipSummary),
      event: (): Promise<ShipEvent | null> => ipcRenderer.invoke(IPC.shipEvent),
      setEvent: (name: string, date: string): Promise<Result<ShipEvent>> =>
        ipcRenderer.invoke(IPC.shipSetEvent, { name, date }),
      warnings: (): Promise<ShipWarning[]> => ipcRenderer.invoke(IPC.shipWarnings),
      setWarningStatus: (
        id: string,
        status: 'open' | 'handled',
        note?: string | null
      ): Promise<Result<ShipWarning>> =>
        ipcRenderer.invoke(IPC.shipWarningStatus, { id, status, note: note ?? null }),
      audit: (): Promise<ShipBreakAudit[]> => ipcRenderer.invoke(IPC.shipAudit),
      customers: (): Promise<ShipCustomerRow[]> => ipcRenderer.invoke(IPC.shipCustomers),
      clearDataset: (): Promise<Result<ShipWorkspaceSummary>> =>
        ipcRenderer.invoke(IPC.shipDatasetClear),

      /**
       * Mark every card in one package picked (or un-picked). `onlyUnchecked`
       * leaves already-ticked cards — and whoever ticked them — alone.
       */
      setOrderChecked: (
        customerId: string,
        checked: boolean,
        onlyUnchecked = false
      ): Promise<Result<ShipOrderRow>> =>
        ipcRenderer.invoke(IPC.shipOrderCheckAll, { customerId, checked, onlyUnchecked }),

      /** What tonight's show will consume in supplies. Read only. */
      supplyPlan: (): Promise<ShipSupplyPlan | null> => ipcRenderer.invoke(IPC.shipSupplyPlan),
      /** The same plan costed against the supplies list. Needs Inventory too. */
      supplyPlanCosted: (): Promise<ShipSupplyPlanCosted | null> =>
        ipcRenderer.invoke(IPC.shipSupplyPlanCosted),

      /**
       * The floor: who is at this bench, and the pick -> pack handoff.
       *
       * `heartbeat` is local and cheap — it keeps this station's claims from
       * expiring while somebody is genuinely working, and touches no network.
       */
      stationBoard: (): Promise<ShipStationBoard | null> =>
        ipcRenderer.invoke(IPC.shipStationBoard),
      stationRoster: (): Promise<Array<{ id: string; name: string }>> =>
        ipcRenderer.invoke(IPC.shipStationRoster),
      stationStart: (operatorId: string, role: ShipStationRole): Promise<Result<ShipStationBoard>> =>
        ipcRenderer.invoke(IPC.shipStationStart, { operatorId, role }),
      stationEnd: (): Promise<Result<ShipStationBoard>> => ipcRenderer.invoke(IPC.shipStationEnd),
      stationClaim: (
        orderId: string,
        customerId: string,
        role: ShipStationRole
      ): Promise<Result<unknown>> =>
        ipcRenderer.invoke(IPC.shipStationClaim, { orderId, customerId, role }),
      stationRelease: (claimId: string): Promise<Result<boolean>> =>
        ipcRenderer.invoke(IPC.shipStationRelease, claimId),
      /** The handoff. Says whether this pick was the one that closed step 5. */
      stationPickAdvance: (customerId: string): Promise<Result<ShipPickAdvanced>> =>
        ipcRenderer.invoke(IPC.shipStationPickAdvance, customerId),
      stationPickNext: (): Promise<Result<ShipStationOrder | null>> =>
        ipcRenderer.invoke(IPC.shipStationPickNext),
      stationPackNext: (): Promise<Result<ShipStationOrder | null>> =>
        ipcRenderer.invoke(IPC.shipStationPackNext),
      stationPackDone: (customerId: string): Promise<Result<unknown>> =>
        ipcRenderer.invoke(IPC.shipStationPackDone, customerId),
      /**
       * Step back one box and open it again — see packBack in db/shipStations.
       *
       * Result-shaped rather than a bare order, because it is the one bench
       * control that refuses: a parcel the carrier already has must not be
       * quietly marked unpacked.
       */
      stationPackBack: (): Promise<Result<unknown>> =>
        ipcRenderer.invoke(IPC.shipStationPackBack),
      stationSendBack: (customerId: string, reason: string): Promise<Result<boolean>> =>
        ipcRenderer.invoke(IPC.shipStationSendBack, { customerId, reason }),
      stationHeartbeat: (): Promise<number> => ipcRenderer.invoke(IPC.shipStationHeartbeat),
      /** Sleeved / top-loaded, per card. Moves no stock — step 1's tick does. */
      setSlotSleeve: (
        slotId: string,
        which: 'sleeved' | 'top_sleeved',
        on: boolean
      ): Promise<Result<ShipSlotUpdate>> =>
        ipcRenderer.invoke(IPC.shipSlotSleeve, { slotId, which, on }),

      // ---- The uploaded slip -------------------------------------------------
      /** Metadata only — cheap enough for any screen to ask on mount. */
      document: (): Promise<ShipDocument | null> => ipcRenderer.invoke(IPC.shipDocument),
      /**
       * The file itself, once. The caller turns it into a blob URL and pages
       * around inside it locally, so moving between orders costs nothing.
       */
      documentBytes: (): Promise<Uint8Array | null> => ipcRenderer.invoke(IPC.shipDocumentBytes),
      /**
       * How much of a slip still on its way has arrived, or null when there is
       * nothing to wait for. The document travels in slices (see
       * ship_document_parts), so a blank pane means one of two very different
       * things and this is how a screen tells them apart.
       */
      documentArrival: (): Promise<{ have: number; total: number; name: string } | null> =>
        ipcRenderer.invoke(IPC.shipDocumentArrival),
      clearDocument: (): Promise<Result<{ cleared: number }>> =>
        ipcRenderer.invoke(IPC.shipDocumentClear),

      // ---- Upload: the parse runs as a background job ------------------------
      /**
        * Start the background parse.
        *
        * Desktop: main opens a PDF picker unless `filePath` is given. Browser:
        * the PDF is chosen here and its bytes ride along, because a server has
        * no picker and would not be given a path if it had one.
        */
      startParse: async (request?: ShipParseRequest): Promise<Result<ShipParseStart>> => {
        const req = request ?? {}
        if (!ipcRenderer.pickFiles || req.filePath || req.upload || req.uploads) {
          return ipcRenderer.invoke(IPC.shipParseStart, req)
        }
        // SEVERAL SLIPS. A night can be two streams, and a bench can be working
        // two nights; each file becomes its own show. See @shared/shows.
        const uploads = await ipcRenderer.pickFiles({ accept: '.pdf', as: 'bytes', multiple: true })
        if (uploads.length === 0) return { ok: false, error: 'No file selected.' }
        return ipcRenderer.invoke(IPC.shipParseStart, { ...req, uploads })
      },
      parseJob: (jobId: string): Promise<ShipParseJob | null> =>
        ipcRenderer.invoke(IPC.shipParseJob, jobId),
      onParseProgress: (callback: (job: ShipParseJob) => void): (() => void) => {
        const listener = (_e: unknown, job: ShipParseJob): void => callback(job)
        ipcRenderer.on(IPC.shipParseEvent, listener)
        return () => ipcRenderer.removeListener(IPC.shipParseEvent, listener)
      },

      // ---- Orders ------------------------------------------------------------
      orders: (): Promise<ShipOrderRow[]> => ipcRenderer.invoke(IPC.shipOrdersList),
      order: (id: string): Promise<ShipOrderRow | null> => ipcRenderer.invoke(IPC.shipOrderGet, id),
      setStage: (id: string, stage: ShipFulfillmentStage): Promise<Result<ShipOrderRow>> =>
        ipcRenderer.invoke(IPC.shipOrderStage, { id, stage }),
      setHold: (id: string, onHold: boolean, reason?: string | null): Promise<Result<ShipOrderRow>> =>
        ipcRenderer.invoke(IPC.shipOrderHold, { id, onHold, reason: reason ?? null }),
      moveOrder: (id: string, direction: ShipQueueDirection): Promise<Result<ShipOrderRow[]>> =>
        ipcRenderer.invoke(IPC.shipOrderMove, { id, direction }),
      setSpecialRequest: (id: string, text: string): Promise<Result<ShipOrderRow>> =>
        ipcRenderer.invoke(IPC.shipOrderSpecialRequest, { id, text }),
      setOrderNotes: (id: string, notes: string): Promise<Result<ShipOrderRow>> =>
        ipcRenderer.invoke(IPC.shipOrderNotes, { id, notes }),
      resetQueue: (): Promise<Result<ShipOrderRow[]>> => ipcRenderer.invoke(IPC.shipOrdersResetQueue),

      // ---- Checker -----------------------------------------------------------
      breaks: (): Promise<ShipBreakSummary[]> => ipcRenderer.invoke(IPC.shipBreaksList),
      break: (id: string): Promise<ShipBreakDetail | null> => ipcRenderer.invoke(IPC.shipBreakGet, id),
      /** Bagged at the break bench — step 3. Break-side screens call this. */
      setSlotChecked: (id: string, checked: boolean): Promise<Result<ShipSlotUpdate>> =>
        ipcRenderer.invoke(IPC.shipSlotChecked, { id, checked }),
      /** Gathered into the buyer's package — step 4. The order walker calls this. */
      setSlotPicked: (id: string, picked: boolean): Promise<Result<ShipOrderRow>> =>
        ipcRenderer.invoke(IPC.shipSlotPicked, { id, picked }),
      setSlotTopSleeved: (id: string, topSleeved: boolean): Promise<Result<ShipSlotUpdate>> =>
        ipcRenderer.invoke(IPC.shipSlotTopSleeved, { id, topSleeved }),
      /**
       * The bench checklist. `benchStates` is every break at once (the board and
       * the tab badge); `bench` is one break's team-by-team bagging list.
       */
      benchStates: (): Promise<BreakStepState[]> => ipcRenderer.invoke(IPC.shipBenchStates),
      bench: (id: string): Promise<BreakBenchDetail | null> =>
        ipcRenderer.invoke(IPC.shipBenchGet, id),
      setBenchStep: (
        id: string,
        step: 'sleeve' | 'sort',
        done: boolean
      ): Promise<Result<BreakBenchDetail>> =>
        ipcRenderer.invoke(IPC.shipBenchSetStep, { id, step, done }),
      setTeamBagged: (
        id: string,
        teamName: string,
        bagged: boolean
      ): Promise<Result<BreakBenchDetail>> =>
        ipcRenderer.invoke(IPC.shipBenchSetTeamBagged, { id, teamName, bagged }),
      setBreakChecked: (id: string, checked: boolean): Promise<Result<ShipBreakDetail>> =>
        ipcRenderer.invoke(IPC.shipBreakCheckAll, { id, checked }),
      packBreak: (id: string): Promise<Result<ShipBreakDetail>> =>
        ipcRenderer.invoke(IPC.shipBreakPack, { id }),
      clearBreak: (id: string): Promise<Result<ShipBreakDetail>> =>
        ipcRenderer.invoke(IPC.shipBreakClear, { id }),
      sleeveBreak: (id: string, topSleeved: boolean): Promise<Result<ShipBreakDetail>> =>
        ipcRenderer.invoke(IPC.shipBreakSleeveAll, { id, topSleeved }),
      setBreakStatus: (id: string, status: ShipBreakStatus): Promise<Result<ShipBreakDetail>> =>
        ipcRenderer.invoke(IPC.shipBreakSetStatus, { id, status }),
      /**
       * Correct one break's league. `null` puts it back on the import's own
       * league — the state every break carries that predates per-break
       * detection — so it is a real value here, not a missing argument.
       */
      setBreakSport: (id: string, sport: ShipSport | null): Promise<Result<ShipBreakDetail>> =>
        ipcRenderer.invoke(IPC.shipBreakSetSport, { id, sport }),

      // ---- Break assignments (who is sorting which break) --------------------
      /** Every assignment, or just one break's when `breakId` is given. */
      assignments: (breakId?: string): Promise<ShipBreakAssignee[]> =>
        ipcRenderer.invoke(IPC.shipAssignmentsList, breakId ?? ''),
      /** The Admin tab's single read: breaks + assignees + the pickable roster. */
      assignmentBoard: (): Promise<ShipAssignmentBoard | null> =>
        ipcRenderer.invoke(IPC.shipAssignmentBoard),
      /** Idempotent: re-assigning the same person just refreshes their note. */
      assignBreak: (
        breakId: string,
        employeeId: string,
        note?: string | null
      ): Promise<Result<ShipBreakAssignmentUpdate>> =>
        ipcRenderer.invoke(IPC.shipAssign, { breakId, employeeId, note: note ?? null }),
      /** Remove by assignment id (what an assignee chip carries). */
      unassignBreak: (assignmentId: string): Promise<Result<ShipBreakAssignmentUpdate>> =>
        ipcRenderer.invoke(IPC.shipUnassign, { id: assignmentId }),
      /** Remove by (break, person) — the shape a toggle already has. */
      unassignEmployee: (
        breakId: string,
        employeeId: string
      ): Promise<Result<ShipBreakAssignmentUpdate>> =>
        ipcRenderer.invoke(IPC.shipUnassign, { breakId, employeeId }),

      // ---- Shipping tracker --------------------------------------------------
      shipments: (): Promise<ShipShipmentRow[]> => ipcRenderer.invoke(IPC.shipShipmentsList),
      setShipmentStatus: (id: string, code: ShipStatusCode): Promise<Result<ShipShipmentRow>> =>
        ipcRenderer.invoke(IPC.shipShipmentStatus, { id, code }),
      setShipmentNotes: (id: string, notes: string): Promise<Result<ShipShipmentRow>> =>
        ipcRenderer.invoke(IPC.shipShipmentNotes, { id, notes }),
      /** Omit `by` for a human write; pass 'auto' / '17track' / 'usps' for a scan. */
      bulkSetStatus: (
        entries: ShipBulkStatusEntry[],
        by?: string | null
      ): Promise<Result<ShipBulkStatusResult>> =>
        ipcRenderer.invoke(IPC.shipShipmentBulkStatus, { entries, by: by ?? null }),
      batchUrls: (): Promise<ShipBatchUrl[]> => ipcRenderer.invoke(IPC.shipBatchUrls),
      trackingNumbers: (): Promise<string[]> => ipcRenderer.invoke(IPC.shipTrackingNumbers),
      openTracking: (trackingNumber: string): Promise<Result> =>
        ipcRenderer.invoke(IPC.shipOpenTracking, trackingNumber),
      /** Opens the USPS "open all" tabs — one batch, or every batch when omitted. */
      openBatch: (batchNumber?: number): Promise<Result<{ opened: number }>> =>
        ipcRenderer.invoke(IPC.shipOpenBatch, { batchNumber }),

      // ---- Sales / ledger ----------------------------------------------------
      sales: (): Promise<ShipSalesSummary | null> => ipcRenderer.invoke(IPC.shipSales),
      ledger: (): Promise<ShipLedgerRow[]> => ipcRenderer.invoke(IPC.shipLedger),

      // ---- History -----------------------------------------------------------
      /**
       * A month of real activity, one entry per calendar day — imports, value,
       * cards picked/total, tracking and sent/delivered counts — so the grid
       * renders from a single call. `month` is 1-12; omit both for this month.
       */
      calendar: (year?: number, month?: number): Promise<ShipCalendarMonth | null> =>
        ipcRenderer.invoke(IPC.shipCalendar, { year, month }),
      /** One day expanded: per-break breakdown + the snapshot to jump to. */
      calendarDay: (date: string): Promise<ShipCalendarDayDetail | null> =>
        ipcRenderer.invoke(IPC.shipCalendarDay, date),
      imports: (): Promise<ShipImportRecord[]> => ipcRenderer.invoke(IPC.shipImportsList),
      renameImport: (id: string, name: string): Promise<Result<ShipImportRecord>> =>
        ipcRenderer.invoke(IPC.shipImportRename, { id, name }),
      /** What deleting this import would destroy, priced. Nothing is written. */
      importDeletePlan: (id: string): Promise<Result<ShipImportDeletePlan>> =>
        ipcRenderer.invoke(IPC.shipImportDeletePlan, { id }),
      /** Delete the show, not just its log row. */
      deleteImport: (id: string): Promise<Result<ShipImportDeleteResult>> =>
        ipcRenderer.invoke(IPC.shipImportDelete, { id }),
      snapshots: (): Promise<ShipSnapshotSummary[]> => ipcRenderer.invoke(IPC.shipSnapshotsList),
      snapshot: (id: string): Promise<ShipSnapshot | null> =>
        ipcRenderer.invoke(IPC.shipSnapshotGet, id),
      createSnapshot: (name?: string): Promise<Result<ShipSnapshot>> =>
        ipcRenderer.invoke(IPC.shipSnapshotCreate, { name: name ?? '' }),
      /**
       * Close the night: capture it as a report, then put the paper away.
       *
       * NOT a delete. Every package, card, claim and assignment stays where it
       * is — what goes is the PDF, whose only job was to be read at the bench
       * while the cards were being pulled. The capture is written first and both
       * happen in one transaction, because a report with no paper and a
       * cleared slip with no report are each worse than doing nothing.
       */
      finishNight: (name?: string): Promise<Result<ShipFinishResult>> =>
        ipcRenderer.invoke(IPC.shipFinishNight, { name: name ?? '' }),
      renameSnapshot: (id: string, name: string): Promise<Result<ShipSnapshot>> =>
        ipcRenderer.invoke(IPC.shipSnapshotRename, { id, name }),
      deleteSnapshot: (id: string): Promise<Result> =>
        ipcRenderer.invoke(IPC.shipSnapshotDelete, { id }),
      /** Pass a `snapshotId` to export the dated capture instead of live data. */
      export: (kind: ShipExportKind, snapshotId?: string | null): Promise<ExportResult> =>
        ipcRenderer.invoke(IPC.shipExport, { kind, snapshotId: snapshotId ?? null }),

      // ---- Settings ----------------------------------------------------------
      settings: (): Promise<Record<string, string>> => ipcRenderer.invoke(IPC.shipSettingsGet),
      saveSettings: (patch: Record<string, string | null>): Promise<Result<Record<string, string>>> =>
        ipcRenderer.invoke(IPC.shipSettingsPatch, patch)
    },
    /**
     * Streaming — show sessions, breaks and giveaways. Reads resolve to an empty
     * value without `module.streaming`; every mutation needs `streaming.manage`
     * (each one moves real stock) and returns `Result<T>` carrying the freshly
     * derived session or detail, so a screen can reconcile without a refetch.
     */
    streaming: {
      /** The show currently on air, if any. */
      active: (): Promise<StreamSession | null> => ipcRenderer.invoke(IPC.streamActive),
      /** One entry per day that HAS activity — the caller builds the grid. */
      calendar: (month: string): Promise<StreamCalendarMonth> =>
        ipcRenderer.invoke(IPC.streamCalendar, month),
      /** Ranged on the session's business day (stream_date), newest first. */
      list: (from: string, to: string): Promise<StreamSession[]> =>
        ipcRenderer.invoke(IPC.streamList, { from, to }),
      get: (id: string): Promise<StreamSessionDetail | null> => ipcRenderer.invoke(IPC.streamGet, id),
      start: (input: {
        title: string
        hostId: string | null
        /** Everybody on the show. The first of them becomes the host. */
        crew?: string[]
        note: string | null
      }): Promise<Result<StreamSession>> => ipcRenderer.invoke(IPC.streamStart, input),
      end: (id: string): Promise<Result<StreamSession>> => ipcRenderer.invoke(IPC.streamEnd, id),
      /** Type in a show nobody clocked. Refused if it overlaps another session. */
      create: (input: NewStreamSession): Promise<Result<StreamSession>> =>
        ipcRenderer.invoke(IPC.streamCreate, input),
      /** Partial: an omitted field keeps its value, an explicit null clears it. */
      update: (input: UpdateStreamSession): Promise<Result<StreamSession>> =>
        ipcRenderer.invoke(IPC.streamUpdate, input),
      /** Deletes the session AND returns the stock its lines consumed. */
      remove: (id: string): Promise<Result> => ipcRenderer.invoke(IPC.streamDelete, id),
      /**
       * Consumes stock at its real FIFO cost.
       *
       * Send it in the units the work is described in — `cases` + `boxes` for a
       * break, `boxes` + `packs` for a giveaway — and main converts to whatever
       * unit THAT product is stocked in. `quantity` is the raw stock-unit escape
       * hatch and is ignored when any of the three are present.
       *
       * On a show that is already history (isPastDatedSession) this is a
       * RECONCILIATION instead: send the count in the product's OWN stock unit —
       * `cases` for a case-stocked product, `boxes` for a box-stocked one — plus
       * `casePrice`, which is what one of those cost. The line then books what was
       * actually paid, moving no stock. Main decides which of the two acts it is
       * from the stored session, and which unit the count is in from the product,
       * refusing a mismatch either way — so a form drawn before midnight cannot
       * post the wrong kind of line after it.
       *
       * A refused conversion comes back as `Result.error` and is safe to show
       * verbatim: every one of those messages names the field to go and fill in
       * (boxes per case, packs per box, or the giveaway-item flag).
       */
      addItem: (input: NewStreamItem): Promise<Result<StreamSessionDetail>> =>
        ipcRenderer.invoke(IPC.streamItemAdd, input),
      /** Puts back exactly the cost layers the line took. */
      removeItem: (id: string): Promise<Result<StreamSessionDetail>> =>
        ipcRenderer.invoke(IPC.streamItemRemove, id),
      /**
       * What a line already recorded turns out to have cost — "we might not always
       * know in the moment".
       *
       * `unitPrice` is per ONE of whatever the product is stocked in: per case for
       * a case-stocked product, per box for a box-stocked one, the same unit
       * `addItem`'s `casePrice` is in.
       *
       * IT CORRECTS THE RECORD, NOT THE STOCK. No cost layer is consumed, opened
       * or revalued and no average is re-based, on either kind of line — a
       * reconciled line never moved stock and a live one moved it when it was
       * recorded. What changes is what the statement says that night cost.
       */
      setItemCost: (input: SetStreamItemCost): Promise<Result<StreamSessionDetail>> =>
        ipcRenderer.invoke(IPC.streamItemCost, input),
      /**
       * Shows that have not happened yet — the diary, not the record.
       *
       * A plan carries BOTH halves of its start on purpose. `streamDate` +
       * `startTime` is the intention ("9:00 PM on Friday"), which is what a
       * screen shows and what stays true across a daylight-saving boundary.
       * `startsAt` is the same moment as a UTC instant, and the CALLER computes
       * it — the browser is the only party that knows what timezone the person
       * typing "9:00 PM" is in, and the relay that sends the reminders runs in
       * UTC and must never guess. Use `isoFromLocalParts` from the streaming
       * module's time helpers; do not send a hand-built string.
       */
      plans: {
        /** Everything still to come, soonest first. Cancelled plans excluded. */
        upcoming: (): Promise<ScheduledStream[]> => ipcRenderer.invoke(IPC.streamPlanList),
        /** Plans whose LOCAL day falls in [from, to] — the calendar's question. */
        range: (from: string, to: string): Promise<ScheduledStream[]> =>
          ipcRenderer.invoke(IPC.streamPlanRange, { from, to }),
        create: (input: NewScheduledStream): Promise<Result<ScheduledStream>> =>
          ipcRenderer.invoke(IPC.streamPlanCreate, input),
        /**
         * Partial: an omitted field keeps its value, an explicit null clears it.
         *
         * Moving the start RE-ARMS both reminders, because the relay records
         * what it has sent against the start instant as well as the plan. A show
         * moved from 9pm to 11pm is told about again; a title correction is not.
         */
        update: (input: { id: string } & Partial<NewScheduledStream>): Promise<Result<ScheduledStream>> =>
          ipcRenderer.invoke(IPC.streamPlanUpdate, input),
        /** Call it off. Keeps the row, stops the reminders. */
        cancel: (id: string): Promise<Result<ScheduledStream>> =>
          ipcRenderer.invoke(IPC.streamPlanCancel, id),
        /** For the one typed by mistake. */
        remove: (id: string): Promise<Result> => ipcRenderer.invoke(IPC.streamPlanDelete, id),
        /**
         * Go live on it. Runs the ordinary Start-stream path — same "already
         * live" and overlap refusals — and returns the session it created. The
         * session's start is NOW, not the planned time: the plan said nine and
         * the show went on at 9:07, and the record has to be what happened.
         */
        start: (id: string): Promise<Result<{ sessionId: string }>> =>
          ipcRenderer.invoke(IPC.streamPlanStart, id)
      }
    },
    /**
     * Finance → Streaming: the Whatnot ledger, attributed to shows.
     *
     * Reads resolve to an empty view / [] without `module.finance`; every write
     * needs `finance.manage` and hands back the freshly derived view, so a screen
     * never has to refetch to find out what its own action did.
     *
     * A row's business day is its session's `streamDate` — the local date the show
     * STARTED on — so a stream that ran 7/24 into 7/25 counts entirely to 7/24.
     * Anything that matched no session stays in `unattributed`, clustered by time
     * so the missing show is visible rather than merely counted.
     */
    finance: {
      /** Day-by-day revenue, totals, unattributed money and the reconciliation
       *  flag. `reconciled: false` means the numbers do not add up — show it. */
      streamView: (): Promise<StreamingFinanceView> => ipcRenderer.invoke(IPC.finStreamView),
      /** Opens a file picker — native in Electron, the browser's own in a tab.
       *  Re-importing an overlapping week is safe: matched rows are skipped as
       *  duplicates, never counted twice. */
      importLedger: async (): Promise<Result<LedgerImportResult>> => {
        if (!ipcRenderer.pickFile) return ipcRenderer.invoke(IPC.finLedgerImport)
        const upload = await ipcRenderer.pickFile({ accept: '.csv', as: 'text' })
        if (!upload) return { ok: false, error: 'No file selected.' }
        return ipcRenderer.invoke(IPC.finLedgerImport, upload)
      },
      imports: (): Promise<LedgerImport[]> => ipcRenderer.invoke(IPC.finLedgerImports),
      /** One row per product line sold on a sales order: what it sold for, what
       *  those exact FIFO layers cost, and the margin between them. */
      wholesale: (): Promise<WholesaleSaleRow[]> => ipcRenderer.invoke(IPC.finWholesale),
      /** Which years the ledger has anything in, newest first. */
      historyYears: (): Promise<OrderHistoryYears> => ipcRenderer.invoke(IPC.finHistoryYears),
      /**
       * Every purchase order filed under one year, lines included.
       *
       * `sourcePoId` narrows to ONE purchase and then ignores the year, because
       * what came out of a December trip is mostly sold in January — see
       * listPurchaseOrderHistory.
       */
      historyPurchaseOrders: (
        year: number,
        sourcePoId?: string | null
      ): Promise<PurchaseOrderHistoryRow[]> =>
        ipcRenderer.invoke(IPC.finHistoryPos, { year, sourcePoId: sourcePoId ?? '' }),
      /** Every sales order filed under one year, lines and FIFO cost included. */
      historySalesOrders: (
        year: number,
        sourcePoId?: string | null
      ): Promise<SalesOrderHistoryRow[]> =>
        ipcRenderer.invoke(IPC.finHistorySos, { year, sourcePoId: sourcePoId ?? '' }),
      /** The purchases the ledger can be narrowed to. See listHistorySources. */
      historySources: (): Promise<HistorySource[]> => ipcRenderer.invoke(IPC.finHistorySources),
      /** The deal ticket register for one year, or the whole thing for null. */
      dealTickets: (year: number | null): Promise<DealTicketRow[]> =>
        ipcRenderer.invoke(IPC.finDealTickets, year),
      /** Every order somebody deleted, newest first. See listDeletedOrders. */
      deletedOrders: (): Promise<DeletedOrder[]> => ipcRenderer.invoke(IPC.finDeletedOrders),
      /** Which years the register covers, and what it will call the next one. */
      dealTicketYears: (): Promise<{ years: number[]; next: string }> =>
        ipcRenderer.invoke(IPC.finDealTicketYears),
      /** Put several documents under one ticket. Returns the whole register. */
      mergeDealTickets: (targetId: string, ticketIds: string[]): Promise<Result<DealTicketRow[]>> =>
        ipcRenderer.invoke(IPC.finDealTicketsMerge, { targetId, ticketIds }),
      /** Take documents back out, each to the number it was struck with. */
      unmergeDealTickets: (ticketIds: string[]): Promise<Result<DealTicketRow[]>> =>
        ipcRenderer.invoke(IPC.finDealTicketsUnmerge, { ticketIds }),
      /** Removes the upload and the rows NOTHING ELSE covers — a correction.
       *  Rows another import also contains are re-pointed to it and survive. */
      deleteImport: (id: string): Promise<Result<StreamingFinanceView>> =>
        ipcRenderer.invoke(IPC.finLedgerDeleteImport, id),
      /** What that delete would cost, for the confirmation to quote. */
      importImpact: (id: string): Promise<ImportDeleteImpact> =>
        ipcRenderer.invoke(IPC.finLedgerImportImpact, id),
      rows: (filter: {
        streamDate?: string
        sessionId?: string
        bucket?: string
        unattributed?: boolean
        limit?: number
      }): Promise<LedgerRow[]> => ipcRenderer.invoke(IPC.finLedgerRows, filter),
      /**
       * The records behind ONE figure on the P&L, over the range on screen.
       *
       * `start`/`end` are inclusive business days and both null means all time —
       * the same null the range control uses. Fetched on click rather than with
       * the statement: a five-week export is thousands of rows and almost none of
       * them are ever opened.
       *
       * The payload's `total` is the sum of EVERY matching record, not of the page
       * that came back, because it is what the screen reconciles against the
       * figure that was clicked.
       */
      pnlDetail: (req: PnlDrillRequest): Promise<PnlDetail> =>
        ipcRenderer.invoke(IPC.finPnlDetail, req),
      /** One business day, split by break. `day` is a stream_date — a BUSINESS
       *  day, the same key the statement and the rate lookup are asked with. */
      breakPnl: (day: string): Promise<BreakPnlSplit> =>
        ipcRenderer.invoke(IPC.finBreakPnl, day),
      /** Re-runs attribution against the sessions as they are NOW. This is how
       *  unattributed money moves onto a show after the operator adds the session
       *  they forgot to log — data entry, never a heuristic. */
      reattribute: (): Promise<Result<StreamingFinanceView>> =>
        ipcRenderer.invoke(IPC.finLedgerReattribute),
      /**
       * What Whatnot's commission was, by date range. 6% wherever nothing says.
       *
       * The fee is DERIVED ON READ from the net figure Whatnot paid, so saving one
       * of these re-prices every past show it covers the next time the view is
       * read — no re-upload, no re-attribution. Both writes hand back the whole
       * list, because these are ranges that constrain each other and a single row
       * is not a useful answer to "did that save".
       */
      rates: (): Promise<WhatnotRatePeriod[]> => ipcRenderer.invoke(IPC.finRatesList),
      saveRate: (input: RatePeriodInput): Promise<Result<WhatnotRatePeriod[]>> =>
        ipcRenderer.invoke(IPC.finRateSave, input),
      deleteRate: (id: string): Promise<Result<WhatnotRatePeriod[]>> =>
        ipcRenderer.invoke(IPC.finRateDelete, id),
      /**
       * What the platform says a window sold, and whether we agree.
       *
       * Revenue on the Streaming tab is DERIVED — the ledger states only the net
       * and the gross is that net with a modelled fee added back — so these are
       * the only calls in the finance surface that reach for something outside
       * the app. `check` stores nothing: running it must never be the thing that
       * moves a number, so saving the fitted rate is a separate `saveRate`.
       */
      statements: (): Promise<WhatnotStatement[]> => ipcRenderer.invoke(IPC.finStatements),
      saveStatement: (input: StatementInput): Promise<Result<WhatnotStatement[]>> =>
        ipcRenderer.invoke(IPC.finStatementSave, input),
      deleteStatement: (id: string): Promise<Result<WhatnotStatement[]>> =>
        ipcRenderer.invoke(IPC.finStatementDelete, id),
      revenueCheck: (input: {
        fromDate: string
        toDate: string
        statedGross: number
        /** What the platform actually paid out. Null when the document does not say. */
        statedPayout?: number | null
      }): Promise<RevenueCheck | null> => ipcRenderer.invoke(IPC.finRevenueCheck, input),
      /**
       * Costs typed against a business day — a pack opened for fun, a box written
       * off. A DOLLAR AMOUNT ONLY: nothing on this bridge moves stock, which is
       * what separates it from the streaming giveaway flow.
       *
       * Both writes hand back the entries and the re-derived view together,
       * because one of these changes the bottom line of the day it lands on.
       */
      expenses: (): Promise<GeneralExpense[]> => ipcRenderer.invoke(IPC.finExpensesList),
      saveExpense: (input: GeneralExpenseInput): Promise<Result<GeneralExpenseResult>> =>
        ipcRenderer.invoke(IPC.finExpenseSave, input),
      deleteExpense: (id: string): Promise<Result<GeneralExpenseResult>> =>
        ipcRenderer.invoke(IPC.finExpenseDelete, id)
    },
    email: {
      composeInvite: (
        employeeId: string,
        temporaryPassword: string | null
      ): Promise<Result<ComposedEmail>> =>
        ipcRenderer.invoke(IPC.emailComposeInvite, { employeeId, temporaryPassword }),
      openExternal: (url: string): Promise<Result> => ipcRenderer.invoke(IPC.emailOpenExternal, url)
    },
    /**
     * Cloud sync — the relay that keeps every laptop showing the same data.
     *
     * `onChanged` is the live half: it fires when rows from another machine have
     * landed locally, carrying only which KINDS of record moved. A screen refetches
     * through its normal, permission-checked call rather than being handed data
     * over the event, so this can never surface something the viewer may not see.
     */
    sync: {
      status: (): Promise<SyncStatus> => ipcRenderer.invoke(IPC.syncStatus),
      configure: (update: Partial<SyncConfig> & { key?: string }): Promise<Result<SyncStatus>> =>
        ipcRenderer.invoke(IPC.syncConfigure, update),
      test: (): Promise<Result<{ rows: number }>> => ipcRenderer.invoke(IPC.syncTest),
      now: (): Promise<Result<{ pushed: number; pulled: number; applied: number; rejected: number }>> =>
        ipcRenderer.invoke(IPC.syncNow),
      seed: (): Promise<Result<{ queued: number }>> => ipcRenderer.invoke(IPC.syncSeed),
      rejects: (): Promise<SyncReject[]> => ipcRenderer.invoke(IPC.syncRejects),
      clearRejects: (): Promise<Result<{ cleared: number }>> =>
        ipcRenderer.invoke(IPC.syncClearRejects),
      drift: (): Promise<StockDrift[]> => ipcRenderer.invoke(IPC.syncDrift),
      repairStock: (): Promise<Result<{ shelves: number; changed: number }>> =>
        ipcRenderer.invoke(IPC.syncRepairStock),
      onStatus: (callback: (status: SyncStatus) => void): (() => void) => {
        const listener = (_e: unknown, status: SyncStatus): void => callback(status)
        ipcRenderer.on(IPC.syncStatusEvent, listener)
        return () => ipcRenderer.removeListener(IPC.syncStatusEvent, listener)
      },
      onChanged: (callback: (event: { kinds: string[] }) => void): (() => void) => {
        const listener = (_e: unknown, payload: { kinds: string[] }): void => callback(payload)
        ipcRenderer.on(IPC.syncChangedEvent, listener)
        return () => ipcRenderer.removeListener(IPC.syncChangedEvent, listener)
      }
    },
    /**
     * Clock-in push notifications.
     *
     * The browser gets its own subscription from the push service and hands the
     * three public values here; the relay does the signing and encrypting. No
     * VAPID private key and no relay key ever reaches this side — see
     * @shared/webPush for why the middleman exists at all.
     */
    push: {
      state: (): Promise<ClockPushState> => ipcRenderer.invoke(IPC.pushState),
      subscribe: (input: PushSubscriptionInput): Promise<Result<{ ok: true }>> =>
        ipcRenderer.invoke(IPC.pushSubscribe, input),
      unsubscribe: (endpoint: string): Promise<Result<{ ok: true }>> =>
        ipcRenderer.invoke(IPC.pushUnsubscribe, endpoint),
      test: (): Promise<Result<{ sent: number; dropped: number; failed: number }>> =>
        ipcRenderer.invoke(IPC.pushTest)
    },
    intake: {
      links: (): Promise<IntakeLink[]> => ipcRenderer.invoke(IPC.intakeLinks),
      createLink: (input: IntakeLinkInput): Promise<Result<IntakeLink>> =>
        ipcRenderer.invoke(IPC.intakeLinkCreate, input),
      setLinkActive: (id: string, active: boolean): Promise<Result<{ id: string }>> =>
        ipcRenderer.invoke(IPC.intakeLinkSetActive, { id, active }),
      submissions: (status?: IntakeStatus): Promise<IntakeSubmission[]> =>
        ipcRenderer.invoke(IPC.intakeSubmissions, status),
      accept: (id: string): Promise<Result<IntakeSubmission>> =>
        ipcRenderer.invoke(IPC.intakeAccept, id),
      reject: (id: string, note: string): Promise<Result<IntakeSubmission>> =>
        ipcRenderer.invoke(IPC.intakeReject, { id, note })
    },
    /**
     * The owner's home board and inbox.
     *
     * `board` returns whichever sections the caller's own module permissions
     * already cover, so this is a vantage point rather than a new door.
     */
    owner: {
      board: (): Promise<OwnerBoard | null> => ipcRenderer.invoke(IPC.ownerBoard),
      reminders: (): Promise<Reminder[]> => ipcRenderer.invoke(IPC.remindersList),
      /** Anyone signed in may send one — see the note in ownerIpc.ts. */
      sendReminder: (input: NewReminder): Promise<Result<Reminder>> =>
        ipcRenderer.invoke(IPC.remindersCreate, input),
      setReminderStatus: (id: string, status: 'open' | 'done'): Promise<Result<Reminder>> =>
        ipcRenderer.invoke(IPC.remindersSetStatus, { id, status }),
      deleteReminder: (id: string): Promise<Result<boolean>> =>
        ipcRenderer.invoke(IPC.remindersDelete, id),

      /**
       * The caller's OWN to-do list.
       *
       * None of these names whose list to touch. The owner id is taken from the
       * session inside the handler, which is what makes "your list" a property
       * of the operation rather than of the argument somebody remembered to
       * pass.
       */
      todos: (): Promise<Todo[]> => ipcRenderer.invoke(IPC.todosList),
      addTodo: (body: string): Promise<Result<Todo>> => ipcRenderer.invoke(IPC.todoCreate, body),
      setTodoDone: (id: string, done: boolean): Promise<Result<Todo>> =>
        ipcRenderer.invoke(IPC.todoSetDone, { id, done }),
      deleteTodo: (id: string): Promise<Result<{ id: string }>> =>
        ipcRenderer.invoke(IPC.todoDelete, id),
      clearDoneTodos: (): Promise<Result<{ cleared: number }>> =>
        ipcRenderer.invoke(IPC.todosClearDone),

      /** Jobs on a clock. Same rule: the caller's own, never named in a call. */
      recurring: (): Promise<RecurringTask[]> => ipcRenderer.invoke(IPC.recurringList),
      addRecurring: (input: {
        title: string
        everyDays: number
        anchorDate: string
        leadDays?: number
      }): Promise<Result<RecurringTask>> => ipcRenderer.invoke(IPC.recurringCreate, input),
      /** `occurrence` is the date the SCREEN showed, not today. */
      completeRecurring: (id: string, occurrence: string): Promise<Result<{ id: string }>> =>
        ipcRenderer.invoke(IPC.recurringComplete, { id, occurrence }),
      deleteRecurring: (id: string): Promise<Result<{ id: string }>> =>
        ipcRenderer.invoke(IPC.recurringDelete, id),

      /** The caller's OWN shifts, day by day and by payroll period. */
      myHours: (): Promise<{
        days: Array<{ day: string; minutes: number; shifts: number }>
        periods: Array<{
          start: string
          end: string
          runOn: string
          paidOn: string
          current: boolean
          minutes: number
        }>
        totalMinutes: number
        firstDay: string | null
      } | null> => ipcRenderer.invoke(IPC.myHours)
    },
    /**
     * The floor's home board, and the rota behind one of its cards.
     *
     * `board` is scoped to the caller by the handler, exactly as the owner's is.
     * `mine` is their own shifts; the three write operations are the lead's and
     * are refused for anybody else in main.
     */
    staff: {
      board: (): Promise<StaffBoard | null> => ipcRenderer.invoke(IPC.staffBoard),
      myShifts: (): Promise<Shift[]> => ipcRenderer.invoke(IPC.scheduleMine),
      shifts: (from: string, to: string): Promise<ShiftWithPerson[]> =>
        ipcRenderer.invoke(IPC.scheduleList, { from, to }),
      addShift: (input: NewShift): Promise<Result<Shift>> =>
        ipcRenderer.invoke(IPC.scheduleCreate, input),
      deleteShift: (id: string): Promise<Result<{ id: string }>> =>
        ipcRenderer.invoke(IPC.scheduleDelete, id),
      copyWeek: (from: string, to: string): Promise<Result<{ created: number }>> =>
        ipcRenderer.invoke(IPC.scheduleCopyWeek, { from, to }),

      /**
       * What this week still owes the floor — never published, or published and
       * changed since. A pure read, so the Publish button can carry a count.
       */
      pendingShifts: (from: string, to: string): Promise<ShiftWithPerson[]> =>
        ipcRenderer.invoke(IPC.schedulePending, { from, to }),

      /**
       * Publish the week: put it on the phones of the people on it, and tell
       * them. `problem` is a sentence about the NOTIFYING, beside a publish that
       * succeeded — the rota is out either way, and a dead relay must not be
       * reported as a failure to publish.
       */
      publishShifts: (
        from: string,
        to: string
      ): Promise<
        Result<{ published: number; people: number; notified: number; problem: string | null }>
      > => ipcRenderer.invoke(IPC.schedulePublish, { from, to }),

      /**
       * Availability — what you say about a day before anybody is put on it.
       *
       * `myAvailability` and `setAvailability` name no employee, deliberately:
       * the session is whose. `availability` is the lead's range read and comes
       * back empty for anybody without admin.hours.view.
       */
      myAvailability: (): Promise<Availability[]> => ipcRenderer.invoke(IPC.availabilityMine),
      /**
       * The team's answers across a range — EFFECTIVE, so a day covered by
       * somebody's usual week is in here even though nobody tapped that date.
       * Each row carries `source` so the screen can tell the two apart.
       */
      availability: (from: string, to: string): Promise<EffectiveAvailabilityWithPerson[]> =>
        ipcRenderer.invoke(IPC.availabilityList, { from, to }),
      setAvailability: (input: NewAvailability): Promise<Result<Availability>> =>
        ipcRenderer.invoke(IPC.availabilitySet, input),
      clearAvailability: (day: string): Promise<Result<{ day: string }>> =>
        ipcRenderer.invoke(IPC.availabilityClear, day),

      /**
       * Your USUAL WEEK — "I work Mondays, Wednesdays and Fridays".
       *
       * `setPattern` takes the whole week at once because that is the one
       * gesture somebody makes; seven separate calls would let a dropped
       * connection leave a half-written week that reads as a real answer.
       */
      myPattern: (): Promise<AvailabilityPattern[]> => ipcRenderer.invoke(IPC.patternMine),
      setPattern: (days: PatternDayInput[]): Promise<Result<AvailabilityPattern[]>> =>
        ipcRenderer.invoke(IPC.patternSet, { days }),
      clearPattern: (): Promise<Result<{ cleared: number }>> =>
        ipcRenderer.invoke(IPC.patternClear),

      /**
       * A lead's whole view of a week: everybody's usual week, who is rostered,
       * and where the two disagree. Comes back empty for anybody without
       * admin.hours.view rather than null, so the screen has one shape.
       */
      teamSchedule: (from: string, to: string): Promise<TeamScheduleOverview> =>
        ipcRenderer.invoke(IPC.scheduleTeamOverview, { from, to })
    },
    /**
     * Invoices — the sell side, and the mirror image of purchase orders.
     *
     * Everything is gated on `module.invoicing` in main. The three qbo* calls
     * are the only ones that leave the machine, and `createInQbo` is the only
     * one anywhere in this API that WRITES to somebody's accounting system.
     */
    /**
     * Messages, and the contact list they are addressed from.
     *
     * Every one of these is a plain database operation. The push notification is
     * sent by main as a side effect of a send and reported back in the result —
     * a relay that is down costs the buzz and never the message.
     */
    messages: {
      contacts: (): Promise<Contact[]> => ipcRenderer.invoke(IPC.contactsList),
      threads: (): Promise<ThreadSummary[]> => ipcRenderer.invoke(IPC.messageThreads),
      thread: (id: string): Promise<ThreadDetail | null> =>
        ipcRenderer.invoke(IPC.messageThread, id),
      /** Everything unread, across every conversation — the sidebar badge. */
      unread: (): Promise<number> => ipcRenderer.invoke(IPC.messageUnread),
      /** Start one. Needs messages.broadcast: it puts a message in front of
       *  somebody who did not ask for it. */
      create: (input: NewThreadInput): Promise<Result<ThreadSummary>> =>
        ipcRenderer.invoke(IPC.messageThreadCreate, input),
      /** Everybody at once, in a thread of its own. */
      broadcast: (
        title: string,
        body: string
      ): Promise<Result<{ thread: ThreadSummary; notified: number; notifyProblem: string | null }>> =>
        ipcRenderer.invoke(IPC.messageBroadcast, { title, body }),
      /** Reply. Unprivileged — being in the thread IS the permission. */
      send: (threadId: string, body: string): Promise<Result<SendResult>> =>
        ipcRenderer.invoke(IPC.messageSend, { threadId, body }),
      markRead: (threadId: string): Promise<Result> =>
        ipcRenderer.invoke(IPC.messageMarkRead, threadId),
      add: (threadId: string, employeeIds: string[]): Promise<Result<ThreadSummary>> =>
        ipcRenderer.invoke(IPC.messageThreadAdd, { threadId, employeeIds }),
      leave: (threadId: string): Promise<Result> =>
        ipcRenderer.invoke(IPC.messageThreadLeave, threadId)
    },

    /**
     * What a purchase order and a sales order BOTH have.
     *
     * One section taking a `side` of 'po' or 'so' rather than the same four
     * calls duplicated under each board. Every question here — how did it get
     * here, what is it shipping in, what paperwork is on it — is asked
     * identically of both documents, and two parallel sets would drift the first
     * time either was edited.
     */
    orders: {
      /** What happened to this order, newest first. A read; nothing writes here. */
      events: (side: OrderSide, orderId: string): Promise<OrderEvent[]> =>
        ipcRenderer.invoke(IPC.orderEvents, { side, orderId }),

      /** The parcels it ships in, each with its own carrier and service. */
      shipments: (side: OrderSide, orderId: string): Promise<OrderShipment[]> =>
        ipcRenderer.invoke(IPC.orderShipments, { side, orderId }),

      /**
       * Add a parcel or change one.
       *
       * Omit the carrier and it is GUESSED from the tracking number, which is
       * the ordinary gesture: paste the number and the carrier and its services
       * fill themselves in. An explicit carrier always wins, so a wrong guess
       * can be corrected and stays corrected.
       */
      saveShipment: (
        side: OrderSide,
        orderId: string,
        shipment: NewOrderShipment & { id?: string }
      ): Promise<Result<OrderShipment>> =>
        ipcRenderer.invoke(IPC.orderShipmentSave, { side, orderId, shipment }),

      deleteShipment: (id: string): Promise<Result<{ id: string }>> =>
        ipcRenderer.invoke(IPC.orderShipmentDelete, id),

      /** Labels attached to this order. `present` says whether the bytes are here. */
      documents: (side: OrderSide, orderId: string): Promise<OrderDocument[]> =>
        ipcRenderer.invoke(IPC.orderDocuments, { side, orderId }),

      uploadDocument: (
        side: OrderSide,
        orderId: string,
        file: UploadedFile,
        shipmentId?: string | null
      ): Promise<Result<OrderDocument>> =>
        ipcRenderer.invoke(IPC.orderDocumentUpload, { side, orderId, file, shipmentId }),

      openDocument: (id: string): Promise<Result<{ path: string }>> =>
        ipcRenderer.invoke(IPC.orderDocumentOpen, id),

      deleteDocument: (id: string): Promise<Result<{ id: string }>> =>
        ipcRenderer.invoke(IPC.orderDocumentDelete, id),

      /**
       * Email the label to whoever is shipping the goods.
       *
       * `sent` is the fact that matters. With a mail account configured this
       * really sends, with the label attached. Without one it comes back
       * `sent: false` and a `mailtoUrl` the screen can open instead — which
       * cannot carry the attachment, and the screen has to say so rather than
       * letting somebody send an email they believe has a label on it.
       */
      emailLabel: (input: {
        side: OrderSide
        orderId: string
        to: string
        note?: string | null
        documentId?: string | null
      }): Promise<
        Result<{
          sent: boolean
          mailtoUrl: string
          subject: string
          body: string
          problem: string | null
        }>
      > => ipcRenderer.invoke(IPC.orderEmailLabel, input),

      /** Record that a purchase order and a sales order are the same deal. */
      /**
       * The purchase orders a saved sale could be attached to.
       *
       * Deliberately not the PO board's list: that one sweeps finished orders
       * off after a day, and a purchase raised last week for goods only now
       * being invoiced is exactly the one somebody comes here looking for.
       */
      /** Every purchase this sale could name. `query` reaches past the newest 60. */
      linkablePos: (
        invoiceId: string,
        query = ''
      ): Promise<Result<LinkablePurchaseOrder[]>> =>
        ipcRenderer.invoke(IPC.orderLinkablePos, { invoiceId, query }),
      linkDropship: (poId: string, invoiceId: string): Promise<Result<{ linked: true }>> =>
        ipcRenderer.invoke(IPC.orderLinkDropship, { poId, invoiceId }),
      /**
       * Take one purchase back off a sale. A sale may be supplied by several,
       * so attaching the wrong one has to be undoable — with one column there
       * was nothing to detach from, only a value to overwrite.
       */
      unlinkPurchase: (poId: string, invoiceId: string): Promise<Result<{ unlinked: true }>> =>
        ipcRenderer.invoke(IPC.orderUnlinkPurchase, { poId, invoiceId }),

      /**
       * One purchase, several buyers: write and link every buyer's sales order
       * in one transaction.
       *
       * ALL OR NOTHING. A half-written split leaves buyers uninvoiced for boxes
       * already shipping, and the assignment that knew which ones is gone the
       * moment the screen closes — so a failure comes back with nothing created
       * and the screen still holding the answer.
       *
       * The orders arrive as DRAFTS at rate 0. Prices are per buyer and nobody
       * has typed them yet; posting five unpriced invoices to QuickBooks from
       * one button would be five documents to void over there.
       */
      splitDropship: (
        poId: string,
        orders: NewInvoice[]
      ): Promise<
        Result<{
          created: Array<{ id: string; invoiceNumber: string | null; customerName: string }>
        }>
      > => ipcRenderer.invoke(IPC.orderSplitDropship, { poId, orders }),

      /** Every sales order raised against one purchase order, oldest first. */
      dropshipSales: (poId: string): Promise<InvoiceDetail[]> =>
        ipcRenderer.invoke(IPC.orderDropshipSales, poId),

      /**
       * The address already on file for a party, so the To box fills itself in.
       *
       * A SUGGESTION. A purchase order's supplier is a string with no record
       * behind it, and this finds the contact of the same name — two suppliers
       * can share a name and a contact's address can be old, so it is typed over
       * freely. Null when nobody of that name is on file, which is the ordinary
       * case for a distributor nobody has entered.
       */
      partyEmail: (name: string): Promise<{ email: string | null }> =>
        ipcRenderer.invoke(IPC.orderPartyEmail, name),

      /**
       * The mail account labels are sent from.
       *
       * The password NEVER comes back — `hasPassword` says whether one is
       * stored, and saving with the box blank keeps it. A form that had to be
       * drawn with a password in it would be putting one in a browser tab's
       * memory for no reason.
       */
      emailSettings: (): Promise<RedactedEmailSettings | null> =>
        ipcRenderer.invoke(IPC.emailSettingsGet),
      saveEmailSettings: (
        input: Partial<EmailSettings>
      ): Promise<Result<RedactedEmailSettings>> => ipcRenderer.invoke(IPC.emailSettingsSave, input),
      clearEmailSettings: (): Promise<Result<{ cleared: true }>> =>
        ipcRenderer.invoke(IPC.emailSettingsClear),
      /** Prove it works NOW, rather than when a supplier is waiting for a label. */
      verifyEmailSettings: (): Promise<Result<{ ok: true }>> =>
        ipcRenderer.invoke(IPC.emailSettingsVerify)
    },

    invoices: {
      list: (): Promise<Invoice[]> => ipcRenderer.invoke(IPC.invoicesList),
      get: (id: string): Promise<InvoiceDetail | null> => ipcRenderer.invoke(IPC.invoiceGet, id),
      stats: (): Promise<{
        draft: number
        created: number
        sent: number
        paid: number
        /** What is still owed us, in every stage. See invoiceIsOwed. */
        outstanding: number
        /** How many orders that figure is spread across. */
        owedCount: number
        paidTotal: number
        thisMonth: number
      }> => ipcRenderer.invoke(IPC.invoiceStats),
      nextNumber: (): Promise<string> => ipcRenderer.invoke(IPC.invoiceNextNumber),
      /** Where all three document series start. Empty when not an admin. */
      numbering: (): Promise<SeriesState[]> => ipcRenderer.invoke(IPC.numberingRead),
      /** Move one series forward. `start` is the NEXT number to issue. */
      setNumberingStart: (
        series: NumberSeries,
        start: number
      ): Promise<Result<SeriesState[]>> =>
        ipcRenderer.invoke(IPC.numberingSetStart, { series, start }),

      /**
       * What a hard reset would delete. Null when the caller may not ask.
       *
       * A separate read from the apply on purpose: the confirmation shows this,
       * and a screen that guessed at the numbers would be asking somebody to
       * approve a figure the delete does not use.
       */
      orderResetPreview: (): Promise<OrderResetPreview | null> =>
        ipcRenderer.invoke(IPC.orderResetPreview),

      /** Every order and every deal ticket, gone. See @shared/orderReset. */
      orderResetApply: (input: OrderResetInput): Promise<Result<OrderResetResult>> =>
        ipcRenderer.invoke(IPC.orderResetApply, input),
      save: (input: NewInvoice & { id?: string | null }): Promise<Result<InvoiceDetail>> =>
        ipcRenderer.invoke(IPC.invoiceSave, input),
      /**
       * Delete an invoice. Always locally; in QuickBooks when it allows it.
       *
       * `removedFromQbo` and `qboError` are BOTH returned because the outcome
       * genuinely varies — QuickBooks refuses to delete an invoice that has a
       * payment applied — and a screen that says only "deleted" would leave
       * somebody believing their books are clear when one is still on them.
       */
      remove: (
        id: string
      ): Promise<Result<{ id: string; removedFromQbo: boolean; qboError: string | null }>> =>
        ipcRenderer.invoke(IPC.invoiceDelete, id),
      setStatus: (id: string, status: InvoiceStatus): Promise<Result<{ id: string }>> =>
        ipcRenderer.invoke(IPC.invoiceSetStatus, { id, status }),

      /** Buyers. Saving by name merges rather than duplicating — see saveCustomer. */
      customers: (): Promise<InvoiceCustomer[]> => ipcRenderer.invoke(IPC.invoiceCustomersList),
      saveCustomer: (input: {
        id?: string | null
        name: string
        email?: string | null
        /** Omit BOTH to leave stored numbers alone; pass either as null to clear. */
        phone?: string | null
        mobile?: string | null
        terms?: InvoiceTerms
        location?: string | null
        className?: string | null
        message?: string | null
        notes?: string | null
        /** Bill-to. Omit entirely to leave a stored address alone — see saveCustomer. */
        billAddr?: InvoiceAddress | null
        qboId?: string | null
      }): Promise<Result<InvoiceCustomer>> => ipcRenderer.invoke(IPC.invoiceCustomerSave, input),
      /**
       * Remove a buyer — three outcomes, and the caller has to say which.
       *
       * `deleted` false with `keptAsVendor` false means they had invoices and
       * were retired instead. `keptAsVendor` true means the record survives
       * because it is also in the vendor directory and deleting it would take a
       * supplier's address away from a screen this gesture never mentioned.
       */
      deleteCustomer: (id: string): Promise<Result<{ deleted: boolean; keptAsVendor: boolean }>> =>
        ipcRenderer.invoke(IPC.invoiceCustomerDelete, id),

      /**
       * Load the QuickBooks Customer Contact List off the operator's own disk.
       *
       * Read as BYTES for both formats. A .xlsx has no choice, and taking the
       * same route for a .csv means the format is worked out once, from the
       * file's first two bytes, rather than differently on each of the two
       * transports.
       *
       * Safe to run twice: buyers are matched on the QuickBooks display name and
       * every field merges, so a repeat import of the same file writes nothing.
       */
      importContacts: async (): Promise<Result<ContactImportResult>> => {
        if (!ipcRenderer.pickFile) return ipcRenderer.invoke(IPC.invoiceContactsImport)
        const upload = await ipcRenderer.pickFile({ accept: '.xlsx,.csv,.tsv,.txt', as: 'bytes' })
        if (!upload) return { ok: false, error: 'No file selected.' }
        return ipcRenderer.invoke(IPC.invoiceContactsImport, upload)
      },

      /** Intuit's own import template on disk. Works with no connection at all. */
      exportCsv: (ids?: string[]): Promise<ExportResult> =>
        ipcRenderer.invoke(IPC.invoiceExportCsv, ids ?? []),

      /** The live lists behind the buyer and item pickers. Read-only. */
      qboCustomers: (): Promise<
        Result<
          Array<{
            id: string
            name: string
            email: string | null
            billAddr: InvoiceAddress | null
          }>
        >
      > => ipcRenderer.invoke(IPC.invoiceQboCustomers),
      qboItems: (): Promise<
        Result<
          Array<{
            id: string
            name: string
            rate: number | null
            description: string | null
            /** Item.Sku. There is no SKU field on an invoice LINE — see @shared/invoices. */
            sku: string | null
          }>
        >
      > => ipcRenderer.invoke(IPC.invoiceQboItems),

      /**
       * Would QuickBooks take this, as typed? Two reads, nothing written.
       *
       * Takes the form's CURRENT contents rather than a saved id, because the
       * answer is wanted while somebody can still act on it — which is before
       * there is anything on disk to refer to.
       */
      qboPreflight: (input: {
        customerName: string
        lines: Array<{ item: string; sku: string | null }>
      }): Promise<Result<QboInvoicePreflight>> =>
        ipcRenderer.invoke(IPC.invoiceQboPreflight, input),

      /**
       * Add the missing Product/Service to QuickBooks. A WRITE to real books,
       * and always its own press — never a hidden step inside a send.
       */
      qboCreateItem: (input: {
        name: string
        sku?: string | null
        rate?: number | null
        description?: string | null
      }): Promise<
        Result<{
          id: string
          name: string
          sku: string | null
          /**
           * Named only when THIS press settled which Income account the item's
           * sales post to — see createQboItem. Null every press after, because
           * the mapping then has one.
           */
          incomeAccountChosen?: string | null
        }>
      > => ipcRenderer.invoke(IPC.invoiceQboCreateItem, input),

      /**
       * Give an existing QuickBooks item the SKU we hold for it.
       *
       * There is no SKU field on an invoice LINE — the SKU printed on a
       * QuickBooks invoice is the ITEM's — so this is what actually gets our SKU
       * onto their document. Only offered when theirs is blank.
       */
      qboSetItemSku: (
        itemId: string,
        sku: string
      ): Promise<Result<{ id: string; name: string; sku: string | null }>> =>
        ipcRenderer.invoke(IPC.invoiceQboSetItemSku, { itemId, sku }),

      /** Add the missing buyer. Same rule: explicit, never a side effect. */
      qboCreateCustomer: (input: {
        name: string
        email?: string | null
      }): Promise<Result<{ id: string; name: string }>> =>
        ipcRenderer.invoke(IPC.invoiceQboCreateCustomer, input),

      /**
       * Save it and put it in QuickBooks, in that order — the everyday gesture.
       *
       * A refused push still resolves `ok: true`, with `pushed: false` and a
       * sentence in `error`. That is not sloppiness: the SAVE succeeded, the
       * invoice is on disk, and only the push has to be tried again. Treat this
       * as a failed save and you throw away a document somebody just typed
       * because Intuit was having an afternoon.
       */
      saveAndPush: (
        input: NewInvoice & { id?: string | null; open?: boolean }
      ): Promise<Result<InvoicePushResult>> => ipcRenderer.invoke(IPC.invoiceSaveAndPush, input),

      /** Try a push that failed. Same guards, same result shape. */
      retryQboPush: (id: string, open = false): Promise<Result<InvoicePushResult>> =>
        ipcRenderer.invoke(IPC.invoiceRetryQboPush, { id, open }),

      /** The ones that tried and did not make it. A LOCAL read — no connection. */
      qboPending: (): Promise<Invoice[]> => ipcRenderer.invoke(IPC.invoiceQboPending),

      /**
       * Money that arrived BEFORE anything shipped, and — usually — the release
       * of the order to the packing floor.
       *
       * Payment and readiness are separate facts, the same way they are on the
       * buy side: `setPurchaseOrderPaid` records money without moving a purchase
       * order's stage, precisely so a received-but-unpaid order is not dragged
       * backwards to say the money arrived. `payment.markPaid` and
       * `payment.readyToShip` are what let a caller ask for one without the
       * other — a deposit against a bigger order is payment and not readiness; a
       * trusted buyer on terms is readiness and no payment at all.
       */
      payUpFront: (id: string, payment: InvoicePaymentInput): Promise<Result<InvoiceDetail>> =>
        ipcRenderer.invoke(IPC.invoicePayUpFront, { id, payment }),

      /** Say whether the money arrived. Does NOT move the order — see setInvoicePaid. */
      setPaid: (id: string, paid: boolean): Promise<Result<InvoiceDetail>> =>
        ipcRenderer.invoke(IPC.invoiceSetPaid, { id, paid }),

      /** Put an order on the packing list, or take it back off. */
      setReady: (id: string, ready: boolean): Promise<Result<InvoiceDetail>> =>
        ipcRenderer.invoke(IPC.invoiceSetReady, { id, ready }),

      /** Everything waiting to be picked, oldest first — it is a queue. */
      awaitingShipment: (): Promise<InvoiceDetail[]> =>
        ipcRenderer.invoke(IPC.invoicesAwaitingShipment),

      /**
       * The fulfilment board, in ONE read.
       *
       * Which column an order belongs in is derived rather than stored — see
       * fulfillmentStageOf — so the board asks for everything live and sorts it
       * on the client. Three reads, one per column, would be three chances for
       * the SQL to disagree with the rule the cards are labelled by.
       */
      fulfillment: (): Promise<InvoiceDetail[]> => ipcRenderer.invoke(IPC.invoicesFulfillment),

      /** Weigh and measure the box. All four together, or all four cleared. */
      setDims: (
        id: string,
        dims: {
          weightLb: number | null
          lengthIn: number | null
          widthIn: number | null
          heightIn: number | null
        }
      ): Promise<Result<InvoiceDetail>> => ipcRenderer.invoke(IPC.invoiceSetDims, { id, ...dims }),

      /** Confirm the goods are in hand — the only signal a dropship has. */
      setItemsInHand: (id: string, inHand: boolean): Promise<Result<InvoiceDetail>> =>
        ipcRenderer.invoke(IPC.invoiceSetItemsInHand, { id, inHand }),
      /**
       * Where a POSTED sale's lines are fulfilled from — our shelf, or a
       * supplier shipping direct. See setInvoiceLineRouting.
       *
       * Not part of save, and that is the point: save rewrites every column and
       * is refused once a document is on the books. This writes three columns on
       * the lines named and re-derives the stock, so it changes nothing anybody
       * was billed and never speaks to Intuit.
       */
      setLineRouting: (
        id: string,
        changes: Array<{
          lineId: string
          destination: string | null
          supplier: string | null
          /** Omit to leave it; null to clear it. See setInvoiceLineRouting. */
          sourcePoId?: string | null
          /**
           * The line SPLIT BY QUANTITY, so each case can come from its own
           * place. Omit to leave the splits alone; an empty array collapses the
           * line back to one answer. See @shared/invoiceAllocations.
           */
          allocations?: InvoiceAllocationInput[]
        }>
      ): Promise<Result<InvoiceDetail>> =>
        ipcRenderer.invoke(IPC.invoiceSetLineRouting, { id, changes }),

      /**
       * Edit the LINES of a POSTED sale — quantity and money. See
       * setInvoiceLines.
       *
       * Writes a quantity, a rate and an amount on the lines named, re-derives
       * the order's stock and the header total, and cannot reach QuickBooks —
       * that copy is corrected there by hand, and the card shows the gap until
       * somebody does.
       *
       * Every field is optional and absence means "leave it": sending a rate
       * alone lets the amount follow it, which is the ordinary case, and
       * sending an amount alone corrects a line agreed at something other than
       * quantity × rate. `splitInto` replaces the line with several real lines,
       * each with its own quantity and price — two prices for one product is
       * two lines on any invoice ever written. `remove` takes a line off, so a
       * split made by mistake has a way back.
       */
      setLines: (
        id: string,
        changes: Array<{
          lineId: string
          quantity?: number
          rate?: number | null
          amount?: number | null
          splitInto?: Array<{ quantity: number; rate: number; amount?: number | null }>
          remove?: boolean
        }>
      ): Promise<Result<InvoiceDetail>> => ipcRenderer.invoke(IPC.invoiceSetLines, { id, changes }),

      /**
       * What POSTING this sale cost us, corrected after it has gone out.
       *
       * The mirror of the freight box on a purchase order, with one difference
       * that decides everything about it: on a SALE this is a cost we carry,
       * not a charge to the buyer. It stays out of the order total and never
       * reaches QuickBooks, so unlike setLines it cannot make our copy of a
       * posted document disagree with Intuit's — and it is editable long after
       * the invoice form has closed, because postage is bought when the parcel
       * goes.
       *
       * `null` clears it back to "nobody has said", which is not zero: with
       * nothing typed, `orderShippingCost` answers from the parcel labels
       * instead. Refused on a void order.
       */
      setShippingCost: (id: string, shippingCost: number | null): Promise<Result<InvoiceDetail>> =>
        ipcRenderer.invoke(IPC.invoiceSetShippingCost, { id, shippingCost }),

      /** Send it anyway, ahead of the gates. Recorded as its own decision. */
      setForceReady: (id: string, forced: boolean): Promise<Result<InvoiceDetail>> =>
        ipcRenderer.invoke(IPC.invoiceSetForceReady, { id, forced }),

      /**
       * Ask QuickBooks where these have got to, and move the cards it can
       * justify moving.
       *
       * Only three of the five states the owner named are in that API. Sent,
       * paid and open are real; VIEWED BY THE PAYER and PAYOUT SENT are not
       * exposed by the Accounting API at all and are deliberately not faked —
       * see @shared/invoices for the full accounting.
       *
       * Omit the id to sweep every posted invoice QUICKBOOKS has not called
       * finished — a zero balance or a void. Deliberately not "not already
       * settled" in this app's sense: an invoice sitting in Paid on this board while
       * Intuit still shows money owing is the one most worth asking about, and
       * treating the tick as the answer is what once froze a card's payment bar
       * at the balance it had before anybody paid.
       *
       * `updated` counts answers that changed a figure a person can see, which
       * is not the same as `moved` — a card already in Paid does not change
       * column when the money finally lands, but its rail does fill in.
       */
      syncQboStatus: (
        id?: string
      ): Promise<
        Result<{
          checked: number
          missing: number
          updated: number
          moved: Array<{ id: string; from: InvoiceStatus; to: InvoiceStatus }>
        }>
      > => ipcRenderer.invoke(IPC.invoiceSyncQboStatus, { id: id ?? '' }),

      /**
       * Which open orders could be bound to a QuickBooks invoice by number.
       *
       * READ ONLY — it decides nothing and writes nothing. What comes back is a
       * list of proposals with both sides' figures on them, plus the near
       * misses and why they missed, for a screen to show before anybody agrees
       * to anything.
       */
      qboMatchScan: (): Promise<Result<InvoiceMatchScan>> =>
        ipcRenderer.invoke(IPC.invoiceQboMatchScan),

      /**
       * Bind these exact pairs. The write half, and it takes only pairs
       * somebody has actually looked at — every one is re-checked against
       * QuickBooks before it is written, because a scan is a snapshot and the
       * books move underneath it.
       */
      qboMatchAdopt: (
        pairs: Array<{ invoiceId: string; qboId: string }>
      ): Promise<Result<{ adopted: number; refused: Array<{ invoiceId: string; why: string }> }>> =>
        ipcRenderer.invoke(IPC.invoiceQboMatchAdopt, { pairs }),

      /** Post it, then open the browser on it so somebody can press Send. */
      createInQbo: (
        id: string,
        open = true
      ): Promise<
        Result<{
          url: string
          docNumber: string | null
          numberChanged: boolean
          /** Wanted but not resolved — a missing class, an unknown term, a SKU clash. */
          notes: string[]
        }>
      > => ipcRenderer.invoke(IPC.invoiceCreateInQbo, { id, open }),
      sendFromQbo: (id: string): Promise<Result<{ id: string }>> =>
        ipcRenderer.invoke(IPC.invoiceSendFromQbo, id),
      /** Record the payment in QuickBooks for an invoice paid here. */
      recordQboPayment: (
        id: string
      ): Promise<Result<{ id: string; posted: boolean; message: string }>> =>
        ipcRenderer.invoke(IPC.invoiceRecordQboPayment, id),
      /**
       * The standing payment instructions, and whether QuickBooks emails each
       * invoice as it is posted. Machine-local — see the store.
       */
      getDelivery: (): Promise<Result<InvoiceDelivery>> =>
        ipcRenderer.invoke(IPC.invoiceDeliveryGet),
      setDelivery: (input: InvoiceDelivery): Promise<Result<InvoiceDelivery>> =>
        ipcRenderer.invoke(IPC.invoiceDeliverySet, input),
      openInQbo: (id: string): Promise<Result<{ url: string }>> =>
        ipcRenderer.invoke(IPC.invoiceOpenInQbo, id),

      /**
       * The invoice as a document a BUYER reads — the only artefact in this
       * module meant for a person rather than for QuickBooks.
       */
      openPdf: (id: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
        ipcRenderer.invoke(IPC.invoiceOpenPdf, id),
      savePdf: (
        id: string
      ): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> =>
        ipcRenderer.invoke(IPC.invoiceSavePdf, id)
    },
    updates: {
      getStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.updatesGetStatus),
      check: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.updatesCheck),
      download: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.updatesDownload),
      install: (): Promise<Result> => ipcRenderer.invoke(IPC.updatesInstall),
      openDownload: (url?: string): Promise<Result> =>
        ipcRenderer.invoke(IPC.updatesOpenDownload, url),
      onStatus: (callback: (status: UpdateStatus) => void): (() => void) => {
        const listener = (_e: unknown, status: UpdateStatus): void => callback(status)
        ipcRenderer.on(IPC.updatesStatusEvent, listener)
        return () => ipcRenderer.removeListener(IPC.updatesStatusEvent, listener)
      }
    }
  }
  return api
}

/** The shape every screen programs against, on either transport. */
export type RmOpsApi = ReturnType<typeof createBridge>
