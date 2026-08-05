import { useState } from 'react'
import type { InventoryProduct, UnitType } from '@shared/types'
import { LOCATIONS, type Location } from '@shared/inventory'
import { boxCost, packCost, type ProductUnits } from '@shared/units'
import { api } from '../../lib/api'
import { formatMoney } from '../../lib/format'
import { stockUnitOf, stockUnitWord } from '../../lib/productUnits'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { Button, Checkbox, Field, Input, Modal, Select, Textarea } from '../../components/ui'
import { UNIT_TYPES } from './helpers'

function numOrNull(v: string): number | null {
  const n = parseFloat(v)
  return v.trim() === '' || Number.isNaN(n) ? null : n
}

export function ProductFormModal({
  product,
  presetUpc,
  onClose,
  onSaved
}: {
  product: InventoryProduct | null
  /** Prefills the UPC when creating — used by the scan station's "not
   * recognised" escape hatch so the code you just scanned is already in. */
  presetUpc?: string | null
  onClose: () => void
  onSaved: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const isEdit = !!product
  const [form, setForm] = useState({
    sku: product?.sku ?? '',
    upc: product?.upc ?? presetUpc ?? '',
    name: product?.name ?? '',
    category: product?.category ?? '',
    brand: product?.brand ?? '',
    setName: product?.setName ?? '',
    year: product?.year ?? '',
    unitType: (product?.unitType ?? 'box') as UnitType,
    boxesPerCase: product?.boxesPerCase != null ? String(product.boxesPerCase) : '',
    packsPerBox: product?.packsPerBox != null ? String(product.packsPerBox) : '',
    giveawayItem: product?.giveawayItem === true,
    unitCost: product ? String(product.unitCost) : '',
    highBid: product?.highBid != null ? String(product.highBid) : '',
    salePrice: product?.salePrice != null ? String(product.salePrice) : '',
    reorderPoint: product?.reorderPoint ? String(product.reorderPoint) : '',
    notes: product?.notes ?? '',
    openingQuantity: '',
    openingLocation: 'RM' as Location
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const set =
    (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>): void =>
      setForm((f) => ({ ...f, [k]: e.target.value }))

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const base = {
        sku: form.sku,
        upc: form.upc.trim() || null,
        name: form.name,
        category: form.category,
        brand: form.brand,
        setName: form.setName,
        year: form.year,
        unitType: form.unitType,
        boxesPerCase: numOrNull(form.boxesPerCase),
        packsPerBox: numOrNull(form.packsPerBox),
        // Saved alongside the two divisors it depends on. The flag only means
        // anything in combination with them, so letting them be saved apart
        // would let a product claim it allows part-packs while carrying no
        // packs-per-box to split with.
        giveawayItem: form.giveawayItem,
        unitCost: numOrNull(form.unitCost) ?? 0,
        highBid: numOrNull(form.highBid),
        salePrice: numOrNull(form.salePrice),
        reorderPoint: numOrNull(form.reorderPoint) ?? 0,
        notes: form.notes.trim() || null
      }
      const res = isEdit
        ? await api.inventory.update({ id: product.id, ...base })
        : await api.inventory.create({
            ...base,
            openingQuantity: numOrNull(form.openingQuantity) ?? 0,
            openingLocation: form.openingLocation
          })
      if (!res.ok) {
        setError(res.error ?? 'Could not save the product.')
        return
      }
      toast.success(isEdit ? 'Product updated.' : `${form.name} added to the catalog.`)
      await onSaved()
    } finally {
      setBusy(false)
    }
  }

  const stockUnit = stockUnitOf(form.unitType)

  return (
    <Modal
      title={isEdit ? 'Edit product' : 'Add product'}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose} type="button">
            Cancel
          </Button>
          <Button variant="primary" icon={isEdit ? 'Check' : 'PackagePlus'} loading={busy} onClick={submit}>
            {isEdit ? 'Save changes' : 'Add product'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit}>
        {error && <div className="auth-alert">{error}</div>}

        <Field label="Product name">
          <Input value={form.name} onChange={set('name')} placeholder="2026 Bowman Baseball Hobby 12-Box Case" required autoFocus />
        </Field>

        <div className="field-row">
          <Field label="SKU" hint="Short code — can repeat (e.g. BOX)">
            <Input value={form.sku} onChange={set('sku')} placeholder="6578" />
          </Field>
          <Field label="UPC" hint="Barcode — unique">
            <Input value={form.upc} onChange={set('upc')} placeholder="887521158126" />
          </Field>
        </div>

        <div className="field-row">
          <Field label="Category">
            <Input value={form.category} onChange={set('category')} placeholder="Baseball" />
          </Field>
          <Field
            label="Stock unit"
            hint={
              stockUnit
                ? `On-hand counts ${stockUnitWord(stockUnit, 2)} of this product`
                : 'Breaks and giveaways are entered as a plain count for this unit'
            }
          >
            <Select value={form.unitType} onChange={set('unitType')}>
              {UNIT_TYPES.map((u) => (
                <option key={u.value} value={u.value}>
                  {u.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="field-row">
          <Field label="Brand">
            <Input value={form.brand} onChange={set('brand')} placeholder="Bowman" />
          </Field>
          <Field label="Year">
            <Input value={form.year} onChange={set('year')} placeholder="2026" />
          </Field>
        </div>

        <div className="field-row">
          <Field
            label="Boxes per case"
            hint={
              form.unitType === 'case'
                ? 'Divides a case into boxes — a break of loose boxes needs it'
                : 'How many boxes came in a case, e.g. 12'
            }
          >
            <Input
              type="number"
              min={1}
              step={1}
              value={form.boxesPerCase}
              onChange={set('boxesPerCase')}
              placeholder="—"
            />
          </Field>
          <Field label="Packs per box" hint="Nothing can value a giveaway of packs without it">
            <Input
              type="number"
              min={1}
              step={1}
              value={form.packsPerBox}
              onChange={set('packsPerBox')}
              placeholder="—"
            />
          </Field>
        </div>

        <GiveawayToggle
          checked={form.giveawayItem}
          unitWord={stockUnit ? stockUnitWord(stockUnit) : 'unit'}
          onChange={(giveawayItem) => setForm((f) => ({ ...f, giveawayItem }))}
        />

        <div className="field-row">
          <Field label="Average cost" hint={`Average cost of one ${stockUnit ?? 'unit'} (what we paid)`}>
            <Input type="number" min={0} step="0.01" value={form.unitCost} onChange={set('unitCost')} placeholder="0.00" />
          </Field>
          <Field label="High bid" hint="Current top bid / market value per unit">
            <Input type="number" min={0} step="0.01" value={form.highBid} onChange={set('highBid')} placeholder="0.00" />
          </Field>
        </div>

        <UnitEconomics
          unitType={form.unitType}
          boxesPerCase={numOrNull(form.boxesPerCase)}
          packsPerBox={numOrNull(form.packsPerBox)}
          giveawayItem={form.giveawayItem}
          unitCost={numOrNull(form.unitCost)}
        />

        <Field label="Default sale price" hint="Optional">
          <Input type="number" min={0} step="0.01" value={form.salePrice} onChange={set('salePrice')} placeholder="0.00" />
        </Field>

        {!isEdit && (
          <div className="field-row">
            <Field label="Opening quantity" hint="Optional — stock on hand now">
              <Input type="number" min={0} value={form.openingQuantity} onChange={set('openingQuantity')} placeholder="0" />
            </Field>
            <Field label="Opening location">
              <Select value={form.openingLocation} onChange={set('openingLocation')}>
                {LOCATIONS.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}

        <Field label="Low-stock alert at" hint="0 = off">
          <Input type="number" min={0} value={form.reorderPoint} onChange={set('reorderPoint')} />
        </Field>

        <Field label="Notes">
          <Textarea value={form.notes} onChange={set('notes')} placeholder="Anything worth noting…" />
        </Field>

        <button type="submit" style={{ display: 'none' }} aria-hidden />
      </form>
    </Modal>
  )
}

/**
 * The one switch that lets a product hold a part-unit.
 *
 * Named for its consequence rather than its field name, and it states what
 * happens to everything else in the same breath — the risk with a lone toggle
 * is that it reads as a harmless tag, gets flipped on the whole catalog, and
 * rounding dust starts accumulating in the cost basis of stock nobody is giving
 * away.
 */
function GiveawayToggle({
  checked,
  unitWord,
  onChange
}: {
  checked: boolean
  /** "case" or "box" — the unit that stays whole for every other product. */
  unitWord: string
  onChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <div className={`inv-giveaway-toggle${checked ? ' is-on' : ''}`}>
      <Checkbox
        checked={checked}
        onChange={onChange}
        label="Giveaway item — may be held in part boxes and packs"
      />
      <p className="igt-body">
        {checked ? (
          <>On-hand may be a fraction of a {unitWord} — e.g. 3 packs out of a 12-pack box.</>
        ) : (
          <>
            On-hand stays whole {unitWord}s; anything leaving a part-{unitWord} is refused.
          </>
        )}
      </p>
    </div>
  )
}

/**
 * Cost per box and cost per pack, derived live from what is being typed.
 *
 * This is the number that values a giveaway as a loss in the P&L, and it is
 * downstream of three fields that are easy to fat-finger. Seeing "$0.83 a pack"
 * turn into "$8.33 a pack" while the divisor is being typed is how a wrong
 * boxes-per-case gets caught here, rather than as an unexplainable loss on a
 * day's P&L weeks later.
 *
 * A missing figure names the field that is missing. "—" would be true and
 * useless: the whole value of this panel is that it says what to go and fix.
 */
function UnitEconomics({
  unitType,
  boxesPerCase,
  packsPerBox,
  giveawayItem,
  unitCost
}: {
  unitType: UnitType
  boxesPerCase: number | null
  packsPerBox: number | null
  giveawayItem: boolean
  unitCost: number | null
}): JSX.Element {
  const stockUnit = stockUnitOf(unitType)

  if (!stockUnit) {
    return (
      <div className="inv-unit-econ">
        <p className="iue-none">
          <Icon name="Info" size={13} />
          Box and pack economics only apply to products stocked in cases or boxes.
        </p>
      </div>
    )
  }

  const units: ProductUnits = { unitType: stockUnit, boxesPerCase, packsPerBox, giveawayItem }
  const cost = unitCost ?? 0
  const perBox = boxCost(units, cost)
  const perPack = packCost(units, cost)

  // The contract returns null for every failure alike; the operator needs to
  // know WHICH one, so the same preconditions are read back here in the order
  // they would be fixed in.
  const noCost = cost <= 0
  const boxWhy = noCost
    ? 'Enter an average cost first.'
    : stockUnit === 'case' && !boxesPerCase
      ? 'Set boxes per case.'
      : null
  const packWhy = boxWhy ?? (!packsPerBox ? 'Set packs per box.' : null)

  return (
    <div className="inv-unit-econ">
      <span className="iue-head">
        <Icon name="Calculator" size={13} />
        Derived from {stockUnit === 'case' ? 'the case cost' : 'the box cost'}
      </span>

      <div className="iue-grid">
        <EconCell
          label="Cost per box"
          value={perBox}
          why={boxWhy}
          workings={
            stockUnit === 'case' && boxesPerCase && !noCost
              ? `${formatMoney(cost)} ÷ ${boxesPerCase} boxes`
              : stockUnit === 'box' && !noCost
                ? 'the stock unit is already a box'
                : null
          }
        />
        <EconCell
          label="Cost per pack"
          value={perPack}
          why={packWhy}
          workings={
            perBox !== null && packsPerBox ? `${formatMoney(perBox)} ÷ ${packsPerBox} packs` : null
          }
          /* Pack cost is what a giveaway is booked at, so on a giveaway item a
             missing one is a real gap rather than a nicety. */
          emphasis={giveawayItem}
        />
      </div>

      {giveawayItem && perPack === null && (
        <p className="iue-warn">
          <Icon name="AlertTriangle" size={13} />
          This is flagged as a giveaway item but a pack cannot be costed yet, so a giveaway of packs
          would book no loss at all.
        </p>
      )}
    </div>
  )
}

function EconCell({
  label,
  value,
  why,
  workings,
  emphasis = false
}: {
  label: string
  value: number | null
  /** Why there is no number — names the field to go and fill in. */
  why: string | null
  /** The arithmetic, so a wrong divisor is visible as a wrong divisor. */
  workings: string | null
  emphasis?: boolean
}): JSX.Element {
  return (
    <div className={`iue-cell${emphasis ? ' is-key' : ''}`}>
      <span className="iue-label">{label}</span>
      {value !== null ? (
        <b className="iue-value mono">{formatMoney(value)}</b>
      ) : (
        <b className="iue-value is-missing">{why ?? 'Not available'}</b>
      )}
      {value !== null && workings && <em className="iue-workings">{workings}</em>}
    </div>
  )
}
