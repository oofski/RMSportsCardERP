import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ParsedSheet,
  ResetField,
  ResetMissingRow,
  ResetPlan,
  ResetRowPlan,
  ResetRunSummary
} from '@shared/inventoryReset'
import { RESET_FIELDS, applicableRows, cellAt, hasWork } from '@shared/inventoryReset'
import { LOCATIONS } from '@shared/inventory'
import { api } from '../../lib/api'
import { Button, Checkbox, Modal, Select } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { formatDateTime, formatMoney } from '../../lib/format'

/**
 * Mass inventory re-adjustment.
 *
 * A periodic count arrives as a spreadsheet. Paste it (or pick the file), check
 * that the columns were read the way they were meant, look at what would change,
 * then apply the lot in one go.
 *
 * THE SHEET IS THE WHOLE WAREHOUSE — there are no behaviour toggles left. After
 * an adjust, on-hand equals the sheet, and every product the sheet does not name
 * holds nothing. That makes this the only screen in the app that can write off
 * the entire inventory from one bad paste, so the preview is not a courtesy: it
 * is the control. It leads with how much is about to be zeroed rather than
 * filing that at the bottom, and when a run is out of proportion to what was
 * pasted — five rows against three hundred products holding real money — the
 * confirm dialog stops being a formality and asks for an explicit acknowledgement
 * of the number. An ordinary run is still two clicks.
 *
 * The renderer keeps the pasted text and re-asks main for the plan whenever
 * anything changes — main holds no draft, so closing this tab abandons the whole
 * thing cleanly.
 */

type Busy = 'preview' | 'file' | 'apply' | 'export' | null

const PREVIEW_ROWS = 6

/** What the sheet is about to write off, in the money the dashboard will lose. */
interface WipeScale {
  products: number
  shelves: number
  units: number
  costValue: number
  marketValue: number
  /**
   * True when the run destroys more than it states.
   *
   * Two ways that happens: the sheet names fewer products than it wipes (a
   * partial paste treated as a whole warehouse), or the write-off is a large
   * share of the money on hand. Either is a paste to look at twice; neither is
   * true of a genuine full recount, which names everything it keeps.
   */
  alarming: boolean
}

function wipeScale(missing: ResetMissingRow[], countedProducts: number, costOnHand: number): WipeScale {
  const products = new Set(missing.map((m) => m.productId)).size
  let units = 0
  let costValue = 0
  let marketValue = 0
  for (const m of missing) {
    units += m.quantity
    costValue += m.quantity * m.unitCost
    marketValue += m.quantity * m.unitMarket
  }
  return {
    products,
    shelves: missing.length,
    units: Math.round(units * 1e4) / 1e4,
    costValue,
    marketValue,
    alarming:
      products > 0 && (products > countedProducts || (costOnHand > 0 && costValue > costOnHand * 0.25))
  }
}

export function InventoryResetTab(): JSX.Element {
  const toast = useToast()
  const [text, setText] = useState('')
  const [source, setSource] = useState('Pasted sheet')
  const [mapping, setMapping] = useState<ResetField[] | null>(null)
  const [defaultLocation, setDefaultLocation] = useState<string>(LOCATIONS[0].id)
  const [sheet, setSheet] = useState<ParsedSheet | null>(null)
  const [plan, setPlan] = useState<ResetPlan | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [denied, setDenied] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [runs, setRuns] = useState<ResetRunSummary[]>([])
  const [openRun, setOpenRun] = useState<{ run: ResetRunSummary; lines: string[] } | null>(null)
  const [showAll, setShowAll] = useState(false)
  /** Ticked in the confirm dialog, and only ever asked for on an alarming run. */
  const [acknowledged, setAcknowledged] = useState(false)

  // Guards against an out-of-order preview: typing fires several in flight and
  // the LAST request must win, not the last to return.
  const requestRef = useRef(0)

  const loadRuns = useCallback(async () => {
    setRuns(await api.inventory.resetHistory(8))
  }, [])

  useEffect(() => {
    loadRuns().catch(() => setRuns([]))
  }, [loadRuns])

  // Re-plan whenever the sheet, the mapping or the options move. Debounced so a
  // paste of two thousand rows is not re-planned on every keystroke.
  useEffect(() => {
    if (!text.trim()) {
      setSheet(null)
      setPlan(null)
      return
    }
    const ticket = ++requestRef.current
    const timer = setTimeout(() => {
      setBusy((b) => (b === 'apply' ? b : 'preview'))
      api.inventory
        .resetPreview({ text, mapping, defaultLocation })
        .then((result) => {
          if (ticket !== requestRef.current) return
          if (!result) {
            setDenied(true)
            setPlan(null)
            return
          }
          setSheet(result.sheet)
          setPlan(result.plan)
          // Adopt the guess ONCE, so the operator's own choices survive the next
          // re-plan. Without this every keystroke would undo their last edit.
          if (result.guessed) setMapping(result.plan.mapping)
        })
        .catch(() => {
          if (ticket === requestRef.current) setPlan(null)
        })
        .finally(() => {
          if (ticket === requestRef.current) setBusy((b) => (b === 'preview' ? null : b))
        })
    }, 250)
    return () => clearTimeout(timer)
  }, [text, mapping, defaultLocation])

  const pickFile = async (): Promise<void> => {
    setBusy('file')
    try {
      const res = await api.inventory.resetPickFile()
      if (!res.ok || !res.data) {
        if (res.error && res.error !== 'No file selected.') toast.error(res.error)
        return
      }
      // A new file is a new sheet: drop the mapping so it is guessed afresh.
      setMapping(null)
      setText(res.data.text)
      setSource(res.data.filename)
    } finally {
      setBusy(null)
    }
  }

  const exportCurrent = async (): Promise<void> => {
    setBusy('export')
    try {
      const res = await api.inventory.resetExport()
      if (res.ok) toast.success('Current count exported.')
      else if (res.error !== 'Export cancelled.') toast.error(res.error ?? 'Export failed.')
    } finally {
      setBusy(null)
    }
  }

  const apply = async (): Promise<void> => {
    if (!plan || !mapping) return
    setBusy('apply')
    setConfirming(false)
    try {
      const res = await api.inventory.resetApply({ text, mapping, defaultLocation, source })
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Nothing was applied.')
        return
      }
      const run = res.data.run
      toast.success(
        `${run.rowsApplied} ${run.rowsApplied === 1 ? 'product' : 'products'} updated` +
          (run.shelvesZeroed ? `, ${run.shelvesZeroed} zeroed` : '') +
          '.'
      )
      await loadRuns()
      // Re-plan against the new state: everything just applied now reads as
      // "same" and nothing is left to zero, which is the operator's confirmation
      // that the sheet and the warehouse now say the same thing.
      requestRef.current++
      const fresh = await api.inventory.resetPreview({ text, mapping, defaultLocation })
      if (fresh) setPlan(fresh.plan)
    } finally {
      setBusy(null)
    }
  }

  const clear = (): void => {
    setText('')
    setMapping(null)
    setSheet(null)
    setPlan(null)
    setSource('Pasted sheet')
  }

  const openRunDetail = async (run: ResetRunSummary): Promise<void> => {
    const lines = await api.inventory.resetRunDetail(run.id)
    setOpenRun({ run, lines })
  }

  const changing = useMemo(() => (plan ? applicableRows(plan) : []), [plan])
  const problemRows = useMemo(
    () =>
      plan
        ? plan.rows.filter(
            (r) => r.status === 'unmatched' || r.status === 'ambiguous' || r.status === 'invalid'
          )
        : [],
    [plan]
  )
  const warned = useMemo(() => (plan ? plan.rows.filter((r) => r.warnings.length > 0) : []), [plan])
  const wipe = useMemo(
    () =>
      plan
        ? wipeScale(
            plan.missing,
            // Products the sheet actually speaks for, whether or not they move.
            new Set(
              plan.rows.filter((r) => r.productId && r.status !== 'invalid').map((r) => r.productId)
            ).size,
            plan.totals.costBefore
          )
        : null,
    [plan]
  )
  const ready = !!plan && hasWork(plan) && !!mapping

  if (denied) {
    return (
      <div className="qbo-denied">
        <Icon name="ShieldCheck" size={22} />
        <span>You need the “Manage inventory” permission to run a bulk re-adjustment.</span>
      </div>
    )
  }

  return (
    <div className="inv-reset">
      <div className="inv-reset-head">
        <div>
          <h3>Bulk inventory re-adjustment</h3>
          <p>
            Paste a count sheet and it becomes the inventory: every product on it is set to the
            quantity, cost and market value it states, and every product it leaves out goes to
            zero. Export the current count first if you want to start from what is on the shelves.
            Nothing is written until you review the plan and apply it.
          </p>
        </div>
        <div className="inv-reset-head-actions">
          <Button variant="ghost" onClick={exportCurrent} disabled={busy === 'export'}>
            <Icon name="Download" size={15} />
            Export current count
          </Button>
          <Button variant="secondary" onClick={pickFile} disabled={busy === 'file'}>
            <Icon name="FileUp" size={15} />
            Choose a file
          </Button>
        </div>
      </div>

      <div className="inv-reset-paste">
        <label htmlFor="inv-reset-text">
          Count sheet
          <em>
            Copy the rows straight out of Excel or Google Sheets and paste them here. A header row
            is optional — the columns are worked out either way.
          </em>
        </label>
        <textarea
          id="inv-reset-text"
          className="inv-reset-textarea"
          value={text}
          spellCheck={false}
          placeholder={
            'Product\tSKU\tCategory\tUPC\tLocation\tQty\tMarket\tCost\n' +
            '2026 Topps Chrome Baseball Hobby 12-Box Case\t6625\tBaseball\t887521159468\tRM\t6\t$4,680.00\t$4,180.50'
          }
          onChange={(e) => {
            const next = e.target.value
            // A brand-new sheet gets a brand-new guess; an edit to the same one
            // keeps whatever mapping the operator has set.
            if (!text.trim() && next.trim()) setMapping(null)
            setText(next)
            if (source !== 'Pasted sheet' && next !== text) setSource('Pasted sheet')
          }}
        />
        {text.trim().length > 0 && (
          <div className="inv-reset-paste-foot">
            <span>
              {sheet ? `${sheet.rows.length} rows · ${sheet.columns} columns` : 'Reading…'}
              {sheet?.header ? ' · header detected' : ''}
            </span>
            <button type="button" className="link-btn" onClick={clear}>
              Clear
            </button>
          </div>
        )}
      </div>

      {sheet && mapping && (
        <ColumnMapper
          sheet={sheet}
          mapping={mapping}
          onChange={(index, field) => {
            const next = [...mapping]
            // A unique role can only live in one column: assigning it here takes
            // it away from wherever it was, rather than silently making the plan
            // invalid.
            const def = RESET_FIELDS.find((f) => f.id === field)
            if (def?.unique) {
              for (let i = 0; i < next.length; i++) if (next[i] === field) next[i] = 'ignore'
            }
            next[index] = field
            setMapping(next)
          }}
        />
      )}

      {plan && (
        <>
          <div className="inv-reset-options">
            <div className="inv-reset-rule">
              <Icon name="Info" size={16} />
              <p>
                This sheet becomes the whole warehouse. Every row is written exactly as counted, and{' '}
                <strong>every product it does not mention goes to zero at both locations</strong> —
                stock, cost layers and all. It never edits SKUs, UPCs or categories, and it never
                adds a product the catalog does not already have.
              </p>
            </div>
            <div className="inv-reset-default-loc">
              <span>Rows with no location count at</span>
              <Select
                value={defaultLocation}
                onChange={(e) => setDefaultLocation(e.target.value)}
                aria-label="Default location"
              >
                {LOCATIONS.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {plan.problems.length > 0 && (
            <div className="inv-reset-block">
              <Icon name="TriangleAlert" size={16} />
              <ul>
                {plan.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Above the totals, not below the fold. The write-off is the half of
              this operation that cannot be undone, so it is the first thing the
              plan says. */}
          {wipe && wipe.products > 0 && <WipePanel wipe={wipe} missing={plan.missing} />}

          <PlanTotals plan={plan} />

          <div className="inv-reset-counts">
            <Tally label="Changing" value={changing.length} tone="accent" />
            <Tally label="Already correct" value={plan.counts.same} tone="muted" />
            <Tally label="Not matched" value={plan.counts.unmatched} tone="warn" />
            <Tally label="Ambiguous" value={plan.counts.ambiguous} tone="warn" />
            <Tally label="Rejected" value={plan.counts.invalid} tone="bad" />
            <Tally label="Zeroed" value={wipe?.products ?? 0} tone="bad" />
          </div>

          {warned.length > 0 && (
            <details className="inv-reset-section" open={warned.length <= 4}>
              <summary>
                <Icon name="TriangleAlert" size={15} />
                {warned.length} {warned.length === 1 ? 'row needs' : 'rows need'} a second look
              </summary>
              <ul className="inv-reset-warnlist">
                {warned.map((r) => (
                  <li key={`w${r.line}`}>
                    <strong>{r.productName || r.sheetName || `Row ${r.line}`}</strong>
                    {r.warnings.map((w, i) => (
                      <span key={i}>{w}</span>
                    ))}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {/* Never a "skipped" list any more. A row that could not be read stops
              the run, because the alternative is writing off the stock it was
              counting. Open by default and stated as the blocker it is. */}
          {problemRows.length > 0 && (
            <details className="inv-reset-section" open>
              <summary>
                <Icon name="CircleHelp" size={15} />
                {problemRows.length} {problemRows.length === 1 ? 'row is' : 'rows are'} holding this
                count up
              </summary>
              <table className="inv-reset-table">
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>From the sheet</th>
                    <th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {problemRows.map((r) => (
                    <tr key={`p${r.line}`}>
                      <td className="num">{r.line}</td>
                      <td>
                        <strong>{r.sheetName || '—'}</strong>
                        {r.sheetSku && <em>{r.sheetSku}</em>}
                      </td>
                      <td>
                        {r.message}
                        {r.suggestion && (
                          <span className="inv-reset-hint">Closest match: {r.suggestion}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}

          {changing.length > 0 && (
            <div className="inv-reset-section is-open">
              <div className="inv-reset-section-head">
                <h4>
                  {changing.length} {changing.length === 1 ? 'product' : 'products'} would change
                </h4>
                {changing.length > 25 && (
                  <button type="button" className="link-btn" onClick={() => setShowAll(!showAll)}>
                    {showAll ? 'Show first 25' : `Show all ${changing.length}`}
                  </button>
                )}
              </div>
              <ChangeTable rows={showAll ? changing : changing.slice(0, 25)} />
            </div>
          )}

          <div className="inv-reset-apply">
            <Button
              onClick={() => {
                setAcknowledged(false)
                setConfirming(true)
              }}
              disabled={!ready || busy === 'apply'}
            >
              <Icon name="Check" size={15} />
              {busy === 'apply' ? 'Applying…' : 'Apply this count'}
            </Button>
            {!ready && plan.problems.length === 0 && (
              <span className="inv-reset-apply-note">
                {changing.length === 0 && plan.counts.total > 0
                  ? 'The warehouse already reads exactly like this sheet.'
                  : 'Nothing to apply yet.'}
              </span>
            )}
          </div>
        </>
      )}

      {runs.length > 0 && (
        <div className="inv-reset-history">
          <h4>Previous resets</h4>
          <table className="inv-reset-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Sheet</th>
                <th>By</th>
                <th className="num">Applied</th>
                <th className="num">Skipped</th>
                <th className="num">Units</th>
                <th className="num">Cost value</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{formatDateTime(r.createdAt)}</td>
                  <td>{r.source}</td>
                  <td>{r.actorName ?? '—'}</td>
                  <td className="num">{r.rowsApplied}</td>
                  <td className="num">{r.rowsSkipped}</td>
                  <td className="num">
                    {r.unitsBefore} → {r.unitsAfter}
                  </td>
                  <td className="num">
                    {formatMoney(r.costBefore)} → {formatMoney(r.costAfter)}
                  </td>
                  <td>
                    <button type="button" className="link-btn" onClick={() => openRunDetail(r)}>
                      Detail
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirming && plan && wipe && (
        <Modal title="Apply this count?" onClose={() => setConfirming(false)}>
          <div className="inv-reset-confirm">
            <p>
              This writes {changing.length} {changing.length === 1 ? 'product' : 'products'} in one
              go
              {wipe.products > 0
                ? ` and empties ${wipe.products} more that this sheet does not mention`
                : ''}
              . Every movement is recorded in Inventory activity, so it can be traced afterwards —
              but there is no single undo.
            </p>
            <dl className="inv-reset-confirm-figures">
              <div>
                <dt>Units on hand</dt>
                <dd>
                  {plan.totals.unitsBefore} → <strong>{plan.totals.unitsAfter}</strong>
                </dd>
              </div>
              <div>
                <dt>Cost value</dt>
                <dd>
                  {formatMoney(plan.totals.costBefore)} →{' '}
                  <strong>{formatMoney(plan.totals.costAfter)}</strong>
                </dd>
              </div>
              <div>
                <dt>Market value</dt>
                <dd>
                  {formatMoney(plan.totals.marketBefore)} →{' '}
                  <strong>{formatMoney(plan.totals.marketAfter)}</strong>
                </dd>
              </div>
            </dl>
            {wipe.products > 0 && (
              <p className="inv-reset-confirm-wipe">
                <Icon name="Trash2" size={15} />
                <span>
                  <strong>
                    {wipe.products} {wipe.products === 1 ? 'product' : 'products'} written down to
                    zero
                  </strong>{' '}
                  — {wipe.units} on hand, {formatMoney(wipe.marketValue)} of market value. Their
                  cost layers are retired with them.
                </span>
              </p>
            )}
            {/* Only on a run that destroys more than it states. A full recount
                names everything it keeps, so it never sees this. */}
            {wipe.alarming && (
              <div className="inv-reset-confirm-ack">
                <Checkbox
                  checked={acknowledged}
                  onChange={setAcknowledged}
                  label={`Yes — zero ${wipe.products} products and write off ${formatMoney(wipe.marketValue)}`}
                  hint={`This sheet names ${plan.counts.total} ${
                    plan.counts.total === 1 ? 'row' : 'rows'
                  }. Everything else in the catalog is emptied.`}
                />
              </div>
            )}
          </div>
          <div className="modal-foot">
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button onClick={apply} disabled={wipe.alarming && !acknowledged}>
              Apply
            </Button>
          </div>
        </Modal>
      )}

      {openRun && (
        <Modal title={`Reset — ${formatDateTime(openRun.run.createdAt)}`} onClose={() => setOpenRun(null)}>
          <div className="inv-reset-rundetail">
            <p>
              {openRun.run.source} · {openRun.run.rowsApplied} applied · {openRun.run.rowsSkipped}{' '}
              skipped
              {openRun.run.productsCreated ? ` · ${openRun.run.productsCreated} created` : ''}
              {openRun.run.shelvesZeroed ? ` · ${openRun.run.shelvesZeroed} zeroed` : ''}
            </p>
            {openRun.lines.length === 0 ? (
              <p className="inv-reset-hint">Nothing was recorded for this run.</p>
            ) : (
              <ul>
                {openRun.lines.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="modal-foot">
            <Button variant="ghost" onClick={() => setOpenRun(null)}>
              Close
            </Button>
          </div>
        </Modal>
      )}
    </div>
  )
}

/**
 * The column strip: what each column of the sheet was read as, over the first
 * few rows of real data so a wrong answer is obvious at a glance rather than
 * after the write.
 */
function ColumnMapper({
  sheet,
  mapping,
  onChange
}: {
  sheet: ParsedSheet
  mapping: ResetField[]
  onChange: (index: number, field: ResetField) => void
}): JSX.Element {
  const columns = Array.from({ length: sheet.columns }, (_, i) => i)
  const sample = sheet.rows.slice(0, PREVIEW_ROWS)
  // A pasted block of cells brings its spacer columns with it — four empty ones
  // between the data and the summary block, in the sheet this was built for.
  // Given a full-width dropdown each, they push the money columns off screen,
  // and the money columns are the ones most worth checking. An empty column has
  // nothing to map, so it collapses to a sliver instead. Emptiness is measured
  // over EVERY row, not just the sample shown.
  const empty = columns.map(
    (i) => !sheet.rows.some((row) => cellAt(row, i) !== '') && cellAt(sheet.header ?? [], i) === ''
  )
  const emptyCount = empty.filter(Boolean).length
  const cls = (i: number): string =>
    empty[i] ? 'is-empty' : mapping[i] === 'ignore' ? 'is-ignored' : ''
  return (
    <div className="inv-reset-map">
      <div className="inv-reset-map-head">
        <h4>Columns</h4>
        <span>Change any that were read wrong.</span>
      </div>
      {/* A wide sheet does not fit, so the grid below scrolls sideways — which
          would put the money columns, the ones most worth checking, out of
          sight. This line states what was read in words, so the mapping can be
          verified without scrolling anything. */}
      <div className="inv-reset-map-summary">
        {RESET_FIELDS.filter((f) => f.id !== 'ignore').map((f) => {
          const index = mapping.indexOf(f.id)
          const sampleValue =
            index >= 0 ? sheet.rows.map((r) => cellAt(r, index)).find((v) => v !== '') : undefined
          return (
            <span
              key={f.id}
              className={`inv-reset-map-chip${index < 0 ? ' is-off' : ''}`}
              title={index >= 0 ? `Column ${index + 1}` : 'Not in this sheet'}
            >
              <b>{f.label}</b>
              {index >= 0 ? <i>{sampleValue || '(blank)'}</i> : <i>not set</i>}
            </span>
          )
        })}
      </div>
      <div className="inv-reset-map-scroll">
        <table className="inv-reset-maptable">
          <thead>
            <tr>
              {columns.map((i) => (
                <th key={i} className={cls(i)}>
                  {empty[i] ? (
                    <span className="inv-reset-map-empty" title="This column is empty">
                      —
                    </span>
                  ) : (
                    <>
                      <Select
                        value={mapping[i] ?? 'ignore'}
                        onChange={(e) => onChange(i, e.target.value as ResetField)}
                        aria-label={`Column ${i + 1}`}
                      >
                        {RESET_FIELDS.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.label}
                          </option>
                        ))}
                      </Select>
                      {sheet.header && <em>{cellAt(sheet.header, i) || `Column ${i + 1}`}</em>}
                    </>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sample.map((row, r) => (
              <tr key={r}>
                {columns.map((i) => (
                  <td key={i} className={cls(i)}>
                    {cellAt(row, i)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="inv-reset-map-foot">
        {sheet.rows.length > sample.length
          ? `Showing ${sample.length} of ${sheet.rows.length} rows.`
          : `${sheet.rows.length} ${sheet.rows.length === 1 ? 'row' : 'rows'}.`}
        {emptyCount > 0 &&
          ` ${emptyCount} empty ${emptyCount === 1 ? 'column' : 'columns'} collapsed.`}
      </div>
    </div>
  )
}

/**
 * What this sheet is about to destroy, stated before anything else.
 *
 * The list is always here and always complete — an unmatched row can no longer
 * be quietly dropped, and a shelf that is about to be emptied can no longer hide
 * behind a collapsed summary at the bottom of the page. It opens itself when the
 * run is out of proportion to the paste, because that is exactly the case where
 * the operator needs to read the names rather than the count.
 */
function WipePanel({ wipe, missing }: { wipe: WipeScale; missing: ResetMissingRow[] }): JSX.Element {
  return (
    <div className={`inv-reset-wipe${wipe.alarming ? ' is-alarming' : ''}`}>
      <div className="inv-reset-wipe-head">
        <Icon name={wipe.alarming ? 'TriangleAlert' : 'Trash2'} size={18} />
        <div>
          <strong>
            {wipe.products} {wipe.products === 1 ? 'product' : 'products'} will be written down to
            zero
          </strong>
          <span>
            {wipe.units} on hand across {wipe.shelves}{' '}
            {wipe.shelves === 1 ? 'location' : 'locations'} · {formatMoney(wipe.costValue)} at cost ·{' '}
            {formatMoney(wipe.marketValue)} at market
          </span>
        </div>
      </div>
      {wipe.alarming && (
        <p className="inv-reset-wipe-alarm">
          This sheet accounts for less of the warehouse than it clears. Check that the paste is the
          whole count and not a section of it — everything below is emptied.
        </p>
      )}
      <details className="inv-reset-wipe-list" open={wipe.alarming}>
        <summary>Show the {wipe.shelves} that will be emptied</summary>
        <table className="inv-reset-table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Where</th>
              <th className="num">On hand</th>
              <th className="num">Cost value</th>
              <th className="num">Market value</th>
            </tr>
          </thead>
          <tbody>
            {missing.map((m) => (
              <tr key={`${m.productId}${m.location}`}>
                <td>{m.productName}</td>
                <td>{m.location}</td>
                <td className="num">{m.quantity}</td>
                <td className="num">{formatMoney(m.quantity * m.unitCost)}</td>
                <td className="num">{formatMoney(m.quantity * m.unitMarket)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  )
}

/** The three numbers that say whether the whole count is sane, before and after. */
function PlanTotals({ plan }: { plan: ResetPlan }): JSX.Element {
  const t = plan.totals
  return (
    <div className="inv-reset-totals">
      <Total label="Units on hand" before={String(t.unitsBefore)} after={String(t.unitsAfter)} delta={t.unitsAfter - t.unitsBefore} />
      <Total
        label="Cost value"
        before={formatMoney(t.costBefore)}
        after={formatMoney(t.costAfter)}
        delta={t.costAfter - t.costBefore}
        money
      />
      <Total
        label="Market value"
        before={formatMoney(t.marketBefore)}
        after={formatMoney(t.marketAfter)}
        delta={t.marketAfter - t.marketBefore}
        money
      />
    </div>
  )
}

function Total({
  label,
  before,
  after,
  delta,
  money
}: {
  label: string
  before: string
  after: string
  delta: number
  money?: boolean
}): JSX.Element {
  const tone = Math.abs(delta) < 0.005 ? 'flat' : delta > 0 ? 'up' : 'down'
  return (
    <div className={`inv-reset-total is-${tone}`}>
      <span className="inv-reset-total-label">{label}</span>
      <span className="inv-reset-total-figure">{after}</span>
      <span className="inv-reset-total-from">
        from {before}
        {tone !== 'flat' && (
          <em>
            {delta > 0 ? '+' : '−'}
            {money
              ? formatMoney(Math.abs(delta))
              : Math.round(Math.abs(delta) * 10000) / 10000}
          </em>
        )}
      </span>
    </div>
  )
}

function Tally({
  label,
  value,
  tone
}: {
  label: string
  value: number
  tone: 'accent' | 'muted' | 'warn' | 'bad'
}): JSX.Element {
  return (
    <div className={`inv-reset-tally is-${tone}${value === 0 ? ' is-zero' : ''}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  )
}

/** One line per changing product: what it is now, and what it becomes. */
function ChangeTable({ rows }: { rows: ResetRowPlan[] }): JSX.Element {
  return (
    <table className="inv-reset-table is-changes">
      <thead>
        <tr>
          <th>Product</th>
          <th>Where</th>
          <th className="num">Quantity</th>
          <th className="num">Cost</th>
          <th className="num">Market</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.line}-${r.productId ?? r.line}`}>
            <td>
              <strong>{r.productName || r.sheetName}</strong>
            </td>
            <td>{r.location}</td>
            <td className="num">
              <Delta before={r.quantityBefore} after={r.quantityAfter} />
            </td>
            <td className="num">
              <Delta before={r.costBefore} after={r.costAfter} money />
            </td>
            <td className="num">
              <Delta before={r.marketBefore} after={r.marketAfter} money />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** before → after, dimmed to a single value when it is not moving. */
function Delta({
  before,
  after,
  money
}: {
  before: number | null
  after: number | null
  money?: boolean
}): JSX.Element {
  const show = (v: number | null): string => (v == null ? '—' : money ? formatMoney(v) : String(v))
  const changed = (before ?? null) !== (after ?? null)
  if (!changed) return <span className="inv-reset-delta is-flat">{show(after)}</span>
  const up = (after ?? 0) > (before ?? 0)
  return (
    <span className={`inv-reset-delta ${up ? 'is-up' : 'is-down'}`}>
      <s>{show(before)}</s>
      <b>{show(after)}</b>
    </span>
  )
}
