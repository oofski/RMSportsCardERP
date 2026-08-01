import { useEffect, useRef } from 'react'
import { api } from './api'

/**
 * Keep a screen current while somebody is looking at it.
 *
 * The sync loop announces which KINDS of record landed from other machines. A
 * screen says which kinds it is showing, and refetches through its normal,
 * permission-checked call when one of them moves. Nothing is pushed into the
 * component — the event carries names, never data — so this can never put a
 * number in front of someone who is not allowed to see it.
 *
 * Without this the app is a set of private copies that happen to agree at
 * startup. Someone receives a case, and the person at the next bench keeps
 * counting against a number that stopped being true ten minutes ago, with
 * nothing on screen to suggest it.
 */

/**
 * Which tables sit behind each part of the app.
 *
 * Named here rather than at each call site so that adding a table to sync is
 * one edit, and so two screens showing the same data cannot disagree about what
 * they are watching.
 */
export const LIVE = {
  inventory: [
    'inventory_products',
    'inventory_stock',
    'inventory_lots',
    'inventory_transactions',
    'inventory_incoming',
    'inventory_scans',
    'inventory_resets',
    'supplies',
    'supply_transactions',
    'supply_orders'
  ],
  purchasing: [
    'purchase_orders',
    'purchase_order_lines',
    'po_line_receipts',
    'inventory_incoming',
    'inventory_products'
  ],
  shipping: [
    'ship_event',
    'ship_breaks',
    'ship_customers',
    'ship_team_slots',
    'ship_shipments',
    'ship_orders',
    'ship_warnings',
    'ship_break_assignments',
    'ship_settings',
    'ship_imports',
    'intake_submissions'
  ],
  streaming: ['stream_sessions', 'stream_items', 'stream_item_lots', 'inventory_products'],
  finance: [
    'ledger_imports',
    'ledger_rows',
    'ledger_row_imports',
    'finance_cogs',
    'inventory_transactions'
  ],
  people: ['employees', 'time_entries'],
  activity: ['audit_log', 'inventory_transactions'],
  intake: ['intake_links', 'intake_submissions']
} as const

/**
 * Refetches are coalesced.
 *
 * A first sync after a laptop has been offline arrives as several batches in a
 * few seconds. Refetching per batch would hammer every open screen for no gain,
 * and the user would watch numbers flicker. One refetch shortly after the last
 * batch says the same thing once.
 */
const SETTLE_MS = 400

export function useLiveRefresh(
  kinds: readonly string[],
  refetch: () => void | Promise<void>
): void {
  // Held in a ref so a callback that is rebuilt on every render — which is most
  // of them — does not tear down and re-subscribe on every render too.
  const latest = useRef(refetch)
  latest.current = refetch

  const watched = kinds.join(',')

  useEffect(() => {
    const set = new Set(watched.split(','))
    let timer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false

    const off = api.sync.onChanged((event) => {
      if (!event.kinds.some((kind) => set.has(kind))) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (cancelled) return
        // Errors are swallowed on purpose. This is a background refresh nobody
        // asked for; a failed one should leave the screen showing what it had,
        // not throw a toast at someone who is in the middle of something else.
        void Promise.resolve(latest.current()).catch(() => {})
      }, SETTLE_MS)
    })

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      off()
    }
  }, [watched])
}
