import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ShipImportRecord, ShipSnapshotSummary } from '@shared/shippingTypes'
import type {
  ShipExportKind,
  ShipImportDeletePlan,
  ShipSnapshotContents
} from '@shared/shippingViews'
import { SHIP_EXPORT_KINDS, SHIP_EXPORT_LABELS } from '@shared/shippingViews'
import type { ShipTabProps } from './ShippingModule'
import { ShippingCalendar } from './ShippingCalendar'
import { api } from '../../lib/api'
import { formatDateTime, formatMoney } from '../../lib/format'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { Button, CenterLoader, Checkbox, EmptyState, Field, Input, Modal } from '../../components/ui'

/**
 * History tab — architecture doc section 7.
 *
 * Four things live here, and the difference between them is the whole point:
 *
 *  - **The activity calendar** is the month view over the two below: one cell
 *    per day, derived by the main process from the same imports and snapshots
 *    (there is no rollup table), showing what ran, what it was worth and how far
 *    it got. It joins the lists — it does not replace them.
 *
 *  - **Import history** is a log. One active dataset exists at a time; every
 *    import overwrites it and appends a nameable row here recording what came in
 *    and whether it carried operator state forward (which only happens on a
 *    confirmed same-named-event re-import).
 *  - **Snapshots** are a dated *capture* of orders + shipments + sales that
 *    survives a re-import. They are rendered from the stored capture, so a
 *    snapshot still exports correctly after the live dataset has been replaced.
 *  - **Exports** write CSV from the LIVE dataset — nine kinds, plus a per-snapshot
 *    export of that capture's orders.
 *
 * Deleting an import row deletes THE SHOW when that import is the active one:
 * every package, card, claim and break assignment goes with it. Deleting any
 * earlier row is nearly inert, because that import's dataset was overwritten
 * long ago. Which of the two is about to happen — and what it costs — is the
 * whole content of the confirmation, and it is drawn from the main process
 * rather than guessed at here.
 */

const EXPORT_ICONS: Record<ShipExportKind, string> = {
  orders: 'ClipboardList',
  shipments: 'Truck',
  ledger: 'ListTree',
  sales: 'BarChart3',
  customers: 'Users',
  checker: 'ListChecks',
  warnings: 'AlertTriangle',
  imports: 'History',
  tracking: 'Hash'
}

const EXPORT_HINTS: Record<ShipExportKind, string> = {
  orders: 'One row per package, with stage, tracking and value',
  shipments: 'Tracking, carrier, weight and manual status',
  ledger: 'One row per card — the flattened truth',
  sales: 'Revenue, cards and giveaways per break',
  customers: 'Revenue and card counts per customer',
  checker: 'Every pick row, with who owns it',
  warnings: 'What the parser could not read',
  imports: 'The import log itself',
  tracking: 'Just the tracking numbers'
}

type Editing =
  | { kind: 'import-rename'; record: ShipImportRecord }
  | { kind: 'import-delete'; record: ShipImportRecord }
  | { kind: 'snapshot-create' }
  | { kind: 'snapshot-rename'; snapshot: ShipSnapshotSummary }
  | { kind: 'snapshot-delete'; snapshot: ShipSnapshotSummary }

export function HistoryTab({ summary, canManage, onChanged }: ShipTabProps): JSX.Element {
  const toast = useToast()

  const [imports, setImports] = useState<ShipImportRecord[]>([])
  const [snapshots, setSnapshots] = useState<ShipSnapshotSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [exporting, setExporting] = useState<string | null>(null)
  const [openSnapshot, setOpenSnapshot] = useState<string | null>(null)
  const [snapshotBody, setSnapshotBody] = useState<ShipSnapshotContents | null>(null)
  const [snapshotLoading, setSnapshotLoading] = useState(false)
  // Bumped after any import/snapshot mutation. The calendar derives its month
  // from those same rows, so it has to re-read when one is renamed or deleted —
  // it owns its own fetch, and this is how it is told the ground moved.
  const [calendarVersion, setCalendarVersion] = useState(0)

  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged

  const reload = useCallback(async () => {
    const [i, s] = await Promise.all([api.shipping.imports(), api.shipping.snapshots()])
    setImports(i)
    setSnapshots(s)
  }, [])

  /** Refetch the lists AND invalidate the calendar — used by every mutation. */
  const reloadAll = useCallback(async () => {
    await reload()
    setCalendarVersion((v) => v + 1)
  }, [reload])

  useEffect(() => {
    let active = true
    ;(async () => {
      // A rejected read must never leave the view on a permanent spinner: catch,
      // surface it, and always clear loading.
      try {
        await reload()
      } catch (err) {
        if (active) setLoadError(err instanceof Error ? err.message : 'Could not load shipping data.')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [reload])

  // A snapshot's payload is only fetched when one is expanded — the list itself
  // stays cheap no matter how many captures pile up.
  useEffect(() => {
    if (!openSnapshot) {
      setSnapshotBody(null)
      return
    }
    let active = true
    setSnapshotLoading(true)
    ;(async () => {
      const snap = await api.shipping.snapshot(openSnapshot)
      if (!active) return
      setSnapshotBody((snap?.payload as unknown as ShipSnapshotContents) ?? null)
      setSnapshotLoading(false)
    })()
    return () => {
      active = false
    }
  }, [openSnapshot])

  const runExport = useCallback(
    async (key: string, kind: ShipExportKind, snapshotId?: string) => {
      setExporting(key)
      try {
        const res = await api.shipping.export(kind, snapshotId ?? null)
        if (res.canceled) return
        if (!res.ok) {
          toast.error(res.error ?? 'Could not write that CSV.')
          return
        }
        toast.success(`Saved ${res.path ?? 'the CSV'}.`)
      } finally {
        setExporting(null)
      }
    },
    [toast]
  )

  const createSnapshot = useCallback(
    async (name: string) => {
      setBusy(true)
      try {
        const res = await api.shipping.createSnapshot(name)
        if (!res.ok || !res.data) {
          toast.error(res.error ?? 'Could not create the snapshot.')
          return
        }
        await reloadAll()
        setEditing(null)
        toast.success(`Snapshot “${res.data.name}” captured.`)
      } finally {
        setBusy(false)
      }
    },
    [reloadAll, toast]
  )

  const renameSnapshot = useCallback(
    async (id: string, name: string) => {
      setBusy(true)
      try {
        const res = await api.shipping.renameSnapshot(id, name)
        if (!res.ok) {
          toast.error(res.error ?? 'Could not rename the snapshot.')
          return
        }
        await reloadAll()
        setEditing(null)
      } finally {
        setBusy(false)
      }
    },
    [reloadAll, toast]
  )

  const deleteSnapshot = useCallback(
    async (id: string) => {
      setBusy(true)
      try {
        const res = await api.shipping.deleteSnapshot(id)
        if (!res.ok) {
          toast.error(res.error ?? 'Could not delete the snapshot.')
          return
        }
        if (openSnapshot === id) setOpenSnapshot(null)
        await reloadAll()
        setEditing(null)
      } finally {
        setBusy(false)
      }
    },
    [openSnapshot, reloadAll, toast]
  )

  const renameImport = useCallback(
    async (id: string, name: string) => {
      setBusy(true)
      try {
        const res = await api.shipping.renameImport(id, name)
        if (!res.ok) {
          toast.error(res.error ?? 'Could not rename the import.')
          return
        }
        await reloadAll()
        await onChangedRef.current()
        setEditing(null)
      } finally {
        setBusy(false)
      }
    },
    [reloadAll, toast]
  )

  const deleteImport = useCallback(
    async (id: string) => {
      setBusy(true)
      try {
        const res = await api.shipping.deleteImport(id)
        if (!res.ok || !res.data) {
          toast.error(res.error ?? 'Could not delete that import.')
          return
        }
        const { plan, workspaceCleared } = res.data
        await reloadAll()
        await onChangedRef.current()
        setEditing(null)
        toast.success(
          workspaceCleared
            ? `“${plan.name}” deleted. The workspace is empty.`
            : `“${plan.name}” deleted.`
        )
      } finally {
        setBusy(false)
      }
    },
    [reloadAll, toast]
  )

  /**
   * "Jump to that snapshot" from a calendar day: expand the capture in the list
   * below and bring it into view, so the click lands somewhere visible rather
   * than silently opening a row three screens down.
   */
  const jumpToSnapshot = useCallback((id: string) => {
    setOpenSnapshot(id)
    // One frame later the row is expanded and has its final height.
    requestAnimationFrame(() => {
      document
        .getElementById(`hist-snap-${id}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }, [])

  const activeImportId = summary?.lastImport?.id ?? null
  const hasDataset = !!summary?.hasDataset
  // The calendar shows a spinner on the snapshot whose CSV is being written;
  // the export itself stays owned here, where the file dialog lives.
  const exportingSnapshotId = exporting?.startsWith('snap:') ? exporting.slice(5) : null

  const importTotals = useMemo(() => {
    let cards = 0
    let value = 0
    for (const r of imports) {
      cards += r.counts?.teamSlots ?? 0
      value += r.counts?.cardValue ?? 0
    }
    return { cards, value }
  }, [imports])

  // The calendar owns a separate read (api.shipping.calendar) and its own error
  // handling, so it renders above the loading/error branches rather than inside
  // them — a slow or failed snapshot list must not take the month view with it.
  const calendar = (
    <ShippingCalendar
      refreshToken={calendarVersion}
      onOpenSnapshot={jumpToSnapshot}
      onExportSnapshot={(id) => runExport(`snap:${id}`, 'orders', id)}
      exportingSnapshotId={exportingSnapshotId}
      exportBusy={exporting !== null}
    />
  )

  if (loading) {
    return (
      <div className="ship-page hist-page">
        {calendar}
        <CenterLoader />
      </div>
    )
  }
  // A failed load is a dead end otherwise — show what happened and offer a retry.
  if (loadError) {
    return (
      <div className="ship-page hist-page">
        {calendar}
        <EmptyState
          icon="AlertTriangle"
          title="Could not load shipping data"
          message={loadError}
          action={
            <Button
              variant="primary"
              icon="RefreshCw"
              onClick={() => {
                setLoadError(null)
                setLoading(true)
                void reload()
                  .catch((err) =>
                    setLoadError(
                      err instanceof Error ? err.message : 'Could not load shipping data.'
                    )
                  )
                  .finally(() => setLoading(false))
              }}
            >
              Try again
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <div className="ship-page hist-page">
      {/* ---- The month view over everything below ---- */}
      {calendar}

      {/* ---- Exports from the live dataset ----
           Lead-only. The customers and sales CSVs carry every buyer's real
           name, full address and total spend, and this module now runs on
           shared bench logins that sit unattended on work computers. The IPC
           refuses it too — this only stops the floor being shown a button that
           would fail. */}
      {canManage && (
      <section className="hist-section">
        <div className="hist-head">
          <span className="hist-title">
            <Icon name="FileDown" size={16} /> Export the active dataset
          </span>
          <span className="hist-sub">
            {hasDataset
              ? 'CSV, written wherever you choose. Every export reads the dataset as it stands right now.'
              : 'Nothing to export — the workspace is empty.'}
          </span>
        </div>
        {hasDataset ? (
          <div className="hist-export-grid">
            {SHIP_EXPORT_KINDS.map((kind) => (
              <button
                key={kind}
                className="hist-export"
                disabled={exporting !== null}
                onClick={() => runExport(`live:${kind}`, kind)}
              >
                <span className="hist-export-ico">
                  <Icon
                    name={exporting === `live:${kind}` ? 'Loader2' : EXPORT_ICONS[kind]}
                    size={16}
                    className={exporting === `live:${kind}` ? 'spin-ico' : undefined}
                  />
                </span>
                <span className="hist-export-body">
                  <b>{SHIP_EXPORT_LABELS[kind]}</b>
                  <em>{EXPORT_HINTS[kind]}</em>
                </span>
                <Icon name="Download" size={14} />
              </button>
            ))}
          </div>
        ) : (
          // Setup is the tab next door in Admin rather than somewhere to be
          // sent — naming it beats a button that walks one pill sideways.
          <EmptyState
            icon="FileSpreadsheet"
            title="No dataset to export"
            message="Import a Whatnot packing-slip PDF on the Setup tab first."
          />
        )}
      </section>
      )}

      {/* ---- Snapshots ---- */}
      <section className="hist-section">
        <div className="hist-head">
          <span className="hist-title">
            <Icon name="Archive" size={16} /> Snapshots
            {snapshots.length > 0 && <span className="hist-count mono">{snapshots.length}</span>}
          </span>
          <span className="hist-sub">A dated capture that survives the next import.</span>
          {canManage && hasDataset && (
            <Button
              size="sm"
              variant="primary"
              icon="Save"
              onClick={() => setEditing({ kind: 'snapshot-create' })}
            >
              Capture snapshot
            </Button>
          )}
        </div>

        {snapshots.length === 0 ? (
          <div className="hist-empty">
            <Icon name="Archive" size={15} />
            No snapshots yet.{' '}
            {canManage && hasDataset
              ? 'Capture one at the end of an event and the numbers stay yours.'
              : 'They are captured from a finished event.'}
          </div>
        ) : (
          <div className="hist-list">
            {snapshots.map((s) => {
              const open = openSnapshot === s.id
              return (
                <div
                  className={`hist-row ${open ? 'open' : ''}`}
                  key={s.id}
                  id={`hist-snap-${s.id}`}
                >
                  <div className="hist-row-main">
                    <button
                      className="hist-row-name"
                      onClick={() => setOpenSnapshot(open ? null : s.id)}
                    >
                      <Icon name={open ? 'ChevronDown' : 'ChevronRight'} size={15} />
                      <Icon name="Archive" size={14} />
                      {s.name}
                    </button>
                    <span className="hist-row-when">
                      <Icon name="CalendarClock" size={13} /> {formatDateTime(s.createdAt)}
                    </span>
                    <div className="hist-row-actions">
                      <button
                        className="sor-act"
                        title="Export this capture's orders as CSV"
                        disabled={exporting !== null}
                        onClick={() => runExport(`snap:${s.id}`, 'orders', s.id)}
                      >
                        <Icon
                          name={exporting === `snap:${s.id}` ? 'Loader2' : 'FileDown'}
                          size={15}
                          className={exporting === `snap:${s.id}` ? 'spin-ico' : undefined}
                        />
                      </button>
                      {canManage && (
                        <>
                          <button
                            className="sor-act"
                            title="Rename"
                            onClick={() => setEditing({ kind: 'snapshot-rename', snapshot: s })}
                          >
                            <Icon name="Pencil" size={15} />
                          </button>
                          <button
                            className="sor-act danger"
                            title="Delete"
                            onClick={() => setEditing({ kind: 'snapshot-delete', snapshot: s })}
                          >
                            <Icon name="Trash2" size={15} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {open && (
                    <div className="hist-snap-body">
                      {snapshotLoading ? (
                        <CenterLoader />
                      ) : snapshotBody ? (
                        <SnapshotContents contents={snapshotBody} />
                      ) : (
                        <span className="muted text-sm">This capture could not be read.</span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* ---- Import history ---- */}
      <section className="hist-section">
        <div className="hist-head">
          <span className="hist-title">
            <Icon name="History" size={16} /> Import history
            {imports.length > 0 && <span className="hist-count mono">{imports.length}</span>}
          </span>
          {imports.length > 0 && (
            <span className="hist-total mono">
              {importTotals.cards} cards · {formatMoney(importTotals.value)} across all imports
            </span>
          )}
        </div>

        {imports.length === 0 ? (
          <div className="hist-empty">
            <Icon name="History" size={15} />
            Nothing has been imported yet.
          </div>
        ) : (
          <div className="hist-list">
            {imports.map((r) => (
              <div className={`hist-row ${r.id === activeImportId ? 'active' : ''}`} key={r.id}>
                <div className="hist-row-main">
                  <span className="hist-row-name static">
                    <Icon name="FileText" size={14} />
                    {r.name}
                    {r.id === activeImportId && (
                      <span className="ship-chip ok mini">
                        <Icon name="Check" size={11} /> Active dataset
                      </span>
                    )}
                    {r.carriedForward ? (
                      <span
                        className="ship-chip info mini"
                        title="Same-named re-import — check-offs and statuses were re-attached."
                      >
                        <Icon name="Repeat" size={11} /> Carried forward
                      </span>
                    ) : (
                      <span className="ship-chip mini" title="Everything started fresh at To pick.">
                        <Icon name="Sparkles" size={11} /> Fresh
                      </span>
                    )}
                  </span>
                  <span className="hist-row-when">
                    <Icon name="CalendarClock" size={13} /> {formatDateTime(r.createdAt)}
                  </span>
                  {canManage && (
                    <div className="hist-row-actions">
                      <button
                        className="sor-act"
                        title="Rename this import"
                        onClick={() => setEditing({ kind: 'import-rename', record: r })}
                      >
                        <Icon name="Pencil" size={15} />
                      </button>
                      <button
                        className="sor-act danger"
                        title={
                          r.id === activeImportId
                            ? 'Delete this show and empty the workspace'
                            : 'Delete this import'
                        }
                        onClick={() => setEditing({ kind: 'import-delete', record: r })}
                      >
                        <Icon name="Trash2" size={15} />
                      </button>
                    </div>
                  )}
                </div>

                <div className="hist-row-meta">
                  <span className="hist-file mono" title={r.filename}>
                    <Icon name="FileUp" size={12} /> {r.filename || '—'}
                  </span>
                  <span className="hist-kind">{r.kind.toUpperCase()}</span>
                  <span className="hist-counts">
                    <Count icon="Users" value={r.counts?.customers ?? 0} label="customers" />
                    <Count icon="Layers" value={r.counts?.breaks ?? 0} label="breaks" />
                    <Count icon="SquareStack" value={r.counts?.teamSlots ?? 0} label="cards" />
                    <Count icon="Hash" value={r.counts?.orders ?? 0} label="line items" />
                    <Count icon="Package" value={r.counts?.shipments ?? 0} label="packages" />
                    <Count icon="Gift" value={r.counts?.giveaways ?? 0} label="giveaways" />
                    <Count
                      icon="AlertTriangle"
                      value={r.counts?.warnings ?? 0}
                      label="warnings"
                      tone={(r.counts?.warnings ?? 0) > 0 ? 'warn' : undefined}
                    />
                  </span>
                  <span className="hist-value mono">{formatMoney(r.counts?.cardValue ?? 0)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {editing?.kind === 'import-delete' ? (
        <ImportDeleteModal
          key={editKey(editing)}
          record={editing.record}
          busy={busy}
          onClose={() => setEditing(null)}
          onDelete={deleteImport}
        />
      ) : (
        editing && (
          <EditModal
            key={editKey(editing)}
            editing={editing}
            busy={busy}
            onClose={() => setEditing(null)}
            onCreateSnapshot={createSnapshot}
            onRenameSnapshot={renameSnapshot}
            onDeleteSnapshot={deleteSnapshot}
            onRenameImport={renameImport}
          />
        )
      )}
    </div>
  )
}

function editKey(e: Editing): string {
  if (e.kind === 'snapshot-create') return e.kind
  if (e.kind === 'import-rename' || e.kind === 'import-delete') return `${e.kind}:${e.record.id}`
  return `${e.kind}:${e.snapshot.id}`
}

function Count({
  icon,
  value,
  label,
  tone
}: {
  icon: string
  value: number
  label: string
  tone?: 'warn'
}): JSX.Element {
  return (
    <span className={`hist-count-item ${tone ?? ''}`} title={label}>
      <Icon name={icon} size={12} />
      <b className="mono">{value}</b>
      {label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// What a snapshot actually captured
// ---------------------------------------------------------------------------

function SnapshotContents({ contents }: { contents: ShipSnapshotContents }): JSX.Element {
  const orders = contents.orders ?? []
  const shipments = contents.shipments ?? []
  const sales = contents.sales
  const delivered = shipments.filter((s) => s.manualStatus?.code === 'delivered').length

  return (
    <div className="hist-snap">
      <div className="hist-snap-grid">
        <SnapStat icon="CalendarDays" label="Event" value={contents.event?.name || 'Unnamed'} />
        <SnapStat icon="Package" label="Packages" value={String(orders.length)} />
        <SnapStat icon="SquareStack" label="Cards" value={String(sales?.cardCount ?? 0)} />
        <SnapStat icon="DollarSign" label="Revenue" value={formatMoney(sales?.revenue ?? 0)} />
        <SnapStat icon="Users" label="Customers" value={String(sales?.customerCount ?? 0)} />
        <SnapStat icon="Layers" label="Breaks" value={String(sales?.breakCount ?? 0)} />
        <SnapStat icon="Gift" label="Giveaways" value={String(sales?.giveawayCount ?? 0)} />
        <SnapStat icon="PackageCheck" label="Delivered" value={`${delivered}/${shipments.length}`} />
      </div>

      {sales?.topCustomers && sales.topCustomers.length > 0 && (
        <div className="hist-snap-top">
          <span className="hist-snap-top-title">
            <Icon name="Crown" size={13} /> Top customers in this capture
          </span>
          <div className="hist-snap-top-list">
            {sales.topCustomers.slice(0, 6).map((c) => (
              <span className="hist-snap-top-row" key={c.customerId}>
                <b>@{c.handle}</b>
                <em className="mono">{c.cards} cards</em>
                <span className="mono">{formatMoney(c.revenue)}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <span className="hist-snap-note">
        Captured {formatDateTime(contents.createdAt)}. Exports read these stored rows, not the live
        dataset.
      </span>
    </div>
  )
}

function SnapStat({
  icon,
  label,
  value
}: {
  icon: string
  label: string
  value: string
}): JSX.Element {
  return (
    <div className="hist-snap-stat">
      <Icon name={icon} size={14} />
      <b>{value}</b>
      <em>{label}</em>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Rename / delete / create
// ---------------------------------------------------------------------------

/**
 * Deleting a show, stated in full before it happens.
 *
 * Modelled on the inventory reset's confirm rather than on the rename dialogs
 * beside it, because it belongs to the same category: irreversible, and capable
 * of destroying much more than the row that was clicked. So it leads with what
 * goes, prices it, names anyone who is mid-pick, and — the moment live work or
 * real progress is involved — refuses to arm the button until the operator has
 * ticked an acknowledgement that says the number out loud.
 *
 * The figures are the MAIN PROCESS's, fetched fresh when the dialog opens, and
 * the delete recomputes them for itself: this screen states the bargain, it does
 * not enforce it.
 */
function ImportDeleteModal({
  record,
  busy,
  onClose,
  onDelete
}: {
  record: ShipImportRecord
  busy: boolean
  onClose: () => void
  onDelete: (id: string) => void
}): JSX.Element {
  const [plan, setPlan] = useState<ShipImportDeletePlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const res = await api.shipping.importDeletePlan(record.id)
        if (!active) return
        if (!res.ok || !res.data) setError(res.error ?? 'Could not read what this would delete.')
        else setPlan(res.data)
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Could not read what this would delete.')
      }
    })()
    return () => {
      active = false
    }
  }, [record.id])

  const armed = !!plan && (!plan.needsAcknowledgement || acknowledged)

  return (
    <Modal
      title={plan?.isLive ? 'Delete this show?' : 'Delete this import?'}
      subtitle={record.name}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            icon="Trash2"
            loading={busy}
            disabled={!armed}
            onClick={() => plan && onDelete(plan.importId)}
          >
            {plan?.isLive ? 'Delete the show' : 'Delete the import'}
          </Button>
        </>
      }
    >
      {error ? (
        <p className="ship-confirm-body">{error}</p>
      ) : !plan ? (
        <CenterLoader />
      ) : (
        <div className="hist-del">
          <p className="ship-confirm-body">
            {plan.isLive ? (
              <>
                This is the <b>active</b> import, so its rows are the workspace. Deleting it takes
                the whole show with it and leaves the workspace <b>empty</b> — there is no earlier
                dataset to fall back to, because this import overwrote it. There is no undo.
              </>
            ) : (
              <>
                This import no longer owns the workspace — its dataset was replaced or cleared, so
                no card, package or status changes. What goes is the <b>log entry</b> and the
                bench records stamped with it.
              </>
            )}
          </p>

          {plan.isLive && (
            <dl className="hist-del-figures">
              <div>
                <dt>Packages</dt>
                <dd>
                  <strong>{plan.packages}</strong>
                  {plan.packagesPacked > 0 && <span> · {plan.packagesPacked} already packed</span>}
                </dd>
              </div>
              <div>
                <dt>Cards</dt>
                <dd>
                  <strong>{plan.cards}</strong>
                  {plan.cardsPicked > 0 && <span> · {plan.cardsPicked} already picked</span>}
                </dd>
              </div>
              <div>
                <dt>Breaks</dt>
                <dd>
                  <strong>{plan.breaks}</strong>
                </dd>
              </div>
              <div>
                <dt>Card value</dt>
                <dd>
                  <strong>{formatMoney(plan.value)}</strong>
                </dd>
              </div>
            </dl>
          )}

          {plan.working.length > 0 && (
            <div className="hist-del-alarm">
              <Icon name="UserMinus" size={16} />
              <div>
                <strong>
                  {plan.working.length}{' '}
                  {plan.working.length === 1 ? 'person is' : 'people are'} working this show right
                  now
                </strong>
                <span>
                  {plan.working
                    .map(
                      (w) =>
                        `${w.name ?? 'Somebody'} is ${w.role === 'pack' ? 'packing' : 'picking'} ${
                          w.handle ? `@${w.handle}` : 'an order'
                        }`
                    )
                    .join(' · ')}
                  . Their screen will empty the moment this is done.
                </span>
              </div>
            </div>
          )}

          <ul className="hist-del-list">
            {plan.carriedToId ? (
              <li>
                <Icon name="Repeat" size={13} />
                <span>
                  Claims and assignments move to “
                  {plan.carriedToName || 'the import that carried forward from this one'}” — the
                  same run of work.
                </span>
              </li>
            ) : (
              (plan.claims > 0 || plan.assignments > 0) && (
                <li>
                  <Icon name="Users" size={13} />
                  <span>
                    <b>{plan.claims}</b> work {plan.claims === 1 ? 'claim' : 'claims'} and{' '}
                    <b>{plan.assignments}</b> break{' '}
                    {plan.assignments === 1 ? 'assignment' : 'assignments'} go with it. Nothing
                    carried forward from this import, so there is nothing to move them to.
                  </span>
                </li>
              )
            )}
            <li>
              <Icon name="Archive" size={13} />
              <span>
                {plan.snapshots > 0 ? (
                  <>
                    <b>{plan.snapshots}</b>{' '}
                    {plan.snapshots === 1 ? 'snapshot survives' : 'snapshots survive'} this delete.
                  </>
                ) : (
                  <>
                    No snapshot was ever captured from this show, so nothing about it stays
                    reportable. Capture one first if the numbers might be wanted.
                  </>
                )}
              </span>
            </li>
          </ul>

          {plan.needsAcknowledgement && (
            <div className="hist-del-ack">
              <Checkbox
                checked={acknowledged}
                onChange={setAcknowledged}
                label={`Yes — delete “${plan.name}” and everything shown above`}
                hint={
                  plan.cardsPicked > 0 || plan.packagesPacked > 0
                    ? `${plan.cardsPicked} picked cards and ${plan.packagesPacked} packed packages are thrown away with it.`
                    : 'This cannot be undone.'
                }
              />
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

function EditModal({
  editing,
  busy,
  onClose,
  onCreateSnapshot,
  onRenameSnapshot,
  onDeleteSnapshot,
  onRenameImport
}: {
  editing: Exclude<Editing, { kind: 'import-delete' }>
  busy: boolean
  onClose: () => void
  onCreateSnapshot: (name: string) => void
  onRenameSnapshot: (id: string, name: string) => void
  onDeleteSnapshot: (id: string) => void
  onRenameImport: (id: string, name: string) => void
}): JSX.Element {
  const initial =
    editing.kind === 'import-rename'
      ? editing.record.name
      : editing.kind === 'snapshot-rename'
        ? editing.snapshot.name
        : ''
  const [name, setName] = useState(initial)

  if (editing.kind === 'snapshot-delete') {
    return (
      <Modal
        title="Delete this snapshot?"
        subtitle={editing.snapshot.name}
        onClose={onClose}
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="danger"
              icon="Trash2"
              loading={busy}
              onClick={() => onDeleteSnapshot(editing.snapshot.id)}
            >
              Delete the snapshot
            </Button>
          </>
        }
      >
        <p className="ship-confirm-body">
          The capture is gone for good. If the live dataset has already been replaced by a later
          import, these numbers cannot be rebuilt — export the CSV first if you might want it.
        </p>
      </Modal>
    )
  }

  const isCreate = editing.kind === 'snapshot-create'
  const submit = (): void => {
    const value = name.trim()
    if (isCreate) onCreateSnapshot(value)
    else if (editing.kind === 'snapshot-rename') onRenameSnapshot(editing.snapshot.id, value)
    else if (editing.kind === 'import-rename') onRenameImport(editing.record.id, value)
  }

  return (
    <Modal
      title={
        isCreate
          ? 'Capture a snapshot'
          : editing.kind === 'snapshot-rename'
            ? 'Rename snapshot'
            : 'Rename import'
      }
      subtitle={
        isCreate
          ? 'Freezes orders, shipments and sales as they stand right now.'
          : 'Just a label — nothing about the data changes.'
      }
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon={isCreate ? 'Save' : 'Check'}
            loading={busy}
            disabled={!isCreate && name.trim().length === 0}
            onClick={submit}
          >
            {isCreate ? 'Capture' : 'Save'}
          </Button>
        </>
      }
    >
      <Field
        label="Name"
        hint={isCreate ? 'Leave it empty and the event name and date are used.' : undefined}
      >
        <Input
          autoFocus
          value={name}
          placeholder={isCreate ? 'Sunday NFL mega break' : 'Name'}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
      </Field>
    </Modal>
  )
}
