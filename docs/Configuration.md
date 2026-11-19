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
| `repoUrl` | A repository URL shown as a GitHub icon in the header, opening in a new tab. Unset hides it — that is the default, so a site you deploy does not inherit this project's link. |
| `cspMeta` | Also carry the CSP in a `<meta>` tag — for hosts that cannot send response headers (GitHub Pages). |
| `footer` | The site footer. Every field is optional and renders only when set; see below. |

# Footer

Every page ends in one quiet line: the theme mark, the copyright line, an optional author credit, and the filing number on the right. Without configuration the © line reads `© <year> <siteName>` and links this project as a whole — mark and text are one target. The `footer` block changes any of those pieces:

```ts
footer: {
  copyright: '© {year} {site}',   // {year} → the build year, {site} → siteName
  since: 2024,                    // renders "2024–2026" once the year has moved on
  copyrightUrl: '/about',         // link the © line: a site path or an absolute URL
  author: 'you',                  // renders "By you" after the © line
  authorUrl: 'https://github.com/you',
  icp: '京ICP备00000000号',        // 备案号, linked to beian.miit.gov.cn
  icpUrl: 'https://beian.miit.gov.cn/',  // optional: point the 备案 link elsewhere
  credit: false,                  // drop the mark and the project link
},
```

- `copyright` supports `{year}` and `{site}`; without `since` the year is the build year.
- `copyrightUrl` and `authorUrl` accept `/site/paths` and `http(s)://`, `mailto:` and `tel:` URLs. Off-site links open in a new tab, matching the link policy used throughout the site.
- `author` renders `By <name>`, optionally linked; unset renders nothing.
- `icp` prints the filing number and links it to the MIIT query page. Set `icpUrl` if your filing is queried at another address.
- Without `copyrightUrl` the whole © line (mark included) links this project; setting it retargets that one link.
- `credit: false` drops the mark; the © text then renders as plain, unlinked text.

Footer links are audited like every other link: a site path must exist in the output, and an off-site link without a new-tab target fails the build.

# Named profiles

`--config <file>` builds from a standalone profile that replaces the personal stack (no local overrides). This documentation site is one:

```bash
./start.sh build --config site.config.docs.ts
./start.sh serve --config site.config.docs.ts
```
