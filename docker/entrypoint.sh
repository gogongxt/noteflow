#!/bin/sh
# Build /app/notes and serve it on $PORT. Every start rebuilds: the mount may
# have changed, and CSP hashes are over the output bytes. A failed build exits
# non-zero rather than serving the previous tree — fail-closed, like CI.
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

# A source tree mounted over /app (latest code or your own fork) arrives without
# node_modules; install it once per mount. Without the mount the baked-in one
# is used and this is a no-op.
if [ ! -d node_modules ] || [ package.json -nt node_modules ]; then
  echo "==> Installing dependencies (source tree mounted?)"
  npm ci --ignore-scripts || npm install --ignore-scripts
fi

content_dir="${CONTENT_DIR:-notes}"
if [ ! -d "$content_dir" ]; then
  if [ -n "${CONFIG:-}" ]; then
    echo "entrypoint: content directory $content_dir is missing" >&2
    exit 1
  fi
  echo "entrypoint: $content_dir is missing; mounting it is the point — showing the project's own docs instead" >&2
  content_dir=docs
fi

echo "==> Building $content_dir → dist/"
set +e
node src/cli/build.ts $config_args --content "$content_dir"
status=$?
set -e
if [ "$status" -ne 0 ]; then
  if [ "$content_dir" != docs ]; then
    echo "entrypoint: build failed. If a note cannot be written (abbrlink), the content mount is read-only;" >&2
    echo "  mount it read-write: docker run -v \"\$PWD/notes:/app/notes:rw\" …" >&2
  fi
  exit "$status"
fi

echo "==> Serving on :${PORT:-8080} (CSP and cache policy as production, minus upgrade-insecure-requests — plain http)"
exec node src/cli/serve.ts --root dist --port "${PORT:-8080}" $config_args