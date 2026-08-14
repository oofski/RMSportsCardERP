import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Contact, ThreadDetail, ThreadSummary } from '@shared/messages'
import { MESSAGE_MAX, threadTitle } from '@shared/messages'
import { Icon } from '../../components/Icon'
import { Avatar, Button, CenterLoader, EmptyState, Input, Modal, Textarea } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { useSession } from '../../lib/session'
import { api } from '../../lib/api'

/**
 * Contacts — everybody who works here, and the conversations you are in.
 *
 * ## Why the roster is the front door
 *
 * The thing somebody opens this for is a PERSON: who works here, and the
 * conversation they are already having with them. Naming the module after the
 * transport would put the list of colleagues one level down inside something
 * called Messages, which is backwards — you pick a name and get a thread, not
 * the other way round.
 *
 * ## The message is the record; the notification is a doorbell
 *
 * Every message is an ordinary synced row. The push is the buzz that says to
 * come and look, and it is reported separately: a send that lands but cannot be
 * notified says so, rather than implying either that it failed or that everybody
 * has been told. A phone that was off costs the buzz and never the conversation.
 *
 * ## Two permissions
 *
 * Everybody can read and REPLY. Starting a conversation and notifying the whole
 * team need `messages.broadcast`, because both put a message in front of
 * somebody who did not ask for it — see @shared/permissions.
 */
type Pane = 'threads' | 'people'

export function ContactsModule(): JSX.Element {
  const { user, can } = useSession()
  const toast = useToast()
  const [pane, setPane] = useState<Pane>('threads')
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null)
  const [contacts, setContacts] = useState<Contact[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [thread, setThread] = useState<ThreadDetail | null>(null)
  const [composing, setComposing] = useState<Contact[] | null>(null)
  const [broadcasting, setBroadcasting] = useState(false)
  const [query, setQuery] = useState('')

  const mayStart = can('messages.broadcast')
  const me = user?.id ?? ''

  const load = useCallback(async (): Promise<void> => {
    const [t, c] = await Promise.all([api.messages.threads(), api.messages.contacts()])
    setThreads(t)
    setContacts(c)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Opening a thread marks it read, so the badge clears the moment somebody
  // looks — which is what "read" means.
  const open = useCallback(
    async (id: string): Promise<void> => {
      setOpenId(id)
      setThread(null)
      const detail = await api.messages.thread(id)
      setThread(detail)
      if (detail) {
        await api.messages.markRead(id)
        void load()
      }
    },
    [load]
  )

  /**
   * A tap on a push notification opens that conversation.
   *
   * The service worker posts the thread id rather than putting it in a URL: this
   * app has no routes, so a query string would be read once at boot and be wrong
   * for the rest of the session.
   */
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const data = e.data as { type?: string; threadId?: string } | null
      if (data?.type === 'rmops-open-thread' && data.threadId) {
        setPane('threads')
        void open(data.threadId)
      }
    }
    navigator.serviceWorker?.addEventListener('message', onMessage)
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage)
  }, [open])

  const shownThreads = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!threads) return []
    if (!q) return threads
    return threads.filter(
      (t) =>
        threadTitle(t, me).toLowerCase().includes(q) ||
        (t.lastMessage ?? '').toLowerCase().includes(q)
    )
  }, [threads, query, me])

  const shownContacts = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!contacts) return []
    if (!q) return contacts
    return contacts.filter((c) =>
      [c.name, c.companyId, c.title, c.email ?? ''].some((v) => v.toLowerCase().includes(q))
    )
  }, [contacts, query])

  if (threads === null || contacts === null) return <CenterLoader />

  return (
    <div className="content-narrow ct-shell">
      <div className="ct-bar">
        <div className="ct-panes">
          <button
            className={`ct-pane ${pane === 'threads' ? 'active' : ''}`}
            onClick={() => setPane('threads')}
          >
            <Icon name="Inbox" size={15} />
            Conversations
            {threads.some((t) => t.unread > 0) && <span className="ct-dot" />}
          </button>
          <button
            className={`ct-pane ${pane === 'people' ? 'active' : ''}`}
            onClick={() => setPane('people')}
          >
            <Icon name="Users" size={15} />
            People
            <span className="ct-n">{contacts.length}</span>
          </button>
        </div>

        <div className="ct-search">
          <Icon name="Search" size={15} />
          <Input
            placeholder={pane === 'threads' ? 'Search conversations…' : 'Name, ID or title…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {mayStart && (
          <div className="ct-actions">
            <Button onClick={() => setComposing([])}>
              <Icon name="Plus" size={15} />
              New conversation
            </Button>
            <Button variant="secondary" onClick={() => setBroadcasting(true)}>
              <Icon name="Radio" size={15} />
              Notify everyone
            </Button>
          </div>
        )}
      </div>

      <div className="ct-body">
        <div className="ct-list">
          {pane === 'threads' ? (
            shownThreads.length === 0 ? (
              <EmptyState
                icon="Inbox"
                title={query ? 'Nothing matches that' : 'No conversations yet'}
                message={
                  mayStart
                    ? 'Start one from the People tab, or with the button above.'
                    : 'You will see conversations here once somebody adds you to one.'
                }
              />
            ) : (
              shownThreads.map((t) => (
                <button
                  key={t.id}
                  className={`ct-thread ${openId === t.id ? 'active' : ''}`}
                  onClick={() => void open(t.id)}
                >
                  <span className="ct-thread-top">
                    <span className="ct-thread-name">
                      {t.kind === 'broadcast' && <Icon name="Radio" size={13} />}
                      {threadTitle(t, me)}
                    </span>
                    {t.unread > 0 && <span className="ct-unread">{t.unread}</span>}
                  </span>
                  <span className="ct-thread-last">{t.lastMessage ?? 'No messages yet.'}</span>
                  <span className="ct-thread-when">{when(t.lastMessageAt ?? t.createdAt)}</span>
                </button>
              ))
            )
          ) : shownContacts.length === 0 ? (
            <EmptyState icon="Users" title="Nobody matches that" message="Try a different name." />
          ) : (
            shownContacts.map((c) => (
              <div key={c.id} className="ct-person">
                <Avatar text={initials(c.name)} src={c.avatarUrl ?? undefined} small />
                <div className="ct-person-id">
                  <div className="ct-person-name">
                    {c.name}
                    {c.me && <span className="ct-you">you</span>}
                  </div>
                  <div className="ct-person-sub">
                    {[c.title, c.companyId].filter(Boolean).join(' · ')}
                    {c.email ? ` · ${c.email}` : ''}
                  </div>
                </div>
                {mayStart && !c.me && (
                  <Button variant="secondary" onClick={() => setComposing([c])}>
                    <Icon name="Send" size={14} />
                    Message
                  </Button>
                )}
              </div>
            ))
          )}
        </div>

        <div className="ct-pane-right">
          {openId === null ? (
            <EmptyState
              icon="Inbox"
              title="Pick a conversation"
              message="Everything said in it is kept here, whether or not a notification got through."
            />
          ) : thread === null ? (
            <CenterLoader />
          ) : (
            <ThreadView
              thread={thread}
              me={me}
              onSent={() => {
                void open(thread.id)
                void load()
              }}
            />
          )}
        </div>
      </div>

      {composing !== null && (
        <ComposeModal
          contacts={contacts.filter((c) => !c.me)}
          preselected={composing}
          onClose={() => setComposing(null)}
          onStarted={(id) => {
            setComposing(null)
            setPane('threads')
            void load().then(() => open(id))
          }}
        />
      )}

      {broadcasting && (
        <BroadcastModal
          count={contacts.length}
          onClose={() => setBroadcasting(false)}
          onSent={(id, notified, problem) => {
            setBroadcasting(false)
            setPane('threads')
            if (problem) toast.error(`Everybody has the message, but no phones were buzzed: ${problem}`)
            else toast.success(`Sent to everyone. ${notified} device${notified === 1 ? '' : 's'} notified.`)
            void load().then(() => open(id))
          }}
        />
      )}
    </div>
  )
}

function ThreadView({
  thread,
  me,
  onSent
}: {
  thread: ThreadDetail
  me: string
  onSent: () => void
}): JSX.Element {
  const toast = useToast()
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const endRef = useRef<HTMLDivElement | null>(null)

  // A conversation opens at the BOTTOM. Anything else means scrolling past
  // everything said before to find what was said last.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [thread.id, thread.messages.length])

  const send = async (): Promise<void> => {
    if (busy || !body.trim()) return
    setBusy(true)
    try {
      const res = await api.messages.send(thread.id, body)
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'That did not send.')
        return
      }
      setBody('')
      // The message landed either way — the notification is the part that can
      // fail on its own, and saying so is more honest than a green tick that
      // implies everybody's phone buzzed.
      if (res.data.notifyProblem) {
        toast.error(`Sent. Nobody could be notified: ${res.data.notifyProblem}`)
      }
      onSent()
    } finally {
      setBusy(false)
    }
  }

  const roster = thread.participants.map((p) => p.name).join(', ')

  return (
    <div className="ct-thread-view">
      <div className="ct-thread-head">
        <div>
          <h2>{threadTitle(thread, me)}</h2>
          {/* A whole-team broadcast lists everybody, so this is clamped to one
              line and the full roster is the tooltip. The header has to stay a
              fixed height — it is the only thing holding the message list's
              scroll box open. */}
          <p title={roster}>{roster}</p>
        </div>
      </div>

      <div className="ct-messages">
        {thread.messages.length === 0 ? (
          <p className="ct-nomsg">Nothing said yet.</p>
        ) : (
          thread.messages.map((m) => (
            <div key={m.id} className={`ct-msg ${m.mine ? 'mine' : ''}`}>
              {!m.mine && <span className="ct-msg-who">{m.authorName}</span>}
              <span className="ct-msg-body">{m.body}</span>
              <span className="ct-msg-when">{when(m.createdAt)}</span>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>

      <div className="ct-compose">
        <Textarea
          rows={2}
          maxLength={MESSAGE_MAX}
          placeholder="Write a message…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a new line. The reverse turns every
            // quick reply into a two-step gesture.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <Button onClick={() => void send()} disabled={busy || !body.trim()}>
          <Icon name="Send" size={15} />
          Send
        </Button>
      </div>
    </div>
  )
}

function ComposeModal({
  contacts,
  preselected,
  onClose,
  onStarted
}: {
  contacts: Contact[]
  preselected: Contact[]
  onClose: () => void
  onStarted: (threadId: string) => void
}): JSX.Element {
  const toast = useToast()
  const [picked, setPicked] = useState<string[]>(preselected.map((c) => c.id))
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)

  const start = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const res = await api.messages.create({ participantIds: picked, title, body })
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'That conversation could not be started.')
        return
      }
      onStarted(res.data.id)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="New conversation"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void start()} disabled={busy || picked.length === 0}>
            Start
          </Button>
        </>
      }
    >
      <div className="ct-pick">
        {contacts.map((c) => (
          <label key={c.id} className={`ct-pick-row ${picked.includes(c.id) ? 'on' : ''}`}>
            <input
              type="checkbox"
              checked={picked.includes(c.id)}
              onChange={(e) =>
                setPicked((list) =>
                  e.target.checked ? [...list, c.id] : list.filter((id) => id !== c.id)
                )
              }
            />
            <span className="ct-pick-name">{c.name}</span>
            <span className="ct-pick-sub">{c.title || c.companyId}</span>
          </label>
        ))}
      </div>
      {/* A name is optional for two people — a direct thread is named after the
          other person, per reader. It earns its place once there are three. */}
      {picked.length > 1 && (
        <Input
          placeholder="Name this conversation (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      )}
      <Textarea
        rows={3}
        maxLength={MESSAGE_MAX}
        placeholder="First message (optional)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
    </Modal>
  )
}

function BroadcastModal({
  count,
  onClose,
  onSent
}: {
  count: number
  onClose: () => void
  onSent: (threadId: string, notified: number, problem: string | null) => void
}): JSX.Element {
  const toast = useToast()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)

  const send = async (): Promise<void> => {
    if (busy || !body.trim()) return
    setBusy(true)
    try {
      const res = await api.messages.broadcast(title, body)
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'That did not send.')
        return
      }
      onSent(res.data.thread.id, res.data.notified, res.data.notifyProblem)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Notify everyone"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void send()} disabled={busy || !body.trim()}>
            Send to all {count}
          </Button>
        </>
      }
    >
      {/* Said plainly, because it reaches every personal phone in the business
          and there is no way to un-send it. */}
      <p className="ct-warn">
        <Icon name="AlertTriangle" size={15} />
        This buzzes the phone of everybody who works here and starts a conversation they can all
        reply to. It cannot be taken back.
      </p>
      <Input
        placeholder="What is this about? (optional)"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <Textarea
        rows={4}
        maxLength={MESSAGE_MAX}
        placeholder="Message"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
    </Modal>
  )
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?'
}

/** A time somebody can read at a glance: today is a clock, older is a date. */
function when(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const today = new Date()
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
