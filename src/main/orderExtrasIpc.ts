import { writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { shell } from 'electron'
import { ipcMain } from './ipcRegistry'
import { IPC } from '@shared/ipc'
import type { Result, UploadedFile } from '@shared/types'
import type {
  NewOrderShipment,
  OrderDocument,
  OrderEvent,
  OrderShipment,
  OrderSide
} from '@shared/orders'
import { composeLabelEmail, isOrderSide, labelMailtoUrl } from '@shared/orders'
import type { InvoiceDetail, InvoicePaymentInput } from '@shared/invoices'
import { COMPANY_NAME } from '@shared/config'
import { currentUser } from './services/auth'
import {
  deleteOrderDocument,
  deleteShipment,
  getOrderDocumentBytes,
  listOrderDocuments,
  listOrderEvents,
  listShipments,
  recordOrderEvent,
  saveOrderDocument,
  saveShipment
} from './db/orderExtras'
import {
  getInvoice,
  listAwaitingShipment,
  linkDropshipPair,
  recordInvoicePayment,
  setInvoiceReadyToShip
} from './db/invoices'
import { getPurchaseOrder, lookupPartyEmail } from './db/purchaseOrders'
import { uploadedBytes, uploadedName } from './util'
import type { EmailSettings, RedactedEmailSettings } from '@shared/emailSettings'
import { redactEmailSettings } from '@shared/emailSettings'
import {
  clearEmailSettings,
  emailConfigured,
  getEmailSettings,
  sendLabelEmail,
  setEmailSettings,
  verifyEmailSettings
} from './services/orderEmail'

/**
 * The things a purchase order and a sales order both have: a history, parcels,
 * paperwork, and — on the sell side — money that arrived before anything
 * shipped.
 *
 * ## One permission, and it is the one that already spends money
 *
 * `module.invoicing` gates the whole surface. It is already what raises a
 * purchase order and what bills a buyer, and everything here is a fact about one
 * of those two documents. Splitting it would invent a role that can commit this
 * business to a purchase but not say which box it came in.
 *
 * ## The log is READ here and WRITTEN everywhere else
 *
 * There is deliberately no "add a log entry" channel. An event is a record of
 * something the app did, written by the code that did it, inside the same
 * transaction — see recordOrderEvent. A channel that let a screen post arbitrary
 * history would make the log a thing somebody can author rather than a thing
 * that happened, which is the only property that makes it worth reading.
 */

function requireInvoicing(): { id: string; name: string } {
  const user = currentUser()
  if (!user) throw new Error('You are not signed in.')
  if (!user.permissions.includes('module.invoicing')) {
    throw new Error('You do not have access to Purchase Orders and Sales Orders.')
  }
  return {
    id: user.id,
    name: `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || 'Somebody'
  }
}

function fail(err: unknown): Result<never> {
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function side(v: unknown): OrderSide {
  if (!isOrderSide(v)) throw new Error('That is not an order this app knows about.')
  return v
}

/**
 * Everything the label email needs to say, read off whichever order it is.
 *
 * One function for both sides because the message is the same message — here is
 * what to ship, here is where it goes, here is the tracking — and the only thing
 * that differs is which table the answer comes out of. Two composers would drift
 * the first time either sentence was edited.
 */
function orderContext(
  which: OrderSide,
  orderId: string
): { number: string; shipTo: string | null; lines: Array<{ description: string; quantity: number }> } | null {
  if (which === 'po') {
    const po = getPurchaseOrder(orderId)
    if (!po) return null
    return {
      number: po.poNumber,
      // Where the goods are going. On a dropship that is somebody's shop; on an
      // ordinary purchase it is our own shelf, which is still the right answer
      // to put in front of a supplier.
      shipTo: po.location,
      lines: po.lines.map((l) => ({
        description: l.productName ?? l.productId ?? 'Item',
        quantity: l.quantity
      }))
    }
  }
  const invoice = getInvoice(orderId)
  if (!invoice) return null
  return {
    number: invoice.invoiceNumber || 'draft',
    shipTo: invoice.customerName,
    lines: invoice.lines.map((l) => ({ description: l.item, quantity: l.quantity }))
  }
}

export function registerOrderExtrasIpc(): void {
  // ---- What happened ------------------------------------------------------

  ipcMain.handle(
    IPC.orderEvents,
    (_e, payload: { side?: unknown; orderId?: unknown }): OrderEvent[] => {
      try {
        requireInvoicing()
        return listOrderEvents(side(payload?.side), str(payload?.orderId))
      } catch {
        // An empty history is the right answer for somebody who may not read
        // this order, and it is what an unreadable log should look like too.
        // Throwing would put an error banner over a panel nobody opened on
        // purpose.
        return []
      }
    }
  )

  // ---- Parcels ------------------------------------------------------------

  ipcMain.handle(
    IPC.orderShipments,
    (_e, payload: { side?: unknown; orderId?: unknown }): OrderShipment[] => {
      try {
        requireInvoicing()
        return listShipments(side(payload?.side), str(payload?.orderId))
      } catch {
        return []
      }
    }
  )

  /**
   * Add a parcel or change one.
   *
   * The event says what changed in words rather than storing a diff, because the
   * log is read by a person asking "why does this order say FedEx now" and a
   * structured diff would make them reconstruct the sentence themselves.
   */
  ipcMain.handle(
    IPC.orderShipmentSave,
    (
      _e,
      payload: { side?: unknown; orderId?: unknown; shipment?: NewOrderShipment & { id?: string } }
    ): Result<OrderShipment> => {
      try {
        const actor = requireInvoicing()
        const which = side(payload?.side)
        const orderId = str(payload?.orderId)
        const input = payload?.shipment ?? {}
        const isNew = !str(input.id)
        const saved = saveShipment(which, orderId, input, actor.id)
        const how = [saved.carrier, saved.service].filter(Boolean).join(' ')
        recordOrderEvent(which, orderId, 'shipment', {
          detail:
            (isNew ? 'Parcel added' : 'Parcel changed') +
            (saved.trackingNumber ? ` — ${saved.trackingNumber}` : '') +
            (how ? ` (${how})` : '') +
            (saved.labelCost !== null ? ` · label ${saved.labelCost.toFixed(2)}` : ''),
          actorId: actor.id
        })
        return { ok: true, data: saved }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.orderShipmentDelete,
    (_e, id: unknown): Result<{ id: string }> => {
      try {
        const actor = requireInvoicing()
        const target = str(id)
        const removed = deleteShipment(target)
        if (!removed) return { ok: false, error: 'That parcel is gone.' }
        recordOrderEvent(removed.side, removed.orderId, 'shipment', {
          detail: 'Parcel removed',
          actorId: actor.id
        })
        return { ok: true, data: { id: target } }
      } catch (err) {
        return fail(err)
      }
    }
  )

  // ---- Paperwork ----------------------------------------------------------

  ipcMain.handle(
    IPC.orderDocuments,
    (_e, payload: { side?: unknown; orderId?: unknown }): OrderDocument[] => {
      try {
        requireInvoicing()
        return listOrderDocuments(side(payload?.side), str(payload?.orderId))
      } catch {
        return []
      }
    }
  )

  /**
   * Attach a label.
   *
   * The bytes arrive as an UploadedFile — the same envelope every other upload
   * in this app uses — which works identically over the Electron bridge and over
   * HTTP, and that matters because this app is one renderer bundle served two
   * ways.
   */
  ipcMain.handle(
    IPC.orderDocumentUpload,
    (
      _e,
      payload: {
        side?: unknown
        orderId?: unknown
        shipmentId?: unknown
        file?: UploadedFile
      }
    ): Result<OrderDocument> => {
      try {
        const actor = requireInvoicing()
        const which = side(payload?.side)
        const orderId = str(payload?.orderId)
        if (!payload?.file) return { ok: false, error: 'No file was uploaded.' }
        const bytes = uploadedBytes(payload.file)
        if (!bytes) return { ok: false, error: 'That file came through empty.' }
        const name = uploadedName(payload.file, 'label')
        // What the browser said, falling back to the extension. Neither is
        // trusted — saveOrderDocument checks it against the list of what this
        // app is willing to keep before a byte is written.
        const claimed = str(payload.file.mimeType)
        const byExtension = name.toLowerCase().endsWith('.png')
          ? 'image/png'
          : /\.jpe?g$/i.test(name)
            ? 'image/jpeg'
            : name.toLowerCase().endsWith('.gif')
              ? 'image/gif'
              : name.toLowerCase().endsWith('.webp')
                ? 'image/webp'
                : 'application/pdf'
        const mime = claimed || byExtension
        const doc = saveOrderDocument(
          which,
          orderId,
          { name, mimeType: mime, bytes, kind: 'label', shipmentId: str(payload.shipmentId) || null },
          actor.id
        )
        recordOrderEvent(which, orderId, 'label', {
          detail: `Label attached — ${name}`,
          actorId: actor.id
        })
        return { ok: true, data: doc }
      } catch (err) {
        return fail(err)
      }
    }
  )

  /**
   * Open the label.
   *
   * Written to a temporary file and handed to the OS rather than streamed,
   * because "open this PDF" is a thing the desktop already does well and a
   * viewer built into this app would be a worse one. On the web build the same
   * call returns the path and the server serves it — see tempFiles.
   */
  ipcMain.handle(IPC.orderDocumentOpen, async (_e, id: unknown): Promise<Result<{ path: string }>> => {
    try {
      requireInvoicing()
      const file = getOrderDocumentBytes(str(id))
      if (!file) {
        return {
          ok: false,
          // The honest message. A document whose slices have not all arrived is
          // a real and temporary state, and telling somebody the file is missing
          // would send them to re-upload one that is on its way.
          error: 'That label is not on this machine yet — it is still syncing.'
        }
      }
      // The same arrangement the PDF exports use: write it beside the OS's own
      // temporary files and let the desktop open it. The name is scrubbed
      // because it came off somebody's disk and is about to become a path.
      const path = join(tmpdir(), file.name.replace(/[^\w.-]/g, '_') || 'label')
      writeFileSync(path, file.bytes)
      // openPath resolves to a NON-EMPTY string when it FAILED — an empty
      // string is success, which is easy to invert by accident.
      const problem = await shell.openPath(path)
      if (problem) return { ok: false, error: problem }
      return { ok: true, data: { path } }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.orderDocumentDelete, (_e, id: unknown): Result<{ id: string }> => {
    try {
      const actor = requireInvoicing()
      const target = str(id)
      const removed = deleteOrderDocument(target)
      if (!removed) return { ok: false, error: 'That label is gone.' }
      recordOrderEvent(removed.side, removed.orderId, 'label', {
        detail: 'Label removed',
        actorId: actor.id
      })
      return { ok: true, data: { id: target } }
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * Email the label to whoever is shipping the goods.
   *
   * ## Two ways out, and the screen is told which one happened
   *
   * With a mail account configured this SENDS, with the label attached, which is
   * what was actually asked for. Without one it hands back a `mailto:` URL and
   * says the label is not on it — because the scheme cannot carry an attachment,
   * and an email somebody believes has a label on it is worse than no email.
   *
   * The send failing is NOT a failed request. The label is stored, the order is
   * saved and the message is composed; what did not happen is delivery, and the
   * screen offers the fallback rather than reporting that nothing worked.
   */
  ipcMain.handle(
    IPC.orderEmailLabel,
    async (
      _e,
      payload: {
        side?: unknown
        orderId?: unknown
        to?: unknown
        note?: unknown
        documentId?: unknown
      }
    ): Promise<
      Result<{ sent: boolean; mailtoUrl: string; subject: string; body: string; problem: string | null }>
    > => {
      try {
        const actor = requireInvoicing()
        const which = side(payload?.side)
        const orderId = str(payload?.orderId)
        const to = str(payload?.to)
        if (!to) return { ok: false, error: 'Say who it is going to.' }

        const context = orderContext(which, orderId)
        if (!context) return { ok: false, error: 'That order is gone.' }

        const shipments = listShipments(which, orderId)
        const composed = composeLabelEmail({
          side: which,
          orderNumber: context.number,
          shipTo: context.shipTo,
          senderName: actor.name,
          companyName: COMPANY_NAME,
          lines: context.lines,
          shipments: shipments.map((s) => ({
            carrier: s.carrier,
            service: s.service,
            trackingNumber: s.trackingNumber
          })),
          note: str(payload?.note) || null,
          labelName: null
        })

        const docId = str(payload?.documentId)
        const file = docId ? getOrderDocumentBytes(docId) : null
        // ASKED FOR A LABEL AND THIS MACHINE HAS NOT GOT IT YET. Refused rather
        // than sent without one: the body would read "the label is attached" to
        // a supplier who is waiting for it, and they would wait. The slices are
        // on their way — see rebuildOrderDocuments — so this is a "try again in
        // a moment", not a failure of the order.
        if (docId && !file) {
          return {
            ok: false,
            error:
              'That label has not finished syncing to this machine yet, so it cannot be attached. ' +
              'Try again in a moment, or send it from the machine it was uploaded on.'
          }
        }
        const withLabel = file
          ? composeLabelEmail({
              side: which,
              orderNumber: context.number,
              shipTo: context.shipTo,
              senderName: actor.name,
              companyName: COMPANY_NAME,
              lines: context.lines,
              shipments: shipments.map((s) => ({
                carrier: s.carrier,
                service: s.service,
                trackingNumber: s.trackingNumber
              })),
              note: str(payload?.note) || null,
              labelName: file.name
            })
          : composed

        const mailtoUrl = labelMailtoUrl(to, composed)

        if (!emailConfigured()) {
          return {
            ok: true,
            data: {
              sent: false,
              mailtoUrl,
              subject: composed.subject,
              body: composed.body,
              problem: null
            }
          }
        }

        const result = await sendLabelEmail({
          to,
          composed: withLabel,
          attachment: file
            ? { filename: file.name, content: file.bytes, contentType: file.mimeType }
            : null
        })
        if (result.ok) {
          recordOrderEvent(which, orderId, 'email', {
            detail: `Label emailed to ${to}${file ? '' : ' (no label attached)'}`,
            actorId: actor.id
          })
        }
        return {
          ok: true,
          data: {
            sent: result.ok,
            mailtoUrl,
            subject: withLabel.subject,
            body: withLabel.body,
            problem: result.ok ? null : (result.error ?? 'The mail server refused it.')
          }
        }
      } catch (err) {
        return fail(err)
      }
    }
  )

  /**
   * The address already on file for a party.
   *
   * Answers null rather than failing when there is no contact of that name,
   * which is the ordinary case for a distributor nobody has filed — the To box
   * simply opens empty and gets typed into, exactly as it did before.
   */
  ipcMain.handle(IPC.orderPartyEmail, (_e, name: unknown): { email: string | null } => {
    try {
      requireInvoicing()
      return { email: lookupPartyEmail(str(name)) }
    } catch {
      return { email: null }
    }
  })

  // ---- The mail account labels are sent from ------------------------------

  /**
   * What is configured, WITHOUT the password.
   *
   * The redaction is not politeness. This value crosses into a renderer that may
   * be a browser tab, and an SMTP password living in a page's memory — where an
   * extension, a devtools heap snapshot or a stray error report can reach it —
   * buys nothing, because the form never needs to display it. `hasPassword`
   * tells the form which of the two blank states it is in: "saved, leave it
   * alone" or "still needs one".
   */
  ipcMain.handle(IPC.emailSettingsGet, (): RedactedEmailSettings | null => {
    try {
      requireInvoicing()
      const settings = getEmailSettings()
      return settings ? redactEmailSettings(settings) : null
    } catch {
      return null
    }
  })

  ipcMain.handle(
    IPC.emailSettingsSave,
    (_e, input: Partial<EmailSettings>): Result<RedactedEmailSettings> => {
      try {
        requireInvoicing()
        // A BLANK PASSWORD MEANS KEEP THE STORED ONE. The renderer is never sent
        // the password, so the box is always drawn empty — and a save that read
        // that empty box as "clear it" would wipe the account every time
        // somebody corrected a port number.
        const existing = getEmailSettings()
        const password = (input.password ?? '').trim() || existing?.password || ''
        const settings: EmailSettings = {
          host: (input.host ?? '').trim(),
          port: Number(input.port),
          secure: input.secure !== false,
          user: (input.user ?? '').trim(),
          password,
          fromName: (input.fromName ?? '').trim(),
          fromAddress: (input.fromAddress ?? '').trim()
        }
        const res = setEmailSettings(settings)
        if (!res.ok) return { ok: false, error: res.error ?? 'Those settings were refused.' }
        return { ok: true, data: redactEmailSettings(settings) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.emailSettingsClear, (): Result<{ cleared: true }> => {
    try {
      requireInvoicing()
      clearEmailSettings()
      return { ok: true, data: { cleared: true } }
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * Try the account now.
   *
   * Tests what is STORED rather than what is on screen, so what is proved is
   * exactly what a send will use. Save, then verify — which is also the order
   * the screen presents them in.
   */
  ipcMain.handle(IPC.emailSettingsVerify, async (): Promise<Result<{ ok: true }>> => {
    try {
      requireInvoicing()
      const res = await verifyEmailSettings()
      if (!res.ok) return { ok: false, error: res.error ?? 'The mail server would not accept it.' }
      return { ok: true, data: { ok: true } }
    } catch (err) {
      return fail(err)
    }
  })

  // ---- Paid up front, and the packing queue -------------------------------

  ipcMain.handle(
    IPC.invoicePayUpFront,
    (_e, payload: { id?: unknown; payment?: InvoicePaymentInput }): Result<InvoiceDetail> => {
      try {
        const actor = requireInvoicing()
        const res = recordInvoicePayment(str(payload?.id), payload?.payment ?? {}, actor.id)
        if (res.error) return { ok: false, error: res.error }
        if (!res.invoice) return { ok: false, error: 'That order is gone.' }
        return { ok: true, data: res.invoice }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.invoiceSetReady,
    (_e, payload: { id?: unknown; ready?: unknown }): Result<InvoiceDetail> => {
      try {
        const actor = requireInvoicing()
        const res = setInvoiceReadyToShip(str(payload?.id), payload?.ready !== false, actor.id)
        if (res.error) return { ok: false, error: res.error }
        if (!res.invoice) return { ok: false, error: 'That order is gone.' }
        return { ok: true, data: res.invoice }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.invoicesAwaitingShipment, (): InvoiceDetail[] => {
    try {
      requireInvoicing()
      return listAwaitingShipment().map((i) => ({ ...i, lines: [] }))
    } catch {
      return []
    }
  })

  // ---- The two halves of a dropship ---------------------------------------

  /**
   * Bind a sales order to the purchase order it was raised against.
   *
   * The SALE IS ALREADY SAVED before this is called. That ordering is the whole
   * design: the second screen of the dropship flow saves an ordinary sales order
   * through the ordinary path — same validation, same stock rules, same
   * QuickBooks decision — and this only records that the two are the same deal.
   * A combined "create and link" call would be a second way to write a sales
   * order, and the two would drift.
   */
  ipcMain.handle(
    IPC.orderLinkDropship,
    (_e, payload: { poId?: unknown; invoiceId?: unknown }): Result<{ linked: true }> => {
      try {
        const actor = requireInvoicing()
        const res = linkDropshipPair(str(payload?.poId), str(payload?.invoiceId), actor.id)
        if (!res.ok) return { ok: false, error: res.error ?? 'Could not link those orders.' }
        return { ok: true, data: { linked: true } }
      } catch (err) {
        return fail(err)
      }
    }
  )
}
