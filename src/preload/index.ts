import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type AppInfo } from '@shared/ipc'
import type { Permission } from '@shared/permissions'
import type {
  ParsedSheet,
  ResetApplyResult,
  ResetField,
  ResetOptions,
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
  ThemeMode,
  TimeEntry,
  UpdateEmployeeInput,
  UpdateInventoryProduct,
  UpdateSupply,
  UpdateStatus
} from '@shared/types'
import type {
  ShipBatchUrl,
  ShipBreakAudit,
  ShipBreakStatus,
  ShipEvent,
  ShipImportRecord,
  ShipSnapshot,
  ShipSnapshotSummary,
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
  ShipFulfillmentStage,
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
  StreamCalendarMonth,
  StreamSession,
  StreamSessionDetail,
  UpdateStreamSession
} from '@shared/streaming'
import type {
  ImportDeleteImpact,
  LedgerImport,
  LedgerImportResult,
  LedgerRow,
  StreamingFinanceView
} from '@shared/financeStreaming'

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
    setAvatar: (id: string): Promise<Result<Employee>> =>
      ipcRenderer.invoke(IPC.employeesSetAvatar, id),
    removeAvatar: (id: string): Promise<Result<Employee>> =>
      ipcRenderer.invoke(IPC.employeesRemoveAvatar, id)
  },
  hours: {
    summary: (): Promise<EmployeeHoursSummary[]> => ipcRenderer.invoke(IPC.hoursSummary),
    list: (employeeId?: string): Promise<TimeEntry[]> =>
      ipcRenderer.invoke(IPC.hoursList, employeeId),
    create: (input: NewTimeEntryInput): Promise<Result<TimeEntry>> =>
      ipcRenderer.invoke(IPC.hoursCreate, input),
    delete: (id: string): Promise<Result> => ipcRenderer.invoke(IPC.hoursDelete, { id }),
    timesheet: (employeeId: string, start: string, end: string): Promise<TimeEntry[]> =>
      ipcRenderer.invoke(IPC.hoursTimesheet, { employeeId, start, end }),
    export: (req: ExportRequest): Promise<ExportResult> => ipcRenderer.invoke(IPC.hoursExport, req)
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
  theme: {
    set: (mode: ThemeMode): Promise<Result> => ipcRenderer.invoke(IPC.themeSet, mode)
  },
  inventory: {
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
    recordSale: (input: RecordSaleInput): Promise<Result<InventoryProduct>> =>
      ipcRenderer.invoke(IPC.invSaleRecord, input),
    thumbnails: (): Promise<Record<string, string>> => ipcRenderer.invoke(IPC.invThumbnails),
    listImages: (productId: string): Promise<ProductImage[]> =>
      ipcRenderer.invoke(IPC.invImageList, productId),
    addImage: (productId: string): Promise<Result<ProductImage[]>> =>
      ipcRenderer.invoke(IPC.invImageAdd, productId),
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
    productLots: (productId: string): Promise<ProductLot[]> =>
      ipcRenderer.invoke(IPC.invProductLots, productId),
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
      options?: Partial<ResetOptions>
      defaultLocation?: string
    }): Promise<{ sheet: ParsedSheet; plan: ResetPlan; guessed: boolean } | null> =>
      ipcRenderer.invoke(IPC.invResetPreview, input),
    resetPickFile: (): Promise<Result<{ text: string; filename: string }>> =>
      ipcRenderer.invoke(IPC.invResetPickFile),
    resetApply: (input: {
      text: string
      mapping: ResetField[]
      options?: Partial<ResetOptions>
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
    setImage: (id: string): Promise<Result<Supply>> =>
      ipcRenderer.invoke(IPC.supplySetImage, { id }),
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
      environment: QboEnvironment
    ): Promise<Result<QboStatus>> =>
      ipcRenderer.invoke(IPC.qboSaveConfig, { clientId, clientSecret, environment }),
    connect: (): Promise<Result<QboStatus>> => ipcRenderer.invoke(IPC.qboConnect),
    disconnect: (): Promise<Result<QboStatus>> => ipcRenderer.invoke(IPC.qboDisconnect),
    forget: (): Promise<Result<QboStatus>> => ipcRenderer.invoke(IPC.qboForget),
    test: (): Promise<Result<{ companyName: string; realmId: string }>> =>
      ipcRenderer.invoke(IPC.qboTest),
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

  purchaseOrders: {
    list: (): Promise<PurchaseOrder[]> => ipcRenderer.invoke(IPC.poList),
    get: (id: string): Promise<PurchaseOrderDetail | null> =>
      ipcRenderer.invoke(IPC.poGet, id),
    create: (input: NewPurchaseOrder): Promise<Result<PurchaseOrderDetail>> =>
      ipcRenderer.invoke(IPC.poCreate, input),
    setStatus: (id: string, status: PurchaseOrderStatus): Promise<Result<PurchaseOrderDetail>> =>
      ipcRenderer.invoke(IPC.poSetStatus, { id, status }),
    searchCatalog: (query: string): Promise<InventoryProduct[]> =>
      ipcRenderer.invoke(IPC.poCatalogSearch, query),
    thumbnails: (): Promise<Record<string, string>> => ipcRenderer.invoke(IPC.poThumbnails),
    incomingBoxes: (): Promise<PurchaseOrderDetail[]> => ipcRenderer.invoke(IPC.poIncomingBoxes),
    scanIn: (id: string): Promise<Result<PurchaseOrderDetail>> =>
      ipcRenderer.invoke(IPC.poScanIn, { id }),
    cogsList: (): Promise<CogsEntry[]> => ipcRenderer.invoke(IPC.poCogsList),
    remove: (id: string): Promise<Result<null>> => ipcRenderer.invoke(IPC.poDelete, id),
    /** Delete a PO the ordinary path refuses. `removeStock` decides whether its
     *  received units come back out of inventory or stay on the shelf. */
    forceRemove: (
      id: string,
      removeStock: boolean
    ): Promise<Result<{ removedUnits: number; soldUnits: number }>> =>
      ipcRenderer.invoke(IPC.poForceDelete, { id, removeStock }),
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
    audit: (): Promise<ShipBreakAudit[]> => ipcRenderer.invoke(IPC.shipAudit),
    customers: (): Promise<ShipCustomerRow[]> => ipcRenderer.invoke(IPC.shipCustomers),
    clearDataset: (): Promise<Result<ShipWorkspaceSummary>> =>
      ipcRenderer.invoke(IPC.shipDatasetClear),

    // ---- Upload: the parse runs as a background job ------------------------
    /** Opens a PDF picker (unless `filePath` is given) and starts the job. */
    startParse: (request?: ShipParseRequest): Promise<Result<ShipParseStart>> =>
      ipcRenderer.invoke(IPC.shipParseStart, request ?? {}),
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
    setSlotChecked: (id: string, checked: boolean): Promise<Result<ShipSlotUpdate>> =>
      ipcRenderer.invoke(IPC.shipSlotChecked, { id, checked }),
    setSlotTopSleeved: (id: string, topSleeved: boolean): Promise<Result<ShipSlotUpdate>> =>
      ipcRenderer.invoke(IPC.shipSlotTopSleeved, { id, topSleeved }),
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
    deleteImport: (id: string): Promise<Result> => ipcRenderer.invoke(IPC.shipImportDelete, { id }),
    snapshots: (): Promise<ShipSnapshotSummary[]> => ipcRenderer.invoke(IPC.shipSnapshotsList),
    snapshot: (id: string): Promise<ShipSnapshot | null> =>
      ipcRenderer.invoke(IPC.shipSnapshotGet, id),
    createSnapshot: (name?: string): Promise<Result<ShipSnapshot>> =>
      ipcRenderer.invoke(IPC.shipSnapshotCreate, { name: name ?? '' }),
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
     * A refused conversion comes back as `Result.error` and is safe to show
     * verbatim: every one of those messages names the field to go and fill in
     * (boxes per case, packs per box, or the giveaway-item flag).
     */
    addItem: (input: NewStreamItem): Promise<Result<StreamSessionDetail>> =>
      ipcRenderer.invoke(IPC.streamItemAdd, input),
    /** Puts back exactly the cost layers the line took. */
    removeItem: (id: string): Promise<Result<StreamSessionDetail>> =>
      ipcRenderer.invoke(IPC.streamItemRemove, id)
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
    /** Opens a native file picker. Re-importing an overlapping week is safe:
     *  matched rows are skipped as duplicates, never counted twice. */
    importLedger: (): Promise<Result<LedgerImportResult>> =>
      ipcRenderer.invoke(IPC.finLedgerImport),
    imports: (): Promise<LedgerImport[]> => ipcRenderer.invoke(IPC.finLedgerImports),
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
    /** Re-runs attribution against the sessions as they are NOW. This is how
     *  unattributed money moves onto a show after the operator adds the session
     *  they forgot to log — data entry, never a heuristic. */
    reattribute: (): Promise<Result<StreamingFinanceView>> =>
      ipcRenderer.invoke(IPC.finLedgerReattribute)
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
    drift: (): Promise<Array<{ productId: string; location: string; stock: number; lots: number }>> =>
      ipcRenderer.invoke(IPC.syncDrift),
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

export type RmOpsApi = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('rmops', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore — fallback when context isolation is disabled
  window.rmops = api
}
