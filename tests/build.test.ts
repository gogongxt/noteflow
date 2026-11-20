import { test, suite, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { cleanupTmpDirs, tmpDir, PNG } from './helpers.ts';
import { computeAbbrlink } from '../src/content/abbrlink.ts';
import { stripTypes } from '../src/build/frontend.ts';
import { CSS_LAYERS, themeCss } from '../src/build/static-assets.ts';

// Top-level tests run serially, so every test that only reads dist/ shares one
// build and the variant tests run their builds concurrently in a suite.

const REPO = path.resolve(import.meta.dirname, '..');
// The purpose-built fixture tree: every subtree here exists because a test
// asserts on it (tree shape, media, privacy, comments, dates, tags).
const NOTES = path.join(REPO, 'tests/fixtures/content');
// Same pipeline as build.ts: strip types, escape `</script`, then hash the bytes.
const readInline = (name: string): string =>
  stripTypes(fs.readFileSync(path.join(REPO, 'themes/default', name), 'utf8'))
    .trim()
    .replace(/<\/script/gi, '<\\/script');
const themeInitSrc = readInline('theme-init.ts');
const uiBootSrc = readInline('ui-boot.ts');

/** A fresh copy of the fixture tree, for tests that mutate content in place. */
function makeContentCopy(): string {
  const dest = tmpDir('blog-e2e-');
  fs.cpSync(NOTES, dest, { recursive: true });
  return dest;
}

function brokenLinkTree(): string {
  const dest = tmpDir('blog-badlink-');
  fs.writeFileSync(
    path.join(dest, 'a.md'),
    '---\ntitle: 坏链接\npublic: true\n---\n\n[intro](./不存在.md)\n\n# 组件源码\n\n[第一处](./missing-one.md)\n\n# 部署步骤\n\n## 子小节\n\n[第二处](./missing-two.md)\n',
  );
  return dest;
}

function badPublicTree(): string {
  const dest = tmpDir('blog-badpublic-');
  fs.writeFileSync(path.join(dest, 'a.md'), '---\ntitle: 类型错误\npublic: "true"\n---\n');
  return dest;
}

let content: string;
let dist: string;
let docsDist: string;
let buildSeq = 0;
let shared: Promise<BuildResult>;
/** The docs profile build (base path + cspMeta); Syntax.md lives there. */
let sharedDocs: Promise<BuildResult>;
/** Concurrent builds must not write the same manifest. */
let manifestDir: string;

before(async () => {
  content = makeContentCopy();
  dist = tmpDir('blog-dist-');
  docsDist = tmpDir('blog-docsdist-');
  manifestDir = tmpDir('blog-manifest-');
  shared = runBuild([]);
  sharedDocs = runBuild(['--config', 'site.config.docs.mjs'], { content: 'docs', out: docsDist });
});

after(() => cleanupTmpDirs());

interface BuildResult {
  status: number;
  stdout: string;
  stderr: string;
  manifest: string;
}

/** Async so concurrent builds are not serialized by a blocked event loop. */
function runBuild(
  args: string[],
  opts: { content?: string; out?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<BuildResult & { manifest: string }> {
  const seq = buildSeq++;
  const manifest = path.join(manifestDir, `${seq}.json`);
  // --no-link-fetch + an isolated cache dir: tests never touch the network and
  // stay independent of the developer's real .cache/link-previews state.
  const linkCache = path.join(manifestDir, `${seq}-linkcache`);
  return new Promise((resolve, reject) => {
    const p = spawn(
      process.execPath,
      // The pinned config keeps CI and dev machines identical: an explicit
      // --config file never merges the developer's site.config.local overrides.
      ['src/cli/build.ts', '--config', 'site.config.mjs', '--content', opts.content ?? content, '--out', opts.out ?? dist, '--skip-mermaid', '--manifest', manifest, '--no-link-fetch', '--link-cache', linkCache, ...args],
      { cwd: REPO, env: { ...process.env, PANDOC_BIN: process.env.PANDOC_BIN || 'pandoc', ...opts.env } },
    );
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d: Buffer) => (stdout += d));
    p.stderr.on('data', (d: Buffer) => (stderr += d));
    p.on('error', reject);
    p.on('close', (code: number | null) => resolve({ status: code ?? 1, stdout, stderr, manifest }));
  });
}

/** A build against a fresh copy of the content, for tests that mutate notes. */
async function buildCopy(mutate: (copy: string) => void): Promise<{ out: string; result: BuildResult }> {
  const copy = makeContentCopy();
  mutate(copy);
  const out = tmpDir('blog-out-');
  const result = await runBuild(['--out', out, '--content', copy]);
  return { out, result };
}

/** Assets are content-addressed with the hash before the extension (`static/style.<hash>.css`); resolve by logical name. */
function findAsset(base: string, root: string = dist): string {
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${stem}(\\.[0-9a-f]{8})?${ext.replace(/\./g, '\\.')}$`);
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
    );
  const files = walk(path.join(root, 'static'));
  const hit = files.find((f) => re.test(path.basename(f)));
  if (!hit) throw new Error(`${base} not found in output; existing top-level files: ${fs.readdirSync(path.join(root, 'static')).join(', ')}`);
  return hit;
}

test('full build succeeds with no private content in output', async () => {
  const r = await shared;
  assert.equal(r.status, 0, `build failed:\n${r.stdout}\n${r.stderr}`);
  const files = listFiles(dist);
  const all = files.map((f) => path.relative(dist, f));
  for (const secret of ['Account secrets', 'Weekend journal', 'Private attachment', 'Draft: unsettled ideas']) {
    for (const f of files.filter((x) => x.endsWith('.html') || x.endsWith('.xml'))) {
      assert.ok(!fs.readFileSync(f, 'utf8').includes(secret), `${path.relative(dist, f)} leaks private title "${secret}"`);
    }
  }
  assert.ok(!all.some((f) => f.includes('secret.png')), 'private image was emitted');
  assert.ok(!all.some((f) => f.endsWith('.md') || f.endsWith('sort.txt')), 'source file found in output');
});

test('search index contains only public pages; private titles and paths never appear', async () => {
  await shared;
  const raw = fs.readFileSync(findAsset('search-index.json'), 'utf8');
  const index = JSON.parse(raw) as { v: number; docs: { u: string; t: string; p: string[]; x: string }[] };
  assert.equal(index.v, 1);
  assert.ok(index.docs.length > 0, 'index should not be empty');
  for (const secret of ['Account secrets', 'Weekend journal', 'Private attachment', 'Draft: unsettled ideas', 'Private notes']) {
    assert.ok(!raw.includes(secret), `index leaks private content "${secret}"`);
  }
  for (const d of index.docs) {
    assert.match(d.u, /^\/posts\/[0-9a-f]{8}(#[^/]*)?$/, `invalid URL: ${d.u}`);
    assert.ok(!d.u.includes('私人'), `index leaks a private path: ${d.u}`);
  }
  for (const d of index.docs) {
    const file = path.join(dist, d.u.split('#')[0].slice(1));
    assert.ok(fs.existsSync(file), `index points to a nonexistent page: ${d.u}`);
  }
});

test('search.js is self-hosted and browser-loadable (no TS types)', async () => {
  await shared;
  const js = fs.readFileSync(findAsset('search.js'), 'utf8');
  assert.ok(js.includes('initSearch'), 'should export initSearch');
  assert.ok(!/interface\s|type\s+\w+\s*=|\bexport type\b/.test(js), 'browser scripts must not contain type declarations');
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  assert.ok(html.includes('data-search-open'), 'header should have a search entry');
});

test('the media viewer is a separate, lazily loaded module (not inlined into app.js)', async () => {
  await shared;
  const js = fs.readFileSync(findAsset('media.js'), 'utf8');
  assert.ok(js.includes('initMediaViewer'), 'should export initMediaViewer');
  assert.ok(!/interface\s|^type\s+\w+\s*=|\bexport type\b/m.test(js), 'browser scripts must not contain type declarations');
  // app.js statically imports the intent-driven loader; the loader lazily
  // imports media.js, so the viewer's DOM code stays out of the first paint.
  const loader = fs.readFileSync(findAsset('media-comments.js'), 'utf8');
  assert.match(loader, /media(\.[0-9a-f]{8})?\.js/, 'the loader should import media.js on demand');
  const app = fs.readFileSync(findAsset('app.js'), 'utf8');
  assert.ok(!app.includes('mv-panel'), 'viewer DOM code should not be inlined into app.js');
  assert.ok(!fs.readFileSync(findAsset('style.css'), 'utf8').includes('.diagram-lightbox'), 'the old lightbox styles should be gone');
});

test('zooming the viewer re-lays the diagram out instead of stretching a cached layer', async () => {
  await shared;
  const js = fs.readFileSync(findAsset('media.js'), 'utf8');
  // A pure CSS scale rasterizes the composited card once and stretches it,
  // which blurs foreignObject label text; the viewer must commit the zoom into
  // the canvas's width/height so the text is rasterized at its final size.
  assert.ok(js.includes('layoutScale'), 'the viewer should track the laid-out scale separately from the gesture scale');
  assert.match(js, /style\.width = `\$\{baseW \* at\}px`/, 'commit should size the canvas in layout pixels');
  const css = fs.readFileSync(findAsset('style.css'), 'utf8');
  assert.ok(!/\.mv-card\s*\{[^}]*will-change/.test(css), 'will-change pins the card to a cached raster and defeats re-rasterization');
  assert.ok(!/\.mv-card\s*\{[^}]*transition:[^;]*width/.test(css), 'animating the card width would make the layout commit wobble');
});

test('the viewer rotates a quarter turn and shows no zoom percentage', async () => {
  await shared;
  const js = fs.readFileSync(findAsset('media.js'), 'utf8');
  assert.ok(js.includes('Rotate 90° (R)'), 'the toolbar should offer a quarter-turn rotation');
  assert.ok(!js.includes('mv-zoom') && !js.includes('"Fit"'), 'the zoom percentage/Fit readout is gone');
  assert.ok(/rotation % 180|rotation\(\)|rotate\(\)/.test(js), 'the viewer should track the rotation state');
  // The fit math must key on the rotated footprint, or a portrait photo
  // rotated to landscape would stay fitted to its old height.
  assert.ok(js.includes('boxW') && js.includes('boxH'), 'fit should use the displayed (rotated) footprint');
  const css = fs.readFileSync(findAsset('style.css'), 'utf8');
  assert.ok(!css.includes('.mv-zoom'), 'the .mv-zoom style should be gone');
  assert.match(css, /\.mv-canvas\s*\{[^}]*transform-origin:\s*center/, 'rotation pivots about the canvas center');
});

test('tabs: fenced-div groups render as semantic divs, the widget module ships, no div soup leaks', async () => {
  // The tabs demo lives on the noteflow-features child page of the docs build.
  await sharedDocs;
  const html = fs.readFileSync(path.join(docsDist, 'posts/9d19226c/index.html'), 'utf8');
  assert.ok(html.includes('<div class="tabs">'), 'live group should become a .tabs container');
  assert.ok(html.includes('<div class="tab" data-title="npm">'), 'each panel keeps its title attribute');
  assert.ok(html.includes('<div class="tab" data-title="pnpm">'), 'both panels of the demo group render');

  const app = fs.readFileSync(findAsset('app.js'), 'utf8');
  assert.match(app, /tabs(\.[0-9a-f]{8})?\.js/, 'app.js should import the widget statically (no flash of stacked panels)');
  const tabs = fs.readFileSync(findAsset('tabs.js'), 'utf8');
  assert.ok(tabs.includes('initTabs'), 'should export initTabs');
  assert.ok(!/interface\s|^type\s+\w+\s*=|\bexport type\b/m.test(tabs), 'browser scripts must not contain type declarations');
  assert.ok(!tabs.includes('innerHTML'), 'the widget builds DOM via createElement only');
  // spa.js now imports the widget (hash deep links) and the shared anchor helper;
  // unrewritten specifiers would 404 at runtime.
  const spa = fs.readFileSync(findAsset('spa.js'), 'utf8');
  assert.match(spa, /tabs(\.[0-9a-f]{8})?\.js/, 'spa.js should import revealAnchor by its hashed name');
  assert.match(spa, /anchor(\.[0-9a-f]{8})?\.js/, 'spa.js should import the scroll helper by its hashed name');
});

test('widgets: note scripts and stylesheets publish same-origin through the asset pipeline', async () => {
  // The orbit demo lives on the noteflow-features child page of the docs build.
  await sharedDocs;
  const html = fs.readFileSync(path.join(docsDist, 'posts/9d19226c/index.html'), 'utf8');
  // Same hashed-URL shape as every other attachment, base path included; the
  // audit's script-src existence check accepted it (the build resolved).
  assert.match(html, /<script src="\/noteflow\/assets\/9d19226c\/orbit\.[0-9a-f]{8}\.js" defer=""><\/script>/,
    'the demo script ships as a hashed same-origin URL');
  assert.match(html, /<link rel="stylesheet" href="\/noteflow\/assets\/9d19226c\/orbit\.[0-9a-f]{8}\.css">/,
    'the companion stylesheet ships the same way');
  // URLs carry the /noteflow base path; the dist tree keeps the unprefixed layout.
  const jsRel = html.match(/<script src="\/noteflow\/(assets\/9d19226c\/orbit\.[0-9a-f]{8}\.js)"/)![1];
  const body = fs.readFileSync(path.join(docsDist, jsRel), 'utf8');
  assert.ok(body.includes('w-orbit'), 'the published file is the widget source');
  assert.ok(!body.includes('innerHTML'), 'the widget builds DOM via createElement only');
  // Soft navigation swaps <main> via importNode, which never executes a
  // script; the replay is what keeps widgets alive across soft navigation.
  const spa = fs.readFileSync(findAsset('spa.js'), 'utf8');
  assert.match(spa, /main script\[src\]/, 'spa must replay swapped-in widget scripts');
  // The code fence quoting the same markup stays quoted, not live.
  assert.ok(!/<script src="\.\/widgets\/orbit\.js"/.test(html), 'the fenced example must not survive as a live tag');
});

test('widgets: inline and external scripts never reach the output; a broken ref fails the build', async () => {
  const fm = (body: string) => `---\ntitle: 小玩具\npublic: true\nabbrlink: "widget001"\n---\n\n${body}\n`;
  // A missing widget file aborts like any broken reference.
  const copy = tmpDir();
  fs.writeFileSync(path.join(copy, 'a.md'), fm('<div class="w-x"></div>\n<script src="./gone.js" defer></script>\n'));
  const bad = await runBuild([], { content: copy, out: tmpDir() });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr + bad.stdout, /a\.md .*widget|attachment not found: .*gone\.js/);

  // Without it, the build passes and only the sanctioned forms ship.
  const okCopy = tmpDir();
  fs.writeFileSync(
    path.join(okCopy, 'a.md'),
    fm('<script>alert(1)</script>\n\n<script src="https://evil.example.org/x.js"></script>\n\n<script src="./viz.js" defer>ignored body</script>\n'),
  );
  fs.writeFileSync(path.join(okCopy, 'viz.js'), '// ok\n');
  const outDir = tmpDir();
  const ok = await runBuild([], { content: okCopy, out: outDir });
  assert.equal(ok.status, 0, ok.stderr);
  const page = fs.readFileSync(path.join(outDir, 'posts/widget001/index.html'), 'utf8');
  assert.ok(!page.includes('evil.example.org'), 'an external script URL must not survive');
  assert.ok(page.includes('<span>alert(1)</span>'), 'inline code degrades to visible text');
  assert.match(page, /<script src="\/assets\/widget001\/viz\.[0-9a-f]{8}\.js" defer=""><\/script>/, 'the relative one ships');
  assert.ok(!page.includes('ignored body'), 'a src script body never ships');
});

test('code blocks: every block ships its chrome at build time (indented / language-less included)', async () => {
  // The demos live on the Standard Markdown child page of the docs build.
  await sharedDocs;
  const raw = fs.readFileSync(path.join(docsDist, 'posts/c182255e/index.html'), 'utf8');
  // Diagram source panels are injected after postprocess with their own
  // chrome; drop them so only pandoc's blocks are counted.
  const html = raw.replace(/<div class="sourceCode diagram-source[\s\S]*?<\/figure>/g, '');
  // Indented and language-less fences render as bare <pre> from pandoc; the
  // build must wrap every block, not just highlighted ones.
  const pres = (html.match(/<pre\b/g) || []).length;
  const wraps = (html.match(/<div class="code-wrap">/g) || []).length;
  assert.ok(pres > 0, 'the syntax page should contain code blocks');
  assert.equal(wraps, pres, 'every <pre> must sit inside a build-time .code-wrap');
  // With a language: head bar with label + copy. Language-less: plain card
  // (code-plain) with an icon-only corner copy, no head bar.
  assert.ok(html.includes('<span class="code-lang">js</span>'), 'highlighted block shows its language');
  // A fence title lands in the head bar alongside the language, and the
  // consumed attribute never survives as a tooltip.
  assert.ok(html.includes('<span class="code-title">sort.ts</span><span class="code-lang">ts</span>'), 'a titled fence shows its title');
  assert.ok(!/<(?:pre|div)\b[^>]*\btitle="sort\.ts"/.test(html), 'the fence title must be consumed, not duplicated');
  assert.ok(html.includes('class="sourceCode code-plain"'), 'language-less blocks become plain cards');
  const plainBox = html.slice(html.indexOf('code-plain'), html.indexOf('</pre>', html.indexOf('code-plain')));
  assert.ok(!plainBox.includes('code-head'), 'plain cards carry no head bar');
  assert.ok(/<li><p>Step one: stage the changes<\/p>\s*<div class="sourceCode code-plain">/.test(html), 'an indented block inside a list item is wrapped too');
  const app = fs.readFileSync(findAsset('app.js'), 'utf8');
  assert.ok(!app.includes('code-lang'), 'the head markup must not be rebuilt client-side');
});

test('link cards: no cached metadata degrades to the plain link and never fails the build', async () => {
  await sharedDocs; // built with --no-link-fetch and an empty cache dir
  const html = fs.readFileSync(path.join(docsDist, 'posts/9d19226c/index.html'), 'utf8');
  // Match the rendered card element, not the words "link-card" in the prose.
  assert.ok(!/<div class="link-card/.test(html), 'nothing may render as a card without metadata');
  // The demo link keeps its sanitizer-whitelisted class — the degraded shape
  // is exactly the plain link the markdown already described.
  assert.ok(html.includes('class="link-preview"'), 'the {.link-preview} class survives for the degraded link');
});

test('link cards: cached metadata renders a card; inline links and unknown urls stay plain', async () => {
  const copy = tmpDir('blog-cards-');
  fs.writeFileSync(path.join(copy, 'a.md'),
    '---\ntitle: 卡片\npublic: true\nabbrlink: "card0001"\n---\n\n' +
      '[兜底甲](https://good.example.org/x){.link-preview}\n\n' +
      '行内 [不升级](https://good.example.org/x){.link-preview} 出现在文字中间\n\n' +
      '[兜底乙](https://missing.example.org/y){.link-preview}\n\n' +
      '[ico 站](https://ico.example.org/z){.link-preview}\n');

  const cacheDir = tmpDir('blog-cardcache-');
  fs.writeFileSync(path.join(cacheDir, 'cache.json'), JSON.stringify({
    version: 1,
    entries: {
      'https://good.example.org/x': {
        ok: true, at: 0,
        title: 'A <b> title',
        desc: '</span><img src=x onerror=alert(1)> quoting /home/user/docs and {% raw %}',
        host: 'good.example.org',
        icon: { mime: 'image/png', b64: PNG.toString('base64') },
      },
      'https://ico.example.org/z': {
        // ICO favicons are the audit's only legitimate x-icon data URI source;
        // the output audit must let them through (guards SAFE_DATA in audit.ts).
        ok: true, at: 0, title: 'ICO site', desc: '', host: 'ico.example.org',
        icon: { mime: 'image/x-icon', b64: Buffer.from([0, 0, 1, 0, 1, 0]).toString('base64') },
      },
    },
  }));

  const out = tmpDir('blog-card-out-');
  const r = await runBuild(['--out', out, '--content', copy, '--no-link-fetch', '--link-cache', cacheDir]);
  assert.equal(r.status, 0, `build must survive missing metadata\n${r.stderr}`);
  const html = fs.readFileSync(path.join(out, 'posts/card0001/index.html'), 'utf8');

  assert.equal((html.match(/class="link-card"/g) || []).length, 2, 'cards: the sole-line cached link + the ICO-icon link');
  assert.ok(html.includes('data:image/x-icon;base64,'), 'ICO favicons must pass the output audit');
  const card = html.slice(html.indexOf('link-card'), html.indexOf('</a>', html.indexOf('link-card')));
  assert.ok(card.includes('href="https://good.example.org/x"'), 'card keeps the external href');
  assert.ok(card.includes('rel="noopener noreferrer"'), 'cards open without a window handle');
  assert.ok(card.includes('data:image/png;base64,'), 'favicon ships as a sniffed data URI');
  assert.ok(card.includes('data-inline'), 'favicon imgs must not become media-viewer content');
  assert.ok(card.includes('lc-glyph') === false, 'an icon must suppress the letter avatar');
  // Fetched metadata is external content: text nodes only, escaped by the serializer.
  assert.ok(html.includes('A &lt;b&gt; title'), 'title is escaped text');
  assert.ok(html.includes('&lt;/span&gt;&lt;img src=x onerror=alert(1)&gt;'), 'desc markup stays inert text');
  assert.ok(!html.includes('<img src=x'), 'no unescaped external markup may ship');
  // Inline occurrence and uncached url keep their plain shape.
  assert.equal((html.match(/class="link-preview"/g) || []).length, 2, 'inline + uncached links stay plain');
  assert.ok(
    /行内 <a href="https:\/\/good\.example\.org\/x" class="link-preview" target="_blank" rel="noopener noreferrer">/.test(html),
    'the inline link keeps its text siblings and opens a new tab',
  );
});

test('opening the viewer must not change page layout (no scrollbar-gutter loosening)', async () => {
  await shared;
  const css = fs.readFileSync(findAsset('style.css'), 'utf8');
  assert.ok(css.includes('scrollbar-gutter: stable'), 'html must keep stable so the body does not shift when a scrollbar appears');
  assert.ok(!/mv-open[^{]*\{[^}]*scrollbar-gutter/.test(css), 'changing the gutter when the viewer opens shifts the whole page');
  const js = fs.readFileSync(findAsset('media.js'), 'utf8');
  assert.ok(!js.includes('data-theme'), 'the viewer must not hardcode a theme, or diagrams on light pages would render dark');
});

test('public note URLs are extensionless directories (/posts/<abbrlink>/); existing abbrlinks are reused', async () => {
  await shared;
  assert.ok(fs.existsSync(path.join(dist, 'posts/d1b06489/index.html')), 'the first post should keep d1b06489');
  assert.ok(fs.existsSync(path.join(dist, 'posts/16f9b6d1/index.html')), 'the second post should keep 16f9b6d1');
  const posts = fs.readdirSync(path.join(dist, 'posts'));
  for (const d of posts) assert.match(d, /^[0-9a-f]{8}$/, `no .html files should remain under posts/: ${d}`);
  // In-page internal links are extensionless too, never the legacy .html shape.
  const html = findPageByTitle(dist, 'Post 1: from notes to blog');
  assert.ok(!/\/posts\/[0-9a-f]{8}\.html/.test(html), 'the page still references the old .html URL');
  assert.match(html, /href="\/posts\/[0-9a-f]{8}"/, 'internal note links should be extensionless');
});

test('image references are rewritten to root-absolute /assets/ and do not 404', async () => {
  await shared;
  const html = findPageByTitle(dist, 'Image references');
  // Only the note's own images: the header brand and footer credit ship theme
  // icons under /static/img/, not content attachments.
  const srcs = [...html.matchAll(/<img(?![^>]*class="logo-mark")[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(srcs.length >= 1);
  for (const s of srcs) {
    assert.match(s, /^\/assets\/[0-9a-f]{8}\//);
    assert.ok(fs.existsSync(path.join(dist, s.slice(1))), `attachment missing: ${s}`);
  }
});

test('media references are rewritten to root-absolute /assets/ and ship the files', async () => {
  await shared;
  const html = findPageByTitle(dist, 'Media references');
  const urls = [...html.matchAll(/<(?:video|audio|source|track)\b[^>]*?\s(?:src|poster)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(urls.length >= 4, `expected video/source/track/audio URLs: ${html.slice(0, 400)}`);
  for (const u of urls) {
    assert.match(u, /^\/assets\/[0-9a-f]{8}\//, u);
    assert.ok(fs.existsSync(path.join(dist, u.slice(1))), `attachment missing: ${u}`);
  }
  assert.ok(urls.some((u) => u.endsWith('.webm')) && urls.some((u) => u.endsWith('.wav')) && urls.some((u) => u.endsWith('.vtt')));
  assert.match(html, /<track[^>]+srclang="zh"[^>]+label="中文"/, 'the subtitle track declares its language');
  assert.ok(!/<(?:video|audio)\b[^>]*\bautoplay/.test(html), 'autoplay must never reach a media element');
});

test('outDir overlapping the content, the source, or the theme is refused before anything is deleted', async () => {
  const copy = makeContentCopy();
  const marker = path.join(copy, 'articles/post-1.md');
  const before = fs.readFileSync(marker, 'utf8');

  // writeDiff deletes everything in dist/ it did not emit, so each of these
  // would erase its own input.
  for (const [label, out] of [
    ['the content tree', copy],
    ['a subdirectory of the content tree', path.join(copy, 'out')],
    ['the builder source', path.join(REPO, 'src')],
  ] as const) {
    const r = await runBuild(['--out', out, '--content', copy]);
    assert.notEqual(r.status, 0, `outDir at ${label} must be refused`);
    assert.match(r.stderr, /outDir overlaps/, `expected an overlap error for ${label}: ${r.stderr}`);
    assert.equal(fs.readFileSync(marker, 'utf8'), before, `${label} must be left untouched`);
  }

  // The filesystem root contains everything; `out + sep` is "//" and a naive
  // check misses it.
  const rootOut = await runBuild(['--out', '/', '--content', copy]);
  assert.notEqual(rootOut.status, 0, 'outDir "/" must be refused');
  assert.match(rootOut.stderr, /outDir contains the project root|outDir overlaps/);

  // A symlinked content dir with a not-yet-existing dist must not hide the
  // overlap: realPath resolves the dist through the symlink.
  const realContent = makeContentCopy();
  const linkRoot = tmpDir('blog-linkroot-');
  const link = path.join(linkRoot, 'notes');
  fs.symlinkSync(realContent, link, 'dir');
  const viaLink = await runBuild(['--out', path.join(link, 'out'), '--content', link]);
  assert.notEqual(viaLink.status, 0, 'an outDir reaching into the real content tree through a symlink must be refused');
  assert.match(viaLink.stderr, /outDir overlaps the content directory/);
});

test('--skip-audit waives only the style-hash claim, never a link or private-content finding', async () => {
  const copy = tmpDir('blog-skipaudit-');
  fs.writeFileSync(path.join(copy, 'pub.md'), '---\ntitle: Public Doc\npublic: true\n---\n\n[leak](/secret)\n');
  const out = tmpDir('blog-skipaudit-out-');
  const r = await runBuild(['--out', out, '--content', copy, '--skip-audit'], { content: copy, out });
  assert.notEqual(r.status, 0, '--skip-audit must not let a nonexistent internal link ship');
  assert.match(r.stderr, /output audit failed[\s\S]*nonexistent file/i);
});

test('rebuilding into the same dist collects stale attachments and keeps the live one', async () => {
  const copy = makeContentCopy();
  const out = tmpDir('blog-rebuild-');
  const first = await runBuild(['--out', out, '--content', copy, '--no-link-fetch', '--link-cache', path.join(manifestDir, 'rebuild-cache')]);
  assert.equal(first.status, 0, first.stderr);
  const media = listFiles(path.join(out, 'assets')).filter((f) => f.endsWith('.webm'));
  assert.ok(media.length >= 1, 'the media test page should ship a webm');
  const live = path.relative(out, media[0]).split(path.sep).join('/');
  // A stale attachment from an earlier build (a URL no page references now);
  // its directory belongs to no live page, so create it explicitly.
  fs.mkdirSync(path.join(out, 'assets/9c41d7e2'), { recursive: true });
  fs.writeFileSync(path.join(out, 'assets/9c41d7e2/old.deadbeef.webm'), 'stale');

  const second = await runBuild(['--out', out, '--content', copy, '--no-link-fetch', '--link-cache', path.join(manifestDir, 'rebuild-cache')]);
  assert.equal(second.status, 0, second.stderr);
  assert.ok(!fs.existsSync(path.join(out, 'assets/9c41d7e2/old.deadbeef.webm')), 'stale attachment must be removed');
  assert.ok(fs.existsSync(path.join(out, live)), 'the live attachment must be kept');
});

test('private references are downgraded to text', async () => {
  await shared;
  const html = findPageByTitle(dist, 'Private references');
  assert.ok(html.includes('(page not public)'));
  assert.ok(html.includes('(image not public)'));
  assert.ok(!html.includes('secret.png'));
});

test('archives and RSS include only public notes with a date', async () => {
  await shared;
  const feed = fs.readFileSync(path.join(dist, 'feed.xml'), 'utf8');
  assert.ok(feed.includes('Post 1: from notes to blog'));
  assert.ok(!feed.includes('<title>Knowledge base</title>'), 'a note without a date should not enter the RSS feed');
  const archives = fs.readFileSync(path.join(dist, 'archives/index.html'), 'utf8');
  assert.ok(!/2026-1[0-9]-\d\d[\s\S]{0,400}Knowledge base<\/(a|span)>/.test(archives));
  assert.ok(/2026-0?9[\-\/?[\s\S]{0,400}Post 1: from notes to blog<\/span><\/a>/.test(archives));
});

test('sitemap.xml lists every public page once, as absolute URLs, and nothing private', async () => {
  await shared;
  const xml = fs.readFileSync(path.join(dist, 'sitemap.xml'), 'utf8');
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">\n/);
  assert.match(xml, /<\/urlset>\n$/);
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.equal(new Set(locs).size, locs.length, 'duplicate <loc> entries');
  for (const loc of locs) assert.match(loc, /^https:\/\/example\.com\//, `a loc must be absolute: ${loc}`);

  // Every loc resolves to a built page, and every HTML page except the 404 is listed.
  const listed = new Set(locs.map((l) => new URL(l).pathname));
  for (const pathname of listed) {
    assert.ok(
      fs.existsSync(path.join(dist, pathname.slice(1))) || fs.existsSync(path.join(dist, pathname.slice(1), 'index.html')),
      `sitemap points to a nonexistent page: ${pathname}`,
    );
  }
  const pages = listFiles(dist)
    .filter((f) => f.endsWith('.html'))
    .map((f) => '/' + path.relative(dist, f).split(path.sep).join('/').replace(/index\.html$/, '').replace(/\/$/, ''))
    .filter((p) => p !== '/404.html');
  for (const p of pages) assert.ok(listed.has(p === '/' ? '/' : p), `page missing from the sitemap: ${p}`);

  for (const secret of ['Account secrets', 'Weekend journal', 'Private attachment', 'Draft: unsettled ideas']) {
    assert.ok(!xml.includes(secret), `sitemap leaks private content "${secret}"`);
  }
  assert.ok(!/<loc>[^<]*私人/.test(xml), 'sitemap leaks a private path');
  // A dated note carries lastmod; the date is the note's own, never the build time.
  assert.match(xml, /<loc>https:\/\/example\.com\/posts\/d1b06489<\/loc>\n<lastmod>2026-09-12<\/lastmod>/);

  const robots = fs.readFileSync(path.join(dist, 'robots.txt'), 'utf8');
  assert.match(robots, /Sitemap: https:\/\/example\.com\/sitemap\.xml/);
});

test('tag case merging: K8s and k8s are the same page', async () => {
  await shared;
  const dirs = fs.readdirSync(path.join(dist, 'tags')).sort();
  const k8s = dirs.filter((d) => d.toLowerCase() === 'k8s');
  assert.equal(k8s.length, 1, `duplicate tag pages: ${dirs.join(', ')}`);
});

test('sidebar contains only public nodes; groups ship closed and keyed for the boot script', async () => {
  await shared;
  const html = findPageByTitle(dist, 'Level 4');
  assert.ok(!html.includes('Private notes'));
  assert.ok(!html.includes('Account secrets'));
  // Every group is server-rendered closed; ui-boot.ts opens the current
  // chain and any stored groups before the first frame.
  assert.ok(!/<details\b[^>]*\sopen(?:\s|>)/.test(html), 'groups must ship closed');
  assert.match(html, /<details data-key="tech\/docker\/deep"/, 'groups carry their relPath as the stable key');
  assert.match(html, /data-tree-groups="[^"]*&quot;tech\/docker&quot;/, 'the expand-all control needs the full group list');
  assert.ok(/data-tree-all/.test(html), 'the expand/collapse-all control must exist');
  // One click opens and navigates: the group title is a plain link inside
  // <summary>, with a separate caret button for pure expansion.
  assert.match(html, /<summary><button type="button" class="tw"[^>]*><svg[^>]*>[\s\S]*?<\/button><a class="tree-link"/);
});

test('Subpages lists only immediate children; a directory child does not pull up its own subpages', async () => {
  await shared;
  const html = findPageByTitle(dist, 'Toolchain');
  const at = html.indexOf('class="children"');
  assert.ok(at > 0, 'the index page should render a Subpages section');
  const section = html.slice(at, html.indexOf('</section>', at));
  const titles = [...section.matchAll(/<h3 class="card-title"><a [^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
  assert.deepEqual(titles, ['Cheat sheet', 'Terminal &amp; shell', 'Scripting', 'End-to-end tuning: P99 from 2.1s to 240ms', 'Node.js 22 LTS upgrade notes']);
  assert.ok(!section.includes('Prompt & history'), 'a grandchild page must not appear in its grandparent\'s Subpages');
});

test('page identity lives on <article>, never in a class on <body> (a shared class leaks page layout into the sidebar)', async () => {
  await shared;
  const pages = listFiles(dist).filter((f) => f.endsWith('.html'));
  const kinds = new Set<string>();
  for (const f of pages) {
    const html = fs.readFileSync(f, 'utf8');
    const body = html.match(/<body([^>]*)>/);
    assert.ok(body, `${path.relative(dist, f)} has no <body>`);
    assert.ok(!/\bclass=/i.test(body[1]), `<body> must carry no class: ${body[0]}`);
    const kind = body[1].match(/data-page="([^"]+)"/)?.[1];
    assert.ok(kind, `${path.relative(dist, f)}: <body> must declare data-page`);
    assert.ok(
      new RegExp(`<article class="page-${kind}\\b`).test(html),
      `${path.relative(dist, f)}: the article's class must be page-${kind}, matching data-page`,
    );
    kinds.add(kind);
  }
  for (const k of ['home', 'post', 'index', 'archives', 'tags', 'tag', '404']) {
    assert.ok(kinds.has(k), `no page of kind ${k} was rendered, so its CSS is untested`);
  }
});

test('breadcrumbs: the current page also gets a sibling menu; directory entries get cascading panels', async () => {
  await shared;
  const html = findPageByTitle(dist, 'Level 4');
  const nav = html.slice(html.indexOf('<nav class="crumbs"'), html.indexOf('</nav>', html.indexOf('<nav class="crumbs"')));
  assert.ok(nav, 'the page should render breadcrumbs');
  assert.equal((nav.match(/<li class="crumb\b/g) || []).length, 5, 'should contain Home / 技术笔记 / Docker / 深层 / 第四层');
  const currentLi = nav.slice(nav.indexOf('<li class="crumb current"'));
  assert.match(currentLi, /data-crumb-key="4"/, 'the current page\'s breadcrumb must open its own level');
  // Panels are flat siblings in one layer, never nested inside the crumb list.
  const layer = html.slice(html.indexOf('<div class="crumb-layer"'), html.indexOf('</div>', html.indexOf('<div class="crumb-layer"')));
  assert.match(layer, /<ul class="crumb-panel" data-crumb-panel="4"/);
  assert.match(layer, /<ul class="crumb-panel" data-crumb-panel="0"/);
  // A directory row inside a panel is the trigger of its own panel, by key.
  assert.match(layer, /<li class="crumb-item has-sub" data-crumb-key="[\d.]+"/);
  assert.match(layer, /class="crumb-item-link is-current" href="[^"]+" aria-current="page"/);
});

test("CSP constraints: no <style> blocks; inline styles come only from note content", async () => {
  await shared;
  for (const f of listFiles(dist).filter((x) => x.endsWith('.html'))) {
    const html = fs.readFileSync(f, 'utf8');
    assert.ok(!/<style[\s>]/i.test(html), `${path.relative(dist, f)} contains <style>`);
    // Note bodies may carry inline styles; those are hashed at build time.
    const shell = html.replace(/<article[\s\S]*<\/article>/, '');
    assert.ok(!/\sstyle="/i.test(shell), `${path.relative(dist, f)} page shell contains an inline style`);
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    for (const m of scripts) {
      const attrs = m[1];
      const body = m[2].trim();
      if (/src=/.test(attrs)) continue; // external script (self-hosted)
      const allowed = [themeInitSrc, uiBootSrc].map((s) => s.trim());
        assert.ok(allowed.includes(body) && body.length < 2000, `suspicious inline script: ${body.slice(0, 80)}`);
    }
  }
});

test('giscus: comments render only when configured; the container carries config attributes, never an iframe', async () => {
  // Unconfigured (the pinned neutral config): no comments markup at all.
  await shared;
  const bare = fs.readFileSync(path.join(dist, 'posts/12341234/index.html'), 'utf8');
  assert.ok(!bare.includes('data-giscus'), 'no comments without a giscus block in the config');
  assert.ok(!bare.includes('data-scroll-comments'), 'the TOC rail entry must disappear too');

  // Configured via a profile: config attributes only; the iframe is created on demand.
  const profile = path.join(manifestDir, `giscus-${buildSeq++}.mjs`);
  fs.writeFileSync(
    profile,
    `export default { url: 'https://example.com', siteName: 't', lang: 'en',` +
      ` contentDir: 'tests/fixtures/content', outDir: 'unused', themeDir: 'themes/default',` +
      ` cacheDir: '.cache', manifestFile: 'unused.json', postPattern: '/posts/{abbrlink}',` +
      ` pageSize: { home: 5, feed: 5 }, giscus: { repo: 'noteflow/demo', repoId: 'R_demo',` +
      ` category: 'Announcements', categoryId: 'DIC_demo' } };\n`,
  );
  const out = tmpDir('blog-giscus-');
  const r = await runBuild(['--config', profile, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const html = fs.readFileSync(path.join(out, 'posts/12341234/index.html'), 'utf8');
  assert.match(html, /data-giscus/, 'note pages should have a comments container');
  assert.match(html, /data-term="posts\/12341234"/, 'the term must be a fixed value, never empty');
  assert.match(html, /data-repo="noteflow\/demo"/);
  assert.match(html, /id="comments"/, 'the comments anchor must exist; the sidebar entry depends on it');
  assert.ok(!/<iframe/i.test(html), 'the server must not render an iframe (no third party on first paint)');
  assert.ok(html.includes('data-scroll-comments'), 'the TOC rail should have a jump-to-comments entry');

  // Index pages get no comments: an auto-generated listing has no discussion of its own.
  const indexHtml = fs.readFileSync(path.join(out, 'posts/a39aca86/index.html'), 'utf8');
  assert.ok(indexHtml.includes('class="page-index"'), 'this page should be an index page');
  assert.ok(!indexHtml.includes('data-giscus'), 'index pages should not render comments');
});

suite('build variants', { concurrency: 6 }, () => {
  test('giscus: comments: false disables comments; an unknown value fails the build', async () => {
    const file = 'tech/no-comments.md';
    const { out, result: r } = await buildCopy((copy) =>
      fs.writeFileSync(path.join(copy, file), '---\ntitle: No comments\npublic: true\nabbrlink: "abcdef01"\ncomments: false\n---\nbody text\n'),
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const html = fs.readFileSync(path.join(out, 'posts/abcdef01/index.html'), 'utf8');
    assert.ok(!html.includes('data-giscus'), 'comments: false should not render comments');
    assert.ok(!html.includes('data-scroll-comments'), 'the sidebar entry must disappear once comments are off');

    // A second build from the same copy: comments: "no" must fail closed.
    const copy2 = makeContentCopy();
    fs.writeFileSync(path.join(copy2, file), '---\ntitle: No comments\npublic: true\nabbrlink: "abcdef01"\ncomments: "no"\n---\nbody text\n');
    const bad = await runBuild(['--out', tmpDir('d-bad-'), '--content', copy2]);
    assert.notEqual(bad.status, 0, 'a non-boolean comments value must fail the build');
    assert.match(bad.stderr + bad.stdout, /must be a YAML boolean/);
  });

  test('--check mode: computes missing abbrlinks on the fly and writes nothing back', async () => {
    const copy = makeContentCopy();
    const extra = path.join(copy, '新笔记没有链接.md');
    fs.writeFileSync(extra, '---\ntitle: 新笔记\ndate: 2026-11-01\npublic: true\n---\nbody text\n');
    const before = fs.readFileSync(extra, 'utf8');
    const out = tmpDir('check-fly-');
    const r = await runBuild(['--check', '--out', out], { content: copy, out });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(extra, 'utf8'), before, '--check must not modify source files');
    assert.match(r.stderr + r.stdout, /without an abbrlink/);
    const slug = computeAbbrlink('新笔记', '2026-11-01');
    assert.ok(fs.existsSync(path.join(out, 'posts', slug, 'index.html')), `served at the computed slug ${slug}`);
  });

  test('--check never fetches link metadata: a card with no cache degrades, offline', async () => {
    const copy = tmpDir('check-offline-');
    fs.writeFileSync(
      path.join(copy, 'a.md'),
      '---\ntitle: Card\npublic: true\nabbrlink: "c0ffee01"\n---\n\n[某站](https://unreachable.example.org/x){.link-preview}\n',
    );
    const out = tmpDir('check-offline-out-');
    // No --no-link-fetch and no cache: without the fix this build would try the
    // network during --check, whose output must not depend on network state.
    const r = await runBuild(['--check', '--out', out, '--content', copy, '--link-cache', tmpDir('check-offline-cache-')], {
      content: copy,
      out,
    });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /no cached metadata \(fetch disabled\)/);
    // Degraded to the plain link the author wrote, not a card.
    const html = fs.readFileSync(path.join(out, 'posts/c0ffee01/index.html'), 'utf8');
    assert.ok(!html.includes('class="link-card"'), 'no card without fetched metadata');
    assert.ok(html.includes('class="link-preview"'), 'the plain link survives');
  });

  test('the build writes back missing abbrlinks and leaves unknown fields untouched', async () => {
    const original = '---\ntitle: 新笔记\ndate: 2026-11-01\npublic: true\ncustom: keep-me\n---\nbody text\n';
    const copy = makeContentCopy();
    const extra = path.join(copy, '新笔记没有链接.md');
    fs.writeFileSync(extra, original);
    const out = tmpDir('writeback-');
    const r = await runBuild(['--out', out], { content: copy, out });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const after = fs.readFileSync(extra, 'utf8');
    assert.match(after, /abbrlink: "[0-9a-f]{8}"/);
    assert.match(after, /custom: keep-me/);
    assert.ok(after.startsWith('---\ntitle: 新笔记\ndate: 2026-11-01\npublic: true\ncustom: keep-me\n'));
    const slug = computeAbbrlink('新笔记', '2026-11-01');
    assert.ok(fs.existsSync(path.join(out, 'posts', slug, 'index.html')), `served at ${slug}`);
  });

  test('a broken link fails the build, naming the file and the heading it sits under', async () => {
    const copy = brokenLinkTree();
    const r = await runBuild([], { content: copy });
    assert.notEqual(r.status, 0);
    const out = r.stderr + r.stdout;
    assert.match(out, /a\.md/);
    assert.match(out, /link target does not exist/);
    assert.match(out, /a\.md › 「组件源码」: link target does not exist: \.\/missing-one\.md/);
    // The nested heading is the nearest section: "部署步骤" wraps "子小节".
    assert.match(out, /a\.md › 「子小节」: link target does not exist: \.\/missing-two\.md/);
    // A reference above the first heading has no section to name.
    assert.match(out, /a\.md: link target does not exist: \.\/不存在\.md/);
  });

  test('the render cache reuses unchanged pages, re-converts only the edited one, and never changes the output', async () => {
    const copy = makeContentCopy();
    const cacheDir = path.join(tmpDir('blog-cache-'), 'r');
    const out = tmpDir('blog-cacheout-');
    const profile = path.join(manifestDir, `cache-${buildSeq++}.mjs`);
    fs.writeFileSync(
      profile,
      `export default { url: 'https://example.com', siteName: 't', lang: 'en',` +
        ` contentDir: ${JSON.stringify(copy)}, outDir: ${JSON.stringify(out)}, themeDir: 'themes/default',` +
        ` cacheDir: ${JSON.stringify(cacheDir)}, manifestFile: ${JSON.stringify(path.join(manifestDir, `cachem-${buildSeq++}.json`))}, postPattern: '/posts/{abbrlink}',` +
        ` pageSize: { home: 5, feed: 5 } };\n`,
    );
    // --skip-mermaid: mermaid hashes Chromium's SVG output, so cached HTML
    // with figures is only reproducible on the same browser build.
    const build = (): Promise<BuildResult> => runBuild(['--config', profile, '--out', out], { content: copy, out });
    const first = await build();
    assert.equal(first.status, 0, first.stderr);
    const cold = listFiles(out).filter((f) => f.endsWith('.html')).map((f) => [path.relative(out, f), fs.readFileSync(f, 'utf8')] as const);

    const second = await build();
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /render cache: \d+ of \d+ pages reused/);
    for (const [rel, html] of cold) assert.equal(fs.readFileSync(path.join(out, rel), 'utf8'), html, `${rel} changed on a warm rebuild`);

    // One edited note: its page re-converts, the rest stay cached.
    const edited = path.join(copy, 'articles/post-1.md');
    fs.writeFileSync(edited, fs.readFileSync(edited, 'utf8') + '\nAn edited paragraph.\n');
    const third = await build();
    assert.equal(third.status, 0, third.stderr);
    const m = /render cache: (\d+) of (\d+) pages reused/.exec(third.stdout);
    assert.ok(m, 'the cache should report its reuse');
    assert.equal(Number(m[1]), Number(m[2]) - 1, 'exactly the edited page must re-convert');
    assert.ok(fs.readFileSync(path.join(out, 'posts/d1b06489/index.html'), 'utf8').includes('An edited paragraph.'));

    // Two builds sharing one cacheDir (the docs profile and the personal build
    // share .cache/render): entries are namespaced by the build digest, so
    // neither prune() nor a rewrite may evict the other's work. The base-path
    // url gives the second profile a different digest over the same pages.
    const otherOut = tmpDir('blog-cacheout2-');
    const other = path.join(manifestDir, `cache2-${buildSeq++}.mjs`);
    fs.writeFileSync(other, fs.readFileSync(profile, 'utf8').replace("'https://example.com'", "'https://example.com/noteflow'").replace(JSON.stringify(out), JSON.stringify(otherOut)));
    const warmA = await build();
    assert.equal(warmA.status, 0, warmA.stderr);
    const reA = /render cache: (\d+) of (\d+) pages reused/.exec(warmA.stdout);
    assert.ok(reA && reA[1] === reA[2], `profile A must still be warm: ${warmA.stdout}`);
    const otherFirst = await runBuild(['--config', other, '--out', otherOut], { content: copy, out: otherOut });
    assert.equal(otherFirst.status, 0, otherFirst.stderr);
    const otherWarm = await runBuild(['--config', other, '--out', otherOut], { content: copy, out: otherOut });
    assert.equal(otherWarm.status, 0, otherWarm.stderr);
    const reB = /render cache: (\d+) of (\d+) pages reused/.exec(otherWarm.stdout);
    assert.ok(reB && reB[1] === reB[2], `profile B must keep its own entries: ${otherWarm.stdout}`);
    const againA = await build();
    assert.equal(againA.status, 0, againA.stderr);
    const reA2 = /render cache: (\d+) of (\d+) pages reused/.exec(againA.stdout);
    assert.ok(reA2 && reA2[1] === reA2[2], `profile A must survive profile B building alongside: ${againA.stdout}`);

    // --check is read-only: it must not create or refresh the cache.
    fs.rmSync(cacheDir, { recursive: true, force: true });
    const checked = await runBuild(['--config', profile, '--out', out, '--check'], { content: copy, out });
    assert.equal(checked.status, 0, checked.stderr);
    assert.ok(!fs.existsSync(cacheDir), '--check must not write the render cache');
  });

  test('--no-render-cache re-converts every page and yields byte-identical output', async () => {
    const copy = makeContentCopy();
    const cacheDir = path.join(tmpDir('blog-nocache-'), 'r');
    const out = tmpDir('blog-nocacheout-');
    const profile = path.join(manifestDir, `nocache-${buildSeq++}.mjs`);
    fs.writeFileSync(
      profile,
      `export default { url: 'https://example.com', siteName: 't', lang: 'en',` +
        ` contentDir: ${JSON.stringify(copy)}, outDir: ${JSON.stringify(out)}, themeDir: 'themes/default',` +
        ` cacheDir: ${JSON.stringify(cacheDir)}, manifestFile: ${JSON.stringify(path.join(manifestDir, `nocachem-${buildSeq++}.json`))}, postPattern: '/posts/{abbrlink}',` +
        ` pageSize: { home: 5, feed: 5 } };\n`,
    );
    const build = (extra: string[]): Promise<BuildResult> => runBuild(['--config', profile, '--out', out, ...extra], { content: copy, out });

    const cold = await build([]);
    assert.equal(cold.status, 0, cold.stderr);
    const html = listFiles(out).filter((f) => f.endsWith('.html')).map((f) => [path.relative(out, f), fs.readFileSync(f, 'utf8')] as const);

    // Warm without the flag: everything is reused.
    const warm = await build([]);
    assert.equal(warm.status, 0, warm.stderr);
    assert.match(warm.stdout, /render cache: (\d+) of \1 pages reused\n/);

    // With the flag a warm build re-converts anyway, and says so.
    const forced = await build(['--no-render-cache']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(forced.stdout, /render cache: 0 of \d+ pages reused \(disabled\)/);

    // Skipping the cache never changes what is written.
    for (const [rel, before] of html) assert.equal(fs.readFileSync(path.join(out, rel), 'utf8'), before, `${rel} changed with --no-render-cache`);

    // Combined with --check it is a cold verification: nothing read or written.
    fs.rmSync(cacheDir, { recursive: true, force: true });
    const verified = await build(['--check', '--no-render-cache']);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /render cache: 0 of \d+ pages reused \(disabled\)/);
    assert.ok(!fs.existsSync(cacheDir), '--check --no-render-cache must not write the cache');
  });

  test('a crafted abbrlink fails the build before any cache file is written', async () => {
    const copy = tmpDir('blog-badabbr-');
    fs.writeFileSync(path.join(copy, 'a.md'), '---\ntitle: 越界\npublic: true\nabbrlink: "../../package"\n---\n\nbody\n');
    const out = tmpDir('blog-badabbrout-');
    const r = await runBuild(['--out', out, '--content', copy], { content: copy, out });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /abbrlink must be letters/);
    const pkg = path.join(REPO, 'package.json');
    assert.ok(JSON.parse(fs.readFileSync(pkg, 'utf8')).name === 'noteflow', 'package.json must not be overwritten by a cache entry');
  });

  test('a custom themeDir is hashed by its own CSS, not themes/default', async () => {
    const copy = makeContentCopy();
    const alt = tmpDir('blog-alt-theme-');
    fs.cpSync(path.join(REPO, 'themes/default'), alt, { recursive: true });
    const profile = path.join(manifestDir, `alt-${buildSeq++}.mjs`);
    const out = tmpDir('blog-altout-');
    fs.writeFileSync(
      profile,
      `export default { url: 'https://example.com', siteName: 't', lang: 'en', contentDir: ${JSON.stringify(copy)},` +
        ` outDir: ${JSON.stringify(out)}, themeDir: ${JSON.stringify(alt)}, cacheDir: ${JSON.stringify(tmpDir('blog-altcache-'))},` +
        ` manifestFile: ${JSON.stringify(path.join(manifestDir, `altm-${buildSeq++}.json`))}, postPattern: '/posts/{abbrlink}', pageSize: { home: 5, feed: 5 } };\n`,
    );
    const r = await runBuild(['--config', profile, '--out', out], { content: copy, out });
    assert.equal(r.status, 0, r.stderr);
    // Editing that theme's CSS must invalidate the cache (the digest covers it).
    const first = await runBuild(['--config', profile, '--out', out], { content: copy, out });
    const reUsed = /render cache: (\d+) of (\d+) pages reused/.exec(first.stdout);
    assert.ok(reUsed && reUsed[1] === reUsed[2], 'the custom theme must cache like the default one');
    fs.appendFileSync(path.join(alt, 'css/utilities.css'), '\n.probe { color: red; }\n');
    const after = await runBuild(['--config', profile, '--out', out], { content: copy, out });
    assert.equal(after.status, 0, after.stderr);
    const reAfter = /render cache: (\d+) of (\d+) pages reused/.exec(after.stdout);
    assert.ok(reAfter && reAfter[1] === '0', 'a custom theme CSS edit must invalidate every page');
  });

  test('a non-boolean public fails the build (fail-open guard)', async () => {
    const copy = badPublicTree();
    const r = await runBuild([], { content: copy });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /must be a YAML boolean/);
  });

  test('link policy: external and attachment links open a new tab; note navigation does not; a violation fails the audit', async () => {
    const file = 'tech/link-policy.md';
    const { out, result: r } = await buildCopy((copy) => {
      fs.writeFileSync(
        path.join(copy, file),
        '---\ntitle: Link policy\npublic: true\nabbrlink: "exlink01"\n---\n' +
          '\n[off-site](https://pandoc.org) [on-site](./docker/network.md) [anchor](#top) [mail](mailto:a@b.c)\n' +
          '\n[download](./attachments/sample.pdf)\n',
      );
      fs.mkdirSync(path.join(copy, 'tech/attachments'), { recursive: true });
      fs.writeFileSync(path.join(copy, 'tech/attachments/sample.pdf'), '%PDF-1.4\n');
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const html = fs.readFileSync(path.join(out, 'posts/exlink01/index.html'), 'utf8');
    assert.ok(/<a href="https:\/\/pandoc\.org" target="_blank" rel="noopener noreferrer">off-site<\/a>/.test(html), html);
    assert.ok(/<a href="\/assets\/[^"]+" target="_blank" rel="noopener noreferrer">download<\/a>/.test(html), html);
    // Page navigation inside the site keeps the current tab.
    assert.ok(/<a href="\/posts\/[^"]+">on-site<\/a>/.test(html), html);
    assert.ok(/<a href="#top">anchor<\/a>/.test(html), html);
    assert.ok(/<a href="mailto:a@b\.c">mail<\/a>/.test(html), html);

    // A stripped target on a specific off-site link must fail the output audit.
    // The Standard Markdown page (posts/c182255e) is built by the docs profile,
    // so this half runs under the base-path config; the inverse half stays on
    // the root-config fixture build.
    await sharedDocs;
    const tampered = tmpDir('blog-links-audit-');
    fs.cpSync(docsDist, tampered, { recursive: true });
    const page = path.join(tampered, 'posts/c182255e/index.html');
    const before = fs.readFileSync(page, 'utf8');
    const stripped = before.replace(/href="https:\/\/pandoc\.org" target="_blank"/, 'href="https://pandoc.org"');
    assert.notEqual(stripped, before, 'the fixture page must contain the pandoc.org link');
    fs.writeFileSync(page, stripped);
    // The inverse must bite too: an internal anchor that wrongly opens a new tab.
    const tamperedRoot = tmpDir('blog-links-audit-root-');
    fs.cpSync(dist, tamperedRoot, { recursive: true });
    const inverse = path.join(tamperedRoot, 'posts/12341234/index.html');
    fs.writeFileSync(inverse, fs.readFileSync(inverse, 'utf8').replace(/<a class="crumb-label" href="(\/posts\/[^"]+)"/, '<a class="crumb-label" href="$1" target="_blank"'));

    const { runAuditDetailed } = await import('../src/build/audit.ts');
    const { loadConfig } = await import('../src/core/config.ts');
    const audit = runAuditDetailed({
      dist: tampered,
      pages: [],
      privateItems: [],
      cfg: await loadConfig(path.resolve(REPO, 'site.config.docs.mjs')),
    });
    const offsite = audit.findings.find((f) => /off-site link must open a new tab/.test(f.msg));
    assert.ok(offsite, `audit must catch an off-site anchor without target: ${JSON.stringify(audit.findings.slice(0, 3))}`);
    assert.equal(offsite.file, 'posts/c182255e/index.html');
    assert.match(offsite.msg, /https:\/\/pandoc\.org/);
    const auditRoot = runAuditDetailed({ dist: tamperedRoot, pages: [], privateItems: [], cfg: await loadConfig() });
    assert.ok(
      auditRoot.findings.some((f) => f.file === 'posts/12341234/index.html' && /internal link must stay/.test(f.msg)),
      'audit must catch an internal anchor that opens a new tab',
    );
  });
});

test('no pandoc server is left running after the build', () => {
  let out = '';
  try {
    out = execFileSync('pgrep', ['-af', '^pandoc server'], { encoding: 'utf8' }).trim();
  } catch {
    out = ''; // pgrep exits 1 when nothing matches, which is what we want
  }
  assert.equal(out, '', `leftover process: ${out}`);
});


function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

function findPageByTitle(root: string, title: string): string {
  for (const f of listFiles(root).filter((x) => x.endsWith('.html'))) {
    const html = fs.readFileSync(f, 'utf8');
    if (html.includes(`<title>${title} ·`)) return html;
  }
  throw new Error(`page not found: ${title}`);
}

test('all static assets are content-addressed: hashed under /static/, HTML references no legacy unhashed paths', async () => {
  await shared;
  // When font caches expire and fonts re-download, font-display: swap makes the
  // whole page fall back and swap back — the header and sidebar visibly "jitter".
  // Content-addressed URLs let browsers cache forever, cutting off re-downloads
  // at the source. This test locks in that contract.
  const statics = listFiles(path.join(dist, 'static')).map((f) => path.relative(path.join(dist, 'static'), f));
  assert.ok(statics.length > 0, '/static/ should contain assets');
  const hashed = statics.filter((f) => /\.[0-9a-f]{8}\.[a-z0-9]+$/i.test(f));
  const unhashed = statics.filter((f) => !/\.[0-9a-f]{8}\.[a-z0-9]+$/i.test(f) && !/\.woff2$/i.test(f));
  assert.ok(hashed.length >= 4, `CSS/JS/icons should carry content hashes; got ${hashed.length} hashed`);
  // Font filenames carry their own hash (<name>.<hash>.woff2).
  for (const f of statics.filter((x) => x.endsWith('.woff2'))) {
    assert.match(path.posix.basename(f), /\.[0-9a-f]{8}\.woff2$/, `font not hashed: ${f}`);
  }
  assert.equal(unhashed.length, 0, `unhashed static assets remain: ${unhashed.join(', ')}`);

  const index = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  for (const legacy of ['/style.css', '/fonts.css', '/app.js', '/search.js', '/media.js', '/diagrams.css', '/favicon.svg', '/favicon.png']) {
    assert.ok(!new RegExp(`(?:href|src)="${legacy}"`).test(index), `the page still references unhashed ${legacy}`);
  }
  assert.ok(/<link rel="stylesheet" href="\/static\/style\.[0-9a-f]{8}\.css">/.test(index), 'should reference the hashed style.css');
  assert.ok(/<script type="module" src="\/static\/js\/app\.[0-9a-f]{8}\.js"><\/script>/.test(index), 'should reference the hashed app.js');
});

test('font CSS references hashed font files, all resolvable (else fonts vanish silently)', async () => {
  await shared;
  const fontsCssFile = listFiles(path.join(dist, 'static')).find((f) => /fonts\.[0-9a-f]{8}\.css$/.test(f));
  assert.ok(fontsCssFile, 'output is missing fonts.<hash>.css');
  const css = fs.readFileSync(fontsCssFile, 'utf8');
  const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1].replace(/['"]/g, ''));
  assert.ok(urls.length > 100, `unexpected font URL count: ${urls.length}`);
  for (const u of urls) {
    assert.match(u, /^\/static\/fonts\/.+\.[0-9a-f]{8}\.woff2$/, `font URL is not content-addressed: ${u}`);
    assert.ok(fs.existsSync(path.join(dist, u.slice(1))), `font URL points to a nonexistent file: ${u}`);
  }
});

test('browser module lazy imports point at hashed files (else on-demand loads 404)', async () => {
  await shared;
  const appFile = listFiles(path.join(dist, 'static')).find((f) => /app\.[0-9a-f]{8}\.js$/.test(f));
  assert.ok(appFile, 'output is missing app.<hash>.js');
  // The lazy imports now live in the feature loaders app.js statically imports;
  // collect them from every emitted module so each on-demand load is checked.
  const modules = listFiles(path.join(dist, 'static')).filter((f) => f.endsWith('.js'));
  const imports = modules.flatMap((f) =>
    [...fs.readFileSync(f, 'utf8').matchAll(/import\("(\.\/[^"]+)"\)/g)].map((m) => ({ file: f, spec: m[1] })),
  );
  assert.ok(imports.length >= 2, `the loaders should lazily import search and media; got ${imports.length}`);
  for (const { file, spec } of imports) {
    assert.match(spec, /^\.\/[a-z-]+\.[0-9a-f]{8}\.js$/, `import does not point at a hashed file: ${spec}`);
    const target = path.join(path.dirname(file), spec.slice(2));
    assert.ok(fs.existsSync(target), `import from ${path.basename(file)} points to a nonexistent file: ${spec}`);
  }
});

test('the soft-navigation module ships with the build: config injected, static imports rewritten, no placeholders left', async () => {
  await shared;
  const appFile = listFiles(path.join(dist, 'static')).find((f) => /app\.[0-9a-f]{8}\.js$/.test(f));
  assert.ok(appFile, 'output is missing app.<hash>.js');
  const app = fs.readFileSync(appFile, 'utf8');
  // app.ts imports spa.js statically (it wires the router at module load).
  const staticImport = app.match(/from\s+"(\.\/spa\.[0-9a-f]{8}\.js)"/);
  assert.ok(staticImport, `app.js is missing the static import of the spa module: ${app.slice(0, 300)}`);
  const spaFile = path.join(path.dirname(appFile), staticImport![1].slice(2));
  assert.ok(fs.existsSync(spaFile), 'the spa file imported by app.js does not exist');

  const spa = fs.readFileSync(spaFile, 'utf8');
  assert.ok(!spa.includes('__NOTEFLOW_SPA_CONFIG__'), 'the config placeholder in spa.js was not replaced');
  // With --skip-mermaid there are no diagrams, so the URL is legitimately empty.
  assert.match(
    spa,
    /"diagramsCss":\s*"(?:\/static\/diagrams\.[0-9a-f]{8}\.css)?"/,
    'spa.js diagramsCss is neither empty nor a hashed URL',
  );
  assert.ok(spa.includes('[data-nav-spinner]'), 'spa.js should drive the header loading indicator');
  assert.ok(!/interface\s|^type\s+\w+\s*=/m.test(spa), 'browser scripts must not contain type declarations');
});

test('pages mark soft-navigation regions, and header controls live inside the header', async () => {
  await shared;
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  assert.ok(/<header class="site-header(?: has-sidebar)?" data-region="header">/.test(html), 'header is missing the data-region marker');
  assert.ok(/<main id="main">/.test(html), 'missing main#main (the soft-navigation swap anchor)');
  assert.ok(html.includes('data-theme-toggle'), 'the theme toggle should be delegation-friendly');
  assert.ok(html.includes('data-sidebar-collapse'), 'the sidebar-collapse button should be delegation-friendly');
  assert.ok(html.includes('data-search-open'), 'the search entry should be delegation-friendly');
});

test('repoUrl turns into a header GitHub link that opens off-site', async () => {
  await sharedDocs;
  // The docs profile is the one with repoUrl set; the neutral default has none.
  const docsHtml = fs.readFileSync(path.join(docsDist, 'index.html'), 'utf8');
  assert.ok(
    docsHtml.includes('<a class="icon-btn repo-link" href="https://github.com/gogongxt/noteflow" target="_blank" rel="noopener noreferrer"'),
    'the docs header is missing the GitHub link',
  );
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  assert.ok(!html.includes('repo-link'), 'without repoUrl the header must not link anywhere');
});

test('edit links each docs page title to its source file in the forge', async () => {
  await sharedDocs;
  // Features.md carries a space-free path; Standard Markdown.md proves the encoding.
  for (const [abbr, file] of [
    ['9d19226c', 'docs/Syntax/Features.md'],
    ['c182255e', 'docs/Syntax/Standard%20Markdown.md'],
  ] as const) {
    const page = fs.readFileSync(path.join(docsDist, `posts/${abbr}/index.html`), 'utf8');
    const href = `https://github.com/gogongxt/noteflow/edit/master/${file}`;
    assert.ok(
      page.includes(`<a class="post-edit" href="${href}" target="_blank" rel="noopener noreferrer"`),
      `posts/${abbr} is missing the edit link to ${href}`,
    );
  }
  // The neutral profile configures no edit block, so its titles must stay bare.
  const html = fs.readFileSync(path.join(dist, 'posts/12341234/index.html'), 'utf8');
  assert.ok(!html.includes('post-edit'), 'without an edit block no page may carry an edit link');
});

test('edit links cover every page kind: note, bundle, _index.md directory, bare listing', async () => {
  const out = tmpDir('blog-editdist-');
  const profile = path.join(manifestDir, `edit-profile-${buildSeq}.mjs`);
  fs.writeFileSync(
    profile,
    `export default { url: 'https://example.com', siteName: 't', lang: 'en',` +
      ` contentDir: 'tests/fixtures/content', outDir: ${JSON.stringify(out)}, themeDir: 'themes/default',` +
      ` cacheDir: '.cache', manifestFile: 'unused.json', postPattern: '/posts/{abbrlink}',` +
      ` pageSize: { home: 5, feed: 5 },` +
      ` edit: { repoUrl: 'https://git.example.com/you/notes', branch: 'trunk', provider: 'gitea', root: 'site' } };\n`,
  );
  const result = await runBuild(['--config', profile, '--out', out]);
  assert.equal(result.status, 0, result.stderr);

  // Locate each page by its rendered title rather than hard-coding abbrlinks.
  const linkIn = (title: string): string | null => {
    for (const dir of fs.readdirSync(path.join(out, 'posts'))) {
      const file = path.join(out, 'posts', dir, 'index.html');
      if (!fs.existsSync(file)) continue;
      const html = fs.readFileSync(file, 'utf8');
      if (html.includes(`<h1 class="post-title">${title}<a class="post-edit"`)) {
        return html.match(/<a class="post-edit" href="([^"]+)"/)![1];
      }
    }
    return null;
  };
  const base = 'https://git.example.com/you/notes/_edit/trunk/site';
  assert.equal(linkIn('Tech notes'), `${base}/tech.md`, 'a note links its own file');
  assert.equal(linkIn('Toolchain'), `${base}/toolchain/_index.md`, 'a directory page links its _index.md');
  // A listing generated from children alone has no source file: no pencil.
  assert.equal(linkIn('Articles'), null, 'a bare directory listing must not carry an edit link');
});

test('the theme CSS ships as one concatenated sheet in layer order (style-src allows no second link)', async () => {
  await shared;
  const css = fs.readFileSync(findAsset('style.css'), 'utf8');
  for (const [a, b] of [
    [':root {', 'html {'],
    ['html {', '.site-header {'],
    ['.toc .lvl3 a {', '.children {'],
    ['code.sourceCode span.ot {', '.post-body .diagram {'],
    ['.mv-canvas {', '.search-dialog {'],
    ['@media (prefers-contrast: more) {', ''],
  ] as const) {
    const ia = css.indexOf(a);
    assert.ok(ia >= 0, `missing ${a}`);
    if (b) assert.ok(ia < css.indexOf(b), `${a} must come before ${b}`);
  }
  assert.ok(css.trimEnd().endsWith('}'), 'the sheet ends with the last utility block');
  for (const l of CSS_LAYERS) assert.ok(fs.statSync(path.join(REPO, `themes/default/css/${l}.css`)).size > 0, `${l}.css is empty`);
  // A stray .css file has no declared cascade position: refuse rather than guess.
  const brokenDir = tmpDir('blog-css-');
  fs.mkdirSync(path.join(brokenDir, 'css'));
  fs.writeFileSync(path.join(brokenDir, 'css/tokens.css'), ':root{}');
  fs.writeFileSync(path.join(brokenDir, 'css/stray.css'), ':root{}');
  assert.throws(() => themeCss(brokenDir), /not listed in CSS_LAYERS/);
});

test('every page ends in a footer region; the docs profile adds the author credit', async () => {
  await shared;
  await sharedDocs;
  const rootPages = ['index.html', 'archives/index.html', 'tags/index.html', '404.html', 'posts/12341234/index.html'];
  for (const rel of rootPages) {
    const html = fs.readFileSync(path.join(dist, rel), 'utf8');
    assert.ok(/<footer class="site-footer" data-region="footer">/.test(html), `${rel} is missing the footer region`);
    assert.ok(html.indexOf('</main>') < html.indexOf('<footer class="site-footer"'), `${rel}: the footer must follow the main content`);
    // The neutral profile: one linked © line carrying the theme mark, nothing else.
    assert.ok(
      /<a class="foot-copy" href="https:\/\/github\.com\/gogongxt\/noteflow" target="_blank" rel="noopener noreferrer"><img class="logo-mark"[\s\S]*© \d{4} my notes<\/a>/.test(html),
      `${rel}: the default © line should link this project as a whole`,
    );
    assert.ok(!html.includes('foot-by') && !html.includes('foot-icp') && !html.includes('Built with'), `${rel}: nothing else is configured`);
  }
  assert.ok(!fs.readFileSync(path.join(dist, 'index.html'), 'utf8').includes('repo-link'), 'the neutral header still has no repository icon');

  const docsHtml = fs.readFileSync(path.join(docsDist, 'index.html'), 'utf8');
  assert.ok(
    docsHtml.includes('<span class="foot-by">By <a class="foot-author" href="https://github.com/gogongxt" target="_blank" rel="noopener noreferrer">gogongxt</a></span>'),
    'the docs profile adds a linked author credit',
  );
  // The header and the footer share one hashed mark URL, so the icon is fetched once.
  const marks = [...docsHtml.matchAll(/<img class="logo-mark" src="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(marks.length, 2, `the header and footer should each mount the mark: ${marks.join(', ')}`);
  assert.equal(new Set(marks).size, 1, `the two marks must share one cached asset: ${marks.join(', ')}`);
  assert.ok(/^\/noteflow\/static\/img\/mark\.[0-9a-f]{8}\.png$/.test(marks[0]), `the docs mark must carry the base path: ${marks[0]}`);
  // Off-site footer links must satisfy the audit's policy, which the builds
  // above already ran; assert the markup so a regression fails here, too.
  for (const m of docsHtml.matchAll(/<footer[\s\S]*?<\/footer>/g)) {
    for (const a of m[0].matchAll(/<a\b[^>]*>/g)) {
      const tag = a[0];
      if (/href="https?:\/\//.test(tag) && !tag.includes('href="https://gogongxt.github.io')) {
        assert.ok(tag.includes('target="_blank"') && /rel="[^"]*noopener[^"]*noreferrer/.test(tag), `off-site footer link without the new-tab policy: ${tag}`);
      }
    }
  }
});

test('the frontmatter title always renders; a body H1 stays as the author wrote it', async () => {
  await shared;
  const body = fs.readFileSync(path.join(dist, 'posts/a1b2c3d4/index.html'), 'utf8');
  assert.ok(body.includes('<h1 class="post-title">Heading shapes</h1>'), 'the frontmatter title renders');
  assert.ok(body.includes('<h1>A body title</h1>'), 'the body H1 stays in the article');
  const toc = body.slice(body.indexOf('<nav class="toc"'));
  assert.ok(/<li class="lvl1"><a href="#a-body-title">/.test(toc), `the H1 is a rail entry: ${toc.slice(0, 200)}`);
  assert.ok(/<li class="lvl2"><a href="#after-the-title">/.test(toc), toc.slice(0, 300));
  assert.equal((body.match(/<section\b/g) ?? []).length, (body.match(/<\/section>/g) ?? []).length, 'section-divs output must stay balanced');

  // A body H1 that repeats the frontmatter title is the author's choice: both
  // render, and the rail keeps its entry.
  const dup = fs.readFileSync(path.join(dist, 'posts/d4c3b2a1/index.html'), 'utf8');
  assert.ok(dup.includes('<h1 class="post-title">Same as heading</h1>'), 'the frontmatter title renders');
  assert.ok(dup.includes('<h1>Same as heading</h1>'), 'the body H1 is kept as written');
  const dupToc = dup.slice(dup.indexOf('<nav class="toc"'));
  assert.ok(/#same-as-heading/.test(dupToc), `the rail lists the body H1: ${dupToc.slice(0, 200)}`);
  assert.equal((dup.match(/<section\b/g) ?? []).length, (dup.match(/<\/section>/g) ?? []).length, 'sections stay balanced');
});

test('nginx /assets/ types cover every publishable attachment type', async () => {
  const { ATTACHMENT_TYPES } = await import('../src/render/attachments.ts');
  const nginx = fs.readFileSync(path.join(REPO, 'deploy/nginx/noteflow.conf'), 'utf8');
  const block = nginx.match(/location \/assets\/ \{[\s\S]*?\n    \}/)?.[0] ?? '';
  const declared = new Set<string>();
  for (const line of block.matchAll(/^\s*([\w.+-]+\/[\w.+-]+)\s+([^;]+);/gm)) {
    for (const ext of line[2].trim().split(/\s+/)) declared.add(`${ext}:${line[1]}`);
  }
  for (const [ext, mime] of Object.entries(ATTACHMENT_TYPES)) {
    assert.ok(declared.has(`${ext}:${mime}`), `nginx /assets/ does not serve ${ext} as ${mime}`);
  }
});

test('CSP: one builder, identical across serve / gen-nginx / checked-in snippet', async () => {
  const { spawnSync } = await import('node:child_process');
  const { loadConfig } = await import('../src/core/config.ts');
  const { buildCsp, hashesOf } = await import('../src/core/csp.ts');
  // Pass the shared build's manifest explicitly: the repo-root default is
  // gitignored, so a fresh checkout (CI) has no .build-manifest.json.
  const sharedResult = await shared;
  const genOut = path.join(manifestDir, `snippet-${buildSeq++}.conf`);
  const r = spawnSync(process.execPath, ['src/cli/gen-nginx.ts', '--config', 'site.config.mjs', '--out', genOut, sharedResult.manifest], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0, `gen-nginx failed:\n${r.stderr}`);
  const gen = fs.readFileSync(genOut, 'utf8');
  const nginx = fs.readFileSync(path.join(REPO, 'deploy/nginx/noteflow.conf'), 'utf8');
  const cfg = await loadConfig(path.resolve(REPO, 'site.config.mjs'));
  // Independent expectation: frame-src must be exactly the comments widget
  // (when configured) plus the two video embed hosts — never 'none' (that
  // would break whichever is configured), never anything broader.
  const expectedFrames = [...(cfg.giscus ? ['https://giscus.app'] : []), 'https://player.bilibili.com', 'https://www.youtube-nocookie.com'];
  assert.match(gen, new RegExp(`frame-src ${expectedFrames.map((o) => o.replace(/[./]/g, '\\$&')).join(' ')};`), `frame-src must be ${expectedFrames.join(' ')}`);
  // gen-nginx's CSP must be exactly the shared builder's production output;
  // the preview server sends the same string minus upgrade-insecure-requests.
  const hashes = hashesOf(JSON.parse(fs.readFileSync(sharedResult.manifest, 'utf8')));
  const prod = buildCsp(hashes, cfg, true);
  assert.ok(gen.includes(`Content-Security-Policy "${prod}"`), 'gen-nginx CSP drifted from src/core/csp.ts');
  assert.equal(buildCsp(hashes, cfg), prod.replace(/; upgrade-insecure-requests$/, ''),
    'preview and production CSP must differ only by upgrade-insecure-requests');
  // serve.ts must go through the same builder (grep: importing it boots a server).
  const serve = fs.readFileSync(path.join(REPO, 'src/cli/serve.ts'), 'utf8');
  assert.ok(serve.includes('buildCsp('), 'serve.ts must build its CSP via src/core/csp.ts');
  // The checked-in snippet must be current. Hash values AND counts are
  // content-derived (inline styles in note bodies), so comparing them across
  // the demo build here and the real-content build that produced the snippet
  // would be unsound; collapse hash runs and compare the skeleton. Actual
  // hash freshness in the snippet is the release step's job.
  const hashless = (s: string): string =>
    s.replace(/'sha256-[^']*'/g, "'#'").replace(/'#'(?: '#')+/g, "'#'");
  const snippet = fs.readFileSync(path.join(REPO, 'deploy/nginx/snippets/security-headers.conf'), 'utf8');
  assert.equal(
    hashless(snippet.split('\n').slice(1).join('\n')),
    hashless(gen.split('\n').slice(1).join('\n')),
    'deploy/nginx/snippets/security-headers.conf is stale; run src/cli/gen-nginx.ts --out <file> <manifest> and commit the result',
  );
  assert.match(nginx, /location ~ \^\/posts\/\(\[\^\/\]\+\)\\\.html\$/, 'nginx is missing the 301 for old .html URLs');
});

test('gen-nginx fails closed without touching the output file', async () => {
  const { spawnSync } = await import('node:child_process');
  const refuse = (manifest: string, expect: RegExp) => {
    const out = path.join(manifestDir, `refused-${buildSeq++}.conf`);
    fs.writeFileSync(out, 'PREVIOUS\n');
    const r = spawnSync(process.execPath, ['src/cli/gen-nginx.ts', '--out', out, manifest], { cwd: REPO, encoding: 'utf8' });
    assert.notEqual(r.status, 0, `gen-nginx accepted ${path.basename(manifest)}`);
    assert.match(r.stderr, expect);
    assert.equal(fs.readFileSync(out, 'utf8'), 'PREVIOUS\n', 'a refused manifest must not touch the output file');
  };
  const noHashes = path.join(manifestDir, 'no-hashes.json');
  fs.writeFileSync(noHashes, JSON.stringify({ buildId: 'broken' }));
  refuse(noHashes, /no inline script hashes/);
  const skipAudit = path.join(manifestDir, 'skip-audit.json');
  fs.writeFileSync(skipAudit, JSON.stringify({ buildId: 'x', audited: false, csp: { inlineScriptHashes: ['sha256-abc='], inlineStyleHashes: [] } }));
  refuse(skipAudit, /--skip-audit/);
  const malformed = path.join(manifestDir, 'malformed.json');
  fs.writeFileSync(malformed, JSON.stringify({ buildId: 'x', csp: { inlineScriptHashes: ["'sha256-x='"] } }));
  refuse(malformed, /malformed CSP hash/);
});

// ---------------------------------------------------------------------------
// Base-path profiles (GitHub Pages sub-path deployment) + meta CSP
// ---------------------------------------------------------------------------
suite('base-path profile: every emitted URL carries the url pathname prefix', () => {
  const BASE = '/noteflow';
  let out: string;
  let result: BuildResult;
  let profile: string;

  before(async () => {
    out = tmpDir('blog-basedist-');
    profile = path.join(manifestDir, `profile-${buildSeq}.mjs`);
    fs.writeFileSync(
      profile,
      `export default { url: 'https://user.github.io${BASE}', siteName: 't', lang: 'en',` +
        ` contentDir: 'tests/fixtures/content', outDir: ${JSON.stringify(out)}, themeDir: 'themes/default',` +
        ` cacheDir: '.cache', manifestFile: 'unused.json', postPattern: '/posts/{abbrlink}',` +
        ` pageSize: { home: 5, feed: 5 }, cspMeta: true };\n`,
    );
    result = await runBuild(['--config', profile, '--out', out]);
  });

  test('builds and passes the audit under the prefix', () => {
    assert.equal(result.status, 0, result.stderr);
  });

  test('no internal URL leaks out without the base path', async () => {
    const htmlFiles = walkHtml(out);
    assert.ok(htmlFiles.length > 5, 'expected a full site');
    for (const f of htmlFiles) {
      const html = fs.readFileSync(f, 'utf8');
      const urls = [...html.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1]);
      for (const u of urls) {
        assert.ok(
          u === BASE + '/' || u.startsWith(BASE + '/'),
          `${path.relative(out, f)}: unprefixed internal URL ${u}`,
        );
      }
    }
  });

  test('every prefixed URL maps to a file in the unprefixed dist layout', async () => {
    const htmlFiles = walkHtml(out);
    for (const f of htmlFiles) {
      const html = fs.readFileSync(f, 'utf8');
      for (const m of html.matchAll(/(?:href|src)="\/noteflow\/([^"#?]*)"/g)) {
        // Tag dirs are URL-encoded at link time; the disk uses the raw name.
        let target: string;
        try {
          target = decodeURIComponent(m[1]).replace(/\/$/, '');
        } catch {
          target = m[1].replace(/\/$/, '');
        }
        if (!target) continue;
        assert.ok(
          fs.existsSync(path.join(out, target)) || fs.existsSync(path.join(out, target, 'index.html')),
          `dangling prefixed URL: /noteflow/${m[1]}`,
        );
      }
    }
  });

  test('posts still land at dist root, not under the base path', async () => {
    const posts = fs.readdirSync(path.join(out, 'posts'));
    assert.ok(posts.length >= 1);
    assert.ok(!fs.existsSync(path.join(out, 'noteflow')), 'the base path must not exist on disk');
  });

  test('meta CSP ships the same directive set, with the inline-script hashes', async () => {
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.ok(!html.includes('__NOTEFLOW_CSP__'), 'placeholder was not replaced');
    const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
    assert.ok(meta, 'cspMeta must inject the meta tag');
    assert.match(meta![1], /default-src 'self'/);
    assert.match(meta![1], /script-src 'self' 'sha256-/);
    assert.ok(!meta![1].includes('upgrade-insecure-requests'), 'meta keeps the plain-http preview loadable');
    // Root builds (the shared one) must not carry a meta CSP at all.
    await shared;
    const rootHome = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
    assert.ok(!rootHome.includes('http-equiv="Content-Security-Policy"'), 'cspMeta is opt-in');
  });

  test('feed, sitemap and canonical URLs carry the Pages origin + base path', async () => {
    const feed = fs.readFileSync(path.join(out, 'feed.xml'), 'utf8');
    assert.ok(feed.includes(`<link>https://user.github.io${BASE}/</link>`), 'feed home link');
    assert.match(feed, /<link>https:\/\/user\.github\.io\/noteflow\/posts\/[0-9a-f]{8}<\/link>/);
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.match(html, /<link rel="canonical" href="https:\/\/user\.github\.io\/noteflow\/">/);
    const sitemap = fs.readFileSync(path.join(out, 'sitemap.xml'), 'utf8');
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    assert.ok(locs.length > 5, 'expected every public page in the sitemap');
    assert.ok(locs.every((l) => l.startsWith(`https://user.github.io${BASE}/`)), 'every loc carries the base path');
    assert.ok(fs.readFileSync(path.join(out, 'robots.txt'), 'utf8').includes(`Sitemap: https://user.github.io${BASE}/sitemap.xml`));
  });

  function walkHtml(dir: string): string[] {
    const acc: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.html')) acc.push(p);
      }
    };
    walk(dir);
    return acc;
  }
});
