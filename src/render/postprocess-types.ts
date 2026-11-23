// The interface between the build pipeline and the body HTML pass.
import type { TocItem } from '../core/types.ts';

export interface BrokenLink {
  relPath: string;
  msg: string;
  /** The heading of the section the broken element sits under, if any. */
  where?: string;
}

/** Argument to `assets.add`: what the author wrote, so a failure can name the
 *  element, the attribute and the literal reference instead of only the
 *  resolved internal path. */
export interface AssetRef {
  srcRel: string;
  origin: string;
  attr: string;
  node: string;
}

export interface PostprocessCtx {
  pageRelPath: string;
  /** The site's own host; links to any other host open in a new tab. */
  siteHost: string;
  /** URL-space base path ('' or '/repo'); emitted attachment URLs carry it. */
  basePath: string;
  urlMap: ReadonlyMap<string, string>;
  assets: { add(ref: AssetRef): string | null };
  isPublicAsset(rel: string): boolean;
  isPrivatePage(rel: string): boolean;
  /** True when rel is inside (or is) a private subtree — pages and directories alike. */
  inPrivateSubtree?(rel: string): boolean;
  dirIndexHref?(relDir: string): string | null;
  onBroken?(b: BrokenLink): void;
  onWarn?(msg: string): void;
}

export interface PostprocessResult {
  html: string;
  toc: TocItem[];
  /** Everything the page's CSP must cover, as the exact bytes the browser
   *  hashes: `<style>` bodies and style attribute values in `styles`; inline
   *  `<script>` bodies and `on…` handler values in `scripts` (handlers need
   *  script-src 'unsafe-hashes', which is set for the site as a whole). */
  csp: { styles: string[]; scripts: string[] };
}
