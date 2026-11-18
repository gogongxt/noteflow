// Site configuration: every value and path resolves through here. A gitignored
// site.config.local.ts (or .mjs) overrides individual keys for personal values.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BuildError } from './util.ts';

/** The project root (this file lives at <root>/src/core/config.ts). */
export const ROOT = path.resolve(import.meta.dirname, '..', '..');

/** Official giscus widget configuration; the only third-party frame the CSP allows. */
interface GiscusConfig {
  repo: string;
  repoId: string;
  category?: string;
  categoryId?: string;
  /** Widget UI language, e.g. en; falls back to the site lang. */
  lang?: string;
  reactionsEnabled?: boolean;
  inputPosition?: 'top' | 'bottom';
}

/** The site footer: one line of identity on the left, the filing number on the
 *  right. Every piece renders only when configured. */
export interface FooterConfig {
  /** The © line; `{year}` becomes the build year (a `since`–year range when
   *  `since` is set), `{site}` the site name. Defaults to `© {year} {site}`. */
  copyright?: string;
  /** First year of a `2020–2026` copyright range. */
  since?: number;
  /** Wrap the © line in a link: a site path or an absolute URL. */
  copyrightUrl?: string;
  /** Author credit after the © line: `By <author>`. Unset renders nothing. */
  author?: string;
  /** Link target for the author name. */
  authorUrl?: string;
  /** ICP 备案号, linked to the MIIT query page in a new tab. */
  icp?: string;
  /** Override the ICP link target. */
  icpUrl?: string;
  /** The theme mark beside the © line, linking this project; on by default. */
  credit?: boolean;
}

/** Rendering-facing site settings (everything a template may read). */
export interface SiteConfig {
  url: string;
  siteName: string;
  lang: string;
  description?: string;
  /** `/posts/{abbrlink}` → the URL of every note. */
  postPattern: string;
  pageSize: { home: number; feed: number };
  /** When set, public notes show comments by default; `comments: false` opts out per note. */
  giscus?: GiscusConfig;
  /** Repository URL shown as a GitHub icon in the header; hidden when unset. */
  repoUrl?: string;
  /** Also carry the CSP in a <meta> tag — for hosts that cannot send headers
   *  (GitHub Pages). nginx and serve.ts keep sending theirs. */
  cspMeta?: boolean;
  /** Site footer. Omit for the default footer (copyright + credit). */
  footer?: FooterConfig;
}

/** SiteConfig plus the builder's own paths, all repo-relative. */
export interface AppConfig extends SiteConfig {
  /** Markdown content root; in real use a separate private repository. */
  contentDir: string;
  /** Build output. */
  outDir: string;
  /** Theme directory (layout, css, fonts, inline scripts). */
  themeDir: string;
  /** Build caches (mermaid prerender, link-card metadata, …). */
  cacheDir: string;
  /** Build manifest, written next to the output for serve/deploy. */
  manifestFile: string;
}

const DEFAULTS: Partial<AppConfig> = {
  contentDir: 'notes',
  outDir: 'dist',
  themeDir: 'themes/default',
  cacheDir: '.cache',
  manifestFile: '.build-manifest.json',
  postPattern: '/posts/{abbrlink}',
  pageSize: { home: 20, feed: 20 },
};

/** Local override files, highest priority first. */
const LOCAL_CONFIG_FILES = ['site.config.local.ts', 'site.config.local.mjs'];
/** Files whose change invalidates a watcher. */
export const CONFIG_FILES = ['site.config.ts', ...LOCAL_CONFIG_FILES];

async function readModule(file: string): Promise<Record<string, unknown>> {
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
  return (mod.default ?? mod) as Record<string, unknown>;
}

function requireString(cfg: Record<string, unknown>, key: string): void {
  if (typeof cfg[key] !== 'string' || !(cfg[key] as string).trim()) {
    throw new BuildError(`site.config.ts: ${key} must be a non-empty string`);
  }
}

/** A footer href: a site path (base path added at render time) or an absolute
 *  http(s)/mailto/tel URL — anything the output audit can classify. `//host`
 *  and `/\host` are protocol-relative, so a bare starts-with-slash check would
 *  wave them through.
 */
function checkFooterHref(href: string, key: string): void {
  const bad =
    typeof href !== 'string' ||
    !href.trim() ||
    /^\/(?:\/|\\|\/\\|\\)/.test(href) ||
    (!href.startsWith('/') && !/^(https?:\/\/|mailto:|tel:)/i.test(href));
  if (bad) throw new BuildError(`site.config.ts: ${key} must start with / , http(s)://, mailto: or tel:`);
}

function validate(cfg: AppConfig): AppConfig {
  requireString(cfg as unknown as Record<string, unknown>, 'url');
  requireString(cfg as unknown as Record<string, unknown>, 'siteName');
  if (!/^https?:\/\//i.test(cfg.url)) throw new BuildError(`site.config.ts: url must start with http:// or https://`);
  siteHostOf(cfg.url); // rejects a scheme-only or otherwise unparsable url here, not mid-build

  const size = cfg.pageSize as { home?: unknown; feed?: unknown } | undefined;
  if (!size || typeof size !== 'object') throw new BuildError('site.config.ts: pageSize must be an object');
  for (const k of ['home', 'feed'] as const) {
    const v = size[k];
    if (!Number.isInteger(v) || (v as number) <= 0) throw new BuildError(`site.config.ts: pageSize.${k} must be a positive integer`);
  }
  if (!cfg.postPattern.includes('{abbrlink}')) throw new BuildError('site.config.ts: postPattern must contain {abbrlink}');

  const g = cfg.giscus;
  if (g !== undefined) {
    if (typeof g !== 'object' || !g || typeof g.repo !== 'string' || typeof g.repoId !== 'string') {
      throw new BuildError('site.config.ts: giscus needs at least { repo, repoId } string fields');
    }
  }

  const f = cfg.footer;
  if (f !== undefined) {
    if (typeof f !== 'object' || !f || Array.isArray(f)) throw new BuildError('site.config.ts: footer must be an object');
    for (const k of ['copyright', 'author', 'icp'] as const) {
      if (f[k] !== undefined && (typeof f[k] !== 'string' || !f[k]!.trim())) {
        throw new BuildError(`site.config.ts: footer.${k} must be a non-empty string`);
      }
    }
    if (f.since !== undefined && (!Number.isInteger(f.since) || f.since < 1900)) {
      throw new BuildError('site.config.ts: footer.since must be a four-digit year');
    }
    for (const k of ['copyrightUrl', 'authorUrl'] as const) {
      if (f[k] !== undefined) checkFooterHref(f[k]!, `footer.${k}`);
    }
    if (f.credit !== undefined && typeof f.credit !== 'boolean') {
      throw new BuildError('site.config.ts: footer.credit must be a boolean');
    }
    if (f.icpUrl !== undefined) checkFooterHref(f.icpUrl, 'footer.icpUrl');
  }
  return cfg;
}

/** Load site.config.ts, then apply the first existing local override. With
 *  `file` (--config), that profile replaces the whole stack — no local
 *  overrides — so CI and docs builds never see a developer's personal values. */
export async function loadConfig(file?: string): Promise<AppConfig> {
  const baseFile = file ?? path.join(ROOT, 'site.config.ts');
  let merged: Record<string, unknown> = { ...DEFAULTS, ...(await readModule(baseFile)) };
  if (!file) {
    const local = LOCAL_CONFIG_FILES.map((f) => path.join(ROOT, f)).find((f) => fs.existsSync(f));
    if (local) merged = { ...merged, ...(await readModule(local)) };
  }
  return validate(merged as unknown as AppConfig);
}

/**
 * The site's own host:port, as the link policy compares against. A relative or
 * scheme-only url is a config error, reported like every other one.
 */
export function siteHostOf(siteUrl: string): string {
  try {
    return new URL(siteUrl).host;
  } catch {
    throw new BuildError(`site.config.ts: url is not a valid absolute URL: ${siteUrl}`);
  }
}

/** The URL path prefix every emitted URL carries, derived from `url`'s own
 *  pathname — a GitHub Pages project site (`https://user.github.io/<repo>/`)
 *  serves under one. '' for a root deployment. The prefix lives in URL space
 *  only; dist/ keeps its unprefixed layout. */
export function basePathOf(siteUrl: string): string {
  const pathname = new URL(siteUrl).pathname.replace(/\/+$/, '');
  return pathname === '/' ? '' : pathname;
}

/** A site-root-relative path (`/posts/x`) as it appears in hrefs. */
export function siteUrlOf(siteUrl: string, p: string): string {
  return basePathOf(siteUrl) + (p.startsWith('/') ? p : `/${p}`);
}

/** Inverse of siteUrlOf. Fail-closed: without the prefix a link 404s in production. */
export function siteRelOf(siteUrl: string, href: string): string {
  const base = basePathOf(siteUrl);
  if (!base) return href;
  if (href === base) return '/';
  if (href.startsWith(base + '/')) return href.slice(base.length);
  throw new BuildError(`URL is missing the site's base path ${base}: ${href}`);
}

/** Third-party video players a note may embed. Any iframe in the output must
 *  point at one of these or at the comments widget; the output audit enforces
 *  it, and the CSP's frame-src lists them. */
export const EMBED_ORIGINS = ['https://player.bilibili.com', 'https://www.youtube-nocookie.com'] as const;

/** Origins the site may iframe: the comments widget (when configured) plus the
 *  video embed hosts. `'none'` only when nothing at all is allowed. */
export function frameOriginsOf(cfg: { giscus?: GiscusConfig }): string[] {
  return [...(cfg.giscus ? ['https://giscus.app'] : []), ...EMBED_ORIGINS];
}

export function frameSrcOf(cfg: { giscus?: GiscusConfig }): string {
  const origins = frameOriginsOf(cfg);
  return origins.length ? origins.join(' ') : "'none'";
}

/** Resolve a repo-relative path against the project root. */
export function repoPath(...rel: string[]): string {
  return path.join(ROOT, ...rel);
}