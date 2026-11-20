#!/bin/sh
# Serve the notes on $PORT. With sync configured in the config stack, the
# serve process is the daemon: it clones/fetches the notes repository itself
# and rebuilds when the remote tip moves — nothing is pre-built here. Without
# sync, build once and fail closed on error, like CI.
set -eu

cd "${APP_ROOT:-/app}"

config_args=""
if [ -n "${CONFIG:-}" ]; then
  case "$CONFIG" in
    site.config.*) ;;
    *) echo "entrypoint: CONFIG must name a site.config.* file in /app, got: $CONFIG" >&2; exit 1 ;;
  esac
  [ -f "$CONFIG" ] || { echo "entrypoint: CONFIG file not found in /app: $CONFIG (mount it)" >&2; exit 1; }
  # Unquoted at every use below: it must split into two argv items.
  config_args="--config $CONFIG"
fi

# A source tree mounted over /app arrives without node_modules; install once
# per mount. Without the mount the baked-in one is used and this is a no-op.
if [ ! -d node_modules ] || [ package.json -nt node_modules ]; then
  echo "==> Installing dependencies (source tree mounted?)"
  npm ci || npm install
fi

# A fresh container has no known_hosts; accept the host key on first contact
# unless the operator brings their own ssh setup.
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o StrictHostKeyChecking=accept-new}"

# Unquoted $config_args: empty when there is no profile, else two argv items.
node src/cli/config-print.ts $config_args --exists sync && sync=1 || sync=0

content_dir="${CONTENT_DIR:-notes}"
if [ "$sync" = 0 ] && [ ! -d "$content_dir" ]; then
  if [ -n "${CONFIG:-}" ]; then
    echo "entrypoint: content directory $content_dir is missing" >&2
    exit 1
  fi
  echo "entrypoint: $content_dir is missing; mounting it is the point — showing the project's own docs instead" >&2
  content_dir=docs
fi

if [ "$sync" = 0 ]; then
  echo "==> Building $content_dir → dist/"
  set +e
  node src/cli/build.ts $config_args --content "$content_dir"
  status=$?
  set -e
  [ "$status" -ne 0 ] && exit "$status"
  exec node src/cli/serve.ts --root dist --port "${PORT:-8080}" $config_args
fi

# Sync mode: serve resolves the content dir from the config itself (or an
# explicit CONTENT_DIR); an absent dir is simply the clone target.
serve_content_args=""
[ -n "${CONTENT_DIR:-}" ] && serve_content_args="--content $CONTENT_DIR"
echo "==> Serving on :${PORT:-8080}, syncing the notes from their remote"
exec node src/cli/serve.ts --root dist --port "${PORT:-8080}" $serve_content_args $config_args
