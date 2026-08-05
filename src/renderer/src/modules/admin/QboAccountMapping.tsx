import { useCallback, useEffect, useMemo, useState } from 'react'
import type { QboAccount, QboAccountMap, QboMapSlot } from '@shared/quickbooks'
import { QBO_FLOWS, QBO_MAP_SLOTS, flowReady, missingSlots } from '@shared/quickbooks'
import { api } from '../../lib/api'
import { Button, Field, Select } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'

/**
 * Choosing which QuickBooks account each kind of money lands in.
 *
 * Everything this screen does is read-only against QuickBooks — it lists the
 * chart of accounts and stores the operator's choices locally. Nothing here
 * posts anything, which is why it is safe to run against live books before the
 * sync itself is trusted.
 *
 * Readiness is reported PER FLOW rather than as one switch, because the flows
 * are genuinely independent: inventory purchase orders can start syncing while
 * the revenue side is still being argued about.
 */
export function QboAccountMapping({ connected }: { connected: boolean }): JSX.Element | null {
  const toast = useToast()
  const [accounts, setAccounts] = useState<QboAccount[] | null>(null)
  const [map, setMap] = useState<QboAccountMap>({})
  const [saved, setSaved] = useState<QboAccountMap>({})
  const [suggested, setSuggested] = useState<QboAccountMap>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // The stored mapping first: it is local and always available, so the form
      // can show the operator's real choices even if QuickBooks is unreachable.
      const current = await api.quickbooks.getMapping()
      if (current.ok && current.data) {
        setMap(current.data.map)
        setSaved(current.data.map)
      }
      const res = await api.quickbooks.accounts()
      if (!res.ok || !res.data) {
        setError(res.error ?? 'Could not read the chart of accounts.')
        return
      }
      setAccounts(res.data.accounts)
      setSuggested(res.data.suggested)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (connected) void load()
  }, [connected, load])

  const dirty = useMemo(
    () => QBO_MAP_SLOTS.some((s) => (map[s.key] ?? '') !== (saved[s.key] ?? '')),
    [map, saved]
  )

  if (!connected) return null

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const res = await api.quickbooks.saveMapping(map)
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Could not save the mapping.')
        return
      }
      setMap(res.data.map)
      setSaved(res.data.map)
      toast.success('Account mapping saved.')
    } finally {
      setSaving(false)
    }
  }

  const applySuggestions = (): void => {
    // Merge rather than replace: a slot the operator already chose is theirs,
    // and a guess must never overwrite a deliberate decision.
    setMap((prev) => {
      const next = { ...prev }
      for (const slot of QBO_MAP_SLOTS) {
        if (!next[slot.key] && suggested[slot.key]) next[slot.key] = suggested[slot.key]
      }
      return next
    })
  }

  const hasSuggestion = QBO_MAP_SLOTS.some((s) => !map[s.key] && suggested[s.key])

  return (
    <div className="qbo-map">
      <div className="qbo-map-head">
        <div>
          <b>Account mapping</b>
          <p>Nothing posts until every account a flow needs is chosen.</p>
        </div>
        <div className="qbo-map-acts">
          {hasSuggestion && (
            <Button icon="Sparkles" onClick={applySuggestions} disabled={loading || saving}>
              Fill suggestions
            </Button>
          )}
          <Button icon="RefreshCw" onClick={() => void load()} loading={loading} disabled={saving}>
            Reload accounts
          </Button>
        </div>
      </div>

      {error && (
        <div className="qbo-error">
          <Icon name="AlertTriangle" size={15} />
          <span>{error}</span>
        </div>
      )}

      <div className="qbo-flows">
        {QBO_FLOWS.map((flow) => {
          const ready = flowReady(saved, flow)
          const missing = missingSlots(saved, flow)
          return (
            <div key={flow.key} className="qbo-flow" data-ready={ready ? 'true' : 'false'}>
              <Icon name={ready ? 'CheckCircle2' : 'Circle'} size={15} />
              <div>
                <b>{flow.label}</b>
                <span>
                  {ready
                    ? flow.description
                    : `Needs ${missing
                        .map((k) => QBO_MAP_SLOTS.find((s) => s.key === k)?.label ?? k)
                        .join(' and ')}`}
                </span>
              </div>
            </div>
          )
        })}
      </div>

      <div className="qbo-map-grid">
        {QBO_MAP_SLOTS.map((slot) => (
          <SlotField
            key={slot.key}
            slot={slot}
            accounts={accounts}
            value={map[slot.key] ?? ''}
            onChange={(id) =>
              setMap((prev) => {
                const next = { ...prev }
                if (id) next[slot.key] = id
                else delete next[slot.key]
                return next
              })
            }
          />
        ))}
      </div>

      <div className="qbo-map-save">
        <Button
          variant="primary"
          icon="Save"
          loading={saving}
          disabled={!dirty || saving || loading}
          onClick={() => void save()}
        >
          Save mapping
        </Button>
        {dirty && <span className="qbo-map-dirty">Unsaved changes</span>}
      </div>
    </div>
  )
}

/**
 * One account picker. The list is filtered to the account types that make sense
 * for the slot — QuickBooks will happily accept inventory posted to an income
 * account and produce books that balance while being completely wrong, so the
 * wrong answer is not offered in the first place.
 */
function SlotField({
  slot,
  accounts,
  value,
  onChange
}: {
  slot: QboMapSlot
  accounts: QboAccount[] | null
  value: string
  onChange: (id: string) => void
}): JSX.Element {
  const candidates = useMemo(
    () => (accounts ?? []).filter((a) => slot.accountTypes.includes(a.accountType)),
    [accounts, slot.accountTypes]
  )

  // A stored id whose account is not in the candidate list — renamed, made
  // inactive, or belonging to a different company. Surfaced rather than
  // silently dropped, because a blank field reads as "never set".
  const orphaned = !!value && accounts !== null && !candidates.some((a) => a.id === value)

  const none = accounts !== null && candidates.length === 0

  return (
    <Field label={slot.label} hint={none ? undefined : slot.hint}>
      <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={accounts === null}>
        <option value="">{accounts === null ? 'Loading accounts…' : '— not set —'}</option>
        {orphaned && <option value={value}>Account {value} (no longer available)</option>}
        {candidates.map((a) => (
          <option key={a.id} value={a.id}>
            {a.fullyQualifiedName}
          </option>
        ))}
      </Select>
      {none && (
        <span className="qbo-slot-warn">
          No {slot.accountTypes.join(' or ')} account in this company — create one in QuickBooks
          first.
        </span>
      )}
    </Field>
  )
}
