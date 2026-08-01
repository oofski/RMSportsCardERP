import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ShipBatchUrl, ShipStatusCode } from '@shared/shippingTypes'
import { SHIP_STATUS_CODES, SHIP_STATUS_LABELS } from '@shared/shippingTypes'
import type { ShipBulkStatusEntry, ShipShipmentRow } from '@shared/shippingViews'
import { SHIP_STAGE_LABELS } from '@shared/shippingViews'
import type { ShipTabProps } from './ShippingModule'
import { api } from '../../lib/api'
import { formatDateTime, formatMoney } from '../../lib/format'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import {
  Button,
  CenterLoader,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Textarea
} from '../../components/ui'

/**
 * Shipping tracker — architecture doc section 6.
 *
 * Tracking here is **manual status only**: nothing on this screen fetches a
 * carrier, scrapes USPS or phones home. What it does instead is the doc's
 * precedence rule, which exists so an automated writer can never stomp a status
 * a human deliberately chose:
 *
 *   humanSet && !forwardFromPreship && !forwardScan  ->  skip
 *
 * Two paths into a status, and the difference matters:
 *  - The per-row dropdown and the selection bar call `setShipmentStatus`, the
 *    always-writes escape hatch. A person looking at a row and picking a value
 *    always wins.
 *  - The bulk paste calls `bulkSetStatus`, where the writer matters. Pasting a
 *    17TRACK / USPS export marks it a machine scan (`by = auto`), so it may only
 *    move a package FORWARD and will report what it deliberately skipped.
 *
 * The USPS "open all" batch URLs come straight from the parse — the app just
 * hands them to the OS browser.
 */

type FlagFilter = 'all' | 'untracked' | 'tracked' | 'hold' | 'special' | 'undelivered'

const FLAG_LABELS: Record<FlagFilter, string> = {
  all: 'Every package',
  tracked: 'Has tracking',
  untracked: 'No tracking',
  undelivered: 'Not delivered yet',
  hold: 'On hold',
  special: 'Special requests'
}

const STATUS_ICONS: Record<ShipStatusCode, string> = {
  not_shipped: 'Package',
  label_created: 'Tag',
  in_transit: 'Truck',
  out_for_delivery: 'Send',
  delivered: 'PackageCheck',
  exception: 'AlertTriangle',
  returned: 'Undo2'
}

/** Who the bulk write is attributed to — this is what section 6 keys off. */
const BULK_WRITERS = [
  { value: 'auto', label: 'Imported scan (auto)' },
  { value: '17track', label: '17TRACK export' },
  { value: 'usps', label: 'USPS export' },
  { value: '', label: 'Me — a manual decision' }
]

/**
 * Free text -> status code. A pasted carrier export says "Delivered, In
 * Mailbox"; the operator should not have to translate that by hand. Ordered
 * longest-phrase-first so "out for delivery" never matches the "delivery" in a
 * broader phrase first.
 */
const STATUS_PHRASES: Array<[RegExp, ShipStatusCode]> = [
  [/out\s*for\s*delivery|with\s*(?:the\s*)?courier|on\s*vehicle/i, 'out_for_delivery'],
  [/return(?:ed|ing)?\s*(?:to\s*sender)?|rts\b|refused/i, 'returned'],
  [/deliver(?:ed|y\s*complete)|left\s*(?:with|at)|in\s*mailbox|picked\s*up\s*by/i, 'delivered'],
  [
    /exception|alert|delay|undeliverable|damaged|held\s*at|missent|no\s*access|address\s*issue/i,
    'exception'
  ],
  [
    /label\s*created|pre[-\s]?shipment|shipping\s*label|awaiting\s*item|manifest|electronic/i,
    'label_created'
  ],
  [
    /in\s*transit|accepted|arriv|depart|processed|moving|origin|destination|sorting|in\s*route|en\s*route/i,
    'in_transit'
  ],
  [/not\s*shipped|no\s*(?:info|movement)|pending/i, 'not_shipped']
]

interface ParsedBulkLine {
  raw: string
  trackingNumber: string | null
  code: ShipStatusCode | null
}

/** Parse one pasted line into a tracking number + status code. */
export function parseBulkLine(raw: string): ParsedBulkLine {
  const line = raw.trim()
  if (!line) return { raw, trackingNumber: null, code: null }
  // A tracking number is the first long run of digits (USPS is 20-22, but
  // UPS/FedEx mix letters, so accept any 8+ alphanumeric token with a digit).
  const token = line.split(/[\s,;|\t]+/).find((t) => /\d/.test(t) && /^[A-Za-z0-9]{8,}$/.test(t))
  const trackingNumber = token ?? null
  const rest = trackingNumber ? line.replace(trackingNumber, ' ') : line
  let code: ShipStatusCode | null = null
  for (const [re, c] of STATUS_PHRASES) {
    if (re.test(rest)) {
      code = c
      break
    }
  }
  return { raw: line, trackingNumber, code }
}

export function ShippingTab({ canManage, onChanged, onGoTo }: ShipTabProps): JSX.Element {
  const toast = useToast()

  const [rows, setRows] = useState<ShipShipmentRow[]>([])
  const [batches, setBatches] = useState<ShipBatchUrl[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | ShipStatusCode>('all')
  const [flag, setFlag] = useState<FlagFilter>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busyId, setBusyId] = useState<string | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [noteRow, setNoteRow] = useState<ShipShipmentRow | null>(null)
  const [holdRow, setHoldRow] = useState<ShipShipmentRow | null>(null)
  const [sweepStatus, setSweepStatus] = useState<ShipStatusCode>('in_transit')
  const [sweeping, setSweeping] = useState(false)

  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged

  const reload = useCallback(async () => {
    const [s, b] = await Promise.all([api.shipping.shipments(), api.shipping.batchUrls()])
    setRows(s)
    setBatches(b)
  }, [])

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

  const applyRow = useCallback((next: ShipShipmentRow) => {
    setRows((prev) => prev.map((r) => (r.id === next.id ? next : r)))
  }, [])

  // ---- Mutations -----------------------------------------------------------
  const setStatus = useCallback(
    async (row: ShipShipmentRow, code: ShipStatusCode) => {
      setBusyId(row.id)
      try {
        const res = await api.shipping.setShipmentStatus(row.id, code)
        if (!res.ok || !res.data) {
          toast.error(res.error ?? 'Could not set the status.')
          return
        }
        applyRow(res.data)
        await onChangedRef.current()
      } finally {
        setBusyId(null)
      }
    },
    [applyRow, toast]
  )

  const saveNotes = useCallback(
    async (row: ShipShipmentRow, notes: string) => {
      setBusyId(row.id)
      try {
        const res = await api.shipping.setShipmentNotes(row.id, notes)
        if (!res.ok || !res.data) {
          toast.error(res.error ?? 'Could not save the note.')
          return
        }
        applyRow(res.data)
        setNoteRow(null)
      } finally {
        setBusyId(null)
      }
    },
    [applyRow, toast]
  )

  const setHold = useCallback(
    async (row: ShipShipmentRow, onHold: boolean, reason: string | null) => {
      setBusyId(row.id)
      try {
        // Hold lives on the shipment, so the Orders handler is the same record —
        // it just derives an order row back, hence the refetch.
        const res = await api.shipping.setHold(row.id, onHold, reason)
        if (!res.ok) {
          toast.error(res.error ?? 'Could not change the hold.')
          return
        }
        await reload()
        setHoldRow(null)
        await onChangedRef.current()
      } finally {
        setBusyId(null)
      }
    },
    [reload, toast]
  )

  /**
   * The selection sweep. A person ticked these rows and picked a value, so it
   * goes through `setShipmentStatus` — the always-writes path — rather than the
   * bulk endpoint, which would treat it as a competing write and skip rows that
   * already carry a human status.
   */
  const sweepSelected = useCallback(async () => {
    const ids = [...selected]
    if (ids.length === 0) return
    setSweeping(true)
    try {
      let ok = 0
      for (const id of ids) {
        const res = await api.shipping.setShipmentStatus(id, sweepStatus)
        if (res.ok) ok += 1
      }
      await reload()
      await onChangedRef.current()
      setSelected(new Set())
      toast.success(
        `${ok} package${ok === 1 ? '' : 's'} set to ${SHIP_STATUS_LABELS[sweepStatus]}.`
      )
    } finally {
      setSweeping(false)
    }
  }, [reload, selected, sweepStatus, toast])

  const openBatch = useCallback(
    async (batchNumber?: number) => {
      const res = await api.shipping.openBatch(batchNumber)
      if (!res.ok) {
        toast.error(res.error ?? 'Could not open the tracking pages.')
        return
      }
      const opened = res.data?.opened ?? 0
      toast.success(`Opened ${opened} USPS tab${opened === 1 ? '' : 's'}.`)
    },
    [toast]
  )

  const copyTracking = useCallback(async () => {
    const numbers = await api.shipping.trackingNumbers()
    if (numbers.length === 0) {
      toast.error('No tracking numbers in this dataset.')
      return
    }
    await navigator.clipboard.writeText(numbers.join('\n'))
    toast.success(`Copied ${numbers.length} tracking numbers.`)
  }, [toast])

  // ---- Derivations ---------------------------------------------------------
  const statusCounts = useMemo(() => {
    const counts = Object.fromEntries(SHIP_STATUS_CODES.map((c) => [c, 0])) as Record<
      ShipStatusCode,
      number
    >
    for (const r of rows) counts[r.manualStatus.code] += 1
    return counts
  }, [rows])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((r) => {
      if (statusFilter !== 'all' && r.manualStatus.code !== statusFilter) return false
      if (flag === 'tracked' && !r.trackingNumber) return false
      if (flag === 'untracked' && r.trackingNumber) return false
      if (flag === 'hold' && !r.onHold) return false
      if (flag === 'special' && !r.specialRequest) return false
      if (flag === 'undelivered' && r.manualStatus.code === 'delivered') return false
      if (!q) return true
      return (
        r.customer.handle.toLowerCase().includes(q) ||
        r.customer.realName.toLowerCase().includes(q) ||
        r.customer.address.toLowerCase().includes(q) ||
        (r.trackingNumber ?? '').toLowerCase().includes(q) ||
        (r.serviceType ?? '').toLowerCase().includes(q) ||
        (r.carrier ?? '').toLowerCase().includes(q)
      )
    })
  }, [rows, query, statusFilter, flag])

  const totals = useMemo(
    () => ({
      packages: visible.length,
      tracked: visible.filter((r) => r.trackingNumber).length,
      delivered: visible.filter((r) => r.manualStatus.code === 'delivered').length,
      weight: visible.reduce((n, r) => n + (r.weightOz ?? 0), 0)
    }),
    [visible]
  )

  const allVisibleSelected = visible.length > 0 && visible.every((r) => selected.has(r.id))

  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  if (loading) return <CenterLoader />
  // A failed load is a dead end otherwise — show what happened and offer a retry.
  if (loadError) {
    return (
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
                  setLoadError(err instanceof Error ? err.message : 'Could not load shipping data.')
                )
                .finally(() => setLoading(false))
            }}
          >
            Try again
          </Button>
        }
      />
    )
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon="Truck"
        title="Nothing to ship yet"
        message="Import a Whatnot packing-slip PDF — every package with a label shows up here with its tracking number."
        action={
          <Button variant="primary" icon="UploadCloud" onClick={() => onGoTo('setup')}>
            Go to Upload
          </Button>
        }
      />
    )
  }

  return (
    <div className="ship-page">
      <div className="ship-toolbar">
        <div className="topsearch ship-search">
          <Icon name="Search" size={16} />
          <input
            placeholder="Search handle, name, address, tracking or service…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="ts-clear" title="Clear" onClick={() => setQuery('')}>
              <Icon name="X" size={14} />
            </button>
          )}
        </div>

        <Select
          className="ship-filter"
          value={flag}
          onChange={(e) => setFlag(e.target.value as FlagFilter)}
        >
          {(Object.keys(FLAG_LABELS) as FlagFilter[]).map((f) => (
            <option key={f} value={f}>
              {FLAG_LABELS[f]}
            </option>
          ))}
        </Select>

        <div className="ship-toolbar-right">
          <Button size="sm" icon="Copy" onClick={copyTracking}>
            Copy tracking
          </Button>
          {canManage && (
            <Button size="sm" variant="primary" icon="ClipboardPaste" onClick={() => setBulkOpen(true)}>
              Bulk update
            </Button>
          )}
        </div>
      </div>

      {/* USPS "open all" batch links — straight from the parse, no network here. */}
      {batches.length > 0 && (
        <div className="trk-batches">
          <span className="trk-batches-title">
            <Icon name="Link2" size={15} /> USPS batch tracking
          </span>
          <div className="trk-batch-list">
            {batches.map((b) => (
              <button
                key={b.batchNumber}
                className="trk-batch"
                title={b.url}
                onClick={() => openBatch(b.batchNumber)}
              >
                <span className="trk-batch-num mono">#{b.batchNumber}</span>
                <span className="trk-batch-count">{b.count} numbers</span>
                <Icon name="ExternalLink" size={13} />
              </button>
            ))}
          </div>
          <Button size="sm" icon="ExternalLink" onClick={() => openBatch()}>
            Open all {batches.length} batches
          </Button>
        </div>
      )}

      <div className="ship-stage-bar">
        <button
          className={`ship-stage-chip ${statusFilter === 'all' ? 'active' : ''}`}
          onClick={() => setStatusFilter('all')}
        >
          All <span className="mono">{rows.length}</span>
        </button>
        {SHIP_STATUS_CODES.map((c) => (
          <button
            key={c}
            data-code={c}
            className={`ship-stage-chip ${statusFilter === c ? 'active' : ''}`}
            onClick={() => setStatusFilter(statusFilter === c ? 'all' : c)}
          >
            {SHIP_STATUS_LABELS[c]} <span className="mono">{statusCounts[c]}</span>
          </button>
        ))}
        <span className="spacer" />
        <span className="ship-totals">
          <b className="mono">{totals.packages}</b> packages ·{' '}
          <b className="mono">{totals.tracked}</b> tracked ·{' '}
          <b className="mono">{totals.delivered}</b> delivered
          {totals.weight > 0 && (
            <>
              {' '}
              · <b className="mono">{totals.weight.toFixed(1)}</b> oz
            </>
          )}
        </span>
      </div>

      {selected.size > 0 && canManage && (
        <div className="trk-selbar">
          <Icon name="CheckCheck" size={15} />
          <b>{selected.size} selected</b>
          <Select
            className="trk-sel-status"
            value={sweepStatus}
            onChange={(e) => setSweepStatus(e.target.value as ShipStatusCode)}
          >
            {SHIP_STATUS_CODES.map((c) => (
              <option key={c} value={c}>
                {SHIP_STATUS_LABELS[c]}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="primary" icon="Check" loading={sweeping} onClick={sweepSelected}>
            Set status
          </Button>
          <span className="trk-selbar-note">
            A status you pick by hand always writes — it is never held back by a previous value.
          </span>
          <button className="link-btn" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}

      {visible.length === 0 ? (
        <EmptyState
          icon="Search"
          title="Nothing matches"
          message="No package matches the current search and filters."
          action={
            <Button
              icon="X"
              onClick={() => {
                setQuery('')
                setFlag('all')
                setStatusFilter('all')
              }}
            >
              Clear filters
            </Button>
          }
        />
      ) : (
        // `has-sel` switches the grid template: the select column only exists
        // for a writer, so a read-only view must not leave an empty column
        // behind and misalign every header.
        <div className={`trk-table ${canManage ? 'has-sel' : ''}`}>
          <div className="trk-head">
            {canManage && (
              <button
                className="trk-sel"
                title={allVisibleSelected ? 'Deselect all' : 'Select everything shown'}
                onClick={() =>
                  setSelected(allVisibleSelected ? new Set() : new Set(visible.map((r) => r.id)))
                }
              >
                <Icon name={allVisibleSelected ? 'CheckCircle2' : 'Circle'} size={16} />
              </button>
            )}
            <span>Customer</span>
            <span>Tracking</span>
            <span>Status</span>
            <span className="trk-h-right">Package</span>
            <span />
          </div>

          {visible.map((row) => (
            <ShipmentRow
              key={row.id}
              row={row}
              canManage={canManage}
              busy={busyId === row.id}
              selected={selected.has(row.id)}
              onSelect={() => toggleSelected(row.id)}
              onStatus={(c) => setStatus(row, c)}
              onNote={() => setNoteRow(row)}
              onHold={() => (row.onHold ? setHold(row, false, null) : setHoldRow(row))}
            />
          ))}
        </div>
      )}

      {bulkOpen && (
        <BulkStatusModal
          rows={rows}
          onClose={() => setBulkOpen(false)}
          onDone={async (result) => {
            setRows(result.rows)
            await onChangedRef.current()
          }}
        />
      )}

      {noteRow && (
        <NoteModal
          key={`note:${noteRow.id}`}
          row={noteRow}
          busy={busyId === noteRow.id}
          onClose={() => setNoteRow(null)}
          onSave={(notes) => saveNotes(noteRow, notes)}
        />
      )}

      {holdRow && (
        <HoldModal
          key={`hold:${holdRow.id}`}
          row={holdRow}
          busy={busyId === holdRow.id}
          onClose={() => setHoldRow(null)}
          onHold={(reason) => setHold(holdRow, true, reason)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// One shipment
// ---------------------------------------------------------------------------

function ShipmentRow({
  row,
  canManage,
  busy,
  selected,
  onSelect,
  onStatus,
  onNote,
  onHold
}: {
  row: ShipShipmentRow
  canManage: boolean
  busy: boolean
  selected: boolean
  onSelect: () => void
  onStatus: (code: ShipStatusCode) => void
  onNote: () => void
  onHold: () => void
}): JSX.Element {
  const code = row.manualStatus.code

  return (
    <div
      className={`trk-row ${busy ? 'busy' : ''} ${selected ? 'selected' : ''}`}
      data-code={code}
      data-hold={row.onHold ? 'true' : undefined}
    >
      {canManage && (
        <button className="trk-sel" title="Select" onClick={onSelect}>
          <Icon name={selected ? 'CheckCircle2' : 'Circle'} size={16} />
        </button>
      )}

      <div className="trk-cust">
        <span className="trk-handle">@{row.customer.handle}</span>
        <span className="trk-name">{row.customer.realName || '—'}</span>
        <span className="trk-addr" title={row.customer.address}>
          {row.customer.address || 'No address on the slip'}
        </span>
        <span className="trk-chips">
          {row.customer.isNew && <span className="ship-chip info mini">NEW</span>}
          {row.onHold && (
            <span className="ship-chip warn mini" title={row.heldReason ?? undefined}>
              <Icon name="PauseCircle" size={11} /> Hold
              {row.heldReason ? ` — ${row.heldReason}` : ''}
            </span>
          )}
          {row.specialRequest && (
            <span className="ship-chip danger mini" title={row.specialRequest.text}>
              <Icon name="Megaphone" size={11} /> Special
            </span>
          )}
        </span>
      </div>

      <div className="trk-track">
        {row.trackingNumber ? (
          <button
            className="trk-num"
            title={row.uspsUrl ?? 'Open USPS tracking'}
            onClick={() => api.shipping.openTracking(row.trackingNumber as string)}
          >
            <Icon name="Truck" size={13} />
            <span className="mono">{row.trackingNumber}</span>
            <Icon name="ExternalLink" size={12} />
          </button>
        ) : (
          <span className="trk-num empty">
            <Icon name="Truck" size={13} /> No tracking on the slip
          </span>
        )}
        <span className="trk-service">
          {[row.carrier, row.serviceType].filter(Boolean).join(' · ') || '—'}
          {row.weightOz != null && (
            <>
              {' '}
              <span className="trk-weight">
                <Icon name="Scale" size={11} /> {row.weightOz} oz
              </span>
            </>
          )}
        </span>
      </div>

      <div className="trk-status">
        <Select
          className="trk-status-select"
          data-code={code}
          value={code}
          disabled={!canManage || busy}
          onChange={(e) => onStatus(e.target.value as ShipStatusCode)}
        >
          {SHIP_STATUS_CODES.map((c) => (
            <option key={c} value={c}>
              {SHIP_STATUS_LABELS[c]}
            </option>
          ))}
        </Select>
        <span className="trk-status-meta">
          <Icon name={STATUS_ICONS[code]} size={11} />
          {row.manualStatus.setAt
            ? `${row.manualStatus.setBy ? `${row.manualStatus.setBy} · ` : ''}${formatDateTime(
                row.manualStatus.setAt
              )}`
            : 'Never set'}
        </span>
      </div>

      <div className="trk-pkg">
        <span className={`ship-chip mini`} data-stage={row.stage} title="Fulfillment stage">
          {SHIP_STAGE_LABELS[row.stage]}
        </span>
        <span className="trk-cards mono">
          <Icon name="SquareStack" size={11} /> {row.cardCount}
        </span>
        <span className="trk-value mono">{formatMoney(row.value)}</span>
      </div>

      <div className="trk-actions">
        <button
          className={`sor-act ${row.onHold ? 'on' : ''}`}
          title={row.onHold ? 'Release the hold' : 'Put this package on hold'}
          disabled={!canManage || busy}
          onClick={onHold}
        >
          <Icon name="PauseCircle" size={15} />
        </button>
        <button
          className={`sor-act ${row.notes ? 'on' : ''}`}
          title={row.notes ?? 'Add a note'}
          disabled={!canManage || busy}
          onClick={onNote}
        >
          <Icon name="StickyNote" size={15} />
        </button>
      </div>

      {row.notes && (
        <div className="trk-note">
          <Icon name="StickyNote" size={13} />
          {row.notes}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Note + hold editors
// ---------------------------------------------------------------------------

function NoteModal({
  row,
  busy,
  onClose,
  onSave
}: {
  row: ShipShipmentRow
  busy: boolean
  onClose: () => void
  onSave: (notes: string) => void
}): JSX.Element {
  const [value, setValue] = useState(row.notes ?? '')
  return (
    <Modal
      title="Shipping note"
      subtitle={`@${row.customer.handle} — an internal note on this package.`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="Check" loading={busy} onClick={() => onSave(value)}>
            Save note
          </Button>
        </>
      }
    >
      <Field label="Note">
        <Textarea
          autoFocus
          rows={4}
          value={value}
          placeholder="Reshipped after a bad label, buyer asked to hold until Friday…"
          onChange={(e) => setValue(e.target.value)}
        />
      </Field>
    </Modal>
  )
}

function HoldModal({
  row,
  busy,
  onClose,
  onHold
}: {
  row: ShipShipmentRow
  busy: boolean
  onClose: () => void
  onHold: (reason: string | null) => void
}): JSX.Element {
  const [reason, setReason] = useState(row.heldReason ?? '')
  return (
    <Modal
      title="Hold this package"
      subtitle={`@${row.customer.handle} sinks to the bottom of the queue until released.`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            icon="PauseCircle"
            loading={busy}
            onClick={() => onHold(reason.trim() || null)}
          >
            Hold package
          </Button>
        </>
      }
    >
      <Field label="Reason (optional)">
        <Input
          autoFocus
          value={reason}
          placeholder="Waiting on a replacement card"
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Bulk status paste — the section 6 precedence path
// ---------------------------------------------------------------------------

function BulkStatusModal({
  rows,
  onClose,
  onDone
}: {
  rows: ShipShipmentRow[]
  onClose: () => void
  onDone: (result: { rows: ShipShipmentRow[] }) => Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [text, setText] = useState('')
  const [writer, setWriter] = useState('auto')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{
    updated: number
    skipped: number
    unmatched: string[]
  } | null>(null)

  const known = useMemo(() => {
    const set = new Set<string>()
    for (const r of rows) if (r.trackingNumber) set.add(r.trackingNumber.trim())
    return set
  }, [rows])

  const parsed = useMemo(
    () => text.split(/\r?\n/).map(parseBulkLine).filter((p) => p.raw.length > 0),
    [text]
  )
  const usable = parsed.filter((p) => p.trackingNumber && p.code)
  const unreadable = parsed.filter((p) => !p.trackingNumber || !p.code)
  const unknown = usable.filter((p) => !known.has(p.trackingNumber as string))

  const apply = useCallback(async () => {
    const entries: ShipBulkStatusEntry[] = usable.map((p) => ({
      trackingNumber: p.trackingNumber as string,
      code: p.code as ShipStatusCode
    }))
    if (entries.length === 0) {
      toast.error('Nothing readable in that paste.')
      return
    }
    setBusy(true)
    try {
      // An empty writer means "me" — the IPC layer stamps the signed-in user,
      // which makes this a HUMAN write under section 6 (so it will not overwrite
      // another human's value). A named AUTO_SETTER makes it a machine scan.
      const res = await api.shipping.bulkSetStatus(entries, writer || undefined)
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Could not apply the statuses.')
        return
      }
      setResult({
        updated: res.data.updated,
        skipped: res.data.skipped,
        unmatched: res.data.unmatched
      })
      await onDone({ rows: res.data.rows })
    } finally {
      setBusy(false)
    }
  }, [onDone, toast, usable, writer])

  return (
    <Modal
      wide
      title="Bulk tracking update"
      subtitle="Paste a carrier or 17TRACK export — one tracking number and its status per line."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{result ? 'Done' : 'Cancel'}</Button>
          <Button
            variant="primary"
            icon="ClipboardCheck"
            loading={busy}
            disabled={usable.length === 0}
            onClick={apply}
          >
            Apply {usable.length > 0 ? `${usable.length} update${usable.length === 1 ? '' : 's'}` : ''}
          </Button>
        </>
      }
    >
      <div className="trk-bulk">
        <Field
          label="Attribute this write to"
          hint="A machine scan may only move a package forward and never overwrites a status a person chose. Choose “Me” only if you are correcting values by hand."
        >
          <Select value={writer} onChange={(e) => setWriter(e.target.value)}>
            {BULK_WRITERS.map((w) => (
              <option key={w.value || 'human'} value={w.value}>
                {w.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Paste">
          <Textarea
            autoFocus
            rows={8}
            className="textarea mono"
            value={text}
            placeholder={
              '9400111899223... Delivered, In Mailbox\n9400111899224... Out for Delivery\n9400111899225... In Transit to Next Facility'
            }
            onChange={(e) => setText(e.target.value)}
          />
        </Field>

        {parsed.length > 0 && (
          <div className="trk-bulk-preview">
            <div className="trk-bulk-stats">
              <span className="ship-chip ok">
                <Icon name="Check" size={11} /> {usable.length} readable
              </span>
              {unknown.length > 0 && (
                <span className="ship-chip warn">
                  <Icon name="AlertTriangle" size={11} /> {unknown.length} not in this dataset
                </span>
              )}
              {unreadable.length > 0 && (
                <span className="ship-chip danger">
                  <Icon name="X" size={11} /> {unreadable.length} unreadable
                </span>
              )}
            </div>
            <div className="trk-bulk-lines">
              {parsed.slice(0, 40).map((p, i) => (
                <div
                  className={`trk-bulk-line ${
                    !p.trackingNumber || !p.code
                      ? 'bad'
                      : known.has(p.trackingNumber)
                        ? 'ok'
                        : 'warn'
                  }`}
                  key={`${p.raw}:${i}`}
                >
                  <span className="mono">{p.trackingNumber ?? '—'}</span>
                  <span>{p.code ? SHIP_STATUS_LABELS[p.code] : 'Could not read a status'}</span>
                  <span className="trk-bulk-raw">{p.raw}</span>
                </div>
              ))}
              {parsed.length > 40 && <span className="ship-more">+{parsed.length - 40} more lines</span>}
            </div>
          </div>
        )}

        {result && (
          <div className="trk-bulk-result">
            <p>
              <b className="mono">{result.updated}</b> updated ·{' '}
              <b className="mono">{result.skipped}</b> skipped ·{' '}
              <b className="mono">{result.unmatched.length}</b> unmatched
            </p>
            {result.skipped > 0 && (
              <p className="muted text-sm">
                Skipped rows already carried a status a person set, and this write was not a forward
                move — that protection is the point of the rule.
              </p>
            )}
            {result.unmatched.length > 0 && (
              <p className="muted text-sm">
                No package here carries {result.unmatched.slice(0, 4).join(', ')}
                {result.unmatched.length > 4 ? ` +${result.unmatched.length - 4} more` : ''}.
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
