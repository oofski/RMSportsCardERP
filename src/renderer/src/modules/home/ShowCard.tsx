import { useCallback, useEffect, useState } from 'react'
import type { ShipDocument } from '@shared/shippingTypes'
import type { ShipWorkspaceSummary } from '@shared/shippingViews'
import { api } from '../../lib/api'
import { useChrome } from '../../lib/chrome'
import { useSession } from '../../lib/session'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { Button, Input } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'

/**
 * Tonight's show, on the front page.
 *
 * Whoever runs the floor opens the app on Home, and the first question they have
 * is whether the night is loaded and what day it belongs to. That answer lived
 * three clicks inside Shipping › Setup, which meant the date got set once at
 * import — if at all — and nobody looked at it again. A show with the wrong day
 * on it lands on the wrong day in the calendar and in every export off the back
 * of it.
 *
 * So the date is editable right here, by whoever runs the show, without opening
 * the module. Everything else on the card is read-only: what is loaded, how big
 * it is, and whether the slip came with it.
 */
export function ShowCard(): JSX.Element | null {
  const { can } = useSession()
  const { navigate } = useChrome()
  const toast = useToast()

  const [summary, setSummary] = useState<ShipWorkspaceSummary | null>(null)
  const [doc, setDoc] = useState<ShipDocument | null>(null)
  const [date, setDate] = useState('')
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)

  const canSee = can('module.fulfillment')
  const canManage = can('shipping.manage')

  const load = useCallback(async () => {
    if (!canSee) return
    const [next, document] = await Promise.all([api.shipping.summary(), api.shipping.document()])
    setSummary(next)
    setDoc(document)
    // Never clobber a date somebody is part-way through typing.
    setDate((current) => (current === '' ? (next?.event.date ?? '') : current))
  }, [canSee])

  useLiveRefresh(LIVE.shipping, load)

  useEffect(() => {
    void load()
  }, [load])

  if (!canSee) return null

  const counts = summary?.counts
  const hasDataset = !!summary?.hasDataset
  const eventDate = summary?.event.date ?? ''
  const eventName = summary?.event.name ?? ''

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const res = await api.shipping.setEvent(eventName, date.trim())
      if (!res.ok) {
        toast.error(res.error ?? 'Could not set the show day.')
        return
      }
      toast.success(date.trim() ? `Show assigned to ${date.trim()}.` : 'Show day cleared.')
      setEditing(false)
      await load()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="panel-card show-card">
      <div className="panel-head">
        <h3>Tonight&apos;s show</h3>
        {hasDataset && canManage && !editing && (
          <button className="show-edit" onClick={() => setEditing(true)}>
            <Icon name="CalendarDays" size={13} />
            {eventDate ? 'Change the day' : 'Assign a day'}
          </button>
        )}
      </div>

      {!hasDataset ? (
        <div className="show-empty">
          <Icon name="UploadCloud" size={22} />
          <p>
            Nothing is loaded. Import the night&apos;s packing slips and every break, package and
            card shows up for the floor.
          </p>
          {/* The import lives in Admin now — the shipping module is what the
              bench needs, and loading a night is the lead's job. Sending this
              button at the workspace would land on the bench with no way to
              load anything. */}
          {canManage && (
            <Button variant="primary" icon="UploadCloud" onClick={() => navigate('admin')}>
              Import packing slips
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="show-title">
            <span className="show-name">{eventName || 'Unnamed show'}</span>
            {editing ? (
              <div className="show-datefield">
                <Input
                  type="date"
                  value={date}
                  autoFocus
                  onChange={(e) => setDate(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void save()
                    if (e.key === 'Escape') {
                      setEditing(false)
                      setDate(eventDate)
                    }
                  }}
                />
                <Button size="sm" variant="primary" loading={saving} onClick={() => void save()}>
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditing(false)
                    setDate(eventDate)
                  }}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <span className={`show-day ${eventDate ? '' : 'unset'}`}>
                <Icon name="CalendarDays" size={13} />
                {eventDate || 'No day assigned'}
              </span>
            )}
          </div>

          <div className="show-stats">
            <ShowStat value={counts?.breaks ?? 0} label="breaks" />
            <ShowStat value={counts?.shipments ?? 0} label="packages" />
            <ShowStat
              value={Math.max(0, (counts?.teamSlots ?? 0) - (counts?.checkedSlots ?? 0))}
              label="cards to find"
            />
          </div>

          <div className="show-foot">
            <span className={`show-slip ${doc ? 'have' : 'missing'}`}>
              <Icon name={doc ? 'FileCheck' : 'FileX'} size={13} />
              {doc
                ? `Slip attached · ${doc.pageCount} pages`
                : 'No slip on this machine — re-import it in Admin › Shipping setup to work against the paper'}
            </span>
            <Button size="sm" icon="ArrowRight" onClick={() => navigate('fulfillment')}>
              Open shipping
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

function ShowStat({ value, label }: { value: number; label: string }): JSX.Element {
  return (
    <div className="show-stat">
      <span className="show-stat-v">{value.toLocaleString()}</span>
      <span className="show-stat-l">{label}</span>
    </div>
  )
}
