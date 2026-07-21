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

1. **Create an R2 bucket** (Cloudflare dashboard → R2 → *Create bucket*), e.g.
   `rmops-updates`.
2. **Give it a public domain.** In the bucket → *Settings* → *Public access* →
   *Connect a custom domain*, add `updates.rmcardz.com` (Cloudflare manages the
   DNS if `rmcardz.com` is on Cloudflare). This is the base URL clients read.
3. **Create an R2 API token** (R2 → *Manage API Tokens* → *Create*, Object
   Read & Write for the bucket). Note the **Access Key ID**, **Secret Access
   Key**, and your account's **S3 endpoint**
   `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.

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

## Why Mac can't silently auto-update (yet)

This is an **Apple** rule, not a hosting one — it's the same on GitHub or
Cloudflare. macOS Gatekeeper only lets an app replace itself when the app is
**code-signed with an Apple Developer ID and notarized**. Unsigned builds:

- show a Gatekeeper warning on first open (right-click → *Open*, once), and
- **cannot** be updated in place by Squirrel.Mac — hence the download-and-
  reinstall flow the app uses today.

### Enabling true Mac auto-update later

1. Enrol in the **Apple Developer Program** ($99/yr) and create a **Developer ID
   Application** certificate.
2. Add signing + notarization secrets to CI: `CSC_LINK` (base64 .p12),
   `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
3. In the Mac build, set `CSC_IDENTITY_AUTO_DISCOVERY: true` and add
   `mac.notarize: true` (electron-builder) / an `afterSign` notarize step.
4. Switch the macOS path in `src/main/services/updater.ts` from the
   download-link flow back to `electron-updater` (it already reads the same
   generic Cloudflare feed) — Macs will then download + install automatically,
   just like Windows.

Until then, the Cloudflare move still gives you: your own branded download
domain, full control of the files, and seamless Windows auto-update.
