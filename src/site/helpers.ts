// Shared HTML helpers for the page templates.
import { datePart, decodeEntities, esc } from '../core/util.ts';
import { basePathOf, siteUrlOf } from '../core/config.ts';
import type { Page, SidebarItem } from '../core/types.ts';
import type { SiteCtx } from './layout.ts';
import type { SiteConfig } from '../core/config.ts';

export function fmtDate(d: unknown): string {
  const v = datePart(d);
  return v ? `<time datetime="${esc(v)}">${esc(v)}</time>` : '';
}

/** A site-root-relative path (`/archives`, `/feed.xml`) ready for an href. */
export function siteUrl(site: SiteConfig | undefined, p: string): string {
  return siteUrlOf(String(site?.url ?? ''), p);
}

/** Absolute URL for feed/canonical use. Takes site-rel paths and emitted hrefs
 *  alike: a base path already present is stripped, then applied exactly once. */
export function absUrl(site: SiteConfig | undefined, p: string): string {
  const raw = String(site?.url ?? '');
  const path = p.startsWith('/') ? p : `/${p}`;
  if (!raw) return path;
  const { origin } = new URL(raw);
  const base = basePathOf(raw);
  const rel = base && (path === base || path.startsWith(base + '/')) ? path.slice(base.length) || '/' : path;
  return origin + base + rel;
}

export function pageTitleHtml(ctx: SiteCtx, title: string, extra?: string): string {
  return extra ? `${esc(title)} · ${esc(extra)} · ${esc(ctx.site.siteName)}` : `${esc(title)} · ${esc(ctx.site.siteName)}`;
}

export function descriptionOf(page: Page, limit = 160): string {
  if (page.description) return String(page.description).trim();
  return firstParagraph(page.html || '', limit);
}

// `>` inside a quoted attribute does not close the tag.
const TAG = /<(?:"[^"]*"|'[^']*'|[^'">])*>/g;

export function firstParagraph(html: string, limit = 200): string {
  const src = String(html || '');
  // Skip link-card rows: external og metadata is not the page's own prose.
  let text = '';
  for (const m of src.matchAll(/<p\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/p>/gi)) {
    if (/\blink-card-row\b/.test(m[1])) continue;
    text = m[2];
    break;
  }
  text = decodeEntities(text.replace(TAG, '').replace(/&nbsp;/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(text);
  return chars.length > limit ? chars.slice(0, limit).join('') + '…' : text;
}

export function titleOf(page: Page | null | undefined): string {
  return String(page?.title ?? '');
}

export function ancestorsOf(ctx: SiteCtx, page: Page): SidebarItem[] {
  return ctx.ancestorsOf.get(page.relPath) || [];
}
