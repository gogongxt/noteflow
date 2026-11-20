// Site configuration: every value and path resolves through here. Plain-JS
// profiles (site.config.mjs, site.config.local.mjs) are merged over DEFAULTS.
// Each file is validated as it is read, so an error names the file to edit.
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
export interface GiscusConfig {
  repo: string;
  repoId: string;
  category?: string;
  categoryId?: string;
  /** Widget UI language, e.g. en; falls back to the site lang. */
  lang?: string;
  reactionsEnabled?: boolean;
  inputPosition?: 'top' | 'bottom';
}

/** Git mirror mode for a serving host: poll the notes repository's remote and
 *  hard-reset the content dir onto it, rebuilding when the tip moves. The
 *  reset is unconditional — edit notes where you edit them, never on the
 *  mirror. */
export interface SyncConfig {
  /** Any `git` remote URL (ssh://…, https://…, a local path). */
  remote: string;
  /** Branch to follow. Default 'master'. */
  branch?: string;
  /** Poll interval in seconds; a failed poll backs off up to 5×. Default 15, min 2. */
  intervalSec?: number;
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

/** Selectable mermaid themes; each has a real dark twin. */
export const MERMAID_THEMES = ['default', 'redux', 'redux-color', 'neo'] as const;
export type MermaidTheme = (typeof MERMAID_THEMES)[number];

export interface MermaidConfig {
  /** Light-mode theme; the build pairs it with its dark twin. Default 'default'. */
  theme?: MermaidTheme;
  /** CSS-colour overrides applied to both modes. */
  themeVariables?: Record<string, string>;
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
  /** Mermaid diagram theme. */
  mermaid?: MermaidConfig;
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
  /** Poll-and-reset mirroring of the content repo. Absent: no syncing. */
  sync?: SyncConfig;
}

/** Everything a config file may omit. `url` and `siteName` have no default. */
type ConfigDefaults = Omit<AppConfig, 'url' | 'siteName'>;

const DEFAULTS: ConfigDefaults = {
  lang: 'en',
  postPattern: '/posts/{abbrlink}',
  pageSize: { home: 20, feed: 20 },
  contentDir: 'notes',
  outDir: 'dist',
  themeDir: 'themes/default',
  cacheDir: '.cache',
  manifestFile: '.build-manifest.json',
};

/** The neutral site profile, and the personal override that merges on top. */
export const SITE_CONFIG_FILE = 'site.config.mjs';

/** `.mjs` rather than `.ts`: it must load from a bare notes repo with no
 *  package.json declaring a module type. Found at the project root or the
 *  content root; a project-root copy wins. */
export const LOCAL_CONFIG_FILE = 'site.config.local.mjs';
export const CONFIG_FILES = [SITE_CONFIG_FILE, LOCAL_CONFIG_FILE];

/** Every key a config file may set; anything else is a typo. A Record over
 *  AppConfig's keys, so adding a field without listing it here is a compile error. */
const CONFIG_KEYS = new Set<string>(
  Object.keys({
    url: true, siteName: true, lang: true, description: true, postPattern: true,
    pageSize: true, mermaid: true, giscus: true, repoUrl: true, edit: true, cspMeta: true,
    footer: true, contentDir: true, outDir: true, themeDir: true, cacheDir: true,
    manifestFile: true, sync: true,
  } satisfies Record<keyof AppConfig, true>),
);

export interface LocalConfig {
  file: string;
  atContentRoot: boolean;
}

/** A project-root override wins over one at the content root. */
export function localConfigOf(root: string, contentDir: string): LocalConfig | null {
  const atRoot = path.join(root, LOCAL_CONFIG_FILE);
  if (fs.existsSync(atRoot)) return { file: atRoot, atContentRoot: false };
  const inContent = path.resolve(root, contentDir, LOCAL_CONFIG_FILE);
  return fs.existsSync(inContent) ? { file: inContent, atContentRoot: true } : null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** An absolute http(s) URL. The header renders it as an href, so a `javascript:`
 *  or relative value would be a broken or dangerous link. */
function isHttpUrl(v: unknown): boolean {
  if (!nonEmpty(v)) return false;
  try {
    return /^https?:$/.test(new URL(v).protocol);
  } catch {
    return false;
  }
}

/** Import a config module, reject unknown keys, and validate every value it
 *  sets. `label` names the file in every error. */
async function readConfig(file: string, label: string): Promise<Record<string, unknown>> {
  let mtime: number;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    throw new BuildError(`config file not found: ${label}`);
  }
  // The mtime query defeats ESM's per-URL module cache, so a file edited in
  // place (watch mode, tests) is re-read — and an unchanged file is not.
  const mod = (await import(`${pathToFileURL(file).href}?v=${mtime}`)) as { default?: unknown };
  if (!isObject(mod.default)) throw new BuildError(`${label}: must \`export default { … }\``);
  const cfg = mod.default;
  const unknown = Object.keys(cfg).filter((k) => !CONFIG_KEYS.has(k));
  if (unknown.length) throw new BuildError(`${label}: unknown key ${unknown.map((k) => `'${k}'`).join(', ')}`);
  checkFields(cfg, label);
  return cfg;
}

/** A config error naming the file it came from. A declaration (not an arrow
 *  const) so TypeScript narrows the preceding type guards after the call. */
function bad(origin: string, msg: string): never {
  throw new BuildError(`${origin}: ${msg}`);
}

/** Validate the values a single file sets; omitted keys are defaults. */
function checkFields(cfg: Record<string, unknown>, origin: string): void {
  if (cfg.url !== undefined && !isHttpUrl(cfg.url)) {
    bad(origin, 'url must be an absolute http(s) URL, e.g. https://example.com');
  }
  for (const k of ['siteName', 'lang', 'contentDir', 'outDir', 'themeDir', 'cacheDir', 'manifestFile'] as const) {
    if (cfg[k] !== undefined && !nonEmpty(cfg[k])) bad(origin, `${k} must be a non-empty string`);
  }
  if (cfg.description !== undefined && typeof cfg.description !== 'string') bad(origin, 'description must be a string');
  if (cfg.postPattern !== undefined && (typeof cfg.postPattern !== 'string' || !cfg.postPattern.includes('{abbrlink}'))) {
    bad(origin, 'postPattern must contain {abbrlink}');
  }
  if (cfg.repoUrl !== undefined && !isHttpUrl(cfg.repoUrl)) bad(origin, 'repoUrl must be an absolute http(s) URL');
  if (cfg.cspMeta !== undefined && typeof cfg.cspMeta !== 'boolean') bad(origin, 'cspMeta must be a boolean');

  if (cfg.pageSize !== undefined) {
    const size = cfg.pageSize;
    if (!isObject(size)) bad(origin, 'pageSize must be an object { home, feed }');
    for (const k of ['home', 'feed'] as const) {
      if (!Number.isInteger(size[k]) || (size[k] as number) <= 0) bad(origin, `pageSize.${k} must be a positive integer`);
    }
  }
  checkMermaid(cfg.mermaid, origin);
  checkGiscus(cfg.giscus, origin);
  checkEdit(cfg.edit, origin);
  checkFooter(cfg.footer, origin);
  checkSync(cfg.sync, origin);
}

function checkSync(s: unknown, origin: string): void {
  if (s === undefined) return;
  if (!isObject(s)) bad(origin, 'sync must be an object');
  if (!nonEmpty(s.remote)) bad(origin, 'sync.remote must be a non-empty git remote URL');
  if (s.branch !== undefined && !nonEmpty(s.branch)) bad(origin, 'sync.branch must be a non-empty string');
  if (s.intervalSec !== undefined && (!Number.isFinite(s.intervalSec) || (s.intervalSec as number) < 2)) {
    bad(origin, 'sync.intervalSec must be a number of seconds >= 2');
  }
}

/** #rgb, #rrggbb, rgb()/rgba() or a colour name; `url(...)` stays out. */
const MERMAID_COLOR = /^(#[0-9a-f]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)|[a-z]{3,24})$/i;

function checkMermaid(m: unknown, origin: string): void {
  if (m === undefined) return;
  if (!isObject(m)) bad(origin, 'mermaid must be an object');
  if (m.theme !== undefined && !MERMAID_THEMES.includes(m.theme as MermaidTheme)) {
    bad(origin, `mermaid.theme must be one of ${MERMAID_THEMES.join(', ')}`);
  }
  if (m.themeVariables !== undefined) {
    if (!isObject(m.themeVariables)) bad(origin, 'mermaid.themeVariables must be an object of colour strings');
    for (const [k, v] of Object.entries(m.themeVariables)) {
      if (k === 'fontFamily') bad(origin, 'mermaid.themeVariables.fontFamily is set from the theme; override the theme font instead');
      if (typeof v !== 'string' || !MERMAID_COLOR.test(v.trim())) {
        bad(origin, `mermaid.themeVariables.${k} must be a CSS colour, got ${JSON.stringify(v)}`);
      }
    }
  }
}

function checkGiscus(g: unknown, origin: string): void {
  if (g === undefined) return;
  if (!isObject(g)) bad(origin, 'giscus must be an object');
  if (!nonEmpty(g.repo) || !nonEmpty(g.repoId)) bad(origin, 'giscus needs at least { repo, repoId } string fields');
  for (const k of ['category', 'categoryId', 'lang'] as const) {
    if (g[k] !== undefined && !nonEmpty(g[k])) bad(origin, `giscus.${k} must be a non-empty string`);
  }
  if (g.reactionsEnabled !== undefined && typeof g.reactionsEnabled !== 'boolean') {
    bad(origin, 'giscus.reactionsEnabled must be a boolean');
  }
  if (g.inputPosition !== undefined && g.inputPosition !== 'top' && g.inputPosition !== 'bottom') {
    bad(origin, "giscus.inputPosition must be 'top' or 'bottom'");
  }
}

function checkEdit(e: unknown, origin: string): void {
  if (e === undefined) return;
  if (!isObject(e)) bad(origin, 'edit must be an object');
  if (!isHttpUrl(e.repoUrl)) bad(origin, 'edit.repoUrl must be an absolute http(s) URL');
  const repo = new URL(String(e.repoUrl));
  // editUrlOf concatenates onto repoUrl; a ?query or #hash would land after the
  // file path and silently point at the wrong page.
  if (repo.search || repo.hash) bad(origin, 'edit.repoUrl must not carry a query string or fragment');
  if (e.branch !== undefined && !nonEmpty(e.branch)) bad(origin, 'edit.branch must be a non-empty string');
  if (e.provider !== undefined && !EDIT_PROVIDERS.includes(e.provider as EditProvider)) {
    bad(origin, `edit.provider must be one of ${EDIT_PROVIDERS.join(', ')}`);
  }
  const root = e.root;
  if (
    root !== undefined &&
    (typeof root !== 'string' ||
      (root !== '' &&
        (root.startsWith('/') || root.endsWith('/') || root.includes('\\') ||
          root.split('/').some((s) => !s || s === '.' || s === '..'))))
  ) {
    bad(origin, "edit.root must be a repo-relative path like 'docs' ('' when the content dir is the repo root)");
  }
}

/** A footer href: a site path or an absolute http(s)/mailto/tel URL. `//host`
 *  is protocol-relative, so the leading-slash check cannot be naive. */
function checkFooterHref(href: unknown, key: string, origin: string): void {
  const ok = nonEmpty(href) && !/^\/(?:\/|\\|\/\\|\\)/.test(href) && (href.startsWith('/') || /^(https?:\/\/|mailto:|tel:)/i.test(href));
  if (!ok) bad(origin, `${key} must start with / , http(s)://, mailto: or tel:`);
}

function checkFooter(f: unknown, origin: string): void {
  if (f === undefined) return;
  if (!isObject(f)) bad(origin, 'footer must be an object');
  for (const k of ['copyright', 'author', 'icp'] as const) {
    if (f[k] !== undefined && !nonEmpty(f[k])) bad(origin, `footer.${k} must be a non-empty string`);
  }
  if (f.since !== undefined && (!Number.isInteger(f.since) || (f.since as number) < 1900)) {
    bad(origin, 'footer.since must be a four-digit year');
  }
  for (const k of ['copyrightUrl', 'authorUrl', 'icpUrl'] as const) {
    if (f[k] !== undefined) checkFooterHref(f[k], `footer.${k}`, origin);
  }
  if (f.credit !== undefined && typeof f.credit !== 'boolean') bad(origin, 'footer.credit must be a boolean');
}

/** Load site.config.mjs plus the first local override (see localConfigOf).
 *  With `file` (--config) the profile replaces the whole stack: CI and docs
 *  never see a developer's personal values. */
export async function loadConfig(file?: string, contentDir?: string, root: string = ROOT): Promise<AppConfig> {
  const baseLabel = file ? path.relative(process.cwd(), file) || file : SITE_CONFIG_FILE;
  const base = await readConfig(file ?? path.join(root, SITE_CONFIG_FILE), baseLabel);
  let merged: Record<string, unknown> = { ...DEFAULTS, ...base };
  if (!file) {
    const local = localConfigOf(root, contentDir ?? String(base.contentDir ?? DEFAULTS.contentDir));
    if (local) {
      const over = await readConfig(local.file, LOCAL_CONFIG_FILE);
      // The file was found *by* this contentDir; re-pointing it would move the
      // build while the file keeps being read from the old tree.
      if (local.atContentRoot && over.contentDir !== undefined) {
        throw new BuildError(`${LOCAL_CONFIG_FILE} at the content root cannot set contentDir; put that override at the project root`);
      }
      merged = { ...merged, ...over };
    }
  }
  for (const k of ['url', 'siteName'] as const) {
    if (merged[k] === undefined) throw new BuildError(`${baseLabel}: ${k} is required`);
  }
  if (merged.sync !== undefined) {
    merged.sync = { branch: 'master', intervalSec: 15, ...(merged.sync as Record<string, unknown>) };
  }
  return merged as unknown as AppConfig;
}

/** The site's own host:port, as the link policy compares against. `url` was
 *  validated in loadConfig, so a bad value can only arrive from a hand-built
 *  config in tests. */
export function siteHostOf(siteUrl: string): string {
  try {
    return new URL(siteUrl).host;
  } catch {
    throw new BuildError(`url is not a valid absolute URL: ${siteUrl}`);
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
