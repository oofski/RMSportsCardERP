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
  looksLikeClientId,
  looksLikeRealmId,
  validateClientId,
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

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
