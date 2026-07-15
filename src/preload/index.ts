import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type AppInfo } from '@shared/ipc'
import type {
  AuthResult,
  ComposedEmail,
  Employee,
  EmployeeHoursSummary,
  EmployeeInvite,
  NewEmployeeInput,
  NewTimeEntryInput,
  Result,
  SessionUser,
  TimeEntry,
  UpdateEmployeeInput,
  UpdateStatus
} from '@shared/types'

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
      ipcRenderer.invoke(IPC.employeesResetPassword, { id })
  },
  hours: {
    summary: (): Promise<EmployeeHoursSummary[]> => ipcRenderer.invoke(IPC.hoursSummary),
    list: (employeeId?: string): Promise<TimeEntry[]> =>
      ipcRenderer.invoke(IPC.hoursList, employeeId),
    create: (input: NewTimeEntryInput): Promise<Result<TimeEntry>> =>
      ipcRenderer.invoke(IPC.hoursCreate, input),
    delete: (id: string): Promise<Result> => ipcRenderer.invoke(IPC.hoursDelete, { id })
  },
  email: {
    composeInvite: (
      employeeId: string,
      temporaryPassword: string | null
    ): Promise<Result<ComposedEmail>> =>
      ipcRenderer.invoke(IPC.emailComposeInvite, { employeeId, temporaryPassword }),
    openExternal: (url: string): Promise<Result> => ipcRenderer.invoke(IPC.emailOpenExternal, url)
  },
  updates: {
    getStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.updatesGetStatus),
    check: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.updatesCheck),
    download: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.updatesDownload),
    install: (): Promise<Result> => ipcRenderer.invoke(IPC.updatesInstall),
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
