// Build orchestration: scan → abbrlink → mermaid → pandoc → postprocess →
// link cards → render → write → audit → manifest. Pure sequencing only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig, siteHostOf, basePathOf, type AppConfig, type SiteConfig } from '../core/config.ts';
import { BuildError, esc, log, nfc, toPosix, type CliArgs } from '../core/util.ts';
import { assertReserved, scanTree } from '../content/scan.ts';
import { buildCsp, CSP_META_TAG } from '../core/csp.ts';
import { buildSidebar, collectChildPages, resolveTree } from '../content/visibility.ts';
import { assignAbbrlinks } from '../content/abbrlink.ts';
import { PandocServer } from '../render/pandoc.ts';
import type { BrokenLink } from '../render/postprocess-types.ts';
import { RenderCache, renderCacheRoot } from './render-cache.ts';
import { convertWorker } from './worker.ts';
import { finishBuild } from './manifest.ts';
import { prepareMermaid } from '../render/mermaid.ts';
import { expandPageCards } from '../render/link-preview.ts';
import { makeAssetNamer } from '../render/attachments.ts';
import { buildSearchIndex } from '../render/search-index.ts';
import { loadTheme, postHref, renderAll, renderFeed, renderSitemap, renderRobots, buildTagSlugs, byRecency, type SiteCtx } from '../site/index.ts';
import { buildStaticAssets } from './static-assets.ts';
import { readInlineScript, stripTypes } from './frontend.ts';
import { styleHash, writeDiff, writeMissing } from './outputs.ts';
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
  const broken: BrokenLink[] = [];
  const warnings: string[] = [];
  const privateLeakWarns: string[] = [];
  // The <meta> CSP's style hashes must be known before rendering.
  const bodyInlineStyles = new Set<string>();
  const assets = makeAssetNamer(realRoot);
  try {
    await pandoc.start();
    await pandoc.smokeTest();
    log.info(`pandoc ${pandoc.info?.version} server ready (:${pandoc.port})`);

    // --check is read-only, so it never writes the cache.
    const cache = new RenderCache({
      dir: path.resolve(root, cfg.cacheDir, 'render'),
      root: renderCacheRoot({
        pandocVersion: pandoc.info?.version ?? '',
        urlMap,
        privateRels: privateRel,
        basePath,
        siteHost,
        allowPrivateAssets,
        contentRoot: realRoot,
        srcDirs: [path.join(root, 'src'), path.join(root, 'themes', 'default', 'css')],
      }),
      write: fix,
      contentRoot: realRoot,
    });
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
          cache,
        }),
      ),
    );
    cache.prune();
    cache.report();
  } finally {
    await pandoc.waitExit();
    await mermaid.renderer?.close();
  }

  if (broken.length) {
    const lines = broken.slice(0, 20).map((b) => `  - ${b.relPath}${b.where ? ` › 「${b.where}」` : ''}: ${b.msg}`);
    const more = broken.length > 20 ? `\n  … and ${broken.length - 20} more` : '';
    throw new BuildError(
      `Build failed: ${broken.length} broken reference(s)\n${lines.join('\n')}${more}\n` +
        '  Each line is the note, the heading it sits under, then the reference that could not be resolved.',
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
    // Replaced with content-hashed URLs before rendering.
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
  outputs.set('sitemap.xml', renderSitemap(siteCtx));
  outputs.set('robots.txt', renderRobots(siteCtx));
  for (const [rel, content] of staticBundle.files) outputs.set(toPosix(rel), content);

  // ---- meta CSP (hosts that cannot send headers, e.g. GitHub Pages) --------
  // No upgrade-insecure-requests: the same dist/ must stay previewable over
  // plain http. The audit cross-checks the style hashes after writing.
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
  const written = writeDiff(dist, outputs, keep);
  for (const a of assets.entries()) writeMissing(dist, toPosix(a.outRel), a.abs, a.stat);

  // ---- audit + manifest ----------------------------------------------------
  const finished = finishBuild(
    {
      dist,
      contentRoot: realRoot,
      pages,
      privateItems,
      cfg,
      skipAudit,
      bodyInlineStyles,
      counts: { ...siteCtx.counts, assets: assets.count(), searchDocs: searchIndex.docs.length },
      buildTime,
      pandocVersion: pandoc.info?.version,
      scriptHashes,
    },
    manifestFile,
  );
  log.info(`✓ Output: ${written.written} written, ${written.removed} removed, ${written.total} total (unchanged files skipped)`);
  log.info(
    `✓ Build complete: ${finished.counts.published} public + ${finished.counts.indexes} index pages, ` +
      `${finished.counts.private} private, ${finished.counts.assets} attachments, in ${Date.now() - t0}ms`,
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
