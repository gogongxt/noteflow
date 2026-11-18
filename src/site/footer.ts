// The site footer: one quiet line under the article — the theme mark, the ©
// line (linked), and an author credit — with the ICP filing number on the
// right. Every piece is config-driven and renders only when configured.
import { esc } from '../core/util.ts';
import type { SiteCtx } from './layout.ts';
import { siteUrl } from './helpers.ts';
import { siteHostOf, type FooterConfig } from '../core/config.ts';
import { isOffsiteHref } from '../render/links.ts';
import { logoMark } from './logo.ts';

const PROJECT_REPO = 'https://github.com/gogongxt/noteflow';
const ICP_QUERY = 'https://beian.miit.gov.cn/';
const DEFAULT_COPYRIGHT = '© {year} {site}';

function anchor(ctx: SiteCtx, inner: string, href: string, className: string): string {
  const url = href.startsWith('/') ? siteUrl(ctx.site, href) : href;
  // Same policy as note links and the output audit: another host opens a new
  // tab, anything on this site (or mailto:/tel:) stays in the current one.
  const attrs = isOffsiteHref(url, siteHostOf(ctx.site.url)) ? ' target="_blank" rel="noopener noreferrer"' : '';
  return `<a class="${className}" href="${esc(url)}"${attrs}>${inner}</a>`;
}

/** `© {year} {site}`: the year expands to `since–year` once `since` is set. */
function copyrightText(footer: FooterConfig, siteName: string, now: Date): string {
  const template = footer.copyright?.trim() || DEFAULT_COPYRIGHT;
  const year = new Date(now).getUTCFullYear();
  const range = footer.since && footer.since < year ? `${footer.since}–${year}` : String(year);
  return esc(template).replace(/\{year\}/g, range).replace(/\{site\}/g, esc(siteName));
}

/** The identity cluster: theme mark, the © line and the author credit, all
 *  reading as one line of small text. */
function identity(ctx: SiteCtx): string {
  const cfg: FooterConfig = ctx.site.footer ?? {};
  const parts: string[] = [];
  const mark = cfg.credit === false ? '' : logoMark({ size: 18, id: 'footer-logo-ink', className: 'foot-mark' });
  const copy = copyrightText(cfg, ctx.site.siteName, ctx.builtAt);

  // One link in this cluster, never two adjacent ones to the same place: a
  // linked © line takes the mark in with it, and a bare mark is the theme
  // credit on its own.
  if (cfg.copyrightUrl) parts.push(anchor(ctx, mark + copy, cfg.copyrightUrl, 'foot-copy'));
  else if (mark) parts.push(anchor(ctx, mark, PROJECT_REPO, 'foot-brand') + `<span class="foot-copy">${copy}</span>`);
  else parts.push(`<span class="foot-copy">${copy}</span>`);

  if (cfg.author) {
    const author = esc(cfg.author);
    parts.push(`<span class="foot-by">By ${cfg.authorUrl ? anchor(ctx, author, cfg.authorUrl, 'foot-author') : author}</span>`);
  }

  return `<div class="foot-identity">\n${parts.join('\n')}\n</div>`;
}

export function footer(ctx: SiteCtx): string {
  const cfg: FooterConfig = ctx.site.footer ?? {};
  const icp = cfg.icp
    ? `<div class="foot-meta">\n${anchor(ctx, esc(cfg.icp), cfg.icpUrl?.trim() || ICP_QUERY, 'foot-icp')}\n</div>\n`
    : '';
  return `<footer class="site-footer" data-region="footer">\n<div class="foot-row">\n${identity(ctx)}\n${icp}</div>\n</footer>`;
}