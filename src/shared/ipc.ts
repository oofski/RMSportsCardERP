/**
 * Central registry of IPC channel names. Both the preload bridge and the main
 * process import from here so the two sides can never drift apart.
 */
export const IPC = {
  // Auth
  authSetupState: 'auth:setup-state',
  authCreateOwner: 'auth:create-owner',
  authLogin: 'auth:login',
  authLogout: 'auth:logout',
  authCurrent: 'auth:current',
  authChangePassword: 'auth:change-password',

  // Employees
  employeesList: 'employees:list',
  employeesCreate: 'employees:create',
  employeesUpdate: 'employees:update',
  employeesResetPassword: 'employees:reset-password',
  employeesSetPermissions: 'employees:set-permissions',
  employeesSetAvatar: 'employees:set-avatar',
  employeesRemoveAvatar: 'employees:remove-avatar',

  // Hours
  hoursSummary: 'hours:summary',
  hoursList: 'hours:list',
  hoursCreate: 'hours:create',
  hoursDelete: 'hours:delete',
  hoursTimesheet: 'hours:timesheet',
  hoursExport: 'hours:export',

  // Time clock (self-service)
  clockStatus: 'clock:status',
  clockIn: 'clock:in',
  clockOut: 'clock:out',

  // Remembered credentials (pre-login)
  credGet: 'credentials:get',
  credSet: 'credentials:set',
  credClear: 'credentials:clear',

  // Theme
  themeSet: 'theme:set',

  // Inventory
  invProductsList: 'inventory:products:list',
  invCatalogSearch: 'inventory:catalog:search',
  invProductCreate: 'inventory:products:create',
  invProductUpdate: 'inventory:products:update',
  invProductDelete: 'inventory:products:delete',
  invSaleRecord: 'inventory:sale:record',
  invStockAdd: 'inventory:stock:add',
  invStockAdjust: 'inventory:stock:adjust',
  invStats: 'inventory:stats',
  invCategories: 'inventory:categories',
  invByCategory: 'inventory:by-category',
  invRecentSales: 'inventory:sales:recent',
  invTransactions: 'inventory:transactions:list',
  invSalesSeries: 'inventory:sales:series',
  invThumbnails: 'inventory:images:thumbnails',
  invImageList: 'inventory:images:list',
  invImageAdd: 'inventory:images:add',
  invImageRemove: 'inventory:images:remove',
  invIncomingList: 'inventory:incoming:list',
  invIncomingAdd: 'inventory:incoming:add',
  invIncomingReceive: 'inventory:incoming:receive',
  invIncomingCancel: 'inventory:incoming:cancel',
  invPricingList: 'inventory:pricing:list',
  invHighBidUpdate: 'inventory:pricing:high-bid',
  invProductLots: 'inventory:product:lots',
  // UPC scanning. resolve/history are reads; commit/log-miss/undo write stock.
  invScanResolve: 'inventory:scan:resolve',
  invScanCommit: 'inventory:scan:commit',
  invScanLogMiss: 'inventory:scan:log-miss',
  invScanHistory: 'inventory:scan:history',
  invScanUndo: 'inventory:scan:undo',

  // Supplies (operating consumables)
  suppliesList: 'supplies:list',
  suppliesStats: 'supplies:stats',
  supplyCreate: 'supplies:create',
  supplyUpdate: 'supplies:update',
  supplyDelete: 'supplies:delete',
  supplyPurchase: 'supplies:purchase',
  supplyUse: 'supplies:use',
  supplyAdjust: 'supplies:adjust',
  supplySetImage: 'supplies:set-image',
  supplyRemoveImage: 'supplies:remove-image',
  supplyOrdersList: 'supplies:orders:list',
  supplyOrderCreate: 'supplies:orders:create',
  supplyOrderSetStatus: 'supplies:orders:set-status',
  supplyOrderDelete: 'supplies:orders:delete',

  // Purchase orders
  poList: 'po:list',
  poGet: 'po:get',
  poCreate: 'po:create',
  poSetStatus: 'po:set-status',
  poCatalogSearch: 'po:catalog-search',
  poThumbnails: 'po:thumbnails',
  poIncomingBoxes: 'po:incoming-boxes',
  poScanIn: 'po:scan-in',
  poCogsList: 'po:cogs-list',
  poDelete: 'po:delete',
  poForceDelete: 'po:forceDelete',
  // Render the PO as a standalone PDF document (not a screen print).
  poOpenPdf: 'po:pdf:open',
  poSavePdf: 'po:pdf:save',

  // Shipping (RM Cardz Shipping Workspace)
  // Reads are gated by 'module.fulfillment'; every write by 'shipping.manage'.
  shipSummary: 'shipping:summary',
  shipEvent: 'shipping:event',
  shipSetEvent: 'shipping:event:set',
  shipWarnings: 'shipping:warnings',
  shipAudit: 'shipping:audit',
  shipCustomers: 'shipping:customers',
  // Parse runs as a background job — startParse returns a jobId immediately.
  shipParseStart: 'shipping:parse:start',
  shipParseJob: 'shipping:parse:job',
  shipParseEvent: 'shipping:parse:event',
  shipDatasetClear: 'shipping:dataset:clear',
  // Orders
  shipOrdersList: 'shipping:orders:list',
  shipOrderGet: 'shipping:orders:get',
  shipOrderStage: 'shipping:orders:stage',
  shipOrderHold: 'shipping:orders:hold',
  shipOrderMove: 'shipping:orders:move',
  shipOrderSpecialRequest: 'shipping:orders:special-request',
  shipOrderNotes: 'shipping:orders:notes',
  shipOrdersResetQueue: 'shipping:orders:reset-queue',
  // Checker
  shipBreaksList: 'shipping:breaks:list',
  shipBreakGet: 'shipping:breaks:get',
  shipBreakPack: 'shipping:breaks:pack',
  shipBreakClear: 'shipping:breaks:clear',
  shipBreakSleeveAll: 'shipping:breaks:sleeve-all',
  shipBreakCheckAll: 'shipping:breaks:check-all',
  shipBreakSetStatus: 'shipping:breaks:set-status',
  shipSlotChecked: 'shipping:teamslot:checked',
  shipSlotTopSleeved: 'shipping:teamslot:top-sleeved',
  // Shipping tracker
  shipShipmentsList: 'shipping:shipments:list',
  shipShipmentStatus: 'shipping:shipments:status',
  shipShipmentNotes: 'shipping:shipments:notes',
  shipShipmentBulkStatus: 'shipping:shipments:bulk-status',
  shipBatchUrls: 'shipping:shipments:batch-urls',
  shipTrackingNumbers: 'shipping:shipments:tracking-numbers',
  shipOpenTracking: 'shipping:tracking:open',
  shipOpenBatch: 'shipping:tracking:open-batch',
  // Break assignments (v17) — who is sorting which break. Writes need
  // 'shipping.manage'; the Checker's read only needs 'module.fulfillment'.
  shipAssignmentsList: 'shipping:assignments:list',
  shipAssignmentBoard: 'shipping:assignments:board',
  shipAssign: 'shipping:assignments:assign',
  shipUnassign: 'shipping:assignments:unassign',
  // Sales / ledger
  shipSales: 'shipping:sales',
  shipLedger: 'shipping:ledger',
  // History
  shipCalendar: 'shipping:calendar',
  shipCalendarDay: 'shipping:calendar:day',
  shipImportsList: 'shipping:imports:list',
  shipImportRename: 'shipping:imports:rename',
  shipImportDelete: 'shipping:imports:delete',
  shipSnapshotsList: 'shipping:snapshots:list',
  shipSnapshotGet: 'shipping:snapshots:get',
  shipSnapshotCreate: 'shipping:snapshots:create',
  shipSnapshotRename: 'shipping:snapshots:rename',
  shipSnapshotDelete: 'shipping:snapshots:delete',
  shipExport: 'shipping:export',
  // Settings
  shipSettingsGet: 'shipping:settings:get',
  shipSettingsPatch: 'shipping:settings:patch',

  // QuickBooks Online (admin.access only; the client secret is write-only)
  qboStatus: 'qbo:status',
  qboSaveConfig: 'qbo:config:save',
  qboConnect: 'qbo:connect',
  qboDisconnect: 'qbo:disconnect',
  qboForget: 'qbo:forget',
  qboTest: 'qbo:test',
  // Diagnostics + the manual (OAuth Playground) token path.
  qboAuthorizeUrl: 'qbo:authorize-url',
  qboPasteTokens: 'qbo:tokens:paste',
  // Chart of accounts + the account mapping that posting will use. All reads;
  // nothing here can change the operator's books.
  qboAccounts: 'qbo:accounts',
  qboMappingGet: 'qbo:mapping:get',
  qboMappingSave: 'qbo:mapping:save',
  qboSyncLog: 'qbo:sync-log',

  // Streaming — live show sessions, breaks and giveaways
  streamActive: 'stream:active',
  streamCalendar: 'stream:calendar',
  streamList: 'stream:list',
  streamGet: 'stream:get',
  streamStart: 'stream:start',
  streamEnd: 'stream:end',
  streamCreate: 'stream:create',
  streamUpdate: 'stream:update',
  streamDelete: 'stream:delete',
  streamItemAdd: 'stream:item:add',
  streamItemRemove: 'stream:item:remove',

  // Finance — Streaming tab (Whatnot ledger import + day-by-day revenue)
  finStreamView: 'finance:stream:view',
  finLedgerImport: 'finance:ledger:import',
  finLedgerImports: 'finance:ledger:imports',
  finLedgerDeleteImport: 'finance:ledger:import:delete',
  finLedgerImportImpact: 'finance:ledger:import:impact',
  finLedgerRows: 'finance:ledger:rows',
  finLedgerReattribute: 'finance:ledger:reattribute',

  // Email
  emailComposeInvite: 'email:compose-invite',
  emailOpenExternal: 'email:open-external',

  // Updates
  updatesCheck: 'updates:check',
  updatesDownload: 'updates:download',
  updatesInstall: 'updates:install',
  updatesOpenDownload: 'updates:open-download',
  updatesGetStatus: 'updates:get-status',
  updatesStatusEvent: 'updates:status-event',

  // App meta
  appInfo: 'app:info'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

export interface AppInfo {
  name: string
  version: string
  platform: NodeJS.Platform
  isPackaged: boolean
}
