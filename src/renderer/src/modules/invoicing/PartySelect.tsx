import { useEffect, useMemo, useState } from 'react'
import type { SupplierSuggestion } from '@shared/purchaseOrders'
import { MAX_PINNED_PARTIES, canonicalDestination } from '@shared/purchaseOrders'
import { LOCATION_IDS } from '@shared/inventory'
import { api } from '../../lib/api'
import { Input, Select } from '../../components/ui'
import { useOrderParties } from './DestinationPicker'
import { Icon } from '../../components/Icon'

/**
 * Supplier and destination, as a dropdown you do not type into.
 *
 * ## Why a native <select> and not the typeaheads these replaced
 *
 * Two reasons, and the second one is the bigger of them.
 *
 * The first is what was asked for: picking the distributor you buy from every
 * week should not be a spelling exercise. A typeahead is a text box that HAPPENS
 * to offer help, so its resting state is an empty caret and its failure state is
 * a name typed two ways — "Bramble Wholesale" on Monday and "bramble wholesale"
 * on Thursday, which the vendor list then has to fold back together.
 *
 * The second is that a typeahead's menu is a `position: absolute` panel, and
 * this form is a table inside a modal that scrolls. A floating panel opened from
 * a row near the bottom of that table has to be positioned against a scrolling
 * ancestor, gets clipped by the panel it is drawn inside, and moves out from
 * under the pointer when the body scrolls. A native <select> has none of those
 * problems because its menu is not in the page at all — the OS draws it, above
 * everything, correctly positioned, scrollable, and searchable by typing the
 * first few letters. Every "the dropdown appeared in the wrong place" bug this
 * screen could have is deleted rather than fixed.
 *
 * ## The escape hatch is not optional
 *
 * A list of parties can only ever hold the parties somebody has already dealt
 * with. The FIRST order from a new distributor, and the one-off drop to a shop
 * nobody has filed, are both real and both frequent — and a form that cannot
 * express them is a form somebody has to work around. So the last option is
 * `Other…`, and choosing it reveals a text box. Nothing is typed on the ordinary
 * path, and the unusual path is still one click away.
 *
 * ## Inheritance is a first option, never a pre-selected value
 *
 * A line whose supplier or destination is NULL follows the order header, and
 * that null is what gets stored. Pre-selecting the header's concrete name would
 * look identical on screen and be a completely different document: the line
 * would stop tracking the header, so changing the order's destination afterwards
 * would move every line except the ones somebody had merely LOOKED at. So the
 * inherited state gets its own option, reading `Same as order (RM)`, whose value
 * is the empty string and whose meaning is null.
 */

/* -------------------------------------------------------------------------- */
/* The supplier list, fetched once for the whole form                          */
/* -------------------------------------------------------------------------- */

/**
 * Process-wide, for the same reason `useOrderParties` is.
 *
 * The create form draws a supplier control on the header AND one on every line
 * AND one on every split row, so a nine-line order mounts a dozen of these at
 * once. Fetching per instance would be a dozen identical round trips every time
 * the modal opens, on a list that cannot change while it is open.
 */
let supplierCache: SupplierSuggestion[] | null = null
let supplierInflight: Promise<SupplierSuggestion[]> | null = null
const supplierListeners = new Set<(rows: SupplierSuggestion[]) => void>()

function publishSuppliers(rows: SupplierSuggestion[]): void {
  supplierCache = rows
  for (const notify of supplierListeners) notify(rows)
}

export function useSupplierSuggestions(): SupplierSuggestion[] {
  const [rows, setRows] = useState<SupplierSuggestion[]>(supplierCache ?? [])

  useEffect(() => {
    supplierListeners.add(setRows)
    if (supplierCache) setRows(supplierCache)
    else if (!supplierInflight) {
      supplierInflight = api.purchaseOrders.suppliers()
      void supplierInflight
        .then((fresh) => publishSuppliers(fresh))
        .catch(() => {
          // A failed first read must not poison the cache for the session —
          // clearing the promise lets the next control that mounts try again.
          // The form still works meanwhile: Other… types any name.
          supplierInflight = null
          publishSuppliers([])
        })
    }
    return () => {
      supplierListeners.delete(setRows)
    }
  }, [])

  return rows
}

/* -------------------------------------------------------------------------- */
/* The control                                                                 */
/* -------------------------------------------------------------------------- */

/** One `<optgroup>`. Groups with no names are dropped rather than left empty. */
interface PartyGroup {
  label: string
  names: string[]
}

/**
 * The two option values that are not somebody's name.
 *
 * A control character rather than a readable word, because every name in either
 * directory is human-typed and a supplier genuinely called "Other" is possible.
 * U+001F cannot be typed into the escape hatch and cannot come back from
 * either list, so a sentinel can never be mistaken for a choice. Written as
 * an escape sequence rather than pasted in: an invisible byte in a string
 * literal is the kind of thing an editor silently eats and nobody sees go.
 */
const BLANK = ''
const OTHER = '\u001Fother'

function PartySelectBase({
  value,
  onChange,
  groups,
  blankLabel,
  otherLabel,
  otherPlaceholder,
  ariaLabel,
  className = '',
  drop = false,
  canonical = false
}: {
  /** null or empty means "the blank option" — inherited, or not named at all. */
  value: string | null
  onChange: (next: string | null) => void
  groups: PartyGroup[]
  /**
   * The label on the empty option. Absent means the field is REQUIRED: the
   * option is still rendered so a momentarily-empty value has something to show,
   * but it is disabled so it cannot be chosen back.
   */
  blankLabel?: string
  otherLabel: string
  otherPlaceholder: string
  ariaLabel: string
  className?: string
  /** Show the Drop chip beside the control — the caller decides, because on an
   *  inherited cell the answer comes from the header rather than from `value`. */
  drop?: boolean
  /** Fold a hand-typed shelf id back to its canonical spelling. Destinations
   *  only: "rm" typed into a supplier box is just a supplier called rm. */
  canonical?: boolean
}): JSX.Element {
  /**
   * Is the escape hatch open?
   *
   * Deliberately not derived from "the value is not in the list". A brand-new
   * supplier is not in the list the moment it is typed either, so a derived flag
   * would close the box on the first keystroke and re-open it on the second.
   */
  const [custom, setCustom] = useState(false)

  const current = (value ?? '').trim()

  const names = useMemo(() => groups.flatMap((g) => g.names), [groups])

  /**
   * The option whose name IS this value, matched case-insensitively.
   *
   * The fold is the whole point of doing this by search rather than by equality.
   * A supplier typed in caps on one order comes back from the directory in the
   * spelling it was last written in, and `<select>` matches its options by exact
   * string: "bramble wholesale" against an option reading "Bramble Wholesale"
   * matches nothing, so the control silently falls back to displaying its FIRST
   * entry — a form that says the order is going somewhere it is not.
   */
  const match = useMemo(
    () => names.find((n) => n.toLowerCase() === current.toLowerCase()) ?? null,
    [names, current]
  )

  /**
   * A name that is set and is in no group at all.
   *
   * Rendered as an option of its own, for the same reason: without one the
   * <select> has nothing to show and drops to its first entry. Happens on a name
   * typed through Other… — which is every brand-new supplier, before the first
   * order to them exists — and on a party whose directory row went away after
   * the order was drafted.
   */
  const stray = current && !match ? current : null

  const blankText = blankLabel ?? 'Choose…'
  const selected = custom ? OTHER : match ?? stray ?? current

  const choose = (raw: string): void => {
    if (raw === OTHER) {
      setCustom(true)
      // Cleared rather than carried over: the box is being opened BECAUSE the
      // list did not have the answer, so starting it with the last pick would
      // mean deleting somebody else's name before typing your own.
      onChange(null)
      return
    }
    setCustom(false)
    onChange(raw === BLANK ? null : raw)
  }

  return (
    <div className={`po-party${className ? ` ${className}` : ''}`}>
      <div className="po-party-row">
        <Select
          className="po-party-select"
          value={selected}
          aria-label={ariaLabel}
          // A 170px column cannot print "Cardboard Kingdom Collectibles", and a
          // native select clips rather than ellipsises. The tooltip is the only
          // way to read the whole name without changing it.
          title={custom ? undefined : current || blankText}
          onChange={(e) => choose(e.target.value)}
        >
          <option value={BLANK} disabled={blankLabel === undefined}>
            {blankText}
          </option>
          {stray && <option value={stray}>{stray}</option>}
          {groups
            .filter((g) => g.names.length > 0)
            .map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.names.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </optgroup>
            ))}
          <option value={OTHER}>{otherLabel}</option>
        </Select>
        {drop && (
          <span
            className="po-drop-chip"
            title="Ships straight to this party — never into RM or AM stock"
          >
            Drop
          </span>
        )}
      </div>

      {custom && (
        <Input
          className="po-party-other"
          value={value ?? ''}
          placeholder={otherPlaceholder}
          aria-label={`${ariaLabel} — new name`}
          autoFocus
          onChange={(e) => onChange(e.target.value.trim() ? e.target.value : null)}
          onBlur={() => {
            const folded = canonical ? canonicalDestination(current) : current
            if (folded !== (value ?? '')) onChange(folded || null)
            // Typed a name the list already holds — or emptied the box — so the
            // dropdown can tell the truth again. Without this the control would
            // sit in "Other…" while holding a value that was never other, and
            // "rm" folded to "RM" would read as a shop nobody has heard of.
            if (!folded || names.some((n) => n.toLowerCase() === folded.toLowerCase())) {
              setCustom(false)
            }
          }}
        />
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Suppliers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Grouped by whether money has ever gone to them, not alphabetically.
 *
 * `listSupplierSuggestions` returns the names already used on purchase orders
 * FIRST and most-recently-dealt-with first, then the rest of the contact list.
 * That order is the whole value of the list — this operation buys from about
 * four distributors and has several hundred contacts — so it is preserved and
 * only labelled, rather than re-sorted into one long alphabet where the four
 * that matter are scattered through the Cs and the Ms.
 */
export function SupplierSelect({
  value,
  onChange,
  blankLabel,
  ariaLabel,
  className
}: {
  value: string | null
  onChange: (next: string | null) => void
  blankLabel?: string
  ariaLabel: string
  className?: string
}): JSX.Element {
  const suggestions = useSupplierSuggestions()

  const groups = useMemo<PartyGroup[]>(() => {
    const used: string[] = []
    const rest: string[] = []
    for (const s of suggestions) (s.usedOnOrders > 0 ? used : rest).push(s.name)
    return [
      { label: 'Bought from before', names: used },
      { label: 'Contacts', names: rest }
    ]
  }, [suggestions])

  return (
    <PartySelectBase
      value={value}
      onChange={onChange}
      groups={groups}
      blankLabel={blankLabel}
      otherLabel="Other… (type a new supplier)"
      otherPlaceholder="Name the supplier"
      ariaLabel={ariaLabel}
      className={className}
    />
  )
}

/* -------------------------------------------------------------------------- */
/* Destinations                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Shelves first, then pins, then everybody else — the order the party list
 * already comes back in, split into `<optgroup>`s on the two flags it carries.
 *
 * RM and AM lead and are labelled as what they are, because they are the only
 * two entries in the list that mean "this arrives here". Everything below the
 * first group is a dropship, and the consequence — no box, nothing to check in —
 * is what the Drop chip beside the control says.
 */
export function DestinationSelect({
  value,
  onChange,
  blankLabel,
  ariaLabel,
  className,
  drop,
  pinnable
}: {
  value: string | null
  onChange: (next: string | null) => void
  blankLabel?: string
  ariaLabel: string
  className?: string
  drop?: boolean
  /**
   * Show the pin toggle beside the box.
   *
   * Only the ORDER's destination sets this, and it is the one control anywhere
   * in the app that writes a pin. Moving from a typeahead to a select took the
   * per-row star with it, which left the Pinned group readable and permanently
   * unfillable: a list that can only ever shrink, and a main-process call with
   * no caller left anywhere in the renderer.
   * One toggle on the header keeps the feature whole without putting a button
   * inside every line's select, which a native select cannot hold anyway.
   */
  pinnable?: boolean
}): JSX.Element {
  const { parties, setPinned } = useOrderParties()

  const groups = useMemo<PartyGroup[]>(() => {
    const shelves = parties.filter((p) => p.holdsStock).map((p) => p.name)
    return [
      // Synthesised when the party list cannot be read — an older main process,
      // a permission the user does not hold, a failed call. Without it the
      // destination box on a new order would offer nothing at all, which reads
      // as the form being broken rather than as a list being unavailable.
      { label: 'Stock locations', names: shelves.length > 0 ? shelves : [...LOCATION_IDS] },
      {
        label: 'Pinned',
        names: parties
          .filter((p) => !p.holdsStock && p.pinned)
          .slice(0, MAX_PINNED_PARTIES)
          .map((p) => p.name)
      },
      {
        label: 'Everyone else',
        names: parties.filter((p) => !p.holdsStock && !p.pinned).map((p) => p.name)
      }
    ]
  }, [parties])

  const chosen = (value ?? '').trim()
  const row = parties.find((p) => p.name.toLowerCase() === chosen.toLowerCase())
  // RM and AM are locations, not pins: they are prepended in code and cannot be
  // unpinned, so offering the toggle on them would be offering a refusal. A name
  // not in the directory at all has nothing to pin yet — it becomes pinnable
  // once the order is saved and the party exists.
  const canPin = !!pinnable && !!row && !row.holdsStock && row.pinnable

  const select = (
    <PartySelectBase
      value={value}
      onChange={onChange}
      groups={groups}
      blankLabel={blankLabel}
      otherLabel="Other… (ship somewhere new)"
      otherPlaceholder="Shop, person or address"
      ariaLabel={ariaLabel}
      className={className}
      drop={drop}
      canonical
    />
  )
  if (!pinnable) return select

  return (
    <div className="po-dest-with-pin">
      {select}
      {canPin && (
        <button
          type="button"
          className={`po-pin-btn${row?.pinned ? ' is-pinned' : ''}`}
          title={
            row?.pinned
              ? `Unpin ${row.name} — it drops back into the full list`
              : `Pin ${row?.name} so it sits near the top of every destination list`
          }
          aria-pressed={!!row?.pinned}
          onClick={() => void setPinned(chosen, !row?.pinned)}
        >
          <Icon name="Star" size={14} />
        </button>
      )}
    </div>
  )
}
