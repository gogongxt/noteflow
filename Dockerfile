# noteflow in a container: mount your notes, get a served site.
#
#   docker run --rm -p 8080:8080 -v "$PWD/notes:/app/notes:rw" ghcr.io/gogongxt/noteflow:latest
#
# The image builds the site from /app/notes on every start (abbrlinks are
# written back there, so the mount is read-write) and serves it through the
# project's own server, which sends production's CSP and cache policy. A
# baked-in dist/ would go stale the moment you edit a note, and nginx's
# production headers carry upgrade-insecure-requests — meaningful only behind
# TLS, which would break a plain-http container.

ARG NODE_VERSION=22-bookworm-slim

# ---- build base: everything npm ci and a local `./start.sh build` need ------
FROM node:${NODE_VERSION} AS base
ARG PANDOC_VERSION=3.13
ARG TARGETARCH
# The distro pandoc lacks the +server feature the builder runs against.
RUN case "$TARGETARCH" in arm64|amd64) ;; *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; esac \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && curl -fsSL "https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}/pandoc-${PANDOC_VERSION}-linux-${TARGETARCH}.tar.gz" \
    | tar xz --strip-components=2 -C /usr/local/bin "pandoc-${PANDOC_VERSION}/bin/pandoc" \
 && pandoc --version | grep -q '+server' \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---- deps: production node_modules, plus playwright-core for mermaid -------
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ---- renderer: headless Chromium for mermaid prerendering ------------------
# Without it the build still completes, but diagrams degrade to source blocks,
# so this is an upgrade to the final image rather than a separate stage.
FROM deps AS renderer
RUN npx playwright-core install --with-deps chromium

# ---- runtime ---------------------------------------------------------------
FROM renderer AS runtime
# No NODE_ENV=production: the build runs mermaid and playwright-core, which are
# devDependencies — npm would omit them under it.
ENV PANDOC_BIN=pandoc \
    PORT=8080 \
    PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
# site.config.mjs is the only file a self-hoster edits; theme, source and the
# demo content are the rest of what the build reads.
COPY site.config.mjs ./
COPY src ./src
COPY themes ./themes
COPY docs ./docs
COPY start.sh ./
COPY docker/entrypoint.sh /usr/local/bin/noteflow-entrypoint
RUN chmod +x /usr/local/bin/noteflow-entrypoint

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# As root, so a bind-mounted notes/ owned by any host uid can be written
# (abbrlinks are assigned on first build). The container is a single-purpose
# static site; it runs no untrusted code beyond what the build already does.
ENTRYPOINT ["noteflow-entrypoint"]