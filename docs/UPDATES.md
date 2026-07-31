# Updates & distribution (Cloudflare)

How the RM Operations App ships updates, and how to move the update feed from
GitHub to **Cloudflare**.

## How updates work

- The app checks a feed and offers the new version from **Check for updates**
  (top bar / sidebar, every module).
- **Windows** — fully automatic: `electron-updater` downloads and installs the
  new version silently from the feed's `latest.yml`.
- **macOS** — the app checks `update.json` on the feed and, when a newer version
  exists, offers a **direct download of the `.dmg`** to reinstall (drag to
  Applications). See *Why Mac can't silently auto-update* below.

The feed lives wherever you point it. We're moving it from GitHub Releases to a
**Cloudflare R2 bucket behind your own domain** (e.g. `updates.rmcardz.com`).

> **Current state — GitHub phase.** Until the Cloudflare setup below is done,
> GitHub is the active feed and everything works there: Windows reads
> `latest.yml` from the GitHub release, and the `github-update-json` CI job
> attaches an `update.json` so the macOS check works too (`UPDATE_FEED_URL`
> points at `…/releases/latest/download`). The Cloudflare provider + R2 mirror
> job exist but stay inert until you enable them.

---

## One-time Cloudflare setup

All of this is dashboard clicking — there is nothing to install and no
`wrangler`. **You do not need a Worker.** An R2 bucket with a custom domain
serves the files directly over HTTPS; a Worker only earns its place if you want
the downloads to be private (see *Locking downloads down* at the end).

### Prerequisite: is `rmcardz.com` on Cloudflare?

Check dash.cloudflare.com → **Websites**. If the domain is not listed, add it
first (*Add a site* → follow the nameserver change at your registrar). That can
take anywhere from minutes to a few hours to go active, so start it before
anything else.

Not ready, or want to test the pipeline today? Skip to *Testing without a
domain* below — R2 gives every bucket a free `r2.dev` URL that works
immediately.

### 1. Create the bucket

1. dash.cloudflare.com → **R2 Object Storage** in the left sidebar.
2. First time only: R2 asks for a payment method before it will enable, even on
   the free tier. The free tier is 10 GB of storage and generous operation
   limits — this app's releases sit well inside it.
3. **Create bucket** → name it `rmops-updates` → Location: *Automatic* →
   **Create bucket**.

### 2. Put it on your domain

1. Open the bucket → **Settings** tab.
2. Find **Public access** → **Custom Domains** → **Connect Domain**.
3. Enter `updates.rmcardz.com` → **Continue** → **Connect domain**.
   Because the zone is already on Cloudflare, it creates the DNS record itself.
4. Wait for the status to read **Active** (usually under a minute).
5. Do **not** add a Cache Rule for this hostname. R2 honours the per-file
   `Cache-Control` that CI sets — installers cached hard, feed files never
   cached — and a blanket rule would override exactly the part that must stay
   fresh.

### 3. Create an API token for CI

1. On the R2 overview page, note your **Account ID** (right-hand side). Your S3
   endpoint is `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.
2. **Manage API tokens** (top right of the R2 overview) → **Create API token**.
3. Permission: **Object Read & Write**. Scope it to the `rmops-updates` bucket
   rather than all buckets. TTL: forever.
4. **Create API token**, then copy the **Access Key ID** and **Secret Access
   Key**. The secret is shown once — if you lose it, delete the token and make
   another.

### Testing without a domain

In the bucket → **Settings** → **Public access** → **R2.dev subdomain** →
*Allow Access*. You get a `https://pub-<hash>.r2.dev` URL that works straight
away. Use it as `CF_UPDATES_URL` to prove the whole release pipeline end to end,
then switch to the custom domain when DNS is ready.

Cloudflare rate-limits `r2.dev` and says outright it is not for production, so
do not point the app's `UPDATE_FEED_URL` at it — it is for testing the CI job
only.

## Point the app + CI at your domain

These three values must all be the same base URL:

| Where | Value |
|-------|-------|
| `src/shared/config.ts` → `UPDATE_FEED_URL` | `https://updates.rmcardz.com` |
| `electron-builder.yml` → `publish[0].url` | `https://updates.rmcardz.com` |
| GitHub repo **variable** `CF_UPDATES_URL` | `https://updates.rmcardz.com` |

## GitHub repo configuration

Settings → Secrets and variables → Actions:

**Variables**
- `CLOUDFLARE_UPDATES` = `true`  *(turns the mirror job on — until then it's off and releases behave exactly as before)*
- `CF_UPDATES_URL` = `https://updates.rmcardz.com`

**Secrets**
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_ENDPOINT` = `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
- `R2_BUCKET` = `rmops-updates`

## Verify BEFORE you switch

Pointing the app at a feed that does not serve correctly is the one change that
breaks every installed copy at once and shows no symptom — the app keeps working
and simply never finds another update again. So prove the feed first:

```bash
npm run check:feed -- https://updates.rmcardz.com
```

It checks that `update.json`, `latest.yml` and `latest-mac.yml` are readable and
parse, that they are **not** served with a long `max-age` (the classic R2
mistake — the right policy for the 100 MB installer beside them is the exact
opposite), and that every download URL they advertise resolves to something
installer-sized rather than an error page with a 200 on it.

Run it against the current GitHub feed any time to see what a healthy one looks
like:

```bash
npm run check:feed -- https://github.com/oofski/rmsportscarderp/releases/latest/download
```

The same check runs in CI after every Cloudflare sync, so a broken feed fails
the release instead of shipping quietly.

## Cutting a release (through Cloudflare)

1. Bump `version` in `package.json`.
2. Commit with `[release]` in the message (or push a `vX.Y.Z` tag).
3. CI builds Windows + Mac, publishes to GitHub, then the **`cloudflare-publish`**
   job downloads those artifacts, writes `update.json`, and syncs everything to
   R2. Windows installs will now update from Cloudflare; Macs get the download
   prompt.

Once every install is on a Cloudflare-fed build (≥ the first Cloudflare
release), you can delete the `github` entry from `publish:` in
`electron-builder.yml` to stop publishing to GitHub entirely.

---

## Locking downloads down (optional — this is the only reason to add a Worker)

A custom domain on R2 is **public**. Anyone who knows
`updates.rmcardz.com/RM-Operations-App-Setup-0.0.51.exe` can download it. For an
internal tool that already requires a login before it does anything, that is
usually an acceptable trade — it is the installer, not the data.

If you would rather it were not public, that is the one job a Worker does here:

1. Bucket → **Settings** → turn **Public access** OFF (remove the custom domain).
2. **Workers & Pages** → **Create** → **Worker** → name it `rmops-updates` →
   **Deploy** (the default hello-world is fine; you edit it in the browser).
3. Worker → **Settings** → **Bindings** → **Add** → **R2 bucket** → variable
   name `BUCKET`, bucket `rmops-updates`.
4. Worker → **Settings** → **Variables** → add a secret, e.g. `FEED_KEY`.
5. **Edit code** in the dashboard and have it read the key from a header or
   query string, return 404 without it, and otherwise stream the object from
   `env.BUCKET.get(...)`.
6. Worker → **Settings** → **Domains & Routes** → **Add** → *Custom domain* →
   `updates.rmcardz.com`.

The app would then need that key on its feed requests, which means a change to
`services/updater.ts`. Worth doing if the installers should not be world-
readable; skip it otherwise — it is a real amount of extra moving parts for a
file that contains no customer data.

## Why Mac can't silently auto-update (yet)

This is an **Apple** rule, not a hosting one — it's the same on GitHub or
Cloudflare. macOS Gatekeeper only lets an app replace itself when the app is
**code-signed with an Apple Developer ID and notarized**. Unsigned builds:

- show a Gatekeeper warning on first open (right-click → *Open*, once), and
- **cannot** be updated in place by Squirrel.Mac — hence the download-and-
  reinstall flow the app uses today.

### Enabling true Mac auto-update

The CI wiring for this is already in place and **off**. Turning it on is four
steps, and steps 1 and 2 are the only ones that take real time.

1. **Enrol in the Apple Developer Program** ($99/yr, apple.com/developer).
   Approval is usually a day or two for an individual, longer for a company
   (they verify the entity).
2. **Create a Developer ID Application certificate** and export it as a `.p12`
   with a password. Then create an **app-specific password** for your Apple ID
   at appleid.apple.com → Sign-In and Security. Note your **Team ID** from the
   membership page.
3. **Add to GitHub** → Settings → Secrets and variables → Actions:

   | Kind | Name | Value |
   |------|------|-------|
   | Variable | `MAC_SIGNING` | `true` |
   | Secret | `CSC_LINK` | the `.p12`, base64-encoded (`base64 -i cert.p12 \| pbcopy`) |
   | Secret | `CSC_KEY_PASSWORD` | the password you set on the `.p12` |
   | Secret | `APPLE_ID` | your Apple ID email |
   | Secret | `APPLE_APP_SPECIFIC_PASSWORD` | the app-specific password |
   | Secret | `APPLE_TEAM_ID` | your 10-character Team ID |

   The release workflow already reads all six. With `MAC_SIGNING` unset the
   values are empty and the Mac build stays unsigned exactly as it is today, so
   adding the secrets early is harmless.

4. **Flip `MAC_AUTO_UPDATE` to `true`** in `src/shared/config.ts` and release.
   That one constant switches the Mac path in `services/updater.ts` from the
   download-and-reinstall flow to `electron-updater`, and the Update panel's
   buttons and wording follow it automatically.

> **Do step 4 only after a signed build has actually shipped.** Flipping it on an
> unsigned build makes every Mac attempt a silent update that Squirrel then
> rejects — a recurring failure the operator can do nothing about. The safe order
> is: turn on signing, cut a release, download it on a Mac and confirm it opens
> with no Gatekeeper warning, *then* flip the constant.

Until then, the Cloudflare move still gives you: your own branded download
domain, full control of the files, no GitHub account needed to download, and
seamless Windows auto-update.
