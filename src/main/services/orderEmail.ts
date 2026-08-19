/**
 * Sending a shipping label out by email.
 *
 * ## Why this exists next to services/email.ts
 *
 * `services/email.ts` builds a `mailto:` URL and hands it to the operating
 * system. That is still the right answer for the invite email — no server, no
 * password, no setup, and the message lands in the sender's own Sent folder —
 * and it stays the fallback for labels too (`labelMailtoUrl` in @shared/orders).
 * What a `mailto:` cannot do is carry a file. The scheme has no attachment, and
 * no amount of encoding invents one. A shipping label IS the message, so
 * emailing one means the app has to speak SMTP itself.
 *
 * ## Where this runs
 *
 * The main process, in both builds. The desktop app runs it in Electron's main
 * process; the web app on Render runs the same handlers inside src/server, which
 * is an ordinary Node process. Nodemailer needs a TCP socket and Node's crypto,
 * and both of those exist in either place — which is the whole reason the send
 * lives here rather than anywhere near the renderer, where neither does.
 *
 * ## What is never in the repository
 *
 * The host, the account and the password are typed by the operator into the
 * settings screen and stored on that machine, encrypted by the OS keychain where
 * there is one. This repository is PUBLIC. Nothing about a mail account is
 * committed, injected at build time, or defaulted to a real address — the same
 * arrangement the QuickBooks client secret has (see main/quickbooks/store.ts).
 */
import { safeStorage } from 'electron'
import type { EmailSettings } from '@shared/emailSettings'
import { formatFromHeader, looksLikeEmailAddress, validateEmailSettings } from '@shared/emailSettings'
import type { ComposedLabelEmail } from '@shared/orders'
import { ORDER_DOCUMENT_MAX_BYTES } from '@shared/orders'
import { getDb, getMeta, setMeta } from '../db/database'

const SETTINGS_KEY = 'order_email_settings'

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * The seal/open pair, copied from main/quickbooks/store.ts rather than shared.
 *
 * Copied deliberately. Those two helpers are private to that module, and
 * promoting them into a general "encrypted settings" utility would make one file
 * own the storage format for two integrations that have no reason to change
 * together — the sort of shared helper that later gets a parameter added for one
 * caller and quietly alters how the other caller's secret is written. Fourteen
 * lines duplicated with the reason written down is the cheaper mistake. See
 * @shared/homeTasks, @shared/schedule and @shared/invoices, where `addDays`
 * exists three times on the same grounds.
 */
function encAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** Encrypt with the OS keychain when there is one; fall back to base64 when
 *  there is not, so the feature still works on a machine without one — notably
 *  the server, whose electron stub has no keychain to offer. */
function seal(value: unknown): string {
  const json = JSON.stringify(value)
  return encAvailable()
    ? 'v1:' + safeStorage.encryptString(json).toString('base64')
    : 'b64:' + Buffer.from(json, 'utf8').toString('base64')
}

function open<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    if (raw.startsWith('v1:')) {
      if (!encAvailable()) return null
      return JSON.parse(safeStorage.decryptString(Buffer.from(raw.slice(3), 'base64'))) as T
    }
    if (raw.startsWith('b64:')) {
      return JSON.parse(Buffer.from(raw.slice(4), 'base64').toString('utf8')) as T
    }
    return null
  } catch {
    return null
  }
}

/**
 * The mail account this machine sends from, or null if nobody has set one up.
 *
 * Stored in `meta`, which is the one table that does not sync. That is not an
 * oversight: an app password is a credential for ONE person's mailbox, and
 * pushing it around the company through the relay would put it on every laptop
 * and in the relay's storage, to no benefit whatsoever — each machine that needs
 * to send has to be told a From address anyway.
 *
 * Returns null rather than a half-built object when the stored record is missing
 * a field, because a partial account cannot be used for anything and a caller
 * checking `!== null` should not then have to check every field again.
 */
export function getEmailSettings(): EmailSettings | null {
  const s = open<Partial<EmailSettings>>(getMeta(getDb(), SETTINGS_KEY))
  if (!s) return null
  if (typeof s.host !== 'string' || typeof s.user !== 'string' || typeof s.password !== 'string') {
    return null
  }
  if (typeof s.fromAddress !== 'string') return null
  return {
    host: s.host,
    // A port that was stored as a string by an older shape, or lost entirely,
    // reads back as the submission port rather than as NaN — which nodemailer
    // would turn into a connection to port 0 and a failure naming neither.
    port: Number.isInteger(Number(s.port)) ? Number(s.port) : 587,
    secure: s.secure === true,
    user: s.user,
    password: s.password,
    fromName: typeof s.fromName === 'string' ? s.fromName : '',
    fromAddress: s.fromAddress
  }
}

/**
 * Save the account.
 *
 * Returns a result rather than throwing so the IPC handler wiring this up reads
 * the same as the two async calls below — three settings-screen operations with
 * one shape between them is one thing for the renderer to handle, not three.
 *
 * ## A blank password KEEPS the stored one
 *
 * The settings travel to the renderer redacted (see `redactEmailSettings`), so
 * the form is always drawn with the password field empty. If saving with an
 * empty field cleared the password, then changing the port would silently break
 * sending, and the operator would have no reason to connect the two — the field
 * they touched and the field that broke are not the same field. So an empty
 * password means "leave it alone", and clearing it for real is what
 * `clearEmailSettings` is for.
 */
export function setEmailSettings(input: EmailSettings): { ok: boolean; error?: string } {
  const existing = getEmailSettings()
  const password = (input.password ?? '') || (existing?.password ?? '')

  // Validated again here even though the form validates. An IPC handler that
  // trusts its caller is a handler that stores whatever a stale window sends it.
  const problem = validateEmailSettings({ ...input, password })
  if (problem) return { ok: false, error: problem }
  if (!password) return { ok: false, error: 'Enter the password for the mail account.' }

  setMeta(
    getDb(),
    SETTINGS_KEY,
    seal({
      host: input.host.trim(),
      port: Number(input.port),
      secure: input.secure === true,
      user: input.user.trim(),
      // NOT trimmed. Leading and trailing spaces are legal in a password, and
      // an app password is pasted rather than typed — silently trimming one
      // produces an authentication failure that the operator cannot see the
      // cause of, because the field looks exactly right.
      password,
      fromName: (input.fromName ?? '').trim(),
      fromAddress: input.fromAddress.trim()
    } satisfies EmailSettings)
  )
  return { ok: true }
}

/** Forget the account entirely. The only way to remove a stored password. */
export function clearEmailSettings(): void {
  setMeta(getDb(), SETTINGS_KEY, '')
}

/**
 * Can this machine send at all?
 *
 * The question the order screen asks before it offers a Send button, so the
 * offer to email a label is only made where it can be kept. A stored account
 * that no longer validates — saved under an older rule, or half-written — counts
 * as not configured, because attempting it would fail at the socket.
 */
export function emailConfigured(): boolean {
  const s = getEmailSettings()
  if (!s) return false
  return validateEmailSettings(s) === null && s.password.length > 0
}

// ---------------------------------------------------------------------------
// Talking to the mail server
// ---------------------------------------------------------------------------

/** The slice of nodemailer this file uses, and nothing more. */
interface MailMessage {
  from: string
  to: string
  subject: string
  text: string
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>
}

interface MailTransport {
  verify(): Promise<unknown>
  sendMail(message: MailMessage): Promise<unknown>
  close(): void
}

interface TransportOptions {
  host: string
  port: number
  secure: boolean
  auth: { user: string; pass: string }
  connectionTimeout: number
  greetingTimeout: number
  socketTimeout: number
}

interface NodemailerModule {
  createTransport(options: TransportOptions): MailTransport
}

/**
 * Load the mail library, late.
 *
 * Imported inside the call rather than at the top of the file so that a build
 * where nodemailer is missing or unloadable fails as one button saying so,
 * instead of as a main process that will not start. Emailing a label is an
 * optional convenience; the order board, the clock and the invoices are not, and
 * none of them should be able to be taken down by a dependency they never use.
 *
 * The package ships no type declarations, so what comes back is untyped and is
 * narrowed to the two calls this file makes. `.default` and the top level are
 * both checked because the CommonJS exports land in one place under Vite's
 * interop and the other under esbuild's, and which build this is depends on
 * whether the app is running on a desktop or on Render.
 */
async function loadNodemailer(): Promise<NodemailerModule> {
  const mod = await import('nodemailer')
  const candidate =
    (mod as unknown as { default?: NodemailerModule }).default ??
    (mod as unknown as NodemailerModule)
  if (typeof candidate?.createTransport !== 'function') {
    throw new Error('The mail library is missing from this build.')
  }
  return candidate
}

/**
 * A connection, built fresh for each operation and closed after it.
 *
 * NOT pooled. A pooled connection would save a handshake on a button somebody
 * presses a few times a day, and would buy in exchange the classic symptom of
 * one: the first send after a quiet hour fails because the server dropped an
 * idle socket the client still believed in. Two seconds of TLS is the cheaper
 * side of that trade.
 *
 * The three timeouts are all set explicitly because the defaults are minutes
 * long, and the far end of this call is a person watching a spinner on an order
 * they are trying to ship. A wrong host or a blocked port has to come back as a
 * sentence while they are still looking at the form they typed it into.
 */
function buildTransport(nodemailer: NodemailerModule, settings: EmailSettings): MailTransport {
  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: { user: settings.user, pass: settings.password },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 60_000
  })
}

/**
 * What went wrong, in words a person can act on.
 *
 * SMTP failures arrive as a code and a server banner, and the banner is written
 * for a mail administrator: "535-5.7.8 Username and Password not accepted" is
 * accurate and tells an operator nothing about the app password they need to
 * generate. The raw text is kept on the end of the sentence anyway, because the
 * one person who can eventually fix an unusual failure needs it.
 */
function explainMailFailure(err: unknown): string {
  const code = String((err as { code?: unknown } | null)?.code ?? '')
  const raw = err instanceof Error ? err.message : String(err)

  switch (code) {
    case 'EAUTH':
      return (
        'The mail server would not accept that username and password. ' +
        'Most providers need an app password rather than the normal one. ' +
        `(${raw})`
      )
    case 'ENOTFOUND':
    case 'EDNS':
      return `No mail server answers to that name — check the server address. (${raw})`
    case 'ECONNECTION':
    case 'ECONNREFUSED':
      return `Could not reach the mail server on that port. (${raw})`
    case 'ETIMEDOUT':
      return (
        'The mail server did not answer in time. That is usually the TLS setting ' +
        'not matching the port, or a firewall blocking outgoing mail. ' +
        `(${raw})`
      )
    case 'ESOCKET':
      return (
        'The connection to the mail server broke. Check whether that port wants ' +
        `TLS on or off. (${raw})`
      )
    case 'EENVELOPE':
      return `The mail server rejected the from or to address. (${raw})`
    case 'EMESSAGE':
      return `The mail server rejected the message itself. (${raw})`
    default:
      return raw || 'The mail server refused the message and did not say why.'
  }
}

/**
 * Try the account, now.
 *
 * The point of a verify button is WHEN it answers. Everything between typing an
 * app password and a label going out is invisible, so without this the first
 * evidence that the password is wrong arrives at the moment somebody is trying
 * to ship an order — at which point the failure looks like a broken feature
 * rather than like a setting that was never right.
 *
 * Tests what is STORED rather than what is on the form, deliberately. The stored
 * record is what a send will actually use, and verifying a candidate the app has
 * not committed to would be able to pass while sending still failed. Save, then
 * verify.
 */
export async function verifyEmailSettings(): Promise<{ ok: boolean; error?: string }> {
  const settings = getEmailSettings()
  if (!settings) return { ok: false, error: 'No mail account has been set up on this computer yet.' }
  const problem = validateEmailSettings(settings)
  if (problem) return { ok: false, error: problem }

  let transport: MailTransport | null = null
  try {
    const nodemailer = await loadNodemailer()
    transport = buildTransport(nodemailer, settings)
    await transport.verify()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: explainMailFailure(err) }
  } finally {
    // Closed in a `finally` because a verify that threw halfway through can
    // still have opened a socket, and a leaked one holds an authenticated
    // session on the provider's side until it times out — which providers count
    // against a per-account connection limit.
    try {
      transport?.close()
    } catch {
      /* Nothing useful to do about a socket that will not close. */
    }
  }
}

/** A file to hang on the message. The label, in practice. */
export interface LabelEmailAttachment {
  filename: string
  content: Buffer
  contentType: string
}

export interface SendLabelEmailInput {
  to: string
  /**
   * The message, already written by `composeLabelEmail` in @shared/orders.
   *
   * Taken as an argument rather than composed here so the preview somebody reads
   * before pressing Send is built by the same function that builds what is sent.
   * Two composers "doing the same thing" is exactly how a preview comes to
   * differ from the message — the note on `ComposedLabelEmail` says the same.
   */
  composed: ComposedLabelEmail
  attachment?: LabelEmailAttachment | null
}

/**
 * Send the label.
 *
 * ## It never throws
 *
 * By the time this runs, the label is already stored on the order and the order
 * is already saved — that ordering is the point. If a mail failure came back as
 * an exception, the screen that called it would show the whole operation as
 * failed, and the operator would reasonably conclude the label did not upload
 * and upload it again. A failed SEND and a failed SAVE are completely different
 * situations, and only one of them means "do that again". So every failure —
 * no account, a bad address, a dead server, a library that would not load —
 * comes back as `{ ok: false, error }` describing the SEND, and the caller says
 * "the label is attached to the order but the email did not go".
 *
 * Same reasoning as `notifyMessage` in services/webPush.ts: the doorbell failing
 * does not un-deliver what it was announcing.
 */
export async function sendLabelEmail(
  input: SendLabelEmailInput
): Promise<{ ok: boolean; error?: string }> {
  let transport: MailTransport | null = null
  try {
    const settings = getEmailSettings()
    if (!settings) {
      return {
        ok: false,
        error:
          'No mail account has been set up on this computer, so the app cannot send email itself. ' +
          'Set one up in settings, or use the mail-client button and attach the label by hand.'
      }
    }
    const problem = validateEmailSettings(settings)
    if (problem) return { ok: false, error: problem }

    const to = (input.to ?? '').trim()
    if (!to) return { ok: false, error: 'Nobody to send it to — add an email address first.' }
    if (!looksLikeEmailAddress(to)) {
      return { ok: false, error: `${to} does not look like an email address.` }
    }

    const attachment = input.attachment ?? null
    // Checked here as well as at upload, because the two limits are enforced for
    // different reasons and a message can be assembled from a file that did not
    // come through the document store. A provider silently bouncing an oversized
    // message hours later is a far worse answer than this sentence now.
    if (attachment && attachment.content.byteLength > ORDER_DOCUMENT_MAX_BYTES) {
      const mb = Math.round(ORDER_DOCUMENT_MAX_BYTES / (1024 * 1024))
      return { ok: false, error: `That label is too big to email — the limit is ${mb}MB.` }
    }

    const nodemailer = await loadNodemailer()
    transport = buildTransport(nodemailer, settings)

    await transport.sendMail({
      from: formatFromHeader(settings),
      to,
      subject: input.composed.subject,
      // PLAIN TEXT ONLY, on purpose. `composeLabelEmail` lays the body out with
      // blank lines and underlined headings, which is a format that survives
      // being read anywhere. Wrapping it in HTML would collapse every one of
      // those line breaks, and maintaining a second HTML rendering of the same
      // message is how the two versions come to say different things.
      text: input.composed.body,
      attachments: attachment
        ? [
            {
              filename: attachment.filename,
              content: attachment.content,
              contentType: attachment.contentType
            }
          ]
        : undefined
    })

    return { ok: true }
  } catch (err) {
    return { ok: false, error: explainMailFailure(err) }
  } finally {
    try {
      transport?.close()
    } catch {
      /* Nothing useful to do about a socket that will not close. */
    }
  }
}
