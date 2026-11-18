import { parseFragment } from 'parse5';
import { datePart } from '../core/util.ts';
import { getAttr, type P5Any } from '../core/dom.ts';
import { summaryPlainText } from '../content/summary.ts';
import type { Page } from '../core/types.ts';

export interface SearchDoc {
  u: string;
  t: string;
  f: string;
  h: string;
  p: string[];
  g: string[];
  d: string;
  k: 'note' | 'index';
  x: string;
}

interface SearchIndex {
  v: 1;
  docs: SearchDoc[];
}

interface Section {
  id: string;
  heading: string;
  level: number;
  text: string;
}

const SKIP = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'math',
  'iframe', 'object', 'embed', 'button', 'input', 'select', 'textarea',
]);

const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
  'figure', 'figcaption', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'br', 'details', 'summary', 'caption',
]);

const MAX_TEXT = 5000;

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function resolveId(node: P5Any): string {
  let cur: P5Any | null | undefined = node;
  while (cur) {
    const id = getAttr(cur, 'id');
    if (id) return id;
    cur = cur.parentNode;
  }
  return '';
}

export function splitSections(html: string): Section[] {
  const frag = parseFragment(html || '') as unknown as P5Any;
  const out: Section[] = [];
  let cur: { id: string; heading: string; level: number; buf: string[] } = {
    id: '',
    heading: '',
    level: 0,
    buf: [],
  };

  const flush = (): void => {
    const text = norm(cur.buf.join(''));
    if (cur.heading || text) out.push({ id: cur.id, heading: cur.heading, level: cur.level, text });
    cur = { id: '', heading: '', level: 0, buf: [] };
  };

  const visit = (node: P5Any): void => {
    if (SKIP.has(node.nodeName)) return;
    const cls = (getAttr(node, 'class') || '').split(/\s+/);
    // Build-time chrome (code-lang, code-title) and external og text
    // (link-card) are not the author's prose; keep them out of the corpus.
    if (cls.includes('code-lang') || cls.includes('code-title') || cls.includes('link-card')) return;
    const hm = /^h([1-3])$/.exec(node.nodeName);
    if (hm) {
      const heading = norm(collect(node));
      // A textless heading (e.g. only an SVG) is not a section boundary.
      if (heading) {
        flush();
        cur.id = resolveId(node);
        cur.heading = heading;
        cur.level = Number(hm[1]);
      } else {
        cur.buf.push(' ');
      }
      return;
    }
    if (node.nodeName === '#text') {
      cur.buf.push(node.value ?? '');
      return;
    }
    if (node.nodeName === 'img') {
      const alt = getAttr(node, 'alt');
      if (alt) cur.buf.push(' ', alt, ' ');
      return;
    }
    if (node.nodeName === 'br' || node.nodeName === 'hr') {
      cur.buf.push(' ');
      return;
    }
    const block = BLOCK.has(node.nodeName);
    if (block) cur.buf.push(' ');
    for (const c of node.childNodes ?? []) visit(c);
    if (block) cur.buf.push(' ');
  };

  for (const c of frag.childNodes ?? []) visit(c);
  flush();
  return out;
}

function collect(node: P5Any): string {
  const out: string[] = [];
  const push = (n: P5Any): void => {
    if (SKIP.has(n.nodeName)) return;
    if (n.nodeName === '#text') {
      out.push(n.value ?? '');
      return;
    }
    if (n.nodeName === 'br' || n.nodeName === 'hr') {
      out.push(' ');
      return;
    }
    if (n.nodeName === 'img') {
      const alt = getAttr(n, 'alt');
      if (alt) out.push(' ', alt, ' ');
      return;
    }
    const block = BLOCK.has(n.nodeName);
    if (block) out.push(' ');
    for (const c of n.childNodes ?? []) push(c);
    if (block) out.push(' ');
  };
  push(node);
  return out.join('');
}

interface IndexOptions {
  dirsOf?: (page: Page) => string[];
}

export function buildSearchIndex(pages: Page[], opts: IndexOptions = {}): SearchIndex {
  const dirsOf = opts.dirsOf ?? (() => []);
  const docs: SearchDoc[] = [];

  for (const page of pages) {
    if (!page.href) continue;
    const dirs = dirsOf(page);
    const file = page.relPath.split('/').pop() ?? '';
    const base: Omit<SearchDoc, 'u' | 'h' | 'x'> = {
      t: page.title,
      f: file.replace(/\.md$/i, ''),
      p: dirs,
      g: page.tags.filter(Boolean).map(String),
      d: datePart(page.date) ?? '',
      k: page.kind === 'index' ? 'index' : 'note',
    };

    const sections = splitSections(page.html || '');
    const leadParts: string[] = [];
    if (sections[0]?.level === 0) leadParts.push(sections.shift()!.text);
    // A leading h1 equal to the title would only repeat the group header.
    if (sections[0]?.level === 1 && norm(sections[0].heading) === norm(page.title)) {
      leadParts.push(sections.shift()!.text);
    }

    const description = page.description ? norm(String(page.description)) : '';
    const summary = page.summary ? summaryPlainText(page.summary) : '';
    const leadText = norm([description, summary, ...leadParts].filter(Boolean).join(' '));
    docs.push({ ...base, u: page.href, h: '', x: leadText.slice(0, MAX_TEXT) });

    const seen = new Set<string>();
    for (const s of sections) {
      if (!s.heading && !s.text) continue;
      const anchor = s.id ? `#${encodeURIComponent(s.id)}` : '';
      if (anchor) {
        if (seen.has(anchor)) continue;
        seen.add(anchor);
      }
      docs.push({
        ...base,
        u: page.href + anchor,
        h: s.heading,
        x: s.text.slice(0, MAX_TEXT),
      });
    }
  }

  return { v: 1, docs };
}
