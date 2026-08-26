import { useCallback, useEffect, useState } from 'react'
import type { Consignment } from '@shared/consignment'
import { consignedCost, consignedUnits, consignmentStatusLabel } from '@shared/consignment'
import { api } from '../../lib/api'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { formatDate, formatMoney } from '../../lib/format'

/**
 * WHERE THE CASES THAT ARE NOT HERE ARE.
 *
 * Sending on consignment takes units off the shelf — that is what makes them
 * unsellable and unbreakable — which means the on-hand figure stops mentioning
 * them entirely. Without this panel a case handed to a shop would simply
 * VANISH from the product: the count would drop and nothing anywhere would say
 * where three cases went.
 *
 * ## Settled rows stay
 *
 * "This went to Fenwick in March and came back in April" is the history
 * somebody opens this for. Only the OPEN ones are summed — see consignedUnits,
 * which is deliberate: counting a returned consignment would double what the
 * business believes it owns, since its units are back on the shelf and being
 * counted there.
 *
 * ## It loads on demand
 *
 * One read per product, and the catalog can be showing thirty. Same rule
 * ProductOrigins follows: the cost of the answer is paid by whoever wants it.
 */
export function ProductConsignments({
  productId,
  unitNoun,
  canManage,
  onChanged
}: {
  productId: string
  /** "case" / "box" — what one unit of this product is called. */
  unitNoun: string
  /** Without it the rows still read; there is just nothing to press. */
  canManage: boolean
  /** The shelf moves when a consignment settles, so the catalog re-reads. */
  onChanged: () => void | Promise<void>
}): JSX.Element | null {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<Consignment[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  /** How many are out, read whether or not the panel has been opened — it is
   *  what decides whether this component draws at all. */
  const [outUnits, setOutUnits] = useState<number | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const list = await api.inventory.consignmentsFor(productId).catch(() => [])
    setRows(list)
    setOutUnits(consignedUnits(list))
  }, [productId])

  useEffect(() => {
    setRows(null)
    setOutUnits(null)
    void load()
  }, [load])

  // NOTHING AT ALL on a product that has never been consigned. A collapsed
  // panel saying "0 out" on every row of a catalog is a question mark beside
  // stock that is completely fine.
  if (!rows || rows.length === 0) return null

  const out = rows.filter((r) => r.status === 'out')
  const settle = async (row: Consignment, outcome: 'returned' | 'sold'): Promise<void> => {
    if (busy) return
    setBusy(row.id)
    try {
      const res = await api.inventory.settleConsignment(row.id, outcome)
      if (!res.ok) {
        toast.error(res.error ?? 'Could not settle that.')
        return
      }
      toast.success(
        outcome === 'returned'
          ? `${row.quantity} back on the ${row.location} shelf.`
          : `Marked sold by ${row.consignee}.`
      )
      await load()
      await onChanged()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="po-origins">
      <button
        type="button"
        className={`po-origins-toggle ${open ? 'on' : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={open ? 'ChevronDown' : 'ChevronRight'} size={13} />
        <span>On consignment</span>
        {/* The headline before it is opened, because the reason to open it is
            almost always "how much is out" and that is answerable without the
            list. */}
        <span className="po-origins-count">
          {(outUnits ?? 0) > 0
            ? `${outUnits} ${outUnits === 1 ? unitNoun : unitNoun + 's'} out · ${formatMoney(consignedCost(rows))}`
            : 'nothing out'}
        </span>
      </button>

      {open && (
        <div className="po-origins-body">
          {out.length === 0 ? (
            <div className="po-origins-note">Nothing is out at the moment.</div>
          ) : (
            out.map((r) => (
              <div className="po-origins-row cons-row" key={r.id}>
                <div className="po-origins-main">
                  <b>{r.consignee}</b>
                  <span>
                    {r.quantity} {r.quantity === 1 ? unitNoun : unitNoun + 's'} ·{' '}
                    {formatMoney(r.costTotal)} · off {r.location} · sent {formatDate(r.sentAt)}
                    {r.note ? ` · ${r.note}` : ''}
                  </span>
                </div>
                {canManage && (
                  <div className="cons-acts">
                    {/* CAME BACK first and styled as the ordinary one: it is the
                        reversible outcome. Marking a case sold writes off stock
                        that is genuinely gone, and there is no undo for it — so
                        it is the quieter button, not the loud one. */}
                    <button
                      type="button"
                      className="btn po-move"
                      disabled={busy === r.id}
                      title={`Put ${r.quantity} back on the ${r.location} shelf at the price they left at`}
                      onClick={() => void settle(r, 'returned')}
                    >
                      <Icon name="RotateCcw" size={13} />
                      Came back
                    </button>
                    <button
                      type="button"
                      className="btn po-move"
                      disabled={busy === r.id}
                      title="They sold it — the stock stays gone and you settle up outside the app"
                      onClick={() => void settle(r, 'sold')}
                    >
                      They sold it
                    </button>
                  </div>
                )}
              </div>
            ))
          )}

          {/* THE HISTORY, which is most of the reason this panel is worth
              opening once nothing is out: where did those three cases go in
              March. Only drawn when there is any. */}
          {rows.some((r) => r.status !== 'out') && (
            <>
              <div className="po-origins-head">Settled</div>
              {rows
                .filter((r) => r.status !== 'out')
                .map((r) => (
                  <div className="po-origins-row" key={r.id}>
                    <div className="po-origins-main">
                      <b>{r.consignee}</b>
                      <span>
                        {r.quantity} {r.quantity === 1 ? unitNoun : unitNoun + 's'} · sent{' '}
                        {formatDate(r.sentAt)}
                        {r.settledAt ? ` · ${formatDate(r.settledAt)}` : ''}
                      </span>
                    </div>
                    <div className="po-origins-side">
                      <span className={`cons-chip cons-${r.status}`}>
                        {consignmentStatusLabel(r.status)}
                      </span>
                    </div>
                  </div>
                ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
