import { useEffect, useState } from 'react'
import type { InvoiceMatchProposal, InvoiceMatchScan } from '@shared/invoices'
import { describeMatchRefusal } from '@shared/invoices'
import { api } from '../../lib/api'
import { Button, CenterLoader, Modal } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { formatMoney } from '../../lib/format'
import { formatDay } from './helpers'

/**
 * Attach orders written here to the QuickBooks invoices that carry their number.
 *
 * ## Why this is a screen and not a checkbox on the timer
 *
 * An order raised in QuickBooks by hand — or one typed here and then billed
 * there — has no `qboId`, so nothing on this side ever hears that it was paid.
 * The number printed on both documents is the only thing they have in common,
 * and matching on it is the obvious fix.
 *
 * It is also a UNIQUENESS test pretending to be an IDENTITY test. This app takes
 * max+1 over its own rows and QuickBooks takes max+1 over its own, from disjoint
 * knowledge of the same range — so one invoice raised by hand is enough for both
 * counters to offer the same next number for two unrelated documents. That is
 * not an edge case; it is what two working counters do.
 *
 * And the id a match writes is not a label. It is what Delete sends
 * `operation=delete` against, what Send emails to this buyer, and what the
 * status pull reads a stage from — where a bound VOID reads back as `void`,
 * which on this side releases the order's stock and erases its stock ledger for
 * units a picker may already have shipped. None of that can be taken back.
 *
 * So the app does every check it can — one invoice there, one order here, the
 * id unclaimed, not voided, same buyer, same total to the cent, dated within a
 * week — and then shows its working. Both sides are printed side by side because
 * the thing worth checking is whether these are the SAME DOCUMENT, and that is a
 * judgement a person makes by looking at them.
 *
 * ## What IS automatic
 *
 * Everything after. Once an order is attached, the ordinary QuickBooks pull
 * moves it to Paid the moment the balance clears, on the same forward-only path
 * every other invoice takes. The press buys the binding; the payment tracking is
 * then free.
 */
export function MatchByNumberModal({
  onClose,
  onMatched
}: {
  onClose: () => void
  onMatched: () => Promise<void> | void
}): JSX.Element {
  const toast = useToast()
  const [scan, setScan] = useState<InvoiceMatchScan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    void (async () => {
      const res = await api.invoices.qboMatchScan()
      if (!active) return
      if (!res.ok || !res.data) {
        setError(res.error ?? 'Could not reach QuickBooks.')
        return
      }
      setScan(res.data)
      // EVERY PROPOSAL PRE-TICKED. Each one already passed every check the app
      // can make, so the work left is confirming rather than selecting, and
      // making somebody tick forty boxes to agree with forty answers is how a
      // review screen becomes a rubber stamp people click through without
      // reading. Untick is the gesture that carries the meaning here.
      setChosen(new Set(res.data.proposals.map((p) => p.invoiceId)))
    })()
    return () => {
      active = false
    }
  }, [])

  const toggle = (id: string): void => {
    setChosen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const apply = async (): Promise<void> => {
    if (!scan || busy) return
    const pairs = scan.proposals
      .filter((p) => chosen.has(p.invoiceId))
      .map((p) => ({ invoiceId: p.invoiceId, qboId: p.match.qboId }))
    if (pairs.length === 0) return
    setBusy(true)
    try {
      const res = await api.invoices.qboMatchAdopt(pairs)
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Could not reach QuickBooks.')
        return
      }
      const { adopted, refused } = res.data
      if (adopted > 0) {
        toast.success(
          adopted === 1
            ? '1 order attached. It will move to Paid on the next QuickBooks check if it is settled.'
            : `${adopted} orders attached. They will move to Paid on the next QuickBooks check.`
        )
      }
      // REFUSALS ARE NOT SILENT. Every one of them means the books moved between
      // the list being drawn and the button being pressed, which is exactly the
      // case the re-check exists for and exactly the case somebody would
      // otherwise assume had worked.
      if (refused.length > 0) {
        toast.error(
          refused.length === 1
            ? `1 was not attached — ${refused[0].why}`
            : `${refused.length} were not attached. Scan again to see why.`
        )
      }
      await onMatched()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const proposals = scan?.proposals ?? []
  const picked = proposals.filter((p) => chosen.has(p.invoiceId)).length

  return (
    <Modal
      title="Attach orders to QuickBooks by number"
      subtitle="Match an order written here to the invoice carrying the same number"
      onClose={() => (busy ? undefined : onClose())}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button
            variant="primary"
            icon="Link"
            loading={busy}
            disabled={busy || picked === 0}
            onClick={() => void apply()}
          >
            {picked === 1 ? 'Attach 1 order' : `Attach ${picked} orders`}
          </Button>
        </>
      }
    >
      {error && (
        <p className="fin-confirm-lead">
          <Icon name="AlertTriangle" size={14} /> {error}
        </p>
      )}

      {!error && !scan && <CenterLoader />}

      {scan && (
        <>
          {/* THE PREMISE, CHECKED. Matching on a number assumes both systems use
              the same one, and QuickBooks silently replaces DocNumber unless the
              company has custom transaction numbers switched on. The app already
              records what it sent beside what came back, so this costs nothing
              and is decisive: if it ever renumbered, every match below is a
              coincidence until somebody proves otherwise. */}
          {scan.renumbered > 0 && (
            <p className="inv-match-warn">
              <Icon name="AlertTriangle" size={14} />
              <span>
                QuickBooks has given a <b>different number</b> to {scan.renumbered} invoice
                {scan.renumbered === 1 ? '' : 's'} this app posted, so the two numbering series
                do not agree. Check each pair below against QuickBooks before attaching it —
                a matching number may be a coincidence in this company.
              </span>
            </p>
          )}

          {proposals.length === 0 ? (
            <p className="fin-confirm-lead">
              Nothing to attach. {scan.scanned === 0
                ? 'Every order here is already in QuickBooks.'
                : `Checked ${scan.scanned} open order${scan.scanned === 1 ? '' : 's'}.`}
            </p>
          ) : (
            <>
              <p className="fin-confirm-lead">
                These orders and QuickBooks invoices share a number, a buyer, a total and a
                date. Attaching one lets QuickBooks payments reach it — <b>it does not move the
                card</b>; the next QuickBooks check does that, and only if the invoice is
                actually settled.
              </p>
              <div className="inv-match-list">
                {proposals.map((p) => (
                  <ProposalRow
                    key={p.invoiceId}
                    proposal={p}
                    checked={chosen.has(p.invoiceId)}
                    disabled={busy}
                    onToggle={() => toggle(p.invoiceId)}
                  />
                ))}
              </div>
            </>
          )}

          {/* THE NEAR MISSES, AND WHY. An order whose number QuickBooks has never
              heard of is left out — that is most of them and it is not a problem
              — but one that matched on the number and failed on the total is the
              single most useful thing this screen can show, because it is either
              a typo somebody can fix or two documents that were never the same. */}
          {scan.rejected.length > 0 && (
            <details className="inv-match-rejects">
              <summary>
                {scan.rejected.length} not offered ({scan.rejected.length === 1 ? 'it' : 'they'}{' '}
                matched on the number but failed another check)
              </summary>
              <ul>
                {scan.rejected.map((r) => (
                  <li key={r.invoiceId}>
                    <b className="mono">{r.invoiceNumber}</b> · {r.customerName} —{' '}
                    {describeMatchRefusal(r.reason)}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </Modal>
  )
}

/**
 * One proposal, with both documents printed side by side.
 *
 * The point of the layout is comparison. Number, buyer, date and total appear
 * twice — ours on the left, theirs on the right — because "are these the same
 * document" is a question somebody answers by reading the two, and a single
 * merged row would be the app asserting the answer rather than showing it.
 */
function ProposalRow({
  proposal,
  checked,
  disabled,
  onToggle
}: {
  proposal: InvoiceMatchProposal
  checked: boolean
  disabled: boolean
  onToggle: () => void
}): JSX.Element {
  const m = proposal.match
  return (
    <label className={`inv-match-row${checked ? ' is-on' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} />
      <div className="inv-match-side">
        <span className="inv-match-where">This order</span>
        <span className="inv-match-num mono">{proposal.invoiceNumber}</span>
        <span className="inv-match-who">{proposal.customerName}</span>
        <span className="inv-match-meta">
          {formatDay(proposal.invoiceDate)} · <b className="mono">{formatMoney(proposal.total)}</b>
        </span>
      </div>
      <Icon name="ArrowRight" size={15} />
      <div className="inv-match-side">
        <span className="inv-match-where">QuickBooks</span>
        <span className="inv-match-num mono">{m.docNumber ?? '—'}</span>
        <span className="inv-match-who">{m.customerName ?? '—'}</span>
        <span className="inv-match-meta">
          {m.txnDate ? formatDay(m.txnDate) : '—'} ·{' '}
          <b className="mono">{m.totalAmt === null ? '—' : formatMoney(m.totalAmt)}</b>
        </span>
        {/* WHAT IT WILL DO ONCE ATTACHED, said before it is attached. A zero
            balance here means this card moves to Paid on the next check, and
            that move is terminal — somebody agreeing to the binding should know
            they are also agreeing to that. */}
        {m.balance !== null && (
          <span className="inv-match-state">
            {m.balance <= 0
              ? 'Settled there — this order will move to Paid'
              : `${formatMoney(m.balance)} still owing there`}
          </span>
        )}
      </div>
    </label>
  )
}
