# Hosting RM Operations on Render

The easy route. No SSH, no Docker commands, no certificate to set up, no
firewall to configure. Render reads `render.yaml`, builds the container, mounts
a disk and gives you an HTTPS address.

Use this instead of `docs/VULTR.md` unless you specifically want your own
machine.

## What it costs

| | |
|---|---|
| Starter web service | $7/month |
| 10 GB disk | ~$2.50/month |

Fixed, not metered.

**The Free plan will not work**, and it is worth being clear why rather than
discovering it: free services have no persistent disk, so the database would be
destroyed on every deploy. Free services also sleep when idle, which on a
clock-in screen means the first person each morning waits for a cold start.

## Setting it up

1. **Sign up** at render.com and connect your GitHub account.
2. **New → Blueprint.**
3. Pick the `oofski/RMSportsCardERP` repository. Render finds `render.yaml`.
4. It will ask for two values, because they are deliberately not in the file:

   | | |
   |---|---|
   | `RMOPS_SYNC_URL` | your relay Worker's address |
   | `RMOPS_SYNC_KEY` | the shared key |

   **Fill these in now, before anybody signs in.** With them the server pulls
   your existing company down from the relay on first boot. Without them you get
   an empty app inviting you to create an Owner account — and if somebody
   accepts, you now have two companies that will never agree.

5. **Apply.** The first build takes several minutes: it compiles better-sqlite3
   from source for Render's machines, which is the whole reason there is a
   Dockerfile.

That is the setup. You get `https://rm-operations.onrender.com` with a working
certificate.

## Check it worked

- **Logs** should show `listening ... 232 operations`.
- Visit `/health` — expect `{"ok":true,"version":"0.0.101",...}`. **The version is
  the answer to "did my deploy land?"** — it is the running build's, so compare it
  against the latest release before believing anything else on this page.
- Wait a minute for the first sync, then sign in with your **existing** company
  ID and password. If it asks you to create an Owner account, stop and read
  "When it breaks" below.

## Your own domain

Settings → Custom Domain, add `rm.yourdomain.com`, then add the CNAME Render
gives you at your registrar. The certificate is automatic.

## Backups — do this before you trust it

Render backs up disks on paid plans, but the safe copy is the one you can
restore without asking anybody. Open a Shell from the service page:

```bash
node -e "
  const db = require('better-sqlite3')('/data/rm-operations.db');
  db.exec(\"VACUUM INTO '/data/backup-$(date +%F).db'\");
"
```

`VACUUM INTO` is safe on a live database. Copying the `.db` file while people
are using it is not — that is how you get a backup that restores into a corrupt
database months later.

Download it from the Shell, and keep the copies somewhere that is not Render.

## Updating

**Every push to `claude/rm-operations-app-initial-3sml0r` redeploys the web app.**
Nothing to click, nothing to download — the tab is on the new version a few
minutes later, and people already signed in stay signed in.

That is Render's default, and it is worth checking once rather than assuming:

- **Settings → Build & Deploy → Auto-Deploy** should read **Yes**.
- **Settings → Branch** must be the branch above. This is the branch releases are
  cut from; pointed anywhere else the site quietly stops following the app.
- The **Events** tab shows a deploy starting within a minute of each push. If one
  is missing, that is where the reason is.

So a release now updates two things from the one push: the web app on its own,
and the desktop installers, which each machine still has to accept.

The disk is not touched by a deploy. That is the point of it.

## When it breaks

**It asks me to create an Owner account and I already have one.** It cannot see
your data. Either the sync values are missing or wrong, or the disk did not
mount. **Do not create the account** — that starts a second company. Check the
logs for sync errors first.

**It offers me a software update / a download that does not work.** It should
not, and after v0.0.101 it does not. The web app has no "Check for updates" —
the page is whatever was deployed last, so it is always current. If you still
see one, you are on an older deploy: check `/health` for the version.

**The inventory totals are smaller here than in the desktop app.** On-hand
quantity is the one number that does not travel between machines. It is summed
from the FIFO cost layers, which do travel, and each machine works it out for
itself — so a shelf can arrive here with every layer and no count, and a screen
whose totals follow the count values it at zero.

Admin → Cloud sync lists any shelf where the two disagree, with a button that
rebuilds the counts from the layers. On this server that is always the right
answer: nothing here was ever counted by hand.

If the list is long and keeps coming back, the sync is not finishing. Check the
Sync screen's "Needs a look" figure and the logs.

**Deploy fails on health check.** The service is not answering `/health`. Check
the logs for a startup error — the most likely one is the disk guard below.

**"RMOPS_DATA_DIR is on the container's own filesystem."** The disk is not
mounted at `/data`. The app is refusing to start rather than writing a database
it is about to lose. Check the disk's mount path matches `RMOPS_DATA_DIR`.

**Build runs out of memory.** Raise the instance plan for one deploy, then lower
it — the build needs more than the app does.

**Everything is slow after months of use.** From the Shell:
`node -e "require('better-sqlite3')('/data/rm-operations.db').exec('VACUUM')"`

## What this does not give you

- **One instance, always.** A Render disk attaches to exactly one instance, and
  this app is one process owning one SQLite file. Raising the instance count
  does not make it faster — it makes two databases that quietly diverge.
- **No automatic failover.** If Render has an outage, the web app is down. The
  desktop apps keep working offline and sync when it returns.
- **The QuickBooks refresh token is on the disk in plain text.** No OS keychain
  in a datacentre. Treat disk backups as secret material.
- **Anyone with the URL reaches the login page.** It is a password on the open
  internet. Cloudflare Access in front would be a large improvement cheaply.
