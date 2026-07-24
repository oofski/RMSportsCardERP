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
