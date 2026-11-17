#!/usr/bin/env bash
# =============================================================================
# Deploy: dist/ → server releases/<buildId>/ → atomic switch of the current symlink
#
# Single entry point: the ./start.sh build audit gate must have passed, and the
# distHash in .build-manifest.json must match the actual dist/, otherwise the
# upload is refused (prevents "audit failed, so rsync old output by hand").
#
# Requires .env.deploy:
#   DEPLOY_HOST=deploy@vps.example.com
#   DEPLOY_ROOT=/srv/noteflow
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

[ -f .env.deploy ] || { echo ".env.deploy is missing" >&2; exit 1; }
# shellcheck disable=SC1091
. ./.env.deploy
: "${DEPLOY_HOST:?}" "${DEPLOY_ROOT:?}"

# Same resolution path as the builder (site.config.ts ← local override ← defaults).
mapfile -t CFG < <(node src/cli/config-print.ts outDir manifestFile)
OUT_DIR="${CFG[0]}"
MANIFEST="${CFG[1]}"

[ -d "$OUT_DIR" ] || { echo "$OUT_DIR/ does not exist; run ./start.sh build first" >&2; exit 1; }
[ -f "$MANIFEST" ] || { echo "$MANIFEST is missing" >&2; exit 1; }

read -r BUILD_ID EXPECTED < <(node -p "[JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).buildId, JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).distHash].join(' ')" "$MANIFEST")
# One implementation: src/cli/hash-dist.ts shares hashDist() with the builder.
ACTUAL="$(node src/cli/hash-dist.ts "$OUT_DIR")"

if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "✗ $OUT_DIR/ does not match the manifest (modified after the audit?). Re-run ./start.sh build" >&2
  exit 1
fi

# ---- Regenerate nginx security headers (CSP hashes change with the output) ----
HDR="$(node src/cli/gen-nginx.ts)"

RELEASE="$DEPLOY_ROOT/releases/$BUILD_ID"
echo "==> rsync to $DEPLOY_HOST:$RELEASE"
ssh "$DEPLOY_HOST" "mkdir -p '$RELEASE'"
rsync -az --delete --chmod=F644,D755 "$OUT_DIR/" "$DEPLOY_HOST:$RELEASE/"

# The rate-limit zones moved to their own http{}-context snippet; deploy it
# next to the header snippet so a config refresh never depends on a manual copy.
ZONES_SRC="deploy/nginx/snippets/rate-limit-zones.conf"
if [ -n "${DEPLOY_NGINX_ZONES_SNIPPET:-}" ]; then
  echo "==> Updating nginx rate-limit zones"
  ssh "$DEPLOY_HOST" "cat > '$DEPLOY_NGINX_ZONES_SNIPPET'" < "$ZONES_SRC"
elif [ -n "${DEPLOY_NGINX_SNIPPET:-}" ]; then
  # Default: sibling file of the header snippet (…/security-headers.conf → …/rate-limit-zones.conf)
  zones_default="$(dirname "$DEPLOY_NGINX_SNIPPET")/rate-limit-zones.conf"
  echo "==> Updating nginx rate-limit zones ($zones_default)"
  ssh "$DEPLOY_HOST" "cat > '$zones_default'" < "$ZONES_SRC"
fi

echo "==> Updating nginx security headers"
if [ -n "${DEPLOY_NGINX_SNIPPET:-}" ]; then
  # Snippet path on the server; if it needs sudo to write, allow that for the deploy user in advance
  ssh "$DEPLOY_HOST" "cat > '$DEPLOY_NGINX_SNIPPET' && sudo nginx -t && sudo nginx -s reload" <<< "$HDR"
else
  echo "  (DEPLOY_NGINX_SNIPPET not set; skipping nginx header sync. If new style="" appeared, sync manually)" >&2
fi

echo "==> Atomic switch of current"
ssh "$DEPLOY_HOST" "ln -sfn '$RELEASE' '$DEPLOY_ROOT/current.tmp' && mv -T '$DEPLOY_ROOT/current.tmp' '$DEPLOY_ROOT/current'"
echo "✓ Published $BUILD_ID"
