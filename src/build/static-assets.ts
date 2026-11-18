// Content-addressed static assets under /static/<name>.<hash>.<ext>. Browser
// modules emit in dependency order; a missing import or cycle fails the build.
import fs from 'node:fs';
import path from 'node:path';
import { hash8, hashedName, staticUrl } from '../core/util.ts';
import type { AssetUrls } from '../core/types.ts';

interface StaticBundle {
  /** dist-relative path → bytes (URLs under `/static/`). */
  files: Map<string, string | Buffer>;
  urls: AssetUrls;
}

// Only real import specifiers, so string literals like `"./foo"` are never
// treated as modules.
const JS_IMPORT = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])\.\/([A-Za-z0-9_./-]+)\2/g;

/** Rewrite `./x.js` specifiers to hashed filenames. An unrewritten specifier
 *  404s at runtime, so it fails the build. */
export function rewriteModuleImports(source: string, names: Map<string, string>): string {
  const unknown = [...source.matchAll(JS_IMPORT)].map((m) => m[3]).filter((file) => !names.has(file));
  if (unknown.length) {
    throw new Error(`unhandled relative import in a browser module: ${[...new Set(unknown)].join(', ')}`);
  }
  return source.replace(JS_IMPORT, (_whole, lead: string, quote: string, file: string) => `${lead}${quote}./${names.get(file)}${quote}`);
}

interface StaticInput {
  themeDir: string;
  /** Diagram CSS text; empty when no page needs it. */
  diagramsCss: string;
  /** Search index JSON; empty when not built. */
  searchIndexJson: string;
  /** Strip TS types from a browser script. */
  strip: (source: string) => string;
  /** URL-space base path ('' or '/repo') carried by every emitted asset URL. */
  basePath: string;
}

/** `define` as an inline expression so a literal assignment is never rewritten. */
const SPA_DEFINE = 'const __SPA__ = ';
const SPA_PLACEHOLDER = '__NOTEFLOW_SPA_CONFIG__';

/** Every js/*.ts module, keyed by emitted base name (directory-derived). */
function moduleSources(jsDir: string, strip: (source: string) => string): Map<string, string> {
  const sources = new Map<string, string>();
  for (const file of fs.readdirSync(jsDir).filter((f) => f.endsWith('.ts')).sort()) {
    sources.set(`${file.slice(0, -3)}.js`, strip(fs.readFileSync(path.join(jsDir, file), 'utf8')));
  }
  if (!sources.has('app.js')) throw new Error(`the theme has no entry module: ${path.join(jsDir, 'app.ts')}`);
  return sources;
}

/** Import specifiers inside a module, as base names (`search.js`). */
function importsOf(source: string): string[] {
  return [...source.matchAll(JS_IMPORT)].map((m) => m[3]);
}

/** Dependencies before importers; `app.js` is the entry and emits last. */
export function topoOrder(sources: Map<string, string>): string[] {
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (base: string, chain: string[]): void => {
    const mark = state.get(base);
    if (mark === 'done') return;
    if (mark === 'visiting') throw new Error(`import cycle among browser modules: ${[...chain, base].join(' -> ')}`);
    if (!sources.has(base)) throw new Error(`browser module imports a missing module: ${[...chain, base].join(' -> ')}`);
    state.set(base, 'visiting');
    for (const dep of importsOf(sources.get(base)!)) visit(dep, [...chain, base]);
    state.set(base, 'done');
    order.push(base);
  };
  // Deterministic: declared order, with the entry module (app.js) last so its
  // importers are all emitted before it.
  const names = [...sources.keys()].sort((a, b) => (a === 'app.js' ? 1 : b === 'app.js' ? -1 : a.localeCompare(b)));
  for (const base of names) visit(base, []);
  return order;
}

function emitModule(base: string, source: string, renamed: Map<string, string>, add: (rel: string, content: string | Buffer) => string): string {
  // Hash the rewritten bytes: a dependency's hash covers its final imports.
  const rewritten = rewriteModuleImports(source, renamed);
  const name = hashedName(base, hash8(rewritten));
  renamed.set(base, name);
  return add(`js/${name}`, rewritten);
}

/** Build the hashed static bundle from the theme. Pure output; no writes. */
export function buildStaticAssets(input: StaticInput): StaticBundle {
  const files = new Map<string, string | Buffer>();
  const add = (rel: string, content: string | Buffer): string => {
    files.set(`static/${rel}`, content);
    return staticUrl(rel, input.basePath);
  };
  const jsDir = path.join(input.themeDir, 'js');

  const diagramsUrl = input.diagramsCss
    ? add(hashedName('diagrams.css', hash8(input.diagramsCss)), input.diagramsCss)
    : '';

  const sources = moduleSources(jsDir, input.strip);
  const spaSource = sources.get('spa.js');
  if (spaSource === undefined) throw new Error('the theme has no soft-navigation module: js/spa.ts');
  if (!spaSource.includes(SPA_DEFINE + SPA_PLACEHOLDER)) {
    throw new Error(`spa.ts is missing the ${SPA_DEFINE}${SPA_PLACEHOLDER} placeholder; soft-navigation config cannot be injected`);
  }
  sources.set('spa.js', spaSource.replace(SPA_DEFINE + SPA_PLACEHOLDER, SPA_DEFINE + JSON.stringify({ diagramsCss: diagramsUrl, basePath: input.basePath }, null, 2)));

  const renamed = new Map<string, string>();
  const urls = new Map<string, string>();
  for (const base of topoOrder(sources)) {
    const url = emitModule(base, sources.get(base)!, renamed, add);
    urls.set(base, url);
  }

  const cssBuf = fs.readFileSync(path.join(input.themeDir, 'css/style.css'));
  const styleUrl = add(hashedName('style.css', hash8(cssBuf)), cssBuf);

  // The icon set is one raster artwork at several sizes; the wide mark is the
  // header/footer glyph, the square one is the tab/touch icon.
  const iconDir = path.join(input.themeDir, 'img');
  const icon = (name: string): string => {
    const buf = fs.readFileSync(path.join(iconDir, name));
    return add(`img/${hashedName(name, hash8(buf))}`, buf);
  };
  const markUrl = icon('mark.png');
  const faviconUrl = icon('favicon.png');
  const touchIconUrl = icon('apple-touch-icon.png');

  let fontsUrl = '';
  const fontsDir = path.join(input.themeDir, 'fonts');
  if (fs.existsSync(fontsDir)) {
    const faces: string[] = [];
    for (const family of fs.readdirSync(fontsDir).sort()) {
      const familyDir = path.join(fontsDir, family);
      if (!fs.statSync(familyDir).isDirectory()) continue;
      const cssFile = path.join(familyDir, 'faces.css');
      if (!fs.existsSync(cssFile)) continue;
      let css = fs.readFileSync(cssFile, 'utf8');
      for (const f of fs.readdirSync(familyDir).filter((x) => x.endsWith('.woff2')).sort()) {
        const buf = fs.readFileSync(path.join(familyDir, f));
        const url = add(`fonts/${family}/${hashedName(f, hash8(buf))}`, buf);
        // Point faces.css `url(./<family>/<font>.woff2)` at the hashed copy.
        css = css.split(`url(./${family}/${f})`).join(`url(${url})`);
      }
      const unresolved = css.match(/url\(\s*['"]?\.\.?\//);
      if (unresolved) throw new Error(`unrewritten relative url in font CSS: ${family}/faces.css`);
      faces.push(css);
    }
    if (faces.length) {
      const css = faces.join('\n');
      fontsUrl = add(hashedName('fonts.css', hash8(css)), css);
    }
  }

  const searchIndexUrl = input.searchIndexJson
    ? add(hashedName('search-index.json', hash8(input.searchIndexJson)), input.searchIndexJson)
    : '';

  return {
    files,
    urls: {
      style: styleUrl,
      app: urls.get('app.js')!,
      spa: urls.get('spa.js')!,
      search: urls.get('search.js')!,
      media: urls.get('media.js')!,
      comments: urls.get('comments.js')!,
      favicon: faviconUrl,
      touchIcon: touchIconUrl,
      mark: markUrl,
      fonts: fontsUrl,
      diagrams: diagramsUrl,
      searchIndex: searchIndexUrl,
    },
  };
}
