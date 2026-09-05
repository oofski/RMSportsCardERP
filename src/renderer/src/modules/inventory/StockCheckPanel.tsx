/**
 * "Does the inventory tie out?" — asked on demand, answered in plain words.
 *
 * The owner's question was "just making sure things are being tied correctly",
 * and until now the only honest answer was to open every order and look. See
 * @shared/stockAudit for the five things that can come untied and why.
 *
 * ## It does not run itself
 *
 * A button, not an automatic banner. Two reasons, and the second is the real
 * one:
 *
 *   - It walks every order and its allocations. That is fine for something
 *     somebody asks for and wrong on every load of the dashboard.
 *   - A standing red banner on a screen people open forty times a day stops
 *     being read by Thursday. This is the screen somebody comes to WHEN THEY
 *     WANT TO KNOW, and the answer they get is worth reading precisely because
 *     they asked for it.
 *
 * ## It never fixes anything
 *
 * Every finding carries a remedy in words and points at a control that already
 * exists — "Take the stock" on the order, a re-count on the shelf. An audit
 * that repaired things on its own would be changing the books while nobody
 * watched, which is indistinguishable from the bug it is looking for.
 */
import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { api } from '../../lib/api'
import { summariseStockAudit } from '@shared/stockAudit'
import type { StockAudit, StockFinding } from '@shared/stockAudit'

/**
 * The order findings are the ones that cost money, so they are the ones that
 * get the loud colour. A shelf drift is real and worth fixing and is not an
 * emergency, and painting both the same teaches somebody to read neither.
 */
function toneOf(kind: StockFinding['kind']): string {
  if (kind === 'sold-not-booked' || kind === 'sold-part-booked') return 'stkchk-row-bad'
  if (kind === 'negative-shelf') return 'stkchk-row-bad'
  return 'stkchk-row-warn'
}

const LABELS: Record<StockFinding['kind'], string> = {
  'sold-not-booked': 'Sold, never came off the shelf',
  'sold-part-booked': 'Sold, only partly came off the shelf',
  'shelf-vs-layers': 'Shelf disagrees with its cost',
  'negative-shelf': 'Shelf below zero',
  'received-uncosted': 'Received with no cost'
}

export function StockCheckPanel({
  onOpenInvoice
}: {
  /** Jump to the order a finding is about, so the repair is one click away. */
  onOpenInvoice?: (invoiceId: string) => void
}): JSX.Element {
  const [audit, setAudit] = useState<StockAudit | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setAudit(await api.inventory.stockAudit())
    } catch (err) {
      // Said plainly rather than left as a spinner that stopped: a check that
      // silently fails to run reads as "nothing is wrong", which is the one
      // wrong answer this must never give.
      setError(err instanceof Error ? err.message : 'The check could not run.')
      setAudit(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stkchk">
      <div className="stkchk-head">
        <div>
          <h3>Does it all tie out?</h3>
          <p className="stkchk-sub">
            Checks every order against the shelf it sold from, and every shelf against what it cost.
          </p>
        </div>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run()}>
          <Icon name="ShieldCheck" size={14} /> {busy ? 'Checking…' : 'Run the check'}
        </button>
      </div>

      {error && <div className="stkchk-error">{error}</div>}

      {audit && (
        <>
          <p className={`stkchk-verdict ${audit.findings.length === 0 ? 'good' : 'bad'}`}>
            {summariseStockAudit(audit)}
          </p>
          {audit.findings.map((f, i) => (
            <div className={`stkchk-row ${toneOf(f.kind)}`} key={`${f.kind}-${f.invoiceId ?? f.productId}-${i}`}>
              <div className="stkchk-row-head">
                <span className="stkchk-kind">{LABELS[f.kind]}</span>
                <span className="stkchk-units mono">{f.units}</span>
              </div>
              <p className="stkchk-say">{f.sentence}</p>
              <div className="stkchk-foot">
                <span className="stkchk-remedy">{f.remedy}</span>
                {f.invoiceId && onOpenInvoice && (
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => onOpenInvoice(f.invoiceId as string)}
                  >
                    Open the order
                  </button>
                )}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
