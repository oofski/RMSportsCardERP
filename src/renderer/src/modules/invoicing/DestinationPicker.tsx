import { useCallback, useEffect, useMemo, useState } from 'react'
import type { OrderParty, OrderPartyKind } from '@shared/purchaseOrders'
import {
  MAX_PINNED_PARTIES,
  canonicalDestination,
  destinationHoldsStock
} from '@shared/purchaseOrders'
import { LOCATIONS } from '@shared/inventory'
import { api } from '../../lib/api'
import { Field, Input } from '../../components/ui'
import { Icon } from '../../components/Icon'

/**
 * Where these units are going.
 *
 * ## NOTHING MOUNTS THE PICKER BELOW ANY MORE — read this before deleting it
 *
 * The purchase-order form asked for dropdowns rather than boxes you type into,
 * so its three destination controls are now native <select>s (see PartySelect),
 * and `useOrderParties` is what they read the list from. That hook is the live
 * half of this file and is imported by both of them.
 *
 * The `DestinationPicker` component underneath is kept for one reason: its menu
 * carries the STAR, and the star is the only thing anywhere in the app that
 * calls `api.purchaseOrders.pinParty`. A <select> cannot hold a second button
 * per row, so with the picker unmounted the `Pinned` group in the new dropdowns
 * can be read but no longer written — the six pins somebody has already set
 * still lead the list, and a seventh cannot be added. Deleting this component
 * makes that permanent and orphans `setPartyPinned` in the main process along
 * with its tests, so it is a decision to take deliberately rather than a tidy-up
 * to do on the way past.
 *
 * ## Why this is not the location <Select> it replaced
 *
 * A destination used to be RM or AM and nothing else, so a two-entry dropdown
 * said everything there was to say. It is now RM, AM, or the name of any vendor
 * or any customer — a list that starts at a couple of dozen and grows every time
 * somebody is added to either directory. A dropdown over that is a scroll; a
 * typeahead over it is a keystroke.
 *
 * ## Free text still wins, matched or not
 *
 * Whatever is in the box is the destination, exactly as ContactTypeahead states
 * for suppliers and for the same reason: a one-off drop to a shop nobody has
 * filed yet must not require a detour into a contacts screen first. The picker
 * is a way of not typing, never a gate on what may be typed.
 *
 * ## But a shelf id is folded back to its canonical spelling
 *
 * `rm` typed by hand is a dropship to a shop called rm: the units stop being
 * receivable, no box appears in Incoming and the order can never complete. The
 * failure is silent and looks like the feature is broken rather than like a
 * typo, so `canonicalDestination` runs on blur — see @shared/purchaseOrders,
 * which does the same thing again on write because this side cannot be trusted
 * to be the only door.
 *
 * ## RM and AM are not pins
 *
 * They are locations. They lead the list, their star is filled and disabled, and
 * `setPartyPinned` refuses them on the other side too. Six user pins sit under
 * them, then everybody else — most recently dealt with first.
 */

/* -------------------------------------------------------------------------- */
/* One fetch, shared                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The party list is process-wide state, not per-picker state.
 *
 * The line editor draws a destination picker on the line AND one on every split
 * row, so a line split three ways mounts four of these at once. Fetching per
 * instance would be four identical round trips on open and — worse — four copies
 * of the list that drift apart the moment one of them pins something, leaving
 * the star filled on one row and hollow on the next.
 */
let cache: OrderParty[] | null = null
let inflight: Promise<OrderParty[]> | null = null
const listeners = new Set<(rows: OrderParty[]) => void>()

function publishParties(rows: OrderParty[]): void {
  cache = rows
  for (const notify of listeners) notify(rows)
}

/**
 * RM and AM, synthesised.
 *
 * The picker must be able to offer the two shelves even when the party list
 * cannot be read — an older main process that does not know the channel, a
 * permission the user does not hold, a failed call. Without this the destination
 * box on a brand new purchase order would offer nothing at all, which reads as
 * the form being broken rather than as a list being unavailable.
 *
 * Built from LOCATIONS rather than from a second hard-coded pair, so a third
 * shelf could never appear here and not there.
 */
const SHELVES: OrderParty[] = LOCATIONS.map((l) => ({
  name: l.id,
  kind: 'location' as OrderPartyKind,
  detail: null,
  holdsStock: true,
  pinned: true,
  pinnable: false,
  lastAt: null
}))

export function useOrderParties(): {
  parties: OrderParty[]
  setPinned: (name: string, pinned: boolean) => Promise<void>
} {
  const [rows, setRows] = useState<OrderParty[]>(cache ?? [])

  useEffect(() => {
    listeners.add(setRows)
    if (cache) setRows(cache)
    else {
      if (!inflight) {
        inflight = api.purchaseOrders.parties()
        void inflight
          .then((fresh) => publishParties(fresh))
          .catch(() => {
            // A failed first read must not poison the cache for the session:
            // clearing `inflight` lets the next picker that opens try again.
            inflight = null
            publishParties([])
          })
      }
    }
    return () => {
      listeners.delete(setRows)
    }
  }, [])

  const setPinned = useCallback(async (name: string, pinned: boolean): Promise<void> => {
    // Swallowed rather than surfaced. A pin is a convenience — it changes the
    // ORDER of a list nobody is blocked on — so a machine whose main process
    // does not know the channel should leave the picker working rather than
    // throw a toast at somebody who was only tidying.
    const res = await api.purchaseOrders.pinParty(name, pinned).catch(() => null)
    // The handler returns the FRESH list rather than an acknowledgement, so the
    // order the pins come back in is the server's and not this component's guess
    // at it. A refusal (RM/AM) simply leaves the list as it was.
    if (res?.ok && res.data) publishParties(res.data)
  }, [])

  return { parties: rows, setPinned }
}

/* -------------------------------------------------------------------------- */
/* The picker                                                                  */
/* -------------------------------------------------------------------------- */

/** How many of "everybody else" are shown before the Show all affordance. */
const REST_SHOWN = 8
/** How many results a query narrows to — the same rule ContactTypeahead states. */
const MATCHES_SHOWN = 8

const KIND_LABEL: Record<OrderPartyKind, string> = {
  location: 'Stock location · units land here',
  vendor: 'Vendor',
  customer: 'Customer',
  both: 'Vendor and customer',
  history: 'Used on an order before'
}

function partyDetail(p: OrderParty): string {
  if (p.kind === 'location') return KIND_LABEL.location
  return [p.detail, KIND_LABEL[p.kind]].filter(Boolean).join(' · ') || 'No details yet'
}

export function DestinationPicker({
  value,
  onChange,
  label = 'Destination',
  hint = 'RM, AM, or anyone you are shipping to',
  placeholder = 'RM, AM or a shop name…',
  /** Drop the Field wrapper — for a table cell or a split row, where the column
   *  heading is already the label and a second one would be noise. */
  inline = false,
  disabled = false,
  /** Announced by a split row, which has no visible label of its own. */
  ariaLabel
}: {
  value: string
  onChange: (destination: string) => void
  label?: string
  hint?: string
  placeholder?: string
  inline?: boolean
  disabled?: boolean
  ariaLabel?: string
}): JSX.Element {
  const { parties, setPinned } = useOrderParties()
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  /**
   * Is the box being TYPED IN, or is it just showing the current choice?
   *
   * ContactTypeahead has no equivalent because its box starts empty: whatever is
   * in it is always a query. This one is never empty — it opens on RM — so
   * treating its contents as a query would filter the list down to the one entry
   * already chosen and hide every alternative behind a backspace. The list is
   * the whole point of the control, so focus shows all of it and only a keystroke
   * narrows it.
   */
  const [typing, setTyping] = useState(false)

  const query = typing ? value.trim().toLowerCase() : ''

  const groups = useMemo(() => {
    const rows = parties.length > 0 ? parties : SHELVES
    const shelves = rows.filter((p) => p.holdsStock)
    // Defensive rather than decorative: a party list that somehow arrives
    // without RM and AM would leave the two shelves untypeable from the menu.
    const withShelves = shelves.length > 0 ? rows : [...SHELVES, ...rows]
    return {
      shelves: withShelves.filter((p) => p.holdsStock),
      pins: withShelves.filter((p) => !p.holdsStock && p.pinned).slice(0, MAX_PINNED_PARTIES),
      rest: withShelves.filter((p) => !p.holdsStock && !p.pinned)
    }
  }, [parties])

  const matches = useMemo(() => {
    const all = [...groups.shelves, ...groups.pins, ...groups.rest]
    if (!query) return null
    return all
      .filter(
        (p) =>
          p.name.toLowerCase().includes(query) || (p.detail ?? '').toLowerCase().includes(query)
      )
      .slice(0, MATCHES_SHOWN)
  }, [groups, query])

  // An exact hit needs no menu: the box already says what would be picked.
  const settled =
    matches != null &&
    matches.length === 1 &&
    matches[0].name.toLowerCase() === value.trim().toLowerCase()

  const restShown = showAll ? groups.rest : groups.rest.slice(0, REST_SHOWN)
  const hidden = groups.rest.length - restShown.length

  const pick = (name: string): void => {
    onChange(name)
    setTyping(false)
    setShowAll(false)
    setOpen(false)
  }

  const row = (p: OrderParty): JSX.Element => (
    <div className="dp-row" key={`${p.kind}-${p.name}`}>
      <button
        type="button"
        className={`ta-item${p.name.toLowerCase() === value.trim().toLowerCase() ? ' active' : ''}`}
        // Late enough that a click on a result lands before the list closes.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => pick(p.name)}
      >
        <span className="ta-name">
          {p.name}
          {!p.holdsStock && <span className="po-drop-chip">Drop</span>}
        </span>
        <span className="ta-sub">{partyDetail(p)}</span>
      </button>
      <button
        type="button"
        className={`dp-star${p.pinned ? ' is-pinned' : ''}`}
        aria-label={
          p.pinnable
            ? p.pinned
              ? `Unpin ${p.name}`
              : `Pin ${p.name} to the top`
            : `${p.name} is a stock location and is always shown first`
        }
        title={
          p.pinnable
            ? p.pinned
              ? 'Unpin'
              : 'Pin to the top of this list'
            : 'A stock location — always first, and cannot be unpinned'
        }
        aria-pressed={p.pinned}
        disabled={!p.pinnable}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void setPinned(p.name, !p.pinned)}
      >
        <Icon name="Star" size={13} />
      </button>
    </div>
  )

  const box = (
    <div className="dp-box">
      <Input
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel ?? (inline ? label : undefined)}
        disabled={disabled}
        onFocus={() => {
          setOpen(true)
          setTyping(false)
        }}
        onChange={(e) => {
          onChange(e.target.value)
          setTyping(true)
          setOpen(true)
        }}
        onBlur={() => {
          // Fold a hand-typed shelf id back to its canonical spelling before it
          // can become a dropship to a shop called "rm". Synchronous, so a click
          // on a menu row still overwrites it a moment later with the exact name.
          const canonical = canonicalDestination(value)
          if (canonical !== value) onChange(canonical)
          setTyping(false)
          window.setTimeout(() => setOpen(false), 160)
        }}
      />
      {/* The one thing about a destination that changes what the app DOES with
          it. Shown on the closed control, not only in the menu, because the
          consequence — these units never reach a shelf — has to be readable
          without opening anything. */}
      {value.trim().length > 0 && !destinationHoldsStock(value) && (
        <span className="po-drop-chip" title="Ships straight to this party — never into RM or AM stock">
          Drop
        </span>
      )}
    </div>
  )

  return (
    <div className={`typeahead dp${inline ? ' dp-inline' : ''}`}>
      {inline ? box : <Field label={label} hint={hint}>{box}</Field>}

      {open && !disabled && !settled && (
        <div className="ta-menu dp-menu">
          {matches != null ? (
            matches.length > 0 ? (
              matches.map(row)
            ) : (
              <div className="ta-empty">
                No match — press on, whatever you type is the destination.
              </div>
            )
          ) : (
            <>
              {groups.shelves.map(row)}
              {groups.pins.length > 0 && (
                <div className="dp-sep">Pinned</div>
              )}
              {groups.pins.map(row)}
              {restShown.length > 0 && <div className="dp-sep">Everyone else</div>}
              {restShown.map(row)}
              {hidden > 0 && (
                <button
                  type="button"
                  className="dp-more"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setShowAll(true)}
                >
                  Show all {groups.rest.length}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
