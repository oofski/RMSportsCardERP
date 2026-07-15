import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ThemeMode } from '@shared/types'
import { api } from './api'

const STORAGE_KEY = 'rmops-theme'

function readInitial(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    // ignore
  }
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark'
  }
  return 'light'
}

// Apply as early as possible to avoid a flash of the wrong theme.
const INITIAL = readInitial()
document.documentElement.dataset.theme = INITIAL

interface ThemeState {
  mode: ThemeMode
  toggle: () => void
  setMode: (mode: ThemeMode) => void
}

const ThemeContext = createContext<ThemeState | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [mode, setModeState] = useState<ThemeMode>(INITIAL)

  const apply = useCallback((next: ThemeMode) => {
    setModeState(next)
    document.documentElement.dataset.theme = next
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // ignore
    }
    // Keep native chrome (dialogs, menus) in sync.
    void api.theme.set(next)
  }, [])

  useEffect(() => {
    void api.theme.set(mode)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const value = useMemo<ThemeState>(
    () => ({
      mode,
      setMode: apply,
      toggle: () => apply(mode === 'dark' ? 'light' : 'dark')
    }),
    [mode, apply]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider')
  return ctx
}
