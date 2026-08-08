import { useMemo, useState } from 'react'
import type { InvoiceCustomer } from '@shared/invoices'
import { Field, Input } from '../../components/ui'

/**
 * Pick the buyer, and the rest of the invoice fills itself in.
 *
 * Deliberately the same shape as POCatalogTypeahead — type, see matches, click
 * one — rather than a dropdown. A `<select>` is fine for five buyers and
 * unusable at fifty, and the buy side already established the pattern somebody
 * on this floor has learned.
 *
 * ## It searches more than the name
 *
 * Email too, because half the time what somebody has to hand is the address a
 * payment came from rather than how the buyer is filed. Matching on both costs
 * nothing and removes the one case where the picker looks broken.
 *
 * ## Typing a name nobody has is allowed
 *
 * A one-off buyer should not require a detour into a buyers screen before an
 * invoice can be written. So whatever is typed stands as the name, and the
 * result list is an offer rather than a gate — the same way the product search
 * lets you name something the catalog has not got.
 */
export function CustomerTypeahead({
  customers,
  value,
  onPick,
  onType
}: {
  customers: InvoiceCustomer[]
  /** The name currently on the invoice. */
  value: string
  /** A saved buyer was chosen — take everything they carry. */
  onPick: (customer: InvoiceCustomer) => void
  /** Free text was typed — it is the name, and no buyer is attached. */
  onType: (name: string) => void
}): JSX.Element {
  const [query, setQuery] = useState(value)
  const [open, setOpen] = useState(false)

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return customers.slice(0, 8)
    return customers
      .filter(
        (c) =>
          c.name.toLowerCase().includes(q) || (c.email ?? '').toLowerCase().includes(q)
      )
      .slice(0, 8)
  }, [customers, query])

  return (
    <div className="typeahead">
      <Field label="Buyer" hint="Search saved buyers, or type a new name">
        <Input
          value={query}
          placeholder="Start typing a buyer's name or email…"
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
            onType(e.target.value)
          }}
          // Late enough that a click on a result lands before the list closes.
          onBlur={() => window.setTimeout(() => setOpen(false), 160)}
        />
      </Field>

      {open && matches.length > 0 && (
        <div className="ta-menu">
          {matches.map((c) => (
            <button
              key={c.id}
              type="button"
              className="ta-item"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setQuery(c.name)
                setOpen(false)
                onPick(c)
              }}
            >
              <span className="ta-name">{c.name}</span>
              <span className="ta-sub">
                {[c.email, c.terms, c.location].filter(Boolean).join(' · ') || 'No details yet'}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
