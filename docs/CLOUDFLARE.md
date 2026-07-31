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
3. Open `cloud/schema.sql` from this repository, copy all of it, paste it into
   the console, and **Execute**.
4. Click **Tables**. You should now see `sync_rows` and `sync_seq`.

If you would rather not open the repo, the whole thing is:

```sql
CREATE TABLE IF NOT EXISTS sync_rows (
  kind TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
  device TEXT, data TEXT, PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS idx_sync_rows_seq ON sync_rows (seq);
CREATE TABLE IF NOT EXISTS sync_seq (
  id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO sync_seq (id, value) VALUES (1, 0);
```

## Step 3 — Create the Worker

1. Left sidebar → **Compute (Workers)** → **Workers & Pages**.
2. **Create** → **Start with Hello World!** → **Get started**.
3. Name it `rm-operations`. **Deploy**.
4. Once it deploys, click **Edit code** (or **</> Edit code** on the Worker's
   page).
5. Select everything in the editor and delete it.
6. Open `cloud/worker.js` from this repository, copy **all** of it, paste it in.
7. **Deploy**.

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

## Step 6 — Check it

Open the Worker URL in a browser. You should see:

```json
{"ok":true,"service":"rm-operations-relay"}
```

If you see an error page instead, the code did not deploy. If you visit
`<your-url>/v1/state` you should get `{"ok":false,"error":"Unauthorized."}` —
that is correct, it means the key is being enforced.

---

## Step 7 — Connect the computer that holds the real data

Do this on **one** computer first — the one whose numbers are correct today.

1. Open RM Operations → **Admin** → **Cloud sync**.
2. Open **Connection** → **Show**.
3. Relay address: the Worker URL from step 3.
4. Shared key: the key from step 5.
5. Name for this computer: something you will recognise in the log.
6. **Save**, then **Test connection**. It should report how many records the
   relay holds (0 the first time).
7. Click **Publish everything**. This queues the whole database for upload —
   run it **once**, and only here.
8. **Turn on**.

Watch "Waiting to go up" count down to 0. That is your data going up.

## Step 8 — Connect everyone else

On each other computer:

1. Install the app.
2. **Do not** create an owner account or set anything up. Go straight to
   **Admin → Cloud sync → Connection**.
3. Enter the same relay address and the same key. Save. **Turn on**.
4. Wait. The catalog, the roster, the stock and the history arrive on their own.
5. Sign in with the account that was created on the first computer.

Do **not** press "Publish everything" on these machines. They pull what is
already there; publishing again would push their empty starter catalog at
everyone.

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
