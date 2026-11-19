// sitemap.xml and robots.txt.
import { datePart } from '../core/util.ts';
import type { SiteCtx } from './layout.ts';
import type { Page } from '../core/types.ts';
import { absUrl } from './helpers.ts';
import { collectTags, tagLink } from './tags.ts';

export function xmlEsc(str: unknown): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/** The freshness signal for a page: `updated` when the author set it, else `date`. */
function lastModified(page: Page): string | null {
  return datePart(page.updated) ?? datePart(page.date);
}

/** Newest lastmod in a set; an aggregate page (home, archives, a tag) changes
 *  when its newest member does. */
function newest(pages: Page[]): string | null {
  let best: string | null = null;
  for (const p of pages) {
    const d = lastModified(p);
    if (d && (!best || d > best)) best = d;
  }
  return best;
}

interface Entry {
  href: string;
  lastmod: string | null;
}

/** One <url> per indexable route: the three fixed pages, every tag page, and
 *  every public note. 404 and the feed are not pages; private notes are
 *  physically absent from `ctx.pages`. */
function entries(ctx: SiteCtx): Entry[] {
  const notes = ctx.pages.filter((p) => p.kind === 'note');
  const tags = [...collectTags(ctx.pages).values()];
  const newestNote = newest(notes);
  const list: Entry[] = [
    { href: absUrl(ctx.site, '/'), lastmod: newestNote },
    { href: absUrl(ctx.site, '/archives'), lastmod: newestNote },
    { href: absUrl(ctx.site, '/tags'), lastmod: newestNote },
    ...tags.map((t) => ({ href: absUrl(ctx.site, tagLink(ctx, t.name)), lastmod: newest(t.pages) })),
    ...ctx.pages.map((p) => ({ href: absUrl(ctx.site, p.href), lastmod: lastModified(p) })),
  ];
  const seen = new Set<string>();
  return list.filter((e) => !seen.has(e.href) && seen.add(e.href));
}

export function renderSitemap(ctx: SiteCtx): string {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
  for (const e of entries(ctx)) {
    lines.push('<url>', `<loc>${xmlEsc(e.href)}</loc>`);
    if (e.lastmod) lines.push(`<lastmod>${xmlEsc(e.lastmod)}</lastmod>`);
    lines.push('</url>');
  }
  lines.push('</urlset>', '');
  return lines.join('\n');
}

export function renderRobots(ctx: SiteCtx): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${absUrl(ctx.site, '/sitemap.xml')}\n`;
}