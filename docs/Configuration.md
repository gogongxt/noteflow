---
title: Configuration
public: true
description: site.config.ts — every path and site setting resolves through here
abbrlink: "5ec70f90"
---

All configuration lives in `site.config.ts`; CLI flags (`--content`, `--out`) and the `PANDOC_BIN` env var take precedence over it. A gitignored `site.config.local.ts` (or `.mjs`) merges personal overrides on top.

| Key | Meaning |
| --- | --- |
| `url` | Absolute site URL. Its **pathname is the base path**: `https://user.github.io/noteflow` makes every emitted link carry `/noteflow` (GitHub Pages project site); an empty path builds for a root deployment. |
| `siteName` / `lang` / `description` | Site identity and HTML language. |
| `contentDir` / `outDir` | Markdown tree and build output, repo-relative. |
| `themeDir` / `cacheDir` / `manifestFile` | Theme directory, caches (mermaid prerender, link-card metadata), and the build manifest. |
| `postPattern` | URL shape of a note, `/posts/{abbrlink}` by default. |
| `pageSize` | Entries per page for the home list and the feed. |
| `giscus` | Comments via GitHub Discussions; remove the block to disable. |
| `cspMeta` | Also carry the CSP in a `<meta>` tag — for hosts that cannot send response headers (GitHub Pages). |

## Named profiles

`--config <file>` builds from a standalone profile that replaces the personal stack (no local overrides). This documentation site is one:

```bash
./start.sh build --config site.config.docs.ts
./start.sh serve --config site.config.docs.ts
```
