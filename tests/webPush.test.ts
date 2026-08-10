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
 * ## And then the half of this feature that is not cryptography at all
 *
 * Sections 12 to 15 cover the INSTALL, which fails in a way that is easy to
 * mistake for the crypto failing. On iOS, web push works only for a site that
 * has been added to the Home Screen, and iOS will only add it as an APP — as
 * opposed to a bookmark that opens in a Safari tab — when the manifest is
 * present, readable, and served as a manifest. Get any of that wrong and the
 * toggle is missing, or present and dead, with nothing anywhere naming the
 * cause. So:
 *
 *   12. the manifest and the icon files it points at are real, the right sizes,
 *       and the maskable one is genuinely opaque;
 *   13. the HTML actually links them, and its CSP permits a service worker;
 *   14. the server serves each of them with the content type and cache headers
 *       that decide whether a browser will accept them at all;
 *   15. the service worker draws the notification and, when tapped, focuses the
 *       window that is already open instead of stacking up another one.
 *
 * No fixture uses a real key or a real person. Every key here is generated at
 * runtime and thrown away; every name is invented.
 *
 * Run: npm run test:push
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  notifyTargets,
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
  // nobody can open. The MESSAGE is asserted, not just the throw: WebCrypto
  // rejects a bad curve point too, with "The operation failed for an
  // operation-specific reason", which names nothing and sends whoever reads it
  // looking in the wrong place.
  const badPoint = await threw(async () =>
    encryptWebPushPayload({ plaintext: enc.encode('x'), p256dh: b64urlFromBytes(new Uint8Array(32)), auth: phone.auth })
  )
  ok(badPoint !== null, 'a p256dh that is not 65 bytes is refused')
  ok(String(badPoint).includes('p256dh'), 'and the error names the field', String(badPoint))
  const badAuth = await threw(async () =>
    encryptWebPushPayload({ plaintext: enc.encode('x'), p256dh: phone.p256dh, auth: b64urlFromBytes(new Uint8Array(8)) })
  )
  ok(badAuth !== null, 'an auth secret that is not 16 bytes is refused')
  ok(String(badAuth).includes('auth secret'), 'and that error names its field too', String(badAuth))
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
  const touched: string[] = []
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
    },
    touch: async (endpoint: string) => {
      touched.push(endpoint)
    }
  })
  ok(outcome.sent === 1, 'one delivered', JSON.stringify(outcome))
  ok(outcome.dropped === 2, 'two reaped')
  ok(outcome.failed === 1, 'one counted as a failure and left alone')
  ok(dropped.join(',') === 'gone,missing', 'exactly the 410 and the 404 were deleted', dropped.join(','))
  ok(!dropped.includes('wobble'), 'a 500 does NOT cost somebody their notifications')

  // "Last notified" is the only durable evidence that the chain works, so it
  // must be written for a delivery and for nothing else. Marking a 500 as a
  // delivery would make a phone that has been silent for a month look healthy.
  ok(touched.join(',') === 'good', 'only the delivered one is marked as sent', touched.join(','))

  // A bookkeeping write must never be able to lose a notification that was
  // already delivered — the phone has buzzed by the time this runs.
  const stillSent = await deliverPush({
    subscriptions: [{ endpoint: 'good' }],
    send: async () => 201,
    drop: async () => {},
    touch: async () => {
      throw new Error('the database is having a moment')
    }
  })
  ok(stillSent.sent === 1 && stillSent.failed === 0, 'a failed "last sent" write is not a failed push', JSON.stringify(stillSent))
  // Nothing may require it: the same function runs in tests and in paths that
  // have no table to write to.
  const noTouch = await deliverPush({
    subscriptions: [{ endpoint: 'good' }],
    send: async () => 201,
    drop: async () => {}
  })
  ok(noTouch.sent === 1, 'and it is optional')

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
  console.log('\n=== 10b. the person who punched is not told about themselves ===')
  // -------------------------------------------------------------------------
  const roster = [
    { endpoint: 'lead-phone', employee_id: 'emp-lead' },
    { endpoint: 'packer-phone', employee_id: 'emp-packer' },
    { endpoint: 'lead-tablet', employee_id: 'emp-lead' }
  ]
  ok(
    notifyTargets(roster, 'emp-packer')
      .map((s: { endpoint: string }) => s.endpoint)
      .join(',') === 'lead-phone,lead-tablet',
    'the packer who clocked in is skipped, everybody else is notified'
  )
  ok(
    notifyTargets(roster, 'emp-lead').length === 1,
    'and BOTH of the lead devices are skipped when the lead punches, not just one'
  )
  ok(notifyTargets(roster, 'nobody').length === 3, 'an unrelated punch reaches every device')
  ok(notifyTargets(roster, '').length === 3, 'a missing employee id excludes nobody rather than everybody')
  ok(notifyTargets(null, 'emp-lead').length === 0, 'and no subscriptions is no recipients, not a crash')

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

  // -------------------------------------------------------------------------
  console.log('\n=== 11b. an out-of-date relay says so ===')
  // -------------------------------------------------------------------------
  // cloud/worker.js is deployed by pasting it into a dashboard, so a relay set
  // up before this feature existed is a relay with no notification routes on
  // it. It answers 404, everything else about it works, and nothing anywhere
  // says the deployed code is older than the repository.
  const { explainRelayProblem } = require('@shared/webPush')
  const stale = explainRelayProblem('Relay error 404.')
  ok(stale.includes('Relay error 404.'), 'the original error is kept', stale)
  ok(stale.includes('cloud/worker.js'), 'and it names the file to re-paste')
  ok(stale.includes('docs/CLOUDFLARE.md'), 'and where the steps are')
  ok(
    explainRelayProblem('Not found.').includes('older copy'),
    'a worded 404 is recognised too',
    explainRelayProblem('Not found.')
  )
  // Everything else is passed through: an invented explanation is worse than a
  // plain error, and these are read by somebody trying to fix something.
  for (const other of [
    'Relay error 401.',
    'Sync is not configured.',
    'The relay replied with something that is not JSON — check the URL.'
  ]) {
    ok(explainRelayProblem(other) === other, `left alone: ${other}`)
  }
  ok(explainRelayProblem('').length > 0, 'and an empty error still says something')

  // -------------------------------------------------------------------------
  console.log('\n=== 12. the manifest, and the icons it promises ===')
  // -------------------------------------------------------------------------
  // Without a manifest a browser can still bookmark the site, and that is the
  // trap: on iOS the bookmark opens in a Safari tab, a Safari tab has no
  // PushManager at all, and the whole feature reads as broken with nothing
  // anywhere mentioning a manifest.
  const PUBLIC_DIR = join(process.cwd(), 'src/renderer/public')
  const manifest = JSON.parse(readFileSync(join(PUBLIC_DIR, 'manifest.webmanifest'), 'utf8'))

  ok(manifest.display === 'standalone', 'display is standalone, so it opens without browser chrome', String(manifest.display))
  ok(manifest.start_url === '/', 'start_url is the site root', String(manifest.start_url))
  ok(manifest.scope === '/', 'and the scope covers the whole app', String(manifest.scope))
  ok(typeof manifest.name === 'string' && manifest.name.length > 0, 'it has a name')
  // Home screens truncate hard. A short_name past about a dozen characters is
  // an ellipsis under the icon on every phone.
  ok(
    typeof manifest.short_name === 'string' && manifest.short_name.length > 0 && manifest.short_name.length <= 12,
    'and a short_name that fits under an icon',
    String(manifest.short_name)
  )
  // The two colours the PHONE paints, not the app: theme_color is the band it
  // fills the status bar / notch strip with, background_color is the splash it
  // shows before the first frame. Both were a dark navy left over from when the
  // app had a dark theme, so an installed copy opened as a black splash into a
  // white page under a black band. The app has one palette now
  // (styles/theme.css) and these are the only two copies of it that live
  // outside CSS and cannot read a token — a manifest takes no comments and no
  // var(). So they are checked against the tokens rather than trusted: retune
  // the palette without touching this file and the test says so.
  const themeCss = readFileSync(join(process.cwd(), 'src/renderer/src/styles/theme.css'), 'utf8')
  const token = (name: string): string =>
    (new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`).exec(themeCss)?.[1] ?? '').toLowerCase()
  const surface = token('surface')
  const canvas = token('bg')
  ok(/^#[0-9a-f]{6}$/.test(surface), 'theme.css still declares a --surface hex', surface)
  ok(/^#[0-9a-f]{6}$/.test(canvas), 'and a --bg hex', canvas)
  ok(
    String(manifest.theme_color).toLowerCase() === surface,
    'theme_color is --surface, the colour of the bars drawn into the notch band',
    `${manifest.theme_color} vs ${surface}`
  )
  ok(
    String(manifest.background_color).toLowerCase() === canvas,
    'background_color is --bg, so the splash is the page it becomes',
    `${manifest.background_color} vs ${canvas}`
  )

  /** width, height and colour type, straight out of the IHDR chunk. */
  function pngHeader(path: string): { width: number; height: number; colorType: number } {
    const bytes = readFileSync(path)
    if (bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error(`${path} is not a PNG`)
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25] }
  }

  const icons: Array<{ src: string; sizes: string; purpose?: string }> = manifest.icons || []
  ok(icons.length >= 3, 'there are at least three icon entries', String(icons.length))
  for (const icon of icons) {
    // A relative src resolves against the MANIFEST's own URL, which is fine
    // until the manifest moves and every icon 404s at install time.
    ok(icon.src.startsWith('/'), `${icon.src} is an absolute path`)
    const file = join(PUBLIC_DIR, icon.src.replace(/^\//, ''))
    ok(existsSync(file), `${icon.src} exists on disk`)
    if (!existsSync(file)) continue
    const header = pngHeader(file)
    // A declared size that does not match the file is not cosmetic: a browser
    // picks an icon by its DECLARED size and then gets something else, and
    // Chrome refuses to call a site installable when they disagree.
    ok(
      `${header.width}x${header.height}` === icon.sizes,
      `${icon.src} really is ${icon.sizes}`,
      `${header.width}x${header.height}`
    )
    // Is there a PICTURE in it? A 512px PNG of one flat colour compresses to
    // well under a kilobyte, so a size floor is the cheapest test that the
    // artwork survived whatever produced the file — and "the icons all came out
    // blank" is exactly the kind of thing nobody notices until a phone shows a
    // white square on its home screen. (The badge is deliberately excluded: it
    // IS a flat silhouette and is supposed to be tiny.)
    ok(readFileSync(file).length > 4096, `${icon.src} contains actual artwork`, `${readFileSync(file).length} bytes`)
  }

  const anyIcons = icons.filter((i) => !i.purpose || i.purpose.split(' ').includes('any'))
  ok(anyIcons.some((i) => i.sizes === '192x192'), 'a 192px icon is declared — Chrome requires one to offer an install')
  ok(anyIcons.some((i) => i.sizes === '512x512'), 'and a 512px one, which is the splash and the app switcher')

  const maskable = icons.filter((i) => (i.purpose || '').split(' ').includes('maskable'))
  ok(maskable.length >= 1, 'and at least one maskable icon')
  for (const icon of maskable) {
    // A launcher masks this to its own shape — circle, squircle, teardrop —
    // and paints whatever is transparent as a black or white wedge. Colour
    // type 2 is RGB with no alpha channel at all, which is the only version of
    // "opaque" that cannot regress. See scripts/make-pwa-icons.mjs.
    const header = pngHeader(join(PUBLIC_DIR, icon.src.replace(/^\//, '')))
    ok(header.colorType === 2, `${icon.src} has no alpha channel to be cropped into a wedge`, `colour type ${header.colorType}`)
    // A maskable icon reused as the ordinary icon is padded artwork floating in
    // a box everywhere it is NOT masked, which is why they are separate files.
    ok(
      !anyIcons.some((i) => i.src === icon.src),
      `${icon.src} is not doubling as the ordinary icon`
    )
  }

  // The badge is the opposite requirement and it is easy to get backwards:
  // Android draws it from the ALPHA CHANNEL ONLY, so one without alpha is a
  // solid grey square in the status bar.
  const badge = pngHeader(join(PUBLIC_DIR, 'app-icon-badge-96.png'))
  ok(badge.colorType === 6, 'the notification badge DOES have an alpha channel', `colour type ${badge.colorType}`)

  // iOS composites a touch icon onto black before applying its own rounding,
  // so an alpha channel here shows as a dark ring inside the corners.
  const touchIcon = pngHeader(join(PUBLIC_DIR, 'apple-touch-icon-180.png'))
  ok(touchIcon.colorType === 2, 'the Apple touch icon is flattened', `colour type ${touchIcon.colorType}`)
  ok(touchIcon.width === 180 && touchIcon.height === 180, 'and is 180px, the size iOS asks for', `${touchIcon.width}`)

  // -------------------------------------------------------------------------
  console.log('\n=== 13. the HTML that has to link all of it ===')
  // -------------------------------------------------------------------------
  const indexHtml = readFileSync(join(process.cwd(), 'src/renderer/index.html'), 'utf8')
  ok(/rel="manifest"/.test(indexHtml), 'the page links a manifest')
  const manifestHref = /rel="manifest"\s+href="([^"]+)"/.exec(indexHtml)
  ok(
    !!manifestHref && existsSync(join(PUBLIC_DIR, manifestHref[1].replace(/^[./]+/, ''))),
    'and the file it links is really there',
    manifestHref ? manifestHref[1] : 'no href'
  )
  const touchHref = /rel="apple-touch-icon"[^>]*href="([^"]+)"/.exec(indexHtml)
  ok(!!touchHref, 'an apple-touch-icon is declared')
  ok(
    !!touchHref && existsSync(join(PUBLIC_DIR, touchHref[1].replace(/^[./]+/, ''))),
    'and that file exists too',
    touchHref ? touchHref[1] : 'no href'
  )
  ok(/apple-mobile-web-app-capable/.test(indexHtml), 'iOS is told this runs as an app')
  // The same colour as the manifest's theme_color, and it has to be HERE too:
  // the tag is read before any stylesheet or script exists, so this static hex
  // is what fills the notch band on the first frame. lib/systemChrome.ts
  // rewrites it from --surface once the CSS is up, which fixes a drift one
  // frame late — long enough to see the band flash on every cold open.
  const metaColor = /<meta\s+name="theme-color"\s+content="([^"]+)"/.exec(indexHtml)?.[1] ?? ''
  ok(
    metaColor.toLowerCase() === surface,
    'and the notch band is --surface before any CSS has loaded',
    `${metaColor} vs ${surface}`
  )
  // The page's own CSP governs whether a service worker may be registered at
  // all. A default-src that does not cover it means registration is refused
  // with a console message on a phone nobody is looking at.
  const csp = /Content-Security-Policy"\s*\n?\s*content="([^"]+)"/.exec(indexHtml)
  ok(!!csp, 'the page carries a Content-Security-Policy')
  if (csp) {
    const workerSrc = /worker-src ([^;]+)/.exec(csp[1])
    ok(!!workerSrc && workerSrc[1].includes("'self'"), 'which permits a same-origin service worker', csp[1])
  }
  // The scope of a service worker is the directory it is served from, so one
  // that is not at the root cannot control the app.
  const { SERVICE_WORKER_URL, canRegisterServiceWorker } = require('../src/renderer/src/lib/webPush')
  ok(SERVICE_WORKER_URL === '/sw.js', 'the worker is registered from the site root', String(SERVICE_WORKER_URL))
  ok(existsSync(join(PUBLIC_DIR, 'sw.js')), 'and the file sits where that URL resolves to')

  // The registration runs at startup, from main.tsx, in a bundle the DESKTOP
  // app also loads — over file://, where there is no service worker API at all.
  // An unguarded call there is a TypeError on every launch of the Electron app,
  // which is the constraint this guard exists to satisfy and the one thing here
  // that cannot be noticed by testing the web app.
  function inFakeBrowser(window: unknown, navigator: unknown): boolean {
    const before = [
      Object.getOwnPropertyDescriptor(globalThis, 'window'),
      Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    ]
    Object.defineProperty(globalThis, 'window', { value: window, configurable: true })
    Object.defineProperty(globalThis, 'navigator', { value: navigator, configurable: true })
    try {
      return canRegisterServiceWorker() === true
    } finally {
      for (const [i, name] of ['window', 'navigator'].entries()) {
        if (before[i]) Object.defineProperty(globalThis, name, before[i] as PropertyDescriptor)
        else delete (globalThis as Record<string, unknown>)[name]
      }
    }
  }

  const browserNavigator = { serviceWorker: {} }
  ok(
    inFakeBrowser({ location: { protocol: 'https:' }, isSecureContext: true, PushManager: {} }, browserNavigator),
    'a secure https page may register the worker'
  )
  ok(
    !inFakeBrowser({ location: { protocol: 'file:' }, isSecureContext: false, PushManager: {} }, browserNavigator),
    'the desktop build on file:// does NOT — that is the Electron guard'
  )
  ok(
    !inFakeBrowser({ location: { protocol: 'http:' }, isSecureContext: false, PushManager: {} }, browserNavigator),
    'and neither does a plain-http LAN address, where a browser refuses anyway'
  )
  ok(
    !inFakeBrowser({ location: { protocol: 'https:' }, isSecureContext: true, PushManager: {} }, {}),
    'a browser with no service worker support is left alone'
  )
  ok(
    !inFakeBrowser({ location: { protocol: 'https:' }, isSecureContext: true }, browserNavigator),
    'and so is one with no PushManager'
  )

  // -------------------------------------------------------------------------
  console.log('\n=== 14. how the server hands those files over ===')
  // -------------------------------------------------------------------------
  // Right file, wrong headers is the whole category of failure here: a manifest
  // served as octet-stream is ignored, a service worker served as HTML is
  // registered and fails forever, and either one is invisible from the app.
  const { serveStatic } = require('../src/server/staticFiles')
  const ROOT = join(process.cwd(), 'out/tests/pwa-root')
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(join(ROOT, 'assets'), { recursive: true })
  writeFileSync(join(ROOT, 'index.html'), '<!doctype html><title>app</title>')
  writeFileSync(join(ROOT, 'sw.js'), '/* worker */')
  writeFileSync(join(ROOT, 'manifest.webmanifest'), JSON.stringify(manifest))
  writeFileSync(join(ROOT, 'app-icon-192.png'), readFileSync(join(PUBLIC_DIR, 'app-icon-192.png')))
  writeFileSync(join(ROOT, 'assets/index-abc123.js'), 'console.log(1)')
  process.env.RMOPS_RENDERER_DIR = ROOT

  interface Served {
    status: number
    headers: Record<string, string>
    handled: boolean
  }
  /** HEAD, so serveStatic answers with headers and never opens a stream. */
  function serve(path: string): Served {
    let status = 0
    let headers: Record<string, string> = {}
    const res = {
      writeHead(code: number, head: Record<string, string>) {
        status = code
        headers = Object.fromEntries(
          Object.entries(head || {}).map(([k, v]) => [k.toLowerCase(), String(v)])
        )
      },
      end() {}
    }
    const handled = serveStatic({ method: 'HEAD' }, res, path, {})
    return { status, headers, handled }
  }

  const servedManifest = serve('/manifest.webmanifest')
  ok(servedManifest.status === 200, 'the manifest is served', String(servedManifest.status))
  // application/manifest+json. As octet-stream the browser ignores the file
  // entirely and iOS never offers "Add to Home Screen" as an app.
  ok(
    servedManifest.headers['content-type'].startsWith('application/manifest+json'),
    'as application/manifest+json',
    servedManifest.headers['content-type']
  )
  ok(servedManifest.headers['cache-control'] === 'no-store', 'and never cached', servedManifest.headers['cache-control'])

  const servedWorker = serve('/sw.js')
  ok(servedWorker.status === 200, 'the service worker is served', String(servedWorker.status))
  ok(
    servedWorker.headers['content-type'].startsWith('text/javascript'),
    'as JavaScript — a browser refuses to register anything else',
    servedWorker.headers['content-type']
  )
  // A cached service worker is a fix that cannot ship: the browser compares the
  // bytes it fetched, and a cached copy is byte-identical forever.
  ok(servedWorker.headers['cache-control'] === 'no-store', 'and never cached', servedWorker.headers['cache-control'])

  const servedIcon = serve('/app-icon-192.png')
  ok(servedIcon.headers['content-type'] === 'image/png', 'an icon is served as a PNG', servedIcon.headers['content-type'])
  // Fetched again for the icon and the badge of every single notification.
  ok(
    /max-age=\d+/.test(servedIcon.headers['cache-control']) && !servedIcon.headers['cache-control'].includes('no-store'),
    'and IS cacheable, because every notification fetches it again',
    servedIcon.headers['cache-control']
  )

  const servedAsset = serve('/assets/index-abc123.js')
  ok(
    servedAsset.headers['cache-control'].includes('immutable'),
    'content-hashed assets stay immutable',
    servedAsset.headers['cache-control']
  )

  // The rule that keeps a missing file from becoming a silently broken one.
  for (const missing of ['/sw.js', '/manifest.webmanifest', '/app-icon-512.png', '/assets/gone.js']) {
    rmSync(join(ROOT, missing.replace(/^\//, '')), { force: true })
    const answer = serve(missing)
    ok(answer.status === 404, `a missing ${missing} is a 404, not the app shell`, String(answer.status))
    ok(
      !String(answer.headers['content-type']).startsWith('text/html'),
      `and is never answered with HTML: ${missing}`,
      String(answer.headers['content-type'])
    )
  }

  // A path a person could have typed still lands in the app.
  const fallback = serve('/some/deep/view')
  ok(fallback.status === 200, 'an extensionless path still reaches the app shell', String(fallback.status))
  ok(
    fallback.headers['content-type'].startsWith('text/html'),
    'as HTML',
    fallback.headers['content-type']
  )
  // Traversal, still refused — the 404 rule above rewrote this function's
  // branch, so the check that matters most is re-asserted here.
  const namedEscape = serve('/../../package.json')
  ok(namedEscape.status === 404, 'a named path outside the renderer root is a 404', String(namedEscape.status))
  // Percent-encoded, so it has no visible extension for the rule above to catch.
  const encodedEscape = serve('/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd')
  ok(encodedEscape.status === 404, 'and so is an encoded one under /assets', String(encodedEscape.status))
  const shellEscape = serve('/../../../etc/passwd')
  ok(
    shellEscape.status === 200 &&
      shellEscape.headers['content-type'].startsWith('text/html') &&
      Number(shellEscape.headers['content-length']) === readFileSync(join(ROOT, 'index.html')).length,
    'and an unnamed one gets the app shell, byte for byte — never the file it asked for',
    `${shellEscape.status} ${shellEscape.headers['content-length']}`
  )
  delete process.env.RMOPS_RENDERER_DIR

  // -------------------------------------------------------------------------
  console.log('\n=== 15. the service worker, driven as a browser would drive it ===')
  // -------------------------------------------------------------------------
  // This file is the last few inches of the whole feature and nothing else in
  // the repository executes it: it runs on a phone, with no console attached,
  // in a process that exists for two seconds. So it is run here, in a vm, with
  // the browser's side faked.
  const vm = require('node:vm')

  interface FakeWindow {
    focused: boolean
    postedMessages: unknown[]
    focus: () => Promise<FakeWindow>
    postMessage: (message: unknown) => void
  }

  function fakeWindow(): FakeWindow {
    const win: FakeWindow = {
      focused: false,
      postedMessages: [],
      focus: async () => {
        win.focused = true
        return win
      },
      postMessage: (message: unknown) => {
        win.postedMessages.push(message)
      }
    }
    return win
  }

  const listeners: Record<string, Array<(event: Record<string, unknown>) => void>> = {}
  const notifications: Array<{ title: string; options: Record<string, unknown> }> = []
  const openedUrls: string[] = []
  let openWindows: FakeWindow[] = []
  let skipWaitingCalls = 0
  let claimCalls = 0

  const workerSelf = {
    addEventListener: (type: string, fn: (event: Record<string, unknown>) => void): void => {
      ;(listeners[type] = listeners[type] || []).push(fn)
    },
    skipWaiting: (): void => {
      skipWaitingCalls += 1
    },
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>): Promise<void> => {
        notifications.push({ title, options })
      }
    },
    clients: {
      claim: async (): Promise<void> => {
        claimCalls += 1
      },
      matchAll: async (): Promise<FakeWindow[]> => openWindows,
      openWindow: async (url: string): Promise<FakeWindow> => {
        openedUrls.push(url)
        return fakeWindow()
      }
    }
  }

  vm.runInNewContext(readFileSync(join(PUBLIC_DIR, 'sw.js'), 'utf8'), {
    self: workerSelf,
    console
  })

  ok(Array.isArray(listeners.push) && listeners.push.length === 1, 'it registers a push handler')
  ok(Array.isArray(listeners.notificationclick), 'and a notificationclick handler')

  async function fire(type: string, event: Record<string, unknown>): Promise<void> {
    const waits: Array<Promise<unknown>> = []
    const full = { ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) }
    for (const fn of listeners[type] || []) fn(full)
    await Promise.all(waits)
  }

  // A new worker must take over rather than wait for every tab to close. On a
  // phone with the app on its home screen, "every tab closed" can be weeks.
  await fire('install', {})
  await fire('activate', {})
  ok(skipWaitingCalls === 1, 'installing skips the waiting state')
  ok(claimCalls === 1, 'and activating claims the open pages')

  const pushed = (payload: unknown): Record<string, unknown> => ({
    data: { json: () => payload }
  })

  await fire('push', pushed({ v: 1, kind: 'in', name: 'Marisol Vandenberg', at: '2026-08-10T14:03:11.000Z' }))
  const first = notifications[0]
  ok(!!first, 'a push draws a notification')
  ok(first.title === 'Marisol Vandenberg clocked in', 'titled with the person and what they did', first.title)
  // The Worker sends a UTC instant and the PHONE formats it, because the relay
  // has no idea what timezone the phone is in.
  ok(/\d{1,2}:\d{2}/.test(String(first.options.body)), 'and a local time in the body', String(first.options.body))
  ok(String(first.options.icon).endsWith('.png'), 'with an icon', String(first.options.icon))
  ok(
    String(first.options.badge).includes('badge'),
    'and a BADGE that is the dedicated silhouette, not the full-colour icon',
    String(first.options.badge)
  )

  await fire('push', pushed({ v: 1, kind: 'out', name: 'Marisol Vandenberg', at: '2026-08-10T22:10:00.000Z' }))
  ok(notifications[1].title === 'Marisol Vandenberg clocked out', 'out reads as out', notifications[1].title)
  // Same person, same tag: punching straight back out replaces the first
  // notification rather than stacking two lines about one person.
  ok(notifications[1].options.tag === first.options.tag, 'and replaces their own earlier one')
  ok(notifications[1].options.renotify === true, 'audibly, so the second one is not silently swapped in')

  await fire('push', pushed({ v: 1, kind: 'in', name: 'Dana Whitfield', at: '2026-08-10T14:05:00.000Z' }))
  ok(
    notifications[2].options.tag !== first.options.tag,
    'but a different person gets a different tag and does not overwrite them',
    String(notifications[2].options.tag)
  )

  await fire('push', pushed({ v: 1, kind: 'test', name: 'Test', at: '2026-08-10T14:05:00.000Z' }))
  ok(notifications[3].title === 'Notifications are working', 'a test push says so plainly', notifications[3].title)

  // A payload that will not parse is still a real event, and on most platforms
  // a push handler that displays NOTHING eventually costs the site its
  // permission to send any at all.
  const before = notifications.length
  await fire('push', {
    data: {
      json: () => {
        throw new Error('not json')
      }
    }
  })
  ok(notifications.length === before + 1, 'an unreadable payload still shows something')
  ok(String(notifications[before].title).length > 0, 'with a title', String(notifications[before].title))
  await fire('push', {})
  ok(notifications.length === before + 2, 'and so does a push with no payload at all')

  // Tapping it must reach the window that is already open. Without this, every
  // tap since breakfast is another entry in the app switcher.
  let dismissed = 0
  const existing = fakeWindow()
  openWindows = [existing]
  await fire('notificationclick', {
    notification: {
      close: () => {
        dismissed += 1
      }
    }
  })
  ok(dismissed === 1, 'tapping dismisses the notification')
  ok(existing.focused, 'and focuses the window that was already open')
  ok(openedUrls.length === 0, 'rather than opening a second copy of the app')

  openWindows = []
  await fire('notificationclick', { notification: { close: () => {} } })
  ok(openedUrls.length === 1 && openedUrls[0] === '/', 'with nothing open it opens the app itself', openedUrls.join(','))

  // The browser rotates subscriptions on its own and tells nobody but this.
  openWindows = [fakeWindow(), fakeWindow()]
  await fire('pushsubscriptionchange', {})
  ok(
    openWindows.every((w) => w.postedMessages.length === 1),
    'a rotated subscription is announced to every open page'
  )
  ok(
    String((openWindows[0].postedMessages[0] as { type: string }).type).includes('push'),
    'in a message the notifications screen listens for',
    JSON.stringify(openWindows[0].postedMessages[0])
  )

  console.log(`\n${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
})()
