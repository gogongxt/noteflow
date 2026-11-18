# NoteFlow

Personal knowledge-base static site generator: `pandoc 3.13 server` converts the Markdown in the content directory to HTML, and the Node side does link rewriting, security sanitizing, and template rendering, emitting a static site to `dist/`. All paths and site settings resolve through `site.config.ts` (→ `src/core/config.ts`); the purpose-built test fixture tree is `tests/fixtures/content/`, real content lives in a separate private repository at `notes/` (gitignored).

**The project is in an early stage; breaking changes are allowed.** Structure, conventions, and design are all fair game to change; where reading the code is faster than reading docs, don't write it down here.

Work directly on `master` unless a change needs isolation.

```bash
./start.sh build           # build to dist/
./start.sh serve           # preview at http://localhost:7060
npm test                   # all tests (includes a real build)
npx tsc --noEmit           # type check
```

The project's own docs (`docs/`) are built by noteflow itself and deployed to GitHub Pages (`site.config.docs.ts` + `.github/workflows/pages.yml`): `./start.sh build --config site.config.docs.ts`. A named `--config` profile replaces the personal config stack entirely (no `site.config.local` overrides). The docs site's base path comes from its `url` pathname (`https://…/noteflow`) — every emitted URL carries that prefix while `dist/` (and `dist-docs/`) keep the unprefixed layout; `serve.ts` strips it when serving.

## Security baseline (non-negotiable)

CSP is enforced end to end: production nginx and `src/cli/serve.ts` send the same set of headers, and **no relaxation of any kind is allowed** except the explicitly recorded ones (`img-src … https:` 2026-11-16; `frame-src` video embeds 2026-11-17). The one deliberate difference: the preview server omits `upgrade-insecure-requests` — it serves plain http, and under that directive WebKit rewrites every same-origin http subresource to https (Chromium does it on redirect hops), so nothing would load locally. Production is https and keeps the directive.

A third delivery channel exists for hosts that cannot send headers (GitHub Pages): with `cspMeta: true` the build also bakes the policy into a `<meta http-equiv="Content-Security-Policy">` (2026-11-17). Same directive set as the headers, minus `upgrade-insecure-requests` (same WebKit reason — the same dist/ must stay previewable over plain http). nginx/serve keep sending headers regardless; `frame-ancestors` is ignored inside a meta tag, which costs nothing there.

- `style-src 'self'`: templates must never produce `<style>` or `style=""`. Frontend styling changes may only go through the CSSOM (`element.style.x` / `setProperty` / `animate()`). Inline styles inside note bodies are user content and are allowed via build-time sha256 hashes (`--unsafe-hashes`).
- `img-src 'self' data: https:` (deliberate, owner decision 2026-11-16): notes embed external image hosts (image CDNs, paste services, …), and images are passive content — script/style/connect stay locked down. Per-host whitelisting was rejected as every new image host would need a CSP edit.
- `script-src 'self'` + build-time hashes: there are exactly two inline scripts, `theme-init.ts` (in `<head>`) and `ui-boot.ts` (after the sidebar), and their order carries meaning. Any new inline script must be added to `inlineScripts` in `src/build/pipeline.ts` together with matching test updates.
- Media is native HTML only (`<video>`/`<audio>`/`<source>`/`<track>`): `default-src 'self'` covers `media-src`, so an off-site `src` fails the build. A JS player would need an injected stylesheet, which CSP blocks. Publishable types live in `ATTACHMENT_TYPES` (`src/render/attachments.ts`) — nginx's `/assets/` block, the preview server, and a test all follow that table.
- Third-party video is an iframe from exactly the two `EMBED_ORIGINS` (`src/core/config.ts`): `[watch URL](…){.embed}` alone on a line becomes a provider player (`src/render/embeds.ts`). `frame-src` lists only those origins plus giscus; the output audit rejects any other iframe. The frames carry no `sandbox` — Bilibili's player needs same-origin storage and renders blank without it, and `allow-same-origin` + `allow-scripts` would make a sandbox meaningless anyway; containment is the frame-src allowlist plus Permissions-Policy. The frame is never granted `autoplay`, and Bilibili's URL carries an explicit `autoplay=0` (its player auto-starts when the parameter is absent); playback always waits for a click.
- No CDNs and no externally hosted fonts; libraries are self-hosted under `themes/default/`.
- All rendered text goes through `esc()`; private content reaches templates only via `ctx.pages` / `ctx.sidebar`.
- The build is fail-closed: broken links, private-content leaks, and audit hits all abort the build. Never "fix" a failure by bypassing the whitelist.

## Known regression traps

- **mermaid must be pre-rendered at build time.** Under strict CSP, client-side rendering turns diagrams into black boxes (the `<style>` and `style=""` injected by the mermaid runtime are all blocked). See `src/render/mermaid.ts` for details.
- New Markdown syntax = update the `FROM` in `pandoc.ts` + update the `sanitize.ts` whitelist + add cases to the syntax reference under `docs/Syntax/` — standard Markdown in `Standard Markdown.md`, builder-specific constructs in `Features.md`; both are public reference *and* test fixture (the suite builds the docs profile and asserts on their output), and their demos carry the abbrlinks the tests read (`c182255e`, `9d19226c`). The whitelist **silently drops** anything not covered; the symptom of a missed update is "content mysteriously disappearing". The keys of `allowedStyles` are **CSS selectors** — writing attribute names there means no filtering happens at all.
- **Opening an overlay must not change the page layout.** `scrollbar-gutter: stable` on `html` must be kept; full-screen layers must supply their own containing block with `width: 100vw` — do not touch the gutter (that would shift the body content sideways).
- **Navigating between pages must not make the sidebar flash.** The server renders `open` only for the current page's ancestor chain; `ui-boot.ts` overrides it from `localStorage` before the first frame; entry animations are attached only to `.tree-anim`, never written as `details[open] > ul`. `src/cli/serve.ts` re-reads the CSP hash manifest whenever its mtime changes (the manifest is written atomically), so a long-running process never blocks the inline scripts of a newly built site.
- Lazily loaded images have no layout box while off-screen, so "rendered width" cannot be used to detect icons — use the build-time `data-inline` flag instead.

## Delivery

After making changes, run `npx tsc --noEmit && npm test && ./start.sh build`. For visual changes, verify in the local preview (`./start.sh serve`). Do not commit / push unless asked.
