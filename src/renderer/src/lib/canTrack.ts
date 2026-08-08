import { useEffect, useState } from 'react'
import { api } from './api'

/**
 * Can THIS client read a carrier's page?
 *
 * Only the desktop app can: reading means loading the carrier's own page in a
 * real browser window, and the web build has none. The answer changes what a
 * screen should SAY, not just which buttons it offers — "Not checked yet" reads
 * as "press something" and is wrong in a browser, where nothing anybody presses
 * will help. See TrackingLine.
 *
 * Asked ONCE per session and shared. It is a property of the build, not of the
 * data, so a board with twenty cards must not make twenty IPC calls to find out
 * the same unchanging fact.
 */
let cached: Promise<boolean> | null = null

export function canReadTracking(): Promise<boolean> {
  if (!cached) {
    cached = api.purchaseOrders.canReadTracking().catch(() => false)
  }
  return cached
}

/**
 * The same answer as React state.
 *
 * Starts as `null` — "not known yet" — rather than false, so a card does not
 * flash the web wording for a moment on the desktop before correcting itself.
 */
export function useCanReadTracking(): boolean | null {
  const [can, setCan] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    void canReadTracking().then((v) => {
      if (alive) setCan(v)
    })
    return () => {
      alive = false
    }
  }, [])
  return can
}
