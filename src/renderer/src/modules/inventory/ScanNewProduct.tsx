import { useEffect, useRef, useState } from 'react'
import type { InventoryProduct, UnitType } from '@shared/types'
import { CATEGORY_ORDER, LOCATIONS } from '@shared/inventory'
import { api } from '../../lib/api'
import { Button, Select } from '../../components/ui'
import { Icon } from '../../components/Icon'

/**
 * Add an uncatalogued item WITHOUT leaving the scan station.
 *
 * This replaces two buttons that both called `setScanning(false)`: one opened
 * the Catalog on the code, the other opened the new-product modal. Either way
 * the station unmounted — and the pending list lives in its state, so a stack of
 * twelve already-scanned boxes was silently discarded the moment the thirteenth
 * turned out to be unknown. Receiving a shipment is exactly when unknown items
 * appear, so that was the worst possible moment to lose the count.
 *
 * The form is deliberately the MINIMUM needed to put stock on a shelf honestly:
 * what it is, what it cost, where it goes. Everything else about the product —
 * brand, set, year, boxes per case, images — is catalog housekeeping that can be
 * filled in later without holding up a pallet.
 *
 * Cost is REQUIRED here for the same reason it is required on the queue: a
 * product created at zero cost puts its whole market value into Spread and the
 * zero cost layer never washes out.
 */

const UNIT_TYPES: { id: UnitType; label: string }[] = [
  { id: 'case', label: 'Case' },
  { id: 'box', label: 'Box' },
  { id: 'pack', label: 'Pack' },
  { id: 'single', label: 'Single' },
  { id: 'other', label: 'Other' }
]

/** Guess the unit from the name the operator typed — overridable, never silent. */
function guessUnit(name: string): UnitType {
  if (/\bcase\b/i.test(name)) return 'case'
  if (/\bpack\b/i.test(name)) return 'pack'
  if (/\bbox\b/i.test(name)) return 'box'
  return 'box'
}

export function ScanNewProduct({
  code,
  defaultLocation,
  categories,
  onCancel,
  onCreated
}: {
  /** The barcode that was not recognised. Fixed — this is the whole point. */
  code: string
  defaultLocation: string
  /** Categories already in the catalog, so a new item joins an existing one. */
  categories: string[]
  onCancel: () => void
  onCreated: (product: InventoryProduct, unitCost: number, quantity: number, location: string) => void
}): JSX.Element {
  const [name, setName] = useState('')
  const [category, setCategory] = useState(categories[0] ?? CATEGORY_ORDER[0])
  const [unitType, setUnitType] = useState<UnitType>('box')
  const [cost, setCost] = useState('')
  const [market, setMarket] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [location, setLocation] = useState(defaultLocation)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement | null>(null)

  // The operator's hands are on the keyboard already — land them in the one
  // field only they can fill.
  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  // The unit follows the name until the operator says otherwise.
  const [unitTouched, setUnitTouched] = useState(false)
  useEffect(() => {
    if (!unitTouched) setUnitType(guessUnit(name))
  }, [name, unitTouched])

  const costValue = parseFloat(cost.trim())
  const qtyValue = parseInt(quantity.trim(), 10)
  const nameOk = name.trim().length > 0
  const costOk = Number.isFinite(costValue) && costValue > 0
  const qtyOk = Number.isInteger(qtyValue) && qtyValue >= 1
  const ready = nameOk && costOk && qtyOk && !saving

  const save = async (): Promise<void> => {
    if (!ready) return
    setSaving(true)
    setError(null)
    try {
      const marketValue = parseFloat(market.trim())
      const res = await api.inventory.create({
        sku: '',
        upc: code,
        name: name.trim(),
        category,
        brand: '',
        setName: '',
        year: '',
        unitType,
        // Left unknown deliberately: a divisor nobody has confirmed makes every
        // cases-to-boxes conversion refuse, which is the safe state.
        boxesPerCase: null,
        packsPerBox: null,
        unitCost: costValue,
        highBid: Number.isFinite(marketValue) && marketValue > 0 ? marketValue : null,
        salePrice: null,
        reorderPoint: 0,
        notes: null,
        // ZERO opening stock on purpose. The units this scan is receiving go on
        // through the ordinary pending-list commit, so there is exactly one code
        // path that moves stock and writes a cost layer — creating the product
        // with opening stock here would be a second one.
        openingQuantity: 0,
        openingLocation: location
      })
      if (!res.ok || !res.data) {
        setError(res.error ?? 'That product could not be created.')
        return
      }
      onCreated(res.data, costValue, qtyValue, location)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That product could not be created.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="scan-result scan-newproduct">
      <div className="scan-newproduct-head">
        <Icon name="PackagePlus" size={18} />
        <div>
          <div className="scan-unknown-title">Add this item</div>
          <div className="scan-newproduct-code mono">{code}</div>
        </div>
      </div>

      <div className="scan-newproduct-grid">
        <label className="field scan-np-name">
          <span>What is it?</span>
          <input
            ref={nameRef}
            className="input"
            value={name}
            placeholder="2026 Topps Chrome Baseball Hobby Box"
            disabled={saving}
            onChange={(e) => setName(e.target.value)}
            // Enter saves, so a whole item can be added without reaching for the
            // mouse mid-shipment.
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ready) {
                e.preventDefault()
                void save()
              }
            }}
          />
        </label>

        <label className="field">
          <span>Category</span>
          <Select value={category} disabled={saving} onChange={(e) => setCategory(e.target.value)}>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </label>

        <label className="field">
          <span>Counted in</span>
          <Select
            value={unitType}
            disabled={saving}
            onChange={(e) => {
              setUnitTouched(true)
              setUnitType(e.target.value as UnitType)
            }}
          >
            {UNIT_TYPES.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </Select>
        </label>

        <label className="field">
          <span>
            Unit cost <em className="scan-queue-cost-req">required</em>
          </span>
          <input
            className={`input${cost.trim() !== '' && !costOk ? ' field-error' : ''}`}
            type="number"
            min={0}
            step="0.01"
            value={cost}
            placeholder="0.00"
            disabled={saving}
            onChange={(e) => setCost(e.target.value)}
          />
        </label>

        <label className="field">
          <span>Market value</span>
          <input
            className="input"
            type="number"
            min={0}
            step="0.01"
            value={market}
            placeholder="optional"
            disabled={saving}
            onChange={(e) => setMarket(e.target.value)}
          />
        </label>

        <label className="field">
          <span>How many?</span>
          <input
            className={`input${quantity.trim() !== '' && !qtyOk ? ' field-error' : ''}`}
            type="number"
            min={1}
            step={1}
            value={quantity}
            disabled={saving}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </label>

        <div className="field scan-np-loc">
          <span>Where</span>
          <div className="loc-pills">
            {LOCATIONS.map((l) => (
              <button
                key={l.id}
                type="button"
                className={`loc-pill ${location === l.id ? 'active' : ''}`}
                disabled={saving}
                onClick={() => setLocation(l.id)}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="scan-banner scan-banner-error">
          <Icon name="AlertCircle" size={16} />
          <span>{error}</span>
        </div>
      )}

      <div className="scan-actions scan-actions-center">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button variant="primary" icon="Plus" loading={saving} disabled={!ready} onClick={() => void save()}>
          Add it and keep scanning
        </Button>
      </div>
      {!ready && !saving && (
        <div className="scan-newproduct-hint">
          {!nameOk
            ? 'Give it a name.'
            : !costOk
              ? 'Enter what it cost — without it the stock goes on the shelf at $0.00.'
              : 'Enter how many you are scanning in.'}
        </div>
      )}
    </div>
  )
}
