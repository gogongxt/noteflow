---
title: Deployment
public: true
description: Self-hosting with nginx, GitHub Pages, and custom domains
abbrlink: "211fd193"
---

`dist/` is a fully static tree — no application server, no runtime. Any static host works.

## Self-hosting with nginx (production)

`src/cli/gen-nginx.ts` regenerates the security-header snippet (CSP hashes change per build) from the build manifest:

```bash
./start.sh build
node src/cli/gen-nginx.ts --out deploy/nginx/csp.conf
```

`deploy/nginx/` holds the reference server config: content-addressed `/static/` and `/assets/` paths cache forever, HTML revalidates, and directory-style URLs (`/posts/<abbrlink>`) resolve without redirects.

## GitHub Pages

The site can serve under a repository sub-path (`https://<user>.github.io/<repo>/`). Set `url` to that address — the `/repo` pathname becomes the base path every emitted link and asset carries — and enable `cspMeta`, because Pages cannot send response headers:

```ts
url: 'https://user.github.io/noteflow',
cspMeta: true,
```

`.github/workflows/pages.yml` in this repository builds exactly this documentation site that way: pandoc 3.13 + Node + Chromium for mermaid prerendering, then the standard Pages deploy actions.

## Custom domain

A custom domain (or a `*.github.io` user site) serves at the root: point `url` at it with no pathname and the base path disappears — nothing else changes.

## What the security model costs you

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
