import { useState } from 'react'
import type { LedgerImport, StreamingFinanceView } from '@shared/financeStreaming'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { Button, Modal } from '../../components/ui'
import { Money, Note, plural } from './bits'
import { finance, resultError } from './api'
import { instantLabel, shortInstantDate } from './time'

/** Older imports fold away: the last one or two are the ones being questioned,
 *  and a year of weekly uploads would otherwise push the day table off-screen. */
const IMPORT_PREVIEW = 2

/**
 * The ledger in, and the ledger back out again.
 *
 * Every number on this screen traces back to a file somebody uploaded, so the
 * files are shown as first-class objects with their own counts: how many rows
 * came in, how many were already here, how many needed repairing and how many
 * could not be read at all. An import whose counts look wrong is the first
 * thing to check when a day looks wrong, and deleting it is the only way to
 * take a bad file back out.
 *
 * IT IS QUIET NOW, and only now. Before anything is uploaded this panel is the
 * entire screen, because uploading is the only thing there is to do; once an
 * import has landed it is provenance, and it prints as a flat run of lines under
 * the P&L rather than as a card of stat blocks competing with the profit figure
 * for the top of the page. Warnings are the exception and always were — those
 * keep their banner wherever the panel sits.
 */
export function ImportPanel({
  imports,
  canManage,
  onView
}: {
  imports: LedgerImport[]
  canManage: boolean
  onView: (view: StreamingFinanceView) => void
}): JSX.Element {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState<LedgerImport | null>(null)
  const [showAll, setShowAll] = useState(false)
  // Which import this session just added — it is called out in the list,
  // because the counts matter most in the seconds after an upload.
  const [freshId, setFreshId] = useState<string | null>(null)

  const upload = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await finance.importLedger()
      if (!res.ok || !res.data) {
        // The picker lives in main, so a cancelled dialog comes back as a plain
        // not-ok with nothing to say. That is not a failure worth shouting at.
        if (res.error?.trim()) toast.error(resultError(res, 'That ledger could not be imported.'))
        return
      }
      const { import: imported, view } = res.data
      setFreshId(imported.id)
      onView(view)
      toast.success(`${plural(imported.rowsImported, 'row')} imported from ${imported.filename}.`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'That ledger could not be imported.')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!deleting) return
    setBusy(true)
    try {
      const res = await finance.deleteImport(deleting.id)
      if (!res.ok || !res.data) {
        toast.error(resultError(res, 'That import could not be deleted.'))
        return
      }
      if (freshId === deleting.id) setFreshId(null)
      onView(res.data)
      toast.success(`${deleting.filename} removed, along with its rows.`)
      setDeleting(null)
    } finally {
      setBusy(false)
    }
  }

  const confirm = deleting && (
    <Modal
      title="Delete this import?"
      onClose={() => (busy ? undefined : setDeleting(null))}
      footer={
        <>
          <Button variant="ghost" onClick={() => setDeleting(null)} disabled={busy}>
            Keep it
          </Button>
          <Button variant="danger" icon="Trash2" loading={busy} onClick={() => void remove()}>
            Delete the import and its rows
          </Button>
        </>
      }
    >
      <p className="fin-confirm-lead">
        <b>{deleting.filename}</b> and every one of its{' '}
        {plural(deleting.rowsImported, 'ledger row')} are removed for good.
      </p>
      <p className="fin-confirm-lead">
        The stretch it covered —{' '}
        <b>
          {shortInstantDate(deleting.firstOccurredAt)} to {shortInstantDate(deleting.lastOccurredAt)}
        </b>{' '}
        — falls back to whatever the remaining imports hold, which may be nothing at all.
        Re-uploading the same file brings it all back; no session or stock record is touched.
      </p>
    </Modal>
  )

  if (imports.length === 0) {
    return (
      <section className="fin-imports is-blank">
        <div className="fin-blank">
          <span className="fin-blank-ico">
            <Icon name="FileSpreadsheet" size={26} />
          </span>
          <h3>No ledger uploaded yet</h3>
          <p>
            The file to upload is Whatnot&rsquo;s ledger export — the CSV of every money movement on
            the account: sales, tips, shipping subsidies, giveaway postage, Show Boost charges and
            payouts, each stamped with the moment it happened.
          </p>
          <p>
            Each row is matched to the stream session running at that instant and booked to that
            show&rsquo;s date — so a Thursday-night show that sells until 2am counts entirely on
            Thursday. Anything matching no session is listed, not dropped.
          </p>
          {canManage ? (
            <Button
              variant="primary"
              icon="UploadCloud"
              loading={busy}
              onClick={() => void upload()}
            >
              Upload ledger
            </Button>
          ) : (
            <p className="fin-blank-gate">
              Uploading needs the <b>Manage finance data</b> permission.
            </p>
          )}
        </div>
      </section>
    )
  }

  const visible = showAll ? imports : imports.slice(0, IMPORT_PREVIEW)

  return (
    <section className="fin-imports">
      <div className="fin-imports-head">
        <span className="fin-section-title">
          <Icon name="FileSpreadsheet" size={15} />
          Ledger imports
          <span className="fin-count">{imports.length}</span>
        </span>
        {canManage && (
          <Button
            size="sm"
            variant="secondary"
            icon="UploadCloud"
            loading={busy}
            onClick={() => void upload()}
          >
            Upload ledger
          </Button>
        )}
      </div>

      <div className="fin-import-list">
        {visible.map((imp) => (
          <ImportRow
            key={imp.id}
            imp={imp}
            fresh={imp.id === freshId}
            canManage={canManage}
            onDelete={() => setDeleting(imp)}
          />
        ))}
      </div>

      {imports.length > IMPORT_PREVIEW && (
        <button type="button" className="fin-more" onClick={() => setShowAll((v) => !v)}>
          <Icon name={showAll ? 'ChevronUp' : 'ChevronDown'} size={14} />
          {showAll
            ? 'Show only the latest imports'
            : `Show ${plural(imports.length - IMPORT_PREVIEW, 'earlier import')}`}
        </button>
      )}

      {confirm}
    </section>
  )
}

function ImportRow({
  imp,
  fresh,
  canManage,
  onDelete
}: {
  imp: LedgerImport
  fresh: boolean
  canManage: boolean
  onDelete: () => void
}): JSX.Element {
  // An import that brought in nothing new — every row already stored from an
  // overlapping export — has no denominator, and "0% matched to a show" on it
  // would read as a failed attribution rather than as an empty numerator.
  const matchedShare =
    imp.rowsImported > 0 ? Math.round((imp.attributedRows / imp.rowsImported) * 100) : null

  return (
    <article className={`fin-import${fresh ? ' is-fresh' : ''}`}>
      <div className="fin-import-top">
        <Icon name="FileSpreadsheet" size={14} />
        <b className="fin-import-name">{imp.filename}</b>
        {fresh && <span className="fin-fresh-tag">Just imported</span>}
        <span className="fin-import-when">{instantLabel(imp.createdAt)}</span>
        {canManage && (
          <button
            type="button"
            className="fin-import-del"
            onClick={onDelete}
            title="Delete this import and every row it brought in"
            aria-label={`Delete import ${imp.filename}`}
          >
            <Icon name="Trash2" size={14} />
          </button>
        )}
      </div>

      {/* One flowing line of counts rather than four stat blocks. The numbers
          have not changed and none of them has gone; what has gone is the
          furniture that made a file receipt look as important as the P&L. */}
      <p className="fin-import-meta">
        <Stat value={imp.rowsImported} label="rows imported" />
        <Stat
          value={imp.rowsDuplicate}
          label="already stored"
          hint="Rows already held from an overlapping export. Skipping them is what makes re-uploading a week safe."
        />
        <Stat
          value={imp.rowsRepaired}
          label="repaired"
          hint="Rows Whatnot exported with unescaped quotes, stitched back together rather than dropped."
        />
        <Stat
          value={imp.rowsQuarantined}
          label="quarantined"
          warn={imp.rowsQuarantined > 0}
          hint="Rows that could not be parsed at all. Kept verbatim, but counted nowhere on this screen."
        />
      </p>

      <p className="fin-import-meta">
        <span>
          Covers {shortInstantDate(imp.firstOccurredAt)} – {shortInstantDate(imp.lastOccurredAt)}
        </span>
        <span title="Share of this file's new rows that fell inside a logged session">
          {matchedShare === null ? (
            'no new rows to match'
          ) : (
            <>
              <b className="mono">{matchedShare}%</b> of its rows matched a show
            </>
          )}
        </span>
        {imp.unattributedRows > 0 && (
          <span>
            {plural(imp.unattributedRows, 'row')} unmatched, worth{' '}
            <Money value={imp.unattributedAmount} />
          </span>
        )}
      </p>

      {imp.warnings.length > 0 && (
        <Note tone="warn" icon="AlertTriangle">
          <b>
            {imp.warnings.length === 1
              ? 'One thing to check on this import'
              : `${imp.warnings.length} things to check on this import`}
          </b>
          <ul className="fin-warn-list">
            {imp.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Note>
      )}
    </article>
  )
}

function Stat({
  value,
  label,
  hint,
  warn
}: {
  value: number
  label: string
  hint?: string
  warn?: boolean
}): JSX.Element {
  // A zero here is a real answer — "nothing was quarantined" is worth reading —
  // so it is printed, just without the emphasis of a count that wants attention.
  return (
    <span className={`fin-stat${value === 0 ? ' is-zero' : ''}${warn ? ' is-warn' : ''}`} title={hint}>
      <b className="mono">{value.toLocaleString()}</b> {label}
    </span>
  )
}
