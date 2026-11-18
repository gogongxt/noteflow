// The site header and the page-kind identity its active state keys on.
import { esc } from '../core/util.ts';
import type { SiteCtx } from './layout.ts';
import { siteUrl } from './helpers.ts';

function themeToggle(): string {
  return (
    '<button type="button" id="theme-toggle" class="icon-btn theme-toggle" data-theme-toggle aria-label="Toggle theme" title="Toggle theme">' +
    '<svg class="icon icon-sun" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">' +
    '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/>' +
    '</svg>' +
    '<svg class="icon icon-moon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">' +
    '<path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/>' +
    '</svg></button>'
  );
}

function menuToggle(): string {
  return (
    '<button type="button" id="menu-toggle" class="icon-btn menu-toggle" data-sidebar-collapse aria-controls="sidebar" aria-label="Menu" title="Menu" aria-expanded="true">' +
    '<svg class="icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
    '<path d="M4 7h16M4 12h16M4 17h16"/></svg></button>'
  );
}

function logoMark(): string {
  return (
    '<svg class="logo-mark" viewBox="0 0 32 32" width="24" height="24" aria-hidden="true" focusable="false">' +
    '<defs>' +
    '<linearGradient id="logo-ink" gradientUnits="userSpaceOnUse" x1="12.1" y1="0" x2="19.3" y2="0"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#6e6e73"/></linearGradient>' +
    '</defs>' +
    '<circle cx="16" cy="16" r="16" fill="#000"/>' +
    '<rect x="9.4" y="6.6" width="13.2" height="16.4" rx="2.7" fill="#fff" fill-opacity=".42" stroke="#000" stroke-width="1.4" transform="rotate(-24 16 23.6)"/>' +
    '<rect x="9.4" y="6.6" width="13.2" height="16.4" rx="2.7" fill="#fff" fill-opacity=".62" stroke="#000" stroke-width="1.4" transform="rotate(-8 16 23.6)"/>' +
    '<rect x="9.4" y="6.6" width="13.2" height="16.4" rx="2.7" fill="#fff" fill-opacity=".81" stroke="#000" stroke-width="1.4" transform="rotate(8 16 23.6)"/>' +
    '<g transform="rotate(24 16 23.6)">' +
    '<rect x="9.4" y="6.6" width="13.2" height="16.4" rx="2.7" fill="#fff"/>' +
    '<path d="M12.1 10.6h7.2M12.1 14.6h5.6" fill="none" stroke="url(#logo-ink)" stroke-width="1.5" stroke-linecap="round"/>' +
    '<path d="M12.1 18.6q1.7-2.2 3.4 0t3.4 0" fill="none" stroke="url(#logo-ink)" stroke-width="1.3" stroke-linecap="round"/>' +
    '</g>' +
    '</svg>'
  );
}

/** A page's identity: `article.page-<kind>` alone selects page CSS and lights
 *  the matching nav entry — never the <body>, which every page shares. */
export type PageKind = 'home' | 'post' | 'index' | 'archives' | 'tags' | 'tag' | '404';

export function pageClass(kind: PageKind): string {
  return `page-${kind}`;
}

const navItems = (ctx: SiteCtx): { href: string; label: string; kinds: PageKind[] }[] => [
  { href: siteUrl(ctx.site, '/archives'), label: 'Archives', kinds: ['archives'] },
  { href: siteUrl(ctx.site, '/tags'), label: 'Tags', kinds: ['tags', 'tag'] },
  { href: siteUrl(ctx.site, '/feed.xml'), label: 'RSS', kinds: [] },
];

function searchTrigger(searchIndex: string): string {
  const indexAttr = searchIndex ? ` data-search-index="${esc(searchIndex)}"` : '';
  return (
    `<button type="button" class="search-trigger" data-search-open${indexAttr} aria-label="Search notes" aria-haspopup="dialog" title="Search (Ctrl K / ⌘K)">` +
    '<svg class="search-trigger-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
    '<circle cx="10.8" cy="10.8" r="6.2"/><path d="M15.4 15.4 19.4 19.4"/></svg>' +
    '<span class="search-trigger-label">Search</span>' +
    '<kbd class="search-trigger-kbd"><span class="kbd-ctrl">Ctrl </span><span class="kbd-meta">⌘</span>K</kbd>' +
    '</button>'
  );
}

/** An off-site link: the audit requires target="_blank" with both rel tokens. */
function repoLink(repoUrl: string | undefined): string {
  if (!repoUrl) return '';
  return (
    `<a class="icon-btn repo-link" href="${esc(repoUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Source repository" title="Source repository">` +
    '<svg class="icon" viewBox="0 0 16 16" width="17" height="17" aria-hidden="true" focusable="false">' +
    '<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>' +
    '</svg></a>'
  );
}

function navSpinner(): string {
  return '<span class="nav-spinner" data-nav-spinner aria-hidden="true"></span>';
}

export function header(ctx: SiteCtx, opts: { kind: PageKind; hasSidebar?: boolean; breadcrumbs?: string }): string {
  const { kind, hasSidebar = true, breadcrumbs = '' } = opts;
  const siteName = esc(ctx.site.siteName);
  const brand = `<a class="brand" href="${esc(siteUrl(ctx.site, '/'))}" aria-label="Back to home">${logoMark()}<span class="brand-name">${siteName}</span></a>`;
  const nav = navItems(ctx).map((n) => {
    const active = n.kinds.includes(kind) ? ' aria-current="page" class="is-active"' : '';
    return `<li><a href="${n.href}"${active}>${n.label}</a></li>`;
  }).join('');
  // data-region marks what soft navigation swaps; keeping the outer element
  // identity stable means the sticky header is never repainted.
  return (
    '<div id="nav-backdrop" class="nav-backdrop" hidden aria-hidden="true"></div>\n' +
    `<header class="site-header${hasSidebar ? ' has-sidebar' : ''}" data-region="header">\n` +
    '<div class="header-inner">\n' +
    (hasSidebar ? menuToggle() + '\n' : '') +
    brand + '\n' +
    (breadcrumbs ? `<div class="header-crumbs" data-region="crumbs">${breadcrumbs}</div>\n` : '') +
    `<div class="header-actions">\n${searchTrigger(ctx.assets.searchIndex)}\n<nav class="top-nav" aria-label="Site navigation"><ul>${nav}</ul></nav>\n${repoLink(ctx.site.repoUrl)}\n</div>\n` +
    themeToggle() + '\n' +
    navSpinner() + '\n' +
    '</div>\n' +
    '</header>'
  );
}
