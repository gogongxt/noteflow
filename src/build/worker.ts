// The per-page conversion loop shared by every worker: pandoc, the body HTML
// pass, and the render cache that lets an unchanged page skip both.
import { BuildError, nfc } from '../core/util.ts';
import { postprocess } from '../render/postprocess.ts';
import type { AssetRef, BrokenLink } from '../render/postprocess-types.ts';
import type { PinnedAsset, makeAssetNamer } from '../render/attachments.ts';
import type { RenderCache, CachedRender } from './render-cache.ts';
import { applyMermaid, type MermaidState } from '../render/mermaid.ts';
import type { PandocServer } from '../render/pandoc.ts';
import { sourceRelOf, type Page } from '../core/types.ts';

export interface WorkerCtx {
  pandoc: PandocServer;
  broken: BrokenLink[];
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
  cache: RenderCache;
}

/** One worker loop; all workers share `cursor`, so each page converts once. */
export async function convertWorker(pages: Page[], cursor: { next: number }, w: WorkerCtx): Promise<void> {
  let pandocDead: string | null = null;
  while (cursor.next < pages.length) {
    if (pandocDead) throw new BuildError(pandocDead);
    const page = pages[cursor.next++];
    const sourceRel = sourceRelOf(page) ?? `${page.relPath}/_index.md`;

    const cached = w.cache.get(page);
    w.cache.note(!!cached);
    let render: CachedRender;
    if (cached) {
      render = cached;
      w.broken.push(...cached.broken);
      w.warnings.push(...cached.warnings);
      w.privateLeakWarns.push(...cached.privateWarns);
      for (const a of cached.assets) w.assets.restore(page.abbrlink, a);
    } else {
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

      const broken: BrokenLink[] = [];
      const warnings: string[] = [];
      const privateWarns: string[] = [];
      const assigned: PinnedAsset[] = [];
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
            if (w.inPrivateSubtree(srcRel)) privateWarns.push(`${sourceRel} references private file ${srcRel} (published via --allow-private-assets)`);
            try {
              const out = w.assets.assign(page.abbrlink, srcRel);
              assigned.push(w.assets.pinOf(page.abbrlink, srcRel)!);
              return out;
            } catch (err) {
              throw new BuildError(`<${node} ${attr}="${origin}"> → ${(err as Error).message}`);
            }
          },
        },
        isPublicAsset: (srcRel: string): boolean => !w.inPrivateSubtree(srcRel),
        isPrivatePage: w.isPrivatePage,
        inPrivateSubtree: w.inPrivateSubtree,
        dirIndexHref: (dirRel: string): string | null => w.pageByRel.get(nfc(dirRel))?.href ?? null,
        onBroken: (b) => broken.push(b),
        onWarn: (m) => warnings.push(m),
      });
      render = { html: r.html, toc: r.toc, inlineStyles: r.inlineStyles, assets: assigned, broken, warnings, privateWarns };
      // A page with failures is never reused: its next build must re-report them.
      if (!broken.length) w.cache.put(page, render);
      w.broken.push(...broken);
      w.warnings.push(...warnings);
      w.privateLeakWarns.push(...privateWarns);
    }

    page.html = applyMermaid(render.html, page, w.mermaid);
    page.toc = render.toc;
    for (const s of render.inlineStyles) w.bodyInlineStyles.add(s);
  }
}