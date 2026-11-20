// One HTML pass: sanitize → parse5 → rewrite links/images → semantic extras
// (code chrome, callouts, equations, TOC), serialized as a fragment.
import { parseFragment, serialize } from 'parse5';
import { decodeURIComponentSafe, encodePath, nfc } from '../core/util.ts';
import { append, classesOf, element, getAttr, setAttr, replaceWithText, SKIP, text, textOf, walk, type P5Any } from '../core/dom.ts';
import { expandEmbed, parseEmbed } from './embeds.ts';
import { reportBroken } from './broken.ts';
import { sanitize } from './sanitize.ts';
import { normalizeCodeBlock } from './code-blocks.ts';
import { normalizeCallout } from './callouts.ts';
import { assertNoRawRefs, numberEquations, rewriteMathRefs } from './math.ts';
import { ATTACHMENT_PATH, isOffsiteHref, markExternal } from './links.ts';
import type { AssetRef, PostprocessCtx, PostprocessResult } from './postprocess-types.ts';
import type { TocItem } from '../core/types.ts';

export function postprocess(fragment: string, ctx: PostprocessCtx): PostprocessResult {
  const cleaned = sanitize(fragment);
  const root = parseFragment(cleaned) as unknown as P5Any;
  const toc: TocItem[] = [];
  const inlineStyles: string[] = [];

  walk(root, (node) => {
    const name = node.nodeName;
    if (name === 'style' || name === 'iframe' || name === 'object' || name === 'embed') return SKIP;
    if (name === 'script') {
      rewriteWidgetScript(node, ctx);
      return SKIP; // raw text children must not be visited
    }
    const style = getAttr(node, 'style');
    if (style !== undefined) inlineStyles.push(style);
    if (name === 'a') rewriteLink(node, ctx);
    else if (name === 'p') expandSoleEmbed(node, ctx);
    else if (name === 'img') rewriteImage(node, ctx);
    else if (name === 'video') rewriteVideo(node, ctx);
    else if (name === 'audio') rewriteAssetAttr(node, 'src', ctx, true);
    else if (name === 'source') rewriteAssetAttr(node, 'src', ctx, true);
    else if (name === 'track') rewriteAssetAttr(node, 'src', ctx, true);
    else if (name === 'link') rewriteStylesheetLink(node, ctx);
    else if (name === 'div') normalizeCallout(node);
    else if (name === 'pre') {
      normalizeCodeBlock(node);
      return SKIP;
    }
    return undefined;
  });

  wrapLoneImages(root);
  const labels = numberEquations(root, ctx);
  rewriteMathRefs(root, labels, ctx);
  assertNoRawRefs(root, ctx);
  collectHeadings(root, toc);
  return { html: serialize(root as never), toc, inlineStyles };
}

/** A paragraph holding only one `a.embed` becomes the provider's iframe. The
 *  link must stand alone so surrounding prose stays prose. */
function expandSoleEmbed(node: P5Any, ctx: PostprocessCtx): void {
  const meaningful = (node.childNodes ?? []).filter((n) => !(n.nodeName === '#text' && !(n.value ?? '').trim()));
  if (meaningful.length !== 1 || meaningful[0].nodeName !== 'a') return;
  const link = meaningful[0];
  if (!classesOf(link).includes('embed')) return;
  const href = getAttr(link, 'href') ?? '';
  const embed = parseEmbed(href);
  if (!embed) {
    // A `.embed` link that is not a provider URL is a mistake worth naming; an
    // in-site link keeps its normal rewrite (rewriteLink runs first on `a`).
    if (isOffsiteHref(href, ctx.siteHost)) broken(ctx, `a.embed is not a supported YouTube/Bilibili video: ${href}`, link);
    return;
  }
  const wrap = expandEmbed(link, embed);
  const parent = node.parentNode;
  if (!parent?.childNodes) return;
  wrap.parentNode = parent;
  parent.childNodes[parent.childNodes.indexOf(node)] = wrap;
}

function broken(ctx: PostprocessCtx, msg: string, node: P5Any): void {
  reportBroken(ctx, msg, node);
}

/** Resolve an attachment through the context and report a failure like any
 *  other broken reference, instead of throwing an unlabelled error out of the
 *  worker (which would hide every other page's problems). */
function addAsset(ctx: PostprocessCtx, ref: AssetRef, node: P5Any): string | null {
  try {
    return ctx.assets.add(ref);
  } catch (err) {
    broken(ctx, (err as Error).message, node);
    return null;
  }
}

function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#');
}

function relDirOf(fileRelPath: string): string {
  const idx = fileRelPath.lastIndexOf('/');
  return idx < 0 ? '' : fileRelPath.slice(0, idx);
}

function resolveIn(relDir: string, ref: string): string | null {
  const parts = (relDir ? relDir.split('/') : []).concat(ref.split('/'));
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(p);
  }
  return out.join('/');
}

function rewriteLink(node: P5Any, ctx: PostprocessCtx): void {
  const href = getAttr(node, 'href');
  if (!href || isExternal(href)) {
    // Any absolute URL that leaves the site opens a new tab, as do attachment
    // downloads below — what must stay in-tab is page navigation.
    if (href && isOffsiteHref(href, ctx.siteHost)) markExternal(node);
    return;
  }

  const decoded = nfc(decodeURIComponentSafe(href));
  const [pathPart, hash = ''] = decoded.split('#');
  const relDir = relDirOf(ctx.pageRelPath);

  if (/\.(md|markdown)$/i.test(pathPart)) {
    const targetRel = resolveIn(relDir, pathPart.replace(/\.(md|markdown)$/i, ''));
    if (targetRel == null) {
      broken(ctx, `link escapes the content root: ${pathPart}`, node);
      return;
    }
    if (ctx.isPrivatePage(targetRel)) {
      replaceWithText(node, '(page not public)');
      return;
    }
    const href2 = ctx.urlMap.get(targetRel);
    if (!href2) {
      broken(ctx, `link target does not exist: ${pathPart}`, node);
      return;
    }
    setAttr(node, 'href', withHash(href2, hash));
    return;
  }

  if (pathPart === '') return; // pure anchor
  if (pathPart.startsWith('/')) {
    if (pathPart.startsWith('/posts/')) ctx.onWarn?.(`hand-written /posts/ link (not validated): ${ctx.pageRelPath} → ${pathPart}`);
    // A hand-written root-absolute attachment link is not validated (it may be
    // raw HTML), but it is a download like any other and follows the policy.
    if (ATTACHMENT_PATH.test(pathPart)) markExternal(node);
    // Root-absolute means site-root-relative: carry the base path. The raw
    // href keeps its original encoding, query and hash.
    if (ctx.basePath) {
      const i = href.indexOf('#');
      setAttr(node, 'href', ctx.basePath + href.split('#')[0] + (i >= 0 ? href.slice(i) : ''));
    }
    return;
  }

  const dirRel = resolveIn(relDir, pathPart.replace(/\/+$/, ''));
  if (dirRel != null) {
    const idx = ctx.dirIndexHref?.(dirRel);
    if (idx) {
      setAttr(node, 'href', withHash(idx, hash));
      return;
    }
    // A private directory has no public index page; never ship a dead link.
    if (ctx.inPrivateSubtree?.(dirRel)) {
      replaceWithText(node, '(directory not public)');
      return;
    }
  }

  // Attachment links: bare relative references work like ./-prefixed ones.
  if (/\.[a-z0-9]{1,8}$/i.test(pathPart) && !pathPart.endsWith('/')) {
    const assetRel = resolveIn(relDir, pathPart);
    if (assetRel == null) {
      broken(ctx, `attachment escapes the content root: ${pathPart}`, node);
      return;
    }
    if (!ctx.isPublicAsset(assetRel)) {
      replaceWithText(node, '(attachment not public)');
      return;
    }
    const out = addAsset(ctx, { srcRel: assetRel, origin: pathPart, attr: 'href', node: 'a' }, node);
    if (out) setAttr(node, 'href', withHash(ctx.basePath + '/' + encodePath(out), hash));
    markExternal(node); // a download, not page navigation: never replaces the reading page
    return;
  }

  // No recognizable shape: report it rather than ship a href that 404s.
  if (dirRel == null) {
    broken(ctx, `link escapes the content root: ${pathPart}`, node);
  } else {
    broken(ctx, `link target does not exist: ${pathPart}`, node);
  }
}

function withHash(href: string, hash: string): string {
  if (!hash) return href;
  return href + '#' + encodeURIComponent(decodeURIComponentSafe(hash));
}

function rewriteVideo(node: P5Any, ctx: PostprocessCtx): void {
  // src is media-src (falling back to default-src 'self'): an off-site file
  // would never load, so fail the build. poster is an image (img-src allows
  // https:), so an external cover is fine.
  rewriteAssetAttr(node, 'src', ctx, true);
  rewriteAssetAttr(node, 'poster', ctx, false);
  if (!getAttr(node, 'preload')) setAttr(node, 'preload', 'metadata');
}

/** Widget channel (2026-11-21): a note loads code shipped next to itself.
 *  sanitize already reduced the tags to exactly two forms — src-only script /
 *  stylesheet link with a relative path — so here there is only resolving and
 *  rewriting to do, through the same hashed /assets/ pipeline as images. */
function rewriteWidgetScript(node: P5Any, ctx: PostprocessCtx): void {
  node.childNodes = []; // a src script's body is dead weight; never ship it
  rewriteWidgetRef(node, 'src', ctx);
}

function rewriteStylesheetLink(node: P5Any, ctx: PostprocessCtx): void {
  rewriteWidgetRef(node, 'href', ctx);
}

function rewriteWidgetRef(node: P5Any, attr: string, ctx: PostprocessCtx): void {
  const value = getAttr(node, attr)!; // sanitize guarantees both form and value
  const pathPart = nfc(decodeURIComponentSafe(value)).split('#')[0].split('?')[0];
  const rel = resolveIn(relDirOf(ctx.pageRelPath), pathPart);
  if (rel == null) {
    broken(ctx, `widget ${attr} escapes the content root: ${pathPart}`, node);
    return;
  }
  if (!ctx.isPublicAsset(rel)) {
    replaceWithText(node, '');
    return;
  }
  const out = addAsset(ctx, { srcRel: rel, origin: pathPart, attr, node: node.nodeName }, node);
  if (out) setAttr(node, attr, ctx.basePath + '/' + encodePath(out));
}

/** Rewrite a local media reference to its hashed /assets/ URL, fail-closed
 *  like images. A root-absolute hand-written URL is only prefixed (base path),
 *  the audit checks it exists. */
function rewriteAssetAttr(node: P5Any, attr: string, ctx: PostprocessCtx, mediaSrc: boolean): void {
  const value = getAttr(node, attr);
  if (!value) return;
  if (mediaSrc && isOffsiteHref(value, ctx.siteHost)) {
    broken(ctx, `${attr} points off-site, which media-src (default-src 'self') blocks; use a link card: ${value}`, node);
    return;
  }
  if (isExternal(value)) return;
  const pathPart = nfc(decodeURIComponentSafe(value)).split('#')[0].split('?')[0];
  if (pathPart.startsWith('/')) {
    if (ctx.basePath) {
      const i = value.indexOf('#');
      setAttr(node, attr, ctx.basePath + value.split('#')[0] + (i >= 0 ? value.slice(i) : ''));
    }
    return;
  }
  const rel = resolveIn(relDirOf(ctx.pageRelPath), pathPart);
  if (rel == null) {
    broken(ctx, `${attr} escapes the content root: ${pathPart}`, node);
    return;
  }
  if (!ctx.isPublicAsset(rel)) {
    replaceWithText(node, '(media not public)');
    return;
  }
  const out = addAsset(ctx, { srcRel: rel, origin: pathPart, attr, node: node.nodeName }, node);
  if (out) setAttr(node, attr, ctx.basePath + '/' + encodePath(out));
}

function rewriteImage(node: P5Any, ctx: PostprocessCtx): void {
  const src = getAttr(node, 'src');
  if (!src) return;
  enhanceImage(node);
  if (/^data:image\//i.test(src)) return; // already whitelist-limited to bitmap types
  if (isExternal(src)) return;
  const pathPart = nfc(decodeURIComponentSafe(src)).split('#')[0].split('?')[0];
  // Root-absolute means the site root: resolving it against relDir would
  // silently publish a different file.
  if (pathPart.startsWith('/')) {
    if (ctx.basePath) {
      const i = src.indexOf('#');
      setAttr(node, 'src', ctx.basePath + src.split('#')[0] + (i >= 0 ? src.slice(i) : ''));
    }
    return;
  }
  const rel = resolveIn(relDirOf(ctx.pageRelPath), pathPart);
  if (rel == null) {
    broken(ctx, `image escapes the content root: ${pathPart}`, node);
    return;
  }
  if (!ctx.isPublicAsset(rel)) {
    replaceWithText(node, '(image not public)');
    return;
  }
  const out = addAsset(ctx, { srcRel: rel, origin: src, attr: 'src', node: 'img' }, node);
  if (!out) return;
  setAttr(node, 'src', ctx.basePath + '/' + encodePath(out));
}

function enhanceImage(node: P5Any): void {
  setAttr(node, 'loading', 'lazy');
  setAttr(node, 'decoding', 'async');
  const w = Number.parseInt(getAttr(node, 'width') || '', 10);
  if (Number.isFinite(w) && w > 0 && w <= 64) setAttr(node, 'data-inline', '');
}

// implicit_figures is off, so lone images become figures here.
function wrapLoneImages(root: P5Any): void {
  walk(root, (node) => {
    if (node.nodeName !== 'p' || !node.childNodes) return undefined;
    const meaningful = node.childNodes.filter(
      (n) => !(n.nodeName === '#text' && !(n.value ?? '').trim()),
    );
    if (meaningful.length !== 1 || meaningful[0].nodeName !== 'img') return undefined;
    const img = meaningful[0];
    if (getAttr(img, 'data-inline') !== undefined) return SKIP;
    const caption = (getAttr(img, 'alt') ?? '').trim();
    const parent = node.parentNode;
    if (!parent?.childNodes) return SKIP;
    const figure = element('figure');
    append(figure, img);
    if (caption) {
      const cap = element('figcaption');
      text(cap, caption);
      append(figure, cap);
    }
    figure.parentNode = parent;
    parent.childNodes[parent.childNodes.indexOf(node)] = figure;
    return SKIP;
  });
}

function collectHeadings(root: P5Any, toc: TocItem[]): void {
  walk(root, (node) => {
    if (!/^h[1-6]$/.test(node.nodeName)) return undefined;
    const level = Number(node.nodeName[1]);
    if (level > 3) return undefined;
    let id = getAttr(node, 'id');
    let cur: P5Any | null | undefined = node.parentNode;
    while (!id && cur) {
      if (cur.nodeName === 'section') id = getAttr(cur, 'id');
      cur = cur.parentNode;
    }
    if (!id) return undefined;
    const text = textOf(node);
    if (text) toc.push({ level: level as 1 | 2 | 3, id, text });
    return undefined;
  });
}

