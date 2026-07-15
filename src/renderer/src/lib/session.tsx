import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { AppInfo } from '@shared/ipc'
import type { SessionUser } from '@shared/types'
import type { Permission } from '@shared/permissions'
import { api } from './api'

interface SessionState {
  loading: boolean
  needsSetup: boolean
  user: SessionUser | null
  appInfo: AppInfo | null
  can: (permission: Permission) => boolean
  refresh: () => Promise<void>
  setUser: (user: SessionUser | null) => void
  logout: () => Promise<void>
}

const SessionContext = createContext<SessionState | null>(null)

export function SessionProvider({ children }: { children: ReactNode }): JSX.Element {
  const [loading, setLoading] = useState(true)
  const [needsSetup, setNeedsSetup] = useState(false)
  const [user, setUser] = useState<SessionUser | null>(null)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)

  const refresh = useCallback(async () => {
    const [setup, current, info] = await Promise.all([
      api.auth.setupState(),
      api.auth.current(),
      api.app.info()
    ])
    setNeedsSetup(setup.needsSetup)
    setUser(current)
    setAppInfo(info)
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        await refresh()
      } finally {
        setLoading(false)
      }
    })()
  }, [refresh])

  const logout = useCallback(async () => {
    await api.auth.logout()
    setUser(null)
  }, [])

  const can = useCallback(
    (permission: Permission) => !!user && user.permissions.includes(permission),
    [user]
  )

  const value = useMemo<SessionState>(
    () => ({ loading, needsSetup, user, appInfo, can, refresh, setUser, logout }),
    [loading, needsSetup, user, appInfo, can, refresh, logout]
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used within a SessionProvider')
  return ctx
}
