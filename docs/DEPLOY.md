# Deployment

This project deploys by checking the repo out on the target host, running it
under a process manager (systemd in the examples below), and serving static
assets through a CDN. `scripts/deploy.sh` automates the routine pull-and-restart;
this document covers the surrounding setup.

## Model

```
git push origin <branch>   →   target host: git reset --hard origin/<branch>   →   restart service   →   purge CDN
```

- The target host has a checkout at `$APP_DIR` (default `/opt/hamlive`) on a
  long-lived branch (e.g. `staging` for the staging host, `main` for production).
- Secrets live in an **untracked** `.env` at `$APP_DIR/.env` (see below). It is
  never touched by deploys.
- Compiled output (`server/dist`, `client/dist`) is committed, so no build step
  runs on the host.

## One-shot deploy

`scripts/deploy.sh` fetches origin and **hard-resets** the checkout to
`origin/<branch>`. This is deliberate: it means stale local edits on the host can
never block a deploy again (no more `git stash` dance). Before resetting it prints
exactly which tracked changes will be discarded and waits for confirmation.
Untracked files (your `.env`, uploads) are never affected by `git reset --hard`.

Point it at your host with env vars — nothing is hardcoded:

```bash
# Example: a Proxmox LXC container <CTID>, app running as user `hamlive`
REMOTE_EXEC='pct exec <CTID> -- runuser -u hamlive --' \
RESTART_EXEC='pct exec <CTID> --' \
  ./scripts/deploy.sh staging

# Example: a plain host over SSH
REMOTE_EXEC='ssh deploy@your-host' \
RESTART_EXEC='ssh root@your-host' \
  ./scripts/deploy.sh main
```

See the header of `scripts/deploy.sh` for every variable (`APP_DIR`, `SERVICE`,
`FORCE`, Cloudflare purge vars).

## Handling dependency updates

When a deploy introduces new npm dependencies (noted in `PATCHES.md`), run
`npm install` after `git reset --hard` and before restarting the service. For
example:

```bash
cd $APP_DIR
git reset --hard origin/<branch>
npm install                 # required when dependencies are added
systemctl restart hamlive
```

Subsequent deploys without dependency changes do not need `npm install` — a plain
`git reset --hard` + restart is sufficient. The repo's commit message and
`PATCHES.md` catalog which releases added new dependencies.

## Prerequisite: strong production secrets

In production (`NODE_ENV=production`) the app **refuses to start** if
`COOKIE_SESSION_KEY` or `MAGIC_LINK_SECRET` are missing, default, or too short
(enforced by `checkSecrets()` in `server/dist/lib/configLib.js`). Rotate them to
strong random values **before** deploying onto a fresh/production host:

```bash
openssl rand -base64 48   # run twice; set COOKIE_SESSION_KEY and MAGIC_LINK_SECRET in $APP_DIR/.env
```

If the service fails to start after a deploy, check `journalctl -u <service>` for
the secret-guard message first.

## CDN cache (static JS/CSS)

`express.static` serves `/js` and `/css` with a 2-hour `max-age`, so a CDN in
front will cache them. After a deploy that changes client assets you must either
**purge** those paths or configure the CDN not to cache them.

**Option A — purge on deploy (recommended).** Set these and `deploy.sh` purges
`/js/*` and `/css/*` automatically after restart:

```bash
export CF_ZONE_ID=...        # Cloudflare zone id
export CF_API_TOKEN=...       # token with Cache Purge permission
export CF_BASE_URL=https://your-host
```

**Option B — a CDN cache rule.** In Cloudflare, add a Cache Rule:
*When incoming request URI Path starts with `/js/` or `/css/` → Edge TTL: short
(e.g. 60s) or Bypass cache.* This trades some edge caching for never serving
stale assets after a deploy. (When client assets are content-hashed in a future
change, this can be reversed to cache aggressively.)

## Content Security Policy note

`script-src` uses a per-request **nonce** (no `'unsafe-inline'`; see
`server/dist/server.js`). Any new inline `<script>` in an EJS view/partial must
carry `nonce="<%= cspNonce %>"` or the browser will refuse to run it. External
`src=` scripts must come from an allow-listed host in the `scriptSrc` directive.
