import type { Employee } from '@shared/types'
import { streamHostCandidates } from '@shared/permissions'
import { Icon } from '../../components/Icon'

/**
 * WHO IS ON THE SHOW.
 *
 * The owner's two asks, together: several people on one stream, and only the
 * people who actually run shows offered.
 *
 * ## Toggles, not a multi-select
 *
 * A native multi-select needs ctrl-click to add a second name and a drag to
 * change the order, neither of which anybody discovers, and on a phone it is a
 * scrolling column of tiny rows. This is a row of names you tap. The set is
 * small — the point of the filter is that it IS small — so the whole thing fits
 * on screen and reads as what it is.
 *
 * ## The first one leads, and the screen says so
 *
 * `stream_sessions.host_id` is the first of the crew, which is what the P&L and
 * the performance page read. That is not a detail to hide: the first chip wears
 * "Host", and tapping somebody who is already on moves them to the front rather
 * than taking them off, because promoting the co-host is a thing somebody
 * actually wants and removing them by accident is not.
 *
 * Taking somebody off is the ✕ on their chip. Two gestures, two outcomes,
 * neither of them a surprise.
 *
 * ## Only Breakers and Owners, read off the PERMISSION
 *
 * See streamHostCandidates. `streaming.run` is what actually decides whether
 * somebody can put the business on air, so a stand-in granted it by hand for a
 * week is covered — testing the role name would let them start a show they
 * could not be named on.
 *
 * ANYBODY ALREADY ON THE CREW STAYS OFFERED, including somebody who has left.
 * They ran the shows they ran, and dropping them out of the picker would
 * silently rewrite the crew of an old session the first time anybody opened it
 * to fix a typo.
 */
export function CrewPicker({
  people,
  value,
  onChange,
  label = 'Who is on it'
}: {
  /** Every employee. Narrowed here rather than by the caller, so one rule. */
  people: Employee[]
  /** Employee ids, in order. The first is the host. */
  value: string[]
  onChange: (next: string[]) => void
  label?: string
}): JSX.Element | null {
  const candidates = streamHostCandidates(people, value)
  if (candidates.length === 0) return null

  const nameOf = (id: string): string => {
    const p = people.find((e) => e.id === id)
    return p ? `${p.firstName} ${p.lastName}`.trim() : 'Someone who has left'
  }

  const toggle = (id: string): void => {
    if (!value.includes(id)) {
      onChange([...value, id])
      return
    }
    // ALREADY ON: promote to the front. Removing is the ✕, which is a
    // deliberate press on a small target — tapping a name you can see is not.
    onChange([id, ...value.filter((v) => v !== id)])
  }

  const remove = (id: string): void => onChange(value.filter((v) => v !== id))

  return (
    <div className="crew-pick">
      <div className="crew-pick-label">{label}</div>

      {/* WHO IS ON, in order, with the first marked as the host. Drawn above
          the choices rather than below them so the answer is what you read
          first and the list is what you reach for. */}
      {value.length > 0 && (
        <div className="crew-on">
          {value.map((id, i) => (
            <span className={`crew-chip${i === 0 ? ' is-host' : ''}`} key={id}>
              {i === 0 && <Icon name="Mic" size={11} />}
              {nameOf(id)}
              {i === 0 && <em>host</em>}
              <button
                type="button"
                className="crew-x"
                aria-label={`Take ${nameOf(id)} off`}
                title={`Take ${nameOf(id)} off the show`}
                onClick={() => remove(id)}
              >
                <Icon name="X" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="crew-choices">
        {candidates.map((p) => {
          const on = value.includes(p.id)
          return (
            <button
              type="button"
              key={p.id}
              className={`crew-opt${on ? ' on' : ''}`}
              aria-pressed={on}
              title={
                on
                  ? value[0] === p.id
                    ? 'Already hosting'
                    : 'Tap to make them the host'
                  : 'Tap to add them to the show'
              }
              onClick={() => toggle(p.id)}
            >
              {p.firstName} {p.lastName}
            </button>
          )
        })}
      </div>
    </div>
  )
}
