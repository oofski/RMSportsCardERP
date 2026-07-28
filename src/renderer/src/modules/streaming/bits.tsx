import type { StreamSession, StreamSource } from '@shared/streaming'
import { formatDuration } from '@shared/streaming'
import { Icon } from '../../components/Icon'
import { crossedDays, timeLabel } from './time'

/**
 * Small display pieces shared by the calendar, the list and the detail screen.
 * They exist as components rather than markup because the "+1d" marker and the
 * measured/recalled distinction have to read identically everywhere — a session
 * that looks like it ended at 2am on one screen and 2am "the same day" on
 * another is exactly the confusion this module removes.
 */

const SOURCE_META: Record<StreamSource, { label: string; icon: string; hint: string }> = {
  live: {
    label: 'Live',
    icon: 'CircleDot',
    hint: 'Clocked with Start stream — these times were measured.'
  },
  manual: {
    label: 'Added manually',
    icon: 'Pencil',
    hint: 'Typed in afterwards — these times were recalled, not measured.'
  }
}

export function SourceChip({ source }: { source: StreamSource }): JSX.Element {
  const meta = SOURCE_META[source]
  return (
    <span className={`stm-chip src-${source}`} title={meta.hint}>
      <Icon name={meta.icon} size={11} />
      {meta.label}
    </span>
  )
}

export function LiveChip(): JSX.Element {
  return (
    <span className="stm-chip live">
      <span className="stm-live-dot small" aria-hidden="true" />
      On air
    </span>
  )
}

/**
 * "9:04 PM → 2:11 AM +1d". The offset badge is the whole reason this module
 * exists: without it a 2am end reads as an eighteen-hour show that started the
 * same morning.
 */
export function TimeSpan({
  session,
  withDuration = false
}: {
  session: StreamSession
  withDuration?: boolean
}): JSX.Element {
  const days = crossedDays(session.startedAt, session.endedAt)
  return (
    <span className="stm-span">
      <span className="mono">{timeLabel(session.startedAt)}</span>
      <Icon name="ArrowRight" size={12} />
      {session.endedAt ? (
        <>
          <span className="mono">{timeLabel(session.endedAt)}</span>
          {days > 0 && (
            <span className="stm-plus" title={`Ended ${days} day${days === 1 ? '' : 's'} later`}>
              +{days}d
            </span>
          )}
        </>
      ) : (
        <em className="stm-span-open">still running</em>
      )}
      {withDuration && (
        <span className="stm-span-dur mono">{formatDuration(session.durationMinutes)}</span>
      )}
    </span>
  )
}
