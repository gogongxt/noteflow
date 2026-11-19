// Site configuration: every value and path resolves through here. A gitignored
// site.config.local.ts (or .mjs) overrides individual keys for personal values.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BuildError } from './util.ts';

/** The project root (this file lives at <root>/src/core/config.ts). */
export const ROOT = path.resolve(import.meta.dirname, '..', '..');

export const EDIT_PROVIDERS = ['gitea', 'github', 'gitlab'] as const;
export type EditProvider = (typeof EDIT_PROVIDERS)[number];

/** The content tree's source repository; enables the per-page edit link. */
export interface EditConfig {
  /** Web URL of the repository, e.g. https://git.example.com/you/notes. */
  repoUrl: string;
  /** Branch the site builds from. Default 'main'. */
  branch?: string;
  /** Default 'gitea'; the edit route differs per forge. */
  provider?: EditProvider;
  /** The content dir's path inside the repo; '' when it is the repo root. */
  root?: string;
}

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
  /** The theme mark and the © line's link back to this project; on by default. */
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
  /** Source repository of the notes; page titles gain an edit link into their
   *  file. Hidden when unset. */
  edit?: EditConfig;
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

/** Project-root local overrides, highest priority first. */
const LOCAL_CONFIG_FILES = ['site.config.local.ts', 'site.config.local.mjs'];
/** At the content root: plain JS, no imports, so it travels with the notes repo. */
export const CONTENT_CONFIG_FILE = 'site.config.local.mjs';
export const CONFIG_FILES = ['site.config.ts', ...LOCAL_CONFIG_FILES];

export interface LocalConfig {
  file: string;
  atContentRoot: boolean;
}

/** A project-root override wins over one at the content root. */
export function localConfigOf(root: string, contentDir: string): LocalConfig | null {
  for (const f of LOCAL_CONFIG_FILES) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) return { file: p, atContentRoot: false };
  }
  const inContent = path.resolve(root, contentDir, CONTENT_CONFIG_FILE);
  return fs.existsSync(inContent) ? { file: inContent, atContentRoot: true } : null;
}

async function readModule(file: string): Promise<Record<string, unknown>> {
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
  return (mod.default ?? mod) as Record<string, unknown>;
}

function requireString(cfg: Record<string, unknown>, key: string): void {
  if (typeof cfg[key] !== 'string' || !(cfg[key] as string).trim()) {
    throw new BuildError(`site.config.ts: ${key} must be a non-empty string`);
  }
}

/** A footer href: a site path or an absolute http(s)/mailto/tel URL. `//host`
 *  is protocol-relative, so the leading-slash check cannot be naive. */
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

  const e = cfg.edit;
  if (e !== undefined) {
    if (typeof e !== 'object' || !e || Array.isArray(e)) throw new BuildError('site.config.ts: edit must be an object');
    let repo: URL | null = null;
    try {
      repo = new URL(String(e.repoUrl));
    } catch {}
    if (!repo || !/^https?:$/.test(repo.protocol)) {
      throw new BuildError('site.config.ts: edit.repoUrl must be an absolute http(s) URL');
    }
    // editUrlOf concatenates onto repoUrl; a ?query or #hash would land after
    // the file path and silently point at the wrong page.
    if (repo.search || repo.hash) {
      throw new BuildError('site.config.ts: edit.repoUrl must not carry a query string or fragment');
    }
    if (e.branch !== undefined && (typeof e.branch !== 'string' || !e.branch.trim())) {
      throw new BuildError('site.config.ts: edit.branch must be a non-empty string');
    }
    if (e.provider !== undefined && !EDIT_PROVIDERS.includes(e.provider)) {
      throw new BuildError(`site.config.ts: edit.provider must be one of ${EDIT_PROVIDERS.join(', ')}`);
    }
    const root = e.root;
    if (
      root !== undefined &&
      (typeof root !== 'string' ||
        (root !== '' &&
          (root.startsWith('/') || root.endsWith('/') || root.includes('\\') ||
            root.split('/').some((s) => !s || s === '.' || s === '..'))))
    ) {
      throw new BuildError(`site.config.ts: edit.root must be a repo-relative path like 'docs' ('' or omitted when the content dir is the repo root), without leading/trailing slashes or '..'`);
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

/** Load site.config.ts plus the first local override (see localConfigOf).
 *  With `file` (--config) the profile replaces the whole stack: CI and docs
 *  never see a developer's personal values. */
export async function loadConfig(file?: string, contentDir?: string, root: string = ROOT): Promise<AppConfig> {
  const baseFile = file ?? path.join(root, 'site.config.ts');
  const base = { ...DEFAULTS, ...(await readModule(baseFile)) } as Record<string, unknown>;
  let merged = base;
  if (!file) {
    const local = localConfigOf(root, contentDir ?? String(base.contentDir));
    if (local) {
      const over = await readModule(local.file);
      // The file was found *by* this contentDir; re-pointing it would move the
      // build while the file keeps being read from the old tree.
      if (local.atContentRoot && over.contentDir !== undefined) {
        throw new BuildError(
          `${CONTENT_CONFIG_FILE} at the content root cannot set contentDir; put that override in a project-root local config`,
        );
      }
      merged = { ...base, ...over };
    }
  }
  return validate(merged as unknown as AppConfig);
}

/** The site's own host:port, as the link policy compares against. */
export function siteHostOf(siteUrl: string): string {
  try {
    return new URL(siteUrl).host;
  } catch {
    throw new BuildError(`site.config.ts: url is not a valid absolute URL: ${siteUrl}`);
  }
}

/** The URL path prefix every emitted URL carries, from `url`'s pathname (a
 *  GitHub Pages project site has one). '' for root; dist/ stays unprefixed. */
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

const EDIT_ROUTES: Record<EditProvider, string> = {
  gitea: '/_edit/',
  github: '/edit/',
  gitlab: '/-/edit/',
};

/** Encode each segment so '/' survives as a separator. */
const encPath = (p: string): string => p.split('/').map(encodeURIComponent).join('/');

/** The forge edit page for a file relative to the content root; `edit.root`
 *  prefixes where that root sits in the repository. */
export function editUrlOf(cfg: { edit?: EditConfig }, srcRel: string): string | null {
  const e = cfg.edit;
  if (!e) return null;
  const repo = e.repoUrl.replace(/\/+$/, '');
  const branch = e.branch?.trim() || 'main';
  const file = [e.root, srcRel]
    .filter((p): p is string => !!p && p.trim() !== '')
    .map((p) => encPath(p.replace(/^\/+|\/+$/g, '')))
    .join('/');
  return `${repo}${EDIT_ROUTES[e.provider ?? 'gitea']}${encPath(branch)}/${file}`;
}

/** Resolve a repo-relative path against the project root. */
export function repoPath(...rel: string[]): string {
  return path.join(ROOT, ...rel);
}