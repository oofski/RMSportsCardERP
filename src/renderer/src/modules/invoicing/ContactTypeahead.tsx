import { useEffect, useMemo, useState } from 'react'
import type { SupplierSuggestion } from '@shared/purchaseOrders'
import { api } from '../../lib/api'
import { Field, Input } from '../../components/ui'

/**
 * The supplier box, backed by the contact list.
 *
 * ## What this does NOT do
 *
 * It does not attach a record to the purchase order. A PO's supplier is a
 * string on the document and stays one — see @shared/purchaseOrders for the
 * argument — so picking a name TYPES it, exactly as if it had been typed by
 * hand, and the PO is identical either way. That is what makes this safe to add
 * to a form that has been saving free text since the module shipped.
 *
 * ## Free text is still the point
 *
 * Whatever is in the box wins, matched or not. A one-off buy from somebody who
 * will never be a contact must not require a detour into a contacts screen
 * first — the same rule CustomerTypeahead states for buyers, and the same rule
 * the catalog search follows for products.
 *
 * ## Searching more than the name
 *
 * Email and city too, because the contact list files people as "Ada Fenwick
 * (NC-FENCO) Fenwick Cards" and half the time what somebody has to hand is the
 * shop, the town or the address an order came from rather than the person.
 */
export function ContactTypeahead({
  value,
  onChange,
  label = 'Supplier',
  hint = 'Search your contacts, or type any name',
  placeholder = 'Start typing a supplier or contact…',
  /**
   * Drop the Field wrapper.
   *
   * For a split row, where the column heading above already names the field and
   * a second label per row would be four words of furniture repeated per
   * allocation. The typeahead itself is unchanged — same markup, same keyboard
   * behaviour, same free-text rule.
   */
  inline = false,
  ariaLabel
}: {
  value: string
  onChange: (name: string) => void
  label?: string
  hint?: string
  placeholder?: string
  inline?: boolean
  ariaLabel?: string
}): JSX.Element {
  const [options, setOptions] = useState<SupplierSuggestion[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let live = true
    void api.purchaseOrders.suppliers().then((rows) => {
      if (live) setOptions(rows)
    })
    return () => {
      live = false
    }
  }, [])

  const matches = useMemo(() => {
    const q = value.trim().toLowerCase()
    // No query means the list is already in the useful order — suppliers used
    // most recently first — so it is offered unfiltered rather than hidden. On
    // a form whose supplier is usually one of four distributors, that is the
    // answer without a keystroke.
    if (!q) return options.slice(0, 8)
    return options
      .filter((o) => o.name.toLowerCase().includes(q) || (o.detail ?? '').toLowerCase().includes(q))
      .slice(0, 8)
  }, [options, value])

  // An exact hit needs no menu: the box already says what would be picked.
  const settled = matches.length === 1 && matches[0].name.toLowerCase() === value.trim().toLowerCase()

  const box = (
    <Input
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel ?? (inline ? label : undefined)}
      onFocus={() => setOpen(true)}
      onChange={(e) => {
        onChange(e.target.value)
        setOpen(true)
      }}
      // Late enough that a click on a result lands before the list closes.
      onBlur={() => window.setTimeout(() => setOpen(false), 160)}
    />
  )

  return (
    <div className={`typeahead${inline ? ' ct-inline' : ''}`}>
      {inline ? box : <Field label={label} hint={hint}>{box}</Field>}

      {open && !settled && matches.length > 0 && (
        <div className="ta-menu">
          {matches.map((o) => (
            <button
              key={`${o.source}-${o.name}`}
              type="button"
              className="ta-item"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(o.name)
                setOpen(false)
              }}
            >
              <span className="ta-name">{o.name}</span>
              <span className="ta-sub">
                {[
                  o.detail,
                  o.source === 'contact' && o.usedOnOrders
                    ? `${o.usedOnOrders} previous ${o.usedOnOrders === 1 ? 'order' : 'orders'}`
                    : null
                ]
                  .filter(Boolean)
                  .join(' · ') || 'No details yet'}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
