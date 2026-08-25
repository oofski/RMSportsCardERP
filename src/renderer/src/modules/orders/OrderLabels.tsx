import { useCallback, useEffect, useRef, useState } from 'react'
import type { OrderDocument, OrderSide } from '@shared/orders'
import { ORDER_DOCUMENT_MAX_BYTES, ORDER_DOCUMENT_TYPES } from '@shared/orders'
import { api } from '../../lib/api'
import { Button, Field, Input, Modal } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { formatDate } from '../../lib/format'
import { MailAccountPanel } from './MailAccountPanel'

/**
 * The shipping label, and getting it to whoever is doing the shipping.
 *
 * ## Why a label lives on the order at all
 *
 * On a dropship the goods never come here: the supplier ships them straight to
 * the buyer, on our postage. So somebody has to buy a label and get it to the
 * supplier, and until now that happened in a text message with a PDF attached —
 * which means the label for order 1043 is findable only by whoever sent it, in
 * an app that is not this one.
 *
 * ## Sending it
 *
 * With a mail account configured the app really sends, with the label attached.
 * Without one it falls back to opening the operator's own mail client with the
 * message already written — and SAYS the label is not on it, because `mailto:`
 * cannot carry an attachment and an email somebody believes has a label on it is
 * worse than no email at all. The screen offers to save the file in the same
 * breath so it can be dragged in.
 */
export function OrderLabels({
  side,
  orderId,
  defaultTo,
  lookupName,
  recipientNote,
  canEdit
}: {
  side: OrderSide
  orderId: string
  /** Who this would go to — the supplier on a purchase, the buyer on a sale. */
  defaultTo: string | null
  /**
   * Why the To box says what it says, in one line.
   *
   * A DROPSHIP SALE POINTS AT THE SUPPLIER, NOT THE BUYER, because the boxes
   * leave the supplier's building — so on those orders this control pre-fills a
   * completely different party from the one the sales order is addressed to.
   * That is right and it is surprising, and an address that quietly changed
   * meaning between two cards is exactly the mistake that only gets noticed
   * after Send. So the screen says which party it picked.
   */
  recipientNote?: string | null
  /**
   * The party's NAME, when the address is not already known.
   *
   * A purchase order's supplier is a string on the document with no record
   * behind it, so there is no email to pass down — but the contact directory the
   * supplier box already searches usually holds one under that name. This is
   * what lets the To box fill itself in anyway. See lookupPartyEmail.
   */
  lookupName?: string | null
  canEdit: boolean
}): JSX.Element {
  const toast = useToast()
  const [docs, setDocs] = useState<OrderDocument[]>([])
  const [busy, setBusy] = useState(false)
  const [emailing, setEmailing] = useState<OrderDocument | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)

  const load = useCallback(async () => {
    setDocs(await api.orders.documents(side, orderId))
  }, [side, orderId])

  useEffect(() => {
    let active = true
    void (async () => {
      const rows = await api.orders.documents(side, orderId)
      if (active) setDocs(rows)
    })()
    return () => {
      active = false
    }
  }, [side, orderId])

  /**
   * Read the file in the BROWSER and send bytes, not a path.
   *
   * The same envelope every other upload in this app uses, and the reason is
   * that this renderer is served two ways: as a desktop window over the Electron
   * bridge and as a browser tab over HTTP. A path picked in a file dialog means
   * nothing to a server running on Render, so nothing anywhere is allowed to
   * pass one.
   */
  const upload = async (file: File): Promise<void> => {
    if (busy) return
    if (file.size > ORDER_DOCUMENT_MAX_BYTES) {
      toast.error(`Labels have to be under ${Math.round(ORDER_DOCUMENT_MAX_BYTES / 1024 / 1024)}MB.`)
      return
    }
    setBusy(true)
    try {
      const buffer = await file.arrayBuffer()
      let binary = ''
      const bytes = new Uint8Array(buffer)
      // Chunked rather than String.fromCharCode(...bytes) in one go: spreading a
      // multi-megabyte array into an argument list overflows the call stack, and
      // it does it at a file size somebody only hits in the field.
      const CHUNK = 0x8000
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
      }
      const res = await api.orders.uploadDocument(side, orderId, {
        filename: file.name,
        base64: btoa(binary),
        mimeType: file.type || 'application/pdf'
      })
      if (!res.ok) {
        toast.error(res.error ?? 'Could not attach that label.')
        return
      }
      toast.success('Label attached.')
      await load()
    } finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const remove = async (doc: OrderDocument): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const res = await api.orders.deleteDocument(doc.id)
      if (!res.ok) toast.error(res.error ?? 'Could not remove that label.')
      await load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ord-lbl">
      <div className="ord-lbl-head">
        <Icon name="FileText" size={15} />
        <b>Shipping label</b>
        {canEdit && (
          <>
            <input
              ref={fileInput}
              type="file"
              accept={ORDER_DOCUMENT_TYPES.join(',')}
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void upload(file)
              }}
            />
            <button
              type="button"
              className="ord-lbl-add"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              <Icon name="Plus" size={13} />
              Attach
            </button>
          </>
        )}
      </div>

      {docs.length === 0 ? (
        <p className="ord-lbl-empty">
          No label on this order. Attach the PDF or image the carrier gave you and it can be
          emailed to whoever is shipping.
        </p>
      ) : (
        <ul className="ord-lbl-list">
          {docs.map((doc) => (
            <li key={doc.id} data-present={doc.present ? 'true' : 'false'}>
              <Icon name="FileText" size={14} />
              <span className="ord-lbl-name" title={doc.name}>
                {doc.name}
              </span>
              <span className="ord-lbl-meta">
                {Math.max(1, Math.round(doc.byteSize / 1024))}KB · {formatDate(doc.uploadedAt)}
              </span>
              {doc.present ? (
                <>
                  <button
                    type="button"
                    className="ord-lbl-btn"
                    onClick={() => void api.orders.openDocument(doc.id)}
                  >
                    Open
                  </button>
                  {canEdit && (
                    <button
                      type="button"
                      className="ord-lbl-btn"
                      onClick={() => setEmailing(doc)}
                    >
                      <Icon name="Mail" size={13} />
                      Email
                    </button>
                  )}
                </>
              ) : (
                // "No label" and "the label is still arriving" are the same blank
                // pane and completely different situations. Saying which stops
                // somebody re-uploading a file that is on its way.
                <span className="ord-lbl-waiting" title="Its slices have not all reached this machine yet">
                  still syncing
                </span>
              )}
              {canEdit && (
                <button
                  type="button"
                  className="ord-lbl-x"
                  title="Remove this label"
                  disabled={busy}
                  onClick={() => void remove(doc)}
                >
                  <Icon name="X" size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {emailing && (
        <EmailLabelModal
          side={side}
          orderId={orderId}
          document={emailing}
          defaultTo={defaultTo}
          lookupName={lookupName ?? null}
          recipientNote={recipientNote ?? null}
          onClose={() => setEmailing(null)}
        />
      )}
    </div>
  )
}

/**
 * Send the label, and say honestly what happened.
 *
 * The preview is not decoration. This message goes to a supplier this business
 * depends on, and the one thing worse than not sending it is sending the wrong
 * one — so the whole body is on screen, editable in the one place it needs to be
 * (the note), before anything leaves.
 */
function EmailLabelModal({
  side,
  orderId,
  document: doc,
  defaultTo,
  lookupName,
  recipientNote,
  onClose
}: {
  side: OrderSide
  orderId: string
  document: OrderDocument
  defaultTo: string | null
  lookupName: string | null
  recipientNote: string | null
  onClose: () => void
}): JSX.Element {
  const toast = useToast()
  const [to, setTo] = useState(defaultTo ?? '')
  const [note, setNote] = useState('')
  const [setup, setSetup] = useState(false)

  /**
   * Fill the To box from the contact of the same name, when nothing was passed.
   *
   * Only when the box is still EMPTY. An address the caller already knew — the
   * buyer's, off the sales order itself — is the better answer and must not be
   * overwritten by a directory lookup a moment later, which is exactly the race
   * that would put somebody else's address in front of a person about to press
   * Send.
   */
  useEffect(() => {
    const name = (lookupName ?? '').trim()
    if (!name || (defaultTo ?? '').trim()) return
    let active = true
    void api.orders.partyEmail(name).then((res) => {
      if (!active || !res.email) return
      setTo((current) => (current.trim() ? current : res.email as string))
    })
    return () => {
      active = false
    }
  }, [lookupName, defaultTo])
  const [sending, setSending] = useState(false)
  const [fallback, setFallback] = useState<{ url: string; body: string; problem: string | null } | null>(
    null
  )

  const send = async (): Promise<void> => {
    if (sending || !to.trim()) return
    setSending(true)
    try {
      const res = await api.orders.emailLabel({
        side,
        orderId,
        to: to.trim(),
        note: note.trim() || null,
        documentId: doc.id
      })
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Could not send that.')
        return
      }
      if (res.data.sent) {
        toast.success(`Label emailed to ${to.trim()}.`)
        onClose()
        return
      }
      // NOT SENT, and the screen has to be specific about why. No mail account
      // configured is a different situation from a server that refused, and the
      // fallback is only honest if it also says the label is not on it.
      setFallback({ url: res.data.mailtoUrl, body: res.data.body, problem: res.data.problem })
    } finally {
      setSending(false)
    }
  }

  return (
    <Modal
      title="Email this label"
      subtitle={`${doc.name} · ${Math.max(1, Math.round(doc.byteSize / 1024))}KB`}
      onClose={() => (sending ? undefined : onClose())}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={sending}>
            Close
          </Button>
          {fallback ? (
            <>
              {/* OFFERED AT THE MOMENT IT IS WANTED. Somebody discovers the app
                  cannot send on its own precisely here — pressing Send and being
                  handed a fallback — and a settings screen buried elsewhere is
                  one they have to go and find later, if they remember. */}
              {!fallback.problem && (
                <Button variant="secondary" icon="Settings" onClick={() => setSetup(true)}>
                  Set up sending
                </Button>
              )}
              <Button
                variant="secondary"
                icon="FileText"
                onClick={() => void api.orders.openDocument(doc.id)}
              >
                Open the label
              </Button>
              <Button variant="primary" icon="Mail" onClick={() => window.open(fallback.url)}>
                Open my mail app
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              icon="Send"
              loading={sending}
              disabled={sending || !to.trim()}
              onClick={() => void send()}
            >
              Send it
            </Button>
          )}
        </>
      }
    >
      {/* WHICH PARTY THIS IS ADDRESSED TO, said out loud.

          On a dropship sale the label goes to the SUPPLIER — they have the
          boxes — not to the buyer the sales order is made out to. That is the
          right answer and a surprising one, and an address that quietly means a
          different person on some cards than on others is the mistake nobody
          catches until after Send. */}
      {recipientNote && (
        <div className="lbl-to-note">
          <Icon name="Info" size={13} />
          <span>{recipientNote}</span>
        </div>
      )}
      <Field label="To">
        <Input
          value={to}
          type="email"
          placeholder="them@example.com"
          onChange={(e) => setTo(e.target.value)}
        />
      </Field>
      <Field label="Anything to add" hint="Goes above the sign-off. Optional.">
        <Input
          value={note}
          placeholder="Please ship by Friday."
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>

      {setup && (
        <MailAccountPanel
          onClose={() => {
            setSetup(false)
            // Cleared so the dialog goes back to offering Send. An account may
            // now exist, and leaving the fallback up would keep showing the
            // route around a problem that has just been fixed.
            setFallback(null)
          }}
        />
      )}

      {fallback && (
        <div className="ord-lbl-fallback">
          <p>
            <Icon name="AlertTriangle" size={14} />{' '}
            {fallback.problem
              ? `The mail server would not send it — ${fallback.problem}`
              : 'No mail account is set up in this app yet, so it cannot send on its own.'}
          </p>
          <p>
            <b>Open my mail app</b> writes the message for you in whatever you normally use.{' '}
            <b>The label will not be attached</b> — a mailto link cannot carry a file — so open
            the label and drag it in before you send.
          </p>
          <pre className="ord-lbl-preview">{fallback.body}</pre>
        </div>
      )}
    </Modal>
  )
}
