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
 * chip size in both themes and for viewers who are colourblind. Break 11 and
 * break 1 share a hue and are told apart by fill: 1–10 solid, 11–20 hollow. And
 * the number is ALWAYS printed, so colour is never the only signal — which is
 * the part that actually makes it accessible.
 */
export function BreakChip({
  n,
  size = 'md'
}: {
  n: number | null
  size?: 'sm' | 'md'
}): JSX.Element {
  if (n == null) {
    return <span className={`brk-chip brk-none ${size === 'sm' ? 'sm' : ''}`}>no break</span>
  }
  const hue = ((Math.abs(n) - 1) % 10) + 1
  const hollow = Math.abs(n) > 10
  return (
    <span
      className={`brk-chip ${size === 'sm' ? 'sm' : ''}`}
      data-hue={hue}
      data-hollow={hollow ? 'true' : 'false'}
      title={`Break #${n}`}
    >
      #{n}
    </span>
  )
}
