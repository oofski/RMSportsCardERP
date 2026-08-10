import { useCallback, useMemo, useRef, useState } from 'react'
import type { InventoryProduct } from '@shared/types'
import {
  catalogQueriesFor,
  lineTotalOf,
  matchOfferLine,
  offerTotal,
  parseSupplierOffer,
  pricingNote,
  unitLabel,
  unitPriceOf,
  type OfferLine,
  type OfferMatch,
  type ParsedOfferLine,
  type PriceBasis
} from '@shared/supplierOffers'
import { api } from '../../lib/api'
import { Button, Field, Input, Textarea } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { formatMoney, formatUnitMoney } from '../../lib/format'
import { POCatalogTypeahead } from './POCatalogTypeahead'

/**
 * Paste a supplier's message, check what it says, then add it to the order.
 *
 * The owner receives offers as text messages and was retyping them into the PO
 * form. This reads the message with @shared/supplierOffers — deterministic
 * string parsing, no model, no network — and lays the result out as a REVIEW,
 * never as a purchase order.
 *
 * ## Why a review and not a shortcut
 *
 * Two things on every row are worth a person's eye, and both are money:
 *
 *   THE PRODUCT. A line attached to the wrong catalog row prices stock at
 *   another product's cost and corrupts the basis of both for as long as either
 *   is on the shelf. So only an unambiguous match arrives pre-selected;
 *   anything else asks.
 *
 *   WHAT WAS NOT UNDERSTOOD. A line the parser could not read stays on screen
 *   with its original text. Nine lines pasted show nine rows, which is the one
 *   property that lets somebody trust everything else on the screen.
 *
 * ## Per case, on every row, with a way out
 *
 * Every line is read as a price per case — the owner's ruling, after the lists
 * turned out to carry the word "per" at random rather than meaningfully. So
 * nothing here marks a row out for having said it: a badge on those rows would
 * invite somebody to "fix" a line that was already right, which is the failure
 * mode of showing a distinction that no longer means anything.
 *
 * The FLIP is still on every row. A supplier will eventually quote a lot price,
 * and a review that could not express it would send the operator back to
 * retyping the whole line to correct one number. Switching a row recomputes its
 * unit price and its total on the spot, from the same figure the purchase order
 * will store.
 *
 * Nothing here writes anything. Applying the review appends draft lines to the
 * create form, which the operator still has to submit.
 */

/** What the review hands back: a catalog product with a quantity and a price. */
export interface OfferDraftLine {
  product: InventoryProduct
  quantity: number
  /** Per-unit, already resolved from the row's per-case / total reading. */
  unitPrice: number
}

interface ReviewRow {
  /** Stable across edits — the parser's line number, which cannot repeat. */
  key: number
  /** The parse, as read. Kept so the row can always show what changed. */
  parsed: OfferLine
  /** The editable copy. Null for a line that could not be parsed. */
  draft: ParsedOfferLine | null
  /** Include this row when the review is applied. */
  include: boolean
  match: OfferMatch<InventoryProduct> | null
  /** Still asking the catalog. */
  searching: boolean
  product: InventoryProduct | null
  /** The per-row catalog search is open. */
  searchOpen: boolean
}

export function PasteOfferPanel({
  onApply
}: {
  onApply: (lines: OfferDraftLine[]) => void
}): JSX.Element {
  /**
   * OPEN FROM THE START.
   *
   * This was a button you pressed to reveal the box, and the owner's first
   * attempt went into the catalog search directly beneath it — a wide, obvious
   * text field, where a collapsed button is not one. Nine lines of a supplier's
   * message landed in a product search, which found nothing and explained
   * nothing.
   *
   * A textarea that is already there cannot lose that race. Nothing is parsed
   * until there is text and nothing is ordered until the rows are confirmed, so
   * showing it costs a few lines of height and removes the only way to
   * misunderstand the screen.
   */
  const [open, setOpen] = useState(true)
  const [text, setText] = useState('')
  const [rows, setRows] = useState<ReviewRow[] | null>(null)
  const [ignored, setIgnored] = useState<{ lineNumber: number; raw: string; reason: string }[]>([])
  const [showIgnored, setShowIgnored] = useState(false)
  const [error, setError] = useState('')
  // Bumped on every parse. A search that comes back after the operator has
  // re-pasted belongs to a review that no longer exists, and applying it would
  // attach a product to whatever row now happens to sit at that index.
  const run = useRef(0)

  const parse = useCallback((): void => {
    const result = parseSupplierOffer(text)
    if (result.lines.length === 0) {
      setError(
        result.consideredLines === 0
          ? 'Nothing to read — paste the message first.'
          : 'Nothing on those lines reads as an offer. A line needs a "$" price.'
      )
      return
    }
    setError('')
    setIgnored(result.ignored)
    setShowIgnored(false)
    const fresh: ReviewRow[] = result.lines.map((line) => ({
      key: line.lineNumber,
      parsed: line,
      draft: line.ok ? { ...line } : null,
      // An unparsed line has nothing to order, so it cannot be included — but
      // it is still a row, because the count of rows is what proves nothing
      // was dropped.
      include: line.ok,
      match: null,
      searching: line.ok,
      product: null,
      searchOpen: false
    }))
    setRows(fresh)
    const generation = ++run.current

    // Ask the catalog about every parsed row. Deliberately the SAME search the
    // typeahead beside it uses (api.purchaseOrders.searchCatalog), so a product
    // this screen cannot find is one the operator could not have found by
    // typing either — the two can never disagree about what is in the catalog.
    void (async () => {
      for (const row of fresh) {
        const line = row.draft
        if (!line) continue
        let found: InventoryProduct[] = []
        // The query ladder, most specific first. Stopping at the first query
        // that returns anything is what keeps a backed-off search from burying
        // an exact match under a page of near-misses.
        for (const query of catalogQueriesFor(line)) {
          found = await api.purchaseOrders.searchCatalog(query)
          if (found.length > 0) break
        }
        // A search that lands after the operator has re-pasted belongs to a
        // review that no longer exists; applying it would attach a product to
        // whatever row now carries that line number.
        if (generation !== run.current) return
        const match = matchOfferLine(line, found)
        setRows(
          (prev) =>
            prev?.map((r) =>
              r.key === row.key
                ? {
                    ...r,
                    searching: false,
                    match,
                    // Only an unambiguous match is pre-selected. See the header.
                    product: match.confidence === 'confident' ? match.selected : null
                  }
                : r
            ) ?? prev
        )
      }
    })()
  }, [text])

  const patch = (key: number, change: Partial<ReviewRow>): void => {
    setRows((prev) => prev?.map((r) => (r.key === key ? { ...r, ...change } : r)) ?? prev)
  }

  const patchDraft = (key: number, change: Partial<ParsedOfferLine>): void => {
    setRows(
      (prev) =>
        prev?.map((r) => (r.key === key && r.draft ? { ...r, draft: { ...r.draft, ...change } } : r)) ??
        prev
    )
  }

  const ready = useMemo(
    () => (rows ?? []).filter((r) => r.include && r.draft && r.product),
    [rows]
  )
  const runningTotal = useMemo(
    () => offerTotal(ready.map((r) => r.draft as ParsedOfferLine)),
    [ready]
  )

  const apply = (): void => {
    if (ready.length === 0) {
      setError('No row is ready — every line needs a catalog product before it can be ordered.')
      return
    }
    // The create form keys its lines by product, so two rows pointing at one
    // product cannot both survive. Merging them would have to invent a price
    // out of two different ones, so the review says which rows collide and lets
    // a person decide instead.
    const seen = new Map<string, number>()
    for (const r of ready) {
      const id = (r.product as InventoryProduct).id
      const first = seen.get(id)
      if (first !== undefined) {
        setError(
          `Lines ${first} and ${r.key} both point at ${(r.product as InventoryProduct).name}. ` +
            'A purchase order holds one line per product — pick different products or drop one.'
        )
        return
      }
      seen.set(id, r.key)
    }
    setError('')
    onApply(
      ready.map((r) => ({
        product: r.product as InventoryProduct,
        quantity: (r.draft as ParsedOfferLine).quantity,
        unitPrice: unitPriceOf(r.draft as ParsedOfferLine)
      }))
    )
    setRows(null)
    setIgnored([])
    setText('')
    setOpen(false)
  }

  const discard = (): void => {
    setRows(null)
    setIgnored([])
    setError('')
  }

  if (!open) {
    return (
      <div className="offer-open">
        <Button icon="ClipboardPaste" onClick={() => setOpen(true)}>
          Paste a supplier message
        </Button>
        <span className="offer-open-hint">
          Reads the offer into rows you check before anything is ordered.
        </span>
      </div>
    )
  }

  return (
    <div className="offer-panel">
      <div className="offer-panel-head">
        <div>
          <h4>Paste a supplier message</h4>
          <p>
            One offer per line. Nothing is ordered until you check the rows and add them below.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setOpen(false)
            discard()
          }}
        >
          <Icon name="X" size={15} />
          Close
        </button>
      </div>

      {error && <div className="auth-alert">{error}</div>}

      {rows === null ? (
        <>
          <Field
            label="The message"
            hint="e.g. 26 Reflector FB Crest-$3150 (4cs) — one per line. Greetings and headings are left out."
          >
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={7}
              placeholder="Paste the whole message here…"
            />
          </Field>
          <div className="offer-actions">
            <Button variant="primary" icon="ListChecks" onClick={parse} disabled={!text.trim()}>
              Read the message
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="offer-summary">
            <span>
              <strong>{rows.length}</strong> {rows.length === 1 ? 'row' : 'rows'} read
            </span>
            {ignored.length > 0 && (
              <button type="button" className="offer-link" onClick={() => setShowIgnored((s) => !s)}>
                {ignored.length} line{ignored.length === 1 ? '' : 's'} left out
                <Icon name={showIgnored ? 'ChevronUp' : 'ChevronDown'} size={14} />
              </button>
            )}
            <span className="offer-summary-total">
              {ready.length} ready · <span className="mono">{formatMoney(runningTotal)}</span>
            </span>
          </div>

          {showIgnored && (
            <ul className="offer-ignored">
              {ignored.map((g) => (
                <li key={g.lineNumber}>
                  <span className="offer-num">{g.lineNumber}</span>
                  <code>{g.raw}</code>
                  <em>{g.reason}</em>
                </li>
              ))}
            </ul>
          )}

          <div className="offer-rows">
            {rows.map((row) => (
              <OfferReviewRow
                key={row.key}
                row={row}
                onToggleInclude={(v) => patch(row.key, { include: v })}
                onPatchDraft={(change) => patchDraft(row.key, change)}
                onPickProduct={(p) => patch(row.key, { product: p, searchOpen: false })}
                onToggleSearch={() => patch(row.key, { searchOpen: !row.searchOpen })}
              />
            ))}
          </div>

          <div className="offer-actions">
            <Button variant="ghost" onClick={discard}>
              Start over
            </Button>
            <Button variant="primary" icon="Plus" onClick={apply} disabled={ready.length === 0}>
              Add {ready.length} {ready.length === 1 ? 'line' : 'lines'} to the order
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * One row of the review.
 *
 * Reads top to bottom as: what the supplier wrote, what that was understood to
 * mean, and which product it is going against. The supplier's own line is
 * printed first and verbatim because it is the thing being checked — every
 * other field on the row is a claim about it.
 */
function OfferReviewRow({
  row,
  onToggleInclude,
  onPatchDraft,
  onPickProduct,
  onToggleSearch
}: {
  row: ReviewRow
  onToggleInclude: (include: boolean) => void
  onPatchDraft: (change: Partial<ParsedOfferLine>) => void
  onPickProduct: (p: InventoryProduct) => void
  onToggleSearch: () => void
}): JSX.Element {
  const line = row.draft

  if (!line) {
    const reason = row.parsed.ok ? '' : row.parsed.reason
    return (
      <div className="offer-row is-unparsed">
        <div className="offer-raw">
          <span className="offer-num">{row.key}</span>
          <code>{row.parsed.raw}</code>
        </div>
        <div className="offer-unread">
          <Icon name="AlertTriangle" size={15} />
          <span>
            <strong>Not read.</strong> {reason} Add it by hand below if it is an order line.
          </span>
        </div>
      </div>
    )
  }

  const unit = unitLabel(line.unit, 1)
  const note = pricingNote(line)
  const perUnitPrice = unitPriceOf(line)
  const total = lineTotalOf(line)
  const setBasis = (basis: PriceBasis): void => onPatchDraft({ basis })

  return (
    <div className="offer-row">
      <div className="offer-raw">
        <label className="offer-include">
          <input
            type="checkbox"
            checked={row.include}
            onChange={(e) => onToggleInclude(e.target.checked)}
            aria-label={`Include line ${row.key}`}
          />
          <span className="offer-num">{row.key}</span>
        </label>
        <code>{row.parsed.raw}</code>
      </div>

      <div className="offer-read">
        <div className="offer-fact">
          <span className="offer-fact-label">Season</span>
          <span className="offer-fact-value">{line.season ? line.season.label : '—'}</span>
        </div>
        <div className="offer-fact offer-fact-grow">
          <span className="offer-fact-label">Product</span>
          <span className="offer-fact-value">{line.productText}</span>
          {line.expansions.length > 0 && (
            <span className="offer-fact-note">
              searched as {line.expansions.map((e) => `${e.from} → ${e.to}`).join(', ')}
            </span>
          )}
        </div>
        <div className="offer-fact">
          <span className="offer-fact-label">{line.basis === 'total' ? 'Order total' : `Per ${unit}`}</span>
          <Input
            type="number"
            min={0}
            step="0.01"
            className="offer-price-input"
            value={String(line.price)}
            onChange={(e) => onPatchDraft({ price: Number(e.target.value) || 0 })}
          />
        </div>
        <div className="offer-fact">
          <span className="offer-fact-label">{unitLabel(line.unit, line.quantity)}</span>
          <Input
            type="number"
            min={1}
            step={1}
            className="offer-qty-input"
            value={String(line.quantity)}
            onChange={(e) => onPatchDraft({ quantity: parseInt(e.target.value, 10) || 0 })}
          />
          {line.quantityAssumed && <span className="offer-fact-note">assumed — none on the line</span>}
        </div>
        <div className="offer-fact offer-fact-total">
          <span className="offer-fact-label">Line total</span>
          <span className="offer-fact-value mono">{formatMoney(total)}</span>
          {line.basis === 'total' && line.quantity > 0 && (
            <span className="offer-fact-note mono">{formatUnitMoney(perUnitPrice)} each</span>
          )}
        </div>
      </div>

      {/* Every line is read as a case price, whether or not it said "per" — so
          nothing here marks one row out from another for having said it. The
          control is still on every row because a supplier will eventually quote
          a lot price, and flipping one row beats retyping the line. */}
      <div className="offer-basis">
        <div className="offer-basis-toggle" role="group" aria-label="How to read the price">
          <button
            type="button"
            className={line.basis === 'per-unit' ? 'is-on' : ''}
            onClick={() => setBasis('per-unit')}
          >
            Per {unit}
          </button>
          <button
            type="button"
            className={line.basis === 'total' ? 'is-on' : ''}
            onClick={() => setBasis('total')}
          >
            Order total
          </button>
        </div>
        {note && (
          <span className="offer-basis-note">
            <Icon name="AlertTriangle" size={13} />
            {note}
          </span>
        )}
      </div>

      <OfferRowMatch
        row={row}
        onPickProduct={onPickProduct}
        onToggleSearch={onToggleSearch}
        line={line}
      />
    </div>
  )
}

/** The catalog half of a row: what it matched, or what it needs. */
function OfferRowMatch({
  row,
  line,
  onPickProduct,
  onToggleSearch
}: {
  row: ReviewRow
  line: ParsedOfferLine
  onPickProduct: (p: InventoryProduct) => void
  onToggleSearch: () => void
}): JSX.Element {
  if (row.searching) {
    return (
      <div className="offer-match">
        <span className="spinner dark" />
        <span className="offer-match-note">Looking in the catalog…</span>
      </div>
    )
  }

  const match = row.match
  const options = match?.options ?? []
  const state = row.product ? 'matched' : (match?.confidence ?? 'none')

  return (
    <div className={`offer-match is-${state}`}>
      {row.product ? (
        <>
          <Icon name="CheckCircle2" size={15} />
          <span className="offer-match-name">{row.product.name}</span>
          <span className="offer-match-sub mono">{row.product.sku}</span>
        </>
      ) : (
        <>
          <Icon name="AlertCircle" size={15} />
          <span className="offer-match-note">
            {match?.note ?? 'No product chosen yet.'}
          </span>
        </>
      )}

      {options.length > 0 && (
        <select
          className="select offer-match-select"
          value={row.product?.id ?? ''}
          onChange={(e) => {
            const picked = options.find((o) => o.product.id === e.target.value)
            if (picked) onPickProduct(picked.product)
          }}
        >
          <option value="">Pick a product…</option>
          {options.map((o) => (
            <option key={o.product.id} value={o.product.id}>
              {o.product.name}
              {o.unitMismatch ? ` — stocked in ${o.product.unitType}` : ''}
            </option>
          ))}
        </select>
      )}

      <button type="button" className="offer-link" onClick={onToggleSearch}>
        <Icon name="Search" size={14} />
        {row.searchOpen ? 'Close search' : 'Search the catalog'}
      </button>

      {row.searchOpen && (
        <div className="offer-match-search">
          <POCatalogTypeahead
            onSelect={onPickProduct}
            label="Find this product"
            hint="The same catalog search as the box above the line items"
            placeholder="Product name, SKU or UPC…"
            initialQuery={line.searchText}
          />
        </div>
      )}
    </div>
  )
}
