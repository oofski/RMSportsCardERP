import { useMemo, useState } from 'react'
import type { Supply } from '@shared/types'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Button, Field, Input, Modal } from '../../components/ui'
import { formatMoney } from '../../lib/format'

type Mode = 'purchase' | 'use' | 'adjust'

const MODE_META: Record<Mode, { title: string; icon: string; cta: string }> = {
  purchase: { title: 'Log purchase', icon: 'PackagePlus', cta: 'Add order to stock' },
  use: { title: 'Use / consume', icon: 'PackageMinus', cta: 'Record use' },
  adjust: { title: 'Adjust count', icon: 'Pencil', cta: 'Apply adjustment' }
}

/**
 * Move a supply's on-hand count. "Log purchase" is entered as an order — units
 * bought × items per unit, plus the order total — and the per-unit and per-item
 * cost are derived. "Use" consumes items; "Adjust" corrects the count up/down.
 */
export function SupplyStockModal({
  supply,
  initialMode = 'purchase',
  onClose,
  onSaved
}: {
  supply: Supply
  initialMode?: Mode
  onClose: () => void
  onSaved: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [mode, setMode] = useState<Mode>(initialMode)
  // Order fields (purchase mode).
  const [units, setUnits] = useState('1')
  const [itemsPerUnit, setItemsPerUnit] = useState(String(supply.itemsPerUnit || 1))
  const [total, setTotal] = useState('')
  // Item count (use / adjust modes).
  const [quantity, setQuantity] = useState('1')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const switchMode = (m: Mode): void => {
    setMode(m)
    setError('')
    setQuantity(m === 'adjust' ? '' : '1')
  }

  // Live order breakdown for the purchase form.
  const breakdown = useMemo(() => {
    const u = parseFloat(units)
    const ipu = parseFloat(itemsPerUnit)
    const t = parseFloat(total)
    if (!Number.isFinite(u) || !Number.isFinite(ipu) || u <= 0 || ipu <= 0) return null
    const items = Math.round(u) * Math.round(ipu)
    const hasTotal = Number.isFinite(t) && t >= 0
    return {
      items,
      perUnit: hasTotal && u > 0 ? t / Math.round(u) : null,
      perItem: hasTotal && items > 0 ? t / items : null
    }
  }, [units, itemsPerUnit, total])

  const submit = async (): Promise<void> => {
    setError('')
    setBusy(true)
    try {
      let res
      if (mode === 'purchase') {
        const u = parseInt(units, 10)
        const ipu = parseInt(itemsPerUnit, 10)
        const t = total.trim() === '' ? NaN : parseFloat(total)
        if (!Number.isFinite(u) || u <= 0) {
          setError('Enter at least 1 unit.')
          return
        }
        if (!Number.isFinite(ipu) || ipu < 1) {
          setError('Items per unit must be at least 1.')
          return
        }
        if (!Number.isFinite(t) || t < 0) {
          setError('Enter the order total.')
          return
        }
        res = await api.supplies.purchase(supply.id, {
          units: u,
          itemsPerUnit: ipu,
          total: t,
          note: note.trim() || null
        })
      } else {
        const qty = parseInt(quantity, 10)
        if (!Number.isFinite(qty) || qty === 0) {
          setError('Enter a non-zero quantity.')
          return
        }
        if (mode === 'use' && qty < 0) {
          setError('Quantity must be positive.')
          return
        }
        res =
          mode === 'use'
            ? await api.supplies.use(supply.id, { quantity: qty, note: note.trim() || null })
            : await api.supplies.adjust(supply.id, qty, note.trim() || null)
      }
      if (!res.ok) {
        setError(res.error ?? 'Could not update the supply.')
        return
      }
      toast.success(
        mode === 'purchase'
          ? `Added ${breakdown?.items ?? ''} to ${supply.name}.`
          : mode === 'use'
            ? `Used ${quantity} ${supply.name}.`
            : `Adjusted ${supply.name}.`
      )
      await onSaved()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const meta = MODE_META[mode]

  return (
    <Modal
      title={meta.title}
      subtitle={supply.name}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={meta.icon} loading={busy} onClick={submit}>
            {meta.cta}
          </Button>
        </>
      }
    >
      {error && <div className="auth-alert">{error}</div>}

      <div className="selected-product">
        <div>
          <div className="sp-name">{supply.name}</div>
          <div className="sp-meta">
            <span>{supply.quantity} on hand</span>
            <span>Avg {formatMoney(supply.unitCost)}/{supply.unit}</span>
          </div>
        </div>
      </div>

      <Field label="Action">
        <div className="loc-pills">
          {(['purchase', 'use', 'adjust'] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              className={`loc-pill ${mode === m ? 'active' : ''}`}
              onClick={() => switchMode(m)}
            >
              {MODE_META[m].title}
            </button>
          ))}
        </div>
      </Field>

      {mode === 'purchase' ? (
        <>
          <div className="field-row">
            <Field label="Units ordered" hint="Boxes / packs bought">
              <Input type="number" min={1} step="1" value={units} onChange={(e) => setUnits(e.target.value)} autoFocus />
            </Field>
            <Field label="Items per unit" hint="Pieces in each">
              <Input
                type="number"
                min={1}
                step="1"
                value={itemsPerUnit}
                onChange={(e) => setItemsPerUnit(e.target.value)}
              />
            </Field>
          </div>

          <Field label="Order total" hint="What you paid for the whole order">
            <Input
              type="number"
              min={0}
              step="0.01"
              value={total}
              onChange={(e) => setTotal(e.target.value)}
              placeholder="0.00"
            />
          </Field>

          {breakdown && (
            <div className="supply-order-summary">
              <div className="sos-row">
                <span>Adds to stock</span>
                <strong>
                  {breakdown.items} {supply.unit}
                </strong>
              </div>
              <div className="sos-row">
                <span>Per unit</span>
                <strong>{breakdown.perUnit != null ? formatMoney(breakdown.perUnit) : '—'}</strong>
              </div>
              <div className="sos-row">
                <span>Per item</span>
                <strong>{breakdown.perItem != null ? formatMoney(breakdown.perItem) : '—'}</strong>
              </div>
            </div>
          )}
        </>
      ) : (
        <Field label={mode === 'adjust' ? 'Change (use − to reduce)' : 'Quantity'}>
          <Input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} autoFocus />
        </Field>
      )}

      <Field label="Note" hint="Optional">
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={mode === 'use' ? 'e.g. Shipped 20 orders' : 'e.g. Restock from Amazon'}
        />
      </Field>
    </Modal>
  )
}
