import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_INVOICE_DELIVERY,
  PAYMENT_INSTRUCTIONS_MAX,
  validateInvoiceDelivery,
  type InvoiceDelivery
} from '@shared/invoiceDelivery'
import { api } from '../../lib/api'
import { Button, Checkbox, Field } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'

/**
 * HOW THE INVOICE REACHES THE BUYER: what it says about paying, and whether
 * QuickBooks emails it without being asked.
 *
 * ## Why these two are one panel
 *
 * They are the same decision from two sides. Turning on automatic email without
 * payment instructions sends a buyer an invoice that does not say where to send
 * the money; filling in the instructions without the switch means opening every
 * invoice in QuickBooks and pressing Send by hand, which is what the owner has
 * been doing. Neither half is much use alone, so neither half is on its own
 * screen.
 *
 * ## The instructions are typed here and stay here
 *
 * Bank details. THIS REPOSITORY IS PUBLIC, so nothing is baked in — see the note
 * in @shared/invoiceDelivery. They live in `meta`, which is one of the tables
 * deliberately left out of sync, so they do not travel to the relay or to
 * another machine. That also means this is answered once per install: the
 * desktop app and the web app each have their own database, the same as the mail
 * account.
 *
 * ## Automatic email is off until somebody switches it on
 *
 * An invoice cannot be unsent, and the mistyped price is found by the person
 * reading it. The default keeps the look-at-it step the current flow has.
 */
export function InvoiceDeliverySettings({ connected }: { connected: boolean }): JSX.Element | null {
  const toast = useToast()
  const [form, setForm] = useState<InvoiceDelivery>(DEFAULT_INVOICE_DELIVERY)
  const [saved, setSaved] = useState<InvoiceDelivery>(DEFAULT_INVOICE_DELIVERY)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const res = await api.invoices.getDelivery()
      if (res.ok && res.data) {
        setForm(res.data)
        setSaved(res.data)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (connected) void load()
  }, [connected, load])

  if (!connected) return null

  const problem = validateInvoiceDelivery(form)
  const dirty =
    form.paymentInstructions !== saved.paymentInstructions || form.autoSend !== saved.autoSend

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const res = await api.invoices.setDelivery(form)
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Could not save that.')
        return
      }
      setForm(res.data)
      setSaved(res.data)
      toast.success(
        res.data.autoSend
          ? 'Saved. New invoices will be emailed as soon as they reach QuickBooks.'
          : 'Saved.'
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="qbo-map">
      <div className="qbo-map-head">
        <div>
          <b>What the buyer gets</b>
          <p>Printed on every invoice, and whether QuickBooks emails it for you.</p>
        </div>
        <div className="qbo-map-acts">
          <Button
            icon="Save"
            variant="primary"
            onClick={() => void save()}
            loading={saving}
            disabled={loading || saving || !dirty || !!problem}
          >
            Save
          </Button>
        </div>
      </div>

      <Field
        label="How to pay it"
        hint={`Wire details, a Zelle handle, anything the buyer needs. Added under the message on every invoice. ${form.paymentInstructions.length}/${PAYMENT_INSTRUCTIONS_MAX}`}
        error={problem ?? undefined}
      >
        {/* A TEXTAREA, because a wire is four lines: bank, routing, account,
            name on the account. The single-line Input every other setting uses
            would put all four on one line and hide three of them. */}
        <textarea
          className="input qbo-pay-note"
          rows={5}
          spellCheck={false}
          value={form.paymentInstructions}
          placeholder={
            'Wire to:\nBank — \nRouting — \nAccount — \nOr Zelle to '
          }
          onChange={(e) => setForm((f) => ({ ...f, paymentInstructions: e.target.value }))}
        />
      </Field>

      <Checkbox
        checked={form.autoSend}
        onChange={(v) => setForm((f) => ({ ...f, autoSend: v }))}
        label="Email it to the buyer as soon as it is created in QuickBooks"
        hint="Off by default. QuickBooks does the sending, from your company's address, and records that it went."
      />

      {/* Said where the switch is, not in a toast after the fact. An invoice
          that emails itself the instant it posts is the one nobody looked at
          first, and the buyer is who finds the mistyped price. */}
      {form.autoSend && (
        <div className="qbo-note">
          <Icon name="AlertTriangle" size={15} />
          <div>
            The browser still opens on each new invoice, but the buyer will already have it — an
            email cannot be recalled. Buyers with no email address on file are skipped and the
            invoice says so.
          </div>
        </div>
      )}

      <div className="qbo-note">
        <Icon name="Info" size={15} />
        <div>
          These stay on this machine. They are not synced and are not in the app&rsquo;s source, so
          the web app and each installed copy are set up separately.
        </div>
      </div>
    </div>
  )
}
