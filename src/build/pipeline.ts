// Build orchestration: scan → abbrlink → mermaid → pandoc → postprocess →
// link cards → render → write → audit → manifest. Everything here is pure
// sequencing; each step lives in its own layer module.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseFragment, serialize } from 'parse5';
import { loadConfig, siteHostOf, basePathOf, type AppConfig, type SiteConfig } from '../core/config.ts';
import { BuildError, esc, log, nfc, toPosix, type CliArgs } from '../core/util.ts';
import { getAttr, textOf, type P5Any } from '../core/dom.ts';
import { assertReserved, scanTree } from '../content/scan.ts';
import { buildCsp, CSP_META_TAG } from '../core/csp.ts';
import { buildSidebar, collectChildPages, resolveTree } from '../content/visibility.ts';
import { assignAbbrlinks } from '../content/abbrlink.ts';
import { PandocServer } from '../render/pandoc.ts';
import { postprocess } from '../render/postprocess.ts';
import type { AssetRef } from '../render/postprocess-types.ts';
import { applyMermaid, prepareMermaid, type MermaidState } from '../render/mermaid.ts';
import { expandPageCards } from '../render/link-preview.ts';
import { makeAssetNamer } from '../render/attachments.ts';
import { buildSearchIndex } from '../render/search-index.ts';
import { loadTheme, postHref, renderAll, renderFeed, renderRobots, buildTagSlugs, byRecency, type SiteCtx } from '../site/index.ts';
import { buildStaticAssets } from './static-assets.ts';
import { readInlineScript, stripTypes } from './frontend.ts';
import { runAuditDetailed } from './audit.ts';
import { hashContent, hashDist, styleHash, writeAtomic, writeDiff, writeMissing } from './outputs.ts';
import type { Page, SidebarItem, TreeNode } from '../core/types.ts';

const CONCURRENCY = 8;

export async function buildSite({ args, root, t0 }: { args: CliArgs; root: string; t0: number }): Promise<void> {
  if (process.env.BLOG_LOG_LEVEL === 'quiet') log.info = () => {};

  const cfg: AppConfig = await loadConfig(args.config ? path.resolve(root, String(args.config)) : undefined);
  const content = path.resolve(root, String(args.content || cfg.contentDir));
  const dist = path.resolve(root, String(args.out || cfg.outDir));
  const manifestFile = args.manifest ? path.resolve(root, String(args.manifest)) : path.resolve(root, cfg.manifestFile);
  const themeDir = path.resolve(root, cfg.themeDir);
  const fix = args.check !== true; // --fix by default; --check is read-only
  const skipAudit = args['skip-audit'] === true;
  const allowPrivateAssets = args['allow-private-assets'] === true;
  const noMermaid = args.mermaid === false || args['skip-mermaid'] === true;
  const mermaidBin = path.join(root, 'node_modules/mermaid/dist/mermaid.min.js');
  const site: SiteConfig = { ...cfg };
  // Links to any other host open a new tab; loadConfig validated the URL.
  const siteHost = siteHostOf(site.url);
  const basePath = basePathOf(site.url);
  const buildTime = buildTimeOf(args);

  if (!fs.existsSync(content)) throw new BuildError(`Content directory not found: ${content}`);
  const loc = new Intl.Collator('zh-CN').resolvedOptions().locale;
  if (loc !== 'zh-CN') throw new BuildError(`Node lacks full ICU (zh-CN locale unavailable, got ${loc})`);

  // ---- scan + visibility, then abbrlink fill-in --------------------------
  const { root: tree, realRoot } = scanTree(content);
  assertReserved(tree);
  const { pages, privateItems } = resolveTree(tree);
  const treeRoot = tree as TreeNode;
  const pageByNode = new Map<TreeNode, Page>(pages.map((p) => [p.node, p]));
  const pageByRel = new Map(pages.map((p) => [p.relPath, p]));

  assignAbbrlinks(treeRoot, pageByNode, pages, fix);

  const urlMap = new Map<string, string>();
  for (const p of pages) {
    p.href = postHref(site, p.abbrlink);
    urlMap.set(p.relPath, p.href);
  }
  const privateRel = new Set(privateItems.map((i) => i.relPath));
  const privatePrefixes = new Set(privateItems.map((i) => i.relPath + '/'));
  const isPrivatePage = (rel: string): boolean => privateRel.has(nfc(rel));
  const inPrivateSubtree = (rel: string): boolean => {
    const r = nfc(rel);
    return privateRel.has(r) || [...privatePrefixes].some((pre) => r.startsWith(pre));
  };

  const globalOrder = [...pages].sort(byRecency);
  const prevNext = new Map<string, { prev: Page | null; next: Page | null }>();
  globalOrder.forEach((p, i) => prevNext.set(p.href, { prev: globalOrder[i - 1] ?? null, next: globalOrder[i + 1] ?? null }));

  // ---- mermaid prerender ---------------------------------------------------
  const mermaid = await prepareMermaid({
    pages,
    themeDir,
    mermaidBin,
    noMermaid,
    root,
    cacheDir: cfg.cacheDir,
    strict: args['strict-mermaid'] === true,
  });

  // ---- pandoc conversion ---------------------------------------------------
  const pandoc = new PandocServer({ bin: process.env.PANDOC_BIN || 'pandoc' });
  const broken: { relPath: string; msg: string }[] = [];
  const warnings: string[] = [];
  const privateLeakWarns: string[] = [];
  // The <meta> CSP's style hashes must be known before pages render.
  const bodyInlineStyles = new Set<string>();
  const assets = makeAssetNamer(realRoot);
  try {
    await pandoc.start();
    await pandoc.smokeTest();
    log.info(`pandoc ${pandoc.info?.version} server ready (:${pandoc.port})`);
    const cursor = { next: 0 };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, pages.length || 1) }, () =>
        convertWorker(pages, cursor, {
          pandoc,
          broken,
          warnings,
          privateLeakWarns,
          assets,
          urlMap,
          siteHost,
          basePath,
          bodyInlineStyles,
          pageByRel,
          isPrivatePage,
          inPrivateSubtree,
          allowPrivateAssets,
          mermaid,
        }),
      ),
    );
  } finally {
    await pandoc.waitExit();
    await mermaid.renderer?.close();
  }

  if (broken.length) {
    const lines = broken.slice(0, 20).map((b) => `  - ${b.relPath}: ${b.msg}`);
    const more = broken.length > 20 ? `\n  … and ${broken.length - 20} more` : '';
    throw new BuildError(
      `Build failed: ${broken.length} broken reference(s)\n${lines.join('\n')}${more}\n` +
        '  Each line is the note, then the element whose path could not be resolved.',
    );
  }
  if (privateLeakWarns.length) {
    log.info(`  Note: public pages reference ${privateLeakWarns.length} attachments under private directories, published as public:`);
    for (const w of privateLeakWarns.slice(0, 10)) log.info(`    - ${w}`);
  }

  // ---- link cards ----------------------------------------------------------
  await expandPageCards(pages, { args, root, cacheDir: cfg.cacheDir, siteHost });

  // ---- site assembly -------------------------------------------------------
  for (const p of pages) p.childPages = collectChildPages(p.node, pageByNode);
  const sidebar = buildSidebar(treeRoot, pageByRel);
  const ancestorsOf = new Map<string, SidebarItem[]>();
  const indexAncestors = (items: SidebarItem[], chain: SidebarItem[]): void => {
    for (const it of items) {
      ancestorsOf.set(it.relPath, chain);
      indexAncestors(it.children, [...chain, it]);
    }
  };
  indexAncestors(sidebar, []);

  const themeInitSrc = readInlineScript(path.join(themeDir, 'theme-init.ts'));
  const uiBootSrc = readInlineScript(path.join(themeDir, 'ui-boot.ts'));
  const inlineScripts = [themeInitSrc, uiBootSrc];
  const scriptHashes = inlineScripts.map((s) => 'sha256-' + crypto.createHash('sha256').update(s, 'utf8').digest('base64'));

  const siteCtx: SiteCtx = {
    site,
    pages,
    sidebar,
    ancestorsOf,
    prevNext,
    home: globalOrder.filter((p) => p.kind === 'note').slice(0, site.pageSize.home),
    counts: { published: pages.filter((p) => p.kind !== 'index').length, indexes: pages.filter((p) => p.kind === 'index').length },
    tagSlugs: buildTagSlugs(pages),
    themeInitSrc,
    uiBootSrc,
    // Replaced with content-hashed URLs before rendering; the placeholder never reaches output.
    assets: { style: '', app: '', spa: '', search: '', media: '', comments: '', favicon: '', touchIcon: '', mark: '', fonts: '', diagrams: '', searchIndex: '' },
    builtAt: buildTime,
  };

  const theme = await loadTheme(themeDir);
  const searchIndex = buildSearchIndex(pages, { dirsOf: (p) => (ancestorsOf.get(p.relPath) ?? []).map((a) => a.title) });
  const staticBundle = buildStaticAssets({
    themeDir,
    diagramsCss: mermaid.cssText,
    searchIndexJson: JSON.stringify(searchIndex) + '\n',
    strip: stripTypes,
    basePath,
  });
  siteCtx.assets = staticBundle.urls;

  const outputs: Map<string, string | Buffer> = renderAll(siteCtx, theme);
  outputs.set('feed.xml', renderFeed(siteCtx));
  outputs.set('robots.txt', renderRobots());
  for (const [rel, content] of staticBundle.files) outputs.set(toPosix(rel), content);

  // ---- meta CSP (hosts that cannot send headers, e.g. GitHub Pages) --------
  // upgrade-insecure-requests stays out so a plain-http preview of the same
  // dist/ still loads; the audit cross-checks the style hashes after writing.
  if (cfg.cspMeta) {
    const tag = `<meta http-equiv="Content-Security-Policy" content="${esc(buildCsp({ script: scriptHashes, style: [...bodyInlineStyles].map(styleHash) }, cfg))}">`;
    for (const [rel, content] of outputs) {
      if (rel.endsWith('.html') && typeof content === 'string') {
        outputs.set(rel, content.split(CSP_META_TAG).join(tag));
      }
    }
  }

  // ---- write + attachments -------------------------------------------------
  const keep = new Set(assets.entries().map((a) => toPosix(a.outRel)));
  keep.add('build-info.json');
  const writeResult = writeDiff(dist, outputs, keep);
  for (const a of assets.entries()) writeMissing(dist, toPosix(a.outRel), a.abs, a.stat);

  // ---- audit + manifest ----------------------------------------------------
  let inlineStyles: string[] = [];
  if (!skipAudit) {
    const audit = runAuditDetailed({ dist, pages, privateItems, cfg });
    inlineStyles = audit.inlineStyles;
    // Anything the audit sees in the final output but postprocess did not
    // collect would ship unhashed in the meta CSP.
    const unknown = audit.inlineStyles.filter((s) => !bodyInlineStyles.has(s));
    if (unknown.length) {
      throw new BuildError(
        `Output audit failed: ${unknown.length} inline style attribute(s) appeared after postprocess; the meta CSP would block them:\n` +
          unknown.slice(0, 5).map((s) => `  - ${s.slice(0, 60)}`).join('\n'),
      );
    }
    if (audit.findings.length) {
      throw new BuildError(
        `Output audit failed (${audit.findings.length} findings):\n` +
          audit.findings.slice(0, 30).map((f) => `  - ${f.file}: ${f.msg}`).join('\n'),
      );
    }
  }

  const manifest = {
    buildId: buildTime.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'),
    builtAt: buildTime.toISOString(),
    pandocVersion: pandoc.info?.version,
    counts: {
      ...siteCtx.counts,
      private: privateItems.length,
      assets: assets.count(),
      searchDocs: searchIndex.docs.length,
    },
    contentHash: hashContent(realRoot),
    distHash: hashDist(dist),
    // --skip-audit style hashes are incomplete; gen-nginx must refuse them.
    audited: !skipAudit,
    csp: {
      inlineScriptHashes: scriptHashes,
      inlineStyleHashes: inlineStyles.map(styleHash),
    },
  };
  writeAtomic(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  // The CSP hashes ride inside dist/ for serve.ts to find.
  writeAtomic(
    path.join(dist, 'build-info.json'),
    JSON.stringify({ buildId: manifest.buildId, builtAt: manifest.builtAt, csp: manifest.csp }) + '\n',
  );

  log.info(`✓ Output: ${writeResult.written} written, ${writeResult.removed} removed, ${writeResult.total} total (unchanged files skipped)`);
  log.info(
    `✓ Build complete: ${manifest.counts.published} public + ${manifest.counts.indexes} index pages, ` +
      `${manifest.counts.private} private, ${manifest.counts.assets} attachments, in ${Date.now() - t0}ms`,
  );
  if (warnings.length) {
    log.info(`  ${warnings.length} notes:`);
    for (const w of warnings.slice(0, 10)) log.info(`    - ${w}`);
  }
}

function buildTimeOf(args: CliArgs): Date {
  const reproducible = args.reproducible === true || !!process.env.SOURCE_DATE_EPOCH;
  if (!reproducible) return new Date();
  const epoch = Number(process.env.SOURCE_DATE_EPOCH);
  return Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000) : new Date(0);
}

interface WorkerCtx {
  pandoc: PandocServer;
  broken: { relPath: string; msg: string }[];
  warnings: string[];
  privateLeakWarns: string[];
  assets: ReturnType<typeof makeAssetNamer>;
  urlMap: Map<string, string>;
  siteHost: string;
  basePath: string;
  bodyInlineStyles: Set<string>;
  pageByRel: Map<string, Page>;
  isPrivatePage: (rel: string) => boolean;
  inPrivateSubtree: (rel: string) => boolean;
  allowPrivateAssets: boolean;
  mermaid: MermaidState;
}

/** One worker loop; all workers share `cursor`, so each page converts once. */
async function convertWorker(pages: Page[], cursor: { next: number }, w: WorkerCtx): Promise<void> {
  let pandocDead: string | null = null;
  while (cursor.next < pages.length) {
    if (pandocDead) throw new BuildError(pandocDead);
    const page = pages[cursor.next++];
    const sourceRel = page.kind === 'index' ? `${page.relPath}/_index.md` : `${page.relPath}.md`;
    let html: string;
    try {
      const res = await w.pandoc.convert(page.content);
      if (res.error || res.html == null) {
        w.broken.push({ relPath: sourceRel, msg: `pandoc conversion failed: ${res.error}` });
        continue;
      }
      html = res.html;
    } catch (err) {
      // Transport failure = the server is gone; fail with the single cause.
      pandocDead = `pandoc server failed while converting ${sourceRel}: ${(err as Error).message}`;
      throw new BuildError(pandocDead);
    }

    const r = postprocess(html, {
      pageRelPath: sourceRel,
      siteHost: w.siteHost,
      basePath: w.basePath,
      urlMap: w.urlMap,
      assets: {
        add: ({ srcRel, origin, attr, node }: AssetRef): string | null => {
          if (w.inPrivateSubtree(srcRel) && !w.allowPrivateAssets) {
            throw new BuildError(
              `references an attachment under private content: ${srcRel}\n` +
                `  Refused by default (fail-closed). After confirming the file is safe to publish, rebuild with --allow-private-assets.`,
            );
          }
          if (w.inPrivateSubtree(srcRel)) w.privateLeakWarns.push(`${sourceRel} references private file ${srcRel} (published via --allow-private-assets)`);
          try {
            return w.assets.assign(page.abbrlink, srcRel);
          } catch (err) {
            throw new BuildError(`<${node} ${attr}="${origin}"> → ${(err as Error).message}`);
          }
        },
      },
      isPublicAsset: (srcRel: string): boolean => !w.inPrivateSubtree(srcRel),
      isPrivatePage: w.isPrivatePage,
      inPrivateSubtree: w.inPrivateSubtree,
      dirIndexHref: (dirRel: string): string | null => w.pageByRel.get(nfc(dirRel))?.href ?? null,
      onBroken: (b) => w.broken.push(b),
      onWarn: (m) => w.warnings.push(m),
    });

    const stripped = stripDuplicateH1(r.html, page.title);
    page.html = applyMermaid(stripped.html, page, w.mermaid);
    page.toc = stripped.id ? r.toc.filter((t) => t.id !== stripped.id) : r.toc;
    for (const s of r.inlineStyles) w.bodyInlineStyles.add(s);
  }
}

/**
 * pandoc's section-divs wraps a leading `# H1` in `<section id=… class=level1>`
 * together with everything up to the next heading. When that H1 repeats the
 * frontmatter title the page already renders, drop the heading and keep the
 * section's contents in its place: slicing the text here would orphan the
 * section's closing tag and leave an unbalanced fragment.
 */
function stripDuplicateH1(html: string, title: string): { html: string; id: string } {
  const root = parseFragment(html) as unknown as P5Any;
  const nodes = root.childNodes ?? [];
  const first = nodes.find((n) => n.nodeName !== '#text' || (n.value ?? '').trim());
  if (!first) return { html, id: '' };
  const holder = first.nodeName === 'section' ? first : null;
  const siblings = holder?.childNodes ?? nodes;
  const h1 = siblings.find((n) => n.nodeName === 'h1');
  if (!h1 || textOf(h1) !== title.trim()) return { html, id: '' };
  const id = getAttr(h1, 'id') || (holder ? getAttr(holder, 'id') : '') || '';
  siblings.splice(siblings.indexOf(h1), 1);
  // A section that held only the title collapses; anything else keeps its id,
  // so the surviving headings still resolve an anchor through it.
  if (holder && !siblings.some((n) => n.nodeName !== '#text' || (n.value ?? '').trim())) {
    nodes.splice(nodes.indexOf(holder), 1);
  }
  return { html: serialize(root as never), id };
}
