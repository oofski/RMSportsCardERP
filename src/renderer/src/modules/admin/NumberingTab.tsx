import { useCallback, useEffect, useState } from 'react'
import type { SeriesState } from '@shared/numbering'
import {
  formatSeriesNumber,
  seriesHint,
  seriesLabel,
  validateSeriesStart
} from '@shared/numbering'
import { api } from '../../lib/api'
import { Button, CenterLoader, EmptyState, Input } from '../../components/ui'
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
