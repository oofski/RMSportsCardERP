/**
 * A break's identity, everywhere it appears.
 *
 * One component so a break looks the same on the board, in the finder, on a
 * package and in the assignment list. The old code coloured a break by its INDEX
 * within one package, which meant break #9 was a different colour in every
 * customer's row — actively misleading the moment two people compared screens.
 * Here the hue is a property of the break itself: #9 is the same orange all
 * night, on every machine, so "the orange break" is a thing someone can say
 * across a room and be right.
 *
 * Ten hues, because ten is roughly the limit of what stays distinguishable at
 * chip size, including for viewers who are colourblind. Break 11 and
 * break 1 share a hue and are told apart by fill: 1–10 solid, 11–20 hollow. And
 * the label is ALWAYS printed, so colour is never the only signal — which is
 * the part that actually makes it accessible.
 *
 * The chip takes the printed LABEL, not a number, because "#11A" is a different
 * break from "#11" with a full slate of its own. A letter shifts the hue one
 * step, so the two never sit side by side in the same colour told apart only by
 * a single character somebody has to squint at across a room.
 */
const LABEL_RE = /^(\d+)([A-Za-z]*)$/

export function BreakChip({
  label,
  size = 'md'
}: {
  label: string | number | null
  size?: 'sm' | 'md'
}): JSX.Element {
  const text = label == null ? '' : String(label).trim()
  if (text === '') {
    return <span className={`brk-chip brk-none ${size === 'sm' ? 'sm' : ''}`}>no break</span>
  }

  const m = LABEL_RE.exec(text)
  // A label that is not "number + optional letter" still gets a chip — it is a
  // real break somebody has to pick — just with a deterministic hue off its own
  // characters rather than off a number it does not have.
  const base = m ? Number(m[1]) : [...text].reduce((a, c) => a + c.charCodeAt(0), 0)
  const letter = m && m[2] ? m[2].toUpperCase().charCodeAt(0) - 64 : 0
  const hue = ((Math.abs(base) + letter - 1) % 10) + 1
  const hollow = m ? Number(m[1]) > 10 : false

  return (
    <span
      className={`brk-chip ${size === 'sm' ? 'sm' : ''}`}
      data-hue={hue}
      data-hollow={hollow ? 'true' : 'false'}
      title={`Break #${text}`}
    >
      #{text}
    </span>
  )
}
