// Sidebar tree, breadcrumbs and their fly-out menus.
import { esc } from '../core/util.ts';
import type { Page, SidebarItem } from '../core/types.ts';
import type { SiteCtx } from './layout.ts';
import { siteUrl } from './helpers.ts';

// Groups ship closed; ui-boot.ts opens the current chain before paint.
function sidebarItemHtml(ctx: SiteCtx, item: SidebarItem, page: Page | null): string {
  const href = item.href ? String(item.href) : null;
  const active = !!page && !!href && href === page.href;
  const children = item.children;
  const label = href
    ? `<a class="tree-link" href="${esc(href)}"${active ? ' aria-current="page"' : ''}>${esc(item.title)}</a>`
    : `<span class="tree-label">${esc(item.title)}</span>`;

  if (!children.length) return `<li class="tree-item">${label}</li>`;

  const ul = '<ul>\n' + children.map((c) => sidebarItemHtml(ctx, c, page)).join('\n') + '\n</ul>';
  const tw =
    '<button type="button" class="tw" data-tree-toggle aria-expanded="false" aria-label="Expand or collapse">' +
    '<svg class="tw-icon" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false">' +
    '<path d="M6 3.5 10.5 8 6 12.5"/></svg></button>';
  return (
    `<li class="tree-item has-children">\n<details data-key="${esc(item.relPath)}"${href ? ` data-href="${esc(href)}"` : ''}>\n` +
    `<summary>${tw}${label}</summary>\n${ul}\n</details>\n</li>`
  );
}

/** Every group's relPath, which the client uses as its open-state key. */
export function sidebarKeys(items: SidebarItem[]): string[] {
  const out: string[] = [];
  const walk = (list: SidebarItem[]): void => {
    for (const it of list) {
      if (it.children.length) out.push(it.relPath);
      walk(it.children);
    }
  };
  walk(items);
  return out;
}

export function countNotes(items: SidebarItem[]): number {
  let n = 0;
  for (const it of items) {
    if (it.href) n++;
    n += countNotes(it.children);
  }
  return n;
}

export function sidebar(ctx: SiteCtx, { currentPage = null }: { currentPage?: Page | null } = {}): string {
  const items: SidebarItem[] = Array.isArray(ctx.sidebar) ? ctx.sidebar : [];
  const tree = items.length
    ? '<ul class="tree">\n' + items.map((i) => sidebarItemHtml(ctx, i, currentPage)).join('\n') + '\n</ul>'
    : '<p class="tree-empty">No public notes yet</p>';
  const keys = esc(JSON.stringify(sidebarKeys(items)));
  return (
    '<aside id="sidebar" class="sidebar" data-tree-groups="' + keys + '">\n' +
    '<div class="sidebar-filter">\n' +
    '<svg class="tf-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M10.8 4.6a6.2 6.2 0 1 0 0 12.4 6.2 6.2 0 0 0 0-12.4Z"/><path d="M15.4 15.4 19.4 19.4"/></svg>\n' +
    '<input type="text" id="tree-filter" class="tree-filter" placeholder="Filter notes…" autocomplete="off" spellcheck="false" aria-label="Filter notes by name">\n' +
    '<button type="button" class="tf-clear" aria-label="Clear filter" hidden>' +
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg></button>\n' +
    '<span class="tf-count"></span>\n' +
    '<button type="button" class="tf-all" data-tree-all aria-label="Expand all" title="Expand all" aria-expanded="false">' +
    '<svg class="tf-all-svg" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<g class="tf-all-out"><path d="M9.5 9.5 4.5 4.5M8.5 4.5H4.5V8.5M14.5 14.5 19.5 19.5M15.5 19.5H19.5V15.5"/></g>' +
    '<g class="tf-all-in"><path d="M4.5 4.5 9.5 9.5M5.5 9.5H9.5V5.5M19.5 19.5 14.5 14.5M18.5 14.5H14.5V18.5"/></g></svg></button>\n' +
    '</div>\n' +
    '<nav class="sidebar-nav" aria-label="Note directory">\n' +
    tree + '\n' +
    '</nav>\n' +
    '<nav class="sidebar-foot" aria-label="Site navigation">\n' +
    `<a href="${esc(siteUrl(ctx.site, '/archives'))}">Archives</a><a href="${esc(siteUrl(ctx.site, '/tags'))}">Tags</a><a href="${esc(siteUrl(ctx.site, '/feed.xml'))}">RSS</a>\n</nav>\n` +
    '<div class="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="Resize sidebar (drag or arrow keys)" tabindex="0" data-sidebar-resizer></div>\n' +
    '</aside>'
  );
}

export interface Crumb {
  title: string;
  href?: string | null;
  level?: SidebarItem[];
  current?: boolean;
}

function menuItemHtml(item: SidebarItem, currentHref: string | null, crumbHref: string | null): string {
  const isCurrent = !!item.href && item.href === currentHref;
  const isCrumb = !isCurrent && !!item.href && item.href === crumbHref;
  const cls = isCurrent ? ' class="is-current"' : isCrumb ? ' class="is-crumb"' : '';
  const mark = isCurrent ? ' aria-current="page"' : '';
  const inner = item.href
    ? `<a href="${esc(item.href)}"${mark}${cls}>${esc(item.title)}</a>`
    : `<span class="menu-label"${cls}>${esc(item.title)}</span>`;
  if (!item.children.length) return `<li>${inner}</li>`;
  const sub = `\n<ul class="crumb-sub">\n${item.children.map((c) => menuItemHtml(c, currentHref, null)).join('\n')}\n</ul>`;
  return `<li class="has-sub">${inner}${sub}</li>`;
}

function crumbMenuHtml(items: SidebarItem[] | undefined, currentHref: string | null, crumbHref: string | null): string {
  if (!items?.length) return '';
  return (
    '<div class="crumb-menu">\n<ul class="crumb-menu-list">\n' +
    items.map((it) => menuItemHtml(it, currentHref, crumbHref)).join('\n') +
    '\n</ul>\n</div>'
  );
}

export function breadcrumbs(ctx: SiteCtx, items: Crumb[], currentHref: string | null): string {
  const all: Crumb[] = [{ title: 'Home', href: siteUrl(ctx.site, '/'), level: ctx.sidebar }, ...items];
  const lis = all.map((c) => {
    if (c.current) {
      return `<li class="crumb current" aria-current="page">\n<span tabindex="0" role="button" aria-haspopup="true">${esc(c.title)}</span>\n${crumbMenuHtml(c.level, currentHref, null)}</li>`;
    }
    const label = c.href ? `<a href="${esc(c.href)}">${esc(c.title)}</a>` : `<span>${esc(c.title)}</span>`;
    return `<li class="crumb">\n${label}\n${crumbMenuHtml(c.level, currentHref, c.href ?? null)}</li>`;
  });
  return '<nav class="crumbs" aria-label="Breadcrumb">\n<ol>\n' + lis.join('\n') + '\n</ol>\n</nav>';
}
