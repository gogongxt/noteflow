import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchIndex, splitSections } from '../src/render/search-index.ts';
import { prepare, rankPages } from '../themes/default/js/search.ts';
import type { SearchDoc } from '../themes/default/js/search.ts';
import type { Page } from '../src/core/types.ts';

function note(over: Partial<Page> & { relPath: string; title: string }): Page {
  return {
    kind: 'note',
    node: { children: [] } as never,
    abbrlink: 'abcd1234',
    href: '/posts/abcd1234',
    date: null,
    updated: null,
    tags: [],
    description: null,
    summary: null,
    html: '',
    toc: [],
    content: '',
    raw: '',
    data: {},
    ...over,
  } as Page;
}

test('sections split by h2/h3; anchors take the nearest ancestor with an id (pandoc section)', () => {
  const html =
    '<p>导语</p>' +
    '<section id="网络模式" class="level2"><h2>网络模式</h2><p>正文一</p></section>' +
    '<section id="端口" class="level2"><h2>端口发布</h2>' +
    '<section id="参数" class="level3"><h3>参数</h3><p>正文二</p></section></section>' +
    '<section id="尾部" class="level2"><h2>尾部</h2></section>';
  const secs = splitSections(html);
  assert.deepEqual(
    secs.map((s) => [s.level, s.id, s.heading]),
    [
      [0, '', ''],
      [2, '网络模式', '网络模式'],
      [2, '端口', '端口发布'],
      [3, '参数', '参数'],
      [2, '尾部', '尾部'],
    ],
  );
  assert.equal(secs[1].text, '正文一');
  assert.equal(secs[3].text, '正文二');
  assert.equal(secs[4].text, '', 'sections with only a heading are kept');
});

test('a heading with its own id wins', () => {
  const secs = splitSections('<section id="outer"><h2 id="inner">标题</h2></section>');
  assert.equal(secs[0].id, 'inner');
});

test('code text is searchable; SVG and scripts stay out of body text; image alt kept as text', () => {
  const html =
    '<h2 id="a">A</h2>' +
    '<pre><code>docker compose up -d</code></pre>' +
    '<svg><path d="M0 0 secret_path"/></svg>' +
    '<script>secret_script</script>' +
    '<p>看图 <img src="x.png" alt="架构图"> 结束</p>';
  const [sec] = splitSections(html);
  assert.ok(sec.text.includes('docker compose up -d'), 'code text is searchable');
  assert.ok(!sec.text.includes('secret_path'), sec.text);
  assert.ok(!sec.text.includes('secret_script'), sec.text);
  assert.ok(sec.text.includes('架构图'), sec.text);
});

test('index: the intro becomes its own entry, sections carry anchor URLs, duplicate anchors dedupe', () => {
  const p = note({
    relPath: '技术笔记/Docker',
    title: 'Docker 实践笔记',
    date: '2026-11-02T10:00:00+08:00',
    tags: ['docker', '运维'],
    description: '容器化相关的记录。',
    href: '/posts/abcd1234',
    html:
      '<p>导语正文</p>' +
      '<section id="常用操作"><h2>常用操作</h2><p>compose up</p></section>' +
      '<section id="重复"><h2>重复</h2><p>一</p></section>' +
      '<section id="重复"><h2>重复</h2><p>二</p></section>',
  });
  const { docs } = buildSearchIndex([p], { dirsOf: () => ['技术笔记'] });
  assert.equal(docs.length, 3);
  assert.equal(docs[0].h, '');
  assert.equal(docs[0].f, 'Docker', 'filename = basename without .md');
  assert.equal(docs[0].u, '/posts/abcd1234');
  assert.match(docs[0].x, /容器化相关的记录/);
  assert.match(docs[0].x, /导语正文/);
  assert.equal(docs[0].d, '2026-11-02', 'date keeps only YYYY-MM-DD');
  assert.deepEqual(docs[0].g, ['docker', '运维']);
  assert.deepEqual(docs[0].p, ['技术笔记']);
  assert.equal(docs[1].u, '/posts/abcd1234#%E5%B8%B8%E7%94%A8%E6%93%8D%E4%BD%9C');
  assert.equal(docs[1].h, '常用操作');
});

test('index: the Summary joins the lead entry text, ahead of the body lead', () => {
  const p = note({
    relPath: '技术笔记/Docker',
    title: 'Docker 实践笔记',
    description: '容器化相关的记录。',
    summary: '本文讲容器编排。\n- 第一点\n- 第二点',
    href: '/posts/abcd1234',
    html: '<p>导语正文</p>',
  });
  const { docs } = buildSearchIndex([p], { dirsOf: () => ['技术笔记'] });
  assert.equal(docs.length, 1);
  const order = ['容器化相关的记录', '本文讲容器编排', '第一点', '第二点', '导语正文'];
  const at = order.map((s) => {
    const i = docs[0].x.indexOf(s);
    assert.ok(i >= 0, `lead text is missing "${s}": ${docs[0].x}`);
    return i;
  });
  for (let i = 1; i < at.length; i++) assert.ok(at[i - 1] < at[i], `"${order[i - 1]}" must precede "${order[i]}"`);
  assert.ok(!docs[0].x.includes('- 第一点'), 'list markers are flattened out of the snippet');
});

test('pages without an href stay out of the index', () => {
  const { docs } = buildSearchIndex([note({ relPath: 'a', title: 'A', href: '' })]);
  assert.equal(docs.length, 0);
});

test('a long note is split into multiple entries with non-overlapping bodies', () => {
  const body = Array.from({ length: 30 }, (_, i) => `<section id="s${i}"><h2>小节 ${i}</h2><p>内容 ${i}</p></section>`).join('');
  const { docs } = buildSearchIndex([note({ relPath: 'a', title: 'A', html: body })]);
  assert.equal(docs.length, 31);
  const seen = new Set(docs.map((d) => d.u));
  assert.equal(seen.size, docs.length, 'anchors must be unique');
});

test('a body-leading h1 that duplicates the title folds into the lead entry', () => {
  const p = note({
    relPath: 'a/Docker',
    title: 'Docker 实践笔记',
    html: '<h1 id="标题">Docker 实践笔记</h1><p>开篇导语</p>' +
      '<section id="s1"><h2>小节</h2><p>内容</p></section>',
  });
  const { docs } = buildSearchIndex([p]);
  assert.equal(docs.length, 2);
  assert.equal(docs[0].h, '');
  assert.match(docs[0].x, /开篇导语/);
  assert.equal(docs[1].h, '小节');
});

test('a body-leading h1 that differs from the title stays its own anchored section', () => {
  const p = note({
    relPath: 'a/Deploy',
    title: '部署手册',
    html: '<h1 id="页面大标题">页面大标题</h1><p>开篇导语</p>',
  });
  const { docs } = buildSearchIndex([p]);
  assert.equal(docs.length, 2);
  assert.equal(docs[1].h, '页面大标题');
  assert.ok(docs[1].u.endsWith('#%E9%A1%B5%E9%9D%A2%E5%A4%A7%E6%A0%87%E9%A2%98'), docs[1].u);
});

test('a heading with no text is not a section boundary', () => {
  const secs = splitSections('<h2><svg><path d="M0 0"/></svg></h2><p>正文</p><h2 id="b">有字</h2><p>后文</p>');
  assert.deepEqual(
    secs.map((s) => [s.level, s.heading]),
    [[0, ''], [2, '有字']],
  );
  assert.ok(secs[0].text.includes('正文'));
});

function sdoc(over: Partial<SearchDoc>): SearchDoc {
  return { u: '', t: '', f: '', h: '', p: [], g: [], d: '', k: 'note', x: '', ...over };
}

test('ranking tiers: title > section heading > tag > body-only', () => {
  const docs = [
    sdoc({ t: 'Docker 实践笔记', x: '引言', u: '/a' }),
    sdoc({ t: '部署手册', x: '', u: '/b' }),
    sdoc({ t: '部署手册', h: 'docker 安装', x: '步骤', u: '/b#安装' }),
    sdoc({ t: '运维杂记', g: ['docker'], x: '杂项', u: '/c' }),
    sdoc({ t: '回滚预案', x: '先降流量，docker 再换版本 docker docker docker docker docker', u: '/d' }),
  ].map(prepare);
  const ranked = rankPages(docs, ['docker'], false);
  assert.deepEqual(
    ranked.map((p) => [p.pageDoc.doc.u, p.tier]),
    [['/a', 0], ['/b', 1], ['/c', 2], ['/d', 3]],
  );
});

test('a title covering the whole query outranks a partial title plus heading match', () => {
  const docs = [
    sdoc({ t: 'Docker 入门', x: '引言', u: '/b' }),
    sdoc({ t: 'Docker 入门', h: '安装', x: '内容', u: '/b#安装' }),
    sdoc({ t: 'Docker 安装指南', x: '引言', u: '/a' }),
  ].map(prepare);
  const ranked = rankPages(docs, ['docker', '安装'], false);
  assert.equal(ranked[0].pageDoc.doc.u, '/a');
  assert.equal(ranked[0].tier, 0);
  assert.equal(ranked[1].pageDoc.doc.u, '/b');
  assert.equal(ranked[1].tier, 1);
});

test('a title match outranks any number of body matches', () => {
  const docs = [
    sdoc({ t: '部署手册', x: 'docker docker docker docker docker docker docker docker', u: '/body' }),
    sdoc({ t: 'Docker 实践笔记', x: '一点引言', u: '/title' }),
  ].map(prepare);
  const ranked = rankPages(docs, ['docker'], false);
  assert.equal(ranked[0].pageDoc.doc.u, '/title');
});

test('sections become rows only on their own matches; the page row is always the page doc', () => {
  const docs = [
    sdoc({ t: 'Docker 实践笔记', x: '引言', u: '/a' }),
    sdoc({ t: 'Docker 实践笔记', h: '安装', x: '安装 docker 的步骤', u: '/a#安装' }),
    sdoc({ t: 'Docker 实践笔记', h: '清理', x: '删除镜像', u: '/a#清理' }),
    sdoc({ t: '部署手册', x: '引言', u: '/b' }),
    sdoc({ t: '部署手册', h: '安装', x: 'docker 步骤', u: '/b#安装' }),
  ].map(prepare);
  const ranked = rankPages(docs, ['docker'], false);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].pageDoc.doc.u, '/a');
  assert.deepEqual(ranked[0].sections.map((s) => s.prep.doc.h), ['安装']);
  // /b qualifies only through its section body; the page row still points at the page doc
  assert.equal(ranked[1].pageDoc.doc.u, '/b');
  assert.equal(ranked[1].pageDoc.doc.h, '');
  assert.equal(ranked[1].sections.length, 1);
});

test('compact rescue: a CJK+Latin spacing mismatch still counts as a title match', () => {
  const docs = [
    sdoc({ t: '单用户 root 模式', x: '正文', u: '/a' }),
    sdoc({ t: '其他', h: '关于 root 模式', x: '', u: '/b#h' }),
  ].map(prepare);
  const ranked = rankPages(docs, ['root模式'], false);
  assert.equal(ranked[0].tier, 0);
  assert.equal(ranked[0].pageDoc.doc.u, '/a');
  assert.equal(ranked[1].tier, 1);
});

test('every token must match somewhere in a doc', () => {
  const docs = [sdoc({ t: 'Docker 笔记', x: '只有 docker', u: '/a' })].map(prepare);
  assert.equal(rankPages(docs, ['docker', 'compose'], false).length, 0);
});

test('tag mode: one row per page, sections never listed, content order kept', () => {
  const docs = [
    sdoc({ t: 'A', g: ['docker', 'ops'], u: '/a' }),
    sdoc({ t: 'A', h: '小节', g: ['docker'], x: '内容', u: '/a#sec' }),
    sdoc({ t: 'B', g: ['docker'], u: '/b' }),
    sdoc({ t: 'C', g: ['ops'], u: '/c' }),
  ].map(prepare);
  const ranked = rankPages(docs, ['docker'], true);
  assert.deepEqual(ranked.map((p) => p.pageDoc.doc.u), ['/a', '/b']);
  assert.equal(ranked[0].sections.length, 0);
});

test('splitSections skips link-card text: external og metadata is not search corpus', () => {
  const html =
    '<h2 id="s">节</h2>' +
    '<p class="link-card-row"><a class="link-card" href="https://a.io/x"><span class="lc-title">External Title Words</span><span class="lc-desc">og description text</span></a></p>' +
    '<p>本页自己的正文词汇。</p>';
  const s = splitSections(html);
  assert.ok(s.length >= 1);
  assert.ok(!s.some((x) => x.text.includes('External Title')), JSON.stringify(s));
  assert.ok(s.some((x) => x.text.includes('本页自己的正文词汇')));
});
