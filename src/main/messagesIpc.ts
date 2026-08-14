import { ipcMain } from './ipcRegistry'
import { IPC } from '@shared/ipc'
import type { Result } from '@shared/types'
import type { Permission } from '@shared/permissions'
import type {
  Contact,
  NewThreadInput,
  SendResult,
  ThreadDetail,
  ThreadSummary
} from '@shared/messages'
import { pushBody, threadTitle } from '@shared/messages'
import { currentUser } from './services/auth'
import {
  addToThread,
  createBroadcast,
  createThread,
  getThread,
  leaveThread,
  listContacts,
  listThreads,
  markRead,
  postMessage,
  unreadCount
} from './db/messages'
import { notifyMessage } from './services/webPush'

/**
 * Messages, and the contact list they are addressed from.
 *
 * ## Two permissions, and the split is the design
 *
 * `module.messages` is ordinary and everybody has it: read the conversations you
 * are in, reply to them, see who works here. Being reachable is not a privilege.
 *
 * `messages.broadcast` is supervisory: START a conversation with anyone, and
 * buzz the whole team at once. That reaches every personal phone in the
 * business, and the fastest way to teach people to turn notifications off is to
 * let anybody use it for anything.
 *
 * REPLYING IS NOT GATED BY IT. Somebody was put in that thread deliberately, and
 * a conversation you cannot answer is an announcement — which is the other
 * feature, and it has its own permission.
 *
 * ## The write happens before the buzz, always
 *
 * Every send commits the message and only then asks the relay to notify. A dead
 * relay costs the notification and never the message, which is what makes this
 * usable on a laptop with notifications switched off and on a phone that was in
 * a locker. The push result is REPORTED back rather than swallowed, so a screen
 * can say "sent, but nobody could be notified" instead of implying either half.
 */

class PermissionError extends Error {}

function requireMessages(): { id: string } {
  const user = currentUser()
  if (!user) throw new PermissionError('You are not signed in.')
  if (!user.permissions.includes('module.messages')) {
    throw new PermissionError('You do not have permission to use messages.')
  }
  return { id: user.id }
}

function require_(permission: Permission): { id: string } {
  const user = requireMessages()
  const full = currentUser()
  if (!full || !full.permissions.includes(permission)) {
    throw new PermissionError('You do not have permission to do that.')
  }
  return user
}

function can(): boolean {
  const user = currentUser()
  return !!user && user.permissions.includes('module.messages')
}

function fail(err: unknown): Result<never> {
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

/**
 * Buzz everybody in a thread except the person who just wrote.
 *
 * The title is what the RECIPIENT should see, which is not always what the
 * sender's screen says: a direct thread has no stored name, so it is rendered
 * per reader. A group keeps its name. A broadcast says so.
 */
async function buzz(
  thread: { id: string; title: string; kind: string },
  authorName: string,
  body: string,
  employeeIds: string[]
): Promise<{ notified: number; problem: string | null }> {
  const named = thread.title.trim()
  const title =
    thread.kind === 'broadcast'
      ? named || 'Everyone'
      : named
        ? `${authorName} · ${named}`
        : authorName
  return notifyMessage({ employeeIds, title, body: pushBody(body), threadId: thread.id })
}

export function registerMessagesIpc(): void {
  // ---- The contact list ---------------------------------------------------
  ipcMain.handle(IPC.contactsList, (): Contact[] => {
    const user = currentUser()
    return can() ? listContacts(user?.id ?? null) : []
  })

  // ---- Conversations ------------------------------------------------------
  ipcMain.handle(IPC.messageThreads, (): ThreadSummary[] => {
    const user = currentUser()
    return can() && user ? listThreads(user.id) : []
  })

  ipcMain.handle(IPC.messageUnread, (): number => {
    const user = currentUser()
    return can() && user ? unreadCount(user.id) : 0
  })

  ipcMain.handle(IPC.messageThread, (_e, id: unknown): ThreadDetail | null => {
    const user = currentUser()
    if (!can() || !user) return null
    return getThread(String(id ?? ''), user.id)
  })

  /**
   * Starting a conversation needs `messages.broadcast`.
   *
   * The name of the permission is about reach rather than about the button: what
   * both it and the whole-team notification do is put a message in front of
   * somebody who did not ask for it. Replying inside a thread is the unprivileged
   * half, and it is a different handler.
   */
  ipcMain.handle(
    IPC.messageThreadCreate,
    async (_e, input: NewThreadInput): Promise<Result<ThreadSummary>> => {
      try {
        const actor = require_('messages.broadcast')
        const thread = createThread(input, actor.id)
        // An opening message is optional. When there is one it goes through the
        // ordinary send path, so it is buzzed exactly like every reply.
        const body = (input.body ?? '').trim()
        if (body) {
          const posted = postMessage(thread.id, body, actor.id)
          await buzz(thread, posted.message.authorName, body, posted.notify)
        }
        return { ok: true, data: listThreads(actor.id).find((t) => t.id === thread.id) ?? thread }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.messageBroadcast,
    async (
      _e,
      payload: { title?: unknown; body?: unknown }
    ): Promise<Result<{ thread: ThreadSummary; notified: number; notifyProblem: string | null }>> => {
      try {
        const actor = require_('messages.broadcast')
        const body = String(payload?.body ?? '')
        const thread = createBroadcast(String(payload?.title ?? ''), body, actor.id)
        const posted = postMessage(thread.id, body, actor.id)
        const sent = await buzz(thread, posted.message.authorName, body, posted.notify)
        return {
          ok: true,
          data: {
            thread: listThreads(actor.id).find((t) => t.id === thread.id) ?? thread,
            notified: sent.notified,
            notifyProblem: sent.problem
          }
        }
      } catch (err) {
        return fail(err)
      }
    }
  )

  /**
   * Say something in a thread you are already in.
   *
   * `module.messages` only. The membership check is in the repo and is the real
   * guard: a thread somebody was not added to refuses the write regardless of
   * what permission they hold.
   */
  ipcMain.handle(
    IPC.messageSend,
    async (_e, payload: { threadId?: unknown; body?: unknown }): Promise<Result<SendResult>> => {
      try {
        const actor = requireMessages()
        const threadId = String(payload?.threadId ?? '')
        const posted = postMessage(threadId, String(payload?.body ?? ''), actor.id)
        const thread = getThread(threadId, actor.id)
        const sent = thread
          ? await buzz(thread, posted.message.authorName, posted.message.body, posted.notify)
          : { notified: 0, problem: null }
        return {
          ok: true,
          data: { message: posted.message, notified: sent.notified, notifyProblem: sent.problem }
        }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.messageMarkRead, (_e, id: unknown): Result => {
    try {
      const actor = requireMessages()
      markRead(String(id ?? ''), actor.id)
      return { ok: true }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    IPC.messageThreadAdd,
    (_e, payload: { threadId?: unknown; employeeIds?: unknown }): Result<ThreadSummary> => {
      try {
        const actor = require_('messages.broadcast')
        const ids = Array.isArray(payload?.employeeIds) ? payload.employeeIds.map(String) : []
        return { ok: true, data: addToThread(String(payload?.threadId ?? ''), ids, actor.id) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.messageThreadLeave, (_e, id: unknown): Result => {
    try {
      const actor = requireMessages()
      leaveThread(String(id ?? ''), actor.id)
      return { ok: true }
    } catch (err) {
      return fail(err)
    }
  })
}

/** Exported for the tests: the title a recipient sees. */
export { threadTitle }
