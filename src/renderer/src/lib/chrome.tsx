import { createContext, useContext } from 'react'

/**
 * Chrome context lets the top-bar search box (owned by the app shell) drive
 * filtering inside whichever module is active, plus lets the dashboard jump to
 * another module.
 */
export interface ChromeState {
  search: string
  navigate: (moduleId: string) => void
}

export const ChromeContext = createContext<ChromeState>({
  search: '',
  navigate: () => {}
})

export function useChrome(): ChromeState {
  return useContext(ChromeContext)
}
