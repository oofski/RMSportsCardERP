import { useCallback, useEffect, useState } from 'react'
import type { Employee } from '@shared/types'
import type { StreamItem, StreamItemKind, StreamSessionDetail } from '@shared/streaming'
import {
  formatDuration,
  isPastDatedSession,
  isSuspiciouslyLong,
  parseMoneyInput,
  statedPriceUnit
} from '@shared/streaming'
import { formatMoney } from '../../lib/format'
import { formatUnitCount, stockUnitWord, typedEntryLabel } from '../../lib/productUnits'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { Button, CenterLoader, EmptyState, Field, Input, Modal } from '../../components/ui'
import { AddItemForm } from './AddItemForm'
import { SessionFormModal } from './SessionFormModal'
import { LiveChip, SourceChip, TimeSpan } from './bits'
import { costEntryReady, resultError, streaming } from './api'
import { longDayLabel } from './time'

/**
 * One session, in full — the screen where the money actually gets attributed.
 *
 * Both writes that move stock (add a line, remove a line) return the freshly
 * derived detail, so this screen reconciles from the response rather than
 * refetching: the totals a user sees are the totals the main process just
 * computed, never a second read that could disagree with them.
 */
export function SessionDetail({
  id,
  canManage,
  canSearchCatalog,
  hosts,
  onBack,
  onChanged
}: {
  id: string
  canManage: boolean
  /** The product picker reads the Inventory catalog, which has its own gate. */
  canSearchCatalog: boolean
  hosts: Employee[]
  onBack: () => void
  /** Tells the shell the calendar/list and the live bar need re-reading. */
  onChanged: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [detail, setDetail] = useState<StreamSessionDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  const [adding, setAdding] = useState<StreamItemKind | null>(null)
  const [removing, setRemoving] = useState<StreamItem | null>(null)
  /** The line whose cost is being typed in — "we might not always know in the
   *  moment", so a line can be recorded now and priced whenever the invoice
   *  turns up. */
  const [costing, setCosting] = useState<StreamItem | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const next = await streaming.get(id)
        if (!active) return
        setDetail(next)
        if (!next) setError('That stream could not be found. It may have been deleted.')
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Could not load that stream.')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [id, attempt])

  const applyDetail = useCallback(
    async (next: StreamSessionDetail) => {
      setDetail(next)
      await onChanged()
    },
    [onChanged]
  )

  const removeLine = async (): Promise<void> => {
    if (!removing) return
    setBusy(true)
    try {
      const res = await streaming.removeItem(removing.id)
      if (!res.ok || !res.data) {
        toast.error(resultError(res, 'Could not remove that line.'))
        return
      }
      const entry = typedEntryLabel(removing) ?? `${formatUnitCount(removing.quantity)} ×`
      toast.success(
        removing.statedCasePrice !== null
          ? `${entry} ${removing.productName} off this show — ${formatMoney(
              removing.costTotal
            )} no longer booked to it.`
          : `${entry} ${removing.productName} back into ${removing.location}.`
      )
      setRemoving(null)
      await applyDetail(res.data)
    } finally {
      setBusy(false)
    }
  }

  const deleteSession = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await streaming.remove(id)
      if (!res.ok) {
        toast.error(resultError(res, 'Could not delete that stream.'))
        return
      }
      toast.success('Stream deleted and its stock returned.')
      setConfirmDelete(false)
      await onChanged()
      onBack()
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <CenterLoader />

  if (error || !detail) {
    return (
      <EmptyState
        icon="AlertTriangle"
        title="Could not open that stream"
        message={error ?? 'It could not be read.'}
        action={
          <div className="stm-empty-acts">
            <Button icon="ArrowLeft" onClick={onBack}>
              Back
            </Button>
            <Button variant="primary" icon="RefreshCw" onClick={() => setAttempt((a) => a + 1)}>
              Try again
            </Button>
          </div>
        }
      />
    )
  }

  const { session, items, totals } = detail
  const breaks = items.filter((i) => i.kind === 'break')
  const giveaways = items.filter((i) => i.kind === 'giveaway')
  const runaway = isSuspiciouslyLong(session)
  // Which act adding a line to THIS show is. The same rule main enforces on the
  // write, so the form the operator is given is the one that will be accepted.
  const reconcile = isPastDatedSession(session)

  return (
    <section className="stm-detail">
      <div className="stm-detail-head">
        <button type="button" className="stm-back" onClick={onBack}>
          <Icon name="ArrowLeft" size={16} />
          Back
        </button>
        <h2 className="stm-detail-title">{session.title}</h2>
        {session.status === 'live' && <LiveChip />}
        <SourceChip source={session.source} />
        {canManage && (
          <div className="stm-detail-acts">
            <Button size="sm" icon="Pencil" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button size="sm" variant="danger" icon="Trash2" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </div>
        )}
      </div>

      <div className="stm-detail-meta">
        <MetaItem icon="CalendarDays" label="Stream date" value={longDayLabel(session.streamDate)} />
        <MetaItem icon="Clock" label="On air" node={<TimeSpan session={session} />} />
        <MetaItem
          icon="Timer"
          label="Duration"
          value={session.status === 'live' ? 'Running' : formatDuration(session.durationMinutes)}
        />
        <MetaItem icon="User" label="Host" value={session.hostName ?? 'Nobody recorded'} />
      </div>

      {runaway && session.status === 'live' && (
        <div className="stm-inline-note warn" role="alert">
          <Icon name="AlertTriangle" size={14} />
          This session has been open far longer than a show runs. End it — or edit the end time to
          when the show actually finished — before it claims another day of sales.
        </div>
      )}

      {/* Said once, at the top, and said plainly. Everything below behaves
          differently on a show that is already history, and an operator who has
          to work that out from the fields has already been surprised by it. */}
      {reconcile && (
        <div className="stm-inline-note recon">
          <Icon name="History" size={14} />
          <span>
            <b>This show is history.</b> Anything added here records what was broken and what it
            cost — counted in the unit each product is stocked in, at the price you paid for one of
            them. It does not move today&rsquo;s stock, because that stock left the shelf on the
            night.
          </span>
        </div>
      )}

      {session.note && (
        <div className="stm-inline-note">
          <Icon name="StickyNote" size={14} />
          {session.note}
        </div>
      )}

      <div className="stm-totals">
        <TotalCard
          icon="Layers"
          label="Broken"
          units={totals.breakUnits}
          lines={totals.breakLines}
          cost={totals.breakCost}
        />
        <TotalCard
          icon="Gift"
          label="Given away"
          units={totals.giveawayUnits}
          lines={totals.giveawayLines}
          cost={totals.giveawayCost}
          /* The one figure on this screen that reaches the P&L. Named here so
             the number on the day's Giveaway loss column can be traced back to
             the lines that produced it. */
          extra={
            totals.giveawayLoss > 0
              ? `${formatMoney(totals.giveawayLoss)} booked as a loss`
              : undefined
          }
        />
        <div className="stm-total-card strong">
          <span className="stm-total-label">
            <Icon name="DollarSign" size={14} /> Cost of this show
          </span>
          <b className="mono">{formatMoney(totals.totalCost)}</b>
          <em>
            {reconcile
              ? 'everything broken on air — reconciled lines at the price entered for them'
              : 'everything consumed on air, at FIFO cost'}
          </em>
        </div>
      </div>

      <ItemSection
        kind="break"
        title="Breaks"
        icon="Layers"
        emptyMessage="Nothing has been broken on this show yet."
        items={breaks}
        canManage={canManage}
        canSearchCatalog={canSearchCatalog}
        reconcile={reconcile}
        adding={adding === 'break'}
        onOpenAdd={() => setAdding('break')}
        onCloseAdd={() => setAdding(null)}
        onAdded={(next) => void applyDetail(next)}
        onRemove={setRemoving}
        onCost={setCosting}
        sessionId={session.id}
      />

      <ItemSection
        kind="giveaway"
        title="Giveaways"
        icon="Gift"
        emptyMessage="Nothing has been given away on this show yet."
        items={giveaways}
        canManage={canManage}
        canSearchCatalog={canSearchCatalog}
        reconcile={reconcile}
        adding={adding === 'giveaway'}
        onOpenAdd={() => setAdding('giveaway')}
        onCloseAdd={() => setAdding(null)}
        onAdded={(next) => void applyDetail(next)}
        onRemove={setRemoving}
        onCost={setCosting}
        sessionId={session.id}
      />

      {costing && (
        <CostModal
          item={costing}
          onClose={() => setCosting(null)}
          onSaved={async (next) => {
            setCosting(null)
            await applyDetail(next)
          }}
        />
      )}

      {removing && (
        <Modal
          title={removing.kind === 'break' ? 'Remove this break?' : 'Remove this giveaway?'}
          onClose={() => setRemoving(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setRemoving(null)}>
                Keep it
              </Button>
              <Button
                variant="danger"
                icon="Undo2"
                loading={busy}
                onClick={() => void removeLine()}
              >
                {removing.statedCasePrice !== null ? 'Remove the line' : 'Remove and return stock'}
              </Button>
            </>
          }
        >
          {/* Named the way it was recorded, so the operator can match this
              against the line they clicked rather than against a converted
              number they never typed. */}
          {removing.statedCasePrice !== null ? (
            /* A reconciliation took no stock, so none comes back. Saying "goes
               back into RM" here would promise a movement that will not happen
               and leave the operator looking for it in Inventory. */
            <p className="stm-confirm-lead">
              <b>
                {typedEntryLabel(removing) ?? `${formatUnitCount(removing.quantity)} ×`}{' '}
                {removing.productName}
              </b>{' '}
              stops being carried by this show, and the {formatMoney(removing.costTotal)} it booked
              comes off the night. No stock moves — none moved when it was recorded.
            </p>
          ) : (
            <>
              <p className="stm-confirm-lead">
                <b>
                  {typedEntryLabel(removing) ?? `${formatUnitCount(removing.quantity)} ×`}{' '}
                  {removing.productName}
                </b>{' '}
                goes back into <b>{removing.location}</b> at the cost it came out at (
                {formatMoney(removing.costTotal)}), and this show stops carrying it.
              </p>
              {typedEntryLabel(removing) && (
                <p className="stm-confirm-lead">
                  That is {formatUnitCount(removing.quantity)} in stock units — the amount that was
                  taken off the shelf and the amount that goes back on it.
                </p>
              )}
            </>
          )}
        </Modal>
      )}

      {confirmDelete && (
        <Modal
          title="Delete this stream?"
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                icon="Trash2"
                loading={busy}
                onClick={() => void deleteSession()}
              >
                Delete the stream
              </Button>
            </>
          }
        >
          <p className="stm-confirm-lead">
            <b>{session.title}</b> on {longDayLabel(session.streamDate)} is removed for good.
          </p>
          {items.length > 0 ? (
            <p className="stm-confirm-lead">
              Its {totals.breakLines + totals.giveawayLines} line
              {totals.breakLines + totals.giveawayLines === 1 ? '' : 's'} —{' '}
              {formatUnitCount(totals.breakUnits + totals.giveawayUnits)} stock units worth{' '}
              {formatMoney(totals.totalCost)} — are reversed
              {/* A reconciliation never took stock, so promising its return here
                  would be a movement the operator then goes looking for. */}
              {items.every((i) => i.statedCasePrice !== null)
                ? '. Nothing goes back on the shelf — every line on this show is a reconciliation and moved no stock.'
                : items.some((i) => i.statedCasePrice !== null)
                  ? ', and the stock the un-reconciled ones took goes back where it came from.'
                  : ', and that stock goes back where it came from.'}
            </p>
          ) : (
            <p className="stm-confirm-lead">Nothing was consumed on it, so no stock moves.</p>
          )}
        </Modal>
      )}

      {editing && (
        <SessionFormModal
          session={session}
          hosts={hosts}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false)
            setAttempt((a) => a + 1)
            await onChanged()
          }}
        />
      )}
    </section>
  )
}

function MetaItem({
  icon,
  label,
  value,
  node
}: {
  icon: string
  label: string
  value?: string
  node?: JSX.Element
}): JSX.Element {
  return (
    <div className="stm-meta-item">
      <span className="stm-meta-label">
        <Icon name={icon} size={13} /> {label}
      </span>
      {node ?? <b>{value}</b>}
    </div>
  )
}

function TotalCard({
  icon,
  label,
  units,
  lines,
  cost,
  extra
}: {
  icon: string
  label: string
  units: number
  lines: number
  cost: number
  /** An extra line under the caption, when there is one worth saying. */
  extra?: string
}): JSX.Element {
  return (
    <div className="stm-total-card">
      <span className="stm-total-label">
        <Icon name={icon} size={14} /> {label}
      </span>
      {/* "stock units" rather than a unit noun: a show mixes case-stocked and
          box-stocked products, so there is no single word that is true of the
          sum. The per-line rows below say which is which. */}
      <b className="mono">
        {formatUnitCount(units)} <span className="stm-total-unit">stock units</span>
      </b>
      <em>
        {lines} line{lines === 1 ? '' : 's'} · {formatMoney(cost)}
      </em>
      {extra && <em className="stm-total-extra">{extra}</em>}
    </div>
  )
}

function ItemSection({
  kind,
  title,
  icon,
  emptyMessage,
  items,
  canManage,
  canSearchCatalog,
  reconcile,
  adding,
  sessionId,
  onOpenAdd,
  onCloseAdd,
  onAdded,
  onRemove,
  onCost
}: {
  kind: StreamItemKind
  title: string
  icon: string
  emptyMessage: string
  items: StreamItem[]
  canManage: boolean
  canSearchCatalog: boolean
  /** The show is history: adding to it records what it cost, not what it takes. */
  reconcile: boolean
  adding: boolean
  sessionId: string
  onOpenAdd: () => void
  onCloseAdd: () => void
  onAdded: (detail: StreamSessionDetail) => void
  onRemove: (item: StreamItem) => void
  /** Type in what this line cost, whenever the invoice turns up. */
  onCost: (item: StreamItem) => void
}): JSX.Element {
  const units = items.reduce((n, i) => n + i.quantity, 0)
  const cost = items.reduce((n, i) => n + i.costTotal, 0)

  return (
    <section className="stm-section">
      <div className="stm-section-head">
        <span className="stm-section-title">
          <Icon name={icon} size={15} /> {title}
          {items.length > 0 && (
            <span className="stm-count mono">
              {formatUnitCount(units)} stock units · {formatMoney(cost)}
            </span>
          )}
        </span>
        {canManage && !adding && (
          /* The button says which act it opens, so the mode is known before the
             form is even on screen. */
          <Button size="sm" icon={reconcile ? 'History' : 'Plus'} onClick={onOpenAdd}>
            {reconcile
              ? kind === 'break'
                ? 'Reconcile a break'
                : 'Reconcile a giveaway'
              : kind === 'break'
                ? 'Add break'
                : 'Add giveaway'}
          </Button>
        )}
      </div>

      {adding && (
        <AddItemForm
          sessionId={sessionId}
          kind={kind}
          canSearchCatalog={canSearchCatalog}
          reconcile={reconcile}
          onAdded={onAdded}
          onCancel={onCloseAdd}
        />
      )}

      {items.length === 0 ? (
        <div className="stm-empty-row">
          <Icon name="Moon" size={14} />
          {emptyMessage}
        </div>
      ) : (
        <div className="stm-lines">
          {items.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              canManage={canManage}
              onRemove={onRemove}
              onCost={onCost}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function ItemRow({
  item,
  canManage,
  onRemove,
  onCost
}: {
  item: StreamItem
  canManage: boolean
  onRemove: (item: StreamItem) => void
  onCost: (item: StreamItem) => void
}): JSX.Element {
  // How the line was TYPED. A break of 2 cases + 3 boxes on a box-stocked
  // product is stored as 27 boxes, and 27 is the number that moved stock — but
  // it is not the number anybody entered, and a line nobody recognises is a line
  // nobody will correct. Both are shown; the entry leads.
  const entry = typedEntryLabel(item)
  // Which unit the stated price is PER. A reconciliation is priced in the unit
  // the product is stocked in, and this list mixes both kinds — so the tag reads
  // it off the line rather than saying "case" for everything, which was wrong on
  // every box-stocked line by however many boxes a case holds.
  const priceUnit = item.statedCasePrice !== null ? statedPriceUnit(item) : null
  // Nobody ever said what this cost. Read off the figure the P&L books for this
  // line — `lossValue` on a giveaway, `costTotal` on a break — so this row and
  // the statement can never disagree about which lines are the holes.
  const uncosted = (item.kind === 'giveaway' ? item.lossValue : item.costTotal) === 0

  return (
    <div className="stm-line">
      <span className="stm-line-thumb">
        {item.image ? (
          <img src={item.image} alt="" />
        ) : (
          <Icon name="Package" size={18} />
        )}
      </span>

      <span className="stm-line-main">
        <b className="stm-line-name">{item.productName}</b>
        <span className="stm-line-meta">
          <span className="mono">{item.sku}</span>
          <span>{item.category || 'Uncategorized'}</span>
          <span className="stm-loc">{item.location}</span>
          {entry && (
            <span className="stm-line-tag is-entry" title="Recorded as">
              <Icon name="Boxes" size={10} />
              {entry}
            </span>
          )}
          {/* This line is a statement about what stock cost, not a record of
              stock moving. Both are on the same list and they are not the same
              thing, so the one that moved nothing says so. */}
          {item.statedCasePrice !== null && priceUnit && (
            <span
              className="stm-line-tag is-recon"
              title={`Reconciled after the show at ${formatMoney(
                item.statedCasePrice
              )} a ${priceUnit}. No stock moved.`}
            >
              <Icon name="History" size={10} />
              {formatMoney(item.statedCasePrice)}/{priceUnit}
            </span>
          )}
          {item.breakNumber !== null && (
            <span className="stm-line-tag">
              <Icon name="Hash" size={10} />
              Break {item.breakNumber}
            </span>
          )}
          {item.recipient && (
            <span className="stm-line-tag">
              <Icon name="User" size={10} />
              {item.recipient}
            </span>
          )}
        </span>
        {item.note && <span className="stm-line-note">{item.note}</span>}
      </span>

      <span
        className="stm-line-qty mono"
        title={
          entry
            ? `${entry} — ${formatUnitCount(item.quantity)} in this product's stock unit`
            : 'Stock units consumed'
        }
      >
        ×{formatUnitCount(item.quantity)}
      </span>
      <span className="stm-line-unit mono" title="Cost per stock unit">
        {formatMoney(item.unitCost)}
      </span>
      <span className="stm-line-total mono" title="Total cost of this line">
        {/* NOTHING WAS EVER RECORDED, said in words rather than as $0.00. The
            same distinction the P&L now makes, on the screen the line lives on:
            a zero here is not "this was free", it is "nobody has priced it", and
            the two lead to completely different actions. */}
        {uncosted ? <span className="stm-line-uncosted">no cost recorded</span> : formatMoney(item.costTotal)}
        {/* Giveaways carry a second figure: what the stock was worth, which is
            what the P&L books. It sits under the FIFO cost rather than replacing
            it because the two answer different questions and are usually — but
            not always — the same number. */}
        {item.kind === 'giveaway' && item.lossValue > 0 && (
          <span
            className="stm-line-loss"
            title={
              item.packCost !== null
                ? `Booked as a giveaway loss. One pack of this cost ${formatMoney(item.packCost)}.`
                : 'Booked as a giveaway loss.'
            }
          >
            {formatMoney(item.lossValue)} loss
          </span>
        )}
      </span>

      {canManage ? (
        <>
          {/* Offered on EVERY line, not only the uncosted ones. A price typed
              wrong is as much a wrong statement as a price never typed, and the
              button that fixes the first is the one that fixes the second.
              Hidden entirely against a preload that predates the write, rather
              than offered and then failing on click. */}
          {costEntryReady && (
            <button
              type="button"
              className={`stm-line-cost${uncosted ? ' is-missing' : ''}`}
              onClick={() => onCost(item)}
              aria-label={`Enter what ${item.productName} cost`}
              title={
                uncosted
                  ? 'Nobody recorded what this cost — enter it'
                  : 'Correct what this line cost'
              }
            >
              <Icon name="DollarSign" size={14} />
            </button>
          )}
          <button
            type="button"
            className="stm-line-remove"
            onClick={() => onRemove(item)}
            aria-label={`Remove ${entry ?? `${formatUnitCount(item.quantity)} ×`} ${item.productName}`}
            title="Remove and return the stock"
          >
            <Icon name="Trash2" size={14} />
          </button>
        </>
      ) : (
        <span className="stm-line-remove placeholder" aria-hidden="true" />
      )}
    </div>
  )
}

/**
 * Type in what a line cost, whenever the number turns up.
 *
 * The owner: "give me the ability in the streaming or finance to enter the price
 * … since we might not always know in the moment." Two things this form is
 * careful about, and both of them are on screen rather than only in the code:
 *
 * WHICH UNIT the price is per. The product's own — per case for a case-stocked
 * product, per box for a box-stocked one — read off `stockUnit`, exactly as
 * `AddItemForm` does it. A form that said "case" on a product bought by the box
 * would be wrong by however many boxes a case holds, silently, in the only field
 * that was going to say what the night cost.
 *
 * WHAT IT CHANGES. The statement, not the stock. Said in the panel, because the
 * operator's reasonable expectation of a cost field is that it re-values the
 * shelf — and it does not, on either kind of line. See `setItemCost`.
 */
function CostModal({
  item,
  onClose,
  onSaved
}: {
  item: StreamItem
  onClose: () => void
  onSaved: (detail: StreamSessionDetail) => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [raw, setRaw] = useState(item.costTotal > 0 ? String(item.unitCost) : '')
  const [busy, setBusy] = useState(false)

  const price = parseMoneyInput(raw)
  const valid = Number.isFinite(price) && price >= 0
  const unitWord = item.stockUnit ? stockUnitWord(item.stockUnit, 1) : 'unit'
  const unitPlural = item.stockUnit ? stockUnitWord(item.stockUnit, 2) : 'units'
  // Recomputed on screen from the same multiplication main will do, so the total
  // that lands on the show is the total that was agreed to before the click.
  const total = valid ? Math.round(item.quantity * price * 100) / 100 : null

  const save = async (): Promise<void> => {
    if (!valid) return
    setBusy(true)
    try {
      const res = await streaming.setItemCost({ itemId: item.id, unitPrice: price })
      if (!res.ok || !res.data) {
        toast.error(resultError(res, 'That cost could not be saved.'))
        return
      }
      toast.success(
        `${item.productName} now costs this show ${formatMoney(
          Math.round(item.quantity * price * 100) / 100
        )}.`
      )
      await onSaved(res.data)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={item.costTotal > 0 ? 'Correct what this cost' : 'What did this cost?'}
      subtitle={item.productName}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="DollarSign"
            loading={busy}
            disabled={!valid}
            onClick={() => void save()}
          >
            Save the cost
          </Button>
        </>
      }
    >
      <Field
        label={`Price paid per ${unitWord}`}
        hint={`This line is ${formatUnitCount(item.quantity)} ${
          item.quantity === 1 ? unitWord : unitPlural
        }. Decimals are fine — 1.25, 1.33.`}
      >
        {/* A text input, not a number one: money is typed with commas and dollar
            signs, and a number input silently discards the lot — leaving a field
            that looks empty for a price the operator is sure they entered. */}
        <Input
          inputMode="decimal"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="2400"
          invalid={raw.trim() !== '' && !valid}
          autoFocus
        />
      </Field>

      {total !== null && (
        <p className="stm-confirm-lead">
          This show will carry <b>{formatMoney(total)}</b> for it —{' '}
          {formatUnitCount(item.quantity)} × {formatMoney(price)}.
        </p>
      )}

      <p className="stm-confirm-lead">
        <b>This corrects the record, not the stock.</b>{' '}
        {item.statedCasePrice !== null
          ? 'This line never moved stock — it states what a show that is already history cost — so there is nothing on the shelf for a price to change.'
          : `The ${formatUnitCount(item.quantity)} ${
              item.quantity === 1 ? unitWord : unitPlural
            } came off ${item.location} when this was recorded and are already gone. The cost layers they took are left exactly as they are; what changes is what the statement says this night cost.`}
      </p>
    </Modal>
  )
}
