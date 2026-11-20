# NoteFlow

Personal knowledge-base static site generator: `pandoc server` converts the Markdown tree to HTML; the Node side rewrites links, sanitizes, and renders templates into `dist/`. Settings resolve through `site.config.mjs` (→ `src/core/config.ts`). Test fixtures: `tests/fixtures/content/`; real content: separate private repo at `notes/` (gitignored).

**Early stage; breaking changes are fine.** Refactor freely — prefer robust and simple over keeping legacy structure. Work on `master` unless a change needs isolation. Where the code answers a question faster than docs would, don't write it down here.

```bash
./start.sh build    # build to dist/
./start.sh serve    # preview at http://localhost:7060
./start.sh watch    # rebuild + preview while editing
./start.sh check    # CI gate: writes dist/; never the content tree or cache, no network
npm test            # all tests (includes a real build)
npx tsc --noEmit    # type check
```

`docs/` is built and shipped by noteflow itself: `npm run build:docs` (`--config site.config.docs.mjs`, output `dist-docs/`, GitHub Pages via `.github/workflows/pages.yml`). A named profile replaces the personal config stack entirely. The docs `url` pathname (`…/noteflow`) is the base path of every emitted URL; `serve.ts` strips it when serving.

## Security baseline (non-negotiable)

CSP is enforced end to end: nginx, `src/cli/serve.ts`, and (with `cspMeta: true`, for header-less hosts like GitHub Pages) a `<meta>` tag all carry the same directive set. **No relaxation except the recorded ones:** `img-src … https:` (2026-11-16, notes embed external image hosts) and `frame-src` for the two `EMBED_ORIGINS` video providers (2026-11-17) plus `https://giscus.app` when a `giscus` block is configured. Preview and the meta tag omit `upgrade-insecure-requests` (it would break plain-http preview).

- `style-src 'self'`: templates never emit `<style>`/`style=""`; frontend styling only via CSSOM (`element.style.x`, `setProperty`, `animate()`). Inline styles in note bodies are user content, allowed via build-time hashes.
- `script-src 'self'` + hashes: exactly two inline scripts, `theme-init.ts` (head) and `ui-boot.ts` (after sidebar), order matters. A new one must be added to `inlineScripts` in `src/build/pipeline.ts` plus test updates.
- Media is native HTML only (`<video>`/`<audio>`/`<source>`/`<track>`); an off-site `src` fails the build. Publishable types live in `ATTACHMENT_TYPES` (`src/render/attachments.ts`); nginx, the preview server, and a test all follow that table.
- Video embeds: `[watch URL](…){.embed}` alone on a line → iframe from `EMBED_ORIGINS` only (`src/render/embeds.ts`); `frameOriginsOf` (`src/core/config.ts`) is the one allowlist — the two video hosts, plus giscus, and the output audit rejects any other iframe. No `sandbox` (Bilibili needs same-origin storage), never `autoplay`.
- Widget channel: a note loads code shipped next to itself — src-only `<script src="rel.js" defer>` and `<link rel="stylesheet" href="rel.css">`, `w-` class namespace. Only those two forms survive sanitize (any other raw HTML degrades to a span); refs are rewritten to hashed `/assets/` URLs, so the CSP is unchanged. A missing file aborts the build. `spa.ts` replays widget scripts on soft navigation — widgets must be idempotent initializers.
- Component layer: `w-` classes as pure Markdown (`components.css`) — no script, nothing new in sanitize. Traps: filled buttons use `--accent-solid*`; section-divs force `h1` margin-top 0, so fenced-div containers carry their own `1.2em` margin; `.w-reveal` is an animation (not transition) so a lingering `translate` can't outrank `.w-card:hover`.
- No CDNs, no external fonts; libraries self-hosted under `themes/default/`. All rendered text goes through `esc()` (`src/core/util.ts`); private content reaches templates only via `ctx.pages` / `ctx.sidebar`.
- Build is fail-closed: broken links, private-content leaks, and audit hits abort. Never "fix" a failure by bypassing the whitelist.

## Regression traps

- **mermaid must be pre-rendered at build time** — client-side rendering is a black box under strict CSP. See `src/render/mermaid.ts`.
- **Sync daemon** (`serve.ts --sync`, `src/sync/`): mirrors the notes repo with unconditional `reset --hard`; after each build commits exactly the `abbrlinkWrites` manifest entries and pushes them back. Arms only with `--sync` — the config block travels with the notes repo and must never start the daemon on its own. `! [rejected]`/non-fast-forward is a race (drop and retry); a hook-declined push (`remote rejected`) is a hard failure — undo the local commit.
- **New Markdown syntax** = `FROM` in `pandoc.ts` + `sanitize.ts` whitelist + cases in `docs/Syntax/` (`Standard Markdown.md` for standard, `Features.md` for builder constructs). Those two docs are both public reference and test fixture; their demos carry the abbrlinks tests read (`c182255e`, `9d19226c`). The whitelist **silently drops** uncovered markup — symptom: content mysteriously disappearing. `allowedStyles` keys are **CSS selectors**.
- **Overlays must not move the page:** keep `scrollbar-gutter: stable` on `html`; full-screen layers supply their own containing block (`width: 100vw`), never touch the gutter.
- **No sidebar flash between pages:** server renders `open` only for the current page's ancestor chain; `ui-boot.ts` overrides from `localStorage` pre-paint; entry animations only on `.tree-anim`. `serve.ts` re-reads the CSP hash manifest on mtime change.
- Lazy images have no layout box off-screen — detect icons with the build-time `data-inline` flag, not rendered width.

## Delivery

After changes: `npx tsc --noEmit && npm test && ./start.sh build`. Visual changes: verify in `./start.sh serve`. Do not commit / push unless asked.