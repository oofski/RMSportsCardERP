/**
 * Messages — the company's own way of reaching people.
 *
 * ## The message is the record; the notification is a doorbell
 *
 * The obvious build puts the text in the push payload and stops there. It is
 * also the one that loses messages: a phone that was off, a browser that dropped
 * its subscription, somebody who read the banner on a lock screen and swiped it
 * away. In every one of those the message is gone with nothing to go back to.
 *
 * So a message is an ordinary synced row, and the push is the buzz that says to
 * come and look. Deliver the buzz or not, the conversation is on every device
 * that syncs — in order, with who said it and when — and it works on a laptop
 * with notifications switched off entirely.
 */

/** What kind of conversation this is. */
export type ThreadKind =
  /** Two people. */
  | 'direct'
  /** Three or more, with a name somebody chose. */
  | 'group'
  /** Everybody who works here, at the moment it was sent. */
  | 'broadcast'

export const THREAD_KINDS: ThreadKind[] = ['direct', 'group', 'broadcast']

export function isThreadKind(v: unknown): v is ThreadKind {
  return THREAD_KINDS.includes(v as ThreadKind)
}

/** How long a message may be. */
export const MESSAGE_MAX = 4000

/**
 * How many characters of a message reach a phone.
 *
 * A push payload is capped at about 4KB after encryption, and a notification
 * that is longer than the screen is truncated by the platform anyway — badly,
 * and differently on every one. Cutting it here means the app decides where the
 * sentence stops rather than Android doing it mid-word.
 */
export const PUSH_BODY_MAX = 180

export interface ThreadParticipant {
  employeeId: string
  name: string
  /** The Company ID, for telling two people with one first name apart. */
  companyId: string
  role: string
  avatarUrl: string | null
  /** Null until they have opened the thread once. */
  lastReadAt: string | null
}

export interface Message {
  id: string
  threadId: string
  /** Null when the author's account has since been removed. */
  authorId: string | null
  authorName: string
  body: string
  createdAt: string
  /** True when the signed-in reader wrote it — decided in main, not by the
   *  screen comparing ids it may not have. */
  mine: boolean
}

/** A row in the conversation list. */
export interface ThreadSummary {
  id: string
  title: string
  kind: ThreadKind
  /** Everybody in it, so the list can name a direct thread after the other person. */
  participants: ThreadParticipant[]
  lastMessage: string | null
  lastMessageAt: string | null
  lastMessageBy: string | null
  /** Messages this reader has not seen. Zero on a thread they have just opened. */
  unread: number
  createdAt: string
}

export interface ThreadDetail extends ThreadSummary {
  messages: Message[]
}

/** Somebody who works here, as the contact list shows them. */
export interface Contact {
  id: string
  name: string
  companyId: string
  email: string | null
  role: string
  title: string
  status: string
  avatarUrl: string | null
  /** True for the signed-in user's own row. */
  me: boolean
}

export interface NewThreadInput {
  title?: string | null
  kind?: ThreadKind
  participantIds: string[]
  /** Sent as the first message, when there is one. */
  body?: string | null
}

/** What a send did, including how far the notification got. */
export interface SendResult {
  message: Message
  /** How many people were notified. Zero is normal — nobody may have a phone on. */
  notified: number
  /** Said out loud when the buzz could not be sent. The MESSAGE still landed. */
  notifyProblem: string | null
}

/**
 * The name to show for a conversation.
 *
 * A group keeps the name somebody gave it. A DIRECT thread is named after the
 * other person, computed per reader rather than stored — a stored title would
 * say "Dana Fry" on Dana's own screen, which is the one name it must never be.
 */
export function threadTitle(thread: ThreadSummary, readerId: string): string {
  if (thread.title.trim()) return thread.title.trim()
  if (thread.kind === 'broadcast') return 'Everyone'
  const others = thread.participants.filter((p) => p.employeeId !== readerId)
  if (others.length === 0) return 'Just you'
  if (others.length <= 3) return others.map((p) => p.name).join(', ')
  return `${others[0].name} and ${others.length - 1} others`
}

/**
 * Trim a message to what a notification can carry, on a word where possible.
 *
 * The ellipsis is a real one (U+2026) rather than three dots: three dots is
 * three characters of a budget this is already up against, and the platform
 * renders the single glyph more tightly.
 */
export function pushBody(body: string): string {
  const text = body.replace(/\s+/g, ' ').trim()
  if (text.length <= PUSH_BODY_MAX) return text
  const cut = text.slice(0, PUSH_BODY_MAX)
  const space = cut.lastIndexOf(' ')
  return (space > PUSH_BODY_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd() + '…'
}

/** Why this message cannot be sent, or null. */
export function validateMessage(body: string): string | null {
  const text = (body ?? '').trim()
  if (!text) return 'Type something first.'
  if (text.length > MESSAGE_MAX) {
    return `That is longer than a message can be (${MESSAGE_MAX.toLocaleString()} characters).`
  }
  return null
}

/** Why this conversation cannot be started, or null. */
export function validateThread(input: NewThreadInput): string | null {
  const people = (input.participantIds ?? []).filter((id) => !!id?.trim())
  if (people.length === 0) return 'Pick at least one person.'
  if ((input.title ?? '').length > 120) return 'That name is too long.'
  if (input.body != null && input.body.trim()) return validateMessage(input.body)
  return null
}
