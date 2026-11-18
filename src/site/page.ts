// Note pages and the shared page shell.
import { datePart, esc } from '../core/util.ts';
import { CSP_META_TAG } from '../core/csp.ts';
import { fillLayout } from './layout.ts';
import type { SiteCtx, Theme } from './layout.ts';
import type { Page } from '../core/types.ts';
import { absUrl, ancestorsOf, bodyStartsWithH1, descriptionOf, firstParagraph, fmtDate, pageTitleHtml, siteUrl, titleOf } from './helpers.ts';
import { header, pageClass } from './header.ts';
import type { PageKind } from './header.ts';
import { breadcrumbs, sidebar } from './sidebar.ts';
import type { Crumb } from './sidebar.ts';
import { tocMinimap, tocNav, tocRail } from './toc.ts';
import { giscusComments } from './comments.ts';
import { footer } from './footer.ts';
import { parseSummary } from '../content/summary.ts';
import { tagLink } from './tags.ts';

function pager(prev: Page | null, next: Page | null): string {
  if (!prev && !next) return '';
  const parts: string[] = [];
  if (prev) parts.push(`<a class="prev" rel="prev" href="${esc(prev.href)}"><span class="pager-dir">← Previous</span> <span class="pager-title">${esc(titleOf(prev))}</span></a>`);
  if (next) parts.push(`<a class="next" rel="next" href="${esc(next.href)}"><span class="pager-dir">Next →</span> <span class="pager-title">${esc(titleOf(next))}</span></a>`);
  return '<nav class="pager" aria-label="Pagination">\n' + parts.join('\n') + '\n</nav>';
}

export function card(page: Page, heading = 'h2'): string {
  const date = fmtDate(page.date);
  const fallback = page.description || (page.html ? firstParagraph(page.html, 90) : '');
  const desc = fallback ? `<p class="card-desc">${esc(fallback)}</p>` : '';
  return (
    `<li class="card" data-page-kind="${esc(page.kind)}">\n` +
    `<${heading} class="card-title"><a href="${esc(page.href)}">${esc(titleOf(page))}</a></${heading}>\n` +
    (date ? `<p class="card-meta">${date}</p>\n` : '') +
    desc + '\n' +
    '</li>'
  );
}

function tagListHtml(ctx: SiteCtx, tags: string[]): string {
  if (!tags.length) return '';
  const item = (t: string) => `<li><a class="tag" rel="tag" href="${esc(tagLink(ctx, t))}">${esc(t)}</a></li>`;
  const head = tags.slice(0, 4).map(item).join('\n');
  if (tags.length <= 4) return `<ul class="tag-list">\n${head}\n</ul>`;
  const rest = tags.slice(4).map(item).join('\n');
  return (
    `<ul class="tag-list">\n${head}\n</ul>\n` +
    `<details class="tag-more">\n<summary>${tags.length - 4} more</summary>\n<ul class="tag-list">\n${rest}\n</ul>\n</details>`
  );
}

function childList(children: Page[] | undefined): string {
  const list = (children || []).filter(Boolean);
  if (!list.length) return '';
  return (
    '<section class="children" aria-labelledby="children-heading">\n' +
    '<h2 id="children-heading" class="children-title">Subpages</h2>\n' +
    '<ul class="child-list">\n' +
    list.map((p) => card(p, 'h3')).join('\n') +
    '\n</ul>\n</section>'
  );
}

function postMeta(page: Page, ctx: SiteCtx): string {
  const parts: string[] = [];
  const d = datePart(page.date);
  const u = datePart(page.updated);
  if (d) parts.push(`<span class="meta-date"><time datetime="${esc(d)}">${esc(d)}</time></span>`);
  if (u && u !== d) parts.push(`<span class="meta-updated">Updated <time datetime="${esc(u)}">${esc(u)}</time></span>`);
  if (page.kind === 'index') parts.push('<span class="meta-kind">Directory</span>');
  const meta = parts.length ? `<p class="post-meta">${parts.join('<span class="sep" aria-hidden="true">·</span>')}</p>` : '';
  const tags = Array.isArray(page.tags) ? page.tags.filter(Boolean) : [];
  const tagHtml = tagListHtml(ctx, tags);
  if (!meta && !tagHtml) return '';
  return `<div class="post-header-meta">\n${meta}${tagHtml ? '\n' + tagHtml : ''}\n</div>`;
}

function articleTitle(page: Page): string {
  return bodyStartsWithH1(page.html || '') ? '' : `<h1 class="post-title">${esc(titleOf(page))}</h1>\n`;
}

const ICON_SUMMARY =
  '<svg class="icon i-spark" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">' +
  '<path d="M12 3.5 13.9 9a3 3 0 0 0 1.8 1.8L21 12l-5.3 1.2a3 3 0 0 0-1.8 1.8L12 20.5l-1.9-5.5a3 3 0 0 0-1.8-1.8L3 12l5.3-1.2a3 3 0 0 0 1.8-1.8z"/></svg>';

// Down-pointing, unlike the TOC rail's chevron.
const ICON_SUMMARY_CHEVRON =
  '<svg class="icon i-chev" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">' +
  '<path d="M6.5 9 12 14.5 17.5 9"/></svg>';

function summaryBlocks(summary: string): string {
  return parseSummary(summary)
    .map((b) => {
      if (b.kind === 'p') return `<p>${esc(b.text)}</p>`;
      // Re-validate: the attribute must always be a plain integer.
      const start = b.kind === 'ol' && Number.isInteger(b.start) && b.start !== 1 ? ` start="${b.start}"` : '';
      return `<${b.kind}${start}>\n` + b.items.map((item) => `<li>${esc(item)}</li>`).join('\n') + `\n</${b.kind}>`;
    })
    .join('\n');
}

/** Collapsible abstract; native <details> keeps it keyboard-accessible. */
function summaryCard(page: Page): string {
  if (!page.summary) return '';
  const body = summaryBlocks(page.summary);
  if (!body) return '';
  return (
    '<details class="summary-card" open>\n' +
    '<summary>\n' +
    ICON_SUMMARY + '\n' +
    '<span class="summary-card-label">Summary</span>\n' +
    ICON_SUMMARY_CHEVRON + '\n' +
    '</summary>\n' +
    '<div class="summary-card-body">\n' + body + '\n</div>\n' +
    '</details>\n'
  );
}

function crumbsFor(ctx: SiteCtx, page: Page): string {
  const chain = ancestorsOf(ctx, page);
  const items: Crumb[] = chain.map((a, i) => ({
    title: a.title,
    href: a.href,
    level: i === 0 ? ctx.sidebar : chain[i - 1].children,
  }));
  const level = chain.length ? chain[chain.length - 1].children : ctx.sidebar;
  items.push({ title: titleOf(page), current: true, level });
  return breadcrumbs(ctx, items, page.href);
}

export function notePage(ctx: SiteCtx, theme: Theme, page: Page): string {
  const pn = ctx.prevNext.get(String(page.href)) ?? { prev: null, next: null };
  const toc = tocNav(page.toc);
  const isIndex = page.kind === 'index';
  const kind: PageKind = isIndex ? 'index' : 'post';
  const comments = isIndex ? '' : giscusComments(ctx, page);
  const rail = tocRail(toc, tocMinimap(page.toc), !!comments);
  const main =
    `<article class="${pageClass(kind)}">\n` +
    '<div class="post-layout">\n' +
    '<div class="post-col">\n' +
    `<header class="post-header">\n${articleTitle(page)}${postMeta(page, ctx)}\n</header>\n` +
    summaryCard(page) +
    `<div class="post-body">\n${page.html}\n</div>\n` +
    childList(page.childPages) + '\n' +
    pager(pn.prev, pn.next) + '\n' +
    comments +
    '</div>\n' +
    rail +
    '</div>\n' +
    '</article>';
  return pageShell(ctx, theme, {
    page,
    kind,
    main,
    title: pageTitleHtml(ctx, titleOf(page)),
    description: esc(descriptionOf(page)),
    canonical: absUrl(ctx.site, page.href),
    breadcrumbs: crumbsFor(ctx, page),
  });
}

function inlineScript(src: string): string {
  return src ? `<script>${src}</script>` : '';
}

interface ShellOpts {
  page: Page | null;
  kind: PageKind;
  main: string;
  title: string;
  description: string;
  canonical: string;
  breadcrumbs: string;
  robots?: string;
}

export function pageShell(ctx: SiteCtx, theme: Theme, opts: ShellOpts): string {
  const hasSidebar = ctx.sidebar.length > 0;
  const breadcrumbs = opts.breadcrumbs || '';
  const a = ctx.assets;
  return fillLayout(theme.layout, {
    lang: esc(ctx.site.lang || 'en'),
    title: opts.title,
    description: opts.description,
    robots: opts.robots ?? 'index, follow, max-image-preview:large',
    theme_init_inline: inlineScript(ctx.themeInitSrc),
    ui_boot_inline: inlineScript(ctx.uiBootSrc),
    canonical: esc(opts.canonical),
    site_name: esc(ctx.site.siteName),
    csp_meta: ctx.site.cspMeta ? CSP_META_TAG : '',
    feed_url: esc(siteUrl(ctx.site, '/feed.xml')),
    fonts_css: a.fonts ? `<link rel="stylesheet" href="${esc(a.fonts)}">\n` : '',
    diagrams_css: a.diagrams ? `<link rel="stylesheet" href="${esc(a.diagrams)}">\n` : '',
    style_css: esc(a.style),
    favicon: esc(a.favicon),
    touch_icon: esc(a.touchIcon),
    app_js: esc(a.app),
    page_kind: opts.kind,
    shell_class: hasSidebar ? '' : ' no-sidebar',
    header: header(ctx, { kind: opts.kind, hasSidebar, breadcrumbs }),
    sidebar: sidebar(ctx, { currentPage: opts.page }),
    main: opts.main,
    footer: footer(ctx),
  });
}
