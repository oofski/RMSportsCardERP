import { useEffect, useMemo, useRef, useState } from 'react'
import type { InventoryProduct } from '@shared/types'
import type { NewStreamItem, StreamItemKind, StreamSessionDetail } from '@shared/streaming'
import { LOCATIONS, type Location } from '@shared/inventory'
import {
  breakToStock,
  describeQuantity,
  giveawayToStock,
  packCost,
  boxCost,
  type Conversion,
  type ProductUnits
} from '@shared/units'
import { api } from '../../lib/api'
import { formatMoney } from '../../lib/format'
import { formatUnitCount, productUnits, stockUnitWord } from '../../lib/productUnits'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { Button, Field, Input } from '../../components/ui'
import { structureLabel } from '../inventory/helpers'
import { resultError, streaming } from './api'

/**
 * A whole count from a text input; blank is zero, and anything that is not a
 * whole number is null.
 *
 * Cases, boxes and packs are indivisible — half a box cannot be broken. A
 * number input still accepts "1.5" as text, and parsing that to 1 would move a
 * different amount of stock than the field on screen says, which is the one
 * class of bug this whole screen is built to prevent.
 */
function count(raw: string): number | null {
  const t = raw.trim()
  if (t === '') return 0
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null
  return n
}

/**
 * Record a break or a giveaway.
 *
 * Both are the same operation against inventory — pull stock out of a location
 * at its real FIFO cost — so they share this form and differ in what the
 * operator counts. A BREAK is counted in cases and boxes, because breaking is a
 * box-level activity. A GIVEAWAY is counted in boxes and packs, because packs
 * are what leaves the building.
 *
 * Neither of those is the unit stock is held in, and what that unit is varies
 * per product. So nothing is submitted until @shared/units has converted the
 * entry, and the result of that conversion is on screen before the button is
 * pressed: adding this TAKES STOCK, and how much it takes is not something the
 * operator should discover from the inventory screen later.
 */
export function AddItemForm({
  sessionId,
  kind,
  canSearchCatalog,
  onAdded,
  onCancel
}: {
  sessionId: string
  kind: StreamItemKind
  /** The catalog search lives behind the Inventory module's permission. */
  canSearchCatalog: boolean
  onAdded: (detail: StreamSessionDetail) => void
  onCancel: () => void
}): JSX.Element {
  const toast = useToast()
  const isBreak = kind === 'break'
  const [product, setProduct] = useState<InventoryProduct | null>(null)
  const [location, setLocation] = useState<Location>('RM')
  const [cases, setCases] = useState('')
  const [boxes, setBoxes] = useState('')
  const [packs, setPacks] = useState('')
  /** Only used for products the unit contract does not model — packs, singles
   *  and "other" have no case/box structure to convert through. */
  const [plainQty, setPlainQty] = useState('1')
  const [breakNumber, setBreakNumber] = useState('')
  const [recipient, setRecipient] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // Memoised because it is the identity the conversion below is keyed on; a
  // fresh object every render would make that memo do nothing.
  const units: ProductUnits | null = useMemo(
    () => (product ? productUnits(product) : null),
    [product]
  )

  /** The two fields this kind of line is entered in: cases + boxes for a break,
   *  boxes + packs for a giveaway. Null means the field is not a whole number. */
  const entered = useMemo(() => {
    const left = isBreak ? count(cases) : count(boxes)
    const right = isBreak ? count(boxes) : count(packs)
    return { left, right }
  }, [isBreak, cases, boxes, packs])

  /** A shape problem in the fields themselves, before the contract is asked. */
  const entryError =
    entered.left === null || entered.right === null
      ? isBreak
        ? 'Cases and boxes are whole numbers — enter 3, not 3.5.'
        : 'Boxes and packs are whole numbers — enter 3, not 3.5.'
      : null

  /**
   * What the entry converts to, in the product's own stock unit — or the
   * contract's refusal. Main runs the same two helpers over the same numbers,
   * so what this shows is what will happen, not an approximation of it.
   *
   * A refusal is passed through verbatim wherever it is shown: each one names
   * the exact field that is missing (packs per box, boxes per case, the giveaway
   * flag), and a generic "invalid quantity" would throw that away and leave the
   * operator with nowhere to go.
   */
  const conversion: Conversion | null = useMemo(() => {
    if (!units || entered.left === null || entered.right === null) return null
    // Nothing typed yet is not an error, it is the starting state. The contract
    // rightly rejects an empty entry, but showing that before the operator has
    // touched a field would be an alarm about their not having started.
    if (entered.left === 0 && entered.right === 0) return null
    return isBreak
      ? breakToStock(units, entered.left, entered.right)
      : giveawayToStock(units, entered.left, entered.right)
  }, [units, isBreak, entered])

  const plain = Number.parseInt(plainQty, 10)
  const quantity = units
    ? conversion?.ok
      ? conversion.value.quantity
      : null
    : Number.isFinite(plain) && plain > 0
      ? plain
      : null

  const onHand = product ? (product.quantityByLocation[location] ?? 0) : 0
  const short = quantity !== null && quantity > onHand

  const choose = (p: InventoryProduct): void => {
    setProduct(p)
    setError('')
    // Land on a location that can actually cover it, so the common case needs
    // no second decision.
    const best = LOCATIONS.find((l) => (p.quantityByLocation[l.id] ?? 0) > 0)?.id ?? 'RM'
    setLocation(best)
    // Prefill ONE of the product's own stock unit — the overwhelmingly common
    // break — so the usual line is a single click. Giveaways are left blank:
    // seeding a pack there would fire "no packs-per-box set" at an operator who
    // has not typed anything yet.
    const one = kind === 'break' && p.unitType === 'case' ? 'case' : kind === 'break' ? 'box' : null
    setCases(one === 'case' ? '1' : '')
    setBoxes(one === 'box' ? '1' : '')
    setPacks('')
    setPlainQty('1')
  }

  const submit = async (): Promise<void> => {
    if (!product) {
      setError('Pick a product first.')
      return
    }
    if (entryError) {
      setError(entryError)
      return
    }
    // The contract's own words, not a paraphrase — this is the message that says
    // which field to go and fill in.
    if (units && conversion && !conversion.ok) {
      setError(conversion.error)
      return
    }
    if (quantity === null || quantity <= 0) {
      setError(
        units
          ? isBreak
            ? 'Enter at least one case or box.'
            : 'Enter at least one box or pack.'
          : 'Quantity must be at least 1.'
      )
      return
    }
    const num = breakNumber.trim() === '' ? null : Number.parseInt(breakNumber, 10)
    if (num !== null && (!Number.isFinite(num) || num <= 0)) {
      setError('Break number must be a whole number.')
      return
    }
    setError('')
    setBusy(true)
    try {
      // The ENTRY is what travels, not the converted number: main runs the same
      // contract helpers over it and stores both. Sending the converted quantity
      // instead would make this form's arithmetic the authority, and two copies
      // of a per-product conversion is exactly what @shared/units exists to
      // prevent. `quantity` is only used for products the contract has no unit
      // for, where there is nothing to convert.
      const input: NewStreamItem = units
        ? {
            sessionId,
            kind,
            productId: product.id,
            cases: isBreak ? entered.left : null,
            boxes: isBreak ? entered.right : entered.left,
            packs: isBreak ? null : entered.right,
            location,
            breakNumber: isBreak ? num : null,
            recipient: !isBreak ? recipient.trim() || null : null,
            note: note.trim() || null
          }
        : {
            sessionId,
            kind,
            productId: product.id,
            quantity,
            location,
            breakNumber: isBreak ? num : null,
            recipient: !isBreak ? recipient.trim() || null : null,
            note: note.trim() || null
          }
      const res = await streaming.addItem(input)
      if (!res.ok || !res.data) {
        setError(resultError(res, 'Could not record that.'))
        return
      }
      toast.success(
        `${units ? describeQuantity(units, quantity) : `${quantity} units`} of ${
          product.name
        } out of ${location}.`
      )
      onAdded(res.data)
      // A show breaks many boxes in a row, so the form stays open and resets
      // itself instead of making the operator reopen it every time. The break
      // number steps on because that is what the next one almost always is.
      setProduct(null)
      setCases('')
      setBoxes('')
      setPacks('')
      setPlainQty('1')
      setRecipient('')
      setNote('')
      setBreakNumber(num === null ? '' : String(num + 1))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`stm-additem ${kind}`}>
      {error && <div className="auth-alert">{error}</div>}

      {!product ? (
        canSearchCatalog ? (
          <ProductTypeahead onSelect={choose} />
        ) : (
          <div className="stm-inline-note warn">
            <Icon name="ShieldCheck" size={14} />
            Searching the catalog needs Inventory access. Ask an admin to grant it before recording{' '}
            {isBreak ? 'breaks' : 'giveaways'}.
          </div>
        )
      ) : (
        <>
          <div className="selected-product">
            <div>
              <div className="sp-name">{product.name}</div>
              <div className="sp-meta">
                <span className="mono">{product.sku}</span>
                {product.category && <span>{product.category}</span>}
                <span>{structureLabel(product)}</span>
                {/* Which unit the on-hand number is in. Without it "3" beside a
                    product is ambiguous by an order of magnitude. */}
                <span className="stm-unit-chip">
                  <Icon name="Boxes" size={11} />
                  {units
                    ? `Stocked in ${stockUnitWord(units.unitType, 2)}`
                    : `Stocked in ${product.unitType}s`}
                </span>
              </div>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ marginLeft: 'auto' }}
              onClick={() => setProduct(null)}
            >
              Change
            </button>
          </div>

          <Field label="Take it out of">
            <div className="loc-pills">
              {LOCATIONS.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  className={`loc-pill ${location === l.id ? 'active' : ''}`}
                  onClick={() => setLocation(l.id)}
                >
                  {l.label}
                  <div className="lp-sub">
                    {formatUnitCount(product.quantityByLocation[l.id] ?? 0)}{' '}
                    {units ? stockUnitWord(units.unitType, 2) : 'on hand'}
                  </div>
                </button>
              ))}
            </div>
          </Field>

          <div className="stm-form-row">
            {units ? (
              isBreak ? (
                <>
                  <Field
                    label="Cases"
                    hint={
                      product.boxesPerCase
                        ? `1 case = ${product.boxesPerCase} boxes`
                        : 'Boxes per case is not set'
                    }
                  >
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      value={cases}
                      onChange={(e) => setCases(e.target.value)}
                      placeholder="0"
                      autoFocus
                    />
                  </Field>
                  <Field
                    label="Boxes"
                    hint={
                      units.unitType === 'case'
                        ? 'Loose boxes — a part-case'
                        : 'The unit this product is stocked in'
                    }
                  >
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      value={boxes}
                      onChange={(e) => setBoxes(e.target.value)}
                      placeholder="0"
                    />
                  </Field>
                </>
              ) : (
                <>
                  <Field
                    label="Boxes"
                    hint={
                      units.unitType === 'box'
                        ? 'The unit this product is stocked in'
                        : product.boxesPerCase
                          ? `${product.boxesPerCase} boxes = 1 case`
                          : 'Boxes per case is not set'
                    }
                  >
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      value={boxes}
                      onChange={(e) => setBoxes(e.target.value)}
                      placeholder="0"
                      autoFocus
                    />
                  </Field>
                  <Field
                    label="Packs"
                    hint={
                      product.packsPerBox
                        ? `1 box = ${product.packsPerBox} packs`
                        : 'Packs per box is not set'
                    }
                  >
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      value={packs}
                      onChange={(e) => setPacks(e.target.value)}
                      placeholder="0"
                    />
                  </Field>
                </>
              )
            ) : (
              <Field
                label={`Quantity (${product.unitType}s)`}
                hint="This product has no case or box structure to convert through"
              >
                <Input
                  type="number"
                  min={1}
                  value={plainQty}
                  onChange={(e) => setPlainQty(e.target.value)}
                  autoFocus
                />
              </Field>
            )}

            {isBreak ? (
              <Field label="Break number" hint="Matches “Break #N” on Whatnot — optional">
                <Input
                  type="number"
                  min={1}
                  value={breakNumber}
                  onChange={(e) => setBreakNumber(e.target.value)}
                  placeholder="e.g. 4"
                />
              </Field>
            ) : (
              <Field label="Recipient" hint="Optional">
                <Input
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="Whatnot username"
                />
              </Field>
            )}
            <Field label="Note" hint="Optional">
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Anything worth recording"
              />
            </Field>
          </div>

          <DeductionPreview
            kind={kind}
            product={product}
            units={units}
            entryError={entryError}
            conversion={conversion}
            quantity={quantity}
            location={location}
            onHand={onHand}
            short={short}
            giveawayBoxes={(isBreak ? null : entered.left) ?? 0}
            giveawayPacks={(isBreak ? null : entered.right) ?? 0}
          />
        </>
      )}

      <div className="stm-additem-acts">
        {/* "Close", not "Cancel": the panel survives a successful add, so by the
            second line there is nothing left to cancel. */}
        <Button variant="ghost" onClick={onCancel}>
          Close
        </Button>
        <Button
          variant="primary"
          icon={isBreak ? 'Layers' : 'Gift'}
          loading={busy}
          disabled={!product || quantity === null}
          onClick={() => void submit()}
        >
          {isBreak ? 'Record break' : 'Record giveaway'}
        </Button>
      </div>
    </div>
  )
}

/**
 * The line that has to be read before the button is pressed: exactly how much
 * stock this takes, in the unit the product is actually held in.
 *
 * A refusal replaces it rather than sitting beside it. The contract only refuses
 * for reasons that make the entry unrecordable, and each message names the field
 * to go and fix — so it is reproduced word for word and given the whole block.
 */
function DeductionPreview({
  kind,
  product,
  units,
  entryError,
  conversion,
  quantity,
  location,
  onHand,
  short,
  giveawayBoxes,
  giveawayPacks
}: {
  kind: StreamItemKind
  product: InventoryProduct
  units: ProductUnits | null
  /** A problem with the fields themselves, raised before the contract is asked. */
  entryError: string | null
  conversion: Conversion | null
  quantity: number | null
  location: Location
  onHand: number
  short: boolean
  giveawayBoxes: number
  giveawayPacks: number
}): JSX.Element {
  // `conversion.error` goes through untouched. Each message names the exact
  // field that is missing — packs per box, boxes per case, the giveaway flag —
  // and a house-style rewrite would cost the operator the only sentence that
  // tells them where to go.
  const problem = entryError ?? (conversion && !conversion.ok ? conversion.error : null)

  if (problem) {
    return (
      <div className="stm-consume is-error" role="alert">
        <Icon name="AlertTriangle" size={15} />
        <div className="stm-consume-body">
          <b>
            This cannot be recorded
            {units ? ` in ${stockUnitWord(units.unitType, 2)}` : ''} yet.
          </b>
          <span>{problem}</span>
        </div>
      </div>
    )
  }

  if (quantity === null) {
    return (
      <div className="stm-consume is-idle">
        <Icon name="PackageMinus" size={15} />
        <div className="stm-consume-body">
          <span>
            {units
              ? kind === 'break'
                ? 'Enter cases and/or boxes — what that deducts appears here before you record it.'
                : 'Enter boxes and/or packs — what that deducts appears here before you record it.'
              : 'Enter a quantity to see what this deducts.'}
          </span>
        </div>
      </div>
    )
  }

  const deducts = units
    ? describeQuantity(units, quantity)
    : `${formatUnitCount(quantity)} ${product.unitType}${quantity === 1 ? '' : 's'}`

  return (
    <div className="stm-consume">
      <Icon name="PackageMinus" size={15} />
      <div className="stm-consume-body">
        <span>
          Deducts <b className="stm-consume-qty">{deducts}</b> of <b>{product.name}</b> from{' '}
          <b>{location}</b>, at their FIFO cost. Removing the line later puts them back.
        </span>
        {short && (
          <span className="stm-consume-short">
            <Icon name="AlertTriangle" size={13} />
            {location} holds only {formatUnitCount(onHand)}{' '}
            {units ? stockUnitWord(units.unitType, onHand) : 'on hand'}.
          </span>
        )}
        {kind === 'giveaway' && units && (
          <GiveawayLossLine
            units={units}
            unitCost={product.unitCost}
            quantity={quantity}
            boxes={giveawayBoxes}
            packs={giveawayPacks}
          />
        )}
      </div>
    </div>
  )
}

/**
 * What the giveaway will book as a loss.
 *
 * Mirrors main's rule exactly: packs are valued at PACK cost and whole boxes at
 * BOX cost, and when no packs were entered the loss is simply what the stock
 * consumed cost. The one difference is which cost basis it can see — main uses
 * the FIFO layers this line will actually take, and only the product's moving
 * average is available before the line exists. So the figure is captioned as an
 * estimate rather than presented as the booked number.
 *
 * Showing the divisor is the point: a wrong packs-per-box turns up here, while
 * it can still be fixed, instead of as an unexplainable loss on a day's P&L
 * weeks later. And when a pack cannot be costed at all the block says which
 * field is missing, because a giveaway silently valued at zero looks exactly
 * like a working feature.
 */
function GiveawayLossLine({
  units,
  unitCost,
  quantity,
  boxes,
  packs
}: {
  units: ProductUnits
  /** The product's moving average per stock unit — a stand-in for FIFO. */
  unitCost: number
  quantity: number
  boxes: number
  packs: number
}): JSX.Element {
  const perPack = packCost(units, unitCost)
  const perBox = boxCost(units, unitCost)

  if (packs > 0) {
    if (perPack === null || perBox === null) {
      return (
        <span className="stm-consume-loss is-missing">
          <Icon name="AlertTriangle" size={13} />
          {!units.packsPerBox
            ? 'Packs per box is not set in Inventory, so packs cannot be valued'
            : units.unitType === 'case' && !units.boxesPerCase
              ? 'Boxes per case is not set in Inventory, so packs cannot be valued'
              : 'This product has no average cost, so packs cannot be valued'}
          — the loss would come out at zero.
        </span>
      )
    }
    return (
      <span className="stm-consume-loss">
        <Icon name="DollarSign" size={13} />
        Books a loss of about <b>{formatMoney(boxes * perBox + packs * perPack)}</b> — {packs}{' '}
        {packs === 1 ? 'pack' : 'packs'} at {formatMoney(perPack)}
        {boxes > 0 && (
          <>
            {' '}
            plus {boxes} {boxes === 1 ? 'box' : 'boxes'} at {formatMoney(perBox)}
          </>
        )}
        . At average cost — the line books at the FIFO cost of the stock it takes.
      </span>
    )
  }

  // Whole boxes only: the loss is just what that stock cost, which is the same
  // figure the FIFO consumption produces. No pack divisor is involved, so a
  // missing packs-per-box is not a problem here.
  if (unitCost <= 0) {
    return (
      <span className="stm-consume-loss is-missing">
        <Icon name="AlertTriangle" size={13} />
        This product has no average cost, so nothing can be estimated here. The line still books at
        the FIFO cost of the stock it takes.
      </span>
    )
  }
  return (
    <span className="stm-consume-loss">
      <Icon name="DollarSign" size={13} />
      Books a loss of about <b>{formatMoney(quantity * unitCost)}</b> — the cost of the stock that
      goes out. At average cost; the line books at FIFO.
    </span>
  )
}

/**
 * The catalog typeahead, same debounce and same read as Inventory's — a second
 * search implementation would be a second set of matching rules to keep in step.
 */
function ProductTypeahead({ onSelect }: { onSelect: (p: InventoryProduct) => void }): JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<InventoryProduct[]>([])
  const [loading, setLoading] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([])
      return
    }
    let cancelled = false
    setLoading(true)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(async () => {
      const r = await api.inventory.search(query)
      if (!cancelled) {
        setResults(r)
        setLoading(false)
      }
    }, 180)
    return () => {
      cancelled = true
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [query])

  return (
    <div className="typeahead">
      <Field label="Product" hint="Search the catalog by name, SKU or UPC">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Start typing a product name, SKU or UPC…"
          autoFocus
        />
      </Field>
      {query.trim().length >= 2 && (
        <div className="ta-menu">
          {loading && results.length === 0 ? (
            <div className="ta-empty">Searching…</div>
          ) : results.length === 0 ? (
            <div className="ta-empty">No match in the catalog.</div>
          ) : (
            results.map((p) => {
              const u = productUnits(p)
              return (
                <button type="button" key={p.id} className="ta-item" onClick={() => onSelect(p)}>
                  <span className="ta-name">{p.name}</span>
                  <span className="ta-sub">
                    {p.sku} · {p.category || 'Uncategorized'} · {structureLabel(p)} ·{' '}
                    {formatUnitCount(p.quantity)} {u ? stockUnitWord(u.unitType, p.quantity) : 'units'}{' '}
                    on hand
                  </span>
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
