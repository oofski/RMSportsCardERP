# The staff clock portal

A web page your employees open on their phone to clock in, clock out, and read
their own timesheet. Nothing else — no inventory, no orders, no money.

It lives inside the relay Worker you already have, at `/clock`.

## Why it needed no new infrastructure

`employees` and `time_entries` are both in the app's sync manifest, so every
employee record and every punch is already in the relay's D1 database — the
laptops put them there. The portal reads those rows and writes new ones in
exactly the same shape, which means a punch made on a phone reaches the laptops
through the pull each of them is already doing.

There is no portal database, no second copy of a timesheet, and nothing to
reconcile. A shift started on a phone shows up in Admin → Timesheets and in the
Gusto export like any other, because it *is* one.

## Deploying it

Exactly what you did the first time:

1. Cloudflare dashboard → Workers & Pages → your relay Worker → **Edit code**.
2. Replace the contents with `cloud/worker.js` from this repo.
3. Deploy.

No new bindings, no new secrets, no D1 console step. The one extra table the
portal needs (a lockout counter) is created automatically the first time
somebody tries to sign in.

The page is then at `https://<your-worker>.workers.dev/clock`. Give staff that
link — bookmarked to a phone home screen it behaves like an app.

## Giving somebody access

In the desktop app: **Admin → Employees → PIN** on their row. Type six digits
and read them out. They sign in at the portal with their **company ID** and that
**PIN**.

The PIN is not their app password and cannot be used to open the app. It is
shown once, while you type it, and is never stored anywhere you can look it up —
a forgotten PIN is replaced, not recovered. **Remove PIN** on the same dialog
takes web access away without touching anything else.

A disabled employee cannot be given a PIN, and disabling somebody who has one
locks them out of the portal on their very next request — not when their session
expires.

## What protects it

Be clear-eyed about this: a six-digit PIN is a million possibilities, and no
amount of hashing makes that a large number. What actually defends it is the
lockout — five wrong PINs and that account stops answering for fifteen minutes,
counted in the database so the limit holds across every phone and every Worker
instance at once.

The rest of the shape:

- The portal never sees the shared sync key. Employees authenticate as
  themselves and can read only their own hours.
- A wrong company ID and a wrong PIN produce the identical reply, so the page
  cannot be used to find out who works here.
- The session is a signed, HttpOnly cookie scoped to `/clock`, good for twelve
  hours. Eligibility is re-checked on every request, not just at sign-in.
- The page loads nothing from anywhere — no fonts, no CDN, no framework — and
  its content-security policy says so.

The trade that comes with the lockout, stated rather than hidden: somebody who
knows a company ID can deliberately lock that person out of the *web* clock for
fifteen minutes. They cannot touch the desktop app, which is where the work is
actually run from, and fifteen minutes is short on purpose for this reason.

## Why a PIN and not their password

The app hashes passwords with bcrypt at cost 12 — deliberately expensive, which
is right on a laptop. A Cloudflare Worker on the free plan is killed after 10ms
of CPU, and one bcrypt verification needs roughly thirty times that. The login
would fail every time.

So the portal gets a credential it can afford to check: PBKDF2 through native
WebCrypto. The app password is never sent to Cloudflare and cannot be worked out
from anything the portal stores.

The format is `pbkdf2$sha256$<iterations>$<salt>$<hash>` and every parameter
travels inside the string, so the Worker needs no shared constant with the app
and no redeploy if the app ever changes its iteration count.

`tests/portalClock.test.ts` hashes a PIN with the real app code and verifies it
with the real Worker function, so the two implementations of that format cannot
quietly drift apart.
