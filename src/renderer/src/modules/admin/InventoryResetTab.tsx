import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ParsedSheet,
  ResetField,
  ResetOptions,
  ResetPlan,
  ResetRowPlan,
  ResetRunSummary
} from '@shared/inventoryReset'
import {
  DEFAULT_RESET_OPTIONS,
  RESET_FIELDS,
  applicableRows,
  cellAt,
  hasWork
} from '@shared/inventoryReset'
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
 * The screen is deliberately a REVIEW screen rather than an upload button. A
 * bulk write to stock and cost is the most destructive thing this app can do, so
 * nothing here is one click away from the database: the plan is computed and
 * shown first, every row says what it would go from and to, and the confirm
 * dialog repeats the headline numbers. The renderer keeps the pasted text and
 * re-asks main for the plan whenever anything changes — main holds no draft, so
 * closing this tab abandons the whole thing cleanly.
 */

type Busy = 'preview' | 'file' | 'apply' | 'export' | null

const PREVIEW_ROWS = 6

export function InventoryResetTab(): JSX.Element {
  const toast = useToast()
  const [text, setText] = useState('')
  const [source, setSource] = useState('Pasted sheet')
  const [mapping, setMapping] = useState<ResetField[] | null>(null)
  const [options, setOptions] = useState<ResetOptions>(DEFAULT_RESET_OPTIONS)
  const [defaultLocation, setDefaultLocation] = useState<string>(LOCATIONS[0].id)
  const [sheet, setSheet] = useState<ParsedSheet | null>(null)
  const [plan, setPlan] = useState<ResetPlan | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [denied, setDenied] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [runs, setRuns] = useState<ResetRunSummary[]>([])
  const [openRun, setOpenRun] = useState<{ run: ResetRunSummary; lines: string[] } | null>(null)
  const [showAll, setShowAll] = useState(false)

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
        .resetPreview({ text, mapping, options, defaultLocation })
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
  }, [text, mapping, options, defaultLocation])

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
      const res = await api.inventory.resetApply({ text, mapping, options, defaultLocation, source })
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Nothing was applied.')
        return
      }
      const run = res.data.run
      toast.success(
        `${run.rowsApplied} ${run.rowsApplied === 1 ? 'product' : 'products'} updated` +
          (run.productsCreated ? `, ${run.productsCreated} created` : '') +
          (run.shelvesZeroed ? `, ${run.shelvesZeroed} zeroed` : '') +
          '.'
      )
      await loadRuns()
      // Re-plan against the new state: everything just applied now reads as
      // "same", which is the operator's confirmation that it landed.
      requestRef.current++
      const fresh = await api.inventory.resetPreview({ text, mapping, options, defaultLocation })
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
            Paste a count sheet to set quantities, cost and market value for many products at once —
            a weekly, monthly or quarterly reset instead of editing products one by one. Nothing is
            written until you review the plan and apply it.
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
            <div className="inv-reset-options-grid">
              <Checkbox
                checked={options.applyQuantity}
                onChange={(v) => setOptions({ ...options, applyQuantity: v })}
                label="Update quantities"
                hint="Set each counted product to the sheet's quantity."
              />
              <Checkbox
                checked={options.applyCost}
                onChange={(v) => setOptions({ ...options, applyCost: v })}
                label="Update cost"
                hint="Re-value the stock on hand at the counted unit cost."
              />
              <Checkbox
                checked={options.applyMarket}
                onChange={(v) => setOptions({ ...options, applyMarket: v })}
                label="Update market value"
                hint="Write the counted value onto each product's high bid."
              />
              <Checkbox
                checked={options.applyDetails}
                onChange={(v) => setOptions({ ...options, applyDetails: v })}
                label="Update SKU, UPC and category"
                hint="Only where the sheet states one. Blank cells never clear a field."
              />
              <Checkbox
                checked={options.createMissing}
                onChange={(v) => setOptions({ ...options, createMissing: v })}
                label="Create products the catalog does not have"
                hint="Adds each unmatched row as a new product with its counted stock."
              />
              <Checkbox
                checked={options.zeroMissing}
                onChange={(v) => setOptions({ ...options, zeroMissing: v })}
                label="This is a complete count — zero everything else"
                hint={
                  plan.missing.length > 0
                    ? `${plan.missing.length} ${plan.missing.length === 1 ? 'product' : 'products'} would be written down to zero.`
                    : 'Nothing else is holding stock.'
                }
              />
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

          <PlanTotals plan={plan} />

          <div className="inv-reset-counts">
            <Tally label="Changing" value={changing.length} tone="accent" />
            <Tally label="Already correct" value={plan.counts.same} tone="muted" />
            {options.createMissing && plan.counts.created > 0 && (
              <Tally label="New products" value={plan.counts.created} tone="accent" />
            )}
            <Tally label="Not matched" value={plan.counts.unmatched} tone="warn" />
            <Tally label="Ambiguous" value={plan.counts.ambiguous} tone="warn" />
            <Tally label="Rejected" value={plan.counts.invalid} tone="bad" />
            {options.zeroMissing && (
              <Tally label="Zeroed" value={plan.missing.length} tone="bad" />
            )}
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

          {problemRows.length > 0 && (
            <details className="inv-reset-section" open>
              <summary>
                <Icon name="CircleHelp" size={15} />
                {problemRows.length} {problemRows.length === 1 ? 'row' : 'rows'} will be skipped
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
              <ChangeTable rows={showAll ? changing : changing.slice(0, 25)} options={options} />
            </div>
          )}

          {options.zeroMissing && plan.missing.length > 0 && (
            <details className="inv-reset-section">
              <summary>
                <Icon name="Trash2" size={15} />
                {plan.missing.length} {plan.missing.length === 1 ? 'product' : 'products'} would be
                zeroed — {formatMoney(plan.missing.reduce((n, m) => n + m.quantity * m.unitCost, 0))}{' '}
                of stock written off
              </summary>
              <table className="inv-reset-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Where</th>
                    <th className="num">On hand</th>
                    <th className="num">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.missing.map((m) => (
                    <tr key={`${m.productId}${m.location}`}>
                      <td>{m.productName}</td>
                      <td>{m.location}</td>
                      <td className="num">{m.quantity}</td>
                      <td className="num">{formatMoney(m.quantity * m.unitCost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}

          <div className="inv-reset-apply">
            <Button onClick={() => setConfirming(true)} disabled={!ready || busy === 'apply'}>
              <Icon name="Check" size={15} />
              {busy === 'apply' ? 'Applying…' : 'Apply this count'}
            </Button>
            {!ready && plan.problems.length === 0 && (
              <span className="inv-reset-apply-note">
                {changing.length === 0 && plan.counts.total > 0
                  ? 'Everything on this sheet already matches the catalog.'
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

      {confirming && plan && (
        <Modal title="Apply this count?" onClose={() => setConfirming(false)}>
          <div className="inv-reset-confirm">
            <p>
              This writes {changing.length} {changing.length === 1 ? 'product' : 'products'} in one
              go
              {options.zeroMissing && plan.missing.length > 0
                ? ` and zeroes ${plan.missing.length} more`
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
            {plan.counts.unmatched + plan.counts.ambiguous + plan.counts.invalid > 0 && (
              <p className="inv-reset-confirm-skip">
                {plan.counts.unmatched + plan.counts.ambiguous + plan.counts.invalid} rows will be
                skipped and left exactly as they are.
              </p>
            )}
          </div>
          <div className="modal-foot">
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button onClick={apply}>Apply</Button>
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
function ChangeTable({
  rows,
  options
}: {
  rows: ResetRowPlan[]
  options: ResetOptions
}): JSX.Element {
  return (
    <table className="inv-reset-table is-changes">
      <thead>
        <tr>
          <th>Product</th>
          <th>Where</th>
          {options.applyQuantity && <th className="num">Quantity</th>}
          {options.applyCost && <th className="num">Cost</th>}
          {options.applyMarket && <th className="num">Market</th>}
          {options.applyDetails && <th>Details</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.line}-${r.productId ?? 'new'}`}>
            <td>
              <strong>{r.productName || r.sheetName}</strong>
              {r.status === 'new' && <em className="inv-reset-new">new product</em>}
            </td>
            <td>{r.location}</td>
            {options.applyQuantity && (
              <td className="num">
                <Delta before={r.quantityBefore} after={r.quantityAfter} />
              </td>
            )}
            {options.applyCost && (
              <td className="num">
                <Delta before={r.costBefore} after={r.costAfter} money />
              </td>
            )}
            {options.applyMarket && (
              <td className="num">
                <Delta before={r.marketBefore} after={r.marketAfter} money />
              </td>
            )}
            {options.applyDetails && (
              <td className="inv-reset-details">
                {r.detailChanges.length === 0
                  ? '—'
                  : r.detailChanges.map((d) => (
                      <span key={d.field}>
                        {d.field}: {d.from || '—'} → {d.to}
                      </span>
                    ))}
              </td>
            )}
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
