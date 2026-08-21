import { useEffect, useMemo, useState } from 'react'
import type { SupplierSuggestion } from '@shared/purchaseOrders'
import { MAX_PINNED_PARTIES, canonicalDestination } from '@shared/purchaseOrders'
import { MULTI_SHIPMENT } from '@shared/multiShipment'
import { LOCATION_IDS } from '@shared/inventory'
import { api } from '../../lib/api'
import { Combobox } from '../../components/Combobox'
import { useOrderParties } from './DestinationPicker'
import { Icon } from '../../components/Icon'

/**
 * Supplier and destination: click the box, start typing, pick out of the list.
 *
 * ## What was tried before this, and why it changed
 *
 * This control has been three things. It started as a typeahead, was rebuilt as
 * a native <select> that could not be typed into at all, and is now a combobox —
 * a box you can type into whose menu is a portal. The middle version was not a
 * mistake, and the reasoning that produced it is still true; what changed is
 * that both of the problems it was avoiding now have answers that do not cost
 * the typing. The owner asked for the typing back in those words: click the
 * empty box and start typing and the results appear.
 *
 * The two problems, and where each one went:
 *
 * **Spelling drift.** A plain typeahead is a text box that HAPPENS to offer
 * help, so its resting state is an empty caret and its failure state is a name
 * typed two ways — "Bramble Wholesale" on Monday and "bramble wholesale" on
 * Thursday, which the vendor list then has to fold back together. That is now
 * handled instead of avoided: the list is still the same curated, grouped,
 * ordered list, picking from it writes the list's own spelling, and a name typed
 * by hand that case-insensitively matches an entry is FOLDED to that entry's
 * spelling when the box is left. See `commitTyped` in components/Combobox.tsx —
 * it is the same fold the `Other…` box did on blur, applied to every path in
 * rather than to the one unusual one. Only a name that matches nothing at all is
 * stored as typed, which is what a genuinely new distributor is.
 *
 * **The menu could not be drawn in the right place.** This was the bigger of the
 * two and the real reason for the <select>. A typeahead's menu is a
 * `position: absolute` panel and this form is a TABLE INSIDE A MODAL BODY THAT
 * SCROLLS, so a menu opened from a row near the bottom is clipped by the panel it
 * is drawn inside, is positioned against a container that is itself moving, and
 * slides out from under the pointer the moment the body scrolls. A native
 * <select> deleted all three by not being in the page at all. The combobox
 * deletes them a different way: its menu is rendered through a React portal into
 * `document.body` at `position: fixed`, placed from the input's
 * `getBoundingClientRect()`, and there is no overflow ancestor to clip a fixed
 * element parented to the body and no scrolling container to measure it against.
 * Drift is handled by refusing to chase it — a capturing scroll listener catches
 * the modal-body scrolls that never bubble to window and CLOSES the menu, with
 * focus left in the box so one keystroke brings it back. The menu also flips
 * above the control when the room below runs out, and is allowed to be wider than
 * the 170px cell it belongs to, which the <select> never could be.
 *
 * ## The escape hatch is still not optional
 *
 * A list of parties can only ever hold the parties somebody has already dealt
 * with. The FIRST order from a new distributor, and the one-off drop to a shop
 * nobody has filed, are both real and both frequent — and a form that cannot
 * express them is a form somebody has to work around. There is no `Other…`
 * option any more because there is nothing to reveal: the box is already a text
 * box, and a name that matches nothing is committed as typed. The menu says so
 * when the filter finds nothing, rather than leaving somebody to guess.
 *
 * One thing that went away with the <select> and is worth naming: the "stray
 * value" option. A <select> can only display strings it holds as options, so a
 * supplier typed through `Other…` — or one whose directory row was deleted after
 * the order was drafted — had to be synthesised as an extra option or the control
 * would silently fall back to displaying its FIRST entry, a form claiming the
 * order was going somewhere it was not. An <input> displays whatever string it
 * is given, so that whole class of bug is gone rather than guarded.
 *
 * ## Inheritance is a first row, never a pre-selected value
 *
 * A line whose supplier or destination is NULL follows the order header, and
 * that null is what gets stored. Pre-selecting the header's concrete name would
 * look identical on screen and be a completely different document: the line
 * would stop tracking the header, so changing the order's destination afterwards
 * would move every line except the ones somebody had merely LOOKED at. So the
 * inherited state gets its own row at the top of the menu, reading
 * `Same as order (RM)`, whose value is null — and it is the placeholder on the
 * empty box too, so an inherited cell reads the same closed as it does open.
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
          // The form still works meanwhile: the box takes any name typed into
          // it, list or no list.
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

/** One heading in the menu. Groups with no names are dropped rather than left
 *  empty — a heading with nothing under it reads as a list that failed to load. */
interface PartyGroup {
  label: string
  names: string[]
}

function PartySelectBase({
  value,
  onChange,
  groups,
  blankLabel,
  customHint,
  requiredPlaceholder,
  ariaLabel,
  className = '',
  drop = false,
  canonical = false
}: {
  /** null or empty means "nothing chosen" — inherited, or not named at all. */
  value: string | null
  onChange: (next: string | null) => void
  groups: PartyGroup[]
  /**
   * The label on the row that clears the field, and the placeholder on the empty
   * box. Absent means the field is REQUIRED: there is no row back to empty, and
   * `requiredPlaceholder` prompts for a name instead.
   */
  blankLabel?: string
  /** The dim footer line naming the escape hatch, in place of the `Other…`
   *  option that used to be the last entry in the list. */
  customHint: string
  /** The placeholder when there is no blank row to name — a required field has
   *  to ask for something rather than sit there empty and silent. */
  requiredPlaceholder: string
  ariaLabel: string
  className?: string
  /** Show the Drop chip beside the control — the caller decides, because on an
   *  inherited cell the answer comes from the header rather than from `value`. */
  drop?: boolean
  /** Fold a hand-typed shelf id back to its canonical spelling. Destinations
   *  only: "rm" typed into a supplier box is just a supplier called rm. */
  canonical?: boolean
}): JSX.Element {
  return (
    <div className={`po-party${className ? ` ${className}` : ''}`}>
      <div className="po-party-row">
        {/* `po-party-select` stays the class on the CONTROL even though the
            control is no longer a <select>. Every rule that sizes one of these —
            the 32px lines-table row, the 30px split row, the phone layer's tap
            floor, the dashed muted look of an inherited cell — is written
            against that name in app.css and mobile.css, and renaming it here
            would silently drop all of them at once. */}
        <Combobox
          className="po-party-select"
          value={value}
          onChange={onChange}
          groups={groups.filter((g) => g.names.length > 0)}
          clearLabel={blankLabel}
          placeholder={blankLabel ?? requiredPlaceholder}
          ariaLabel={ariaLabel}
          allowCustom
          customHint={customHint}
          // Suppliers get no canonicaliser: `canonicalDestination` folds "rm" to
          // the RM shelf, and a supplier genuinely called rm is a supplier, not a
          // shelf. The case-insensitive fold against the list happens either way.
          canonicalize={canonical ? canonicalDestination : undefined}
        />
        {drop && (
          <span
            className="po-drop-chip"
            title="Ships straight to this party — never into RM or AM stock"
          >
            Drop
          </span>
        )}
      </div>
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
      customHint="Not listed? Type the name — whatever you type is the supplier."
      requiredPlaceholder="Search or name the supplier"
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
 * already comes back in, split into headed groups on the two flags it carries.
 * The order is preserved and only labelled, never re-sorted: a filter narrows
 * the groups but never rearranges what is left inside them.
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
  pinnable,
  multi
}: {
  value: string | null
  onChange: (next: string | null) => void
  blankLabel?: string
  ariaLabel: string
  className?: string
  drop?: boolean
  /**
   * Offer "several buyers, named later" as a destination.
   *
   * THE ORDER'S OWN BOX ONLY, never a line's or a split row's. On the header it
   * means "every line that does not say otherwise is going out to buyers I will
   * name on the way to the sales orders", which is a statement about the whole
   * purchase. On a split row — a row that exists precisely to name ONE
   * destination for a slice of a line — it would mean "this slice goes to
   * several buyers", which is just an unsplit line said twice, and it would let
   * an order be half-assigned in two different vocabularies at once.
   */
  multi?: boolean
  /**
   * Show the pin toggle beside the box.
   *
   * Only the ORDER's destination sets this, and it is the one control anywhere
   * in the app that writes a pin. The original typeahead carried a star on every
   * menu row; when that went, the Pinned group was left readable and permanently
   * unfillable — a list that could only ever shrink, and a main-process call with
   * no caller left anywhere in the renderer. One toggle on the header keeps the
   * feature whole. It stays on the header rather than going back into the menu
   * because pinning is a statement about a SHOP, not about a line, and a star on
   * every row of every line's menu offers the same switch a dozen times over.
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
      // Directly under the shelves, because it is the other answer to "where is
      // this going" that is not a party's name — and because a reader scanning
      // for it will not find it filed under E for "Everyone else".
      ...(multi ? [{ label: 'Ships out to buyers', names: [MULTI_SHIPMENT] }] : []),
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
  }, [parties, multi])

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
      customHint="Not listed? Type a shop, a person or an address — it ships there."
      requiredPlaceholder="Search, or type a shop or address"
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

/* -------------------------------------------------------------------------- */
/* Buyers                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Who is receiving these units — a compact box for a table row.
 *
 * ## Why not CustomerTypeahead
 *
 * That control draws its own `Field` with a label and a hint, which is right for
 * the one buyer at the top of a sales order and wrong for a column of them: the
 * buyer-assignment screen has a row per slice, and a labelled field per row
 * would be the same word printed a dozen times down the page. This is the same
 * combobox every supplier and destination cell on both order forms already uses,
 * so a row of it looks like a row of them.
 *
 * ## It reads the party list, not the customer list
 *
 * `useOrderParties` is already fetched once for the whole form and already
 * carries who this business sells to — see OrderParty.kind, where `customer` and
 * `both` are the two that buy. Reaching for `api.invoices.customers()` instead
 * would be a second round trip returning a subset of the same people, and two
 * lists that can disagree about how somebody's name is spelled.
 *
 * SHELVES ARE EXCLUDED. RM and AM are places, not people; offering them here
 * would let somebody raise a sales order billing a shelf.
 */
export function BuyerSelect({
  value,
  onChange,
  ariaLabel,
  className
}: {
  value: string | null
  onChange: (next: string | null) => void
  ariaLabel: string
  className?: string
}): JSX.Element {
  const { parties } = useOrderParties()

  const groups = useMemo<PartyGroup[]>(() => {
    const off = parties.filter((p) => !p.holdsStock)
    return [
      { label: 'Pinned', names: off.filter((p) => p.pinned).map((p) => p.name) },
      {
        label: 'Sold to before',
        names: off.filter((p) => !p.pinned && (p.kind === 'customer' || p.kind === 'both')).map((p) => p.name)
      },
      {
        label: 'Everyone else',
        names: off.filter((p) => !p.pinned && p.kind !== 'customer' && p.kind !== 'both').map((p) => p.name)
      }
    ]
  }, [parties])

  return (
    <PartySelectBase
      value={value}
      onChange={onChange}
      groups={groups}
      // NO BLANK ROW. A row on this screen exists to name one buyer, and there
      // is no header to inherit from — shipmentProblem refuses an empty one, so
      // offering a way back to empty would be offering a refusal.
      customHint="Not listed? Type their name — whatever you type is the buyer."
      requiredPlaceholder="Search, or type a buyer"
      ariaLabel={ariaLabel}
      className={className}
    />
  )
}
