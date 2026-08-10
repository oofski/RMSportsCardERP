# Setting up the relay on Cloudflare

Everything below is done in the Cloudflare dashboard in a browser. There is no
command line, no `wrangler`, and nothing to install.

You are creating **two things**: a Worker (the code) and a D1 database (the
storage). That is the whole cloud side.

**You do not need R2.** R2 stores files. Nothing here is a file — every record
travels as text inside D1. R2 only becomes relevant the day product photos
should travel between computers too, which they do not yet.

---

## What you are building

```
  Sid's Mac ──┐
              │   push what I changed
  Front desk ─┼──────────────────────►  ┌──────────┐      ┌────┐
              │                          │  Worker  │◄────►│ D1 │
  Warehouse ──┘   pull what others did   └──────────┘      └────┘
              ◄──────────────────────         ▲
                                              │  no key needed
                              customers ──────┘  /checkin/<link>
```

Each computer keeps its own full copy of the database and keeps working when the
internet does not. The Worker only carries rows between them. It runs when
someone calls it and sleeps otherwise, so there is no machine to keep switched
on and no monthly bill on Cloudflare's free plan at this size.

---

## Step 1 — Create the D1 database

1. Go to <https://dash.cloudflare.com> and sign in.
2. Left sidebar → **Storage & Databases** → **D1 SQL Database**.
3. **Create Database**.
   - Name: `rm-operations`
   - Location: leave it on automatic.
4. **Create**.

## Step 2 — Create the two tables

1. Open the `rm-operations` database you just made.
2. Click the **Console** tab.
3. Paste the four statements below and **Execute**.
4. Click **Tables**. You should now see `sync_rows` and `sync_seq`.

```sql
CREATE TABLE IF NOT EXISTS sync_rows (kind TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, device TEXT, data TEXT, PRIMARY KEY (kind, id));
CREATE INDEX IF NOT EXISTS idx_sync_rows_seq ON sync_rows (seq);
CREATE TABLE IF NOT EXISTS sync_seq (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO sync_seq (id, value) VALUES (1, 0);
```

This is also `cloud/schema.d1.sql` in the repo, and it has no comments in it on
purpose. Copying SQL out of a rendered file often flattens the line breaks, and
the moment that happens a leading `--` comments out everything after it on what
is now a single line. The console then gets nothing but a comment and says
**"Requests without any query are not supported"** — which reads like a
Cloudflare problem and is really just a lost newline. `cloud/schema.sql` is the
same statements with the reasoning written out, for reading rather than pasting.

If the console refuses four statements at once, run them one at a time, in
order. Each one stands alone.

## Step 3 — Create the Worker

1. Left sidebar → **Compute (Workers)** → **Workers & Pages**.
2. **Create** → **Start with Hello World!** → **Get started**.
3. Name it `rm-operations`. **Deploy**.
4. Once it deploys, click **Edit code** (or **</> Edit code** on the Worker's
   page).
5. Select everything in the editor and delete it.
6. Copy **all** of `cloud/worker.js` and paste it in. Copy it from the **Raw**
   view, not from the rendered file:

   <https://raw.githubusercontent.com/oofski/RMSportsCardERP/claude/rm-operations-app-initial-3sml0r/cloud/worker.js>

   The raw view keeps the line breaks. This matters more here than it did for
   the SQL: the file is several hundred lines of JavaScript with `//` comments,
   and if the line breaks are lost the whole thing becomes one comment. The
   Worker would deploy successfully and then answer nothing.
7. **Deploy**.

Sanity check before you leave the editor: the last line should be a single `}`,
and the editor should show hundreds of lines, not one.

Write down the URL it gives you. It looks like:

```
https://rm-operations.<your-subdomain>.workers.dev
```

That is the **relay address** you type into the app.

## Step 4 — Attach the database to the Worker

The Worker cannot see D1 until you bind it, and the binding must be named `DB`.

1. On the Worker's page → **Settings** → **Bindings**.
2. **Add** → **D1 database**.
   - Variable name: `DB`  ← must be exactly this
   - D1 database: `rm-operations`
3. **Deploy**.

## Step 5 — Set the shared key

This is the password every computer sends. Anyone with it can read and write all
your data, so treat it like a safe combination.

1. Make one up — long and random. On a Mac, Terminal:
   `openssl rand -base64 32`
   Or use any password manager's generator. 30+ characters.
2. Worker → **Settings** → **Variables and Secrets**.
3. **Add** → type **Secret**.
   - Name: `SHARED_KEY`  ← must be exactly this
   - Value: the key you generated
4. **Deploy**.

While you are there, optionally add a plain-text variable (not a secret):

- Name: `BRAND`, Value: `RM Cardz` — this is the name customers see on the
  public form.

There is one more secret to add if you want clock-in notifications on phones —
`VAPID_PRIVATE_KEY`. That has a section of its own further down, because it
needs a key pair generating first and it is not part of getting sync working.

## Step 6 — Check it

Open the Worker URL in a browser. You should see:

```json
{"ok":true,"service":"rm-operations-relay"}
```

If you see an error page instead, the code did not deploy. If you visit
`<your-url>/v1/state` you should get `{"ok":false,"error":"Unauthorized."}` —
that is correct, it means the key is being enforced.

---

## Step 7 — Give the build the address and the key

Do this **once**, in GitHub, not on any laptop. It is what makes the app arrive
already connected, so nobody types a URL or a key on ten machines — and nobody
mistypes one and quietly spends a week working on their own private copy of the
business, which looks exactly like working normally until the numbers disagree.

1. <https://github.com/oofski/RMSportsCardERP/settings/secrets/actions>
2. **New repository secret**
   - Name: `RMOPS_SYNC_URL`
   - Value: your Worker URL, no trailing slash
3. **New repository secret**
   - Name: `RMOPS_SYNC_KEY`
   - Value: the shared key from step 5
4. Cut a release. Every build from then on carries them.

They are secrets rather than lines in a source file because this repository is
public, and a relay URL committed next to its bearer token is exactly the pair
automated scanners hunt for. Injected at build time they reach the installer and
never a commit.

A build made before these exist still works — it is simply standalone, with the
fields under **Admin → Cloud sync → Connection** available to point it somewhere
by hand.

## Step 8 — Install it

On the computer that holds the real numbers, first:

1. Install the release.
2. Open it and sign in as normal.

That is the whole procedure. It connects on its own, notices the relay is empty,
and publishes what it holds — you can watch "Waiting to go up" count down under
**Admin → Cloud sync**. Nothing to press.

On every other computer:

1. Install the release.
2. Open it. **Do not** create an owner account — leave the setup screen alone.
3. Wait. The catalog, the roster, the stock, the history and the logins arrive
   on their own, usually inside a minute.
4. Sign in with an account created on the first computer.

A machine nobody has set up recognises that it is joining rather than starting,
discards the placeholder catalog every install seeds for itself, and takes the
shared one. A machine that already has data publishes instead. Only the first
one to arrive at an empty relay publishes; the rest pull.

---

## Clock-in notifications on your phone

When somebody clocks in or out, the phones of the people who switched this on
buzz with "Marisol Vandenberg clocked in — 7:58 AM". You do this once, in the
dashboard, and then each person turns it on for themselves.

### Why it is built this way, in one paragraph

The obvious versions of this — ntfy, a Discord webhook, Pushover, an email —
all mean handing a company you have never met a running list of who works here
and what hours they keep. That is the payroll shape of the business sitting in
somebody else's database forever, in exchange for saving an afternoon. So the
Worker sends a real Web Push notification instead, **encrypted before it leaves
Cloudflare**. Apple, Google and Mozilla carry it, and what they carry is a
sealed block of bytes: no name, no time, nothing readable. They cannot tell one
notification from another.

The Worker sends it, not the app, because punches arrive from several laptops
and from the web app, and a sender living inside one Mac only fires when that
Mac happens to be awake. The 7am shift would silently never notify.

### What you are setting, at a glance

Three variables on the Worker, and exactly one of them is a secret:

| Name | Kind | Required | What it is |
|---|---|---|---|
| `VAPID_PRIVATE_KEY` | **Secret** (encrypted) | **Yes** | The 32-byte signing key, base64url. Never in this repository, never in a chat, never in a commit. Nothing is sent without it. |
| `VAPID_PUBLIC_KEY` | Plain text variable | No | The matching public half. Optional because the same value is in `cloud/worker.js`; set it only to roll a new pair without editing the file. Not a secret. |
| `VAPID_SUBJECT` | Plain text variable | No | `mailto:` address a push service can complain to. Defaults to the one in the file. Not a secret. |

"Secret" is the type you pick in the **Add** dialog — Cloudflare encrypts it and
stops showing you the value. The other two are ordinary variables and stay
readable, which is correct: both are published to every phone that subscribes.

**If your relay was deployed before this feature existed, re-paste
`cloud/worker.js` first.** The notification routes, the subscription table and
the send path are all in that file, and a Worker running last month's copy
answers `/v1/push-notify/key` with a 404 — which the app reports as "the relay
cannot send notifications yet". The dashboard never tells you that the deployed
code is older than the repository, so re-pasting is the first thing to try
whenever a relay feature seems to be missing rather than broken. Worker →
**Edit code** → select all → paste → **Deploy**.

### Step A — Generate the key pair

The two keys are a matched pair. The private one signs; the public one is what
each phone is told to expect. **The private key is a secret and must never be
pasted into a chat, an issue, a commit, or this file.**

The Worker can mint a pair for you, which saves installing anything:

```
curl -X POST https://rm-operations.<sub>.workers.dev/v1/push-notify/generate-keys \
  -H "authorization: Bearer YOUR_SHARED_KEY"
```

You get back:

```json
{"ok":true,"publicKey":"BKq…","privateKey":"…","note":"…"}
```

Nothing is stored — it generates and hands them over. Run it once.

If you would rather not use a terminal: open any browser, press F12 for the
console, and paste this:

```js
crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign'])
  .then(async k => {
    const j = await crypto.subtle.exportKey('jwk', k.privateKey)
    const p = new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey))
    const b = s => btoa(String.fromCharCode(...s)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
    console.log('public :', b(p)); console.log('private:', j.d)
  })
```

### Step B — Paste the private half into the Worker

1. Worker → **Settings** → **Variables and Secrets**.
2. **Add** → type **Secret**.
   - Name: `VAPID_PRIVATE_KEY`  ← must be exactly this
   - Value: the `privateKey` string, nothing else. No quotes, no spaces.
3. **Deploy**.

That is the only thing here that is a secret, and it is the only thing with no
default. Close the terminal window afterwards.

### Step C — Put the public half in the code

Open `cloud/worker.js` and find:

```js
const VAPID_PUBLIC_KEY_DEFAULT = 'BKq…'
```

Replace the string with your `publicKey`, then re-paste the whole file into the
dashboard editor and **Deploy** (same as Step 3 above).

It lives in the file rather than in a second variable on purpose: the phone and
the Worker have to agree on this value *exactly*, and two hand-typed copies of
an 87-character string eventually stop agreeing. When they do, nothing errors —
subscribing works, the toggle goes green, and no notification is ever delivered.
One copy, served to the phone by the Worker itself, cannot drift.

It is not a secret. It is published to every phone that subscribes.

*(If you would rather not edit the file, a `VAPID_PUBLIC_KEY` plain-text
variable overrides it. Same value, same effect.)*

### Step D — Optional but recommended: a contact address

1. Worker → **Settings** → **Variables and Secrets** → **Add** → **Variable**
   (not a secret).
   - Name: `VAPID_SUBJECT`
   - Value: `mailto:you@yourdomain.com`

Google and Mozilla write to this address before they start throttling or
dropping a sender, so an address nobody reads means the first sign of trouble is
notifications quietly stopping.

**The format is fussy and the failure is silent.** It must be `mailto:` followed
immediately by the address — no space after the colon, no `<angle brackets>`, no
display name. Some push services reject a malformed one with an error that never
mentions the subject. The Worker checks the shape, falls back to its default if
it is wrong, and writes a line to the log saying so; you will see it in the
Worker's **Logs** tab.

If you skip this step entirely the built-in default is used and everything works.

### Step E — Nothing. There is no table to create.

The Worker creates `push_subscriptions` itself the first time somebody
subscribes. It is deliberately not in `schema.d1.sql`, because a feature that
only works after somebody remembers a *second* paste is a feature that appears
broken with no error to search for.

### Step F — Turn it on, per person, per phone

Each person does this for themselves on the phone they want buzzed. There is no
way to turn it on for somebody else — deliberately.

1. Open the **web app** on the phone (not the desktop app; the desktop app
   cannot receive these).
2. **Admin → Notifications**.
3. Press **Turn on** and allow notifications when the browser asks.
4. Press **Send a test**. The phone should buzz within a few seconds.

**On an iPhone or iPad there is one extra step, and it is not optional.** Apple
allows web notifications only for a site that has been **added to the Home
Screen**:

1. Open the app in **Safari** — Chrome on iPhone cannot do this at all.
2. Tap the **Share** button (the square with an arrow out of the top).
3. Scroll down, tap **Add to Home Screen**, then **Add**.
4. Close Safari and open the app from the **new icon**.
5. Now go to Admin → Notifications and press Turn on.

Needs iOS 16.4 or newer. The Notifications screen detects this case and prints
these steps rather than showing a switch that does nothing — but it is written
here too, because the person asking is usually standing in the warehouse.

Only people with the **Clock-in notifications** permission see the screen at all.
Owner and Operations have it; anyone else has to be granted it under **Admin →
Roles & Permissions** (and needs Admin access to reach the screen).

### When notifications do not arrive

**Nothing at all, for anybody.** Almost always `VAPID_PRIVATE_KEY`. Open the
Worker's **Logs** tab and clock in; a missing key logs a line naming it. The
Notifications screen shows the same message in red.

**One person, everybody else fine.** Their phone dropped the subscription —
browsers expire them. Turn it off and on again on that phone. The device list on
the Notifications screen says when each phone was last successfully sent to,
which is how you tell a dead subscription from a quiet week.

**One iPhone, and its Notifications screen has no switch at all.** The app on
that home screen is a bookmark rather than an installed app — the giveaway is
that opening it shows the Safari address bar at the top. Delete the icon and add
it again from **Safari** (not Chrome), following
**[docs/WEB.md](WEB.md#iphone-and-ipad--safari-only)**. A bookmark cannot
receive a notification on iOS at any setting.

**Everything worked, then stopped after a rotation.** Changing either key
invalidates every phone already subscribed. Everyone turns it off and on again.

**You never get notified about your own punches.** Working as intended: the
screen you just pressed already told you, and a second buzz two seconds later is
what teaches people to mute an app.

**Dead phones clean themselves up.** A push service answering 404 or 410 means
that subscription is gone forever, and the Worker deletes the row on the spot.
Without that, every punch would spend longer and longer handshaking with phones
that no longer exist.

---

## Stream reminders — THE ONE STEP THAT IS NOT AUTOMATIC

When a stream is scheduled in the app (Streaming → **Schedule a stream**), the
relay sends a push notification **one hour before** and again **fifteen minutes
before** it starts, to everyone with **Admin access** and to the **host** of that
stream if the host is not an admin. It says which show, what time it starts, and
to go and start it on the RM Operations App.

**None of this happens until you add a Cron Trigger by hand. Read the next
paragraph.**

Every other notification in this app is a reaction: somebody clocks in, a row
arrives at the relay, the relay sends. A reminder is the opposite — it has to
fire when *nothing* has happened, at ten to nine on a Friday with every laptop
asleep. So it needs a clock of its own, and on Cloudflare that clock is a **Cron
Trigger**. Pasting `cloud/worker.js` in is *not* enough: there is no
`wrangler.toml` in this project, so nothing in the code declares a schedule. A
Worker with the reminder code and no trigger records scheduled streams, shows
them, syncs them — and silently never announces one. Nothing anywhere says so.

### Add the trigger (about four clicks, once, forever)

1. Cloudflare dashboard → **Workers & Pages** → **rm-operations**.
2. **Settings** → **Triggers** (older dashboards: **Trigger Events**).
3. Under **Cron Triggers**, press **Add Cron Trigger**.
4. Choose **Cron expression** / *Custom* and enter exactly:

   ```
   */5 * * * *
   ```

5. **Add** / **Save**. It starts within a minute or two.

That is "every five minutes". Nothing else needs setting: the reminders use the
same `VAPID_PRIVATE_KEY` and the same subscriptions the clock-in notifications
already use, so if a test notification reaches your phone, reminders will too.

**Re-paste `cloud/worker.js` first if your relay predates this feature.** The
`scheduled` handler the trigger calls lives in that file. A trigger pointed at an
older copy fires every five minutes and does nothing, with no error anywhere.

### Why five minutes, and what "an hour before" actually means

A cron cannot land exactly on T-60. So a reminder is defined over a **window**,
not an instant: the hour reminder goes out at the first cron tick at or after
T-60, and the fifteen-minute one at the first tick at or after T-15. In practice
that is **up to five minutes late and never early** — the hour reminder arrives
somewhere in T-60 to T-55, the short one in T-15 to T-10.

A reminder more than **ten minutes** late is dropped rather than sent. That is
what stops a relay that was down for an hour waking up and firing a flurry of
stale reminders at everybody at once, and it is why "starts in an hour" is never
a lie. Ten minutes is two cron ticks, so one missed or failed run still delivers.

Every-minute (`* * * * *`) would be exact to the minute and costs 1,440 cron runs
and 1,440 database queries a day, permanently, to sharpen a reminder nobody is
timing with a stopwatch. Every fifteen minutes would be worse than useless — the
"fifteen minutes before" reminder could arrive one minute before the show. Five
is the largest interval that keeps the short reminder worth sending.

### Each reminder is sent exactly once

The trigger re-examines the same show every five minutes, so without this the
feature would send "your stream starts soon" a dozen times an hour — after which
everybody mutes the app, and the clock-in notifications go with it.

Before sending, the Worker writes a row into a table called
`push_reminders_sent`, keyed by the show, its start time and which reminder it
is. That write is what grants permission to send: if the row is already there —
because five minutes ago it sent one, or because two cron runs overlapped — the
insert fails and nothing goes out. There is no table to create; the Worker makes
it on first use, like `push_subscriptions`.

The key includes the **start time**, on purpose. Move a show from 9pm to 11pm and
it reminds again, because the earlier reminder was about a time that is no longer
true. Correct only its title and it does not.

Nothing is sent for a show that was **cancelled**, that somebody has already
**started**, or whose start time is in the **past**.

### What can still go wrong, honestly

**A stream cancelled on a laptop that is offline still reminds.** The relay only
knows what has reached it. Cancel a show and the cancellation travels with the
next sync; until then, the relay has a planned show at nine o'clock and will say
so.

**The relay reminds about what it was told, not about what is true now.** Same
sentence, other direction: schedule a stream on a laptop that never syncs and no
reminder is ever sent, because the relay has never heard of it.

**Reminders honour the timezone of the machine that scheduled the show.** "9:00
PM" is resolved to an absolute moment on the computer where somebody typed it —
the relay runs in UTC and is never asked to guess. The scheduling dialog prints
both reminder times before you save; if those look an hour or five hours out,
that machine's clock or timezone is wrong, not the relay.

---

## The customer form

1. **Admin → Cloud sync → Customer form links**.
2. Name it (for you), name the event (customers see this), pick a date,
   **Create link**.
3. Within a few seconds the link is live. **Copy** it and send it to customers.

The link looks like `https://rm-operations.<sub>.workers.dev/checkin/<32 random
characters>`. It needs no key, because customers do not have one — it is
protected by being unguessable and by being revocable. Press **Close** on a link
and the form stops working everywhere within one sync round.

What customers send lands under **What customers sent**. Nothing about a real
customer changes until somebody presses **Accept**; that is deliberate, because
an unauthenticated form that could edit a stored shipping address is a way to
have someone else's cards mailed elsewhere.

---

## Things worth knowing

**Cost.** At this size — ten people, a few thousand rows, a sync every four
seconds — the free plan covers it. Worker requests are 100,000/day free; ten
laptops syncing every 4 seconds during a 10-hour day is about 90,000 requests.
If you cross it, the paid plan is $5/month. Raise the interval in the app if you
would rather not.

**Losing internet.** Nothing stops. The app keeps working on its own copy and
queues what changed; it uploads when the connection returns. The banner at the
top of the sync tab says so plainly rather than pretending.

**Two people editing the same record.** The later edit wins. For documents,
notes and settings that is what you want. Stock is handled differently and does
not work this way — receipts are kept separately and added up, so two people
receiving the same product at the same moment both count.

**Rotating the key.** Change the secret on the Worker, then update it on every
computer. Between those two moments, the computers still on the old key cannot
sync — they queue and catch up, they do not lose anything.

**Wiping the relay and starting over.** If a seeding attempt goes wrong, you can
clear it. This deletes everything on the relay (not on any laptop):

```
curl -X POST https://rm-operations.<sub>.workers.dev/v1/reset \
  -H "authorization: Bearer YOUR_KEY" \
  -H "content-type: application/json" \
  -d '{"confirm":"ERASE-RELAY"}'
```

Then reset each laptop's cursor by turning sync off and on, and publish
everything again from the origin machine.

**A custom domain.** Not required — `workers.dev` works. If you want
`sync.rmcardz.com`, put `rmcardz.com` on Cloudflare first (that means changing
nameservers at your registrar, which takes hours to a day), then Worker →
Settings → Domains & Routes → Add custom domain.
