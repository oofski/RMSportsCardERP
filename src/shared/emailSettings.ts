/**
 * The mail account the app sends FROM — shapes and rules, no secrets.
 *
 * ## Why there is a mail account at all
 *
 * Every email the app has sent until now has been a `mailto:` handed to the
 * operating system, which is a genuinely good default: no server, no password,
 * nothing to set up, and the message lands in the sender's own Sent folder. But
 * the scheme has no way to carry a file, so a shipping label cannot go out that
 * way — see `labelMailtoUrl` in @shared/orders, which says the same thing from
 * the other side. Attaching the label means the app has to speak SMTP itself,
 * and speaking SMTP means holding a credential.
 *
 * ## Why this file is in @shared and holds nothing secret
 *
 * The settings screen is a renderer form, so the renderer needs the SHAPE and
 * needs the same validation the main process will apply — a rule enforced in one
 * place only is a rule the other side eventually contradicts. What the renderer
 * must never receive is the password itself, which is what `redactEmailSettings`
 * is for. The real values live on the operator's own machine, encrypted; see
 * main/services/orderEmail.ts. Nothing here is ever committed or baked into a
 * build, exactly as with the QuickBooks keys.
 */

/**
 * One SMTP account.
 *
 * Deliberately the plain host/port/user/password quartet rather than a "Gmail /
 * Outlook / other" picker. Every provider worth naming today is reachable this
 * way, a picker is a list that goes stale, and the one thing an operator can
 * always get from their provider's help page is these four values.
 */
export interface EmailSettings {
  /** Just the hostname — `smtp.example.com`. No scheme, no port. */
  host: string
  port: number
  /**
   * TLS from the very first byte (port 465), as opposed to STARTTLS (port 587),
   * where the conversation opens in the clear and is upgraded a moment later.
   *
   * Both are encrypted. Getting the pairing wrong is not an error either end
   * reports usefully: an implicit-TLS handshake sent at a STARTTLS port simply
   * never completes, so the symptom is a send that hangs until the socket times
   * out rather than anything that says "wrong port". `validateEmailSettings`
   * refuses the two mismatched pairs for that reason.
   */
  secure: boolean
  user: string
  /**
   * The SMTP password — an APP PASSWORD, in practice.
   *
   * Every mainstream provider now refuses an account password over SMTP when
   * two-factor is on, which it is on any account worth using. This value only
   * ever exists in the main process and in the operator's encrypted local
   * store; it is stripped before the settings travel anywhere.
   */
  password: string
  /** The display name on the message. Optional — an empty string is fine. */
  fromName: string
  /**
   * The address the message claims to be from.
   *
   * Kept separate from `user` because they are not the same fact and are not
   * always the same string: a relay account signs in as one identity and is
   * authorised to send as another. Defaulting one to the other would work right
   * up until it silently didn't, and the failure — mail accepted by the relay
   * and then dropped by the recipient's SPF check — is invisible from here.
   */
  fromAddress: string
}

/**
 * The settings with the password taken out.
 *
 * `password` is null rather than absent so the type still lines up field for
 * field with the form the renderer draws — an optional field invites
 * `settings.password ?? ''` to quietly mean "the operator cleared it".
 */
export type RedactedEmailSettings = Omit<EmailSettings, 'password'> & {
  password: null
  /**
   * Is there a password stored?
   *
   * Null alone cannot answer this, and the difference matters on screen: a
   * blank field with a password behind it should read "saved, leave blank to
   * keep it", and a blank field with nothing behind it should read as a field
   * that still has to be filled in.
   */
  hasPassword: boolean
}

/** The implicit-TLS port. TLS is negotiated before any SMTP is spoken. */
export const SMTP_TLS_PORT = 465
/** The submission port. Opens in the clear and upgrades with STARTTLS. */
export const SMTP_STARTTLS_PORT = 587

/**
 * Nothing here is a secret, but a host is long enough to be pasted wrong and
 * short enough that a sane cap catches the paste of an entire help article.
 */
const MAX_FIELD = 255

/**
 * An address, loosely.
 *
 * Deliberately permissive: the grammar an address is actually allowed to have is
 * far wider than anything a short regex describes, and a validator that is
 * stricter than the specification rejects real addresses belonging to real
 * people. This only catches what a person plainly meant to be an address and
 * mistyped — a missing `@`, a stray space, no dot in the domain.
 *
 * Every member of every character class is written as an escape or as an
 * ordinary printable character, per the note in CLAUDE.md about invisible
 * control characters in source.
 */
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function looksLikeEmailAddress(value: string): boolean {
  return ADDRESS.test((value ?? '').trim())
}

/**
 * What is wrong with these settings, as a sentence, or null if nothing is.
 *
 * A SENTENCE rather than a field name or a code, because the only consumer is a
 * person who has just typed something into a form and needs to be told what to
 * do about it. Same contract as `validateShipment` in @shared/orders.
 *
 * Called on both sides: the form uses it to keep an unsendable account from
 * being saved, and the main process uses it again before a save, because an IPC
 * handler that trusts the renderer to have validated is a handler that stores
 * whatever a stale window sends it.
 */
export function validateEmailSettings(input: Partial<EmailSettings>): string | null {
  const host = (input.host ?? '').trim()
  const user = (input.user ?? '').trim()
  const fromAddress = (input.fromAddress ?? '').trim()
  const port = Number(input.port)

  if (!host) return 'Enter the outgoing mail server, like smtp.example.com.'
  if (host.length > MAX_FIELD) return 'That mail server name is too long.'
  // The two ways a host gets pasted wrong. Both would otherwise be reported by
  // the socket layer as a DNS failure, which sends the operator looking at
  // their network rather than at the field they just filled in.
  if (/^[a-z]+:\/\//i.test(host)) {
    return 'Enter just the server name — no https:// or smtp:// in front of it.'
  }
  if (host.includes('/') || host.includes(':') || /\s/.test(host)) {
    return 'Enter just the server name. The port goes in its own box.'
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return `Enter a port number — ${SMTP_STARTTLS_PORT} for most providers, ${SMTP_TLS_PORT} if your provider asks for TLS.`
  }
  // The mismatched pairings, refused here because neither of them fails in a way
  // anybody can read. See the note on `secure` above.
  if (port === SMTP_TLS_PORT && !input.secure) {
    return `Port ${SMTP_TLS_PORT} expects TLS from the first byte. Turn TLS on, or use port ${SMTP_STARTTLS_PORT}.`
  }
  if (port === SMTP_STARTTLS_PORT && input.secure) {
    return `Port ${SMTP_STARTTLS_PORT} starts unencrypted and upgrades itself. Turn TLS off for it, or use port ${SMTP_TLS_PORT}.`
  }

  if (!user) return 'Enter the username for the mail account — usually the full address.'
  if (user.length > MAX_FIELD) return 'That username is too long.'

  // NOT checked for emptiness here, and that is on purpose. A saved account has
  // a password the renderer has never been given, so the form comes back with
  // the field blank; demanding one would mean re-typing the app password to
  // change the port. `setEmailSettings` keeps the stored password when a blank
  // one arrives — that is where the two halves of this rule meet.
  if ((input.password ?? '').length > MAX_FIELD) return 'That password is too long.'

  if (!fromAddress) return 'Enter the address these emails should come from.'
  if (!looksLikeEmailAddress(fromAddress)) {
    return 'That does not look like an email address — check for a missing @ or a typo.'
  }
  if ((input.fromName ?? '').length > MAX_FIELD) return 'That sender name is too long.'

  return null
}

/**
 * The settings, safe to hand to a renderer.
 *
 * The form has to be filled in from somewhere, and the alternative — sending the
 * whole record and trusting the screen not to display it — puts an app password
 * into the renderer process, into any devtools window open on it, and into
 * whatever the IPC layer logs. There is no reason for the password to make that
 * trip: nothing in the browser can use it.
 */
export function redactEmailSettings(settings: EmailSettings): RedactedEmailSettings {
  return {
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    user: settings.user,
    password: null,
    hasPassword: (settings.password ?? '').length > 0,
    fromName: settings.fromName,
    fromAddress: settings.fromAddress
  }
}

/**
 * The From header, as one string.
 *
 * The display name is quoted whenever it holds anything that would end the
 * phrase early — a comma, a quote mark, an angle bracket. An unquoted `Rane,
 * Sid <sid@example.com>` is read by a strict server as TWO recipients, the first
 * of which does not exist, and the message is rejected with a parse error that
 * names neither the comma nor the field it came from.
 */
export function formatFromHeader(settings: Pick<EmailSettings, 'fromName' | 'fromAddress'>): string {
  const name = (settings.fromName ?? '').trim()
  const address = (settings.fromAddress ?? '').trim()
  if (!name) return address
  const escaped = name.replace(/["\\]/g, '\\$&')
  return `"${escaped}" <${address}>`
}
