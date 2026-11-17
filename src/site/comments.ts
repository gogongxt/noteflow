// giscus container: config attributes only; the iframe is created on demand.
import { esc } from '../core/util.ts';
import type { Page } from '../core/types.ts';
import type { SiteCtx } from './layout.ts';
import type { SiteConfig } from '../core/config.ts';
import { absUrl } from './helpers.ts';

/** Discussion mapping key: fixed at build time, decoupled from URL shape (with
 *  or without .html, trailing slash). Existing discussions all used
 *  `posts/<abbrlink>`, so the term must never be derived from page.href. */
export function discussionTerm(site: SiteConfig, p: Page): string {
  const pattern = String(site.postPattern || '/posts/{abbrlink}');
  return pattern
    .replace(/^\//, '')
    .replace(/\{abbrlink\}/g, p.abbrlink)
    .replace(/\{\{?\w+\}?\}/g, '')
    .replace(/\.(?:\w+)$/, '')
    .replace(/\/+$/, '');
}

/** The iframe is created on demand (js/comments.ts): server-rendering it would
 *  hit the third party on first paint, and its height goes through CSSOM. */
export function giscusComments(ctx: SiteCtx, page: Page): string {
  const cfg = ctx.site.giscus;
  if (!cfg || !cfg.repo || !cfg.repoId) return '';
  if (page.kind !== 'note' || !page.comments) return '';
  const term = discussionTerm(ctx.site, page);
  const canonical = absUrl(ctx.site, page.href);
  const attr = ` data-giscus data-repo="${esc(cfg.repo)}" data-repo-id="${esc(cfg.repoId)}"` +
    (cfg.category ? ` data-category="${esc(cfg.category)}"` : '') +
    (cfg.categoryId ? ` data-category-id="${esc(cfg.categoryId)}"` : '') +
    ` data-term="${esc(term)}" data-canonical="${esc(canonical)}"` +
    ` data-lang="${esc(cfg.lang || ctx.site.lang || 'en')}"` +
    ` data-reactions="${cfg.reactionsEnabled === false ? '0' : '1'}"` +
    ` data-input-position="${cfg.inputPosition === 'top' ? 'top' : 'bottom'}"`;
  const label = page.toc.length ? 'Join the discussion' : 'Comments';
  const icon =
    '<svg class="comments-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
    '<path d="M20.5 11.6a7.7 7.7 0 0 1-8.3 7.7 8.7 8.7 0 0 1-3.8-1L4 19.5l1.2-4.1a8.6 8.6 0 0 1-1.3-3.8 7.7 7.7 0 0 1 8.3-7.7 7.7 7.7 0 0 1 8.3 7.7z"/></svg>';
  return (
    '\n<section class="comments" id="comments" aria-labelledby="comments-heading">\n' +
    `<div class="comments-head">\n<span class="comments-title" id="comments-heading">${icon}${esc(label)}</span>\n` +
    '<a class="comments-hint" href="https://giscus.app" target="_blank" rel="noopener noreferrer nofollow">Powered by GitHub Discussions</a>\n</div>\n' +
    `<div class="comments-mount"${attr}></div>\n` +
    '</section>\n'
  );
}
