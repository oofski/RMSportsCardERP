import { useCallback, useEffect, useState } from 'react'
import type { OrderResetPreview } from '@shared/orderReset'
import {
  ORDER_RESET_PHRASE,
  describeOrderReset,
  orderResetArmed,
  orderResetIsEmpty,
  orderResetTotal
} from '@shared/orderReset'
import type { SeriesState } from '@shared/numbering'
import {
  formatSeriesNumber,
  seriesHint,
  seriesLabel,
  validateSeriesStart
} from '@shared/numbering'
import { api } from '../../lib/api'
import { Button, CenterLoader, Checkbox, EmptyState, Field, Input, Modal } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'

/**
 * Admin → Numbering: where each document series starts counting.
 *
 * ## Why this screen exists
 *
 * The business had a numbering scheme before this app did. Deal tickets were
 * kept by hand up to 336, invoices were raised in QuickBooks for years, and a
 * purchase order pad has its own history. Every one of those had to be told
 * where to pick up, and until now each was a constant somebody had to change in
 * the source and ship a build for.
 *
 * ## Forward only, and it says so rather than silently clamping
 *
 * Each counter is a floor combined with the highest number actually issued —
 * that is what stops a deleted document handing its number out twice. So a start
 * below what has already gone out is not merely refused by policy; it is a value
 * the generator would ignore. Showing 400 while the app issues 351 is exactly
 * the failure this screen is supposed to prevent, so the field refuses it and
 * names the number it has to clear.
 *
 * ## Nothing here mints a number
 *
 * Every figure is a peek. The two counters that write themselves back as they
 * answer are read through separate peek functions, or opening this screen would
 * burn a purchase order number each time.
 */
export function NumberingTab(): JSX.Element {
  const toast = useToast()
  const [rows, setRows] = useState<SeriesState[] | null>(null)

  const load = useCallback(async () => {
    setRows(await api.invoices.numbering())
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (rows === null) return <CenterLoader />
  if (rows.length === 0) {
    return (
      <EmptyState
        icon="ShieldCheck"
        title="Numbering is an admin setting."
        message="Ask whoever runs the app to change where a series starts."
      />
    )
  }

  return (
    <div>
      <div className="section-head">
        <div>
          <h2>Numbering</h2>
          <p className="section-sub">
            Where each series starts. Changing one affects the <b>next</b> document only —
            nothing already raised is renumbered.
          </p>
        </div>
      </div>

      <div className="num-list">
        {rows.map((s) => (
          <SeriesCard
            key={s.series}
            state={s}
            onSaved={(next, label) => {
              setRows(next)
              toast.success(label)
            }}
          />
        ))}
      </div>

      <HardResetCard />

      <p className="num-foot">
        <Icon name="Info" size={14} />
        <span>
          A series can only move <b>forward</b>. Every counter takes the higher of what you set
          and what has already gone out, so a number below that would be ignored rather than
          used — which is why it is refused here instead.
        </span>
      </p>
    </div>
  )
}

function SeriesCard({
  state,
  onSaved
}: {
  state: SeriesState
  onSaved: (next: SeriesState[], label: string) => void
}): JSX.Element {
  const toast = useToast()
  // Seeded from the current next number, so the box always opens showing what
  // the app would actually do. Re-seeded whenever the series moves underneath
  // it — a save elsewhere on this screen returns all three.
  const [value, setValue] = useState(String(state.next))
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setValue(String(state.next))
  }, [state.next])

  const parsed = Number(value.trim())
  const problem = value.trim() === '' ? 'Type a number.' : validateSeriesStart(state, parsed)
  const changed = Number.isInteger(parsed) && parsed !== state.next

  const save = async (): Promise<void> => {
    if (busy || problem || !changed) return
    setBusy(true)
    try {
      const res = await api.invoices.setNumberingStart(state.series, parsed)
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'That could not be saved.')
        return
      }
      onSaved(
        res.data,
        `${seriesLabel(state.series)} now start at ${formatSeriesNumber(state.series, parsed)}.`
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="num-card">
      <div className="num-card-head">
        <div>
          <h3>{seriesLabel(state.series)}</h3>
          <p className="num-hint">{seriesHint(state.series)}</p>
        </div>
        {/* WHAT THE NEXT DOCUMENT WILL BE, in the series' own format. The whole
            screen is about this one number, so it is the number that is set in
            type rather than the input beside it. */}
        <div className="num-next">
          <span className="num-next-n">{formatSeriesNumber(state.series, state.next)}</span>
          <span className="num-next-l">next</span>
        </div>
      </div>

      <div className="num-card-body">
        <label className="num-field">
          <span>Start at</span>
          <Input
            type="number"
            value={value}
            disabled={busy}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <Button
          variant="primary"
          icon="Save"
          loading={busy}
          disabled={busy || !!problem || !changed}
          onClick={() => void save()}
        >
          Save
        </Button>
      </div>

      {/* THE HALF THIS SCREEN DOES NOT CONTROL.
          The number set here is sent to QuickBooks as DocNumber, and QuickBooks
          silently replaces it unless the company has "Custom transaction
          numbers" switched on — Intuit's own import template warns about this.
          Somebody can set 7000, watch the app say 7000, and have the buyer
          receive 1043. The setting lives over there, so the honest thing is to
          say where it is and then show what has actually been happening. */}
      {state.series === 'invoice' && (
        <p className={state.renumbered ? 'num-warn' : 'num-issued'}>
          <Icon name={state.renumbered ? 'AlertTriangle' : 'Info'} size={13} />
          {state.renumbered ? (
            <span>
              <b>
                QuickBooks has renumbered {state.renumbered} invoice
                {state.renumbered === 1 ? '' : 's'} this app posted
              </b>{' '}
              — so it is not honouring the number sent, and what you set here will not be what
              the buyer receives. Turn on <b>Custom transaction numbers</b> in QuickBooks:
              Settings → Account and settings → Sales → Sales form content.
            </span>
          ) : (
            <span>
              This number is sent to QuickBooks as the invoice number. It is only honoured if{' '}
              <b>Custom transaction numbers</b> is on over there — Settings → Account and
              settings → Sales → Sales form content. Nothing posted so far has come back
              renumbered.
            </span>
          )}
        </p>
      )}

      {problem ? (
        <p className="num-problem">
          <Icon name="AlertTriangle" size={13} />
          {problem}
        </p>
      ) : (
        <p className="num-issued">
          {state.issued > 0 ? (
            <>
              Highest already issued: <b>{formatSeriesNumber(state.series, state.issued)}</b>.
              {changed && (
                <>
                  {' '}
                  Saving makes the next one{' '}
                  <b>{formatSeriesNumber(state.series, parsed)}</b>.
                </>
              )}
            </>
          ) : (
            <>
              Nothing issued yet.
              {changed && (
                <>
                  {' '}
                  Saving makes the first one <b>{formatSeriesNumber(state.series, parsed)}</b>.
                </>
              )}
            </>
          )}
        </p>
      )}
    </div>
  )
}

/**
 * Start the paperwork over.
 *
 * ## Why it is here rather than anywhere else
 *
 * The screen that says where a series starts counting is the screen somebody is
 * on when they decide the count should start again. Filing it under Developer
 * would put the most destructive button in the app behind a door labelled for
 * something else.
 *
 * ## The preview IS the control
 *
 * Same principle the inventory reset works on: a dialog with a button gets
 * dismissed by somebody already reaching for the mouse. This one counts what
 * would go, says in one line what survives — the shelf, and QuickBooks' own
 * copies — and needs a phrase typed before the button does anything.
 *
 * The typed phrase is a courtesy, not the lock. The permission check that
 * matters is in the IPC handler, because a control that lives in a dialog is a
 * control anybody can skip by calling the channel.
 */
function HardResetCard(): JSX.Element {
  const toast = useToast()
  const [preview, setPreview] = useState<OrderResetPreview | null>(null)
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [restartNumbering, setRestartNumbering] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setPreview(await api.invoices.orderResetPreview())
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const begin = async (): Promise<void> => {
    // Re-read at the moment of asking rather than trusting what was fetched when
    // the tab opened. Somebody else may have raised twenty orders since.
    await load()
    setTyped('')
    setRestartNumbering(false)
    setOpen(true)
  }

  const apply = async (): Promise<void> => {
    if (busy || !orderResetArmed(typed)) return
    setBusy(true)
    try {
      const res = await api.invoices.orderResetApply({ restartNumbering })
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Nothing was deleted.')
        return
      }
      toast.success(`Deleted ${describeOrderReset(res.data)}.`)
      setOpen(false)
      await load()
    } finally {
      setBusy(false)
    }
  }

  if (!preview) return <></>
  const empty = orderResetIsEmpty(preview)

  return (
    <>
      <div className="num-reset">
        <div className="num-reset-main">
          <div className="num-reset-title">
            <Icon name="AlertTriangle" size={15} />
            Start the paperwork over
          </div>
          <p>
            Deletes <b>every purchase order, sales order and deal ticket</b>, with their history,
            parcels and uploaded labels. {empty ? 'There are none.' : `Right now that is ${describeOrderReset(preview)}.`}
          </p>
          <p className="num-reset-safe">
            <Icon name="ShieldCheck" size={13} />
            <span>
              Your <b>stock is not touched</b> — {preview.stockUnitsKept} unit
              {preview.stockUnitsKept === 1 ? '' : 's'} on hand, their cost layers and the
              inventory ledger all stay exactly as they are. So do products, buyers, suppliers
              and staff.
            </span>
          </p>
        </div>
        <Button variant="secondary" icon="Trash2" disabled={empty} onClick={() => void begin()}>
          Start over
        </Button>
      </div>

      {open && (
        <Modal
          title="Delete every order?"
          subtitle="This cannot be undone from inside the app"
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                icon="Trash2"
                loading={busy}
                disabled={!orderResetArmed(typed)}
                onClick={() => void apply()}
              >
                Delete {orderResetTotal(preview)} records
              </Button>
            </>
          }
        >
          <p className="fin-confirm-lead">
            <b>{describeOrderReset(preview)}</b> will be deleted, along with {preview.events} log
            entr{preview.events === 1 ? 'y' : 'ies'}, {preview.shipments} parcel
            {preview.shipments === 1 ? '' : 's'} and {preview.documents} uploaded label
            {preview.documents === 1 ? '' : 's'}.
          </p>

          {/* THE TWO THINGS THAT DO NOT COME BACK, and neither is obvious from a
              button that says Delete. Both are permanent disagreements with
              something outside this database. */}
          <p className="auth-alert">
            <b>It travels.</b> Every machine that syncs with this one will lose the same records.
            This is not local housekeeping.
          </p>
          {preview.inQuickBooks > 0 && (
            <p className="auth-alert">
              <b>QuickBooks keeps its copies.</b> {preview.inQuickBooks} of these sales orders
              have been posted to Intuit and will still be there afterwards. Our side and theirs
              will no longer agree, and nothing here can change that.
            </p>
          )}

          <Checkbox
            checked={restartNumbering}
            onChange={setRestartNumbering}
            label="Also restart the numbering"
            hint={
              restartNumbering
                ? 'Deal tickets begin again at DT-000337 and the order series fall back to the starts set above.'
                : 'Off: the next order carries on from where the count is now, so a number that has been on somebody’s paperwork does not come round twice.'
            }
          />

          <Field
            label={`Type ${ORDER_RESET_PHRASE} to confirm`}
            hint="Deliberately awkward — there is no way back from this one."
          >
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={ORDER_RESET_PHRASE}
              autoFocus
            />
          </Field>
        </Modal>
      )}
    </>
  )
}
