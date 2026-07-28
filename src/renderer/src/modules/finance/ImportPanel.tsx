import { useState } from 'react'
import type { LedgerImport, StreamingFinanceView } from '@shared/financeStreaming'
import { formatDateTime } from '../../lib/format'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { Button, Modal } from '../../components/ui'
import { Money, Note, plural } from './bits'
import { finance, resultError } from './api'
import { shortInstantDate } from './time'

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

  const visible = showAll ? imports : imports.slice(0, IMPORT_PREVIEW)

  return (
    <section className="fin-imports">
      <div className="fin-imports-head">
        <span className="fin-section-title">
          <Icon name="FileSpreadsheet" size={15} />
          Ledger imports
          {imports.length > 0 && <span className="fin-count">{imports.length}</span>}
        </span>
        {canManage && (
          <Button variant="primary" icon="UploadCloud" loading={busy} onClick={() => void upload()}>
            Upload ledger
          </Button>
        )}
      </div>

      {imports.length === 0 ? (
        <div className="fin-blank">
          <span className="fin-blank-ico">
            <Icon name="FileSpreadsheet" size={26} />
          </span>
          <h3>No ledger uploaded yet</h3>
          <p>
            The file to upload is Whatnot&rsquo;s ledger export — the CSV of every money movement on
            the account: sales, tips, shipping subsidies, giveaway postage, Show Boost charges and
            payouts, each stamped with the moment it happened. Export it from Whatnot, then press{' '}
            <b>Upload ledger</b>.
          </p>
          <p>
            Each row is matched to the stream session running at that instant and booked to that
            show&rsquo;s date — so a Thursday-night show that sells until 2am counts entirely on
            Thursday. Anything matching no session is listed, not dropped.
          </p>
          {!canManage && (
            <p className="fin-blank-gate">
              Uploading needs the <b>Manage finance data</b> permission.
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="fin-import-list">
            {visible.map((imp) => (
              <ImportCard
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
                : `Show ${imports.length - IMPORT_PREVIEW} earlier import${
                    imports.length - IMPORT_PREVIEW === 1 ? '' : 's'
                  }`}
            </button>
          )}
        </>
      )}

      {deleting && (
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
              {shortInstantDate(deleting.firstOccurredAt)} to{' '}
              {shortInstantDate(deleting.lastOccurredAt)}
            </b>{' '}
            — falls back to whatever the remaining imports hold, which may be nothing at all.
            Re-uploading the same file brings it all back; no session or stock record is touched.
          </p>
        </Modal>
      )}
    </section>
  )
}

function ImportCard({
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
  const matchedShare =
    imp.rowsImported > 0 ? Math.round((imp.attributedRows / imp.rowsImported) * 100) : 0

  return (
    <article className={`fin-import${fresh ? ' is-fresh' : ''}`}>
      <div className="fin-import-top">
        <span className="fin-import-name">
          <Icon name="FileSpreadsheet" size={15} />
          <b>{imp.filename}</b>
          {fresh && <span className="fin-fresh-tag">Just imported</span>}
        </span>
        <span className="fin-import-when">{formatDateTime(imp.createdAt)}</span>
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

      <div className="fin-import-stats">
        <ImportStat value={imp.rowsImported} label="rows imported" />
        <ImportStat
          value={imp.rowsDuplicate}
          label="duplicates skipped"
          hint="Rows already stored from an overlapping export. Skipping them is what makes re-uploading a week safe."
        />
        <ImportStat
          value={imp.rowsRepaired}
          label="repaired"
          hint="Rows Whatnot exported with unescaped quotes, stitched back together rather than dropped."
        />
        <ImportStat
          value={imp.rowsQuarantined}
          label="quarantined"
          tone={imp.rowsQuarantined > 0 ? 'warn' : undefined}
          hint="Rows that could not be parsed at all. Kept verbatim, but counted nowhere on this screen."
        />
      </div>

      <div className="fin-import-foot">
        <span className="fin-import-range">
          <Icon name="CalendarDays" size={13} />
          Covers {shortInstantDate(imp.firstOccurredAt)} → {shortInstantDate(imp.lastOccurredAt)}
        </span>
        <span className="fin-import-attr" title="Rows this import matched to a logged show">
          <Icon name="Link2" size={13} />
          {matchedShare}% matched to a show
        </span>
        {imp.unattributedRows > 0 && (
          <span className="fin-import-unattr">
            {plural(imp.unattributedRows, 'row')} unmatched, worth{' '}
            <Money value={imp.unattributedAmount} />
          </span>
        )}
      </div>

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

function ImportStat({
  value,
  label,
  hint,
  tone
}: {
  value: number
  label: string
  hint?: string
  tone?: 'warn'
}): JSX.Element {
  // A zero here is a real answer — "nothing was quarantined" is worth reading —
  // so it is printed, just quieter than a count that wants attention.
  return (
    <span
      className={`fin-import-stat${value === 0 ? ' is-zero' : ''}${tone ? ` tone-${tone}` : ''}`}
      title={hint}
    >
      <b className="mono">{value.toLocaleString()}</b>
      {label}
    </span>
  )
}
