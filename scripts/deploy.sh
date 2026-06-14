#!/usr/bin/env bash
# hamlive-oss — MIT License. See LICENSE.
#
# One-shot deploy helper for a git-pull-based deployment (e.g. a Proxmox LXC
# container or any host that checks out this repo at $APP_DIR and runs it under
# a systemd service).
#
# It fast-forwards the deploy checkout to origin/<branch> using a hard reset so
# stale local edits never block a pull again — but it first PRINTS exactly what
# tracked changes would be discarded and waits for confirmation. Untracked files
# (your .env, secrets, uploads) are never touched by `git reset --hard`.
#
# Nothing here is environment-specific: point it at your box with env vars.
#
# ── Configuration (env vars) ───────────────────────────────────────────────
#   DEPLOY_BRANCH   branch to deploy            (or pass as $1; default: staging)
#   APP_DIR         repo checkout on the box    (default: /opt/hamlive)
#   SERVICE         systemd service to restart  (default: hamlive)
#   REMOTE_EXEC     command prefix that runs a shell command ON the target.
#                   Default runs locally. Examples:
#                     # Proxmox host, container 204, as the hamlive user:
#                     REMOTE_EXEC='pct exec 204 -- runuser -u hamlive --'
#                     # over SSH:
#                     REMOTE_EXEC='ssh deploy@staging.example.com'
#   RESTART_EXEC    command prefix for the (often root) service restart.
#                   Default: same as REMOTE_EXEC. Example for Proxmox:
#                     RESTART_EXEC='pct exec 204 --'
#   FORCE=1         skip the confirmation prompt (for CI / non-interactive use)
#   CF_ZONE_ID,CF_API_TOKEN
#                   if both set, purge Cloudflare cache for /js and /css after
#                   restart (see also the cache-rule note in docs/DEPLOY.md).
#   CF_BASE_URL     site origin for the purge (e.g. https://staging.example.com)
#
# ── Usage ──────────────────────────────────────────────────────────────────
#   REMOTE_EXEC='pct exec 204 -- runuser -u hamlive --' \
#   RESTART_EXEC='pct exec 204 --' \
#     ./scripts/deploy.sh staging
#
set -euo pipefail

BRANCH="${1:-${DEPLOY_BRANCH:-staging}}"
APP_DIR="${APP_DIR:-/opt/hamlive}"
SERVICE="${SERVICE:-hamlive}"
REMOTE_EXEC="${REMOTE_EXEC:-}"
RESTART_EXEC="${RESTART_EXEC:-$REMOTE_EXEC}"
FORCE="${FORCE:-0}"

# Run a command on the target box (in $APP_DIR) via the configured prefix.
remote() {
    # shellcheck disable=SC2086
    $REMOTE_EXEC bash -c "cd '$APP_DIR' && $*"
}

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

say "Deploy target: ${REMOTE_EXEC:-<local>}  dir=$APP_DIR  branch=$BRANCH  service=$SERVICE"

say "Current checkout"
remote "git log -1 --oneline"

say "Fetching origin"
remote "git fetch --all --prune"

say "Tracked local changes that a hard reset WILL DISCARD (empty = clean)"
# Diff the working tree against the incoming commit; show names only.
remote "git diff --stat HEAD origin/$BRANCH || true; echo '--- uncommitted local edits (also discarded): ---'; git status --porcelain --untracked-files=no"

if [ "$FORCE" != "1" ]; then
    printf '\n\033[1;33mProceed with: git reset --hard origin/%s ? [y/N] \033[0m' "$BRANCH"
    read -r ans
    case "$ans" in
        y|Y|yes|YES) ;;
        *) echo "Aborted."; exit 1 ;;
    esac
fi

say "Resetting to origin/$BRANCH"
remote "git reset --hard origin/$BRANCH"
remote "git log -1 --oneline"

say "Restarting service: $SERVICE"
# shellcheck disable=SC2086
$RESTART_EXEC systemctl restart "$SERVICE"
# shellcheck disable=SC2086
$RESTART_EXEC systemctl --no-pager --lines=0 status "$SERVICE" || true

if [ -n "${CF_ZONE_ID:-}" ] && [ -n "${CF_API_TOKEN:-}" ] && [ -n "${CF_BASE_URL:-}" ]; then
    say "Purging Cloudflare cache for /js and /css"
    curl -fsS -X POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache" \
        -H "Authorization: Bearer ${CF_API_TOKEN}" \
        -H "Content-Type: application/json" \
        --data "{\"prefixes\":[\"${CF_BASE_URL#https://}/js/\",\"${CF_BASE_URL#https://}/css/\"]}" \
        && echo "  cache purge requested" || echo "  cache purge FAILED (purge manually)"
else
    say "Reminder: purge the CDN cache for /js/* and /css/* (or use a cache rule — see docs/DEPLOY.md)"
fi

say "Done."
