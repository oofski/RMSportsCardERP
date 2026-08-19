import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'

/**
 * A box you click, type into, and pick out of.
 *
 * ## What this is for
 *
 * A curated list that is usually right and occasionally short. Picking from it
 * writes the list's own spelling; typing filters it; and — when the caller allows
 * it — whatever is typed and matches nothing is still a legal answer. Those three
 * together are the reason this exists rather than a <select> (which cannot be
 * typed into at all) or a bare <input> (which cannot offer the list).
 *
 * ## THE MENU IS A PORTAL, AND THAT IS THE WHOLE POINT
 *
 * The first version of the supplier and destination pickers on the purchase-order
 * form were typeaheads with `position: absolute` menus, and they were pulled out
 * for one specific reason: that form is a TABLE INSIDE A MODAL BODY THAT SCROLLS.
 * An absolutely positioned panel in that situation loses three separate ways —
 * it is clipped by the first ancestor with `overflow` set, it is positioned
 * relative to a container that is itself moving, and it slides out from under the
 * pointer the moment the body scrolls. A native <select> has none of those
 * problems because the OS draws its menu outside the page altogether, so the
 * screen was rebuilt on <select> and the bugs were deleted rather than fixed.
 *
 * This control gets the same immunity without giving up typing: the menu is
 * rendered through `createPortal` into `document.body` with `position: fixed`,
 * and placed from the input's `getBoundingClientRect()`. A fixed-position element
 * parented to the body has no overflow ancestor to be clipped by and no scrolling
 * container to be measured against — the two failures are structurally impossible
 * rather than worked around. It also means the menu may be WIDER than the control
 * it belongs to, which is how a 170px table cell can still show
 * "Cardboard Kingdom Collectibles" in full.
 *
 * The third failure — drifting when something scrolls — is handled by refusing to
 * chase it. A capturing scroll listener sees every scroll anywhere in the page,
 * including the ones on the modal body that never reach `window` by bubbling, and
 * CLOSES the menu instead of trying to keep it glued to a box that is moving. The
 * input keeps focus, so ArrowDown or the next keystroke brings the list straight
 * back. A resize re-places rather than closes, because a window being resized is
 * not somebody trying to read something else.
 *
 * ## Events still reach the modal, because portals bubble through REACT
 *
 * A portal moves the DOM node, not the React tree: a mousedown inside the menu
 * still propagates through this component's React ancestors, which is why the
 * modal's `.modal` mousedown guard keeps working and a click on the menu does not
 * dismiss the dialog it visually sits inside. That is load-bearing, so the menu
 * additionally stops propagation on mousedown — a click on a result must never be
 * mistaken for a click OUTSIDE something by any ancestor's dismiss logic.
 *
 * ## Nothing here is Electron-only
 *
 * One bundle serves the desktop window and the browser tab, so this is portals,
 * `getBoundingClientRect` and DOM events and nothing else. There is no native
 * menu to fall back to and none is wanted: the two transports have to behave
 * identically or a bug can only be reproduced on one of them.
 */

/** One heading and the names filed under it. Empty groups are dropped. */
export interface ComboboxGroup {
  label: string
  names: string[]
}

/**
 * One row the menu can commit.
 *
 * `value: null` is the clear row — the entry that means "not set", which is a
 * real answer and not the absence of one. `hit` is where the current filter
 * matched inside `label`, kept so the row can show WHY it is in the list.
 */
interface Entry {
  value: string | null
  label: string
  group: string | null
  hit: [number, number] | null
}

/** How tall the menu is allowed to get before it scrolls itself. */
const MENU_MAX = 320
/** Below this much room under the input, prefer opening upwards. */
const FLIP_UNDER = 200
/**
 * Never let the menu be narrower than this, however narrow its cell is.
 *
 * This is one of the things being parented to the body BUYS. The supplier column
 * in the lines table is 180px and cannot print "Cardboard Kingdom Collectibles",
 * so a menu the width of its control would ellipsise the very names somebody
 * opened it to tell apart. A fixed panel on the body is under no obligation to
 * match the box it belongs to, so it does not.
 */
const MENU_MIN_W = 280
/** Breathing room between the control and the menu, and from the viewport edge. */
const GAP = 4
const EDGE = 8

/** Where the portalled menu is pinned this frame, in viewport coordinates. */
interface MenuBox {
  left: number
  width: number
  maxHeight: number
  /** Exactly one of these is set — `bottom` is the flipped placement, and it is
   *  an anchor rather than a computed top so the menu can grow upwards without
   *  anyone having to know its height first. */
  top?: number
  bottom?: number
  above: boolean
}

/** The matched run of a result, wrapped so it can be tinted. */
function Marked({ label, hit }: { label: string; hit: [number, number] | null }): JSX.Element {
  if (!hit) return <>{label}</>
  return (
    <>
      {label.slice(0, hit[0])}
      <mark className="combo-hit">{label.slice(hit[0], hit[1])}</mark>
      {label.slice(hit[1])}
    </>
  )
}

export function Combobox({
  value,
  onChange,
  groups,
  placeholder,
  ariaLabel,
  allowCustom,
  className = '',
  canonicalize,
  disabled = false,
  clearLabel,
  customHint
}: {
  /** null or empty means nothing is chosen — the placeholder is what shows. */
  value: string | null
  onChange: (next: string | null) => void
  groups: ComboboxGroup[]
  placeholder: string
  ariaLabel: string
  /**
   * May a name that is in no group be committed?
   *
   * False turns this into a picker that merely happens to be searchable: typed
   * text that matches nothing is reverted on the way out rather than kept. True
   * makes the list a set of suggestions and the box the real answer.
   */
  allowCustom: boolean
  /** Goes on the INPUT, not on a wrapper — there is no wrapper. The caller's
   *  layout rules are written against the control itself. */
  className?: string
  /**
   * Fold a typed answer to a house spelling before it is matched against the
   * list. Runs before the case-insensitive fold below, so a canonicaliser that
   * turns "rm" into "RM" hands the list a name it can actually recognise.
   */
  canonicalize?: (raw: string) => string
  disabled?: boolean
  /**
   * The label on a first row whose value is null. Absent means the field is
   * REQUIRED and there is no way back to empty from the menu.
   */
  clearLabel?: string
  /** A dim footer line naming the escape hatch, for when the list is long enough
   *  that "you can just type a new one" is not obvious. Ignored unless
   *  `allowCustom`. */
  customHint?: string
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const listId = useId()

  const [open, setOpen] = useState(false)
  const [box, setBox] = useState<MenuBox | null>(null)

  /**
   * What has been TYPED, or null for "showing the current choice".
   *
   * Deliberately not "the input's text is the query". This box is rarely empty —
   * it opens holding RM, or a supplier bought from every week — so treating its
   * contents as a filter would narrow the list to the single entry already
   * chosen and hide every alternative behind a backspace. Clicking in shows
   * everything; only a keystroke narrows it.
   */
  const [draft, setDraft] = useState<string | null>(null)

  /** Which row the keyboard is on. An index into `entries`, never into a group. */
  const [hi, setHi] = useState(0)

  const current = (value ?? '').trim()
  const filter = (draft ?? '').trim()
  const needle = filter.toLowerCase()

  const names = useMemo(() => groups.flatMap((g) => g.names), [groups])

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = []
    const push = (label: string, val: string | null, group: string | null): void => {
      if (!needle) {
        out.push({ value: val, label, group, hit: null })
        return
      }
      const at = label.toLowerCase().indexOf(needle)
      if (at < 0) return
      out.push({ value: val, label, group, hit: [at, at + needle.length] })
    }
    if (clearLabel !== undefined) push(clearLabel, null, null)
    for (const g of groups) for (const n of g.names) push(n, n, g.label)
    return out
  }, [groups, clearLabel, needle])

  /**
   * The flat list re-folded into the runs the menu draws.
   *
   * Kept as a second pass over `entries` rather than as the primary structure so
   * that every index the keyboard, `aria-activedescendant` and the scroll-into-
   * view maths deal in is an index into ONE array. A nested model would need the
   * highlight to be a (group, row) pair, and every off-by-one in that pair is a
   * menu that highlights one row and commits another.
   */
  const blocks = useMemo(() => {
    const out: Array<{ group: string | null; items: Array<{ entry: Entry; index: number }> }> = []
    entries.forEach((entry, index) => {
      const last = out[out.length - 1]
      if (last && last.group === entry.group) last.items.push({ entry, index })
      else out.push({ group: entry.group, items: [{ entry, index }] })
    })
    return out
  }, [entries])

  /* ------------------------------------------------------------------------ */
  /* Placement                                                                 */
  /* ------------------------------------------------------------------------ */

  const place = useCallback((): void => {
    const el = inputRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const below = window.innerHeight - r.bottom - GAP - EDGE
    const above = r.top - GAP - EDGE
    // Flip only when going down would genuinely be worse. A menu that jumps
    // above the control for the sake of thirty extra pixels is a menu that
    // appears in a different place each time the modal is scrolled a little.
    const flip = below < FLIP_UNDER && above > below
    const width = Math.max(r.width, MENU_MIN_W)
    const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - width - EDGE))
    const room = Math.max(120, Math.min(MENU_MAX, flip ? above : below))
    setBox(
      flip
        ? { left, width, maxHeight: room, bottom: window.innerHeight - r.top + GAP, above: true }
        : { left, width, maxHeight: room, top: r.bottom + GAP, above: false }
    )
  }, [])

  // Before paint, so the menu never renders one frame at the wrong coordinates.
  useLayoutEffect(() => {
    if (open) place()
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const onScroll = (e: Event): void => {
      // The menu scrolling ITSELF is not the page moving under it — including
      // the programmatic scrollTop below, which fires here like any other.
      const t = e.target
      if (menuRef.current && t instanceof Node && menuRef.current.contains(t)) return
      setOpen(false)
    }
    // Capturing, because a modal body scrolling does not bubble a scroll event
    // to window at all: a listener without `true` here would simply never fire,
    // which is exactly the case this control has to survive.
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', place)
    }
  }, [open, place])

  /* ------------------------------------------------------------------------ */
  /* Committing                                                                */
  /* ------------------------------------------------------------------------ */

  const commit = useCallback(
    (next: string | null): void => {
      setDraft(null)
      setOpen(false)
      onChange(next)
    },
    [onChange]
  )

  /**
   * Take what is in the box as the answer — the blur and the no-highlight Enter.
   *
   * THIS IS THE FUNCTION THAT KEEPS THE VENDOR LIST FROM FRAGMENTING. A typed
   * name that already exists, in any casing or with any stray spacing, is folded
   * to the spelling the list holds, so "bramble wholesale" typed on Thursday is
   * stored as the "Bramble Wholesale" that Monday's order was filed under. Only
   * a name that genuinely matches nothing is kept as typed, and only when the
   * caller allows one at all.
   */
  const commitTyped = useCallback((): void => {
    if (draft === null) {
      setOpen(false)
      return
    }
    const raw = draft.trim()
    if (!raw) {
      commit(null)
      return
    }
    const folded = canonicalize ? canonicalize(raw) : raw
    const known = names.find((n) => n.toLowerCase() === folded.toLowerCase())
    if (known) {
      commit(known)
      return
    }
    if (allowCustom) {
      commit(folded)
      return
    }
    // A picker that does not take new names cannot be left holding one, so the
    // half-typed query is discarded and the previous choice stands.
    setDraft(null)
    setOpen(false)
  }, [draft, canonicalize, names, allowCustom, commit])

  /* ------------------------------------------------------------------------ */
  /* Opening, and where the highlight starts                                   */
  /* ------------------------------------------------------------------------ */

  /**
   * Put the highlight on the row that is already chosen.
   *
   * So ArrowDown moves on from the current answer rather than from the top of a
   * list it may be a long way down. Falls to the first row when the value is not
   * in the list at all, which is every hand-typed name.
   */
  const highlightCurrent = useCallback((): void => {
    const at = entries.findIndex(
      (e) => e.value !== null && e.value.toLowerCase() === current.toLowerCase()
    )
    setHi(at >= 0 ? at : 0)
  }, [entries, current])

  /**
   * Reopen WITHOUT touching the draft.
   *
   * The menu can be shut while a filter is still half typed — an ancestor
   * scrolling closes it on purpose, and the box keeps focus. Clearing the draft
   * on the way back in would throw that filter away and dump the whole list on
   * somebody who had already narrowed it to two rows, which is the opposite of
   * what pressing ArrowDown was asking for.
   */
  const reopen = useCallback((): void => {
    setOpen(true)
    if (draft === null) highlightCurrent()
  }, [draft, highlightCurrent])

  // A filter that has changed has invalidated wherever the highlight was: the
  // row it pointed at is very likely gone, and a stale index commits whatever
  // has slid into its place.
  useEffect(() => {
    setHi(0)
  }, [needle])

  // Keep the highlighted row on screen without letting the browser scroll
  // anything else to do it — `scrollIntoView` is free to move ancestors, and the
  // ancestor here is the modal body, which would close the menu on its way past.
  useEffect(() => {
    const menu = menuRef.current
    if (!open || !menu) return
    const row = menu.querySelector<HTMLElement>(`[data-idx="${hi}"]`)
    if (!row) return
    if (row.offsetTop < menu.scrollTop) menu.scrollTop = row.offsetTop
    else if (row.offsetTop + row.offsetHeight > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = row.offsetTop + row.offsetHeight - menu.clientHeight
    }
  }, [hi, open, entries])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (disabled) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) {
        reopen()
        return
      }
      if (entries.length === 0) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      setHi((n) => (n + step + entries.length) % entries.length)
      return
    }
    if (e.key === 'Home' && open && entries.length > 0) {
      e.preventDefault()
      setHi(0)
      return
    }
    if (e.key === 'End' && open && entries.length > 0) {
      e.preventDefault()
      setHi(entries.length - 1)
      return
    }
    if (e.key === 'Enter') {
      if (!open) return
      // Both halves matter: preventDefault so a surrounding form does not submit
      // on the keystroke that was picking a supplier, and stopPropagation for the
      // same reason Escape needs it below.
      e.preventDefault()
      e.stopPropagation()
      // The HIGHLIGHTED row wins over the typed text whenever there is one, which
      // is the contract every combobox keeps and the reason the highlight is
      // drawn at all. It does mean that typing a name which is a strict prefix of
      // a listed one — "Bram", with "Bramble Wholesale" showing — commits the
      // list's entry rather than the four letters. Tab or clicking away is the
      // way to insist on exactly what was typed, and the filter finding nothing
      // (the common case for a genuinely new name) lands here anyway.
      const entry = entries[hi]
      if (entry) commit(entry.value)
      else commitTyped()
      return
    }
    if (e.key === 'Escape') {
      if (!open) return
      // The modal listens for Escape on WINDOW. Without this, dismissing a
      // dropdown would throw away the whole half-filled purchase order behind
      // it. Stopping propagation in a React handler stops the native event at
      // the React root, so the window listener never runs — and when the menu is
      // already closed we fall through and Escape closes the modal as it should.
      e.preventDefault()
      e.stopPropagation()
      setDraft(null)
      setOpen(false)
      return
    }
    if (e.key === 'Tab') {
      // No preventDefault: focus is supposed to move. Closing here rather than
      // waiting for blur means the menu is gone in the same frame the focus ring
      // lands on the next control. The commit happens in blur, which fires for
      // this and for clicking away alike.
      setOpen(false)
    }
  }

  const menu =
    open && !disabled && box
      ? createPortal(
          <div
            id={listId}
            ref={menuRef}
            role="listbox"
            aria-label={ariaLabel}
            className={`combo-menu${box.above ? ' is-above' : ''}`}
            style={{
              left: box.left,
              width: box.width,
              maxHeight: box.maxHeight,
              ...(box.above ? { bottom: box.bottom } : { top: box.top })
            }}
            onMouseDown={(e) => {
              // preventDefault keeps focus in the input, so the blur-commit does
              // not fire and steal the click before it lands on a row.
              // stopPropagation keeps any ancestor's click-outside logic from
              // reading a click on our own menu as a click elsewhere — which it
              // otherwise would, because portalled events bubble through React.
              e.preventDefault()
              e.stopPropagation()
            }}
          >
            {blocks.map((block, bi) => {
              const rows = block.items.map(({ entry, index }) => (
                <div
                  key={`${entry.group ?? ''}-${entry.label}-${index}`}
                  id={`${listId}-o${index}`}
                  data-idx={index}
                  role="option"
                  aria-selected={entry.value !== null && entry.value.toLowerCase() === current.toLowerCase()}
                  className={`combo-option${index === hi ? ' is-active' : ''}${
                    entry.value === null ? ' combo-clear' : ''
                  }${
                    entry.value !== null && entry.value.toLowerCase() === current.toLowerCase()
                      ? ' is-current'
                      : ''
                  }`}
                  title={entry.label}
                  onMouseEnter={() => setHi(index)}
                  onClick={() => commit(entry.value)}
                >
                  <Marked label={entry.label} hit={entry.hit} />
                </div>
              ))
              // A Fragment rather than a wrapper div: `role="listbox"` may only
              // hold options and groups, and a bare element between the two
              // breaks the relationship a screen reader counts rows with.
              if (block.group === null) return <Fragment key={`g${bi}`}>{rows}</Fragment>
              return (
                <div key={`g${bi}`} role="group" aria-labelledby={`${listId}-h${bi}`}>
                  <div className="combo-group" id={`${listId}-h${bi}`}>
                    {block.group}
                  </div>
                  {rows}
                </div>
              )
            })}

            {entries.length === 0 && (
              <div className="combo-empty">
                {allowCustom
                  ? `No match for “${filter}” — press Enter to use it exactly as typed.`
                  : `Nothing here matches “${filter}”.`}
              </div>
            )}

            {entries.length > 0 && allowCustom && customHint && (
              <div className="combo-hint">{customHint}</div>
            )}
          </div>,
          document.body
        )
      : null

  return (
    <>
      <input
        ref={inputRef}
        className={`input combo-input ${className}`.trim()}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-haspopup="listbox"
        aria-autocomplete="list"
        aria-activedescendant={open && entries[hi] ? `${listId}-o${hi}` : undefined}
        aria-label={ariaLabel}
        // A narrow column clips rather than ellipsises, and the tooltip is the
        // only way to read a long name without changing it. Suppressed while
        // typing, where a tooltip over your own caret is just in the way.
        title={draft === null ? current || placeholder : undefined}
        value={draft ?? current}
        placeholder={placeholder}
        disabled={disabled}
        // The browser's own autofill menu would open on top of this one, over a
        // field whose list is the point of the control.
        autoComplete="off"
        spellCheck={false}
        onFocus={(e) => {
          // A fresh arrival, so the list opens WHOLE. Never "the box's contents
          // are the query": this box is rarely empty, and filtering by what is
          // already in it would narrow the list to the single row already chosen
          // and hide every alternative behind a backspace.
          setOpen(true)
          setDraft(null)
          highlightCurrent()
          // Select rather than place a caret: the box usually already holds a
          // name, and typing into the middle of one produces a supplier called
          // "Bramxble Wholesale". A second click inside a focused input still
          // places the caret, which is how an existing name gets edited.
          e.target.select()
        }}
        onClick={() => {
          // Focus alone is not enough: Escape and an ancestor scroll both leave
          // the box focused with the menu shut, and clicking it again has to
          // bring the list back.
          if (!open) reopen()
        }}
        onChange={(e) => {
          const text = e.target.value
          setDraft(text)
          setOpen(true)
          // Pushed straight through rather than held until blur. The parent
          // renders things off this value — the Drop chip, an inherited row's
          // muted styling — and, more importantly, a Save button clicked while
          // the caret is still in the box must not be able to save the value
          // from before the last few keystrokes.
          onChange(text.trim() ? text : null)
        }}
        onKeyDown={onKeyDown}
        onBlur={commitTyped}
      />
      {menu}
    </>
  )
}
