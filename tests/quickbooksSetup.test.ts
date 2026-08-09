/**
 * Telling Intuit's four long strings apart.
 *
 * Intuit issues a Client ID, a Client Secret, a refresh token and a Company
 * (realm) ID, and names two of them so similarly — "Client ID" for the app,
 * "Company ID" for the books — that they get pasted into each other's boxes.
 * QuickBooks then refuses the connection with a generic OAuth error naming none
 * of it, and the operator is left staring at four correct-looking fields.
 *
 * This actually happened during setup: a Client ID went into the company field.
 * The two are trivially distinguishable by shape, so the app says which is
 * which BEFORE anything is sent — and says it in terms of the mistake ("that is
 * your Client ID"), not in terms of a regex.
 *
 * The rule that matters most is the asymmetry: a value is refused only when it
 * is recognisably something ELSE. Intuit owns these formats and may change
 * them, and refusing a real credential because it stopped matching a pattern
 * would be a worse failure than accepting an odd-looking one.
 *
 * Run: npm run test:qbo-setup
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const {
  QBO_DEFAULT_REDIRECT_URI,
  QBO_REDIRECT_URI,
  isLoopbackRedirect,
  looksLikeClientId,
  looksLikeRealmId,
  readConsentPaste,
  validateClientId,
  validateClientSecret,
  validateRealmId,
  validateRefreshToken
} = require('../src/shared/quickbooks')

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

// Invented values in the shapes Intuit issues. Nothing real is in this repo.
const REALM = '9341454816183285'
const CLIENT_ID = 'ABxKp2QmR7vTn4Ls9Wd3Yf6Hc8Jb5Ng1Zt0Ax'
const REFRESH = 'VDnw9XZoEthf6XHgn9jxaAtANaVqde5A1ktDP8QmZr2Lc'
const SECRET = 'Kq7Rm2Wd9Tz4Xb6Nc1Vf8Hj3Lp5Sg0Yu2Ae4Bi7Ok'

// ---------------------------------------------------------------------------
console.log('=== 1. shapes ===')
// ---------------------------------------------------------------------------
ok(looksLikeRealmId(REALM), 'a realm id is all digits')
ok(!looksLikeRealmId(CLIENT_ID), 'a client id is not')
ok(!looksLikeRealmId(''), 'nor is nothing')
ok(!looksLikeRealmId('93414 5481'), 'nor digits with a space in them')
ok(looksLikeClientId(CLIENT_ID), 'a client id is recognisable')
ok(!looksLikeClientId(REALM), 'a realm id is not a client id')
ok(!looksLikeClientId('ABC'), 'and neither is a short word starting AB')

// ---------------------------------------------------------------------------
console.log('\n=== 2. THE mistake: a Client ID in the company box ===')
// ---------------------------------------------------------------------------
const swapped = validateRealmId(CLIENT_ID)
ok(swapped !== null, 'a client id is refused as a company id')
ok(
  (swapped ?? '').includes('Client ID'),
  'and the message NAMES what was actually pasted',
  String(swapped)
)
// Telling somebody the format is wrong sends them to check the value. Telling
// them WHICH value they pasted sends them to the right field.
ok(
  /digits/.test(swapped ?? ''),
  'and says what a company id looks like instead',
  String(swapped)
)
ok(validateRealmId(REALM) === null, 'a real company id passes')

// The same swap the other way round.
const backwards = validateClientId(REALM)
ok(backwards !== null, 'a company id is refused as a client id')
ok((backwards ?? '').includes('company id'), 'named just as plainly', String(backwards))
ok(validateClientId(CLIENT_ID) === null, 'a real client id passes')

// THE APP'S NAME in the credential box. This got through the first version of
// these checks — they only recognised a company id — and QuickBooks then
// refused the connection with an error naming none of it. Length and spaces
// are the safe discriminators: Intuit's client ids are around forty opaque
// characters, and no app name is.
ok(
  (validateClientId('RM-Software') ?? '').includes('too short'),
  'an app name is refused as a client id',
  String(validateClientId('RM-Software'))
)
ok(
  (validateClientId('My Company App') ?? '').includes('no spaces'),
  'and a name with a space is named for what it is'
)
ok(validateClientId('short') !== null, 'anything short is refused')

// ---------------------------------------------------------------------------
console.log('\n=== 3. the refresh token, one field over ===')
// ---------------------------------------------------------------------------
ok(validateRefreshToken(REFRESH) === null, 'a real refresh token passes')
ok(
  (validateRefreshToken(CLIENT_ID) ?? '').includes('Client ID'),
  'a client id in its place is named'
)
ok(
  (validateRefreshToken(REALM) ?? '').includes('company id'),
  'and so is a company id'
)
ok(validateRefreshToken('short') !== null, 'and something far too short is refused')

// ---------------------------------------------------------------------------
console.log('\n=== 4. empty says which field, not "invalid" ===')
// ---------------------------------------------------------------------------
ok((validateRealmId('') ?? '').includes('company'), 'blank company id names itself')
ok((validateClientId('') ?? '').includes('client id'), 'blank client id names itself')
ok((validateRefreshToken('') ?? '').includes('refresh token'), 'blank token names itself')
ok(validateRealmId('   ') !== null, 'and whitespace is blank')

// ---------------------------------------------------------------------------
console.log('\n=== 5. what must NOT be refused ===')
// ---------------------------------------------------------------------------
// Intuit owns these formats. A client id that stops starting with AB, or a
// longer realm, must still be accepted — refusing a real credential because it
// no longer matches a guess is worse than accepting an odd-looking one, since
// the operator then cannot connect at all and the app is the thing at fault.
ok(validateClientId('Q2xpZW50SWRUaGF0RG9lc05vdFN0YXJ0V2l0aEFC') === null,
  'a client id in some future shape is still accepted')
ok(validateRealmId('123456789012345678901') === null, 'and a longer all-digit realm id')
ok(
  validateRefreshToken('AB' + 'x'.repeat(30)) !== null,
  'but a client-id-shaped value in the token box is still caught'
)

// ---------------------------------------------------------------------------
console.log('\n=== 6. the client secret, one field below ===')
// ---------------------------------------------------------------------------
// The field a password manager is most likely to have written into, because a
// text input directly above a password input is exactly the shape Chromium
// reads as a login form.
ok(validateClientSecret(SECRET) === null, 'a secret-shaped value passes')
ok((validateClientSecret(REALM) ?? '').includes('company id'), 'a company id is named')
ok((validateClientSecret(CLIENT_ID) ?? '').includes('Client ID'), 'and so is the id one field up')
ok((validateClientSecret('my app secret') ?? '').includes('no spaces'), 'a phrase is refused')
ok(validateClientSecret('hunter2') !== null, 'and anything short')
ok((validateClientSecret('') ?? '').includes('secret'), 'blank names itself')

// ---------------------------------------------------------------------------
console.log('\n=== 7. reading the address bar back ===')
// ---------------------------------------------------------------------------
// Consent ends on a page this app cannot read, so the operator pastes the
// whole address and the app picks the two values out. Asking for the code and
// the realm SEPARATELY meant reading a long URL and picking substrings by eye,
// with &state= sitting between them — which is how a code arrives with
// "&state=..." glued onto the end and Intuit refuses it for no visible reason.
const CODE = 'AB11758914707xUbGcyBOAWDGONtHNXHRJyfNczkGDG6yNTiwj'
const LANDED = `${QBO_DEFAULT_REDIRECT_URI}?code=${CODE}&state=rmops&realmId=${REALM}`

const good = readConsentPaste(LANDED)
ok(good.ok === true, 'a whole redirect URL is read')
ok(good.code === CODE, 'the code comes out clean', String(good.code))
ok(good.realmId === REALM, 'and the company id with it', String(good.realmId))

// The single failure this replaces: state carried into the code.
ok(!String(good.code).includes('state'), 'and the code does NOT carry &state into it')

// Order is Intuit's business, not the operator's.
ok(
  readConsentPaste(`${QBO_DEFAULT_REDIRECT_URI}?realmId=${REALM}&code=${CODE}`).code === CODE,
  'parameter order does not matter'
)
// A bare query string, which is what a partial select gives you.
ok(readConsentPaste(`code=${CODE}&realmId=${REALM}`).ok === true, 'a bare query string works')
// Address bars survive a paste through chat with a line break in them.
ok(
  readConsentPaste(`${QBO_DEFAULT_REDIRECT_URI}?code=${CODE}\n  &realmId=${REALM}`).code === CODE,
  'wrapped whitespace is not part of a value'
)

// Refusals name what is missing, because the operator is looking at a screen
// full of text that all looks correct.
ok(readConsentPaste('').ok === false, 'nothing is refused')
ok((readConsentPaste('') as { error: string }).error.includes('approving'), 'and says what to paste')
const noCode = readConsentPaste(`${QBO_DEFAULT_REDIRECT_URI}?realmId=${REALM}`)
ok(noCode.ok === false && noCode.error.includes('code='), 'a URL with no code says so', String(noCode.error))
const noRealm = readConsentPaste(`${QBO_DEFAULT_REDIRECT_URI}?code=${CODE}&state=rmops`)
ok(noRealm.ok === false && noRealm.error.includes('realmId'), 'and one with no company id', String(noRealm.error))
const denied = readConsentPaste(`${QBO_DEFAULT_REDIRECT_URI}?error=access_denied`)
ok(denied.ok === false && denied.error.includes('refused'), 'Intuit’s own refusal is passed through')
// A realm that is not digits is the same paste mix-up as everywhere else here.
const junkRealm = readConsentPaste(`code=${CODE}&realmId=${CLIENT_ID}`)
ok(junkRealm.ok === false, 'a client id in the realm slot is still caught')

// ---------------------------------------------------------------------------
console.log('\n=== 8. the default redirect is the one production accepts ===')
// ---------------------------------------------------------------------------
// Production keys cannot register a loopback URI at all — Intuit's portal
// accepts plain HTTP on the Development tab only — so the default has to be the
// HTTPS one Intuit already has on file, or the very first attempt fails.
ok(QBO_DEFAULT_REDIRECT_URI.startsWith('https://'), 'the default is HTTPS')
ok(!isLoopbackRedirect(QBO_DEFAULT_REDIRECT_URI), 'and is not one this app can catch')
ok(isLoopbackRedirect(QBO_REDIRECT_URI), 'the loopback URI still is')
// Blank means "the default", NOT "loopback" — the old reading sent a fresh
// install down the listener path, which cannot work on production.
ok(!isLoopbackRedirect(''), 'and blank means the default, not loopback')

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
