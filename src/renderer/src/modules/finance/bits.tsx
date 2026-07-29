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

/**
 * Money as text, with U+2212 MINUS SIGN in place of the ASCII hyphen Intl
 * emits.
 *
 * The hyphen is roughly half a digit wide, so a column containing one negative
 * loses its right edge; U+2212 is drawn to digit width and holds it. Every
 * money string on this screen goes through here — including the ones that end
 * up inside a `title` attribute, which is why it is exported rather than being
 * a private detail of `Money`.
 */
export function moneyText(value: number): string {
  return formatMoney(value).replace('-', '−')
}

export function Money({
  value,
  cost = false,
  abs = false,
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
  /**
   * Print the MAGNITUDE only, because something beside it already carries the
   * sign. The summary equation is the case: it prints its own "−" between the
   * terms, and a signed figure there would render "− −$243.73", which is either
   * a double negative or a typo depending on who is reading it.
   */
  abs?: boolean
  /** Exact zero prints an em dash. A grid of $0.00 reads as a broken screen. */
  dash?: boolean
  strong?: boolean
  title?: string
}): JSX.Element {
  const signed = cost ? -Math.abs(value) : value
  const raw = abs ? Math.abs(signed) : signed
  const zero = isZero(raw)

  if (zero && dash) {
    return (
      <span className="fin-money zero mono" title={title ?? 'Nothing in this bucket'}>
        —
      </span>
    )
  }

  // Colour marks the negative too, but the glyph is what carries it for anyone
  // who cannot use the colour.
  const text = moneyText(zero ? 0 : raw)
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
 * different — did the period KEEP money — so a positive earns the success ramp
 * and a negative the danger one.
 *
 * COLOUR IS NEVER THE ONLY SIGNAL, and there are now two fallbacks rather than
 * one. The sign is printed explicitly on both sides — U+2212 for a loss, a real
 * "+" for a profit rather than leaving the reader to infer it from an absent
 * glyph — and a mark is drawn ahead of it: a triangle up, a triangle down, a bar
 * for flat. The mark is built from CSS borders rather than a character so it
 * cannot fall back to a missing glyph in some other font, and it is hidden
 * inside a calendar cell, where at 640px the seven columns leave no room for it
 * and the sign alone still separates the two cases.
 *
 * Exact zero is neither, so it takes neither ramp — a day that broke even is a
 * finding, not a near miss in one direction.
 */
export function Profit({ value, title }: { value: number; title?: string }): JSX.Element {
  const zero = isZero(value)
  const tone = zero ? 'is-flat' : value > 0 ? 'is-up' : 'is-down'
  const text = moneyText(zero ? 0 : value)
  return (
    <span className={`fin-profit mono ${tone}`} title={title}>
      <i className="fin-profit-mark" aria-hidden="true" />
      {!zero && value > 0 ? `+${text}` : text}
    </span>
  )
}

/**
 * A percentage that names its own base.
 *
 * A bare "9.22%" on a finance screen is not a fact, it is half of one: the fee
 * rate divides by SALES because fees are only charged on sales, while the profit
 * margin divides by TOTAL REVENUE because the question is what share of
 * everything that came in was kept. The two are different numbers on the same
 * data, so neither is ever printed without the denominator it belongs to.
 */
export function Pct({
  value,
  base,
  digits = 1,
  title
}: {
  /** Already a percentage — 73.8, not 0.738. */
  value: number
  /** The denominator, in words: "of revenue", "of sales". */
  base: string
  digits?: number
  title?: string
}): JSX.Element {
  return (
    <span className="fin-pct" title={title}>
      <b className="mono">{value.toFixed(digits)}%</b> {base}
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
