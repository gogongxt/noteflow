// RSS feed and robots.txt.
import { datePart } from '../core/util.ts';
import type { SiteCtx } from './layout.ts';
import { absUrl, descriptionOf, titleOf } from './helpers.ts';
import { byRecency } from './aggregates.ts';

function xmlEsc(str: unknown): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/** 'YYYY-MM-DD' to the RFC-822 string for that day, 00:00:00 UTC. */
function rfc822(dateStr: unknown): string | null {
  const d = datePart(dateStr);
  if (!d) return null;
  const dt = new Date(`${d}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toUTCString();
}

export function renderFeed(ctx: SiteCtx): string {
  const site = ctx.site;
  // Newest first: ctx.pages is in directory-walk order.
  const items = ctx.pages
    .filter((p) => p.kind === 'note' && datePart(p.date))
    .sort(byRecency)
    .slice(0, site.pageSize.feed);
  const lastBuild = ctx.builtAt.toUTCString();
  const home = absUrl(site, '/');
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '<channel>',
    `<title>${xmlEsc(site.siteName)}</title>`,
    `<link>${xmlEsc(home)}</link>`,
    `<description>${xmlEsc(site.description || `${site.siteName} — knowledge base and blog`)}</description>`,
    `<language>${xmlEsc(site.lang || 'en')}</language>`,
    `<lastBuildDate>${xmlEsc(lastBuild)}</lastBuildDate>`,
    `<atom:link href="${xmlEsc(absUrl(site, '/feed.xml'))}" rel="self" type="application/rss+xml"/>`,
  ];
  for (const p of items) {
    const link = absUrl(site, p.href);
    const desc = descriptionOf(p, 200);
    lines.push(
      '<item>',
      `<title>${xmlEsc(titleOf(p))}</title>`,
      `<link>${xmlEsc(link)}</link>`,
      `<guid isPermaLink="true">${xmlEsc(link)}</guid>`,
      `<pubDate>${xmlEsc(rfc822(p.date))}</pubDate>`,
      `<description>${xmlEsc(desc)}</description>`,
      '</item>',
    );
  }
  lines.push('</channel>', '</rss>', '');
  return lines.join('\n');
}

export function renderRobots(): string {
  return 'User-agent: *\nAllow: /\n';
}
