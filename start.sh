#!/usr/bin/env bash
# =============================================================================
# noteflow — unified entry point
#
# Usage:
#   ./start.sh              build and start a local preview (default)
#   ./start.sh build        build to dist/ (never writes into the notes; missing
#                           abbrlinks are computed on the fly)
#   ./start.sh check        CI mode: read-only validation
#   ./start.sh serve        preview an existing dist/ (optional port: ./start.sh serve 7061)
#                           with sync configured in site.config.local.mjs, this is the
#                           serving daemon: poll the notes remote, rebuild on change
#   ./start.sh watch        rebuild on change + preview (edit your notes, refresh the browser)
#   ./start.sh backfill     pin missing abbrlinks into the notes' frontmatter (you commit them)
#   ./start.sh sync         one-shot: mirror the notes from their git remote, rebuild if
#                           anything moved (sync must be configured)
#   ./start.sh deploy       build + publish to the server
#   ./start.sh clean        remove the build output and caches
#   ./start.sh doctor       check local dependencies
#
#   Any command also accepts --config <file> to build a named profile instead
#   of the personal stack, e.g. the docs site:
#   ./start.sh build --config site.config.docs.mjs && ./start.sh serve --config site.config.docs.mjs
#
# Environment variables:
#   CONTENT_DIR   content directory, default from site.config.mjs (contentDir)
#   PORT          local preview port, default 7060
#   PANDOC        path to the pandoc binary
# =============================================================================
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

if [ -t 1 ]; then
  DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
else
  DIM=''; RED=''; GREEN=''; BLUE=''; RESET=''
fi
info() { printf '%s==>%s %s\n' "$BLUE" "$RESET" "$*"; }
ok()   { printf '%s  ✓%s %s\n' "$GREEN" "$RESET" "$*"; }
die()  { printf '%s  ✗%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

config_val() {
  # A named --config profile (e.g. site.config.docs.mjs) replaces the personal
  # config stack; its own contentDir/outDir then drive everything below. The
  # subcommands just forward argv, which already carries the flag — only these
  # lookups need it extracted.
  if [ "$HAS_CONFIG_ARG" = 1 ]; then
    node src/cli/config-print.ts --config "$CONFIG_FILE" "$@" || die "failed to read config ($*)"
  else
    node src/cli/config-print.ts "$@" || die "failed to read config ($*)"
  fi
}

CONFIG_FILE=""
_scan_prev=""
for _a in "$@"; do
  if [ "$_scan_prev" = "--config" ]; then CONFIG_FILE="$_a"; fi
  case "$_a" in --config=*) CONFIG_FILE="${_a#--config=}" ;; esac
  _scan_prev="$_a"
done
HAS_CONFIG_ARG=0
[ -n "$CONFIG_FILE" ] && HAS_CONFIG_ARG=1

CFG_OUT="$(config_val contentDir outDir)"
mapfile -t CFG <<< "$CFG_OUT"
RAW_CONTENT_DIR="${CFG[0]:-notes}"
CONTENT_DIR="$RAW_CONTENT_DIR"
OUT_DIR="${CFG[1]:-dist}"
# Fall back to the project's own docs when the real content repository is
# absent — only for the personal config; a named profile must stand on its own.
# `sync` keeps RAW_CONTENT_DIR: an absent dir there is the clone target.
if [ "$HAS_CONFIG_ARG" = 0 ] && [ ! -d "$CONTENT_DIR" ] && [ -d docs ]; then
  printf '  ! %s/ not found; building the docs content in docs/ as a demo\n' "$CONTENT_DIR" >&2
  CONTENT_DIR=docs
fi
PORT="${PORT:-7060}"
PANDOC="${PANDOC:-pandoc}"

# A port that is not a number would only fail much later, inside serve.ts.
validate_port() {
  if ! [[ "$1" =~ ^[0-9]+$ ]] || [ "$1" -lt 1 ] || [ "$1" -gt 65535 ]; then
    die "invalid port: $1"
  fi
}

# -----------------------------------------------------------------------------
# Dependency checks
# -----------------------------------------------------------------------------

need_node() {
  command -v node >/dev/null 2>&1 || die "node not found (need >= 22.18)"
  local v major minor
  v="$(node -v)"; v="${v#v}"
  major="${v%%.*}"; minor="${v#*.}"; minor="${minor%%.*}"
  if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 18 ]; }; then
    die "node too old: $(node -v), need >= 22.18 (the builder runs .ts natively). Open a fresh shell or nvm use 22."
  fi
  ok "node $(node -v)"
}

need_pandoc() {
  command -v "$PANDOC" >/dev/null 2>&1 || die "pandoc not found (need >= 3.0, see https://pandoc.org/installing.html)"
  local ver major
  ver="$("$PANDOC" --version | head -1 | sed 's/^pandoc //')"
  major="${ver%%.*}"
  [ "${major:-0}" -ge 3 ] || die "pandoc too old: $ver, need >= 3.0"
  ok "pandoc $ver"
}

need_chromium() {
  # Only check when mermaid actually appears in the content; if missing, the
  # build degrades diagrams to source blocks instead of blocking.
  # Fences may be indented (inside lists); a ```mermaid line is a fence opener.
  grep -rqsE '^[[:space:]]*```+[[:space:]]*mermaid[[:space:]]*$|^[[:space:]]*::: *\.mermaid|^[[:space:]]*::: *\{[^}]*\.mermaid' "$CONTENT_DIR" 2>/dev/null || return 0
  local root="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
  if [ -n "${MERMAID_CHROMIUM:-}" ] && [ -x "$MERMAID_CHROMIUM" ]; then
    ok "mermaid Chromium: $MERMAID_CHROMIUM"
  elif compgen -G "$root/chromium-*/chrome-linux64/chrome" >/dev/null; then
    ok "mermaid prerender ready (local Chromium)"
  else
    printf '  ! Content contains mermaid diagrams but no Chromium was found; diagrams will degrade to source.\n'
    printf '    Install: npx playwright-core install chromium (or set MERMAID_CHROMIUM)\n'
  fi
}

need_content() {
  [ -d "$CONTENT_DIR" ] || die "content directory not found: $CONTENT_DIR"
  ok "content directory $CONTENT_DIR"
}

doctor() {
  info "Checking dependencies"
  need_node
  need_pandoc
  need_content
  need_chromium
  ok "All ready"
}

# -----------------------------------------------------------------------------
# Build / preview
# -----------------------------------------------------------------------------
do_build() {
  need_node
  need_pandoc
  need_content
  PANDOC_BIN="$(command -v "$PANDOC")"
  export PANDOC_BIN
  info "Building site → $OUT_DIR/"
  # With --config in argv the profile's own contentDir must win: no --content.
  if [ "$HAS_CONFIG_ARG" = 1 ]; then
    node src/cli/build.ts "$@"
  else
    node src/cli/build.ts --content "$CONTENT_DIR" "$@"
  fi
  ok "Build complete"
}

# PIDs listening on $PORT, from `ss` (falls back to `lsof`). Prints nothing when
# the port is free.
port_pids() {
  # `|| true`: an empty result (port free) makes grep/lsof exit 1, which under
  # `set -euo pipefail` would otherwise kill the script.
  if command -v ss >/dev/null 2>&1; then
    ss -ltnpH "sport = :$PORT" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true
  elif command -v lsof >/dev/null 2>&1; then
    lsof -wn -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | sort -u || true
  fi
}

# A stale preview from a previous run is the usual cause of a port clash. Kill
# it only when it really is this project's serve.ts: never anything else that
# happens to hold the port.
free_port() {
  local pids cmd pid
  pids="$(port_pids)"
  [ -n "$pids" ] || return 0

  for pid in $pids; do
    cmd="$(ps -o args= -p "$pid" 2>/dev/null || true)"
    case "$cmd" in
      # `npm run serve` starts it without --root; both forms are ours.
      *src/cli/serve.ts*) ;;
      *)
        printf '%s  !%s port %s is held by an unrelated process (pid %s): %s\n' "$RED" "$RESET" "$PORT" "$pid" "${cmd:-unknown}" >&2
        die "refusing to kill it; stop it yourself or pick another port: ./start.sh serve 7061"
        ;;
    esac
  done

  # Word splitting is intended: $pids is a newline-separated PID list.
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  for _ in $(seq 1 20); do
    [ -z "$(port_pids)" ] && { ok "Stopped the previous preview (pid $pids)"; return 0; }
    sleep 0.1
  done
  # shellcheck disable=SC2086
  kill -9 $pids 2>/dev/null || true
  sleep 0.2
  [ -z "$(port_pids)" ] || die "port $PORT is still in use after killing pid $pids"
  ok "Stopped the previous preview (pid $pids)"
}

# Non-fatal --exists probe; a config that no longer parses fails inside serve.
sync_enabled() {
  if [ "$HAS_CONFIG_ARG" = 1 ]; then
    node src/cli/config-print.ts --config "$CONFIG_FILE" --exists sync 2>/dev/null
  else
    node src/cli/config-print.ts --exists sync 2>/dev/null
  fi
}

do_serve() {
  # In sync mode serve owns the no-dist decision (it clones and builds); every
  # other mode needs an existing dist.
  sync_enabled || { [ -d "$OUT_DIR" ] || die "$OUT_DIR/ does not exist; run ./start.sh build first"; }
  need_node
  free_port
  info "Local preview http://localhost:${PORT}/  ${DIM}(Ctrl+C to stop)${RESET}"
  exec node src/cli/serve.ts --root "$OUT_DIR" --port "$PORT" "$@"
}

do_watch() {
  need_node
  need_pandoc
  need_content
  free_port || true
  PANDOC_BIN="$(command -v "$PANDOC")"
  export PANDOC_BIN
  # Watch builds in the background and serve the result; the preview re-reads
  # CSP hashes from dist/ per request, so it always matches the latest build.
  # A background command inherits SIG_IGN for SIGINT, so Ctrl+C never reaches
  # it: stop it from a trap instead. The trap is installed before the spawn so
  # no Ctrl+C can land in the window between the two.
  local watch_pid=
  trap '[ -n "$watch_pid" ] && kill "$watch_pid" 2>/dev/null || true' EXIT INT TERM HUP
  if [ "$HAS_CONFIG_ARG" = 1 ]; then
    node src/cli/watch.ts "$@" &
  else
    node src/cli/watch.ts --content "$CONTENT_DIR" "$@" &
  fi
  watch_pid=$!
  info "Watching for changes; preview http://localhost:${PORT}/  ${DIM}(Ctrl+C to stop both)${RESET}"
  # "$@" carries --config: without it the preview would load the personal
  # config stack (no base path) while serving a prefixed dist.
  node src/cli/serve.ts --root "$OUT_DIR" --port "$PORT" "$@"
}

# -----------------------------------------------------------------------------
# Deploy / clean
# -----------------------------------------------------------------------------
do_deploy() {
  do_build
  [ -f scripts/deploy.sh ] || die "scripts/deploy.sh is not implemented yet"
  info "Running scripts/deploy.sh"
  bash scripts/deploy.sh
}

do_backfill() {
  need_node
  # The one command that writes into the notes: never the docs demo fallback,
  # and never a silent substitution — a missing dir is an error.
  [ -d "$RAW_CONTENT_DIR" ] || die "content directory not found: $RAW_CONTENT_DIR"
  if [ "$HAS_CONFIG_ARG" = 1 ]; then
    node src/content/abbrlink.ts "$@"
  else
    node src/content/abbrlink.ts --content "$RAW_CONTENT_DIR" "$@"
  fi
}

do_sync() {
  need_node
  need_pandoc
  command -v git >/dev/null 2>&1 || die "git not found (sync shells out to git)"
  PANDOC_BIN="$(command -v "$PANDOC")"
  export PANDOC_BIN
  # An absent content dir is the clone target: use the configured dir, not the
  # docs demo fallback.
  if [ "$HAS_CONFIG_ARG" = 1 ]; then
    node src/cli/sync.ts "$@"
  else
    node src/cli/sync.ts --content "$RAW_CONTENT_DIR" "$@"
  fi
}

do_clean() {
  info "Cleaning build output"
  local cache_dir
  cache_dir="$(config_val cacheDir)"
  rm -rf "$OUT_DIR" "$cache_dir"
  ok "Removed $OUT_DIR/ and $cache_dir/"
}

usage() {
  # The header comment block, between the two ==== rulers, uncommented.
  awk 'NR==1{next} /^# =+$/{n++; if(n==1) next; exit} n>=1{sub(/^# ?/,""); print}' "$0"
}

# -----------------------------------------------------------------------------
# Entry point
# -----------------------------------------------------------------------------
case "${1:-all}" in
  --help|-h|help) usage ;;
  serve)  # optional leading port number, then flags (--config …)
          shift
          if [[ "${1:-}" =~ ^[0-9]+$ ]]; then PORT="$1"; shift; fi
          validate_port "$PORT"
          do_serve "$@" ;;
  doctor) doctor ;;
  build)  shift; do_build "$@" ;;
  check)  shift; do_build --check "$@" ;;
  watch)  shift; do_watch "$@" ;;
  backfill) shift; do_backfill "$@" ;;
  sync)   shift; do_sync "$@" ;;
  deploy) do_deploy ;;
  clean)  do_clean ;;
  all)    doctor; do_build; do_serve ;;
  *)      die "unknown command: $1 (see ./start.sh --help)" ;;
esac
