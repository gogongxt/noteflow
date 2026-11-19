---
title: Deployment
public: true
description: Self-hosting with nginx, GitHub Pages, and custom domains
abbrlink: "211fd193"
---

`dist/` is a fully static tree — no application server, no runtime. Any static host works. Next to the pages it holds `feed.xml` (RSS), `sitemap.xml` (every public page, absolute URLs, one `<lastmod>` per entry) and a `robots.txt` that points at the sitemap.

# Docker

The published image bundles everything the build needs — Node, pandoc with `+server`, headless Chromium for mermaid — and serves the result. Mount a notes directory and it becomes a site:

```bash
docker run --rm -p 8080:8080 -v "$PWD/notes:/app/notes:rw" ghcr.io/gogongxt/noteflow:latest
```

Open <http://localhost:8080>. On start the container builds `/app/notes` and serves `dist/` through the project's own server, which sends production's CSP and cache policy. Two deliberate choices:

- **It builds on every start**, because CSP hashes are computed over the output bytes and a baked-in `dist/` would go stale the moment you edit a note. A build failure exits non-zero rather than serving the previous tree.
- **No `upgrade-insecure-requests`**, which the production nginx headers carry. That directive only makes sense behind TLS; on plain http it would rewrite same-origin requests to `https://` and break them.

The `:rw` matters: a note's abbrlink is written into its frontmatter on its first build, so a read-only mount fails with an explanation of exactly that. Mount a directory you own or can write to.

`docker-compose.yml` does the same thing declaratively:

```bash
docker compose up
```

**Use your own config.** The image carries the neutral `site.config.ts`. Your personal values go in `site.config.local.ts`, which the build already prefers when present — put it at the root of the mounted notes directory, or mount it directly:

```bash
docker run --rm -p 8080:8080 \
  -v "$PWD/notes:/app/notes:rw" \
  -v "$PWD/site.config.local.ts:/app/site.config.local.ts:ro" \
  ghcr.io/gogongxt/noteflow:latest
```

Your `siteName`, copyright line and [footer options](https://gogongxt.github.io/noteflow/posts/5ec70f90#footer) go in the same file: the neutral config ships no `repoUrl`, so the header never points at this project's repository on your site, and the footer's only backlink is the linked © line (`footer.credit: false` removes the mark.)

Setting `contentDir` there to anything but `notes` points the build elsewhere. A `CONFIG=site.config.docs.ts` profile replaces the whole stack instead — `site.config.local.ts` is not read then — so a profile's `siteName`, `url` and `contentDir` are yours to edit: mount the file, and point the notes mount at its `contentDir`.

One limit: a profile whose `url` carries a **base path** (a GitHub Pages project site) builds for a sub-path, and the audit requires every internal link to carry that prefix — this container serves at `/`, so use a root URL (a domain, or plain `http://localhost:8080`) for it. Pages is the right host for sub-path builds, without a container.

**Use the latest code, or your own fork.** Mount the source tree over `/app`; the entrypoint runs `npm ci` when `node_modules` is missing or older than `package.json`:

```bash
docker run --rm -p 8080:8080 \
  -v "$PWD:/app:ro" \
  -v "$PWD/notes:/app/notes:rw" \
  ghcr.io/gogongxt/noteflow:latest
```

The image is published from a version tag by `.github/workflows/docker.yml` — `linux/amd64` and `linux/arm64`, so Apple Silicon pulls a native build rather than emulating. It goes to GHCR, and to Docker Hub too once the `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` repository secrets exist. To build it yourself, `docker build -t noteflow .` from the repository root.

For TLS, a domain, or several sites behind one proxy, run the container on a private port and put it behind the nginx setup below.

# Self-hosting with nginx (production)

`src/cli/gen-nginx.ts` regenerates the security-header snippet (CSP hashes change per build) from the build manifest:

```bash
./start.sh build
node src/cli/gen-nginx.ts --out deploy/nginx/csp.conf
```

`deploy/nginx/` holds the reference server config: content-addressed `/static/` and `/assets/` paths cache forever, HTML revalidates, and directory-style URLs (`/posts/<abbrlink>`) resolve without redirects.

# GitHub Pages

The site can serve under a repository sub-path (`https://<user>.github.io/<repo>/`). Set `url` to that address — the `/repo` pathname becomes the base path every emitted link and asset carries — and enable `cspMeta`, because Pages cannot send response headers:

```ts
url: 'https://user.github.io/noteflow',
cspMeta: true,
```

`.github/workflows/pages.yml` in this repository builds exactly this documentation site that way: pandoc 3.13 + Node + Chromium for mermaid prerendering, then the standard Pages deploy actions.

# Custom domain

A custom domain (or a `*.github.io` user site) serves at the root: point `url` at it with no pathname and the base path disappears — nothing else changes.

# What the security model costs you

The output is built to run under a strict Content Security Policy, and a few
authoring habits follow from that. Worth knowing before you write notes:

- **No third-party scripts or styles.** No CDN, no externally hosted fonts, no
  embed snippets that pull in JS. Images may come from anywhere (passive
  content); anything executable must be self-hosted and hashed at build time.
- **Mermaid diagrams are rendered at build time**, not in the browser — the
  runtime's injected styles would be blocked. This is why the build wants
  headless Chromium when the content has diagrams.
- **Audio and video are native HTML elements** with attached files; an off-site
  `src` fails the build. Third-party video is an iframe from a fixed allowlist
  (Bilibili, YouTube).
- **Fail-closed**: a broken link, a private-content leak, or any audit hit
  aborts the build. The site you deploy is exactly the site that passed every
  check — there is no partial publish.
