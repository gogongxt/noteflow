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

CSP is enforced end to end: nginx, `src/cli/serve.ts`, and (with `cspMeta: true`, for header-less hosts like GitHub Pages) a `<meta>` tag all carry the same directive set. **No relaxation except these three:** `img-src … https:` (notes embed external image hosts) and `frame-src` for the two `EMBED_ORIGINS` video providers plus `https://giscus.app` when a `giscus` block is configured. Preview and the meta tag omit `upgrade-insecure-requests` (it would break plain-http preview).

- `style-src 'self' 'unsafe-hashes'` + hashes: templates never emit `<style>`/`style=""` (frontend styling only via CSSOM: `element.style.x`, `setProperty`, `animate()`); a note's own inline `<style>`/`style=""` is user content, allowed via build-time hashes. `cspHash` hashes the **raw bytes** (CSP does not percent-decode style attribute content, so percent-encoding the value would never match). Style values pass sanitize verbatim (`parseStyleAttributes: false`); postprocess refuses a value that decodes to `url()`/`image-set()`/`expression()`/`@import` (`src/render/css-safety.ts` — CSS escapes are decoded first, `\75 rl(` is `url(`).
- `script-src 'self' 'unsafe-hashes'` + hashes: two fixed theme scripts, `theme-init.ts` (head) and `ui-boot.ts` (after sidebar), order matters — a new one is added to the theme chain in `src/build/pipeline.ts` plus tests. Beyond those, **channel 2** hashes every inline `<script>` body and every `on…` handler the notes emit: postprocess collects them (`PostprocessResult.csp`, from the parse5 tree — the bytes the browser runs), `finishBuild` re-hashes what the audit finds in the written output and aborts on any value the published hash lists do not cover. `'unsafe-hashes'` is what lets a hash cover an event-handler attribute. **Never add `'unsafe-eval'`** — `eval`/`new Function`/string `setTimeout` stay blocked by design; if a library needs them, it is the wrong tool for this site.
- Channel 2 markup: a note writes ordinary HTML — `<button>`, `<input>`, `<select>`, `<canvas>`, `<svg>`+shapes, any class, `data-*`/`aria-*`, `on*`. Style values are the one tightened corner: postprocess refuses a value that decodes to `url()`/`image-set()`/`expression()`/`@import` (`src/render/css-safety.ts` decodes CSS escapes first), so CSS cannot fetch/execute. `type="module"` inline bodies are dropped; use a classic IIFE or a `src` file. Do not broaden the allowlist without a hashed-byte guard: CSP is the boundary, sanitize is only the markup shape.
- Media is native HTML only (`<video>`/`<audio>`/`<source>`/`<track>`); an off-site `src` fails the build. Publishable types live in `ATTACHMENT_TYPES` (`src/render/attachments.ts`); nginx, the preview server, and a test all follow that table.
- Video embeds: `[watch URL](…){.embed}` alone on a line → iframe from `EMBED_ORIGINS` only (`src/render/embeds.ts`); `frameOriginsOf` (`src/core/config.ts`) is the one allowlist — the two video hosts, plus giscus, and the output audit rejects any other iframe. No `sandbox` (Bilibili needs same-origin storage), never `autoplay`.
- Widget file channel: a note loads code shipped next to itself — src-only `<script src="rel.js" defer>` and `<link rel="stylesheet" href="rel.css">`. The ref is rewritten to a hashed `/assets/` URL, so the CSP is unchanged. External URLs, escapes, dotfiles and wrong extensions degrade to a span; a missing file aborts the build. `spa.ts` replays widget scripts and inline `<script>`/`<style>` (and cleans the previous page's) on soft navigation — widgets must be idempotent initializers.
- Component layer: `w-` classes as pure Markdown (`components.css`) — no script, nothing new in sanitize. Traps: filled buttons use `--accent-solid*`; section-divs force `h1` margin-top 0, so fenced-div containers carry their own `1.2em` margin.
- No CDNs, no external fonts; libraries self-hosted under `themes/default/`. All rendered text goes through `esc()` (`src/core/util.ts`); private content reaches templates only via `ctx.pages` / `ctx.sidebar`.
- Build is fail-closed: broken links, private-content leaks, and audit hits abort. Never "fix" a failure by bypassing the whitelist.

## Regression traps

- **mermaid must be pre-rendered at build time** — client-side rendering is a black box under strict CSP. See `src/render/mermaid.ts`.
- **Sync daemon** (`serve.ts --sync`, `src/sync/`): mirrors the notes repo with unconditional `reset --hard`; after each build commits exactly the `abbrlinkWrites` manifest entries and pushes them back. Arms only with `--sync` — the config block travels with the notes repo and must never start the daemon on its own. `! [rejected]`/non-fast-forward is a race (drop and retry); a hook-declined push (`remote rejected`) is a hard failure — undo the local commit.
- **New Markdown syntax** = `FROM` in `pandoc.ts` + `sanitize.ts` whitelist + cases in `docs/Syntax/` (`Standard Markdown.md` for standard, `Features.md` for builder constructs). Those two docs are both public reference and test fixture; their demos carry the abbrlinks tests read (`c182255e`, `9d19226c`). The whitelist **silently drops** uncovered markup — symptom: content mysteriously disappearing. Style values are not property-whitelisted: postprocess refuses a fetching/executing value (`css-safety.ts`); everything else ships as written.
- **Raw-HTML blocks: 4-space indentation = code.** Pandoc turns a line indented ≥4 spaces inside an HTML block into an indented `<pre><code>` block, so channel-2 `<button>`/`<input>`/`<div>` markup that is visually aligned under a parent ships as escaped text (dead, and its `on*` handlers never get hashed). Indent inside `<style>`/`<script>` freely (raw text); keep every block-level tag at column 0.
- **Overlays must not move the page:** keep `scrollbar-gutter: stable` on `html`; full-screen layers supply their own containing block (`width: 100vw`), never touch the gutter.
- **No sidebar flash between pages:** server renders `open` only for the current page's ancestor chain; `ui-boot.ts` overrides from `localStorage` pre-paint; entry animations only on `.tree-anim`. `serve.ts` re-reads the CSP hash manifest on mtime change.
- Lazy images have no layout box off-screen — detect icons with the build-time `data-inline` flag, not rendered width.

## Delivery

After changes: `npx tsc --noEmit && npm test && ./start.sh build`. Visual changes: verify in `./start.sh serve`. Do not commit / push unless asked.