import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ShipBreakAudit, ShipSportOption, ShipWarning } from '@shared/shippingTypes'
import { SHIP_SPORTS, SHIP_SPORT_LABELS } from '@shared/shippingTypes'
import type { ShipParseJob } from '@shared/shippingViews'
import type { ShipTabProps } from './ShippingModule'
import { api } from '../../lib/api'
import { formatDateTime, formatMoney } from '../../lib/format'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { Button, Checkbox, Field, Input, Modal, Select } from '../../components/ui'

/**
 * Upload tab — turn a Whatnot "combined labels + packing slips" PDF into the
 * active dataset.
 *
 * The parse is a real background job in the main process (a 200-page export
 * takes 10–30s), so this screen starts it, then renders live progress from
 * `onParseProgress` and can re-attach to a running job after a remount by
 * polling `parseJob` with the id it stashed in localStorage.
 *
 * Once a dataset exists the tab becomes the workspace's data-quality screen:
 * **collisions first** (a team captured for two customers in the same break is
 * a real error and the whole reason the audit exists), then the per-break
 * fidelity audit, then the parser's warnings.
 */

const JOB_KEY = 'rmcardz.shipping.parseJobId'
const SPORT_KEY = 'rmcardz.shipping.sport'

const PHASE_LABEL: Record<ShipParseJob['phase'], string> = {
  extract: 'Extracting text',
  parse: 'Parsing slips',
  done: 'Done',
  error: 'Failed'
}

function readSport(): ShipSportOption {
  const stored = localStorage.getItem(SPORT_KEY)
  if (stored === 'auto') return 'auto'
  const hit = SHIP_SPORTS.find((s) => s === stored)
  return hit ?? 'auto'
}

/** Local calendar date as YYYY-MM-DD (not UTC — an evening break must not roll over). */
function todayIso(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function UploadTab({ summary, canManage, onChanged, onGoTo }: ShipTabProps): JSX.Element {
  const toast = useToast()

  const [sport, setSport] = useState<ShipSportOption>(readSport)
  const [importName, setImportName] = useState('')
  const [eventName, setEventName] = useState('')
  const [eventDate, setEventDate] = useState('')
  // Suppress the auto-name once the operator types their own.
  const [nameTouched, setNameTouched] = useState(false)
  const [eventTouched, setEventTouched] = useState(false)
  const [starting, setStarting] = useState(false)
  const [job, setJob] = useState<ShipParseJob | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [savingEvent, setSavingEvent] = useState(false)
  const [showAllAudit, setShowAllAudit] = useState(false)
  const [showAllWarnings, setShowAllWarnings] = useState(false)

  // The id of the job this tab is watching. A ref (not state) so the one
  // long-lived progress subscription can filter without resubscribing.
  const jobIdRef = useRef<string | null>(null)
  // Callbacks the subscription needs, held in refs so the effect stays [].
  const onChangedRef = useRef(onChanged)
  const toastRef = useRef(toast)
  onChangedRef.current = onChanged
  toastRef.current = toast

  const event = summary?.event
  const hasDataset = !!summary?.hasDataset

  // Keep the event editor in step with whatever dataset is loaded.
  useEffect(() => {
    setEventName(event?.name ?? '')
    setEventDate(event?.date ?? '')
  }, [event?.name, event?.date, event?.updatedAt])

  // Re-attach to a job that was still running when this tab last unmounted.
  useEffect(() => {
    const stored = localStorage.getItem(JOB_KEY)
    if (!stored) return
    let active = true
    api.shipping
      .parseJob(stored)
      .then((found) => {
        if (!active) return
        if (!found) {
          localStorage.removeItem(JOB_KEY)
          return
        }
        jobIdRef.current = found.id
        setJob(found)
        if (found.status !== 'running') localStorage.removeItem(JOB_KEY)
      })
      .catch(() => localStorage.removeItem(JOB_KEY))
    // Auto-name the import as "[Sport] - [Pack] - [Date]". The sport comes from the
  // League selector (or whatever the parse detected), the pack type from the
  // product title the slips carry, and the date defaults to today. Anything the
  // operator has typed themselves is never overwritten.
  const autoName = useCallback(
    (detected?: ShipSportOption | null, packHint?: string | null): string => {
      const sportPart =
        detected && detected !== 'auto'
          ? SHIP_SPORT_LABELS[detected]
          : sport !== 'auto'
            ? SHIP_SPORT_LABELS[sport]
            : ''
      const datePart = (eventDate || todayIso()).split('-').reverse().slice(0, 2).reverse().join('/')
      return [sportPart, packHint?.trim(), datePart].filter(Boolean).join(' - ')
    },
    [sport, eventDate]
  )

  // Seed the date once so the field is never empty on a fresh workspace.
  useEffect(() => {
    if (!eventDate) setEventDate(todayIso())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the suggestion in step with the League picker until it is edited.
  useEffect(() => {
    if (nameTouched) return
    const suggested = autoName()
    if (suggested) {
      setImportName(suggested)
      if (!eventTouched) setEventName(suggested)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sport, eventDate, nameTouched])

  return () => {
      active = false
    }
  }, [])

  // One subscription for the life of the tab; the main process throttles pushes.
  useEffect(() => {
    const off = api.shipping.onParseProgress((next) => {
      if (jobIdRef.current && next.id !== jobIdRef.current) return
      jobIdRef.current = next.id
      setJob(next)
      if (next.status === 'running') return
      localStorage.removeItem(JOB_KEY)
      if (next.status === 'done') {
        toastRef.current.success(
          `Imported ${next.counts?.shipments ?? 0} packages from ${next.filename}.`
        )
        void onChangedRef.current()
      } else {
        toastRef.current.error(next.error ?? 'The PDF could not be parsed.')
      }
    })
    return off
  }, [])

  const start = useCallback(async () => {
    setStarting(true)
    try {
      const res = await api.shipping.startParse({
        sport,
        eventName: eventName.trim() || null,
        eventDate: eventDate.trim() || null,
        name: importName.trim() || null
      })
      if (!res.ok || !res.data) {
        // Cancelling the file dialog is not an error worth shouting about.
        if (res.error && res.error !== 'No file selected.') toast.error(res.error)
        return
      }
      jobIdRef.current = res.data.jobId
      localStorage.setItem(JOB_KEY, res.data.jobId)
      setJob({
        id: res.data.jobId,
        status: 'running',
        filename: res.data.filename,
        phase: 'extract',
        page: 0,
        totalPages: 0,
        message: 'Reading the PDF…',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
        counts: null,
        carriedForward: false,
        event: null
      })
    } finally {
      setStarting(false)
    }
  }, [sport, eventName, eventDate, importName, toast])

  const saveEvent = useCallback(async () => {
    setSavingEvent(true)
    try {
      const res = await api.shipping.setEvent(eventName.trim(), eventDate.trim())
      if (!res.ok) {
        toast.error(res.error ?? 'Could not save the event.')
        return
      }
      toast.success('Event saved.')
      await onChanged()
    } finally {
      setSavingEvent(false)
    }
  }, [eventName, eventDate, onChanged, toast])

  const clearDataset = useCallback(async () => {
    setClearing(true)
    try {
      const res = await api.shipping.clearDataset()
      if (!res.ok) {
        toast.error(res.error ?? 'Could not clear the workspace.')
        return
      }
      setConfirmClear(false)
      setJob(null)
      jobIdRef.current = null
      localStorage.removeItem(JOB_KEY)
      toast.success('Workspace cleared.')
      await onChanged()
    } finally {
      setClearing(false)
    }
  }, [onChanged, toast])

  const audit = summary?.audit ?? []
  const warnings = summary?.warnings ?? []
  const collisionAudits = useMemo(
    () => audit.filter((a) => a.collisions.length > 0),
    [audit]
  )
  const collisionCount = collisionAudits.reduce((n, a) => n + a.collisions.length, 0)
  const incomplete = useMemo(() => audit.filter((a) => !a.hasAll), [audit])

  const running = job?.status === 'running'
  const pct =
    job && job.totalPages > 0 ? Math.min(100, Math.round((job.page / job.totalPages) * 100)) : null

  return (
    <div className="ship-page">
      {/* ---------------- Import ---------------- */}
      <div className="panel-card ship-upload-card">
        <div className="panel-head">
          <div>
            <h3>Import a Whatnot PDF</h3>
          </div>
        </div>

        <div className="ship-upload-form">
          <Field label="League">
            <Select
              value={sport}
              disabled={!canManage || running}
              onChange={(e) => {
                const next = e.target.value as ShipSportOption
                setSport(next)
                localStorage.setItem(SPORT_KEY, next)
              }}
            >
              <option value="auto">Auto-detect</option>
              {SHIP_SPORTS.map((s) => (
                <option key={s} value={s}>
                  {SHIP_SPORT_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Import name">
            <Input
              value={importName}
              placeholder="Saturday night football"
              disabled={!canManage || running}
              onChange={(e) => {
                setNameTouched(true)
                setImportName(e.target.value)
              }}
            />
          </Field>

          <Field label="Event name">
            <Input
              value={eventName}
              placeholder="Unnamed event"
              disabled={!canManage || running}
              onChange={(e) => {
                setEventTouched(true)
                setEventName(e.target.value)
              }}
            />
          </Field>

          <Field label="Event date">
            {/* A date picker silently blanks a value it cannot parse, and
                blanking the date would break same-event carry-forward — so a
                non-ISO date from the slip stays editable as plain text. */}
            <Input
              type={/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || eventDate === '' ? 'date' : 'text'}
              value={eventDate}
              disabled={!canManage || running}
              onChange={(e) => setEventDate(e.target.value)}
            />
          </Field>
        </div>

        <div className="ship-upload-actions">
          <Button
            variant="primary"
            icon="FileUp"
            loading={starting || running}
            disabled={!canManage}
            onClick={start}
          >
            {running ? 'Parsing…' : 'Choose PDF & import'}
          </Button>
          {hasDataset && canManage && (
            <>
              <Button icon="Check" loading={savingEvent} disabled={running} onClick={saveEvent}>
                Save event
              </Button>
              <span className="spacer" />
              <Button
                variant="danger"
                icon="Trash2"
                disabled={running}
                onClick={() => setConfirmClear(true)}
              >
                Clear workspace
              </Button>
            </>
          )}
          {!canManage && (
            <span className="ship-readonly">
              <Icon name="Info" size={14} /> Read-only — importing needs the Shipping manage
              permission.
            </span>
          )}
        </div>

        {/* A named event is what makes a corrected re-export keep its progress. */}
        <div className="ship-carry-note">
          <Icon name="Info" size={14} />
          <span>
            Operator progress (check-offs, holds, statuses, queue order) is only carried forward
            when you re-import <b>the same named event on the same date</b>. Everything else starts
            fresh at <b>To pick</b>.
          </span>
        </div>
      </div>

      {/* ---------------- Live job ---------------- */}
      {job && (
        <div className={`panel-card ship-job ${job.status}`}>
          <div className="ship-job-head">
            <span className={`ship-job-ico ${job.status}`}>
              <Icon
                name={
                  job.status === 'done' ? 'CheckCircle2' : job.status === 'error' ? 'AlertCircle' : 'Loader2'
                }
                size={17}
                className={running ? 'spin-ico' : undefined}
              />
            </span>
            <div className="ship-job-main">
              <div className="ship-job-title">{job.filename}</div>
              <div className="ship-job-sub">
                {job.status === 'error'
                  ? job.error ?? 'The PDF could not be parsed.'
                  : `${PHASE_LABEL[job.phase]}${
                      job.totalPages > 0 ? ` · page ${job.page} of ${job.totalPages}` : ''
                    }${job.message ? ` · ${job.message}` : ''}`}
              </div>
            </div>
            {job.status !== 'running' && (
              <button className="ts-clear ship-job-dismiss" title="Dismiss" onClick={() => setJob(null)}>
                <Icon name="X" size={14} />
              </button>
            )}
          </div>

          {running && (
            <div className="progress">
              <div className="bar" style={{ width: `${pct ?? 8}%` }} />
            </div>
          )}

          {job.status === 'done' && job.counts && (
            <>
              <div className="ship-count-grid">
                <CountTile label="Packages" value={job.counts.shipments} icon="Package" />
                <CountTile label="Customers" value={job.counts.customers} icon="Users" />
                <CountTile label="Breaks" value={job.counts.breaks} icon="Layers" />
                <CountTile label="Cards" value={job.counts.teamSlots} icon="SquareStack" />
                <CountTile label="Line items" value={job.counts.orders} icon="ListTree" />
                <CountTile label="Giveaways" value={job.counts.giveaways} icon="Gift" />
                <CountTile
                  label="Card value"
                  value={formatMoney(job.counts.cardValue)}
                  icon="DollarSign"
                />
                <CountTile
                  label="Warnings"
                  value={job.counts.warnings}
                  icon="AlertTriangle"
                  tone={job.counts.warnings > 0 ? 'warning' : undefined}
                />
              </div>
              <div className="ship-job-foot">
                <span className={`ship-chip ${job.carriedForward ? 'info' : ''}`}>
                  <Icon name={job.carriedForward ? 'Repeat' : 'Sparkles'} size={13} />
                  {job.carriedForward
                    ? 'Operator progress carried forward (same event)'
                    : 'Fresh import — every package starts at To pick'}
                </span>
                <Button size="sm" icon="ArrowRight" onClick={() => onGoTo('orders')}>
                  Go to Orders
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ---------------- Collisions: the safety net ---------------- */}
      {collisionCount > 0 && (
        <div className="ship-danger-card">
          <div className="ship-danger-head">
            <span className="ship-danger-ico">
              <Icon name="Siren" size={20} />
            </span>
            <div>
              <h3>
                {collisionCount} team {collisionCount === 1 ? 'collision' : 'collisions'} — do not
                pick until resolved
              </h3>
              <p>
                The same team was captured for two different customers in one break. That is a data
                error, not a business case: one of those pages parsed wrong. Check the printed slips
                for these breaks before anything ships.
              </p>
            </div>
          </div>
          <div className="ship-collision-list">
            {collisionAudits.map((a) =>
              a.collisions.map((c) => (
                <div className="ship-collision-row" key={`${a.breakNumber}-${c.teamName}`}>
                  <span className="ship-collision-break">Break #{a.breakNumber}</span>
                  <span className="ship-collision-team">{c.teamName}</span>
                  <span className="ship-collision-handles">
                    {c.handles.map((h) => (
                      <span className="ship-handle-chip" key={h}>
                        @{h}
                      </span>
                    ))}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* ---------------- Break audit ---------------- */}
      {audit.length > 0 && (
        <div className="panel-card">
          <div className="panel-head">
            <div>
              <h3>Break audit</h3>
              <span className="ph-sub">
                Captured teams vs the full league slate, per break.
                {incomplete.length > 0
                  ? ` ${incomplete.length} of ${audit.length} incomplete.`
                  : ' Every break is complete.'}
              </span>
            </div>
            <div className="ph-right">
              <Checkbox
                checked={showAllAudit}
                onChange={setShowAllAudit}
                label="Show complete breaks"
              />
            </div>
          </div>
          <div className="ship-audit-list">
            {(showAllAudit ? audit : incomplete).map((a) => (
              <AuditRow key={a.breakNumber} audit={a} />
            ))}
            {!showAllAudit && incomplete.length === 0 && (
              <div className="ship-audit-clean">
                <Icon name="CheckCircle2" size={16} />
                All {audit.length} breaks captured a full slate.
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---------------- Parser warnings ---------------- */}
      {warnings.length > 0 && (
        <div className="panel-card">
          <div className="panel-head">
            <div>
              <h3>Parser warnings</h3>
              <span className="ph-sub">
                {warnings.length} line{warnings.length === 1 ? '' : 's'} the grammar could not fully
                resolve. Cards are still imported — the raw text is kept so you can check the slip.
              </span>
            </div>
          </div>
          <div className="ship-warn-list">
            {(showAllWarnings ? warnings : warnings.slice(0, 12)).map((w) => (
              <WarningRow key={w.id} warning={w} />
            ))}
          </div>
          {warnings.length > 12 && (
            <button className="link-btn ship-more" onClick={() => setShowAllWarnings((v) => !v)}>
              {showAllWarnings ? 'Show fewer' : `Show all ${warnings.length} warnings`}
            </button>
          )}
        </div>
      )}

      {/* ---------------- Current dataset ---------------- */}
      {hasDataset && summary && (
        <div className="panel-card">
          <div className="panel-head">
            <div>
              <h3>Active dataset</h3>
              <span className="ph-sub">
                {summary.lastImport
                  ? `${summary.lastImport.name} · imported ${formatDateTime(
                      summary.lastImport.createdAt
                    )}`
                  : 'Loaded'}
              </span>
            </div>
          </div>
          <div className="ship-count-grid">
            <CountTile label="Packages" value={summary.counts.shipments} icon="Package" />
            <CountTile label="Customers" value={summary.counts.customers} icon="Users" />
            <CountTile label="Breaks" value={summary.counts.breaks} icon="Layers" />
            <CountTile
              label="Cards picked"
              value={`${summary.counts.checkedSlots}/${summary.counts.teamSlots}`}
              icon="ListChecks"
            />
            <CountTile label="Tracking" value={summary.trackingCount} icon="Truck" />
            <CountTile
              label="On hold"
              value={summary.onHoldCount}
              icon="PauseCircle"
              tone={summary.onHoldCount > 0 ? 'warning' : undefined}
            />
            <CountTile
              label="Special requests"
              value={summary.specialRequestCount}
              icon="Megaphone"
              tone={summary.specialRequestCount > 0 ? 'danger' : undefined}
            />
            <CountTile label="Value" value={formatMoney(summary.value)} icon="DollarSign" />
          </div>
        </div>
      )}

      {!hasDataset && !job && (
        <div className="ship-hero-empty">
          <span className="empty-ico">
            <Icon name="UploadCloud" size={26} />
          </span>
          <h3>No dataset loaded</h3>
          <p>
            Import a Whatnot combined labels + packing slips PDF to build the pick lists, the
            package queue and the shipping tracker.
          </p>
        </div>
      )}

      {confirmClear && (
        <Modal
          title="Clear the workspace?"
          subtitle="Every package, break, card and tracking status in the active dataset is deleted. Import history and snapshots are kept."
          onClose={() => setConfirmClear(false)}
          footer={
            <>
              <Button onClick={() => setConfirmClear(false)}>Cancel</Button>
              <Button variant="danger" icon="Trash2" loading={clearing} onClick={clearDataset}>
                Clear workspace
              </Button>
            </>
          }
        >
          <p className="muted">
            This cannot be undone. Take a snapshot first from the History tab if you need the
            numbers.
          </p>
        </Modal>
      )}
    </div>
  )
}

function CountTile({
  label,
  value,
  icon,
  tone
}: {
  label: string
  value: number | string
  icon: string
  tone?: 'warning' | 'danger'
}): JSX.Element {
  return (
    <div className={`ship-count ${tone ?? ''}`}>
      <span className="ship-count-ico">
        <Icon name={icon} size={15} />
      </span>
      <span className="ship-count-val mono">{value}</span>
      <span className="ship-count-label">{label}</span>
    </div>
  )
}

function AuditRow({ audit }: { audit: ShipBreakAudit }): JSX.Element {
  const [open, setOpen] = useState(false)
  const captured = audit.distinctTeamCount
  const pct = audit.maxTeams > 0 ? Math.round((captured / audit.maxTeams) * 100) : 0
  const hasCollisions = audit.collisions.length > 0

  return (
    <div className={`ship-audit-row ${hasCollisions ? 'danger' : audit.hasAll ? 'ok' : 'warn'}`}>
      <button className="ship-audit-head" onClick={() => setOpen((v) => !v)}>
        <span className="ship-audit-num">Break #{audit.breakNumber}</span>
        <span className="ship-audit-bar">
          <span className="ship-audit-fill" style={{ width: `${pct}%` }} />
        </span>
        <span className="ship-audit-count mono">
          {captured}/{audit.maxTeams}
        </span>
        {audit.hasAll ? (
          <span className="ship-chip ok">
            <Icon name="Check" size={12} /> Full slate
          </span>
        ) : (
          <span className="ship-chip warn">
            {audit.missingCount} missing
          </span>
        )}
        {hasCollisions && (
          <span className="ship-chip danger">
            <Icon name="Siren" size={12} /> {audit.collisions.length} collision
            {audit.collisions.length === 1 ? '' : 's'}
          </span>
        )}
        {audit.teamCount !== audit.distinctTeamCount && (
          <span className="ship-chip warn" title="The same team was captured more than once">
            {audit.teamCount - audit.distinctTeamCount} duplicate
          </span>
        )}
        <Icon name={open ? 'ChevronUp' : 'ChevronDown'} size={15} className="ship-audit-caret" />
      </button>
      {open && (
        <div className="ship-audit-body">
          {audit.collisions.length > 0 && (
            <div className="ship-audit-block danger">
              <div className="ship-audit-block-label">Collisions</div>
              <div className="ship-team-chips">
                {audit.collisions.map((c) => (
                  <span className="ship-team-chip danger" key={c.teamName}>
                    {c.teamName}
                    <em>{c.handles.map((h) => `@${h}`).join(' · ')}</em>
                  </span>
                ))}
              </div>
            </div>
          )}
          {audit.missingTeams.length > 0 ? (
            <div className="ship-audit-block">
              <div className="ship-audit-block-label">
                Missing teams ({audit.missingTeams.length})
              </div>
              <div className="ship-team-chips">
                {audit.missingTeams.map((t) => (
                  <span className="ship-team-chip" key={t}>
                    {t}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <div className="ship-audit-block">
              <div className="ship-audit-block-label">
                Every team in the slate was captured for this break.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function WarningRow({ warning }: { warning: ShipWarning }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="ship-warn">
      <button
        className="ship-warn-head"
        onClick={() => setOpen((v) => !v)}
        disabled={!warning.rawText}
      >
        <Icon name="AlertTriangle" size={14} />
        {warning.page != null && <span className="ship-warn-page mono">p{warning.page}</span>}
        <span className="ship-warn-msg">{warning.message}</span>
        {warning.rawText && (
          <Icon name={open ? 'ChevronUp' : 'ChevronDown'} size={14} className="ship-audit-caret" />
        )}
      </button>
      {open && warning.rawText && <pre className="ship-warn-raw">{warning.rawText}</pre>}
    </div>
  )
}
