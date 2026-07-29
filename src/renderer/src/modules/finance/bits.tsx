import type { ReactNode } from 'react'
import type { LedgerBucket } from '@shared/financeStreaming'
import { bucketDef } from '@shared/financeStreaming'
import { formatMoney } from '../../lib/format'
import { Icon } from '../../components/Icon'

/**
 * The small display pieces every Finance screen shares.
 *
 * They are components rather than markup because a number that reads as an
 * expense on one panel and as income on another is the exact failure this
 * module exists to prevent — so the sign, the ink and the tabular alignment are
 * decided in one place.
 */

/** Anything below half a cent is zero; float sums arrive as -0 and 1e-13. */
const isZero = (n: number): boolean => Math.abs(n) < 0.005

export function Money({
  value,
  cost = false,
  dash = false,
  strong = false,
  title
}: {
  value: number
  /**
   * Book it as an outflow whatever sign the ledger stored it with. Expense
   * buckets are definitionally costs, so a cost column must never print a bare
   * positive — that reads as income at a glance, and the day's arithmetic stops
   * being explainable from the row you are looking at.
   */
  cost?: boolean
  /** Exact zero prints an em dash. A grid of $0.00 reads as a broken screen. */
  dash?: boolean
  strong?: boolean
  title?: string
}): JSX.Element {
  const raw = cost ? -Math.abs(value) : value
  const zero = isZero(raw)

  if (zero && dash) {
    return (
      <span className="fin-money zero mono" title={title ?? 'Nothing in this bucket'}>
        —
      </span>
    )
  }

  // U+2212 MINUS SIGN, not the ASCII hyphen Intl emits: it is the width of a
  // digit, so it holds the column and stays legible at 13px. Colour marks the
  // negative too, but the glyph is what carries it for anyone who cannot use
  // the colour.
  const text = formatMoney(zero ? 0 : raw).replace('-', '−')
  const negative = !zero && raw < 0

  return (
    <span
      className={`fin-money mono${negative ? ' neg' : ''}${strong ? ' strong' : ''}`}
      title={title}
    >
      {text}
    </span>
  )
}

/**
 * The bottom line, and the only place green is allowed to mean anything.
 *
 * Every other money figure in Finance is neutral-or-red, because a cost is not
 * a loss: `Money` reds a negative because it is an outflow. Here the question is
 * different — did the day KEEP money — so a positive earns the success ramp and
 * a negative the danger one.
 *
 * COLOUR IS NEVER THE ONLY SIGNAL. The sign is printed explicitly on both
 * sides: U+2212 for a loss, and a real "+" for a profit rather than leaving the
 * reader to infer it from an absent glyph. Greyscale-render this and a profit
 * and a loss are still one character apart.
 *
 * Exact zero is neither, so it takes neither ramp — a day that broke even is a
 * finding, not a near miss in one direction.
 */
export function Profit({ value, title }: { value: number; title?: string }): JSX.Element {
  const zero = isZero(value)
  const tone = zero ? 'is-flat' : value > 0 ? 'is-up' : 'is-down'
  // formatMoney already emits the ASCII hyphen for a negative; swapping it for
  // U+2212 keeps the glyph a digit wide so a column of figures stays aligned.
  const text = formatMoney(zero ? 0 : value).replace('-', '−')
  return (
    <span className={`fin-profit mono ${tone}`} title={title}>
      {!zero && value > 0 ? `+${text}` : text}
    </span>
  )
}

const BUCKET_ICON: Record<LedgerBucket, string> = {
  sale: 'ShoppingCart',
  shipping_subsidy: 'Truck',
  tip: 'Sparkles',
  seller_bonus: 'Crown',
  sale_reversal: 'Undo2',
  giveaway_shipping: 'Gift',
  shipping_charge: 'Truck',
  refund_shipping: 'RotateCcw',
  show_boost: 'Megaphone',
  payout: 'Wallet',
  unclassified: 'AlertTriangle'
}

/**
 * A bucket, tinted by what it does to the P&L rather than by what it is called.
 * The operator should not have to remember that "Giveaway postage" is a cost and
 * "Shipping subsidy" is income — the chip says so.
 */
export function BucketChip({ bucket }: { bucket: LedgerBucket }): JSX.Element {
  const def = bucketDef(bucket)
  return (
    <span className={`fin-bucket tone-${def.treatment}`} title={def.hint}>
      <Icon name={BUCKET_ICON[bucket] ?? 'Info'} size={11} />
      {def.label}
    </span>
  )
}

/**
 * An inline banner. `tone` picks the ground; every one of them carries --text
 * ink except `danger`, which uses --danger-strong — --danger itself only makes
 * 3.5:1 on its own tint in light.
 */
export function Note({
  tone = 'info',
  icon,
  children,
  role
}: {
  tone?: 'info' | 'warn' | 'danger' | 'good'
  icon: string
  children: ReactNode
  role?: 'alert' | 'status'
}): JSX.Element {
  return (
    <div className={`fin-note tone-${tone}`} role={role}>
      <Icon name={icon} size={15} />
      <div className="fin-note-body">{children}</div>
    </div>
  )
}

/** "312 rows" / "1 row" — used often enough that getting it wrong once is worse
 *  than the helper. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`
}
