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

/**
 * Repaint the system chrome around an installed web app.
 *
 * On an iPhone running this from the Home Screen, `theme-color` is the colour
 * iOS fills the notch strip and the home-indicator strip with — the two bands
 * this app now deliberately draws its top bar and its bottom navigation into
 * (see styles/mobile.css). index.html can only carry ONE value and the theme is
 * an explicit choice rather than the system's, so a static tag is wrong half
 * the time: light mode had a dark navy band above a white app.
 *
 * Read off --surface rather than restated as a hex, so it cannot drift from
 * whatever theme.css says the bars are painted with. A no-op in Electron, which
 * has real window chrome and never reads this tag.
 */
function paintSystemChrome(): void {
  const tag = document.querySelector('meta[name="theme-color"]')
  if (!tag) return
  const surface = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim()
  if (surface) tag.setAttribute('content', surface)
}

// Apply as early as possible to avoid a flash of the wrong theme.
const INITIAL = readInitial()
document.documentElement.dataset.theme = INITIAL
paintSystemChrome()

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
    paintSystemChrome()
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
