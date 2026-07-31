import { useCallback, useEffect, useState } from 'react'
import type { IntakeLink, IntakeSubmission, SyncReject, SyncStatus } from '@shared/sync'
import { api } from '../../lib/api'
import { Button, CenterLoader, EmptyState, Field, Input, Textarea } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { formatDateTime } from '../../lib/format'

/**
 * Cloud sync + the public intake form.
 *
 * The screen's job is to answer one question honestly at a glance: is what I am
 * looking at current? Everything else — the address, the key, the seeding — is
 * done once and then never touched, so it lives below the fold.
 *
 * The shared key is write-only. It is typed here, sent once, and never read
 * back; "saved" is shown by its last four characters, which is enough to tell
 * two keys apart and useless to anyone reading over a shoulder.
 */
export function CloudSyncTab(): JSX.Element {
  const toast = useToast()
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [url, setUrl] = useState('')
  const [device, setDevice] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [rejects, setRejects] = useState<SyncReject[]>([])
  const [links, setLinks] = useState<IntakeLink[]>([])
  const [submissions, setSubmissions] = useState<IntakeSubmission[]>([])
  const [newLabel, setNewLabel] = useState('')
  const [newEvent, setNewEvent] = useState('')
  const [newDate, setNewDate] = useState('')
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [rejectNote, setRejectNote] = useState('')
  const [showSetup, setShowSetup] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const [s, r, l, subs] = await Promise.all([
      api.sync.status(),
      api.sync.rejects(),
      api.intake.links(),
      api.intake.submissions()
    ])
    setStatus(s)
    setRejects(r)
    setLinks(l)
    setSubmissions(subs)
    setUrl(s.config.url)
    setDevice(s.config.device)
  }, [])

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        await load()
      } finally {
        if (active) setLoading(false)
      }
    })()
    // The loop pushes its own state; without this the screen would be the one
    // place in the app that shows a stale answer to "are we connected".
    const off = api.sync.onStatus((next) => {
      if (active) setStatus(next)
    })
    return () => {
      active = false
      off()
    }
  }, [load])

  if (loading) return <CenterLoader />
  if (!status) {
    return (
      <EmptyState icon="ShieldCheck" title="Only an admin can manage cloud sync." />
    )
  }

  const configured = status.config.url.length > 0 && status.config.keySet
  const run = async (
    label: string,
    fn: () => Promise<{ ok: boolean; error?: string }>,
    okMessage: string
  ): Promise<void> => {
    setBusy(label)
    try {
      const result = await fn()
      if (!result.ok) toast.error(result.error ?? 'That did not work.')
      else toast.success(okMessage)
      await load()
    } finally {
      setBusy(null)
    }
  }

  const state = ((): { tone: string; title: string; detail: string } => {
    if (!status.config.enabled) {
      return {
        tone: 'off',
        title: 'Sync is off',
        detail: 'This computer is working on its own copy. Nothing is shared.'
      }
    }
    if (!configured) {
      return {
        tone: 'warn',
        title: 'Not set up yet',
        detail: 'Add the relay address and the shared key below.'
      }
    }
    if (status.phase === 'error') {
      return {
        tone: 'error',
        title: 'Cannot reach the relay',
        detail:
          (status.lastError ?? 'Unknown error.') +
          ' Work carries on here and goes up when the connection returns.'
      }
    }
    return {
      tone: 'ok',
      title: 'Sharing with everyone else',
      detail: status.lastPullAt
        ? `Last checked ${formatDateTime(status.lastPullAt)}, every ${status.config.intervalSeconds} seconds.`
        : 'Waiting for the first round.'
    }
  })()

  return (
    <div className="sync-page">
      {/* ---- Is what I am looking at current? ---- */}
      <div className="sync-state" data-tone={state.tone}>
        <span className="sync-dot" />
        <div className="sync-state-main">
          <div className="sync-state-title">{state.title}</div>
          <div className="sync-state-sub">{state.detail}</div>
        </div>
        <div className="sync-state-actions">
          <Button
            variant={status.config.enabled ? 'secondary' : 'primary'}
            icon={status.config.enabled ? 'PauseCircle' : 'PlayCircle'}
            loading={busy === 'toggle'}
            onClick={() =>
              run(
                'toggle',
                () => api.sync.configure({ enabled: !status.config.enabled }),
                status.config.enabled ? 'Sync paused.' : 'Sync on.'
              )
            }
          >
            {status.config.enabled ? 'Pause' : 'Turn on'}
          </Button>
          <Button
            icon="RefreshCw"
            loading={busy === 'now'}
            disabled={!configured}
            onClick={() => run('now', () => api.sync.now(), 'Synced.')}
          >
            Sync now
          </Button>
        </div>
      </div>

      <div className="sync-metrics">
        <Metric
          label="Waiting to go up"
          value={status.pending.toLocaleString()}
          tone={status.pending > 0 ? 'busy' : undefined}
        />
        <Metric label="Rows received" value={status.cursor.toLocaleString()} />
        <Metric
          label="Needs a look"
          value={status.rejects}
          tone={status.rejects > 0 ? 'warn' : undefined}
        />
        <Metric label="This computer" value={status.config.device} />
      </div>

      {/* ---- Rows the relay sent that this database refused ---- */}
      {rejects.length > 0 && (
        <section className="sync-card sync-card-warn">
          <header>
            <Icon name="AlertTriangle" size={17} />
            <h3>{rejects.length} records could not be applied</h3>
          </header>
          <p className="sync-note">
            These arrived from another computer and this one would not accept them. Usually it
            means two people created the same thing separately. Nothing is lost — the records are
            still on the other computer.
          </p>
          <ul className="sync-reject-list">
            {rejects.slice(0, 8).map((r) => (
              <li key={`${r.kind}:${r.id}`}>
                <code>{r.kind}</code>
                <span>{r.reason}</span>
                <time>{formatDateTime(r.at)}</time>
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            loading={busy === 'clear'}
            onClick={() => run('clear', () => api.sync.clearRejects(), 'Cleared.')}
          >
            Clear the list
          </Button>
        </section>
      )}

      {/* ---- The public form ---- */}
      <section className="sync-card">
        <header>
          <Icon name="Link" size={17} />
          <h3>Customer form links</h3>
        </header>
        <p className="sync-note">
          One link per event. Send it to customers to collect their shipping details. Anyone with
          the link can fill it in, so what they send waits here for you to accept — nothing changes
          a real customer record until you do.
        </p>

        <div className="sync-link-form">
          <Field label="Name it (for you)">
            <Input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Friday break"
            />
          </Field>
          <Field label="Event shown to customers">
            <Input
              value={newEvent}
              onChange={(e) => setNewEvent(e.target.value)}
              placeholder="Friday Night Rip"
            />
          </Field>
          <Field label="Date">
            <Input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
          </Field>
          <Button
            variant="primary"
            icon="Plus"
            loading={busy === 'link'}
            disabled={!newLabel.trim() && !newEvent.trim()}
            onClick={() =>
              run(
                'link',
                async () => {
                  const result = await api.intake.createLink({
                    label: newLabel,
                    eventName: newEvent,
                    eventDate: newDate || null
                  })
                  if (result.ok) {
                    setNewLabel('')
                    setNewEvent('')
                    setNewDate('')
                  }
                  return result
                },
                'Link created. It goes live on the next sync.'
              )
            }
          >
            Create link
          </Button>
        </div>

        {links.length === 0 ? (
          <p className="sync-note">No links yet.</p>
        ) : (
          <ul className="sync-link-list">
            {links.map((link) => (
              <li key={link.id} data-active={link.active ? 'true' : 'false'}>
                <div className="sync-link-main">
                  <strong>{link.label || link.eventName || 'Untitled'}</strong>
                  <code>{link.url || 'Set the relay address to see the link'}</code>
                </div>
                <span className="sync-link-count">
                  {link.submissions} sent
                  {link.newSubmissions > 0 && <em> · {link.newSubmissions} new</em>}
                </span>
                <Button
                  size="sm"
                  icon="Copy"
                  disabled={!link.url}
                  onClick={() => {
                    void navigator.clipboard.writeText(link.url)
                    toast.success('Link copied.')
                  }}
                >
                  Copy
                </Button>
                <Button
                  size="sm"
                  variant={link.active ? 'ghost' : 'secondary'}
                  loading={busy === `link:${link.id}`}
                  onClick={() =>
                    run(
                      `link:${link.id}`,
                      () => api.intake.setLinkActive(link.id, !link.active),
                      link.active ? 'Link closed.' : 'Link reopened.'
                    )
                  }
                >
                  {link.active ? 'Close' : 'Reopen'}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---- What customers sent ---- */}
      <section className="sync-card">
        <header>
          <Icon name="Inbox" size={17} />
          <h3>What customers sent</h3>
        </header>
        {submissions.length === 0 ? (
          <p className="sync-note">Nothing yet.</p>
        ) : (
          <ul className="sync-sub-list">
            {submissions.map((s) => (
              <li key={s.id} data-status={s.status}>
                <div className="sync-sub-who">
                  <strong>{s.handle || '(no handle)'}</strong>
                  <span>{s.realName}</span>
                  <time>{formatDateTime(s.createdAt)}</time>
                </div>
                <div className="sync-sub-body">
                  <div className="sync-sub-address">
                    {[s.address1, s.address2, [s.city, s.state].filter(Boolean).join(', '), s.postalCode]
                      .filter(Boolean)
                      .join(' · ') || 'No address given'}
                  </div>
                  {s.request && <div className="sync-sub-request">“{s.request}”</div>}
                  {(s.email || s.phone) && (
                    <div className="sync-sub-contact">{[s.email, s.phone].filter(Boolean).join(' · ')}</div>
                  )}
                </div>
                {s.status === 'new' ? (
                  rejectingId === s.id ? (
                    <div className="sync-sub-reject">
                      <Textarea
                        value={rejectNote}
                        onChange={(e) => setRejectNote(e.target.value)}
                        placeholder="Why? (optional, kept with the record)"
                        rows={2}
                      />
                      <Button
                        size="sm"
                        variant="danger"
                        loading={busy === `reject:${s.id}`}
                        onClick={() =>
                          run(
                            `reject:${s.id}`,
                            async () => {
                              const r = await api.intake.reject(s.id, rejectNote)
                              if (r.ok) {
                                setRejectingId(null)
                                setRejectNote('')
                              }
                              return r
                            },
                            'Rejected.'
                          )
                        }
                      >
                        Confirm
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRejectingId(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <div className="sync-sub-actions">
                      <Button
                        size="sm"
                        variant="primary"
                        icon="Check"
                        loading={busy === `accept:${s.id}`}
                        onClick={() =>
                          run(`accept:${s.id}`, () => api.intake.accept(s.id), 'Added to customers.')
                        }
                      >
                        Accept
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRejectingId(s.id)}>
                        Reject
                      </Button>
                    </div>
                  )
                ) : (
                  <span className="sync-sub-done">
                    {s.status === 'accepted' ? 'Added as ' + s.customerId : 'Rejected'}
                    {s.statusNote ? ` — ${s.statusNote}` : ''}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---- Set up once, then forget ---- */}
      <section className="sync-card">
        <header>
          <Icon name="Settings" size={17} />
          <h3>Connection</h3>
          <button className="link-btn" onClick={() => setShowSetup((v) => !v)}>
            {showSetup ? 'Hide' : 'Show'}
          </button>
        </header>
        {showSetup && (
          <>
            <div className="sync-setup">
              <Field
                label="Relay address"
                hint="The Worker's URL from the Cloudflare dashboard."
              >
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://rm-operations.your-name.workers.dev"
                  spellCheck={false}
                />
              </Field>
              <Field
                label="Shared key"
                hint={
                  status.config.keySet
                    ? `A key is saved (ends ${status.config.keyHint}). Type a new one to replace it.`
                    : 'The same key on every computer. Set it as a secret on the Worker.'
                }
              >
                <Input
                  type="password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder={status.config.keySet ? '••••••••' : ''}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Field label="Name for this computer" hint="Shown in the change log.">
                <Input value={device} onChange={(e) => setDevice(e.target.value)} />
              </Field>
            </div>
            <div className="sync-setup-actions">
              <Button
                variant="primary"
                loading={busy === 'save'}
                onClick={() =>
                  run(
                    'save',
                    async () => {
                      const result = await api.sync.configure({
                        url,
                        device,
                        ...(key ? { key } : {})
                      })
                      if (result.ok) setKey('')
                      return result
                    },
                    'Saved.'
                  )
                }
              >
                Save
              </Button>
              <Button
                loading={busy === 'test'}
                onClick={() =>
                  run(
                    'test',
                    async () => {
                      const result = await api.sync.test()
                      if (result.ok) {
                        toast.success(`Reached the relay — ${result.data?.rows ?? 0} records there.`)
                      }
                      return result
                    },
                    ''
                  )
                }
              >
                Test connection
              </Button>
            </div>

            <div className="sync-seed">
              <div>
                <strong>Publish everything on this computer</strong>
                <p className="sync-note">
                  Run this once, on the computer that holds the real data, right after you connect
                  it. It queues the whole database so everyone else receives it. On any other
                  computer you do not need this — it pulls what is already there.
                </p>
              </div>
              <Button
                icon="UploadCloud"
                loading={busy === 'seed'}
                disabled={!configured}
                onClick={() =>
                  run(
                    'seed',
                    async () => {
                      const result = await api.sync.seed()
                      if (result.ok) {
                        toast.success(`${result.data?.queued ?? 0} records queued to go up.`)
                      }
                      return result
                    },
                    ''
                  )
                }
              >
                Publish everything
              </Button>
            </div>
          </>
        )}
      </section>
    </div>
  )
}

function Metric({
  label,
  value,
  tone
}: {
  label: string
  value: number | string
  tone?: 'warn' | 'busy'
}): JSX.Element {
  return (
    <div className="sync-metric" data-tone={tone ?? 'plain'}>
      <span className="sync-metric-value">{value}</span>
      <span className="sync-metric-label">{label}</span>
    </div>
  )
}
