/**
 * The clock-in push notifications, at the level where they can actually be
 * wrong.
 *
 * Everything interesting here is hand-rolled cryptography running inside a file
 * that is PASTED into a dashboard: there is no npm in a Cloudflare Worker, so
 * `web-push` was not an option and RFC 8292 (VAPID) and RFC 8291 (aes128gcm)
 * are implemented by hand against WebCrypto. Hand-rolled crypto fails silently
 * by construction — a wrong byte order produces a request that is accepted with
 * a 201 and a notification the phone quietly cannot open. Nothing errors, no
 * log says anything, and the first evidence is somebody mentioning weeks later
 * that they never get notified.
 *
 * So this suite does not check that the code runs. It checks the two things
 * that would be invisible:
 *
 *   · The JWT verifies against the public half of the key that signed it, and
 *     is raw r||s rather than the DER a Node example would produce.
 *   · The encrypted body DECRYPTS. The test plays the phone: it generates a
 *     subscription key pair, hands the public half to the Worker, and then
 *     performs the RFC 8291 derivation itself to open what came back. If the
 *     key_info ordering, the HKDF salt/ikm argument order or the 0x02 record
 *     delimiter is wrong, this is where it shows.
 *
 * Plus the rules that decide WHETHER to send at all — the transition detection
 * that makes a retried push silent, and the 404/410 reaping without which the
 * subscription table fills with corpses and every punch gets slower forever.
 *
 * No fixture uses a real key or a real person. Every key here is generated at
 * runtime and thrown away; every name is invented.
 *
 * Run: npm run test:push
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/* eslint-disable @typescript-eslint/no-var-requires */
// The Worker itself, not a reimplementation of it. Named exports exist on that
// file purely so this suite can reach them.
const worker = require('../cloud/worker.js')
const {
  b64urlFromBytes,
  bytesFromB64url,
  buildClockPayload,
  clockTransition,
  deliverPush,
  encryptWebPushPayload,
  isDeadPushStatus,
  sendOnePush,
  signVapidJwt,
  vapidAudience,
  vapidAuthorizationHeader,
  vapidPublicKey,
  vapidSigningKey,
  vapidSubject,
  PUSH_MAX_PLAINTEXT,
  PUSH_RECORD_SIZE,
  VAPID_PUBLIC_KEY_DEFAULT,
  VAPID_SUBJECT_DEFAULT
} = worker

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
const threw = async (fn: () => Promise<unknown>): Promise<string | null> => {
  try {
    await fn()
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

const enc = new TextEncoder()
const dec = new TextDecoder()

// ---------------------------------------------------------------------------
// A throwaway VAPID identity, minted here and gone when the process exits.
// ---------------------------------------------------------------------------
interface TestVapid {
  env: { VAPID_PRIVATE_KEY: string; VAPID_PUBLIC_KEY: string }
  publicKey: CryptoKey
}

async function makeVapid(): Promise<TestVapid> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify'
  ])) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  return {
    env: { VAPID_PRIVATE_KEY: String(jwk.d), VAPID_PUBLIC_KEY: b64urlFromBytes(raw) },
    publicKey: pair.publicKey
  }
}

// ---------------------------------------------------------------------------
// A throwaway "phone": exactly what a browser hands to pushManager.subscribe.
// ---------------------------------------------------------------------------
interface TestPhone {
  endpoint: string
  p256dh: string
  auth: string
  privateKey: CryptoKey
  publicBytes: Uint8Array
  authBytes: Uint8Array
}

async function makePhone(endpoint: string): Promise<TestPhone> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits'
  ])) as CryptoKeyPair
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const authBytes = crypto.getRandomValues(new Uint8Array(16))
  return {
    endpoint,
    p256dh: b64urlFromBytes(publicBytes),
    auth: b64urlFromBytes(authBytes),
    privateKey: pair.privateKey,
    publicBytes,
    authBytes
  }
}

/**
 * The receiving half of RFC 8291, written independently of the Worker's.
 *
 * Deliberately NOT sharing helpers with the code under test: a shared
 * concat/HKDF that had the arguments backwards would be backwards on both
 * sides and the round trip would pass while no real phone could read a thing.
 */
async function hmac(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign'
  ])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, message))
}

function join8(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

async function decryptAsPhone(phone: TestPhone, body: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16)
  const recordSize = (body[16] << 24) | (body[17] << 16) | (body[18] << 8) | body[19]
  const idLength = body[20]
  const serverPublic = body.slice(21, 21 + idLength)
  const ciphertext = body.slice(21 + idLength)
  if (recordSize !== PUSH_RECORD_SIZE) throw new Error(`record size ${recordSize}`)
  if (idLength !== 65) throw new Error(`key id length ${idLength}`)

  const serverKey = await crypto.subtle.importKey(
    'raw',
    serverPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  )
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: serverKey }, phone.privateKey, 256)
  )
  const keyInfo = join8(
    enc.encode('WebPush: info'),
    new Uint8Array([0]),
    phone.publicBytes,
    serverPublic
  )
  const ikm = (await hmac(await hmac(phone.authBytes, shared), join8(keyInfo, new Uint8Array([1])))).slice(0, 32)
  const prk = await hmac(salt, ikm)
  const cek = (
    await hmac(prk, join8(enc.encode('Content-Encoding: aes128gcm'), new Uint8Array([0, 1])))
  ).slice(0, 16)
  const nonce = (
    await hmac(prk, join8(enc.encode('Content-Encoding: nonce'), new Uint8Array([0, 1])))
  ).slice(0, 12)

  const key = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt'])
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, ciphertext)
  )
  if (padded[padded.length - 1] !== 2) throw new Error('missing the last-record delimiter')
  return dec.decode(padded.slice(0, padded.length - 1))
}

// ===========================================================================
void (async () => {
  // -------------------------------------------------------------------------
  console.log('=== 1. base64url, both directions and both alphabets ===')
  // -------------------------------------------------------------------------
  const sample = crypto.getRandomValues(new Uint8Array(65))
  const encoded = b64urlFromBytes(sample)
  ok(!/[+/=]/.test(encoded), 'no +, / or = survives the encoding', encoded.slice(0, 12))
  ok(
    Buffer.from(bytesFromB64url(encoded)).equals(Buffer.from(sample)),
    '65 random bytes round-trip exactly'
  )
  // Browsers hand these keys over as ArrayBuffers and whoever encodes them picks
  // an alphabet. Both have to decode or a subscription silently stores garbage.
  const standard = Buffer.from(sample).toString('base64')
  ok(
    Buffer.from(bytesFromB64url(standard)).equals(Buffer.from(sample)),
    'and standard base64 with padding decodes to the same bytes'
  )

  // -------------------------------------------------------------------------
  console.log('\n=== 2. the VAPID audience is an ORIGIN, never the endpoint ===')
  // -------------------------------------------------------------------------
  // The single commonest way a hand-rolled VAPID implementation fails: a token
  // whose aud carries the path is rejected with a bare 401 and no explanation.
  ok(
    vapidAudience('https://web.push.apple.com/AbCdEf/123?x=1') === 'https://web.push.apple.com',
    'the path and query are dropped',
    vapidAudience('https://web.push.apple.com/AbCdEf/123?x=1')
  )
  ok(
    vapidAudience('https://fcm.googleapis.com/fcm/send/abc123') === 'https://fcm.googleapis.com',
    'and the same for Google'
  )
  ok((await threw(async () => vapidAudience('http://insecure.example/x'))) !== null, 'http is refused')
  ok((await threw(async () => vapidAudience('not a url'))) !== null, 'and so is nonsense')

  // -------------------------------------------------------------------------
  console.log('\n=== 3. the VAPID JWT verifies against its own public key ===')
  // -------------------------------------------------------------------------
  const vapid = await makeVapid()
  const signingKey = await vapidSigningKey(vapid.env)
  const expiresAt = Math.floor(Date.now() / 1000) + 12 * 60 * 60
  const jwt = await signVapidJwt(signingKey, {
    audience: 'https://fcm.googleapis.com',
    subject: 'mailto:nobody@example.invalid',
    expiresAtSeconds: expiresAt
  })

  const parts = jwt.split('.')
  ok(parts.length === 3, 'three dot-separated segments', String(parts.length))
  const header = JSON.parse(dec.decode(bytesFromB64url(parts[0])))
  const claims = JSON.parse(dec.decode(bytesFromB64url(parts[1])))
  ok(header.alg === 'ES256', 'alg is ES256', String(header.alg))
  ok(header.typ === 'JWT', 'typ is JWT', String(header.typ))
  ok(claims.aud === 'https://fcm.googleapis.com', 'aud is the push service origin', String(claims.aud))
  ok(claims.sub === 'mailto:nobody@example.invalid', 'sub is carried through')
  ok(claims.exp === expiresAt, 'exp is the expiry it was given')
  // RFC 8292 refuses a token good for more than 24 hours.
  ok(claims.exp - Math.floor(Date.now() / 1000) <= 86400, 'and is inside the 24h ceiling')

  const signature = bytesFromB64url(parts[2])
  // WebCrypto already produces raw r||s. Code copied from a Node example
  // unwraps a DER SEQUENCE, and doing that here would corrupt a good signature
  // — visible only as a 401 from a push service.
  ok(signature.length === 64, 'the signature is raw r||s, not DER', `${signature.length} bytes`)
  const verified = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    vapid.publicKey,
    signature,
    enc.encode(`${parts[0]}.${parts[1]}`)
  )
  ok(verified, 'and it verifies against the public half of the pair that signed it')

  const tampered = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    vapid.publicKey,
    signature,
    enc.encode(`${parts[0]}.${parts[1]}x`)
  )
  ok(!tampered, 'a single changed byte of the signing input breaks it')

  // A second, unrelated identity must not be able to pass off this token.
  const other = await makeVapid()
  ok(
    !(await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      other.publicKey,
      signature,
      enc.encode(`${parts[0]}.${parts[1]}`)
    )),
    'and a different key pair does not verify it'
  )

  ok(
    vapidAuthorizationHeader('TOKEN', 'PUBKEY') === 'vapid t=TOKEN, k=PUBKEY',
    'the Authorization header is the RFC 8292 shape',
    vapidAuthorizationHeader('TOKEN', 'PUBKEY')
  )

  // -------------------------------------------------------------------------
  console.log('\n=== 4. a missing private key says exactly what to do ===')
  // -------------------------------------------------------------------------
  // The worst failure this feature has: everything upstream succeeds, the
  // toggle reads as on, and every shift goes unannounced. It must never be a
  // vague error.
  const missing = await threw(async () => vapidSigningKey({ VAPID_PUBLIC_KEY: vapid.env.VAPID_PUBLIC_KEY }))
  ok(missing !== null, 'no private key is an error, not a silent no-op')
  ok(String(missing).includes('VAPID_PRIVATE_KEY'), 'the message names the variable', String(missing))
  ok(String(missing).includes('Secret'), 'and says where it goes')
  const shortKey = await threw(async () =>
    vapidSigningKey({ VAPID_PRIVATE_KEY: b64urlFromBytes(new Uint8Array(8)), VAPID_PUBLIC_KEY: vapid.env.VAPID_PUBLIC_KEY })
  )
  ok(String(shortKey).includes('32'), 'a wrong-length private key says how long it should be', String(shortKey))

  // -------------------------------------------------------------------------
  console.log('\n=== 5. the subject is validated, not trusted ===')
  // -------------------------------------------------------------------------
  // A malformed subject is rejected by some push services as a 400 on the
  // notification itself, and nothing in that chain mentions the subject.
  ok(vapidSubject({}) === VAPID_SUBJECT_DEFAULT, 'unset falls back to the default')
  ok(
    vapidSubject({ VAPID_SUBJECT: 'mailto:ops@example.invalid' }) === 'mailto:ops@example.invalid',
    'a well-formed mailto is used as given'
  )
  ok(
    vapidSubject({ VAPID_SUBJECT: 'https://relay.example.invalid' }) === 'https://relay.example.invalid',
    'and so is an https URI'
  )
  for (const bad of [
    'mailto: ops@example.invalid',
    '<mailto:ops@example.invalid>',
    'mailto:Ops <ops@example.invalid>',
    'ops@example.invalid',
    'http://relay.example.invalid',
    'mailto:notanaddress'
  ]) {
    ok(
      vapidSubject({ VAPID_SUBJECT: bad }) === VAPID_SUBJECT_DEFAULT,
      `refused and replaced with the default: ${JSON.stringify(bad)}`
    )
  }
  ok(
    VAPID_SUBJECT_DEFAULT.startsWith('mailto:') && !VAPID_SUBJECT_DEFAULT.includes(' '),
    'the default itself is well-formed',
    VAPID_SUBJECT_DEFAULT
  )

  // -------------------------------------------------------------------------
  console.log('\n=== 6. the committed public key is a real P-256 point ===')
  // -------------------------------------------------------------------------
  const committed = bytesFromB64url(VAPID_PUBLIC_KEY_DEFAULT)
  ok(committed.length === 65, 'it is 65 bytes', String(committed.length))
  ok(committed[0] === 0x04, 'and uncompressed (leading 0x04)')
  // Proves it is on the curve: importKey rejects a point that is not.
  const importedCommitted = await threw(async () =>
    crypto.subtle.importKey('raw', committed, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  )
  ok(importedCommitted === null, 'and WebCrypto accepts it as a curve point', String(importedCommitted))
  ok(vapidPublicKey({}) === VAPID_PUBLIC_KEY_DEFAULT, 'it is what the Worker serves by default')
  ok(
    vapidPublicKey({ VAPID_PUBLIC_KEY: 'OVERRIDE' }) === 'OVERRIDE',
    'and a variable can still override it for a rotation'
  )

  // THE thing that must never be true of this repository.
  const workerSrc = readFileSync(join(process.cwd(), 'cloud/worker.js'), 'utf8')
  ok(
    !/VAPID_PRIVATE_KEY\s*=\s*['"][A-Za-z0-9_-]{20,}/.test(workerSrc),
    'no private key is assigned a literal value anywhere in the Worker'
  )
  ok(
    workerSrc.includes('env.VAPID_PRIVATE_KEY'),
    'the private key is only ever read from the environment'
  )

  // -------------------------------------------------------------------------
  console.log('\n=== 7. the encrypted body is one a phone can actually open ===')
  // -------------------------------------------------------------------------
  const phone = await makePhone('https://fcm.googleapis.com/fcm/send/test-1')
  const message = JSON.stringify({ v: 1, kind: 'in', name: 'Marisol Vandenberg', at: '2026-08-10T14:03:11.000Z' })
  const body = await encryptWebPushPayload({
    plaintext: enc.encode(message),
    p256dh: phone.p256dh,
    auth: phone.auth
  })
  ok(body instanceof Uint8Array, 'encryption returns bytes')
  ok(body.length > 21 + 65, 'with a header, a key id and a ciphertext', String(body.length))
  const opened = await threw(async () => {
    const text = await decryptAsPhone(phone, body)
    if (text !== message) throw new Error(`decrypted to ${text}`)
    return text
  })
  ok(opened === null, 'AND THE PHONE CAN DECRYPT IT BACK TO THE EXACT PAYLOAD', String(opened))

  // Every push must use a fresh ephemeral key and a fresh salt. Reusing either
  // reuses an AES-GCM key/nonce pair, which is the one thing GCM does not
  // survive — and it is invisible, because both messages still decrypt.
  const second = await encryptWebPushPayload({
    plaintext: enc.encode(message),
    p256dh: phone.p256dh,
    auth: phone.auth
  })
  ok(
    !Buffer.from(body.slice(0, 16)).equals(Buffer.from(second.slice(0, 16))),
    'a second push of the same text uses a different salt'
  )
  ok(
    !Buffer.from(body.slice(21, 86)).equals(Buffer.from(second.slice(21, 86))),
    'and a different ephemeral public key'
  )
  ok(
    !Buffer.from(body.slice(86)).equals(Buffer.from(second.slice(86))),
    'so the ciphertext differs too'
  )
  ok((await decryptAsPhone(phone, second)) === message, 'and the second one still decrypts')

  // A different phone must not be able to read it. This is the privacy claim
  // the whole feature exists for, reduced to one assertion.
  const eavesdropper = await makePhone('https://fcm.googleapis.com/fcm/send/test-2')
  ok(
    (await threw(async () => decryptAsPhone(eavesdropper, body))) !== null,
    'another subscription cannot decrypt it'
  )

  // Malformed keys are refused at encryption time rather than producing a body
  // nobody can open.
  ok(
    (await threw(async () =>
      encryptWebPushPayload({ plaintext: enc.encode('x'), p256dh: b64urlFromBytes(new Uint8Array(32)), auth: phone.auth })
    )) !== null,
    'a p256dh that is not 65 bytes is refused'
  )
  ok(
    (await threw(async () =>
      encryptWebPushPayload({ plaintext: enc.encode('x'), p256dh: phone.p256dh, auth: b64urlFromBytes(new Uint8Array(8)) })
    )) !== null,
    'an auth secret that is not 16 bytes is refused'
  )
  ok(
    (await threw(async () =>
      encryptWebPushPayload({
        plaintext: new Uint8Array(PUSH_MAX_PLAINTEXT + 1),
        p256dh: phone.p256dh,
        auth: phone.auth
      })
    )) !== null,
    'and a payload past the single-record ceiling is refused rather than truncated'
  )
  ok(
    (await threw(async () =>
      encryptWebPushPayload({
        plaintext: new Uint8Array(PUSH_MAX_PLAINTEXT),
        p256dh: phone.p256dh,
        auth: phone.auth
      })
    )) === null,
    'exactly at the ceiling is fine'
  )

  // -------------------------------------------------------------------------
  console.log('\n=== 8. the request that goes on the wire ===')
  // -------------------------------------------------------------------------
  const realFetch = globalThis.fetch
  let captured: { url: string; headers: Record<string, string>; body: Uint8Array } | null = null
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured = {
      url: String(url),
      headers: init.headers as Record<string, string>,
      body: init.body as Uint8Array
    }
    return { status: 201 } as Response
  }) as unknown as typeof fetch
  try {
    const status = await sendOnePush(vapid.env, phone, enc.encode(message))
    ok(status === 201, 'the status is handed back untouched', String(status))
  } finally {
    globalThis.fetch = realFetch
  }
  const sent = captured as unknown as { url: string; headers: Record<string, string>; body: Uint8Array }
  ok(sent.url === phone.endpoint, 'posted to the subscription endpoint itself')
  ok(sent.headers['content-encoding'] === 'aes128gcm', 'declares aes128gcm')
  ok(sent.headers['content-type'] === 'application/octet-stream', 'as binary')
  ok(Number(sent.headers.ttl) > 0, 'with a TTL', String(sent.headers.ttl))
  ok(sent.headers.urgency === 'normal', 'and normal urgency, so it does not wake a sleeping phone')
  const auth = String(sent.headers.authorization)
  ok(auth.startsWith('vapid t='), 'the Authorization header is a VAPID one', auth.slice(0, 20))
  ok(auth.includes(`, k=${vapid.env.VAPID_PUBLIC_KEY}`), 'carrying the public key the JWT was signed with')
  const wireClaims = JSON.parse(dec.decode(bytesFromB64url(auth.split('t=')[1].split(',')[0].split('.')[1])))
  ok(wireClaims.aud === 'https://fcm.googleapis.com', 'audience is the service origin', String(wireClaims.aud))
  ok(wireClaims.sub === VAPID_SUBJECT_DEFAULT, 'subject is the configured contact', String(wireClaims.sub))
  ok(
    wireClaims.exp - Math.floor(Date.now() / 1000) <= 86400 &&
      wireClaims.exp > Math.floor(Date.now() / 1000),
    'expiry is in the future and inside 24h'
  )
  ok((await decryptAsPhone(phone, sent.body)) === message, 'and the body on the wire decrypts')

  // -------------------------------------------------------------------------
  console.log('\n=== 9. what counts as a punch ===')
  // -------------------------------------------------------------------------
  const open = { employee_id: 'e1', clock_in: '2026-08-10T14:00:00.000Z', clock_out: null }
  const closed = { ...open, clock_out: '2026-08-10T22:00:00.000Z' }
  ok(clockTransition(null, open) === 'in', 'a new open entry is a clock-in')
  ok(clockTransition(open, closed) === 'out', 'closing an open entry is a clock-out')
  // Idempotence. The sync loop retries pushes on any error and ten laptops each
  // pull the same row; without this, one shift notifies the whole company
  // repeatedly.
  ok(clockTransition(open, open) === null, 'the same open row pushed twice is silent')
  ok(clockTransition(closed, closed) === null, 'and so is the same closed row')
  ok(
    clockTransition(closed, { ...closed, note: 'fixed the tape gun' }) === null,
    'editing a note on a finished shift is not a punch'
  )
  ok(
    clockTransition(
      { employee_id: 'e1', clock_in: '2026-08-01T09:00:00.000Z', clock_out: '2026-08-01T17:00:00.000Z' },
      { employee_id: 'e1', clock_in: '2026-08-01T09:00:00.000Z', clock_out: '2026-08-01T17:30:00.000Z' }
    ) === null,
    'an admin correcting last week is not a punch either'
  )
  ok(clockTransition(null, closed) === null, 'a whole finished shift arriving at once stays quiet')
  ok(clockTransition(open, null) === null, 'a deleted entry is not a punch')
  ok(clockTransition(null, null) === null, 'and nothing at all is nothing')
  ok(clockTransition(null, { employee_id: 'e1', clock_in: null }) === null, 'a row with no clock-in is not one')

  // -------------------------------------------------------------------------
  console.log('\n=== 10. dead subscriptions are reaped, live ones are kept ===')
  // -------------------------------------------------------------------------
  ok(isDeadPushStatus(404), '404 is dead')
  ok(isDeadPushStatus(410), '410 is dead')
  for (const alive of [200, 201, 202, 400, 401, 413, 429, 500, 502, 503]) {
    ok(!isDeadPushStatus(alive), `${alive} is NOT a reason to delete a real phone`)
  }

  const statuses: Record<string, number> = { good: 201, gone: 410, missing: 404, wobble: 500 }
  const dropped: string[] = []
  const outcome = await deliverPush({
    subscriptions: [
      { endpoint: 'good' },
      { endpoint: 'gone' },
      { endpoint: 'missing' },
      { endpoint: 'wobble' }
    ],
    send: async (s: { endpoint: string }) => statuses[s.endpoint],
    drop: async (endpoint: string) => {
      dropped.push(endpoint)
    }
  })
  ok(outcome.sent === 1, 'one delivered', JSON.stringify(outcome))
  ok(outcome.dropped === 2, 'two reaped')
  ok(outcome.failed === 1, 'one counted as a failure and left alone')
  ok(dropped.join(',') === 'gone,missing', 'exactly the 410 and the 404 were deleted', dropped.join(','))
  ok(!dropped.includes('wobble'), 'a 500 does NOT cost somebody their notifications')

  const thrownDropped: string[] = []
  const thrownOutcome = await deliverPush({
    subscriptions: [{ endpoint: 'offline' }],
    send: async () => {
      throw new Error('network down')
    },
    drop: async (endpoint: string) => {
      thrownDropped.push(endpoint)
    }
  })
  ok(thrownOutcome.failed === 1, 'a thrown fetch counts as a failure')
  ok(thrownDropped.length === 0, 'and is not evidence the subscription is dead')

  // One bad subscription must not stop the ones after it.
  const order: string[] = []
  await deliverPush({
    subscriptions: [{ endpoint: 'a' }, { endpoint: 'b' }, { endpoint: 'c' }],
    send: async (s: { endpoint: string }) => {
      order.push(s.endpoint)
      if (s.endpoint === 'a') throw new Error('boom')
      return 410
    },
    drop: async () => {}
  })
  ok(order.join('') === 'abc', 'every subscription is attempted even after one throws', order.join(''))

  // -------------------------------------------------------------------------
  console.log('\n=== 11. the payload keeps a UTC instant an instant ===')
  // -------------------------------------------------------------------------
  // A clock-in is a physical event with a UTC timestamp; a wall-clock time is a
  // local intention. The Worker has no idea what timezone the phone is in, so
  // it must pass the instant through and let the service worker format it.
  const instant = '2026-08-10T02:30:00.000Z'
  const payload = buildClockPayload({ kind: 'in', name: 'Marisol Vandenberg', at: instant, place: 'Warehouse' })
  ok(payload.at === instant, 'the instant is byte-identical to what went in', payload.at)
  ok(payload.at.endsWith('Z'), 'still UTC')
  ok(payload.kind === 'in', 'the direction is carried')
  ok(payload.name === 'Marisol Vandenberg', 'and the name')
  ok(payload.place === 'Warehouse', 'and the place when there is one')
  ok(payload.v === 1, 'versioned, so an old service worker can tell')
  ok(
    !JSON.stringify(payload).includes('2026-08-09') && !JSON.stringify(payload).includes('10:30'),
    'nothing anywhere has been converted to a local date or time'
  )
  ok(buildClockPayload({ kind: 'out', name: 'A', at: instant }).kind === 'out', 'out is out')
  ok(
    buildClockPayload({ kind: 'nonsense', name: 'A', at: instant }).kind === 'in',
    'anything else reads as in rather than as a third state the phone cannot render'
  )
  ok(buildClockPayload({ at: instant }).name === 'Someone', 'a missing name has a readable fallback')
  ok(
    buildClockPayload({ kind: 'in', name: 'x'.repeat(500), at: instant }).name.length === 80,
    'a long name is cut rather than blowing the single-record ceiling'
  )
  ok(buildClockPayload({ kind: 'in', name: 'A', at: instant }).place === null, 'no place is null, not undefined')

  // The whole point of doing this ourselves: the payload holds a real name, and
  // it is only ever readable by the phone it was encrypted for.
  const namedBody = await encryptWebPushPayload({
    plaintext: enc.encode(JSON.stringify(payload)),
    p256dh: phone.p256dh,
    auth: phone.auth
  })
  ok(
    !Buffer.from(namedBody).includes(Buffer.from('Marisol')),
    'the name does not appear in the bytes the push service carries'
  )
  ok(
    JSON.parse(await decryptAsPhone(phone, namedBody)).name === 'Marisol Vandenberg',
    'but the phone reads it back in full'
  )

  console.log(`\n${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
})()
