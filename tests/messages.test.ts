/**
 * Messaging: who can see what, and what survives a notification that never
 * arrived.
 *
 * ## The property this whole feature rests on
 *
 * THE MESSAGE IS THE RECORD; THE PUSH IS A DOORBELL. A push notification is
 * unreliable by design, capped at a few kilobytes, and gone the moment somebody
 * swipes it. So every message is an ordinary synced row, and a relay that is
 * down costs the buzz and never the conversation. Section 5 is that assertion,
 * driven through the real IPC handler with the relay unreachable.
 *
 * ## The one that would be a firing offence
 *
 * A conversation somebody was not added to must be invisible to them, and that
 * has to be true at the layer that FETCHES rather than at the screen that
 * renders. Section 3 asks for another person's thread by id, through the
 * registered handler, and insists on the same answer as "no such thread" — not a
 * different one, because "you may not see this" tells somebody it exists.
 *
 * Every name here is invented.
 *
 * Run: npm run test:messages
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/messages-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const { getDb } = require('../src/main/db/database')
const employees = require('../src/main/db/employees')
const auth = require('../src/main/services/auth')
const msgs = require('../src/main/db/messages')
const { registerMessagesIpc } = require('../src/main/messagesIpc')
const { registeredHandlers } = require('../src/main/ipcRegistry')
const { IPC } = require('../src/shared/ipc')
const { pushBody, threadTitle, validateMessage, PUSH_BODY_MAX } = require('../src/shared/messages')
const { permissionsForRole, roleHas } = require('../src/shared/permissions')
const db = getDb()

let pass = 0
let fail = 0
const ok = (c: boolean, n: string, e = ''): void => {
  if (c) {
    pass++
    console.log('  ok   ' + n)
  } else {
    fail++
    console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`)
  }
}

const PASSWORD = 'a-long-enough-password'
const hire = (first: string, companyId: string, role: string): string => {
  const res = employees.insertEmployee(
    {
      firstName: first,
      lastName: 'Invented',
      companyId,
      title: role === 'owner' ? 'Owner' : 'Packer',
      email: role === 'owner' ? `${companyId.toLowerCase()}@example.invalid` : '',
      role,
      status: 'active'
    },
    null,
    PASSWORD,
    false
  )
  return res.employee.id
}

const OWNER = hire('Owen', 'RM-001', 'owner')
const ADA = hire('Ada', 'RM-100', 'shipping')
const BEN = hire('Ben', 'RM-200', 'shipping')
const CAI = hire('Cai', 'RM-300', 'staff')

registerMessagesIpc()
const handler = (channel: string): any => {
  const h = registeredHandlers().get(channel)
  if (!h) throw new Error(`no handler for ${channel}`)
  return h
}
const call = (channel: string, ...args: unknown[]): any =>
  handler(channel)({ sender: null }, ...args)
const signIn = (companyId: string): void => {
  const res = auth.login(companyId, PASSWORD)
  if (!res.ok) throw new Error(`could not sign in ${companyId}: ${res.error}`)
}

const run = async (): Promise<void> => {
  // ---------------------------------------------------------------------------
  console.log('=== 1. being reachable is not a privilege ===')
  // ---------------------------------------------------------------------------
  // Everybody can read and reply. Starting a conversation and buzzing the whole
  // team are the supervisory half, because both put a message in front of
  // somebody who did not ask for it.
  for (const role of ['owner', 'operations', 'staff', 'shipping', 'breaker']) {
    ok(roleHas(role, 'module.messages'), `${role} can be messaged`)
  }
  ok(roleHas('owner', 'messages.broadcast'), 'the owner can start conversations')
  ok(roleHas('operations', 'messages.broadcast'), 'and so can operations')
  ok(!roleHas('shipping', 'messages.broadcast'), 'A PACKER CANNOT BUZZ EVERYBODY')
  ok(!roleHas('staff', 'messages.broadcast'), 'nor can staff')
  ok(
    permissionsForRole('breaker').includes('module.messages'),
    'and the narrowest role on the floor is still reachable'
  )

  // ---------------------------------------------------------------------------
  console.log('\n=== 2. the contact list ===')
  // ---------------------------------------------------------------------------
  signIn('RM-001')
  const contacts = call(IPC.contactsList)
  ok(contacts.length === 4, 'everybody who works here is listed', String(contacts.length))
  ok(contacts.find((c: any) => c.id === OWNER)?.me === true, 'and the reader is marked as themselves')
  ok(
    contacts.find((c: any) => c.id === ADA)?.email === null,
    'an account with no address reports none rather than the placeholder',
    String(contacts.find((c: any) => c.id === ADA)?.email)
  )
  // Somebody who has left should not be in a picker that starts a conversation.
  db.prepare(`UPDATE employees SET status = 'disabled' WHERE id = ?`).run(CAI)
  ok(call(IPC.contactsList).length === 3, 'a disabled account drops out of the list')
  db.prepare(`UPDATE employees SET status = 'active' WHERE id = ?`).run(CAI)

  // ---------------------------------------------------------------------------
  console.log('\n=== 3. a conversation you are not in does not exist ===')
  // ---------------------------------------------------------------------------
  const priv = msgs.createThread(
    { title: 'Owner and Ada', participantIds: [ADA] },
    OWNER
  )
  ok(priv.participants.length === 2, 'a two-person thread has two people', String(priv.participants.length))
  ok(priv.kind === 'direct', 'and is a direct one without being told', priv.kind)

  signIn('RM-200') // Ben, who is not in it
  const stolen = call(IPC.messageThread, priv.id)
  ok(stolen === null, 'ASKING FOR SOMEBODY ELSE’S THREAD BY ID RETURNS NOTHING')
  ok(
    call(IPC.messageThread, 'no-such-thread') === null,
    'and the same answer as a thread that does not exist — the difference would confirm it exists'
  )
  ok(call(IPC.messageThreads).length === 0, "and it is not in Ben's list")
  // Nor can he write into it.
  const intrusion = await call(IPC.messageSend, { threadId: priv.id, body: 'let me in' })
  ok(intrusion.ok === false, 'and he cannot post into it')
  ok(/not in that conversation/i.test(intrusion.error ?? ''), 'saying so plainly', intrusion.error)

  signIn('RM-100') // Ada, who is
  ok(call(IPC.messageThread, priv.id) !== null, 'while Ada, who is in it, can read it')

  // ---------------------------------------------------------------------------
  console.log('\n=== 4. starting one is the supervisory half; replying is not ===')
  // ---------------------------------------------------------------------------
  signIn('RM-100') // a packer
  const refused = await call(IPC.messageThreadCreate, { participantIds: [BEN], body: 'hello' })
  ok(refused.ok === false, 'a packer cannot START a conversation', JSON.stringify(refused))
  const refusedAll = await call(IPC.messageBroadcast, { title: 'x', body: 'y' })
  ok(refusedAll.ok === false, 'nor notify everybody')

  // But she can answer the one she was put in. This is the whole distinction: a
  // conversation you cannot reply to is an announcement.
  const reply = await call(IPC.messageSend, { threadId: priv.id, body: 'On my way.' })
  ok(reply.ok === true, 'AND SHE CAN REPLY IN A THREAD SHE WAS ADDED TO', JSON.stringify(reply))
  ok(reply.data.message.body === 'On my way.', 'with what she said')
  ok(reply.data.message.mine === true, 'flagged as hers')

  // ---------------------------------------------------------------------------
  console.log('\n=== 5. the message lands even when nothing can be notified ===')
  // ---------------------------------------------------------------------------
  // THE PROPERTY THE WHOLE FEATURE RESTS ON. There is no relay configured in a
  // test build, so notifyMessage cannot reach anything — and the conversation is
  // still complete, in order, on both sides.
  signIn('RM-001')
  const sent = await call(IPC.messageSend, { threadId: priv.id, body: 'Can you take the 4pm?' })
  ok(sent.ok === true, 'the send succeeds with no relay at all', JSON.stringify(sent.error))
  ok(sent.data.notified === 0, 'nobody was notified', String(sent.data.notified))
  ok(typeof sent.data.notifyProblem === 'string', 'and it SAYS so rather than implying success')

  signIn('RM-100')
  const asAda = call(IPC.messageThread, priv.id)
  ok(asAda.messages.length === 2, 'Ada has both messages', String(asAda.messages.length))
  ok(asAda.messages[0].body === 'On my way.', 'oldest first')
  ok(asAda.messages[1].body === 'Can you take the 4pm?', 'newest last')
  ok(asAda.messages[1].mine === false, "and the owner's message is not hers")
  ok(asAda.messages[1].authorName === 'Owen Invented', 'with a name on it', asAda.messages[1].authorName)

  // ---------------------------------------------------------------------------
  console.log('\n=== 6. unread counts, and what "read" means ===')
  // ---------------------------------------------------------------------------
  // A message you wrote is not unread to you the moment you send it.
  signIn('RM-001')
  ok(call(IPC.messageUnread) === 0, 'writing a message does not make it unread to the writer')
  signIn('RM-100')
  ok(call(IPC.messageUnread) === 1, "but it IS unread to Ada", String(call(IPC.messageUnread)))
  const beforeRead = call(IPC.messageThreads).find((t: any) => t.id === priv.id)
  ok(beforeRead.unread === 1, 'and the thread says so', String(beforeRead?.unread))
  call(IPC.messageMarkRead, priv.id)
  ok(call(IPC.messageUnread) === 0, 'opening it clears the badge')
  const afterRead = call(IPC.messageThreads).find((t: any) => t.id === priv.id)
  ok(afterRead.unread === 0, 'on the thread too')
  ok(afterRead.lastMessage === 'Can you take the 4pm?', 'and the list previews the last thing said')

  // ---------------------------------------------------------------------------
  console.log('\n=== 7. the whole team, in a thread of its own ===')
  // ---------------------------------------------------------------------------
  signIn('RM-001')
  const all = await call(IPC.messageBroadcast, { title: 'Saturday', body: 'Doors at 9, not 10.' })
  ok(all.ok === true, 'the owner can notify everybody', JSON.stringify(all.error))
  const shout = all.data.thread
  ok(shout.kind === 'broadcast', 'it is a broadcast thread', shout.kind)
  ok(shout.participants.length === 4, 'with everybody in it', String(shout.participants.length))
  ok(all.data.notified === 0, 'nobody was buzzed — no relay in a test build')
  ok(typeof all.data.notifyProblem === 'string', 'and the screen is told why')

  // Everybody can read it, and everybody can answer it.
  signIn('RM-200')
  const bensCopy = call(IPC.messageThread, shout.id)
  ok(bensCopy !== null, 'a packer who was never picked by hand still receives it')
  ok(bensCopy.messages[0].body === 'Doors at 9, not 10.', 'with the announcement in it')
  ok((await call(IPC.messageSend, { threadId: shout.id, body: 'Got it.' })).ok === true, 'and can answer it')

  // A SECOND broadcast is a SECOND thread. Reusing one would file an announcement
  // about Saturday under one about a broken printer.
  signIn('RM-001')
  const second = await call(IPC.messageBroadcast, { title: 'Printer', body: 'The label printer is jammed.' })
  ok(second.data.thread.id !== shout.id, 'EACH BROADCAST IS ITS OWN CONVERSATION')

  // ---------------------------------------------------------------------------
  console.log('\n=== 8. names, trimming and the small rules ===')
  // ---------------------------------------------------------------------------
  // A direct thread is named after the OTHER person, per reader — a stored title
  // would say "Ada Invented" on Ada's own screen.
  const direct = { ...priv, title: '', kind: 'direct' }
  ok(threadTitle(direct, OWNER) === 'Ada Invented', 'a direct thread is named after the other person', threadTitle(direct, OWNER))
  ok(threadTitle(direct, ADA) === 'Owen Invented', 'and reads the other way round for them', threadTitle(direct, ADA))
  ok(threadTitle({ ...priv, title: 'Saturday crew' }, OWNER) === 'Saturday crew', 'a named thread keeps its name')

  // What reaches a lock screen is trimmed here rather than by the platform.
  const long = 'x '.repeat(400)
  ok(pushBody(long).length <= PUSH_BODY_MAX + 1, 'a long message is cut for the notification', String(pushBody(long).length))
  ok(pushBody(long).endsWith('…'), 'with an ellipsis rather than a hard stop')
  ok(pushBody('  hello   there  ') === 'hello there', 'and whitespace is collapsed')
  ok(pushBody('short') === 'short', 'a short one is untouched')

  ok(validateMessage('   ') !== null, 'an empty message is refused')
  ok(validateMessage('hello') === null, 'a real one is not')
  ok(validateMessage('x'.repeat(5000)) !== null, 'and one longer than the cap is refused')

  // ---------------------------------------------------------------------------
  console.log('\n=== 9. leaving, and what leaving does not do ===')
  // ---------------------------------------------------------------------------
  signIn('RM-200')
  ok(call(IPC.messageThreadLeave, shout.id).ok === true, 'Ben can leave the broadcast')
  ok(call(IPC.messageThread, shout.id) === null, 'and stops being able to read it')
  signIn('RM-001')
  const stillThere = call(IPC.messageThread, shout.id)
  ok(stillThere !== null, 'THE THREAD SURVIVES — what he said is not unsaid by him walking away')
  ok(
    stillThere.messages.some((m: any) => m.body === 'Got it.'),
    'and his message is still in it for the people who were told'
  )

  // ---------------------------------------------------------------------------
  console.log('\n=== 10. the tables are synced ===')
  // ---------------------------------------------------------------------------
  // A conversation that lives on one laptop is not a conversation. All three
  // tables have to be in the manifest, or a message written on the desktop never
  // reaches the phone that the notification was sent to.
  const { SYNCED_BY_TABLE } = require('../src/main/db/syncTables')
  for (const table of ['message_threads', 'message_participants', 'messages']) {
    ok(SYNCED_BY_TABLE.has(table), `${table} is in the sync manifest`)
  }
  ok(
    SYNCED_BY_TABLE.get('message_threads').tier < SYNCED_BY_TABLE.get('messages').tier,
    'and the thread lands before the messages that point at it'
  )
  // Two machines adding the same person to the same thread record one fact. Left
  // out of NATURAL_KEYS the second would be quarantined — somebody who silently
  // does not get the message.
  const naturalKeys = require('node:fs').readFileSync('src/main/db/sync.ts', 'utf8')
  ok(
    /message_participants:\s*\[\[\s*'thread_id',\s*'employee_id'\s*\]\]/.test(naturalKeys),
    'and a duplicate participant merges rather than being quarantined'
  )


}

run()
  .catch((err) => {
    fail++
    console.error('\nUNCAUGHT', err)
  })
  .finally(() => {
    console.log(`\n${pass} passed, ${fail} failed\n`)
    process.exit(fail === 0 ? 0 : 1)
  })
