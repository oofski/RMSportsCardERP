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
