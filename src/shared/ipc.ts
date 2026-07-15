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

  // Hours
  hoursSummary: 'hours:summary',
  hoursList: 'hours:list',
  hoursCreate: 'hours:create',
  hoursDelete: 'hours:delete',

  // Email
  emailComposeInvite: 'email:compose-invite',
  emailOpenExternal: 'email:open-external',

  // Updates
  updatesCheck: 'updates:check',
  updatesDownload: 'updates:download',
  updatesInstall: 'updates:install',
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
