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
  // The cost-lot picker's one read: the open layers for a (product, location)
  // plus the average to judge them against. A READ — the choice it informs is
  // carried on the write that follows (addStock/adjustStock/recordSale/stream
  // addItem), never committed from here, so an abandoned dialog leaves nothing
  // behind.
  invLotOptions: 'inventory:lots:options',
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
  // The QuickBooks Customer Contact List, off the operator's own disk. It never
  // leaves the machine and there is deliberately no copy of it in this repo —
  // the list is 360 real people, and this repository is public.
  invoiceContactsImport: 'invoices:contacts:import',
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
  // Would QuickBooks take this invoice? Asked WHILE it is being written, so a
  // missing product is a thing to go and fix rather than a toast after the save.
  // Reads only — two queries, nothing written — which is what makes it safe to
  // run on every edit against live books.
  invoiceQboPreflight: 'invoices:qbo:preflight',
  // Add the missing product or buyer to QuickBooks. A SEPARATE press, never part
  // of a send: see the note above createQboItem for why posting an invoice must
  // never create things as a side effect.
  invoiceQboCreateItem: 'invoices:qbo:create-item',
  invoiceQboCreateCustomer: 'invoices:qbo:create-customer',
  // Give an existing QuickBooks item the SKU we hold for it. Offered only when
  // theirs is BLANK — see skuReconciliation for why a disagreement is a sentence
  // rather than a button.
  invoiceQboSetItemSku: 'invoices:qbo:set-item-sku',
  invoiceSendFromQbo: 'invoices:qbo:send',
  invoiceOpenInQbo: 'invoices:qbo:open',
  // Save it here, then put it in QuickBooks — one gesture, two steps, in that
  // order. The local write is committed BEFORE the network call, so a refused
  // push costs the push and never the invoice. `invoiceQboPending` is what the
  // ones that failed come back on, and `invoiceRetryQboPush` is how they are
  // tried again; without those a failure would be a silent drop.
  invoiceSaveAndPush: 'invoices:save-and-push',
  invoiceRetryQboPush: 'invoices:qbo:retry-push',
  invoiceQboPending: 'invoices:qbo:pending',
  // Read the invoice's state back OUT of QuickBooks. Three of the five states
  // the owner asked about are genuinely in this API and two are not — see
  // @shared/invoices for which, and why the missing two are not faked.
  invoiceSyncQboStatus: 'invoices:qbo:sync-status',
  // The invoice as a document a BUYER reads. The CSV is for QuickBooks and the
  // API call is for QuickBooks; this is the only artefact in the module meant
  // for a person.
  invoiceOpenPdf: 'invoices:pdf:open',
  invoiceSavePdf: 'invoices:pdf:save',

  // Purchase orders
  poList: 'po:list',
  poGet: 'po:get',
  poCreate: 'po:create',
  poSetStatus: 'po:set-status',
  // Record that an order has been paid, WITHOUT moving it along the board.
  // Stock often lands before the invoice is settled, so an order sits in
  // Received owing money; making that a stage move would drag the card back to
  // Paid, where it reads as not-yet-arrived to everybody looking at the board.
  poSetPaid: 'po:set-paid',
  // Add product lines to an order that already exists. A PO was write-once, so
  // a missed case meant cancelling and retyping the whole thing under a new
  // number. Moves the stored total AND the COGS row together — see
  // addPurchaseOrderLines for why one without the other is worse than neither.
  poAddLines: 'po:add-lines',
  poSetFreight: 'po:set-freight',
  // Carrier status: the hourly sweep, forced by hand.
  trackingCheckNow: 'tracking:check-now',
  trackingCanRead: 'tracking:can-read',
  poCatalogSearch: 'po:catalog-search',
  // Names for the supplier box: the contact list plus every supplier already
  // used on a PO. A PO's supplier stays free text — see @shared/purchaseOrders
  // for why it is not turned into a foreign key.
  poSuppliers: 'po:suppliers',
  // Everywhere units can be SENT: RM and AM first, then the operator's pins,
  // then every vendor and every invoice customer merged on the name.
  //
  // A WIDER question than poSuppliers or poVendors answers, and therefore a
  // third channel rather than a filter over either: those two answer "who do we
  // buy from", and a dropship destination is very often somebody we SELL to.
  // Gated on module.invoicing for the same stated reason poSuppliers is — it
  // discloses contact detail, which that permission already grants via Buyers.
  poParties: 'po:parties',
  // Pin or unpin a party so it sits near the top of the picker. RM and AM are
  // refused: they are locations, not pins, and they cannot be removed.
  poPartyPin: 'po:party-pin',
  // Change where an EXISTING order's units are going — a line's supplier or
  // destination, or its split into allocations. Refused once any affected line
  // has been received, because re-routing units already on a shelf means moving
  // stock, which is Inventory's job.
  poSetRouting: 'po:set-routing',
  // Who this business has actually bought from, for Admin → Vendors. A NARROWER
  // question than poSuppliers answers and therefore a separate channel: that one
  // offers the whole contact list as things you might type, this one lists only
  // names that money has gone to.
  poVendors: 'po:vendors',
  // The owner's vendor sheet, off their own disk. It never leaves the machine
  // and there is deliberately no copy of it in this repo — the list is 151 real
  // businesses with street addresses, and this repository is public. Filed with
  // the PO channels because Admin → Vendors is where it is run from, though what
  // it writes is a contact record: see db/vendorImport.ts for why there is no
  // separate vendor table.
  poVendorsImport: 'po:vendors:import',
  poThumbnails: 'po:thumbnails',
  poIncomingBoxes: 'po:incoming-boxes',
  poScanIn: 'po:scan-in',
  /** Record a PARTIAL delivery: how many of each line turned up today. */
  poReceiveLines: 'po:receive-lines',
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
  /** Step 4's per-card tick: gathered into the buyer's package. NOT bagging. */
  shipSlotPicked: 'shipping:teamslot:picked',
  shipSlotTopSleeved: 'shipping:teamslot:top-sleeved',
  // The bench checklist: sleeve, sort, then team-bag every team in the break.
  shipBenchStates: 'shipping:bench:states',
  shipBenchGet: 'shipping:bench:get',
  shipBenchSetStep: 'shipping:bench:set-step',
  shipBenchSetTeamBagged: 'shipping:bench:set-team-bagged',
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
  /**
   * Move the connection this machine already holds onto the cloud relay. Run
   * ONCE, by the owner, on the one laptop that is connected today — after which
   * no machine holds QuickBooks credentials at all. See the handler for why the
   * order (relay first, erase last) is the whole safety of it.
   */
  qboPromote: 'qbo:promote',
  // Diagnostics + the manual (OAuth Playground) token path.
  qboAuthorizeUrl: 'qbo:authorize-url',
  qboExchangeCode: 'qbo:exchange-code',
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

  // Streaming — shows that have not happened yet. A separate set of channels
  // because a plan is a separate table and a separate kind of fact: an
  // intention (a local day and a local HH:MM), not the record of a window that
  // was on air. See @shared/streamReminders.
  streamPlanList: 'stream:plan:list',
  streamPlanRange: 'stream:plan:range',
  streamPlanCreate: 'stream:plan:create',
  streamPlanUpdate: 'stream:plan:update',
  streamPlanCancel: 'stream:plan:cancel',
  streamPlanDelete: 'stream:plan:delete',
  streamPlanStart: 'stream:plan:start',

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
  // The same night's money, grouped one level finer. Its own channel rather
  // than a drill-down source: a drill answers "what is behind THIS line", and
  // this answers "how does the whole statement divide".
  finBreakPnl: 'finance:pnl:byBreak',
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
  // Wholesale: one row per product line sold on a sales order, with what those
  // exact FIFO layers cost. A READ over invoice_stock_moves — the margin is
  // subtracted once, in main, so no screen can arrive at a different one.
  finWholesale: 'finance:wholesale:list',

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

  // Clock-in push notifications.
  //
  // The app is the authenticated middleman only: it holds the relay's shared
  // key, the browser holds a session, and neither ever holds the other's. All
  // the signing and encrypting happens in the Worker — see @shared/webPush.
  pushState: 'push:state',
  pushSubscribe: 'push:subscribe',
  pushUnsubscribe: 'push:unsubscribe',
  pushTest: 'push:test',

  // Public intake form
  intakeLinks: 'intake:links',
  intakeLinkCreate: 'intake:link:create',
  intakeLinkSetActive: 'intake:link:set-active',
  intakeSubmissions: 'intake:submissions',
  intakeAccept: 'intake:accept',
  intakeReject: 'intake:reject',

  // Employee performance (admin.access only — it is a report about people).
  //
  // One read, one range. The screen picks a day, a week, a month or two dates
  // and everything on it is derived from the same answer, so the headline counts
  // and the per-person table can never describe different periods.
  perfShipping: 'performance:shipping',

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
