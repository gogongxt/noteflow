// On-this-page rail: the TOC nav, the scrollspy minimap and the rail chrome.
import { esc } from '../core/util.ts';
import type { TocItem } from '../core/types.ts';

const tocItems = (toc: TocItem[]): TocItem[] => toc.filter((t) => t.id);

export function tocNav(toc: TocItem[]): string {
  const items = tocItems(toc);
  if (!items.length) return '';
  return (
    '<nav class="toc" aria-label="Table of contents">\n<ul class="toc">\n' +
    items.map((t) => `<li class="lvl${t.level}"><a href="#${esc(encodeURIComponent(t.id))}">${esc(t.text)}</a></li>`).join('\n') +
    '\n</ul>\n</nav>'
  );
}

// One tick per heading; the scrollspy highlights the one being read.
export function tocMinimap(toc: TocItem[]): string {
  const items = tocItems(toc);
  if (!items.length) return '';
  return (
    '<span class="toc-marks" aria-hidden="true">\n' +
    items.map((t) => `<i class="m lvl${t.level}" data-for="${esc(encodeURIComponent(t.id))}"></i>`).join('') +
    '\n</span>'
  );
}

const ICON_TOC_LIST =
  '<svg class="icon i-list" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">' +
  '<path d="M4 6h16"/><path d="M4 12h10"/><path d="M4 18h16"/></svg>';

const ICON_TOC_CHEVRON =
  '<svg class="icon i-chev" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">' +
  '<path d="M10 6.5 15.5 12 10 17.5"/></svg>';

const ICON_TOC_PIN =
  '<svg class="icon i-pin" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">' +
  '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';

export function tocRail(toc: string, marks: string, comments: boolean): string {
  if (!marks) marks = '<span class="toc-marks" aria-hidden="true"><i class="m"></i></span>';
  const foot = comments
    ? '\n<div class="toc-foot">' +
      '<a class="toc-comments" href="#comments" data-scroll-comments>' +
      '<span class="toc-comments-label">Jump to comments</span>' +
      '</a></div>'
    : '';
  return (
    '<aside class="toc-rail">\n' +
    '<div class="toc-head">\n<p class="toc-title">' + ICON_TOC_LIST + 'On this page</p>\n' +
    `<button type="button" class="toc-toggle" aria-label="Expand table of contents" aria-expanded="true" aria-controls="toc-panel" title="Table of contents">${marks}${ICON_TOC_CHEVRON}</button>\n` +
    '</div>\n' +
    `<button type="button" class="toc-pin" aria-label="Pin as sidebar table of contents" aria-controls="toc-panel" title="Pin as sidebar table of contents">${ICON_TOC_PIN}</button>\n` +
    `<div class="toc-panel" id="toc-panel">\n${toc}${foot}\n</div>\n` +
    '</aside>\n'
  );
}
