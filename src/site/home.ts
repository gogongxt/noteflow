// The home page: site intro, a few stats, and the most recent notes.
import { esc } from '../core/util.ts';
import type { SiteCtx, Theme } from './layout.ts';
import { absUrl, pageTitleHtml, siteUrl } from './helpers.ts';
import { pageClass } from './header.ts';
import { card, pageShell } from './page.ts';
import { collectTags } from './tags.ts';

function homeStats(ctx: SiteCtx): string {
  const notes = ctx.pages.filter((p) => p.kind === 'note');
  const tagCount = collectTags(ctx.pages).size;
  const items = [
    notes.length && `<li><strong>${notes.length}</strong><span>notes</span></li>`,
    ctx.counts.indexes && `<li><strong>${ctx.counts.indexes}</strong><span>directories</span></li>`,
    tagCount && `<li><strong>${tagCount}</strong><span>tags</span></li>`,
  ].filter(Boolean);
  return items.length ? `<ul class="home-stats">\n${items.join('\n')}\n</ul>` : '';
}

export function renderHome(ctx: SiteCtx, theme: Theme): string {
  // ctx.home is capped to pageSize.home in build.ts; a second cap here would
  // silently override the configured value.
  const home = ctx.home;
  const desc = ctx.site.description || `${ctx.site.siteName} — knowledge base and blog`;
  const intro =
    '<header class="hero">\n' +
    '<p class="hero-eyebrow">Knowledge base · Technical notes</p>\n' +
    `<h1 class="hero-title">${esc(ctx.site.siteName)}</h1>\n` +
    `<p class="hero-desc">${esc(desc)}</p>\n` +
    homeStats(ctx) + '\n' +
    '<nav class="hero-links" aria-label="Site sections">\n' +
    `<a class="btn btn-primary" href="${esc(siteUrl(ctx.site, '/archives'))}">Browse archives</a>` +
    `<a class="btn btn-primary" href="${esc(siteUrl(ctx.site, '/tags'))}">All tags</a>` +
    `<a class="btn btn-primary" href="${esc(siteUrl(ctx.site, '/feed.xml'))}">RSS feed</a>\n</nav>\n` +
    '</header>';
  const recent = home.length
    ? `<section class="recent" aria-labelledby="recent-heading">\n<div class="section-head"><h2 id="recent-heading">Recent updates</h2><a class="section-more" href="${esc(siteUrl(ctx.site, '/archives'))}">View all</a></div>\n<ul class="post-list">\n` +
      home.map((p) => card(p)).join('\n') +
      '\n</ul>\n</section>'
    : '<section class="recent" aria-labelledby="recent-heading">\n<div class="section-head"><h2 id="recent-heading">Recent updates</h2></div>\n<p class="empty">No public notes yet.</p>\n</section>';
  return pageShell(ctx, theme, {
    page: null,
    kind: 'home',
    main: `<article class="${pageClass('home')} post-layout no-toc">\n${intro}\n${recent}\n</article>`,
    title: pageTitleHtml(ctx, ctx.site.siteName),
    description: esc(desc),
    canonical: absUrl(ctx.site, '/'),
    breadcrumbs: '',
  });
}
