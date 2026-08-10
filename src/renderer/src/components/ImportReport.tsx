import { useState } from 'react'
import type { ContactImportResult } from '@shared/contacts'
import { Icon } from './Icon'

/**
 * What an import did, kept on screen until it is dismissed.
 *
 * Shared by the customer list and the vendor list, MOVED here rather than
 * copied: the two importers already return the same result shape on purpose, and
 * a second copy of this panel is how one of them quietly stops showing the
 * skipped rows after somebody fixes a bug in the other.
 *
 * A persistent card rather than a toast, which is the whole point of it: an
 * import of a few hundred rows has something to say about dozens of them, and a
 * line of text that vanishes after four seconds is not a report anybody can act
 * on.
 *
 * Three lists, and they are three different things:
 *
 *   SKIPPED   a row that produced no record. A report footer, a repeated name,
 *             a blank line — each one is spelled out rather than counted,
 *             because the reason is what tells the operator whether it matters.
 *   NOTES     a record WAS imported, but something in the row could not be filed
 *             — an address written on one line, a state nobody recognised, a
 *             ZIP a spreadsheet mangled. Nothing was lost: the text is on the
 *             record and prints. Naming the rows is what lets somebody tidy them.
 *   UNCHANGED not a failure. Re-importing the same file writes nothing, and the
 *             count is how the operator can tell that is what happened.
 */
export function ImportReport({
  result,
  onDismiss
}: {
  result: ContactImportResult
  onDismiss: () => void
}): JSX.Element {
  const [open, setOpen] = useState<'skipped' | 'notes' | null>(null)
  const toggle = (which: 'skipped' | 'notes'): void => setOpen((v) => (v === which ? null : which))

  return (
    <div className="panel-card ci-report">
      <div className="ci-report-head">
        <div>
          <h3>Imported {result.source}</h3>
          <p>
            {result.rowsSeen} {result.rowsSeen === 1 ? 'row' : 'rows'} read.
          </p>
        </div>
        <button className="icon-btn" title="Dismiss" onClick={onDismiss}>
          <Icon name="X" size={16} />
        </button>
      </div>

      <div className="ci-counts">
        <div className="ci-count">
          <b>{result.added}</b>
          <span>added</span>
        </div>
        <div className="ci-count">
          <b>{result.updated}</b>
          <span>updated</span>
        </div>
        <div className="ci-count">
          <b>{result.unchanged}</b>
          <span>already up to date</span>
        </div>
        <button
          type="button"
          className={`ci-count ci-count-btn ${result.skipped.length ? 'warn' : ''}`}
          disabled={result.skipped.length === 0}
          onClick={() => toggle('skipped')}
        >
          <b>{result.skipped.length}</b>
          <span>skipped</span>
        </button>
        <button
          type="button"
          className={`ci-count ci-count-btn ${result.notes.length ? 'warn' : ''}`}
          disabled={result.notes.length === 0}
          onClick={() => toggle('notes')}
        >
          <b>{result.notes.length}</b>
          <span>needs a look</span>
        </button>
      </div>

      {open === 'skipped' && (
        <ul className="ci-list">
          {result.skipped.map((s) => (
            <li key={`${s.row}-${s.reason}`}>
              <span className="ci-row">Row {s.row}</span>
              <span className="ci-who">{s.label || '(blank)'}</span>
              <span className="ci-why">{s.reason}</span>
            </li>
          ))}
        </ul>
      )}

      {open === 'notes' && (
        <ul className="ci-list">
          {result.notes.map((n, i) => (
            <li key={`${n.row}-${i}`}>
              <span className="ci-row">Row {n.row}</span>
              <span className="ci-who">{n.name}</span>
              <span className="ci-why">{n.note}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
