// Archives, tag pages, the 404 page, and the render-every-page map.
import { collator, datePart, esc } from '../core/util.ts';
import { siteRelOf } from '../core/config.ts';
import type { SiteCtx, Theme } from './layout.ts';
import type { Page, SidebarItem } from '../core/types.ts';
import type { SiteConfig } from '../core/config.ts';
import { absUrl, pageTitleHtml, siteUrl, titleOf } from './helpers.ts';
import { pageClass } from './header.ts';
import { breadcrumbs } from './sidebar.ts';
import { collectTags, tagDir, tagLink } from './tags.ts';
import { card, notePage, pageShell } from './page.ts';
import { countNotes } from './sidebar.ts';
import { renderHome } from './home.ts';

const COLLATOR = collator();

/** Newest first; ties break by title. The one ordering shared by the pager, home, archives and feed. */
export function byRecency(a: Page, b: Page): number {
  const da = datePart(a.date) ?? '';
  const db = datePart(b.date) ?? '';
  if (da !== db) return da < db ? 1 : -1;
  return COLLATOR.compare(titleOf(a), titleOf(b));
}

function renderArchives(ctx: SiteCtx, theme: Theme): string {
  const dated = ctx.pages.filter((p) => p.kind === 'note' && datePart(p.date));
  const byYear = new Map<string, Map<string, Page[]>>();
  for (const p of dated) {
    const d = datePart(p.date) ?? '';
    const y = d.slice(0, 4);
    const m = d.slice(5, 7);
    if (!byYear.has(y)) byYear.set(y, new Map());
    const byMonth = byYear.get(y)!;
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m)!.push(p);
  }
  const years = [...byYear.keys()].sort().reverse();
  let body: string;
  if (!years.length) {
    body = '<p class="empty">Nothing archived yet.</p>';
  } else {
    body = years
      .map((y) => {
        const months = [...byYear.get(y)!.entries()].sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
        const monthHtml = months
          .map(([m, list]) => {
            const sorted = list.slice().sort(byRecency);
            return (
              `<h3 class="archive-month"><time datetime="${esc(y)}-${esc(m)}">${esc(y)}-${esc(m)}</time><span class="archive-count">${sorted.length}</span></h3>\n` +
              '<ul class="archive">\n' +
              sorted
                .map((p) => {
                  const d = datePart(p.date) ?? '';
                  return `<li><a href="${esc(p.href)}"><time datetime="${esc(d)}">${esc(d)}</time><span class="archive-title">${esc(titleOf(p))}</span></a></li>`;
                })
                .join('\n') +
              '\n</ul>'
            );
          })
          .join('\n');
        return `<section class="archive-year" aria-labelledby="year-${esc(y)}">\n<h2 id="year-${esc(y)}">${esc(y)}<span class="archive-year-mark" aria-hidden="true"></span></h2>\n${monthHtml}\n</section>`;
      })
      .join('\n');
  }
  return pageShell(ctx, theme, {
    page: null,
    kind: 'archives',
    main: `<article class="${pageClass('archives')} post-layout no-toc">\n<h1>Archives</h1>\n${body}\n</article>`,
    title: pageTitleHtml(ctx, 'Archives'),
    description: esc(`All posts by date · ${ctx.site.siteName}`),
    canonical: absUrl(ctx.site, '/archives'),
    breadcrumbs: breadcrumbs(ctx, [{ title: 'Archives', current: true, level: ctx.sidebar }], null),
  });
}

function renderTags(ctx: SiteCtx, theme: Theme): string {
  const tags = [...collectTags(ctx.pages).values()];
  const col = collator();
  tags.sort((a, b) => b.pages.length - a.pages.length || col.compare(a.name, b.name));
  const body = tags.length
    ? '<ul class="tag-cloud">\n' +
      tags
        .map((t) => `<li><a class="tag" href="${esc(tagLink(ctx, t.name))}"><span class="tag-name">${esc(t.name)}</span> <span class="tag-count">${t.pages.length}</span></a></li>`)
        .join('\n') +
      '\n</ul>'
    : '<p class="empty">No tags yet.</p>';
  return pageShell(ctx, theme, {
    page: null,
    kind: 'tags',
    main: `<article class="${pageClass('tags')} post-layout no-toc">\n<h1>Tags</h1>\n${body}\n</article>`,
    title: pageTitleHtml(ctx, 'Tags'),
    description: esc(`All tags · ${ctx.site.siteName}`),
    canonical: absUrl(ctx.site, '/tags'),
    breadcrumbs: breadcrumbs(ctx, [{ title: 'Tags', current: true, level: ctx.sidebar }], null),
  });
}

function renderTagPage(ctx: SiteCtx, theme: Theme, name: string, pages: Page[]): string {
  const set = new Set(pages);
  const ordered = ctx.pages.filter((p) => set.has(p));
  const list = ordered.length
    ? '<ul class="post-list">\n' + ordered.map((p) => card(p)).join('\n') + '\n</ul>'
    : '<p class="empty">No posts under this tag yet.</p>';
  return pageShell(ctx, theme, {
    page: null,
    kind: 'tag',
    main: `<article class="${pageClass('tag')} post-layout no-toc">\n<h1>Tag: ${esc(name)}</h1>\n${list}\n</article>`,
    title: pageTitleHtml(ctx, `Tag: ${name}`),
    description: esc(`All posts tagged ${name} · ${ctx.site.siteName}`),
    canonical: absUrl(ctx.site, tagLink(ctx, name)),
    breadcrumbs: breadcrumbs(ctx, [{ title: 'Tags', href: siteUrl(ctx.site, '/tags'), level: ctx.sidebar }, { title: name, current: true, level: ctx.sidebar }], null),
  });
}

function render404(ctx: SiteCtx, theme: Theme): string {
  const dirs = ctx.sidebar.filter((it) => it.href || it.children.length).slice(0, 6);
  const dirLinks = dirs.length
    ? '<ul class="e404-dirs">\n' +
      dirs
        .map((it) => {
          const first = it.href ? it : firstLeaf(it);
          const href = first?.href;
          const count = countNotes([it]);
          return href
            ? `<li><a href="${esc(String(href))}"><span class="e404-dir-name">${esc(it.title)}</span><span class="e404-dir-count">${count}</span></a></li>`
            : '';
        })
        .join('\n') +
      '\n</ul>'
    : '';

  // Newest first, not directory-walk order.
  const recent = ctx.pages
    .filter((p) => p.kind === 'note' && p.href)
    .sort(byRecency)
    .slice(0, 3)
    .map((p) => {
      const raw = datePart(p.date);
      const d = raw ? `<span class="e404-recent-date">${esc(raw)}</span>` : '';
      return `<li><a href="${esc(String(p.href))}">${esc(titleOf(p))}</a>${d}</li>`;
    })
    .join('\n');

  const main =
    `<article class="${pageClass('404')}">\n` +
    '<div class="e404-hero">\n' +
    '<svg class="e404-art" viewBox="0 0 120 96" aria-hidden="true" focusable="false">' +
    '<path class="e404-sheet" d="M14 8h58l16 16v64H14z"/>' +
    '<path class="e404-fold" d="M72 8v16h16"/>' +
    '<path class="e404-tear" d="M30 38l20 8-14 12 18 10"/>' +
    '<circle class="e404-hole" cx="96" cy="70" r="17"/>' +
    '<path class="e404-q" d="M89 63a7 7 0 1 1 8.5 6.9c-1.4.3-2 1.3-2 2.6v1.2"/>' +
    '<circle class="e404-q-dot" cx="95.5" cy="80" r="2.2"/>' +
    '</svg>\n' +
    '<p class="e404-code">404</p>\n' +
    '<h1>Nothing here</h1>\n' +
    '<p class="e404-lede">The link may be broken, or this page never existed.</p>\n' +
    '</div>\n' +
    '<div class="e404-actions">\n' +
    `<a class="btn btn-primary" href="${esc(siteUrl(ctx.site, '/'))}">Back to home</a>` +
    `<a class="btn btn-primary" href="${esc(siteUrl(ctx.site, '/archives'))}">Browse archives</a>` +
    `<a class="btn btn-primary" href="${esc(siteUrl(ctx.site, '/tags'))}">Browse tags</a>\n` +
    '</div>\n' +
    (dirLinks
      ? '<section class="e404-section" aria-labelledby="e404-dirs-heading">\n<h2 id="e404-dirs-heading">Start from a directory</h2>\n' + dirLinks + '\n</section>\n'
      : '') +
    (recent
      ? '<section class="e404-section" aria-labelledby="e404-recent-heading">\n<h2 id="e404-recent-heading">Recent updates</h2>\n<ul class="e404-recent">\n' +
        recent +
        '\n</ul>\n</section>\n'
      : '') +
    '</article>';

  return pageShell(ctx, theme, {
    page: null,
    main,
    title: pageTitleHtml(ctx, 'Page not found'),
    description: esc('Page not found'),
    canonical: absUrl(ctx.site, '/404.html'),
    breadcrumbs: '',
    robots: 'noindex, nofollow',
    kind: '404',
  });
}

function firstLeaf(item: SidebarItem): SidebarItem | null {
  if (item.href) return item;
  for (const c of item.children) {
    const leaf = firstLeaf(c);
    if (leaf) return leaf;
  }
  return null;
}

/** Canonical page URL from `postPattern` (`/posts/{abbrlink}` → `/posts/7f3a9c21`),
 *  carrying the site's base path like every emitted URL. */
export function postHref(site: SiteConfig, abbrlink: string): string {
  const pattern = String(site.postPattern || '/posts/{abbrlink}');
  return siteUrl(site, pattern.replace(/\{abbrlink\}/g, abbrlink));
}

/** `/posts/abc` is emitted as `posts/abc/index.html`, which nginx and serve.ts
 *  resolve without a redirect. */
export function postOutRel(site: SiteConfig, href: string): string {
  const pathname = siteRelOf(site.url, String(href)).replace(/^\/+/, '');
  const last = pathname.split('/').pop() || '';
  // Directories and the site root already end the way they should.
  if (!last || last.includes('.')) return pathname;
  return `${pathname}/index.html`;
}

/** Renders every HTML page. Keys are dist-relative paths. */
export function renderAll(ctx: SiteCtx, theme: Theme): Map<string, string> {
  if (!theme?.layout) throw new Error('renderAll() needs the result of loadTheme()');
  const out = new Map<string, string>();

  for (const page of ctx.pages) {
    if (!page.href) continue;
    out.set(postOutRel(ctx.site, page.href), notePage(ctx, theme, page));
  }
  out.set('index.html', renderHome(ctx, theme));
  out.set('archives/index.html', renderArchives(ctx, theme));
  out.set('tags/index.html', renderTags(ctx, theme));

  for (const t of collectTags(ctx.pages).values()) {
    // Encode only at link time; tagSlugs holds the raw directory name.
    const dir = ctx.tagSlugs.get(t.key) ?? tagDir(t.name);
    out.set(`tags/${dir}/index.html`, renderTagPage(ctx, theme, t.name, t.pages));
  }
  out.set('404.html', render404(ctx, theme));
  return out;
}
