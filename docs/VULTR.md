# Hosting RM Operations on a Vultr VPS

A fixed monthly bill, one machine, one disk, Docker. `docs/WEB.md` covers what
the server is and how it behaves; this file is the runbook for putting it on
Vultr specifically.

## What you are buying

| | |
|---|---|
| Instance | Cloud Compute — Regular, **2 GB RAM** |
| OS | Ubuntu 24.04 LTS |
| Region | whichever is nearest the warehouse |

**Take 2 GB, not 1 GB.** The 1 GB plan runs the app fine — it is the *build*
that kills it. `npm ci` plus compiling better-sqlite3 from source will exhaust
1 GB and the build dies with a bare `Killed`, which looks like a broken
Dockerfile and is not. If you are already on 1 GB, add swap before building:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

You also need a **domain name** pointing at the instance. The session cookie is
`Secure`, so the app cannot be signed into over plain `http://` — a login form
that never takes is the symptom. Any domain works; a subdomain is fine.

## 1. The instance

Create it in Vultr's panel with an SSH key, then:

```bash
ssh root@YOUR_IP
apt update && apt upgrade -y
```

## 2. Docker

```bash
curl -fsSL https://get.docker.com | sh
```

## 3. The app

The repository is public, so no credentials are needed to fetch it.

```bash
git clone https://github.com/oofski/RMSportsCardERP.git /opt/rmops
cd /opt/rmops
git checkout claude/rm-operations-app-initial-3sml0r
docker build -t rmops .
```

The build takes a few minutes. It compiles better-sqlite3 for this machine's
Node and architecture, which is the whole reason it happens here rather than
shipping a binary built somewhere else.

## 4. The data directory

```bash
mkdir -p /srv/rmops
```

This is the database, the product images and the QuickBooks token. It lives on
the host, NOT inside the container, which is what lets you rebuild and restart
the container without losing anything.

The server refuses to start unless this really is a separate filesystem from
the container's own — a `docker run` that forgot `-v` leaves the app writing to
a directory that disappears on the next rebuild, with no error and no missing
file. It simply comes up asking you to create an Owner account, and by then the
old database is gone. A bind mount satisfies the check; nothing else does.

## 5. Run it

```bash
docker run -d --name rmops --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v /srv/rmops:/data \
  -e NODE_ENV=production \
  -e RMOPS_DATA_DIR=/data \
  -e RMOPS_TRUST_PROXY=1 \
  -e RMOPS_SYNC_URL='https://YOUR-WORKER.workers.dev' \
  -e RMOPS_SYNC_KEY='YOUR-KEY' \
  rmops
```

Three things in there matter:

- **`-p 127.0.0.1:8080:8080`** binds to localhost only, so the app is not on the
  internet directly. Caddy is the only thing that reaches it. Bind it to `0.0.0.0`
  and you have published an unencrypted copy of the app on port 8080, bypassing
  every TLS setting below.
- **`--restart unless-stopped`** brings it back after a reboot. Without it, a
  power cut in the warehouse is a morning nobody can clock in.
- **The sync secrets** point at the same relay the desktop apps use. Set them
  BEFORE anybody signs in: with them the server pulls your existing company down
  from the relay, without them you get an empty app inviting you to create a
  second, parallel company.

Check it:

```bash
docker logs rmops | tail -20      # expect "listening ... 232 operations"
curl -s localhost:8080/health     # {"ok":true,...}
```

## 6. HTTPS

Caddy gets and renews a Let's Encrypt certificate on its own. Point your
domain's A record at the instance IP first, or the certificate request fails.

```bash
apt install -y caddy
cat > /etc/caddy/Caddyfile <<'EOF'
rm.yourdomain.com {
    reverse_proxy 127.0.0.1:8080
}
EOF
systemctl restart caddy
```

That is the whole configuration. Visit `https://rm.yourdomain.com`.

## 7. Firewall

```bash
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw --force enable
```

Port 8080 is deliberately absent — it is bound to localhost and must stay
unreachable from outside.

## 8. Backups — do this before you trust it

One disk in one datacentre is not a backup. `VACUUM INTO` is safe to run while
the app is being used; a plain file copy of a live SQLite database is not.

```bash
mkdir -p /srv/rmops-backups
cat > /usr/local/bin/rmops-backup <<'EOF'
#!/bin/sh
set -e
STAMP=$(date +%F)
docker exec rmops node -e "
  const db = require('better-sqlite3')('/data/rm-operations.db');
  db.exec(\"VACUUM INTO '/data/backup-$STAMP.db'\");
"
mv /srv/rmops/backup-$STAMP.db /srv/rmops-backups/
find /srv/rmops-backups -name 'backup-*.db' -mtime +14 -delete
EOF
chmod +x /usr/local/bin/rmops-backup
echo '15 3 * * * root /usr/local/bin/rmops-backup' > /etc/cron.d/rmops-backup
```

Fourteen days, nightly. **Then get them off the machine** — Vultr's own snapshots
(a few dollars a month), `rclone` to Cloudflare R2, or a nightly `scp` to a
machine in the warehouse. A backup that only exists on the server it is backing
up is not one.

Verify the first backup by hand before assuming any of it works:

```bash
/usr/local/bin/rmops-backup && ls -la /srv/rmops-backups
```

## 9. Updating

```bash
cd /opt/rmops && git pull
docker build -t rmops .
docker stop rmops && docker rm rmops
# then the same docker run as step 5
```

The data directory is untouched by all of that — that is the point of it being
outside the container.

## When it breaks

**Cannot sign in, login form just clears.** You are on `http://`. The session
cookie is `Secure` and the browser is discarding it. Check Caddy is running and
you are visiting `https://`.

**"RMOPS_DATA_DIR is on the container's own filesystem".** The `-v` flag is
missing or the path is wrong. The app is refusing to start rather than writing a
database it is about to lose. Fix the `docker run`.

**App asks to create an Owner account when you already have one.** It is not
seeing your data. Either the sync secrets are wrong or missing, or `/srv/rmops`
is a different directory than the one it used before. **Do not create the
account** — that starts a second company. Stop, check `docker logs rmops` for
sync errors, and check the mount.

**Build dies with `Killed`.** Out of memory. Add swap (top of this file).

**Everything is slow after months of use.** `docker exec rmops node -e "require('better-sqlite3')('/data/rm-operations.db').exec('VACUUM')"`
during a quiet hour.

## What this does not give you

- **No automatic failover.** One machine. If it is down, the web app is down —
  though the desktop apps keep working offline and sync when it returns.
- **The QuickBooks refresh token is on the disk in plain text.** There is no OS
  keychain here. Treat backups of `/srv/rmops` as secret material.
- **Anyone who knows the URL reaches the login page.** It is a password, on the
  open internet. Cloudflare Access in front of it would be a large improvement
  for very little money.
