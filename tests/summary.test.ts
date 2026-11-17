import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanupTmpDirs, tmpDir } from './helpers.ts';
import { parseSummary, summaryPlainText } from '../src/content/summary.ts';

after(() => cleanupTmpDirs());

const REPO = path.resolve(import.meta.dirname, '..');

function build(content: string, out: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['src/cli/build.ts', '--content', content, '--out', out, '--skip-mermaid'], {
    cwd: REPO,
    encoding: 'utf8',
  });
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

function findPageByTitle(root: string, title: string): string {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
  for (const f of walk(root).filter((x) => x.endsWith('.html'))) {
    const html = fs.readFileSync(f, 'utf8');
    if (html.includes(`<title>${title} ·`)) return html;
  }
  throw new Error(`page not found: ${title}`);
}

test('summary parse: paragraphs, bullets, numbered lists, lazy continuation, blank-line list breaks', () => {
  const blocks = parseSummary(
    '导语一\n续上导语。\n\n' +
      '1. 第一步\n2. 第二步\n\n' +
      '- 要点一\n  续行并入要点\n- 要点二\n\n' +
      '收尾段落',
  );
  assert.deepEqual(blocks, [
    { kind: 'p', text: '导语一续上导语。' },
    { kind: 'ol', start: 1, items: ['第一步', '第二步'] },
    { kind: 'ul', start: 1, items: ['要点一续行并入要点', '要点二'] },
    { kind: 'p', text: '收尾段落' },
  ]);
  assert.equal(summaryPlainText('- 甲\n- 乙\n\n丙'), '甲 乙 丙', 'list markers are dropped for search');
  assert.deepEqual(parseSummary('  \n\n '), [], 'blank-only input yields no blocks');
  assert.deepEqual(parseSummary('7) 从七开始'), [{ kind: 'ol', start: 7, items: ['从七开始'] }], 'ordered lists keep their start');
  assert.deepEqual(
    parseSummary('不改任何组件规则。\n文章围绕三层结构展开。'),
    [{ kind: 'p', text: '不改任何组件规则。文章围绕三层结构展开。' }],
    'CJK wrap points join without a stray space',
  );
  assert.deepEqual(
    parseSummary('first line\nsecond line'),
    [{ kind: 'p', text: 'first line second line' }],
    'Latin wrap points keep the separating space',
  );
  assert.deepEqual(
    parseSummary('2026. 年我们发布了版本。'),
    [{ kind: 'p', text: '2026. 年我们发布了版本。' }],
    'a numeric sentence is prose, not an ordered list',
  );
});

test('summary: a date-like value and a long unbroken token are handled', () => {
  const content = tmpDir('s-summary2-');
  const out = tmpDir('d-summary2-');
  const url = 'https://example.com/' + 'a'.repeat(120);
  fs.writeFileSync(path.join(content, '日期.md'), '---\ntitle: 日期\npublic: true\nabbrlink: "ab12cd34"\nsummary: 2026-11-14\n---\n正文\n');
  fs.writeFileSync(path.join(content, '长词.md'), `---\ntitle: 长词\npublic: true\nabbrlink: "cd34ef56"\nsummary: 链接 ${url}\n---\n正文\n`);
  const r = build(content, out);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(fs.readFileSync(path.join(out, 'posts/ab12cd34/index.html'), 'utf8'), /<p>2026-11-14<\/p>/, 'an unquoted date renders as text');

  // overflow-wrap lives in the stylesheet; assert the token is escaped and intact.
  const longHtml = fs.readFileSync(path.join(out, 'posts/cd34ef56/index.html'), 'utf8');
  assert.ok(longHtml.includes(url), 'the long token survives escaping');
  assert.match(fs.readFileSync(path.join(REPO, 'themes/default/css/style.css'), 'utf8'), /\.summary-card-body \{[^}]*overflow-wrap: break-word/, 'the card must break long tokens');

  for (const d of [content, out]) fs.rmSync(d, { recursive: true, force: true });
});

test('summary: an open <details> card above the body, escaped plain text, _index.md included', () => {
  const content = tmpDir('s-summary-');
  const out = tmpDir('d-summary-');
  fs.writeFileSync(
    path.join(content, '摘要测试.md'),
    '---\ntitle: 摘要测试\npublic: true\nabbrlink: "aa11bb22"\n' +
      'summary: |\n' +
      '  第一段 **不是加粗** 与 <script>alert(1)</script> 按纯文本显示。\n\n' +
      '  - 要点一\n' +
      '  - 要点二 & 符号\n' +
      '---\n正文\n',
  );
  // A corpus page exercises the _index.md path: its summary must not vanish.
  fs.mkdirSync(path.join(content, '索引摘要'));
  fs.writeFileSync(path.join(content, '索引摘要/_index.md'), '---\ntitle: 索引摘要\nsummary: 目录页也有摘要。\n---\n');
  fs.writeFileSync(path.join(content, '索引摘要/子页.md'), '---\ntitle: 子页\npublic: true\nabbrlink: "ee55ff66"\n---\n正文\n');

  const r = build(content, out);
  assert.equal(r.status, 0, r.stdout + r.stderr);

  const html = fs.readFileSync(path.join(out, 'posts/aa11bb22/index.html'), 'utf8');
  const card = /<details class="summary-card" open>([\s\S]*?)<\/details>/.exec(html);
  assert.ok(card, 'the Summary card should be a details element, open by default');
  const cardAt = html.indexOf('<details class="summary-card"');
  assert.ok(
    cardAt > html.indexOf('<header class="post-header">') && cardAt < html.indexOf('<div class="post-body">'),
    'the card sits between the header and the body',
  );
  assert.ok(!/\sstyle="/.test(html), 'the card must be styled by CSS, not inline styles');
  assert.ok(!html.includes('<style'), 'no <style> may be introduced');
  assert.ok(card[1].includes('<summary>'), 'an expandable summary should exist (native toggle: no script)');
  assert.ok(!/aria-expanded|data-toggle|onclick/i.test(card[1]), 'the toggle must not depend on script');
  assert.ok(card[1].includes('**不是加粗**') && !card[1].includes('<strong>'), 'Markdown syntax stays literal text');
  assert.ok(card[1].includes('&lt;script&gt;') && !card[1].includes('<script'), 'summary text is escaped');
  assert.ok(card[1].includes('<ul>') && card[1].includes('要点二 &amp; 符号'), 'blank-line paragraphs and bullets are laid out');

  const indexHtml = findPageByTitle(out, '索引摘要');
  assert.match(indexHtml, /<details class="summary-card" open>[\s\S]*目录页也有摘要。/, 'an _index.md summary must render');

  // A page without the field in the same build renders no card.
  const plain = fs.readFileSync(path.join(out, 'posts/ee55ff66/index.html'), 'utf8');
  assert.ok(!plain.includes('summary-card'), 'a page without a summary must render no card');

  // A structured value fails closed instead of rendering "[object Object]".
  fs.writeFileSync(path.join(content, '摘要测试.md'), '---\ntitle: 摘要测试\npublic: true\nabbrlink: "aa11bb22"\nsummary: [a, b]\n---\n正文\n');
  const badOut = tmpDir('d-badsummary-');
  const bad = build(content, badOut);
  assert.notEqual(bad.status, 0, 'a non-string summary must fail the build');
  assert.match(bad.stderr + bad.stdout, /summary must be a string/);

  for (const d of [content, out, badOut]) fs.rmSync(d, { recursive: true, force: true });
});