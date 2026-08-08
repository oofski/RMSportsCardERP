/**
 * Central registry of IPC channel names. Both the preload bridge and the main
 * process import from here so the two sides can never drift apart.
 */
/**
 * How raw BYTES cross the HTTP transport.
 *
 * Electron's IPC carries a Uint8Array as a Uint8Array — structured clone knows
 * what one is. JSON does not: `JSON.stringify(new Uint8Array([37,80]))` is
 * `{"0":37,"1":80}`, an object with numeric keys, and `new Uint8Array(...)` of
 * that object is ZERO BYTES LONG. So the packing slip crossed the wire as a
 * multi-megabyte object and arrived in the browser as an empty file — pdf.js
 * reporting "The PDF file is empty, i.e. its size is zero bytes" over a blank
 * sheet, on the web only, while the desktop was fine.
 *
 * The server tags binary on the way out and the transport untags it on the way
 * in. The tag lives here because it is the one thing both halves must agree on,
 * and this file is already where they agree on names.
 */
export const BYTES_TAG = '__rmops_bytes__'

/** The tagged form: `{ [BYTES_TAG]: '<base64>' }`. */
export interface TaggedBytes {
  [BYTES_TAG]: string
}

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
  employeesSetPortalPin: 'employees:set-portal-pin',
  employeesClearPortalPin: 'employees:clear-portal-pin',
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
  // Puts a cost basis on stock carried at nothing — a WRITE to the cost layers,
  // not just to the product row, which is why it is not `invProductUpdate`.
  invCostBasisFix: 'inventory:cost-basis:fix',
  invProductLots: 'inventory:product:lots',
  // UPC scanning. resolve/history are reads; commit/log-miss/undo write stock.
  invScanResolve: 'inventory:scan:resolve',
  invScanCommit: 'inventory:scan:commit',
  invScanLogMiss: 'inventory:scan:log-miss',
  invScanHistory: 'inventory:scan:history',
  invScanUndo: 'inventory:scan:undo',
  // Mass re-adjustment from a count sheet. preview/history/export are reads;
  // apply is the one write, and it is the whole run in a single transaction.
  invResetPreview: 'inventory:reset:preview',
  invResetPickFile: 'inventory:reset:pick-file',
  invResetApply: 'inventory:reset:apply',
  invResetHistory: 'inventory:reset:history',
  invResetRunDetail: 'inventory:reset:run-detail',
  invResetExport: 'inventory:reset:export',

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

  // Invoices — the SELL side, and the mirror image of a purchase order.
  // Everything here is gated on `module.invoicing`, the same permission that
  // raises a PO: somebody who may commit this business to paying a supplier may
  // also bill a buyer. The three qbo* channels are the only ones that leave the
  // machine, and `invoiceCreateInQbo` is the only one anywhere in this app that
  // WRITES to somebody's accounting system.
  invoiceCustomersList: 'invoices:customers:list',
  invoiceCustomerSave: 'invoices:customers:save',
  invoiceCustomerDelete: 'invoices:customers:delete',
  invoicesList: 'invoices:list',
  invoiceGet: 'invoices:get',
  invoiceStats: 'invoices:stats',
  invoiceNextNumber: 'invoices:next-number',
  invoiceSave: 'invoices:save',
  invoiceDelete: 'invoices:delete',
  invoiceSetStatus: 'invoices:set-status',
  invoiceExportCsv: 'invoices:export-csv',
  invoiceQboCustomers: 'invoices:qbo:customers',
  invoiceQboItems: 'invoices:qbo:items',
  invoiceCreateInQbo: 'invoices:qbo:create',
  invoiceSendFromQbo: 'invoices:qbo:send',
  invoiceOpenInQbo: 'invoices:qbo:open',

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
  shipWarningStatus: 'shipping:warning:status',
  shipAudit: 'shipping:audit',
  shipCustomers: 'shipping:customers',
  // Parse runs as a background job — startParse returns a jobId immediately.
  shipParseStart: 'shipping:parse:start',
  shipParseJob: 'shipping:parse:job',
  shipParseEvent: 'shipping:parse:event',
  shipDatasetClear: 'shipping:dataset:clear',
  // The uploaded PDF: metadata is cheap and always available; the bytes are
  // fetched once, only by a screen that is about to render them.
  // What tonight's show will consume in supplies. READ ONLY — nothing here
  // moves stock; see getSupplyPlan().
  shipSupplyPlan: 'shipping:supplies:plan',
  // The same plan with the supplies list behind it: cost, on-hand, shortfalls.
  shipSupplyPlanCosted: 'shipping:supplies:plan-costed',
  // Say which supply row plays a role in a show's arithmetic.
  supplySetShipRole: 'supplies:ship-role',
  // The floor: who is at this bench, and the pick -> pack handoff.
  shipStationBoard: 'shipping:station:board',
  shipStationStart: 'shipping:station:start',
  shipStationEnd: 'shipping:station:end',
  shipStationRoster: 'shipping:station:roster',
  shipStationClaim: 'shipping:station:claim',
  shipStationRelease: 'shipping:station:release',
  shipStationPickAdvance: 'shipping:station:pick-advance',
  shipStationPickNext: 'shipping:station:pick-next',
  shipStationPackNext: 'shipping:station:pack-next',
  shipStationPackDone: 'shipping:station:pack-done',
  shipStationSendBack: 'shipping:station:send-back',
  shipStationHeartbeat: 'shipping:station:heartbeat',
  // Per-card sleeve capture, split from the single old flag.
  shipSlotSleeve: 'shipping:teamslot:sleeve',
  // The owner's home board — every module's headline in one read.
  ownerBoard: 'owner:board',
  // The owner's inbox. Anyone signed in may WRITE one; only the owner reads.
  remindersList: 'reminders:list',
  remindersCreate: 'reminders:create',
  remindersSetStatus: 'reminders:set-status',
  remindersDelete: 'reminders:delete',
  // The other half of the home board: a person's own checklist. Every one of
  // these is scoped to the caller by the handler — there is no operation that
  // names whose list to touch.
  todosList: 'todos:list',
  todoCreate: 'todos:create',
  todoSetDone: 'todos:set-done',
  todoDelete: 'todos:delete',
  todosClearDone: 'todos:clear-done',
  // Jobs on a clock — payroll every second Wednesday and anything like it.
  // Scoped to the caller by the handler, exactly as the to-dos are.
  recurringList: 'recurring:list',
  recurringCreate: 'recurring:create',
  recurringComplete: 'recurring:complete',
  recurringDelete: 'recurring:delete',
  // The caller's OWN shifts. No permission beyond being signed in, and the
  // employee is taken from the session — a packer checking their own pay.
  myHours: 'hours:mine',
  // The floor's home board: what needs sorting, this fortnight's hours, and
  // their own next shifts. Assembled per caller like the owner's board is.
  staffBoard: 'staff:board',
  // The rota. `scheduleMine` is scoped to the session and gated on nothing but
  // being signed in; the rest are the lead's view and need admin.hours.view /
  // admin.employees.manage. There is deliberately no channel that reads one
  // NAMED person's shifts — that is the shape somebody forgets to gate.
  scheduleMine: 'schedule:mine',
  scheduleList: 'schedule:list',
  scheduleCreate: 'schedule:create',
  scheduleDelete: 'schedule:delete',
  scheduleCopyWeek: 'schedule:copy-week',
  // Availability — what somebody says about a day BEFORE anybody is put on it.
  // The write half is scoped to the session and gated on nothing else: saying
  // when you can and cannot work is not a privilege. Reading the TEAM's answers
  // is the lead's view and needs admin.hours.view, same as the rota beside it.
  availabilityMine: 'availability:mine',
  availabilityList: 'availability:list',
  availabilitySet: 'availability:set',
  availabilityClear: 'availability:clear',
  // The USUAL WEEK behind those answers — "I work Mondays, Wednesdays and
  // Fridays". The primary way somebody answers; a dated row is the exception.
  // `patternSet` replaces the whole week in one call, because that is the one
  // gesture somebody actually makes and a half-saved week reads as a real answer.
  patternMine: 'availability:pattern:mine',
  patternSet: 'availability:pattern:set',
  patternClear: 'availability:pattern:clear',
  // A lead's whole view of a week — everybody's usual week, who is rostered,
  // where the two disagree — in one read, so the four questions somebody asks
  // at once cannot be answered by four lists that disagree with each other.
  scheduleTeamOverview: 'schedule:team-overview',
  shipDocument: 'shipping:document',
  shipDocumentBytes: 'shipping:document:bytes',
  shipDocumentArrival: 'shipping:document:arrival',
  shipDocumentClear: 'shipping:document:clear',
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
  // Every card in ONE package at once — what "Next order" means.
  shipOrderCheckAll: 'shipping:orders:check-all',
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
  // The plan is a pure read: what a delete would destroy, priced, so the
  // confirmation can state it. The delete then refuses unless the caller says
  // it has agreed to the supplies going back on the shelf.
  shipImportDeletePlan: 'shipping:imports:delete-plan',
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
  // What a line turns out to have cost, entered after the fact. Records the
  // price for the statement; moves no stock and touches no cost layer.
  streamItemCost: 'stream:item:cost',

  // Finance — Streaming tab (Whatnot ledger import + day-by-day revenue)
  finStreamView: 'finance:stream:view',
  finLedgerImport: 'finance:ledger:import',
  finLedgerImports: 'finance:ledger:imports',
  finLedgerDeleteImport: 'finance:ledger:import:delete',
  finLedgerImportImpact: 'finance:ledger:import:impact',
  finLedgerRows: 'finance:ledger:rows',
  finLedgerReattribute: 'finance:ledger:reattribute',
  // The records behind ONE P&L line, over the range the tab is reporting on.
  // Read on click and never with the statement: most of a period's rows are
  // never opened, and a statement that fetched all of them would pay for a page
  // nobody asked for. See @shared/pnlDrill for the line-id → source contract.
  finPnlDetail: 'finance:pnl:detail',
  // What Whatnot's commission was, by date range. The fee is derived on read,
  // so saving one of these immediately re-prices every past show it covers.
  finRatesList: 'finance:rates:list',
  finRateSave: 'finance:rates:save',
  finRateDelete: 'finance:rates:delete',
  // Costs typed against a business day — product opened, given away or written
  // off. A dollar amount only: nothing here moves stock.
  finExpensesList: 'finance:expenses:list',
  finExpenseSave: 'finance:expenses:save',
  finExpenseDelete: 'finance:expenses:delete',

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

  // Cloud sync
  syncStatus: 'sync:status',
  syncConfigure: 'sync:configure',
  syncTest: 'sync:test',
  syncNow: 'sync:now',
  syncSeed: 'sync:seed',
  syncRejects: 'sync:rejects',
  syncClearRejects: 'sync:rejects:clear',
  syncDrift: 'sync:drift',
  syncRepairStock: 'sync:drift:repair',
  /** Push: the sync loop's own state changed (started, finished, failed). */
  syncStatusEvent: 'sync:status-event',
  /** Push: rows landed from another machine — screens showing them are stale. */
  syncChangedEvent: 'sync:changed-event',

  // Public intake form
  intakeLinks: 'intake:links',
  intakeLinkCreate: 'intake:link:create',
  intakeLinkSetActive: 'intake:link:set-active',
  intakeSubmissions: 'intake:submissions',
  intakeAccept: 'intake:accept',
  intakeReject: 'intake:reject',

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
