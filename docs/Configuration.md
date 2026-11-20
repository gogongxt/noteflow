---
title: Configuration
public: true
description: site.config.mjs — every path and site setting resolves through here
abbrlink: "5ec70f90"
---

All configuration lives in `site.config.mjs`; CLI flags (`--content`, `--out`) and the `PANDOC_BIN` env var take precedence over it. Personal overrides go in a gitignored `site.config.local.mjs`, which merges on top.

# Where the personal override lives

One file name, two allowed locations — the project root wins if both exist:

- `./site.config.local.mjs` — the checkout's own personal values.
- `<contentDir>/site.config.local.mjs` — so the settings travel with the notes
  repo; drop the same file there and it keeps working unchanged.

The template and the override are the same kind of file — plain JavaScript with
a default-exported object and no imports — so `cp site.config.mjs
site.config.local.mjs` is a working starting point: delete what you do not need,
keep what you change. `.mjs` keeps it loading from a bare notes repo that has
no `package.json` declaring a module type. A named `--config` profile (e.g.
`site.config.docs.mjs`) replaces this whole stack; no local override is read then.

An unknown key — a typo like `siteNmae` — fails the build and names the file,
rather than silently leaving the setting at its default. The `@type` JSDoc
comment at the top of the template gives editors autocomplete; `npx tsc
--noEmit` checks both shipped profiles through it.

| Key | Meaning |
| --- | --- |
| `url` | Absolute site URL. Its **pathname is the base path**: `https://user.github.io/noteflow` makes every emitted link carry `/noteflow` (GitHub Pages project site); an empty path builds for a root deployment. |
| `siteName` / `lang` / `description` | Site identity and HTML language. |
| `contentDir` / `outDir` | Markdown tree and build output, repo-relative. `outDir` may not be, contain, or sit inside the content tree, `src/`, or the theme: a build deletes whatever it did not just emit, so that would erase its own input. |
| `themeDir` / `cacheDir` / `manifestFile` | Theme directory, caches (mermaid prerender, link-card metadata, per-page render results), and the build manifest. Path fields resolve against the project root; an absolute path is taken as-is, `~` is rejected (node never expands it). |
| `postPattern` | URL shape of a note, `/posts/{abbrlink}` by default. |
| `mermaid` | Diagram theme: `theme` (see below) and CSS-colour `themeVariables` overrides. |
| `pageSize` | Entries per page for the home list and the feed. |
| `giscus` | Comments via GitHub Discussions; remove the block to disable. |
| `repoUrl` | A repository URL shown as a GitHub icon in the header, opening in a new tab. Unset hides it — that is the default, so a site you deploy does not inherit this project's link. |
| `edit` | Links every page to its source file in a Git forge: hovering the page title reveals a pencil that opens the file's edit page. Unset hides it. See below. |
| `sync` | Turn the serving host into a mirror of the notes repository: clone, poll, rebuild on change. Unset: no syncing. See below. |
| `cspMeta` | Also carry the CSP in a `<meta>` tag — for hosts that cannot send response headers (GitHub Pages). |
| `footer` | The site footer. Every field is optional and renders only when set; see below. |

# Diagram theme

Mermaid diagrams pick one of the packages' built-in themes. The build renders both modes, so a light theme is paired with its dark twin automatically — pick one name and both follow:

```ts
mermaid: {
  theme: 'redux-color',                       // default | redux-color | redux | neo
  themeVariables: { primaryColor: '#ECECFE' }, // optional CSS-colour overrides, both modes
},
```

| `theme` | Look |
| --- | --- |
| `default` | mermaid's stock purple/slate theme (the build's default). |
| `redux-color` | mermaid.ai's own palette: each cluster, entity and participant gets a colour from a categorical set. |
| `redux` | The same palette, without the per-element colouring. |
| `neo` | The neo shape language with gradient borders. |

`redux-color` and `redux` also switch the diagram's shape language to `look: 'neo'` (rounded, thicker borders, soft shadows), which is how they are drawn on mermaid.ai. Per-diagram `classDef`/`style` in a note still override the theme's colours. `themeVariables.fontFamily` is not accepted — label metrics are measured with the theme's font, so the two must agree; override the theme's font instead.

# Build cache

`cacheDir` holds three caches, all of them derived data you can delete at any time:

- `mermaid/` — rendered diagram SVGs, keyed by diagram source.
- `link-previews/` — fetched Open Graph metadata for link cards.
- `render/` — each page's pandoc output and body HTML. A page is reused only
  when its source, its URL, the attachments it references, the builder's own
  source and the versions of `sanitize-html`/`parse5` are all unchanged, so a
  warm rebuild skips pandoc for every page you did not touch and a library
  upgrade still re-converts. `--check` never writes this cache.

To ignore it — for example to prove a suspicious page really is stale-proof —
add `--no-render-cache`: every page converts, and existing entries are left
alone (refreshed by a normal build). `./start.sh check --no-render-cache` is
then a cold verification: nothing read, nothing written.

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

# Edit links

The intended setup keeps the content tree in its own Git repository. An `edit` block connects the two: every page title gains a pencil on hover, and it opens that exact file in your forge's editor.

```ts
edit: {
  repoUrl: 'https://git.example.com/you/notes', // the repository's web URL
  branch: 'main',        // the branch the site builds from, 'main' by default
  provider: 'gitea',     // edit-route shape: 'gitea' (default), 'github' or 'gitlab'
  root: 'docs',          // where the content directory sits in the repo; omit when it is the repo root
},
```

The built URL is `{repoUrl}/_edit/{branch}/{path}` for Gitea — `/edit/…` on GitHub, `/-/edit/…` on GitLab. Files are addressed as they sit in the content tree (`Notes/foo.md`; a directory page links its `_index.md`, and a generated listing without one gets no pencil).

# Git mirroring (`sync`)

Edit your notes wherever you edit them, `git push`, and the site follows. A `sync` block configures the mirror daemon; on a serving host `./start.sh serve --sync` (the docker entrypoint passes the flag) arms it: it clones the repository on first start, polls `git ls-remote` every `intervalSec`, and when the branch tip has moved it fetches, hard-resets the content dir onto it and rebuilds. The flag is deliberate — the config block travels with the notes repository, and it alone must not turn every machine's preview into a resetting mirror.

```ts
sync: {
  remote: 'https://gdt_<token>@git.example.com/you/notes.git',  // or ssh://…
  branch: 'master',     // the branch the site follows, 'master' by default
  intervalSec: 15,      // poll interval in seconds; failures back off up to 5×
  proxy: 'http://127.0.0.1:7890',  // optional: http proxy for http(s) remotes
},
```

`proxy` exists for hosts whose git remote sits behind a network restriction — a notes repository on GitHub, say. `''` explicitly disables proxies inherited from the environment (`http_proxy`/`https_proxy` reach git out of the box otherwise). It applies to http(s) remotes only; for ssh use `GIT_SSH_COMMAND` with your own ssh config.

An https remote carries the token in the URL (`https://<token>@host/you/notes.git`) — no ssh key, no host-key setup. The tool keeps the token out of harm's way: error messages have the credential redacted, and the mirror's clone is left without an `origin` so nothing sits in `.git/config`. Committing the token into a **private** notes repository is a deliberate trade: everyone who can read the repo can push to it (a Gitea token acts as your user, across all your repos on that host — scope it minimally when creating it). Prefer an ssh deploy key when you want a per-repository credential instead.

While `sync` is set, the content dir is a mirror, and the reset onto the remote tip is **unconditional** — a mirror never keeps local state. Two invariants follow:

- **Never merges, never preserves local edits.** `git pull` on a server invites divergence; a mirror has nothing to merge. Anything that differs from the remote — including the abbrlinks the build writes into new notes' frontmatter — is reset away on the next push without consequence: the slug is deterministic and the next build writes the same value again. Hand edits on a serving mirror are discarded just the same, so edit notes where you edit them. Untracked files are left alone (the mirror never runs `git clean`), unless the incoming commit adds a file at the same path.
- **A failed poll or build never takes the site down.** A failed poll backs off and retries; a failed build keeps serving the last good `dist/`. Only a first start with nothing to serve exits non-zero — fail-closed applies to publishing content, not to staying up.

A missing `abbrlink` is written into the note's frontmatter by the first build that meets it. The daemon then commits exactly those files (listed in the build manifest — never anything else) and pushes the commit back, so notes created anywhere — the gitea web UI, a plain notes checkout with no noteflow installed — get pinned without any manual step. A push that loses a race to a newer commit drops the pin commit and retries after the next rebuild. The key therefore needs **push** access to the notes repository.

`./start.sh sync` runs one clone/fetch/reset/build/pin cycle and exits — enough for a cron job when you would rather not keep a process running. The ssh key and volume setup for the container are covered under [Deployment](https://gogongxt.github.io/noteflow/posts/211fd193#docker).

The `sync` block itself must survive the reset it configures: keep it in the serving host's project-root `site.config.local.mjs` (or a named profile), or commit it to the notes repository — a block edited into the notes-tree local config but left uncommitted is discarded by the first reset. And arm the daemon (`--sync`) only on serving hosts: on a machine where you edit notes, it would keep resetting your work-in-progress away.

# Named profiles

`--config <file>` builds from a standalone profile that replaces the personal stack (no local overrides). This documentation site is one:

```bash
./start.sh build --config site.config.docs.mjs
./start.sh serve --config site.config.docs.mjs
```
