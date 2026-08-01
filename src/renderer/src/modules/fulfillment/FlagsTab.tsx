import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ShipWarning } from '@shared/shippingTypes'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { Button, CenterLoader, EmptyState, Input } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { formatDateTime } from '../../lib/format'
import type { ShipTabProps } from './ShippingModule'

/**
 * Flags — everything the import noticed that a person should look at.
 *
 * The rule this screen exists to enforce: an oddity never stops the floor. A
 * slot titled "#30" instead of a team, a break with 29 teams because one did not
 * sell, a lettered break label, a name the matcher could not place — all real,
 * all recoverable, none worth refusing to let anyone pick cards. So the card is
 * always kept and always pickable, and the oddity comes here instead.
 *
 * Which only works if the list stays readable. A flag that cannot be cleared
 * turns into wallpaper: after two shows there are eighty of them, nobody reads
 * any, and the one that mattered is lost among the ones that did not. Hence
 * Handled — reversible, attributed, and out of the way.
 */
export function FlagsTab({ canFind, canPack, onChanged }: ShipTabProps): JSX.Element {
  const toast = useToast()
  const [flags, setFlags] = useState<ShipWarning[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [showHandled, setShowHandled] = useState(false)
  const [noteFor, setNoteFor] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const canAct = canFind || canPack

  const load = useCallback(async () => {
    setFlags(await api.shipping.warnings())
  }, [])

  useLiveRefresh(LIVE.shipping, load)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        await load()
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [load])

  const open = useMemo(() => flags.filter((f) => f.status !== 'handled'), [flags])
  const visible = useMemo(() => {
    const pool = showHandled ? flags : open
    const q = query.trim().toLowerCase()
    if (!q) return pool
    return pool.filter(
      (f) =>
        f.message.toLowerCase().includes(q) ||
        (f.rawText ?? '').toLowerCase().includes(q) ||
        String(f.page ?? '').includes(q)
    )
  }, [flags, open, showHandled, query])

  if (loading) return <CenterLoader />

  const setStatus = async (
    flag: ShipWarning,
    status: 'open' | 'handled',
    withNote: string | null
  ): Promise<void> => {
    setBusy(flag.id)
    try {
      const res = await api.shipping.setWarningStatus(flag.id, status, withNote)
      if (!res.ok) {
        toast.error(res.error ?? 'That did not work.')
        return
      }
      setNoteFor(null)
      setNote('')
      await load()
      await onChanged()
    } finally {
      setBusy(null)
    }
  }

  if (flags.length === 0) {
    return (
      <EmptyState
        icon="Flag"
        title="Nothing flagged"
        message="Anything the import could not read cleanly shows up here. An empty list means every card matched a team and every break added up."
      />
    )
  }

  return (
    <div className="flags-page">
      <div className="flags-bar">
        <div className="topsearch ship-search">
          <Icon name="Search" size={15} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search flags, a page number, a name…"
          />
          {query && (
            <button className="ts-clear" onClick={() => setQuery('')} title="Clear">
              <Icon name="X" size={14} />
            </button>
          )}
        </div>
        <span className="flags-count">
          {open.length} open
          {flags.length - open.length > 0 && ` · ${flags.length - open.length} handled`}
        </span>
        <Button
          size="sm"
          icon={showHandled ? 'EyeOff' : 'Eye'}
          onClick={() => setShowHandled((v) => !v)}
        >
          {showHandled ? 'Hide handled' : 'Show handled'}
        </Button>
      </div>

      <p className="flags-note">
        None of these stop anyone working. Every card is still pickable and still counted — these
        are the things worth a second look before the show closes.
      </p>

      {visible.length === 0 ? (
        <EmptyState icon="Check" title="Nothing matches" message="No flag matches that search." />
      ) : (
        <ul className="flags-list">
          {visible.map((f) => (
            <li key={f.id} data-status={f.status}>
              <div className="flags-main">
                <div className="flags-msg">{f.message}</div>
                {f.rawText && <code className="flags-raw">{f.rawText}</code>}
                <div className="flags-meta">
                  {f.page != null && <span>page {f.page}</span>}
                  {f.status === 'handled' && (
                    <span className="flags-done">
                      handled{f.handledAt ? ` ${formatDateTime(f.handledAt)}` : ''}
                      {f.note ? ` — ${f.note}` : ''}
                    </span>
                  )}
                </div>
              </div>

              {canAct &&
                (f.status === 'handled' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === f.id}
                    onClick={() => void setStatus(f, 'open', null)}
                  >
                    Reopen
                  </Button>
                ) : noteFor === f.id ? (
                  <div className="flags-noting">
                    <Input
                      autoFocus
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="What was it? (optional)"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void setStatus(f, 'handled', note)
                        if (e.key === 'Escape') setNoteFor(null)
                      }}
                    />
                    <Button
                      size="sm"
                      variant="primary"
                      loading={busy === f.id}
                      onClick={() => void setStatus(f, 'handled', note)}
                    >
                      Handled
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setNoteFor(null)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    icon="Check"
                    onClick={() => {
                      setNoteFor(f.id)
                      setNote('')
                    }}
                  >
                    Handled
                  </Button>
                ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
