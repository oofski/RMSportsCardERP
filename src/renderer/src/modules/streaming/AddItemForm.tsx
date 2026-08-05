import { useEffect, useMemo, useRef, useState } from 'react'
import type { InventoryProduct } from '@shared/types'
import type { NewStreamItem, StreamItemKind, StreamSessionDetail } from '@shared/streaming'
import { parseMoneyInput } from '@shared/streaming'
import { LOCATIONS, type Location } from '@shared/inventory'
import {
  QTY_EPS,
  boxCost,
  breakToStock,
  describeQuantity,
  giveawayToStock,
  packCost,
  type Conversion,
  type ProductUnits,
  type StockUnit
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
/**
 * A quantity typed into one of the count fields.
 *
 * `allowFraction` is for RECONCILING a past show, where 1.25 cases is a real
 * thing somebody broke. Everywhere else a count is whole, because everywhere
 * else it moves stock and a shelf cannot hold a quarter of a case unless the
 * product is flagged for it. A reconciliation moves no stock at all — it
 * records what a night cost — so the rule that exists to protect the shelf has
 * nothing to protect here.
 */
function count(raw: string, allowFraction = false): number | null {
  const t = raw.trim()
  if (t === '') return 0
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0) return null
  if (!allowFraction && !Number.isInteger(n)) return null
  return n
}

/**
 * The word for the unit a reconciliation is counted and priced in.
 *
 * Null while no product is chosen, and for a product the unit contract has no
 * case or box structure for — that entry is refused by name in the preview, and
 * calling its count "cases" on the way there would be the same wrong assumption
 * this form exists to avoid.
 */
function entryWord(unit: StockUnit | null, n: number): string {
  if (!unit) return n === 1 ? 'unit' : 'units'
  return stockUnitWord(unit, n)
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

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
 *
 * ## Reconcile mode
 *
 * On a show that is already history the form becomes a different one, because
 * the act is different. There is no stock to take — it went weeks ago — so the
 * question stops being "how much comes off the shelf" and becomes "how much was
 * broken, and what did one of them cost". The whole panel changes with it: the
 * fields, the preview, the button, and a banner that says so in as many words.
 * Nobody should ever have to work out which mode they are in from the shape of
 * the inputs.
 *
 * ONE FIELD, in the product's own stock unit. A case-stocked product is counted
 * in cases at a price per case; a box-stocked one in boxes at a price per box,
 * because that is how it is bought and because one box is already one unit of
 * its shelf — there is nothing for a case count to convert through, and asking
 * for one would refuse the entry over a boxes-per-case the product never needed.
 * Every label, hint and message below follows that unit, so a box-stocked
 * product never sees the word "case" on this screen.
 */
export function AddItemForm({
  sessionId,
  kind,
  canSearchCatalog,
  reconcile,
  onAdded,
  onCancel
}: {
  sessionId: string
  kind: StreamItemKind
  /** The catalog search lives behind the Inventory module's permission. */
  canSearchCatalog: boolean
  /** The session is past-dated: this records history, it does not move stock. */
  reconcile: boolean
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
  /** Reconcile mode: what one unit of entry was bought at, exactly as typed. */
  const [unitPriceRaw, setUnitPriceRaw] = useState('')
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

  /**
   * The unit a reconciliation of THIS product is counted and priced in: its own
   * stock unit. Null until a product is chosen, and for one the contract has no
   * case/box structure for.
   */
  const reconUnit: StockUnit | null = reconcile ? (units?.unitType ?? null) : null

  /** The two fields this kind of line is entered in: cases + boxes for a break,
   *  boxes + packs for a giveaway. Null means the field is not a whole number.
   *  A reconciliation is entered in ONE of them — the product's own stock unit —
   *  so a box-stocked product types into the boxes field and a case-stocked one
   *  into cases, and each is priced per one of what it counted. */
  const entered = useMemo(() => {
    if (reconcile) return { left: count(reconUnit === 'box' ? boxes : cases, true), right: 0 }
    const left = isBreak ? count(cases) : count(boxes)
    const right = isBreak ? count(boxes) : count(packs)
    return { left, right }
  }, [reconcile, reconUnit, isBreak, cases, boxes, packs])

  /** A shape problem in the fields themselves, before the contract is asked. */
  const entryError =
    entered.left === null || entered.right === null
      ? reconcile
        ? `Enter how many ${entryWord(reconUnit, 2)} were broken — 2, or 1.25 for part of one.`
        : isBreak
          ? 'Cases and boxes are whole numbers — enter 3, not 3.5.'
          : 'Boxes and packs are whole numbers — enter 3, not 3.5.'
      : null

  /**
   * What one unit of entry cost. NaN covers both "nothing typed yet" and "that
   * is not a number", which is right for the preview — neither can be costed —
   * and the two are told apart at submit, where they are different mistakes.
   *
   * Parsed with the same function main parses it with, so a price this panel
   * accepts is a price the write accepts.
   */
  const unitPrice = parseMoneyInput(unitPriceRaw)
  const priceOk = reconcile ? Number.isFinite(unitPrice) && unitPrice >= 0 : true

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
    // A reconciliation goes through the break conversion whichever kind of line
    // it is: "what is N of this, in the unit it is stocked in" is one question
    // with one answer, and asking it twice is how the two get to disagree. Which
    // side of that conversion the count goes in follows the entry unit — for a
    // box-stocked product it is already the answer, and the round trip is what
    // keeps the arithmetic in one place. Main converts the same entry the same
    // way.
    if (reconcile) {
      return reconUnit === 'box'
        ? breakToStock(units, 0, entered.left)
        : breakToStock(units, entered.left, 0)
    }
    return isBreak
      ? breakToStock(units, entered.left, entered.right)
      : giveawayToStock(units, entered.left, entered.right)
  }, [units, isBreak, reconcile, reconUnit, entered])

  const plain = Number.parseInt(plainQty, 10)
  const quantity = units
    ? conversion?.ok
      ? conversion.value.quantity
      : null
    : Number.isFinite(plain) && plain > 0
      ? plain
      : null

  const onHand = product ? (product.quantityByLocation[location] ?? 0) : 0
  // Same slack main uses when it checks stock: a giveaway that consumes the
  // exact fractional balance leaves float dust, and warning "only 0.25 on hand"
  // about a line that will succeed is worse than not warning at all.
  //
  // Never in reconcile mode: nothing is coming off the shelf, so an empty shelf
  // is not a problem — it is the expected state of a show two months old.
  const short = !reconcile && quantity !== null && quantity > onHand + QTY_EPS

  /** What the reconciliation asserts, in one number, before it is committed. */
  const statedTotal = priceOk && entered.left ? entered.left * unitPrice : null

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
    //
    // A reconciliation seeds one of the same unit for the same reason, and
    // deliberately leaves the price empty: it is the one number nobody but the
    // operator knows, and a prefilled figure is one somebody eventually forgets
    // to change.
    const one = reconcile || kind === 'break' ? (p.unitType === 'box' ? 'box' : 'case') : null
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
        reconcile
          ? `Enter at least one ${entryWord(reconUnit, 1)}.`
          : units
            ? isBreak
              ? 'Enter at least one case or box.'
              : 'Enter at least one box or pack.'
            : 'Quantity must be at least 1.'
      )
      return
    }
    // "Nothing typed" and "not a number" are the same NaN to the preview and two
    // different mistakes here, so they get two different sentences.
    if (reconcile && !priceOk) {
      setError(
        unitPriceRaw.trim() === ''
          ? `Enter what one ${entryWord(reconUnit, 1)} cost — that is the whole point of reconciling it.`
          : Number.isFinite(unitPrice)
            ? `A ${entryWord(reconUnit, 1)} cannot have cost less than nothing.`
            : 'That is not a price. Enter an amount like 2400 or 2,400.00.'
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
      const input: NewStreamItem = reconcile
        ? {
            // In the product's own stock unit, and only that one: main refuses
            // the other field rather than ignoring it, so sending both would be
            // sending a number that cannot be true.
            sessionId,
            kind,
            productId: product.id,
            cases: reconUnit === 'box' ? null : entered.left,
            boxes: reconUnit === 'box' ? entered.left : null,
            // Per unit of entry, not the total on screen. Main multiplies it
            // back out, so the number stored is the assertion the operator made
            // rather than a product of it — and correcting the count later
            // cannot leave a stale total behind.
            casePrice: unitPrice,
            location,
            breakNumber: isBreak ? num : null,
            recipient: !isBreak ? recipient.trim() || null : null,
            note: note.trim() || null
          }
        : units
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
        reconcile
          ? `${entered.left} ${entryWord(reconUnit, entered.left ?? 0)} of ${product.name} recorded at ${
              statedTotal !== null ? formatMoney(statedTotal) : formatMoney(0)
            }.`
          : `${units ? describeQuantity(units, quantity) : `${quantity} units`} of ${
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
      // Cleared with the rest. A reconciliation is usually several different
      // products at several different prices, and a price left sitting in the
      // field is the one that gets recorded against the wrong one.
      setUnitPriceRaw('')
      setRecipient('')
      setNote('')
      setBreakNumber(num === null ? '' : String(num + 1))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`stm-additem ${kind}${reconcile ? ' reconcile' : ''}`}>
      {/* First thing in the panel, before the product is even chosen: what this
          form is going to do. The fields below only make sense once that is
          known, and finding out afterwards is finding out too late. */}
      {reconcile && (
        <div className="stm-recon-banner">
          <Icon name="History" size={15} />
          <div>
            {/* Named in the chosen product's unit as soon as there is one. Before
                that there is no unit to name, and calling it a case would be a
                promise the fields then break for a box-stocked product. */}
            <b>Reconciling a past show:</b>{' '}
            {reconUnit ? (
              <>enter how many {entryWord(reconUnit, 2)} were broken and what one cost.</>
            ) : (
              // No product chosen yet, so there is no unit to name. The clause
              // that names it is dropped rather than guessed at — calling it a
              // case would be a promise the fields then break for a box-stocked
              // product.
              <>enter how much was broken and what one cost.</>
            )}{' '}
            Today&rsquo;s shelf is untouched.
          </div>
        </div>
      )}

      {error && <div className="auth-alert">{error}</div>}

      {!product ? (
        canSearchCatalog ? (
          <ProductTypeahead onSelect={choose} />
        ) : (
          <div className="stm-inline-note warn">
            <Icon name="ShieldCheck" size={14} />
            Searching the catalog needs Inventory access — ask an admin.
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

          {/* Reconciling records WHERE it came from, not where it comes from —
              and the on-hand counts are dropped with the change of tense. They
              are today's numbers, this is not today's stock, and showing them
              here only invites the reader to subtract one from the other. */}
          <Field label={reconcile ? 'Which shelf it came off' : 'Take it out of'}>
            <div className="loc-pills">
              {LOCATIONS.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  className={`loc-pill ${location === l.id ? 'active' : ''}`}
                  onClick={() => setLocation(l.id)}
                >
                  {l.label}
                  {/* The unit, not just the number: "3 on hand" is ambiguous by
                      a factor of twelve between a case product and a box one. */}
                  {!reconcile && (
                    <div className="lp-sub">
                      {formatUnitCount(product.quantityByLocation[l.id] ?? 0)}{' '}
                      {units ? `${stockUnitWord(units.unitType, 2)} on hand` : 'on hand'}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </Field>

          <div className="stm-form-row">
            {reconcile ? (
              <>
                {/* ONE count field, in the product's own stock unit, writing to
                    the state that unit belongs to — so a box-stocked product
                    enters boxes and a case-stocked one cases, and neither is
                    offered a field it would have to be converted out of. */}
                <Field
                  label={`${capitalize(entryWord(reconUnit, 2))} broken`}
                  hint={
                    reconUnit
                      ? `Stocked in ${entryWord(reconUnit, 2)} — one ${entryWord(
                          reconUnit,
                          1
                        )} is one unit`
                      : `Stocked in ${product.unitType}s — not cases or boxes`
                  }
                >
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    value={reconUnit === 'box' ? boxes : cases}
                    onChange={(e) =>
                      reconUnit === 'box' ? setBoxes(e.target.value) : setCases(e.target.value)
                    }
                    placeholder="0"
                    autoFocus
                  />
                </Field>
                <Field
                  label={`Price paid per ${entryWord(reconUnit, 1)}`}
                  hint={`What one ${entryWord(reconUnit, 1)} cost when you bought it`}
                >
                  {/* A text input, not a number one: money is typed with commas
                      and dollar signs, and a number input silently discards the
                      lot — leaving a field that looks empty for a price the
                      operator is sure they entered. */}
                  <Input
                    inputMode="decimal"
                    value={unitPriceRaw}
                    onChange={(e) => setUnitPriceRaw(e.target.value)}
                    placeholder="2400"
                    invalid={unitPriceRaw.trim() !== '' && !priceOk}
                  />
                </Field>
              </>
            ) : units ? (
              isBreak ? (
                <BreakCounts
                  units={units}
                  cases={cases}
                  boxes={boxes}
                  setCases={setCases}
                  setBoxes={setBoxes}
                />
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

          {reconcile ? (
            <ReconcilePreview
              product={product}
              units={units}
              unit={reconUnit}
              entryError={entryError}
              conversion={conversion}
              counted={entered.left}
              quantity={quantity}
              unitPriceRaw={unitPriceRaw}
              unitPrice={unitPrice}
              priceOk={priceOk}
              total={statedTotal}
            />
          ) : (
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
          )}
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
          icon={reconcile ? 'History' : isBreak ? 'Layers' : 'Gift'}
          loading={busy}
          disabled={!product || quantity === null || !priceOk}
          onClick={() => void submit()}
        >
          {reconcile
            ? isBreak
              ? 'Record this break'
              : 'Record this giveaway'
            : isBreak
              ? 'Record break'
              : 'Record giveaway'}
        </Button>
      </div>
    </div>
  )
}

/**
 * The two count fields of a LIVE break, led by the one the product is actually
 * stocked in.
 *
 * Both are always offered — a box-stocked product with a real boxes-per-case is
 * genuinely broken a case at a time, and the contract converts that perfectly
 * well — but the first field is the one the shelf counts, and it is the one the
 * cursor lands in. The old fixed order put cases first for everything, so the
 * usual entry for a box-stocked product started by tabbing past a field it was
 * never going to use, into a divisor it may not even have.
 */
function BreakCounts({
  units,
  cases,
  boxes,
  setCases,
  setBoxes
}: {
  units: ProductUnits
  cases: string
  boxes: string
  setCases: (v: string) => void
  setBoxes: (v: string) => void
}): JSX.Element {
  const leadsWithBoxes = units.unitType === 'box'

  const caseField = (
    <Field
      key="cases"
      label="Cases"
      hint={
        units.boxesPerCase ? `1 case = ${units.boxesPerCase} boxes` : 'Boxes per case is not set'
      }
    >
      <Input
        type="number"
        min={0}
        step={1}
        value={cases}
        onChange={(e) => setCases(e.target.value)}
        placeholder="0"
        autoFocus={!leadsWithBoxes}
      />
    </Field>
  )

  const boxField = (
    <Field
      key="boxes"
      label="Boxes"
      hint={leadsWithBoxes ? 'The unit this product is stocked in' : 'Loose boxes — a part-case'}
    >
      <Input
        type="number"
        min={0}
        step={1}
        value={boxes}
        onChange={(e) => setBoxes(e.target.value)}
        placeholder="0"
        autoFocus={leadsWithBoxes}
      />
    </Field>
  )

  return leadsWithBoxes ? (
    <>
      {boxField}
      {caseField}
    </>
  ) : (
    <>
      {caseField}
      {boxField}
    </>
  )
}

/**
 * The arithmetic, spelled out, before the button is pressed: `4 cases × $2,400 =
 * $9,600`, or `3 boxes × $40 = $120` for a product stocked in boxes.
 *
 * A reconciliation has no shelf to check itself against — the stock is gone, so
 * "only 2 on hand" cannot catch a mistyped count and nothing else will either.
 * The total IS the check: the operator knows what that night cost them, and a
 * wrong figure is obvious on sight in a way that a wrong count in a box beside a
 * price is not.
 *
 * It also says the thing that separates this from every other line on the
 * screen — that no stock moves — because the only place a wrongly-moved case
 * would show up is a stock count weeks later.
 */
function ReconcilePreview({
  product,
  units,
  unit,
  entryError,
  conversion,
  counted,
  quantity,
  unitPriceRaw,
  unitPrice,
  priceOk,
  total
}: {
  product: InventoryProduct
  units: ProductUnits | null
  /** The unit this entry is counted and priced in — the product's own. */
  unit: StockUnit | null
  entryError: string | null
  conversion: Conversion | null
  counted: number | null
  quantity: number | null
  unitPriceRaw: string
  unitPrice: number
  priceOk: boolean
  total: number | null
}): JSX.Element {
  // Same order of precedence as the deduction preview: a shape problem in the
  // fields, then the contract's refusal, and both replace the block rather than
  // sitting under a total that cannot be computed anyway.
  const problem =
    entryError ??
    (conversion && !conversion.ok ? conversion.error : null) ??
    (!units
      ? `${product.name} is stocked in ${product.unitType}s, not cases or boxes, so there is no unit for it to be priced by. Set its unit type to case or box in Inventory.`
      : null)

  if (problem) {
    return (
      <div className="stm-consume is-error" role="alert">
        <Icon name="AlertTriangle" size={15} />
        <div className="stm-consume-body">
          <b>This cannot be recorded yet.</b>
          <span>{problem}</span>
        </div>
      </div>
    )
  }

  if (!counted || quantity === null) {
    return (
      <div className="stm-consume is-idle">
        <Icon name="History" size={15} />
        <div className="stm-consume-body">
          <span>
            Enter how many {entryWord(unit, 2)} were broken, and what one {entryWord(unit, 1)} cost.
          </span>
        </div>
      </div>
    )
  }

  if (!priceOk) {
    return (
      <div className="stm-consume is-idle">
        <Icon name="DollarSign" size={15} />
        <div className="stm-consume-body">
          <span>
            {unitPriceRaw.trim() === ''
              ? `${counted} ${entryWord(unit, counted)} of ${product.name}. Now enter what one ${entryWord(
                  unit,
                  1
                )} cost.`
              : Number.isFinite(unitPrice)
                ? `A ${entryWord(unit, 1)} cannot have cost less than nothing.`
                : 'That is not a price. Enter an amount like 2400 or 2,400.00.'}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="stm-consume is-recon">
      <Icon name="History" size={15} />
      <div className="stm-consume-body">
        {/* The count is in the product's own stock unit, so it IS the number
            that will appear in the line's × column. Nothing is divided down on
            the way in any more, and there is nothing left to warn about. */}
        <span className="stm-recon-sum">
          <b>{counted}</b> {entryWord(unit, counted)} × <b>{formatMoney(unitPrice)}</b> ={' '}
          <b className="stm-recon-total">{formatMoney(total ?? 0)}</b>
        </span>
        <span>Books {formatMoney(total ?? 0)} of cost to this show.</span>
        <span className="stm-consume-short">
          <Icon name="PackageMinus" size={13} />
          Today&rsquo;s stock is untouched — this stock left the shelf on the night.
        </span>
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
        Books about <b>{formatMoney(boxes * perBox + packs * perPack)}</b> — {packs}{' '}
        {packs === 1 ? 'pack' : 'packs'} at {formatMoney(perPack)}
        {boxes > 0 && (
          <>
            {' '}
            plus {boxes} {boxes === 1 ? 'box' : 'boxes'} at {formatMoney(perBox)}
          </>
        )}
        . At average cost; books at FIFO.
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
        No average cost to estimate from. The line still books at FIFO.
      </span>
    )
  }
  return (
    <span className="stm-consume-loss">
      <Icon name="DollarSign" size={13} />
      Books about <b>{formatMoney(quantity * unitCost)}</b>. At average cost; the line books at
      FIFO.
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
