import { test, after } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { injectAbbrlink, parseNote, readAbbrlink, splitSource } from '../src/content/frontmatter.ts';
import { computeAbbrlink, computeIndexAbbrlink, rawDateString } from '../src/content/abbrlink.ts';
import { crc32Hex, datePart } from '../src/core/util.ts';
import { sanitize } from '../src/render/sanitize.ts';
import { postprocess } from '../src/render/postprocess.ts';
import { scanTree, assertReserved, collectNodes, assertNoCaseCollision } from '../src/content/scan.ts';
import { resolveTree } from '../src/content/visibility.ts';
import { makeAssetNamer, resolveAsset } from '../src/render/attachments.ts';
import { extractMermaid, figureHtml, mergeDiagramCss } from '../src/render/mermaid.ts';
import type { RenderedDiagram } from '../src/render/mermaid.ts';
import { cleanupTmpDirs, tmpDir, writeFile, PNG } from './helpers.ts';

after(() => cleanupTmpDirs());

test('crc32 matches Python zlib.crc32', () => {
  assert.equal(crc32Hex('测试标题|2026-11-12'), '3b41732c');
  assert.equal(crc32Hex(''), '00000000');
});

test('abbrlink uses the date part only; empty when absent', () => {
  assert.equal(computeAbbrlink('t', '2026-11-12T10:30:00+08:00'), crc32Hex('t|2026-11-12'));
  assert.equal(computeAbbrlink('t', null), crc32Hex('t|'));
  assert.equal(datePart('2026-11-12T10:00:00+08:00'), '2026-11-12');
});

test('index-page abbrlink carries the index| prefix to avoid colliding with notes', () => {
  assert.notEqual(computeIndexAbbrlink('a'), computeAbbrlink('index|a', null));
  assert.equal(computeIndexAbbrlink('a'), crc32Hex('index|a'));
});

test('raw date string comes from frontmatter, not body', () => {
  const raw = '---\ndate: 2026-11-12T10:30:00+08:00\n---\n正文里有 date: 1999-01-01\n';
  const { yaml } = splitSource(raw);
  const { data } = parseNote(raw);
  assert.equal(rawDateString(yaml, data!), '2026-11-12T10:30:00+08:00');
});

const writeCases: Record<string, { raw: string; expect: RegExp }> = {
  normal: { raw: '---\ntitle: x\ndate: 2026-11-12\n---\n\n正文\n', expect: /title: x\ndate: 2026-11-12\nabbrlink: "abcd1234"\n---\n/ },
  crlf: { raw: '---\r\ntitle: x\r\n---\r\n\r\n正文\r\n', expect: /title: x\r\nabbrlink: "abcd1234"\r\n---\r\n/ },
  empty: { raw: '---\n---\n正文\n', expect: /^---\nabbrlink: "abcd1234"\n---\n正文\n$/ },
  dots: { raw: '---\ntitle: x\n...\n正文\n', expect: /title: x\nabbrlink: "abcd1234"\n\.\.\.\n正文/ },
  bom: { raw: '﻿---\ntitle: x\n---\n正文\n', expect: /^﻿---\ntitle: x\nabbrlink: "abcd1234"\n---\n/ },
};

for (const [name, { raw, expect }] of Object.entries(writeCases)) {
  test(`abbrlink write-back: ${name}`, () => {
    const out = injectAbbrlink(raw, 'abcd1234');
    assert.match(out, expect);
    const before = parseNote(raw).content;
    const after = parseNote(out);
    assert.equal(after.error, null);
    assert.equal(after.data?.abbrlink, 'abcd1234');
    assert.equal(after.content, before, 'body must stay byte-identical with no frontmatter mixed in');
  });
}

test('write-back: purely numeric abbrlink is quoted so YAML keeps the value', () => {
  const out = injectAbbrlink('---\ntitle: x\n---\n', '12345678');
  assert.match(out, /abbrlink: "12345678"/);
  assert.equal(parseNote(out).data?.abbrlink, '12345678');
  assert.equal(parseNote('---\nabbrlink: 12345678\n---\n').data?.abbrlink, 12345678);
});

test('write-back: unknown fields and key order are preserved', () => {
  const raw = '---\nz: 1\ntitle: x\ncustom: {a: 1}\n---\nbody';
  const out = injectAbbrlink(raw, 'deadbeef');
  assert.ok(out.startsWith('---\nz: 1\ntitle: x\ncustom: {a: 1}\nabbrlink: "deadbeef"\n---\nbody'));
});

const INJECTIONS = [
  '<script>alert(1)</script>',
  '<iframe src="file:///etc/passwd"></iframe>',
  '<style>body{display:none}</style>',
  '<img src="x.png" onerror="alert(1)">',
  '<img src="//evil.example/pixel.png">',
  '<span onmouseover="x()">s</span>',
  '<a href="javascript:alert(1)">j</a>',
  '<a href="JaVaScRiPt:alert(1)">j2</a>',
  '<a href="java\nscript:alert(1)">j3</a>',
  '<a href="//evil.com">e</a>',
  '<a href="data:text/html,<script>alert(1)</script>">d</a>',
  '<div onclick="steal()">div</div>',
  '<span style="background-image:url(https://evil)">s</span>',
  '<span style="width:expression(alert(1))">s</span>',
  '<img src="data:image/svg+xml,<svg onload=alert(1)>">',
  '<math><maction actiontype="statusline" xlink:href="javascript:alert(1)">x</maction></math>',
  '<input type="text" value="x">',
  '<object data="x"></object>',
  '<embed src="x">',
];

for (const html of INJECTIONS) {
  test(`injection blocked: ${html.slice(0, 50)}`, () => {
    const out = sanitize(html);
    assert.ok(!/<script|<iframe|<style|<object|<embed/i.test(out), `dangerous tag left behind: ${out}`);
    assert.ok(!/\son[a-z]+=/i.test(out), `event handler attribute left behind: ${out}`);
    assert.ok(!/javascript:|data:text\/html|data:image\/svg/i.test(out), `dangerous scheme left behind: ${out}`);
    assert.ok(!/expression\(|url\(/i.test(out), `dangerous style left behind: ${out}`);
    assert.ok(!/protocol|evil\.com"\s*href|^<a href="\/\//i.test(out), `protocol-relative link left behind: ${out}`);
  });
}

test('preservation regression: rich text, MathML, task lists, code highlighting, callouts', () => {
  const input =
    '<p><b>粗</b><br><span style="color:red">红</span></p>' +
    '<math display="inline" xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mi>x</mi><annotation encoding="application/x-tex">x</annotation></semantics></math>' +
    '<section id="中文" class="level2"><h2>中文</h2></section>' +
    '<ul class="task-list"><li><label><input type="checkbox" checked="" />done</label></li></ul>' +
    '<div class="sourceCode" id="cb1"><pre class="sourceCode js"><code class="sourceCode javascript"><span class="kw">const</span> <span class="op">=</span></code></pre></div>' +
    '<div class="callout" data-note="提示"><p>hi</p></div>' +
    '<figure><img src="/a.png"><figcaption>c</figcaption></figure>' +
    '<table><thead><tr><th style="text-align: left">a</th></tr></thead></table>' +
    '<del>d</del><sup>2</sup><sub>x</sub><kbd>K</kbd><mark>m</mark><details><summary>s</summary>b</details>';
  const out = sanitize(input);
  for (const frag of [
    '<b>粗</b>',
    '<br />',
    'style="color:red"',
    '<math display="inline" xmlns="http://www.w3.org/1998/Math/MathML">',
    'encoding="application/x-tex"',
    '<section id="中文" class="level2">',
    'type="checkbox"',
    'class="kw"',
    'class="op"',
    'class="callout" data-note="提示"',
    '<figure>',
    '<figcaption>',
    'style="text-align:left"',
    '<del>d</del>',
    '<kbd>K</kbd>',
    '<mark>m</mark>',
    '<details>',
    '<summary>s</summary>',
  ]) {
    assert.ok(out.includes(frag), `lost ${frag}; output: ${out}`);
  }
});

test('preservation regression: all skylighting classes are whitelisted', () => {
  const kate = ['alert', 'annotation', 'at', 'bn', 'bu', 'cf', 'ch', 'cn', 'co', 'cv', 'do', 'dt', 'dv', 'er', 'ex', 'fl', 'fu', 'im', 'in', 'kw', 'op', 'ot', 'pp', 'sc', 'ss', 'st', 'va', 'vs', 'wa'];
  const html = '<pre class="sourceCode"><code>' + kate.map((c) => `<span class="${c}">x</span>`).join('') + '</code></pre>';
  const out = sanitize(html);
  for (const c of kate) assert.ok(out.includes(`class="${c}"`), `highlight class lost: ${c}`);
});

test('custom classes on headings are preserved (the syntax guide promises {.accent} works)', () => {
  const out = sanitize('<section id="my-anchor" class="level2 accent"><h2 class="accent">带自定义锚点的标题</h2></section>');
  assert.ok(out.includes('class="level2 accent"'), `accent on section lost: ${out}`);
  assert.ok(out.includes('<h2 class="accent">'), `accent on h2 lost: ${out}`);
});

test('heading custom classes do not let non-whitelisted classes through', () => {
  const out = sanitize('<h2 class="accent evil" style="color:red">x</h2>');
  assert.ok(out.includes('class="accent"'), out);
  assert.ok(!out.includes('evil'), `non-whitelisted class should be dropped: ${out}`);
});

test('allowedStyles must be keyed by selector (an attribute-name key means no filtering)', async () => {
  const { SANITIZE_OPTIONS } = await import('../src/render/sanitize.ts');
  assert.ok('*' in SANITIZE_OPTIONS.allowedStyles);
  assert.ok(!('color' in SANITIZE_OPTIONS.allowedStyles));
});

test('parseArgs: boolean flags never consume a positional as their value', async () => {
  const { parseArgs } = await import('../src/core/util.ts');
  const a = parseArgs(['--check', 'notes', 'positional', '--content', 'x', '--no-mermaid', '--check']);
  assert.equal(a.check, true, '--check must stay boolean even followed by a positional');
  assert.deepEqual(a._, ['notes', 'positional']);
  assert.equal(a.content, 'x');
  assert.equal(a.mermaid, false, '--no-X must rewrite to X=false');
});

test('parseArgs: --flag=value inline form', async () => {
  const { parseArgs } = await import('../src/core/util.ts');
  const a = parseArgs(['--out=dist2', '--check']);
  assert.equal(a.out, 'dist2');
  assert.equal(a.check, true);
});

test('frontmatter: a leading --- thematic break is not a frontmatter block', async () => {
  const { parseNote } = await import('../src/content/frontmatter.ts');
  const raw = '---\n\nHello\n\nworld\n\n---\n\nMore prose';
  const r = parseNote(raw);
  assert.equal(r.error, null);
  assert.equal(r.content, raw, 'body must stay byte-identical, not swallowed as YAML');
  assert.equal(r.data?.title, undefined);
});

test('frontmatter: YAML with internal blank lines still parses', async () => {
  const { parseNote } = await import('../src/content/frontmatter.ts');
  const r = parseNote('---\ntitle: x\n\nabbrlink: "aabbccdd"\n---\nbody');
  assert.equal(r.error, null);
  assert.equal(r.data?.abbrlink, 'aabbccdd');
});

test('abbrlink write-back: an existing EMPTY abbrlink field is replaced, not refused', () => {
  const out = injectAbbrlink('---\ntitle: x\nabbrlink:\n---\nbody', 'abcd1234');
  assert.match(out, /abbrlink: "abcd1234"/);
  assert.equal(parseNote(out).data?.abbrlink, 'abcd1234');
  const out2 = injectAbbrlink('---\ntitle: x\nabbrlink: ""\n---\nbody', 'abcd1234');
  assert.match(out2, /abbrlink: "abcd1234"/);
  assert.equal(parseNote(out2).data?.abbrlink, 'abcd1234');
});

test('abbrlink write-back: a read-only content dir fails with an actionable error, not a raw EROFS', async () => {
  const { writeAbbrlinks } = await import('../src/content/abbrlink.ts');
  const dir = tmpDir('abbr-ro-');
  const file = path.join(dir, 'ro', 'note.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '---\ntitle: x\n---\n');
  // Stubbing fs is more portable than chmod (root and overlayfs ignore modes).
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = ((p: string, ...rest: unknown[]) => {
    if (String(p).endsWith('note.md.tmp')) throw Object.assign(new Error('EROFS'), { code: 'EROFS' });
    return (realWrite as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.writeFileSync;
  try {
    assert.throws(() => writeAbbrlinks([{ path: file, text: 'x' }]), /content directory must be writable/);
  } finally {
    fs.writeFileSync = realWrite;
  }
});

test('sanitize: whitelisted data:image URIs survive (the img transform must not be dead code)', () => {
  const out = sanitize('<img src="data:image/png;base64,iVBORw0KGgo=" alt="i">');
  assert.ok(out.includes('src="data:image/png;base64,'), `data: image src was dropped: ${out}`);
  const bad = sanitize('<img src="data:image/svg+xml,<svg onload=alert(1)>">');
  assert.ok(!bad.includes('src="data:image/svg'), `svg data: URI must stay blocked: ${bad}`);
});

test('sanitize: pandoc width style on img survives the style whitelist', () => {
  const out = sanitize('<img src="a.png" style="width:50.0%">');
  assert.ok(/width:\s*50(\.0+)?%/.test(out), `img width style was dropped: ${out}`);
  const bad = sanitize('<img src="a.png" style="width:expression(alert(1))">');
  assert.ok(!/expression/i.test(bad), `dangerous width value passed: ${bad}`);
});

test('encodePath: a literal % in a filename stays encoded (no %25→% un-escape)', async () => {
  const { encodePath } = await import('../src/core/util.ts');
  assert.equal(encodePath('a/50%.png'), 'a/50%25.png');
});

// One shared fixture root with the few attachments pp() cases reference.
const PP_ROOT = tmpDir();
writeFile(PP_ROOT, '技术笔记/img/demo.png', PNG);
writeFile(PP_ROOT, '技术笔记/img/a.png', PNG);
for (const n of ['b', 'c']) writeFile(PP_ROOT, `技术笔记/img/${n}.png`, PNG);
writeFile(PP_ROOT, '私人/img/secret.png', PNG);
writeFile(PP_ROOT, '技术笔记/媒体/clip.mp4', Buffer.from('fake mp4'));
writeFile(PP_ROOT, '技术笔记/媒体/cover.png', PNG);
writeFile(PP_ROOT, '技术笔记/媒体/song.mp3', Buffer.from('fake mp3'));
writeFile(PP_ROOT, '技术笔记/媒体/subs.vtt', 'WEBVTT\n');
writeFile(PP_ROOT, '私人/媒体/secret.mp4', Buffer.from('private mp4'));

function pp(html: string, overrides = {}) {
  const broken: unknown[] = [];
  const assets = makeAssetNamer(fs.realpathSync(PP_ROOT));
  const ctx = {
    // relDirOf(pageRelPath) is the resolution base for the relative-link
    // fixtures below — the directory part is functional, not cosmetic.
    pageRelPath: '技术笔记/语法测试.md',
    siteHost: 'example.com',
    basePath: '',
    contentRoot: '/',
    urlMap: new Map([
      ['技术笔记/Kubernetes/架构', '/posts/aaa'],
      ['README', '/posts/bbb'],
    ]),
    assets: { add: ({ srcRel }: { srcRel: string }) => assets.assign('p1', srcRel) },
    isPublicAsset: (rel: string) => !rel.startsWith('私人/'),
    isPrivatePage: (rel: string) => rel === '私人/日记',
    onBroken: (b: unknown) => broken.push(b),
    ...overrides,
  };
  const r = postprocess(html, ctx as never);
  return { html: r.html, toc: r.toc, broken };
}

test('link rewriting: relative .md → /posts/xxx (extensionless), anchor preserved', () => {
  const { html, broken } = pp('<a href="./Kubernetes/%E6%9E%B6%E6%9E%84.md#控制平面">x</a>');
  assert.equal(broken.length, 0);
  assert.ok(html.includes('href="/posts/aaa#%E6%8E%A7%E5%88%B6%E5%B9%B3%E9%9D%A2"'), html);
});

test('media: local <video>/<audio>/<source>/<track> sources and posters get hashed /assets/ URLs', () => {
  const { html, broken } = pp(
    '<video controls src="./媒体/clip.mp4" poster="./媒体/cover.png"><source src="./媒体/clip.mp4" type="video/mp4"><track src="./媒体/subs.vtt" kind="captions"></video>' +
      '<audio controls src="./媒体/song.mp3"></audio>',
  );
  assert.equal(broken.length, 0, JSON.stringify(broken));
  assert.match(html, /<video controls="?"[^>]* src="\/assets\/p1\/clip\.[0-9a-f]{8}\.mp4"/, html);
  assert.match(html, /poster="\/assets\/p1\/cover\.[0-9a-f]{8}\.png"/, html);
  assert.match(html, /<source src="\/assets\/p1\/clip\.[0-9a-f]{8}\.mp4" type="video\/mp4"/, html);
  assert.match(html, /<track src="\/assets\/p1\/subs\.[0-9a-f]{8}\.vtt"/, html);
  assert.match(html, /<audio controls="?"[^>]* src="\/assets\/p1\/song\.[0-9a-f]{8}\.mp3"/, html);
  assert.match(html, /preload="metadata"/, 'video gets a metadata preload when the author gave none');
});

test('media: a private attachment fails closed like an image', () => {
  const { html } = pp('<video controls src="./../私人/媒体/secret.mp4"></video>');
  assert.ok(html.includes('(media not public)'), html);
  assert.ok(!html.includes('secret.mp4'), html);
});

test('media: an off-site src fails the build (media-src blocks it); an off-site poster stays', () => {
  const bad = pp('<video controls src="https://cdn.example.com/x.mp4"></video>');
  assert.equal(bad.broken.length, 1, JSON.stringify(bad.broken));
  assert.match(String((bad.broken[0] as { msg: string }).msg), /off-site/);

  // A poster is an image (img-src allows https:) and a local one is rewritten.
  const ok = pp('<video controls src="./媒体/clip.mp4" poster="https://cdn.example.com/p.jpg"></video>');
  assert.equal(ok.broken.length, 0, JSON.stringify(ok.broken));
  assert.ok(ok.html.includes('poster="https://cdn.example.com/p.jpg"'), ok.html);
});

test('embed: a sole YouTube/Bilibili link becomes a sandbox-free provider iframe', async () => {
  const { parseEmbed } = await import('../src/render/embeds.ts');
  assert.equal(parseEmbed('https://youtu.be/KLuTLF3x9sA')?.src, 'https://www.youtube-nocookie.com/embed/KLuTLF3x9sA?rel=0');
  assert.equal(parseEmbed('https://www.youtube.com/watch?v=KLuTLF3x9sA&t=42')?.src, 'https://www.youtube-nocookie.com/embed/KLuTLF3x9sA?rel=0&start=42');
  assert.match(
    parseEmbed('https://www.bilibili.com/video/BV1j4411W7F7')?.src ?? '',
    /^https:\/\/player\.bilibili\.com\/player\.html\?bvid=BV1j4411W7F7&autoplay=0/,
    'autoplay=0 must be explicit: Bilibili autoplays when it is absent',
  );
  // Not a video page, a lookalike host, or a non-web scheme: stay a plain link.
  for (const href of ['https://www.youtube.com/', 'https://evil.example/youtu.be/x', 'javascript:alert(1)', 'https://youtu.be/short']) {
    assert.equal(parseEmbed(href), null, href);
  }

  const { html, broken } = pp('<p><a href="https://www.bilibili.com/video/BV1j4411W7F7" class="embed">看</a></p>');
  assert.equal(broken.length, 0, JSON.stringify(broken));
  assert.ok(html.includes('<div class="embed" data-embed="bilibili">'), html);
  assert.ok(/<iframe[^>]+src="https:\/\/player\.bilibili\.com\/[^"]+"/.test(html), html);
  assert.ok(!/sandbox=/.test(html), 'Bilibili needs a non-sandboxed frame');
  assert.ok(!/allow="[^"]*autoplay/.test(html), 'the frame must not be granted autoplay');
  assert.ok(/<a class="embed-fallback"[^>]+target="_blank"/.test(html), 'the fallback link opens a new tab');
});

test('embed: a link inside a paragraph of prose is not turned into a frame', () => {
  const { html } = pp('<p>看看这个 <a href="https://youtu.be/KLuTLF3x9sA" class="embed">视频</a> 很有意思</p>');
  assert.ok(!html.includes('<iframe'), html);
});

test('sanitize: media keeps only passive attributes; autoplay/crossorigin/on* are dropped', () => {
  const out = sanitize(
    '<video controls autoplay crossorigin onerror="alert(1)" src="a.mp4" poster="p.png" width="640">' +
      '<track src="s.vtt" kind="captions" label="中文字幕" default></video>' +
      '<audio controls src="javascript:alert(1)"></audio>',
  );
  assert.ok(out.includes('controls'), out);
  assert.ok(out.includes('width="640"'), out);
  assert.ok(!/autoplay|crossorigin|onerror/.test(out), out);
  assert.ok(out.includes('label="中文字幕"') && out.includes('default'), out);
  assert.ok(!out.includes('javascript:'), out);
});

test('display math: wrapped in .equation with per-page (n) counter; inline math untouched', () => {
  const M = 'xmlns="http://www.w3.org/1998/Math/MathML"';
  const { html } = pp(
    `<p>inline <math ${M}><mi>x</mi></math> stays</p>` +
      `<p>alone <math display="block" ${M}><mi>a</mi></math></p>` +
      `<ul><li>text <math display="block" ${M}><mi>b</mi></math></li></ul>`,
  );
  assert.equal((html.match(/class="equation"/g) || []).length, 2, html);
  assert.ok(html.includes('class="eq-no">(1)</span>'), html);
  assert.ok(html.includes('class="eq-no">(2)</span>'), html);
  assert.ok(!/<span class="equation"><math [^>]*><mi>x/.test(html), html);
});

test('math labels and refs: \\label gives the equation an id, \\ref/\\eqref link to it', () => {
  const M = 'xmlns="http://www.w3.org/1998/Math/MathML"';
  const eq = (tex: string) =>
    `<p><math display="block" ${M}><semantics><mi>a</mi><annotation encoding="application/x-tex">${tex}</annotation></semantics></math></p>`;
  // The span shape is what pandoc emits when texmath rejects \ref.
  const { html, broken } = pp(
    `<p>see <span class="math inline">$\\ref{area}$</span> and <span class="math inline">$\\eqref{area}$</span></p>` +
      eq('A = \\pi r^2 \\label{area}'),
  );
  assert.equal(broken.length, 0, JSON.stringify(broken));
  assert.ok(html.includes('<span class="equation" id="eq-area">'), html);
  assert.ok(html.includes('<a class="eq-ref" href="#eq-area">1</a>'), html);
  assert.ok(html.includes('<a class="eq-ref" href="#eq-area">(1)</a>'), html);
  assert.ok(!html.includes('\\ref'), 'raw TeX must not survive: ' + html);
});

test('math refs are fail-closed: missing target, duplicate label, unparsable formula', () => {
  const M = 'xmlns="http://www.w3.org/1998/Math/MathML"';
  const eq = (tex: string) =>
    `<p><math display="block" ${M}><semantics><mi>a</mi><annotation encoding="application/x-tex">${tex}</annotation></semantics></math></p>`;

  const missing = pp('<p><span class="math inline">$\\ref{nope}$</span></p>');
  assert.equal(missing.broken.length, 1, JSON.stringify(missing.broken));
  assert.match(String((missing.broken[0] as { msg: string }).msg), /not found/);
  assert.ok(!missing.html.includes('nope'), missing.html);

  const dup = pp(eq('a \\label{d}') + eq('b \\label{d}'));
  assert.equal(dup.broken.length, 1, JSON.stringify(dup.broken));
  assert.match(String((dup.broken[0] as { msg: string }).msg), /duplicate/);

  // pandoc leaves the whole formula unparsed when \ref sits next to real math.
  const mixed = pp('<p><span class="math inline">$x = \\ref{d}$</span></p>' + eq('a \\label{d}'));
  assert.equal(mixed.broken.length, 1, JSON.stringify(mixed.broken));
  assert.match(String((mixed.broken[0] as { msg: string }).msg), /cannot parse/);

  const bad = pp(eq('a \\label{中文}'));
  assert.equal(bad.broken.length, 1, JSON.stringify(bad.broken));
  assert.match(String((bad.broken[0] as { msg: string }).msg), /invalid/);

  // Two labels on one equation resolve to a single id; refuse to guess.
  const twoLabels = pp(eq('a \\label{p} \\label{q}'));
  assert.equal(twoLabels.broken.length, 1, JSON.stringify(twoLabels.broken));
  assert.match(String((twoLabels.broken[0] as { msg: string }).msg), /several/);

  // \tag overrides the displayed number without advancing the counter (amsmath).
  const tag = pp(eq('a \\tag{7}') + eq('b') + '<p><span class="math inline">$\\eqref{t}$</span></p>' + eq('c \\tag{9} \\label{t}'));
  assert.equal(tag.broken.length, 0, JSON.stringify(tag.broken));
  assert.ok(tag.html.includes('class="eq-no">(7)</span>'), tag.html);
  assert.ok(tag.html.includes('class="eq-no">(2)</span>'), 'counter still advances past a tag: ' + tag.html);
  assert.ok(tag.html.includes('<a class="eq-ref" href="#eq-t">(9)</a>'), 'ref shows the tagged number: ' + tag.html);

  // Tag content the build cannot faithfully display must not be guessed at.
  const badTag = pp(eq('a \\tag{\\alpha}'));
  assert.equal(badTag.broken.length, 1, JSON.stringify(badTag.broken));
  assert.match(String((badTag.broken[0] as { msg: string }).msg), /unsupported/);

  // \ref left as literal text: pandoc read `$ \ref{a} $` as prose.
  const prose = pp('<p>see $ \\ref{d} $</p>');
  assert.equal(prose.broken.length, 1, JSON.stringify(prose.broken));
  assert.match(String((prose.broken[0] as { msg: string }).msg), /unrendered/);

  // The same string inside a fence is sample source and must not abort.
  const sample = pp('<pre><code>see $ \\ref{d} $</code></pre>');
  assert.equal(sample.broken.length, 0, JSON.stringify(sample.broken));

  // Literal prose about \href is not a stray \ref.
  const href = pp('<p>write &lt;\\href{https://x}&gt; here</p>');
  assert.equal(href.broken.length, 0, JSON.stringify(href.broken));
});

test('code blocks: every pre ships chrome; a hand-written div.sourceCode keeps its other children', () => {
  const { html } = pp(
    '<pre><code>plain</code></pre>' +
      '<div class="sourceCode"><pre class="js"><code>x</code></pre><p>note</p></div>',
  );
  // language-less: plain card, no head bar, icon-only corner copy
  assert.ok(html.includes('<div class="sourceCode code-plain"><div class="code-wrap"><button class="code-copy"'), html);
  const plain = html.slice(0, html.indexOf('</pre></div></div>'));
  assert.ok(!plain.includes('code-head'), html);
  assert.ok(!plain.includes('code-lang'), html);
  // with a language: head bar with the label
  assert.ok(html.includes('<span class="code-lang">js</span>'), html);
  assert.ok(/<\/pre><\/div><p>note<\/p><\/div>/.test(html), `sibling lost: ${html}`);

  // A fence title becomes a centered header; pandoc puts it on the <pre> for
  // an unhighlighted block and on the sourceCode div when highlighting.
  const plainTitle = pp('<pre class="ts" title="sort.ts"><code>x</code></pre>');
  assert.ok(plainTitle.html.includes('<span class="code-title">sort.ts</span><span class="code-lang">ts</span>'), plainTitle.html);
  assert.ok(!plainTitle.html.includes('title="sort.ts"'), 'the consumed title must not linger as a tooltip');
  const boxed = pp('<div class="sourceCode" title="app.ts"><pre class="ts"><code>x</code></pre></div>');
  assert.ok(boxed.html.includes('<span class="code-title">app.ts</span>'), boxed.html);
  assert.ok(!boxed.html.includes('title="app.ts"'), boxed.html);
  // Title without a language still earns a head bar (not a plain card).
  const titleOnly = pp('<pre title="notes"><code>x</code></pre>');
  assert.ok(titleOnly.html.includes('code-head') && !titleOnly.html.includes('code-plain'), titleOnly.html);
});

test('code blocks: only a long block ships the fold bar; the count is of rendered lines', () => {
  const fence = (n: number): string =>
    '<pre class="js"><code>' + Array.from({ length: n }, (_, i) => `line ${i}\n`).join('') + '</code></pre>';
  // The threshold in src/render/code-blocks.ts is 36 lines.
  assert.ok(!pp(fence(35)).html.includes('code-fold-bar'), '35 lines stay whole');
  const long = pp(fence(36)).html;
  assert.ok(long.includes('class="sourceCode code-fold"'), long);
  assert.ok(long.includes('<span class="code-fold-more">Show all 36 lines</span>'), long);
  // The toggle ships collapsed and with the full count already baked in.
  assert.match(long, /<button class="code-fold-btn" type="button" aria-expanded="false">/, long);
  assert.ok(!long.includes('is-expanded'), 'the folded state is the markup default');

  // Per-line highlight spans must not inflate the count: the newlines live in
  // the text between them, so 40 wrapped lines still read as 40.
  const highlighted = pp('<pre class="js"><code>' +
    Array.from({ length: 40 }, (_, i) => `<span id="cb${i}"><a href="#cb${i}"></a>x${i}</span>`).join('\n') +
    '</code></pre>').html;
  assert.ok(highlighted.includes('Show all 40 lines'), highlighted);
});

test('link rewriting: private target → plain text "(page not public)"', () => {
  const { html } = pp('<a href="../私人/日记.md">私密</a>');
  assert.ok(!/<a /.test(html), html);
  assert.ok(html.includes('(page not public)'));
  assert.ok(!html.includes('私密'), html);
});

test('link rewriting: missing target → build-failure callback (no silent keep)', () => {
  const { broken } = pp('<a href="./不存在.md">x</a>');
  assert.equal(broken.length, 1);
});

test('link rewriting: directory → index page; escaping the root → failure', () => {
  const { html } = pp('<a href="./Docker/">d</a>', {
    urlMap: new Map([['技术笔记/Docker', '/posts/idx.html']]),
    dirIndexHref: (r: string) => (r === '技术笔记/Docker' ? '/posts/idx.html' : null),
  });
  assert.ok(html.includes('href="/posts/idx.html"'), html);
  const out = pp('<a href="../../../越界.md">x</a>');
  assert.equal(out.broken.length, 1);
});

test('images: public → root-absolute /assets/<abbrlink>/; private → text', () => {
  const { html } = pp('<img src="./img/demo.png"><img src="../私人/img/secret.png">');
  assert.match(html, /src="\/assets\/p1\/demo\.[0-9a-f]{8}\.png"/, html);
  assert.ok(html.includes('(image not public)'), html);
  assert.ok(!html.includes('secret.png'), html);
});

test('link policy: external URLs open a new tab, keeping the author href and rel', () => {
  const { html, broken } = pp(
    '<a href="https://x.com/a">1</a><a href="https://x.com/b" rel="nofollow">2</a>' +
      '<a href="https://example.com/posts/aaa">same host</a>' +
      '<a href="http://example.com/posts/bbb">same host, other scheme</a>' +
      '<a href="ftp://mirror.example.net/x">ftp</a>',
  );
  assert.equal(broken.length, 0);
  assert.ok(html.includes('<a href="https://x.com/a" target="_blank" rel="noopener noreferrer">'), html);
  // The author's rel tokens survive and gain ours.
  assert.ok(html.includes('<a href="https://x.com/b" rel="nofollow noopener noreferrer" target="_blank">'), html);
  assert.ok(html.includes('<a href="ftp://mirror.example.net/x" target="_blank" rel="noopener noreferrer">'), html);
  // The site's own host is navigation whatever the scheme.
  assert.ok(html.includes('<a href="https://example.com/posts/aaa">same host</a>'), html);
  assert.ok(html.includes('<a href="http://example.com/posts/bbb">same host, other scheme</a>'), html);
});

test('link policy: page navigation and in-page jumps stay in the current tab', () => {
  const { html } = pp(
    '<a href="./Kubernetes/架构.md">page</a><a href="#标题">anchor</a><a href="mailto:a@b.c">mail</a>',
  );
  assert.ok(html.includes('<a href="/posts/aaa">page</a>'), html);
  assert.ok(html.includes('<a href="#标题">anchor</a>'), html);
  assert.ok(html.includes('<a href="mailto:a@b.c">mail</a>'), html);
  assert.ok(!html.includes('target='), html);
});

test('link policy: a hand-written root-absolute /assets/ link is a download too; code blocks are untouched', () => {
  const { html } = pp(
    '<p><a href="/assets/abc/manual.pdf">dl</a></p>' +
      '<pre><code>&lt;a href="https://x.com/a"&gt;x&lt;/a&gt;</code></pre>',
  );
  assert.ok(html.includes('<a href="/assets/abc/manual.pdf" target="_blank" rel="noopener noreferrer">'), html);
  // Quoted markup inside a code block is never rewritten.
  assert.ok(!/https:\/\/x\.com\/a"[^>]*target=/.test(html), html);
});

test('link policy: an attachment download opens a new tab', () => {
  writeFile(PP_ROOT, '技术笔记/附件/手册.pdf', Buffer.from('%PDF'));
  const { html, broken } = pp('<a href="./附件/手册.pdf">pdf</a>');
  assert.equal(broken.length, 0, JSON.stringify(broken));
  assert.match(html, /href="\/assets\/p1\/[^"]+\.[0-9a-f]{8}\.pdf" target="_blank" rel="noopener noreferrer"/, html);
});

test('base path: hand-written root-absolute links/srcs carry the prefix, raw form preserved', () => {
  const { html } = pp(
    '<p><a href="/assets/p1/%E6%89%8B%E5%86%8C.pdf?v=2#x">pdf</a></p><video src="/assets/p1/clip.mp4"></video>',
    { basePath: '/noteflow' },
  );
  assert.ok(html.includes('href="/noteflow/assets/p1/%E6%89%8B%E5%86%8C.pdf?v=2#x"'), html);
  assert.ok(html.includes('src="/noteflow/assets/p1/clip.mp4"'), html);
  assert.ok(html.includes('target="_blank"'), 'a download keeps opening a new tab');
});

test('base path: no prefix leaves hand-written root-absolute URLs untouched', () => {
  const { html } = pp('<p><a href="/assets/p1/%E6%89%8B%E5%86%8C.pdf">pdf</a></p>');
  assert.ok(html.includes('href="/assets/p1/%E6%89%8B%E5%86%8C.pdf"'), html);
});

test('TOC extraction: id from the section, math subtree excluded from text', () => {
  const { toc } = pp(
    '<section id="内联-x-标题" class="level2"><h2>内联 <math><mi>x</mi><annotation encoding="application/x-tex">x</annotation></math> 标题</h2></section><section id="三级" class="level3"><h3>三级</h3></section>',
  );
  assert.deepEqual(toc, [
    { level: 2, id: '内联-x-标题', text: '内联 标题' },
    { level: 3, id: '三级', text: '三级' },
  ]);
});

test('TOC: a body H1 is an entry, keyed on its section id', () => {
  const { toc } = pp('<section id="正文标题" class="level1"><h1>正文标题</h1></section><section id="背景" class="level2"><h2>背景</h2></section>');
  assert.deepEqual(toc, [
    { level: 1, id: '正文标题', text: '正文标题' },
    { level: 2, id: '背景', text: '背景' },
  ]);
});

test('mermaid placeholder keeps its class and key through sanitize', () => {
  // Extraction happens before pandoc, so postprocess only sees the placeholder.
  const { html } = pp('<div class="mermaid-host" data-mermaid-key="p1-1"></div>');
  assert.ok(html.includes('class="mermaid-host"'), html);
  assert.ok(html.includes('data-mermaid-key="p1-1"'), html);
});

test('code block language names survive sanitizing (the copy button label depends on them)', () => {
  const { html } = pp('<pre class="sourceCode js"><code class="sourceCode javascript"><span class="kw">const</span></code></pre>');
  assert.ok(html.includes('class="sourceCode js"'), html);
  assert.ok(html.includes('class="sourceCode javascript"'), html);
  const other = pp('<p class="totally-made-up">x</p>');
  assert.ok(!other.html.includes('totally-made-up'), other.html);
});

test('fenced-div callout normalization: class and title → semantic class + data-note', () => {
  const { html } = pp('<div class="callout warning" title="注意"><p>x</p></div>');
  assert.ok(html.includes('class="callout warning"'), html);
  assert.ok(html.includes('data-note="注意"'), html);
  assert.ok(!/\stitle=/.test(html), `title should be absorbed into data-note: ${html}`);
});

test('fenced-div callout without a title falls back to the kind name', () => {
  const { html } = pp('<div class="callout tip"><p>x</p></div>');
  assert.ok(html.includes('data-note="Tip"'), html);
});

test('GFM alert drops the pandoc-provided English title for the kind name', () => {
  const alert =
    '<div class="tip alert"><div class="title"><p>Tip</p></div><p>x</p></div>';
  const { html } = pp(alert);
  assert.ok(html.includes('class="callout tip"'), html);
  assert.ok(html.includes('data-note="Tip"'), html);
  assert.ok(!html.includes('>Tip<'), html);
  assert.ok(!html.includes('alert'), html);
});

test('emoji shortcodes keep their semantic attributes', () => {
  const { html } = pp('<p><span class="emoji" data-emoji="sparkles">✨</span></p>');
  assert.ok(html.includes('class="emoji"'), html);
  assert.ok(html.includes('data-emoji="sparkles"'), html);
});

test('caution and danger map to the same danger semantics, distinct from warning', () => {
  const { html } = pp('<div class="caution alert"><div class="title"><p>Caution</p></div><p>x</p></div>');
  assert.ok(html.includes('class="callout caution"'), html);
  assert.ok(html.includes('data-note="Danger"'), html);
});

test('design.md boundary tree: hidden and _-prefixed items are excluded from nodes', () => {
  const root = tmpDir();
  writeFile(root, 'a.md', 'x');
  writeFile(root, '.draft.md', 'x');
  writeFile(root, '_index.md', 'x');
  writeFile(root, '.cache/secret.md', 'x');
  writeFile(root, '_meta/x.md', 'x');
  fs.mkdirSync(path.join(root, 'b'));
  const nodes = collectNodes(root);
  assert.deepEqual([...nodes.keys()].sort(), ['a', 'b']);
});

test('reserved root-name collision raises', () => {
  const root = tmpDir();
  writeFile(root, 'archives.md', '---\npublic: true\n---\n');
  const { root: tree } = scanTree(root);
  assert.throws(() => assertReserved(tree), /fixed route/);
});

test('case-folding collision check (independent of filesystem case behavior)', () => {
  // Exercise the check directly: case-insensitive filesystems cannot hold
  // both Posts.md and posts.md.
  const nodes = new Map([
    ['Posts', { dir: false, md: true }],
    ['posts', { dir: false, md: true }],
  ]);
  assert.throws(() => assertNoCaseCollision(nodes, ''), /differing only by case/);
});

test('symbolic links always raise', () => {
  const root = tmpDir();
  writeFile(root, 'a.md', 'x');
  fs.symlinkSync(path.join(root, 'a.md'), path.join(root, 'link.md'));
  assert.throws(() => scanTree(root), /symbolic link/);
});

test('public must be a boolean: the string "true" raises', () => {
  const root = tmpDir();
  writeFile(root, 'a.md', '---\npublic: "true"\n---\n');
  const { root: tree } = scanTree(root);
  assert.throws(() => resolveTree(tree), /YAML boolean/);
});

test('fail-closed: a private parent keeps children private even with public set', () => {
  const root = tmpDir();
  writeFile(root, '私人.md', '---\ntitle: p\n---\n');
  writeFile(root, '私人/子.md', '---\ntitle: c\npublic: true\n---\n');
  const { root: tree } = scanTree(root);
  const { pages, privateItems } = resolveTree(tree);
  assert.equal(pages.length, 0);
  assert.equal(privateItems.length, 2);
});

test('a directory switched private by _index.md also guards its attachments', () => {
  const root = tmpDir();
  writeFile(root, '机密/_index.md', '---\ntitle: 机密目录\npublic: false\n---\n');
  writeFile(root, '机密/笔记.md', '---\ntitle: 笔记\n---\n');
  writeFile(root, '机密/img/secret.png', PNG);
  const { root: tree } = scanTree(root);
  const { privateItems } = resolveTree(tree);
  const dirs = privateItems.filter((i) => i.kind === 'dir').map((i) => i.relPath);
  assert.ok(dirs.includes('机密'), 'the private directory must be recorded so attachments are refused');
});

test("_index.md's public flag does not affect visibility; bare directories get index pages", () => {
  const root = tmpDir();
  writeFile(root, '分组/_index.md', '---\ntitle: 分组\npublic: true\n---\n');
  writeFile(root, '分组/a.md', '---\npublic: true\n---\n');
  writeFile(root, '私有组/_index.md', '---\ntitle: x\n---\n');
  writeFile(root, '私有组/b.md', '---\npublic: true\n---\n');
  writeFile(root, 'c/_index.md', '---\ntitle: c\n---\n');
  writeFile(root, 'c/x.md', '---\ntitle: x\n---\n');
  const { root: tree } = scanTree(root);
  const { pages } = resolveTree(tree);
  const idx = pages.filter((p) => p.kind === 'index').map((p) => p.relPath);
  assert.ok(!idx.includes('c'), 'a fully private directory should not get an index page');
  assert.ok(idx.includes('分组'));
  // fail-closed applies to private .md parents, not to directories.
  assert.ok(pages.some((p) => p.relPath === '私有组/b'));
  assert.ok(pages.find((p) => p.kind === 'index')?.title === '分组');
});

test('asset-only directories do not get index pages', () => {
  const root = tmpDir();
  writeFile(root, '图/img/a.png', PNG);
  writeFile(root, 't.md', '---\npublic: true\n---\n');
  const { root: tree } = scanTree(root);
  const { pages } = resolveTree(tree);
  assert.equal(pages.filter((p) => p.kind === 'index').length, 0);
});

test('assets: escaping the root and symlink escapes are refused', () => {
  const root = tmpDir();
  writeFile(root, 'img/a.png', PNG);
  const outside = tmpDir();
  writeFile(outside, 'evil.png', PNG);
  fs.symlinkSync(path.join(outside, 'evil.png'), path.join(root, 'img/link.png'));
  const realRoot = fs.realpathSync(root);
  assert.ok(resolveAsset(realRoot, 'img/a.png'));
  assert.throws(() => resolveAsset(realRoot, '../evil.png'), /dotfiles|escapes the content root/);
  assert.throws(() => resolveAsset(realRoot, 'img/link.png'), /escapes the content root/);
});

test('assets: extension whitelist and hashed, deduped names', () => {
  const root = tmpDir();
  writeFile(root, 'a.txt', 'x');
  writeFile(root, 'x/img/a.png', 'one');
  writeFile(root, 'y/img/a.png', 'two');
  const namer = makeAssetNamer(fs.realpathSync(root));
  const [u1, u2, u3] = [namer.assign('p', 'x/img/a.png'), namer.assign('p', 'y/img/a.png'), namer.assign('p', 'x/img/a.png')];
  assert.match(u1, /^assets\/p\/a\.[0-9a-f]{8}\.png$/);
  assert.notEqual(u2, u1, 'same basename from another directory needs its own URL');
  assert.equal(u3, u1, 'the same source keeps one URL');
});

test('mermaid extraction: both fenced and fenced-div forms recognized, source kept byte-exact', () => {
  const md = [
    '# 图',
    '',
    '```mermaid',
    'flowchart LR',
    '  A --> B',
    '```',
    '',
    '::: {.mermaid caption="时序"}',
    'sequenceDiagram',
    'A->>B: hi',
    ':::',
    '',
  ].join('\n');
  const { markdown, blocks } = extractMermaid(md, 'ab12');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].source, 'flowchart LR\n  A --> B');
  assert.equal(blocks[1].caption, '时序');
  assert.ok(markdown.includes('class="mermaid-host"'));
  assert.ok(!markdown.includes('```mermaid'), 'source should not remain in the document');
});

test('mermaid extraction: a quoted caption keeps its spaces in every fence/div form', () => {
  const forms = [
    ':::{.mermaid caption="The request/response handshake"}\nA->>B: x\n:::',
    '```mermaid {caption="The request/response handshake"}\nA->>B: x\n```',
    "```{.mermaid caption='The request/response handshake' #flow}\nA->>B: x\n```",
  ];
  for (const md of forms) {
    const { blocks } = extractMermaid(md, 'k');
    assert.equal(blocks[0].caption, 'The request/response handshake', md);
  }
  const { blocks } = extractMermaid('```{.mermaid caption="Cap" #flow}\nA-->B\n```', 'k');
  assert.equal(blocks[0].key, 'k-flow');
});

test('mermaid extraction: examples inside .demo and nested fences are not diagrams', () => {
  const md = [
    '::: {.demo}',
    '````markdown',
    '```mermaid',
    'A --> B',
    '```',
    '````',
    '```mermaid',
    'X --> Y',
    '```',
    ':::',
    '',
  ].join('\n');
  const { blocks } = extractMermaid(md, 'k');
  assert.deepEqual(blocks.map((b) => b.source), ['X --> Y']);
});

test('mermaid CSS: per-type shared rules emitted once, per-diagram rules stay hash-scoped', () => {
  const base = { key: 'a', svg: '<svg data-mmd="h1"/>', cssDark: '', typeCssDark: '[data-theme="dark"] svg[data-mmd] .n{fill:#888}' };
  const one: RenderedDiagram = { ...base, css: 'svg[data-mmd="h1"] .ms0{stroke-width:1}', typeCss: 'svg[data-mmd] .n{fill:#111}' };
  const two: RenderedDiagram = {
    ...one,
    key: 'b',
    svg: '<svg data-mmd="h2"/>',
    css: 'svg[data-mmd="h2"] .ms0{stroke-width:2}',
  };
  const { css, typeOf } = mergeDiagramCss([one, two]);

  assert.equal(typeOf.size, 2);
  assert.equal(typeOf.get('a'), typeOf.get('b'), 'same diagram type should share one type id');
  // The shared block is emitted once per theme, not once per diagram.
  assert.equal(css.split('fill:#111').length - 1, 1, css);
  assert.equal(css.split('[data-theme="dark"] svg[data-mmdt').length - 1, 1, css);
  // Per-drawing rules stay under their own hash.
  assert.ok(css.includes('svg[data-mmd="h1"] .ms0'));
  assert.ok(css.includes('svg[data-mmd="h2"] .ms0'));
  assert.ok(!css.includes('svg[data-mmd]'), 'a bare data-mmd selector should not remain');
});

test('mermaid figure: carries the shared type id so shared styles hit', () => {
  const html = figureHtml('p-1', '图注', '<svg data-mmd="h1"></svg>', 'tp1');
  assert.ok(html.includes('data-mmdt="tp1"'), html);
  assert.ok(html.includes('data-mmd="h1"'), html);
  assert.ok(html.includes('<figcaption class="diagram-caption">图注</figcaption>'), html);
});

test('images: lazy loading added; block-level images become captioned figures, inline icons untouched', () => {
  const { html } = pp(
    '<p><img src="./img/a.png" alt="图注文字" /></p>' +
      '<p>文字 <img src="./img/b.png" alt="内联" width="24" /> 继续</p>' +
      '<p><img src="./img/c.png" alt="普通" /></p>',
  );
  assert.equal((html.match(/<figure>/g) || []).length, 2, html);
  assert.ok(html.includes('<figcaption>图注文字</figcaption>'), html);
  assert.ok(/loading="lazy"/.test(html));
  assert.ok(/data-inline/.test(html), 'small images should be marked inline, not wrapped in figures');
});

test('module import rewriting: only real imports are rewritten; nested paths fail closed', async () => {
  const { rewriteModuleImports } = await import('../src/build/static-assets.ts');
  const names = new Map([['search.js', 'search.abc12345.js'], ['media.js', 'media.def67890.js']]);
  assert.equal(
    rewriteModuleImports('loader ??= import("./search.js"); void import("./media.js");', names),
    'loader ??= import("./search.abc12345.js"); void import("./media.def67890.js");',
  );
  assert.equal(rewriteModuleImports('import x from "./search.js";', names), 'import x from "./search.abc12345.js";');
  assert.equal(rewriteModuleImports('const s = "./search.js";', names), 'const s = "./search.js";', 'plain strings should not be treated as modules');
  assert.throws(() => rewriteModuleImports('import("./sub/mod.js")', names), /unhandled relative import/, 'nested specifiers must abort the build');
  assert.throws(() => rewriteModuleImports('import("./missing.js")', names), /unhandled relative import/);
});

test('browser module emission order: dependencies first, entry last, cycles fail closed', async () => {
  const { topoOrder } = await import('../src/build/static-assets.ts');
  const sources = new Map([
    ['app.js', 'import { a } from "./spa.js";'],
    ['spa.js', 'import { b } from "./tabs.js"; import { c } from "./anchor.js";'],
    ['tabs.js', 'import { c } from "./anchor.js";'],
    ['anchor.js', 'export const c = 1;'],
  ]);
  const order = topoOrder(sources);
  assert.deepEqual(order, ['anchor.js', 'tabs.js', 'spa.js', 'app.js'], 'deterministic dependency-first order, entry last');
  // Diamond tie-break: an entry importing b then a must still emit a first.
  assert.deepEqual(
    topoOrder(new Map([['app.js', 'import "./b.js"; import "./a.js";'], ['a.js', 'export const a = 1;'], ['b.js', 'import "./a.js";']])),
    ['a.js', 'b.js', 'app.js'],
  );

  assert.throws(
    () => topoOrder(new Map([['app.js', 'import "./spa.js";'], ['spa.js', 'import "./app.js";']])),
    /cycle/,
    'a cycle must abort the build, not emit a broken graph',
  );
  assert.throws(
    () => topoOrder(new Map([['app.js', 'import "./nope.js";']])),
    /missing module/,
    'an unknown import 404s at runtime and must fail closed',
  );
});

test('link cards: sole-line link becomes a card keeping its attrs; inline and unknown stay plain; text is escaped', async () => {
  const { expandLinkCards } = await import('../src/render/link-preview.ts');
  const meta = {
    url: 'https://a.io/x',
    title: 'T <i> & more',
    desc: '</span><img onerror=alert(1)>',
    host: 'a.io',
  };
  const html =
    '<p><a href="https://a.io/x" class="accent link-preview" id="card1" title="docs">fallback</a></p>' +
    '<p>see <a href="https://a.io/x" class="link-preview">t</a> here</p>' +
    '<p><a href="https://b.io/y" class="link-preview">unknown</a></p>';
  const r = expandLinkCards(html, new Map([['https://a.io/x', meta]]));
  assert.equal(r.expanded, 1);
  // In-place mutation: href/id/title survive, the class is swapped in place, rel appended.
  assert.ok(r.html.includes('<p class="link-card-row"><a href="https://a.io/x" class="accent link-card" id="card1" title="docs" target="_blank" rel="noopener noreferrer">'));
  // External metadata only ever becomes text; the serializer escapes it.
  assert.ok(r.html.includes('T &lt;i&gt; &amp; more'));
  assert.ok(r.html.includes('&lt;/span&gt;&lt;img onerror=alert(1)&gt;'));
  assert.ok(!r.html.includes('<img onerror'));
  assert.ok(!r.html.includes('<i>'));
  // Inline among text and no-metadata links keep their plain shape.
  assert.ok(r.html.includes('see <a href="https://a.io/x" class="link-preview">t</a> here'));
  assert.ok(r.html.includes('<a href="https://b.io/y" class="link-preview">unknown</a>'));
});

test('link cards: a card for the site\'s own host stays in the current tab', async () => {
  const { expandLinkCards } = await import('../src/render/link-preview.ts');
  const cards = new Map([['https://example.com/posts/abc', { url: 'https://example.com/posts/abc', title: 'Own', desc: '', host: 'example.com' }]]);
  const html = '<p><a href="https://example.com/posts/abc" class="link-preview">own</a></p>';
  const r = expandLinkCards(html, cards, 'example.com');
  assert.equal(r.expanded, 1);
  assert.ok(!/link-card"[^>]*target=/.test(r.html), r.html);
  // A card for another host does open a new tab.
  const off = expandLinkCards('<p><a href="https://a.io/x" class="link-preview">x</a></p>',
    new Map([['https://a.io/x', { url: 'https://a.io/x', title: 'A', desc: '', host: 'a.io' }]]), 'example.com');
  assert.ok(/link-card" target="_blank" rel="noopener noreferrer"/.test(off.html), off.html);
});

test('link cards: a soft-break paragraph of card links promotes every link', async () => {
  const { expandLinkCards } = await import('../src/render/link-preview.ts');
  const cards = new Map([
    ['https://x.io/1', { url: 'https://x.io/1', title: 'X1', desc: '', host: 'x.io' }],
    ['https://y.io/2', { url: 'https://y.io/2', title: 'Y2', desc: '', host: 'y.io' }],
  ]);
  const html = '<p><a href="https://x.io/1" class="link-preview">a</a>\n<a href="https://y.io/2" class="link-preview">b</a></p>';
  const r = expandLinkCards(html, cards);
  assert.equal(r.expanded, 2);
  assert.equal((r.html.match(/class="link-card"/g) || []).length, 2);
  // One plain neighbor link in the same paragraph keeps all of them plain.
  const mixed = '<p><a href="https://x.io/1" class="link-preview">a</a>\n<a href="https://plain.io">plain</a></p>';
  assert.equal(expandLinkCards(mixed, cards).expanded, 0);
});

test('link cards: nothing to expand → byte-identical output (no round-trip churn)', async () => {
  const { expandLinkCards } = await import('../src/render/link-preview.ts');
  const html = '<p><svg><path d="M0 0"/></svg></p><p><a href="https://b.io/y" class="link-preview">x</a></p>';
  assert.strictEqual(expandLinkCards(html, new Map()).html, html);
});

test('link cards: letter avatar when no icon was fetched; host text is plain', async () => {
  const { expandLinkCards } = await import('../src/render/link-preview.ts');
  const meta = { url: 'https://7-zip.org/', title: '', desc: '', host: '7-zip.org' };
  const r = expandLinkCards('<p><a href="https://7-zip.org/" class="link-preview">7-Zip</a></p>', new Map([['https://7-zip.org/', meta]]));
  assert.ok(r.html.includes('class="lc-icon lc-glyph"'), 'no icon → letter avatar');
  assert.ok(r.html.includes('>7</span>'), 'first host alnum becomes the glyph');
  assert.ok(r.html.includes('>7-Zip</span>'), 'empty fetched title falls back to the link text');
});

test('link cards: collect only external http(s) hrefs from the final html', async () => {
  const { collectLinkPreviewHrefs } = await import('../src/render/link-preview.ts');
  const html =
    '<p><a href="https://a.io/x" class="link-preview">one</a></p>' +
    '<p><a href="/posts/abc/" class="link-preview">rewritten-internal</a></p>' +
    '<p><a href="mailto:someone@a.io" class="link-preview">mailto</a></p>' +
    '<p><a href="https://a.io/x" class="link-preview">dupe</a></p>';
  assert.deepEqual(collectLinkPreviewHrefs(html), ['https://a.io/x']);
});

test('link cards: refresh with fetch disabled keeps serving the cache', async () => {
  const { loadCards } = await import('../src/render/link-preview.ts');
  const dir = (await import('../tests/helpers.ts')).tmpDir('lp-cache-');
  const { writeFile } = await import('../tests/helpers.ts');
  writeFile(dir, 'cache.json', JSON.stringify({
    version: 1,
    entries: { 'https://a.io/x': { ok: true, at: 0, title: 'T', desc: 'D', host: 'a.io' } },
  }));
  const { cards, notes } = await loadCards(['https://a.io/x'], { cacheDir: dir, network: false, refresh: true });
  assert.equal(cards.size, 1, 'a contradictory --refresh-links --no-link-fetch must serve the cache');
  assert.equal(notes.length, 0);
});

test('link cards: cache entries failing the fresh-fetch invariants are ignored', async () => {
  const { loadCards } = await import('../src/render/link-preview.ts');
  const dir = (await import('../tests/helpers.ts')).tmpDir('lp-cache-');
  const { writeFile } = await import('../tests/helpers.ts');
  writeFile(dir, 'cache.json', JSON.stringify({
    version: 1,
    entries: {
      'https://svg.io/x': { ok: true, at: 0, title: 'T', desc: '', host: 'svg.io', icon: { mime: 'image/svg+xml', b64: 'AAAA' } },
      'https://fat.io/x': { ok: true, at: 0, title: 'T'.repeat(500), desc: '', host: 'fat.io' },
      'https://good.io/x': { ok: true, at: 0, title: 'T', desc: '', host: 'good.io' },
    },
  }));
  const { cards, notes } = await loadCards(['https://svg.io/x', 'https://fat.io/x', 'https://good.io/x'], { cacheDir: dir, network: false });
  assert.deepEqual([...cards.keys()], ['https://good.io/x'], 'only the sane entry may serve');
  assert.equal(notes.filter((n) => n.includes('fetch disabled')).length, 2, 'rejected entries degrade with a note');
});

test('link cards: head metadata extraction (og first, icon candidates ranked)', async () => {
  const { extractHead } = await import('../src/render/link-preview.ts');
  const head = extractHead(
    '<meta charset="utf-8"><title>plain</title>' +
      '<meta property="og:title" content="OG 标题">' +
      '<meta property="og:description" content="OG 描述">' +
      '<link rel="apple-touch-icon" href="/touch.png">' +
      '<link rel="shortcut icon" sizes="32x32" href="/f.png">' +
      '<link rel="icon" href="/icon.svg">',
  );
  assert.equal(head.ogTitle, 'OG 标题');
  assert.equal(head.ogDesc, 'OG 描述');
  assert.equal(head.title, 'plain');
  // Ranking only — an SVG candidate may be collected; the byte sniffer
  // decides what actually ships.
  assert.deepEqual(head.icons, ['/f.png', '/icon.svg', '/touch.png']);
});

test('link cards: SSRF guard blocks local and non-http targets (literal hosts, no DNS needed)', async () => {
  const { assertPublicHost } = await import('../src/render/link-preview.ts');
  for (const u of [
    'http://127.0.0.1:7060/',
    'http://10.1.2.3/',
    'http://192.168.1.1/',
    'http://172.16.0.9/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.100.100.200/latest/meta-data/', // Aliyun metadata, inside CGNAT 100.64/10
    'http://100.64.0.1/',
    'http://100.127.255.255/',
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:10.0.0.1]/',
    'file:///etc/passwd',
  ]) {
    await assert.rejects(() => assertPublicHost(new URL(u)), /blocked/, `${u} must be blocked`);
  }
  // Just outside the blocked ranges (v4-mapped public too: compressed v6 forms
  // must parse, not fail closed into false blocks).
  await assert.doesNotReject(() => assertPublicHost(new URL('http://100.128.0.1/')));
  await assert.doesNotReject(() => assertPublicHost(new URL('http://172.32.0.1/')));
  await assert.doesNotReject(() => assertPublicHost(new URL('http://[::ffff:8.8.8.8]/')));
});

test('firstParagraph skips link-card rows: external og text is not the page description', async () => {
  const { firstParagraph } = await import('../src/site/index.ts');
  const html =
    '<p class="link-card-row"><a class="link-card" href="https://a.io/x"><span class="lc-title">External Title</span></a></p>' +
    '<p>真正的第一段正文。</p>';
  assert.equal(firstParagraph(html), '真正的第一段正文。');
  assert.equal(firstParagraph('<p class="link-card-row">only a card</p>'), '');
});

test('output writes refuse a dist-relative path that escapes the root (crafted abbrlink)', async () => {
  const { writeDiff, writeMissing } = await import('../src/build/outputs.ts');
  const dist = tmpDir('out-escape-');
  const src = writeFile(tmpDir('out-src-'), 'attachments/a.mp4', 'bytes');
  for (const bad of ['posts/../../escaped/index.html', '../evil.txt', '/abs/path']) {
    assert.throws(() => writeDiff(dist, new Map([[bad, 'x']]), new Set()), /escapes the root/, bad);
    assert.throws(() => writeMissing(dist, bad, src), /escapes the root/, bad);
  }
  // Legitimate nested writes still work.
  writeDiff(dist, new Map([['posts/abcd/index.html', 'ok']]), new Set());
  assert.ok(fs.existsSync(path.join(dist, 'posts/abcd/index.html')));
  assert.ok(writeMissing(dist, 'assets/p/a.mp4', src), 'a fresh attachment copy must be written');
  assert.equal(fs.readFileSync(path.join(dist, 'assets/p/a.mp4'), 'utf8'), 'bytes');
  assert.ok(!writeMissing(dist, 'assets/p/a.mp4', src), 'an existing copy must not be rewritten');
});

test('writeDiff: stale attachments are collected, live ones are kept without being read', async () => {
  const { writeDiff } = await import('../src/build/outputs.ts');
  const dist = tmpDir('out-gc-');
  fs.mkdirSync(path.join(dist, 'assets/p'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'assets/p/live.aaaa.png'), 'live');
  fs.writeFileSync(path.join(dist, 'assets/p/stale.bbbb.png'), 'stale');
  fs.mkdirSync(path.join(dist, 'posts/old'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'posts/old/index.html'), 'old');

  const keep = new Set(['assets/p/live.aaaa.png']);
  // A stale attachment from a previous build (not in keep) must be collected
  // without its bytes ever being read: give the file unreadable permissions.
  fs.chmodSync(path.join(dist, 'assets/p/stale.bbbb.png'), 0o000);
  const r = writeDiff(dist, new Map([['posts/new/index.html', 'new']]), keep);
  assert.ok(fs.existsSync(path.join(dist, 'assets/p/live.aaaa.png')), 'a kept attachment must survive');
  assert.ok(!fs.existsSync(path.join(dist, 'assets/p/stale.bbbb.png')), 'a dropped attachment must be deleted');
  assert.ok(!fs.existsSync(path.join(dist, 'posts/old/index.html')), 'a dropped page must be deleted');
  assert.ok(fs.existsSync(path.join(dist, 'posts/new/index.html')));
  assert.equal(r.removed, 2);
  cleanupTmpDirs();
});

test('frontend.ts passes real warnings through instead of throwing', () => {
  // The wrapper is installed at import and calls the real emitWarning; a lost
  // spread there makes every non-suppressed warning throw ERR_INVALID_ARG_TYPE.
  const r = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "import './src/build/frontend.ts'; process.emitWarning('a warning'); process.stdout.write('ok');"],
    { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' },
  );
  assert.equal(r.status, 0, String(r.stderr));
  assert.equal(r.stdout, 'ok', 'a real warning must not abort the process');
});

// ---------------------------------------------------------------------------
// Base-path derivation (GitHub Pages sub-path deployment)
// ---------------------------------------------------------------------------
test('basePathOf: derived from the url pathname; empty for root deployments', async () => {
  const { basePathOf } = await import('../src/core/config.ts');
  assert.equal(basePathOf('https://example.com'), '');
  assert.equal(basePathOf('https://example.com/'), '');
  assert.equal(basePathOf('https://user.github.io/noteflow'), '/noteflow');
  assert.equal(basePathOf('https://user.github.io/noteflow/'), '/noteflow');
  assert.equal(basePathOf('https://user.github.io/a/b'), '/a/b');
});

test('siteUrlOf/siteRelOf: prefix and strip are inverse; stripping is fail-closed', async () => {
  const { siteUrlOf, siteRelOf } = await import('../src/core/config.ts');
  const url = 'https://user.github.io/noteflow';
  assert.equal(siteUrlOf(url, '/posts/x'), '/noteflow/posts/x');
  assert.equal(siteUrlOf(url, 'posts/x'), '/noteflow/posts/x');
  assert.equal(siteUrlOf('https://example.com', '/posts/x'), '/posts/x');
  assert.equal(siteRelOf(url, '/noteflow/posts/x'), '/posts/x');
  assert.equal(siteRelOf(url, '/noteflow'), '/');
  assert.throws(() => siteRelOf(url, '/posts/x'), /missing the site's base path/);
  // Root deployment: both are the identity.
  assert.equal(siteRelOf('https://example.com', '/posts/x'), '/posts/x');
});

test('absUrl: base path applied exactly once, whether the path is site-rel or an emitted href', async () => {
  const { absUrl } = await import('../src/site/helpers.ts');
  const site = { url: 'https://user.github.io/noteflow', siteName: 't', lang: 'en', postPattern: '/posts/{abbrlink}', pageSize: { home: 5, feed: 5 } };
  assert.equal(absUrl(site, '/feed.xml'), 'https://user.github.io/noteflow/feed.xml');
  assert.equal(absUrl(site, '/noteflow/feed.xml'), 'https://user.github.io/noteflow/feed.xml');
  assert.equal(absUrl(site, '/noteflow/posts/abc'), 'https://user.github.io/noteflow/posts/abc');
  assert.equal(absUrl({ ...site, url: 'https://example.com' }, '/'), 'https://example.com/');
});

test('postHref/postOutRel: href carries the prefix, the disk path does not', async () => {
  const { postHref, postOutRel } = await import('../src/site/aggregates.ts');
  const site = { url: 'https://user.github.io/noteflow', siteName: 't', lang: 'en', postPattern: '/posts/{abbrlink}', pageSize: { home: 5, feed: 5 } };
  assert.equal(postHref(site, 'abc'), '/noteflow/posts/abc');
  assert.equal(postOutRel(site, postHref(site, 'abc')), 'posts/abc/index.html');
  assert.equal(postOutRel({ ...site, url: 'https://example.com' }, '/posts/abc'), 'posts/abc/index.html');
});

test('footer: the theme mark, the linked © line and the author credit, all optional', async () => {
  const { footer } = await import('../src/site/footer.ts');
  const base = { url: 'https://example.com', siteName: 'my notes', lang: 'en', postPattern: '/posts/{abbrlink}', pageSize: { home: 5, feed: 5 } };
  const ctx = (site: object, builtAt = new Date('2026-03-04T00:00:00Z')) =>
    ({ site, builtAt, assets: { mark: '/static/img/mark.abc12345.png' } }) as unknown as Parameters<typeof footer>[0];

  const plain = footer(ctx(base));
  assert.ok(plain.startsWith('<footer class="site-footer" data-region="footer">'), 'the footer is a semantic, swappable region');
  // Without copyrightUrl the whole © line — mark and text — is the project link.
  assert.ok(
    plain.includes(
      '<a class="foot-copy" href="https://github.com/gogongxt/noteflow" target="_blank" rel="noopener noreferrer"><img class="logo-mark" src="/static/img/mark.abc12345.png"',
    ),
    plain,
  );
  assert.ok(plain.includes('© 2026 my notes</a>'), plain);
  assert.ok(!plain.includes('noteflow</a>') && !plain.includes('foot-by') && !plain.includes('foot-icp'), plain);

  // since → a year range; a custom template interpolates year and site.
  const ranged = footer(ctx({ ...base, footer: { since: 2024, copyright: 'Copyright {year} · {site}' } }));
  assert.ok(ranged.includes('Copyright 2024–2026 · my notes'), ranged);
  assert.ok(footer(ctx({ ...base, footer: { since: 2026 } })).includes('© 2026 my notes'), 'a current-year since stays one year');

  // A configured copyrightUrl still wins: a site path gains the base path,
  // another host opens a new tab, and the mark rides inside the same link.
  const prefixed = footer(ctx({ ...base, url: 'https://user.github.io/noteflow', footer: { copyrightUrl: '/about' } }));
  assert.ok(prefixed.includes('<a class="foot-copy" href="/noteflow/about">'), prefixed);
  assert.ok(prefixed.includes('© 2026 my notes</a>'), prefixed);
  assert.ok(prefixed.includes('<img class="logo-mark"'), 'the mark rides inside the linked © line');
  const sameHost = footer(ctx({ ...base, url: 'https://user.github.io/noteflow', footer: { copyrightUrl: 'https://user.github.io/noteflow/archives' } }));
  assert.ok(sameHost.includes('<a class="foot-copy" href="https://user.github.io/noteflow/archives">'), 'same-host links stay in the tab');
  const offsite = footer(ctx({ ...base, footer: { copyrightUrl: 'https://pandoc.org' } }));
  assert.ok(offsite.includes('<a class="foot-copy" href="https://pandoc.org" target="_blank" rel="noopener noreferrer">'), offsite);
  // credit: false keeps the © line but drops the mark.
  const noMark = footer(ctx({ ...base, footer: { copyrightUrl: '/about', credit: false } }));
  assert.ok(!noMark.includes('logo-mark') && noMark.includes('<a class="foot-copy" href="/about">© 2026 my notes</a>'), noMark);

  // By <author>, optionally linked; unset renders nothing.
  assert.ok(footer(ctx({ ...base, footer: { author: 'gogongxt' } })).includes('<span class="foot-by">By gogongxt</span>'));
  assert.ok(
    footer(ctx({ ...base, footer: { author: 'gogongxt', authorUrl: 'https://github.com/gogongxt' } })).includes(
      '<span class="foot-by">By <a class="foot-author" href="https://github.com/gogongxt" target="_blank" rel="noopener noreferrer">gogongxt</a></span>',
    ),
  );
  assert.ok(!footer(ctx({ ...base, footer: { authorUrl: 'https://github.com/x' } })).includes('foot-by'), 'authorUrl without an author renders nothing');

  // credit: false drops the theme mark; the © text then renders unlinked.
  const icp = footer(ctx({ ...base, footer: { icp: '京ICP备00000000号', credit: false } }));
  assert.ok(icp.includes('<a class="foot-icp" href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">京ICP备00000000号</a>'), icp);
  assert.ok(icp.includes('<span class="foot-copy">© 2026 my notes</span>'), 'credit: false leaves a plain © line');
  const custom = footer(ctx({ ...base, footer: { icp: 'X', icpUrl: 'https://example.org/icp' } }));
  assert.ok(custom.includes('href="https://example.org/icp"'), custom);

  // Every configured string is escaped, including the template itself.
  const hostile = footer(ctx({ ...base, footer: { copyright: '© {year} <script>alert(1)</script>', author: '<b>me</b>', icp: '<b>x</b>' } }));
  assert.ok(!hostile.includes('<script>') && !hostile.includes('<b>'), hostile);
});

test('config validation: footer shape is checked up front, not mid-build', async () => {
  const { loadConfig } = await import('../src/core/config.ts');
  const dir = tmpDir('nf-cfg-');
  const base = "url: 'https://example.com',\nsiteName: 't',\nlang: 'en',\npostPattern: '/posts/{abbrlink}',\npageSize: { home: 5, feed: 5 }";
  const write = (name: string, footer: string): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `export default {\n${base},\n${footer}\n};\n`);
    return file;
  };
  const ok = await loadConfig(write('ok.mjs', "footer: { copyright: '© {year}', since: 2024, credit: false, icp: 'x', author: 'me', authorUrl: 'mailto:me@x.y', copyrightUrl: '/about' },"));
  assert.equal(ok.footer!.since, 2024);
  assert.equal(ok.footer!.author, 'me');

  const bad: [string, RegExp][] = [
    ["footer: 'nope',", /footer must be an object/],
    ['footer: [],', /footer must be an object/],
    ["footer: { copyright: '  ' },", /footer\.copyright must be a non-empty string/],
    ["footer: { author: '' },", /footer\.author must be a non-empty string/],
    ['footer: { since: 24 },', /footer\.since must be a four-digit year/],
    ['footer: { since: 2024.5 },', /footer\.since must be a four-digit year/],
    ["footer: { credit: 'no' },", /footer\.credit must be a boolean/],
    ["footer: { copyrightUrl: 'javascript:alert(1)' },", /footer\.copyrightUrl must start with/],
    ["footer: { authorUrl: '//evil.example/x' },", /footer\.authorUrl must start with/],
    ["footer: { icp: 'x', icpUrl: 'pandoc.org' },", /footer\.icpUrl must start with/],
  ];
  for (const [src, re] of bad) {
    await assert.rejects(loadConfig(write(`bad-${Math.random()}.mjs`, src)), re, src);
  }
});

test('config validation: the edit block is checked up front, not mid-build', async () => {
  const { loadConfig } = await import('../src/core/config.ts');
  const dir = tmpDir('nf-cfg-edit-');
  const base = "url: 'https://example.com',\nsiteName: 't',\nlang: 'en',\npostPattern: '/posts/{abbrlink}',\npageSize: { home: 5, feed: 5 }";
  const write = (name: string, edit: string): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `export default {\n${base},\n${edit}\n};\n`);
    return file;
  };
  const ok = await loadConfig(
    write('ok.mjs', "edit: { repoUrl: 'https://git.example.com/you/notes/', branch: 'dev', provider: 'gitlab', root: 'notes' },"),
  );
  assert.equal(ok.edit!.branch, 'dev');
  // '' is the documented spelling for "the content dir is the repo root".
  const atRoot = await loadConfig(write('root.mjs', "edit: { repoUrl: 'https://git.example.com/you/notes', root: '' },"));
  assert.equal(atRoot.edit!.root, '');

  const bad: [string, RegExp][] = [
    ["edit: 'nope',", /edit must be an object/],
    ['edit: [],', /edit must be an object/],
    ["edit: { branch: 'main' },", /edit\.repoUrl must be an absolute http\(s\) URL/],
    ["edit: { repoUrl: 'git@example.com:notes' },", /edit\.repoUrl must be an absolute http\(s\) URL/],
    ["edit: { repoUrl: 'https://x.example/n?tab=readme' },", /edit\.repoUrl must not carry a query string or fragment/],
    ["edit: { repoUrl: 'https://x.example/n#readme' },", /edit\.repoUrl must not carry a query string or fragment/],
    ["edit: { repoUrl: 'https://x.example/n', branch: ' ' },", /edit\.branch must be a non-empty string/],
    ["edit: { repoUrl: 'https://x.example/n', provider: 'sourcehut' },", /edit\.provider must be one of gitea, github, gitlab/],
    ["edit: { repoUrl: 'https://x.example/n', root: '/docs' },", /edit\.root must be a repo-relative path/],
    ["edit: { repoUrl: 'https://x.example/n', root: 'docs/' },", /edit\.root must be a repo-relative path/],
    ["edit: { repoUrl: 'https://x.example/n', root: '../docs' },", /edit\.root must be a repo-relative path/],
    ["edit: { repoUrl: 'https://x.example/n', root: 'a//b' },", /edit\.root must be a repo-relative path/],
  ];
  for (const [src, re] of bad) {
    await assert.rejects(loadConfig(write(`bad-${Math.random()}.mjs`, src)), re, src);
  }
});

test('editUrlOf: forge routes, a repo subdir, slashed branches and encoded file names', async () => {
  const { editUrlOf } = await import('../src/core/config.ts');
  const repo = 'https://git.example.com/you/notes/';
  const gitea = { edit: { repoUrl: repo } };
  assert.equal(editUrlOf(gitea, 'Intro.md'), 'https://git.example.com/you/notes/_edit/main/Intro.md');
  assert.equal(editUrlOf({ edit: { repoUrl: repo, provider: 'github' } }, 'Intro.md'), 'https://git.example.com/you/notes/edit/main/Intro.md');
  assert.equal(editUrlOf({ edit: { repoUrl: repo, provider: 'gitlab' } }, 'Intro.md'), 'https://git.example.com/you/notes/-/edit/main/Intro.md');
  assert.equal(editUrlOf({ edit: { repoUrl: repo, branch: 'release/1.0' } }, 'Intro.md'), 'https://git.example.com/you/notes/_edit/release/1.0/Intro.md');
  assert.equal(editUrlOf({ edit: { repoUrl: repo, root: 'site/docs' } }, 'Syntax/Features.md'), 'https://git.example.com/you/notes/_edit/main/site/docs/Syntax/Features.md');
  assert.equal(editUrlOf(gitea, '笔记 一.md'), 'https://git.example.com/you/notes/_edit/main/%E7%AC%94%E8%AE%B0%20%E4%B8%80.md');
  assert.equal(editUrlOf({}, 'Intro.md'), null);
  assert.equal(editUrlOf({ edit: { repoUrl: repo } }, ''), 'https://git.example.com/you/notes/_edit/main/');
});

test('abbrlink is a URL path segment: traversal and separators are refused', () => {
  // The value becomes both a URL segment and a cache-file name; anything that
  // could escape either must fail at parse time, not at write time.
  for (const bad of ['../../package', 'a/b', '.hidden', 'a b', 'a.b']) {
    assert.throws(() => readAbbrlink({ abbrlink: bad }), /abbrlink must be letters/, bad);
  }
  assert.equal(readAbbrlink({ abbrlink: 'c182255e' }), 'c182255e');
  assert.equal(readAbbrlink({ abbrlink: '' }), null);
  assert.equal(readAbbrlink({}), null);
});
