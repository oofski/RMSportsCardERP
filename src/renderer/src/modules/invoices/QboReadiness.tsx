import { useCallback, useEffect, useRef, useState } from 'react'
import type { QboInvoicePreflight, QboMissingTarget, QboSkuFix } from '@shared/invoices'
import { api } from '../../lib/api'
import { Button } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'

/**
 * Whether QuickBooks will take this invoice, said while it can still be fixed.
 *
 * ## The problem this exists for
 *
 * QuickBooks does not accept names. Every line has to resolve to a real
 * Product/Service id in the connected company, and the app cannot invent one —
 * so an invoice naming a case QuickBooks has never heard of is refused. That
 * refusal was correct and it arrived at the worst possible moment: after Save,
 * as a red toast, from a button labelled "Create in QuickBooks". The invoice was
 * on the books here, nothing was on the books there, and the message was about a
 * product name. Every part of that was knowable a minute earlier.
 *
 * So it is checked up front. Two queries, no writes, and the answer sits beside
 * the lines while they are being written.
 *
 * ## Why it does not run on every keystroke
 *
 * The check is two full sweeps of the company's customers and items, which for a
 * real set of books is thousands of rows. Re-running that because somebody typed
 * a digit into a QUANTITY would be pointless — quantity cannot change whether an
 * item exists. So it re-runs on a SIGNATURE of the only fields that can change
 * the answer: the buyer's name and each line's name and SKU. Editing prices all
 * afternoon costs nothing.
 *
 * ## Why answers can arrive out of order
 *
 * Two checks in flight and the slower one landing second would paint a stale
 * answer over a fresh one — the classic version of this bug shows a fixed
 * problem coming back. Each run carries a sequence number and a late answer is
 * dropped.
 */
export function QboReadiness({
  customerName,
  lines,
  /** The bill-to, so a customer created from here starts with their email. */
  email
}: {
  customerName: string
  /**
   * The invoice lines as typed. `rate` and `description` are read ONLY when
   * creating a missing item — they do not affect whether it matches, which is
   * why they are not part of the signature below.
   */
  lines: Array<{ item: string; sku: string; rate?: string; description?: string }>
  email?: string | null
}): JSX.Element | null {
  const toast = useToast()
  const [report, setReport] = useState<QboInvoicePreflight | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [creating, setCreating] = useState<string | null>(null)

  // Only the fields that can change the answer. See the note above.
  const named = lines.filter((l) => l.item.trim() !== '')
  const signature = JSON.stringify([
    customerName.trim().toLowerCase(),
    named.map((l) => [l.item.trim().toLowerCase(), l.sku.trim().toLowerCase()])
  ])

  const seq = useRef(0)
  const run = useCallback(
    async (): Promise<void> => {
      const mine = ++seq.current
      setChecking(true)
      try {
        const res = await api.invoices.qboPreflight({
          customerName,
          lines: named.map((l) => ({ item: l.item, sku: l.sku.trim() || null }))
        })
        // A late answer to a question nobody is asking any more.
        if (mine !== seq.current) return
        if (!res.ok || !res.data) {
          // NOT a toast. This runs by itself, and a background check that could
          // not reach QuickBooks must not interrupt somebody who is typing.
          setError(res.error ?? 'Could not ask QuickBooks.')
          setReport(null)
          return
        }
        setError(null)
        setReport(res.data)
      } finally {
        if (mine === seq.current) setChecking(false)
      }
    },
    // Rebuilt only when the SIGNATURE moves, which is the point: `named` gets a
    // new identity on every keystroke anywhere in the form — including in a
    // quantity, which cannot change whether an item exists — and depending on it
    // would re-run two full sweeps of the company's books for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [customerName, signature]
  )

  // Nothing to check until there is a buyer and at least one named line. Before
  // that, an empty form would be reported as "no customer called ''".
  const checkable = customerName.trim() !== '' && named.length > 0

  useEffect(() => {
    if (!checkable) {
      seq.current++
      setReport(null)
      setError(null)
      setChecking(false)
      return
    }
    // Long enough that typing a product name straight through is one check
    // rather than fifteen.
    const t = setTimeout(() => void run(), 700)
    return () => clearTimeout(t)
  }, [checkable, signature, run])

  if (!checkable) return null

  const createItem = async (miss: QboMissingTarget): Promise<void> => {
    setCreating(miss.name)
    try {
      // The line this miss came from, so the item lands in QuickBooks fully
      // formed rather than as a bare name. Matched the same way the backend
      // matched it — SKU first, name second — so the price that travels is the
      // price on the line somebody is actually looking at.
      const from =
        (miss.sku
          ? lines.find((l) => l.sku.trim().toLowerCase() === miss.sku?.toLowerCase())
          : undefined) ??
        lines.find((l) => l.item.trim().toLowerCase() === miss.name.trim().toLowerCase())
      const rate = Number.parseFloat(from?.rate ?? '')

      const res = await api.invoices.qboCreateItem({
        name: miss.name,
        // The SKU is why creating it from here beats creating it by hand: the
        // NEXT invoice matches on it, and a SKU match survives the item being
        // renamed in QuickBooks. A name match does not.
        sku: miss.sku,
        // The agreed price becomes the item's default, so the next sale of the
        // same case starts from what this one settled at instead of zero. It is
        // a DEFAULT and nothing more — every invoice still carries its own rate,
        // and this one already does.
        rate: Number.isFinite(rate) && rate > 0 ? rate : null,
        description: from?.description?.trim() || null
      })
      if (!res.ok) {
        toast.error(res.error ?? 'QuickBooks would not create that item.')
        return
      }
      toast.success(`Added “${miss.name}” to QuickBooks.`)
      await run()
    } finally {
      setCreating(null)
    }
  }

  /**
   * Put our SKU on their item.
   *
   * The SKU column on a QuickBooks invoice is read off the ITEM — there is no
   * SKU field on a line — so this is the thing that actually gets our SKU onto
   * their document.
   */
  const setSku = async (fix: QboSkuFix): Promise<void> => {
    setCreating(`sku:${fix.itemId}`)
    try {
      const res = await api.invoices.qboSetItemSku(fix.itemId, fix.sku)
      if (!res.ok) {
        toast.error(res.error ?? 'QuickBooks would not set that SKU.')
        return
      }
      toast.success(`“${fix.itemName}” is now SKU ${fix.sku} in QuickBooks.`)
      await run()
    } finally {
      setCreating(null)
    }
  }

  const createCustomer = async (): Promise<void> => {
    setCreating('__customer')
    try {
      const res = await api.invoices.qboCreateCustomer({ name: customerName.trim(), email })
      if (!res.ok) {
        toast.error(res.error ?? 'QuickBooks would not create that customer.')
        return
      }
      toast.success(`Added ${customerName.trim()} to QuickBooks.`)
      await run()
    } finally {
      setCreating(null)
    }
  }

  const tone = error ? 'unknown' : !report ? 'checking' : report.ready ? 'ready' : 'blocked'

  return (
    <div className="qbo-ready" data-tone={tone}>
      <div className="qbo-ready-head">
        <Icon
          name={
            tone === 'ready'
              ? 'CheckCircle2'
              : tone === 'blocked'
                ? 'AlertTriangle'
                : tone === 'unknown'
                  ? 'Info'
                  : 'RefreshCw'
          }
          size={15}
        />
        <b>
          {tone === 'checking'
            ? 'Checking QuickBooks…'
            : tone === 'unknown'
              ? 'Could not check QuickBooks'
              : tone === 'ready'
                ? 'QuickBooks has everything on this invoice'
                : 'QuickBooks is missing something on this invoice'}
        </b>
        <Button
          variant="ghost"
          icon="RefreshCw"
          loading={checking}
          onClick={() => void run()}
        >
          Re-check
        </Button>
      </div>

      {/* The transport failed, which says nothing about the invoice. Worth
          distinguishing from "the invoice has a problem" — they need opposite
          reactions, and a check that cannot run must never read as a pass. */}
      {error && <div className="qbo-ready-note">{error}</div>}

      {report && !report.customerFound && (
        <div className="qbo-ready-row">
          <div>
            <b>{report.customerName}</b>
            <span>No customer by that name in QuickBooks.</span>
          </div>
          <Button
            variant="secondary"
            icon="UserPlus"
            loading={creating === '__customer'}
            disabled={creating !== null}
            onClick={() => void createCustomer()}
          >
            Add customer
          </Button>
        </div>
      )}

      {report?.missingItems.map((miss) => (
        <div className="qbo-ready-row" key={`${miss.sku ?? ''}|${miss.name}`}>
          <div>
            <b>{miss.name}</b>
            <span>
              {miss.sku
                ? `No product or service by that name, and none with SKU ${miss.sku}.`
                : 'No product or service by that name.'}
            </span>
          </div>
          <Button
            variant="secondary"
            icon="Plus"
            loading={creating === miss.name}
            disabled={creating !== null}
            // Says what it will do to real books, on the control that does it.
            title={`Create a non-inventory Product/Service called “${miss.name}” in QuickBooks`}
            onClick={() => void createItem(miss)}
          >
            Add to QuickBooks
          </Button>
        </div>
      ))}

      {/* A QuickBooks item with a blank SKU. Not a blocker — the invoice posts —
          but the SKU column on their document is read off the ITEM, so ours
          never prints until this is filled in. One press, and only ever offered
          for a BLANK one: an item whose SKU disagrees with ours gets a sentence
          below instead, because overwriting a SKU somebody set is not this app's
          decision to make. */}
      {report?.skuFixes.map((fix) => (
        <div className="qbo-ready-row" key={fix.itemId}>
          <div>
            <b>{fix.itemName}</b>
            <span>
              No SKU in QuickBooks, so <span className="mono">{fix.sku}</span> will not print on the
              invoice.
            </span>
          </div>
          <Button
            variant="secondary"
            icon="Tag"
            loading={creating === `sku:${fix.itemId}`}
            disabled={creating !== null}
            title={`Set this item’s SKU to ${fix.sku} in QuickBooks`}
            onClick={() => void setSku(fix)}
          >
            Set SKU
          </Button>
        </div>
      ))}

      {/* Not blockers. The invoice posts with these — they change what PRINTS on
          it, and the fix belongs on the QuickBooks item, so doing it now means
          the document is right the first time rather than reissued. */}
      {report?.notes.map((note) => (
        <div className="qbo-ready-note" key={note}>
          {note}
        </div>
      ))}

      {report && !report.ready && (
        <div className="qbo-ready-foot">
          Adding these creates non-inventory products in QuickBooks. Stock stays counted here — see
          Inventory — so nothing is double-counted.
        </div>
      )}
    </div>
  )
}
