// The site footer: copyright, extra links, ICP filing number, and the
// "Built with noteflow" credit. Every piece is config-driven and renders only
// when configured; the default footer is just the copyright line and credit.
import { esc } from '../core/util.ts';
import type { SiteCtx } from './layout.ts';
import { siteUrl } from './helpers.ts';
import { siteHostOf, type FooterConfig, type FooterLink } from '../core/config.ts';
import { isOffsiteHref } from '../render/links.ts';

const PROJECT_NAME = 'noteflow';
const PROJECT_REPO = 'https://github.com/gogongxt/noteflow';
const ICP_QUERY = 'https://beian.miit.gov.cn/';
const DEFAULT_COPYRIGHT = '© {year} {site}';

/** A site path gains the base path; an absolute URL stays as it is. */
function resolveHref(ctx: SiteCtx, href: string): string {
  return href.startsWith('/') ? siteUrl(ctx.site, href) : href;
}

/** Same policy as note links and the output audit: another host opens a new
 *  tab, anything on this site (or mailto:/tel:) stays in the current one. */
export function footerAnchor(ctx: SiteCtx, label: string, href: string, cls = ''): string {
  const url = resolveHref(ctx, href);
  const offsite = isOffsiteHref(url, siteHostOf(ctx.site.url));
  const attrs = offsite ? ' target="_blank" rel="noopener noreferrer"' : '';
  return `<a${cls ? ` class="${cls}"` : ''} href="${esc(url)}"${attrs}>${esc(label)}</a>`;
}

function anchor(ctx: SiteCtx, label: string, href: string): string {
  return footerAnchor(ctx, label, href);
}

/** `© {year} {site}`: the year expands to `since–year` once `since` is set. */
function copyrightText(footer: FooterConfig, siteName: string, now: Date): string | null {
  const template = footer.copyright?.trim() || DEFAULT_COPYRIGHT;
  const year = new Date(now).getUTCFullYear();
  const range = footer.since && footer.since < year ? `${footer.since}–${year}` : String(year);
  return esc(template).replace(/\{year\}/g, range).replace(/\{site\}/g, esc(siteName));
}

/** One row of the footer's normal flow: a border, then identity on the left and
 *  the credit/ICP on the right. Below 768px it wraps into stacked lines. */
export function footer(ctx: SiteCtx): string {
  const cfg: FooterConfig = ctx.site.footer ?? {};
  const copyright = copyrightText(cfg, ctx.site.siteName, ctx.builtAt);
  const links = (cfg.links ?? []).filter((l: FooterLink) => l.label && l.href);

  const identity: string[] = [];
  if (copyright) identity.push(`<span class="foot-copy">${copyright}</span>`);
  if (links.length) {
    identity.push(
      '<nav class="foot-links" aria-label="Footer">\n<ul>\n' +
        links.map((l) => `<li>${anchor(ctx, l.label, l.href)}</li>`).join('\n') +
        '\n</ul>\n</nav>',
    );
  }

  const meta: string[] = [];
  if (cfg.icp) {
    const href = cfg.icpUrl?.trim() || ICP_QUERY;
    meta.push(`<a class="foot-icp" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(cfg.icp)}</a>`);
  }
  if (cfg.credit !== false) {
    meta.push(
      `<span class="foot-credit">Built with <a href="${PROJECT_REPO}" target="_blank" rel="noopener noreferrer">${PROJECT_NAME}</a></span>`,
    );
  }

  const row =
    '<div class="foot-row">\n' +
    `<div class="foot-identity">${identity.length ? '\n' + identity.join('\n') + '\n' : ''}</div>\n` +
    `<div class="foot-meta">${meta.length ? '\n' + meta.join('\n') + '\n' : ''}</div>\n` +
    '</div>';
  return `<footer class="site-footer" data-region="footer">\n${row}\n</footer>`;
}