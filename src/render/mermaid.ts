// Mermaid is rendered in headless Chromium at build time because the site's
// CSP (`style-src 'self'`) blocks the <style> and style="" mermaid injects.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { BuildError, isInside, log } from '../core/util.ts';
import type { Page } from '../core/types.ts';

// Label metrics come from the theme's sans family, else the system stack.
const SYSTEM_FONT_STACK = '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';

function renderTheme(fontFamily: string) {
  return {
    light: { name: 'default', vars: { fontFamily, fontSize: '16px' } },
    dark: { name: 'dark', vars: { fontFamily, fontSize: '16px' } },
  };
}

/** Bump when the pre-render post-processing changes so cached SVGs are rebuilt. */
const STYLE_REVISION = 'r7';

export interface MermaidBlock {
  key: string;
  source: string;
  caption: string;
}

interface ExtractedSource {
    markdown: string;
  blocks: MermaidBlock[];
}

function placeholderHtml(key: string): string {
  return `<div class="mermaid-host" data-mermaid-key="${escapeAttr(key)}"></div>`;
}

const FENCE = /^(\s*)(`{3,}|~{3,})[ \t]*(.*)$/;
const DIV_OPEN = /^\s*:::\s*(\{[^}]*\}|\S+.*)?$/;

interface Attrs {
  id?: string;
  caption?: string;
  key?: string;
}

function parseInfo(info: string): { lang: string; attrs: Attrs } {
  let rest = info.trim();
  let attrText = '';
  const brace = /\{([^}]*)\}\s*$/.exec(rest);
  if (brace) {
    attrText = brace[1];
    rest = rest.slice(0, brace.index).trim();
  }
  let tokens = `${rest} ${attrText}`.split(/\s+/).filter(Boolean);
  if (!rest && attrText) {
    tokens = attrText.split(/\s+/).filter(Boolean);
  }
  const attrs: Attrs = {};
  let lang = '';
  for (const t of tokens) {
    if (t.startsWith('#')) attrs.id = t.slice(1);
    else if (t.startsWith('.')) {
      if (!lang) lang = t.slice(1).toLowerCase();
      continue;
    }
    else {
      const eq = /^([a-z-]+)=(.*)$/.exec(t);
      if (eq) {
        const key = eq[1].toLowerCase();
        const val = unquote(eq[2]);
        if (key === 'caption' || key === 'title') attrs.caption = val;
        else if (key === 'id' || key === 'key') attrs.id = val;
      } else if (!lang) lang = t.toLowerCase();
    }
  }
  return { lang, attrs };
}

function unquote(s: string): string {
  const m = /^(['"])([\s\S]*)\1$/.exec(s.trim());
  return m ? m[2] : s.trim();
}

export function extractMermaid(markdown: string, keyPrefix: string): ExtractedSource {
  const lines = markdown.split('\n');
  const out: string[] = [];
  const blocks: MermaidBlock[] = [];
  let n = 0;

  const push = (source: string, attrs: Attrs): void => {
    const key = attrs.id ? `${keyPrefix}-${attrs.id}` : `${keyPrefix}-${++n}`;
    blocks.push({ key, source: source.replace(/\s+$/, ''), caption: attrs.caption ?? '' });
    out.push('', placeholderHtml(key), '');
  };

  let outerFence = 0;
  let fenceChar = '`';
  const divScopes: boolean[] = [];
  const inDemo = (): boolean => divScopes.some(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[2];
      const info = fence[3] || '';
      const ch = marker[0];

      if (outerFence) {
        if (/^\s*$/.test(info) && marker.length >= outerFence && marker.split('').every((c) => c === ch) && ch === fenceChar) {
          outerFence = 0;
        }
        out.push(line);
        continue;
      }

      const { lang, attrs } = parseInfo(info);
      let j = i + 1;
      while (j < lines.length) {
        const m = FENCE.exec(lines[j]);
        if (m && m[2][0] === ch && m[2].length >= marker.length && /^\s*$/.test(m[3] || '')) break;
        j++;
      }
      if (j < lines.length && lang === 'mermaid' && !inDemo()) {
        push(lines.slice(i + 1, j).join('\n'), attrs);
        i = j;
        continue;
      }
      if (!/^\s*$/.test(info)) {
        outerFence = marker.length;
        fenceChar = ch;
      }
      out.push(line);
      continue;
    }

    const div = DIV_OPEN.exec(line);
    if (div) {
      const rawInfo = div[1] ?? '';
      if (!rawInfo.trim()) {
        divScopes.pop();
        out.push(line);
        continue;
      }
      const info = parseInfo(rawInfo);
      if (info.lang === 'mermaid' && !inDemo() && !outerFence) {
        let j = i + 1;
        while (j < lines.length && !/^\s*:::\s*$/.test(lines[j])) j++;
        if (j < lines.length) {
          push(lines.slice(i + 1, j).join('\n'), info.attrs);
          i = j;
          continue;
        }
      }
      divScopes.push(/(^|[\s.])demo(\s|$)/.test(rawInfo));
      out.push(line);
      continue;
    }

    out.push(line);
  }
  return { markdown: out.join('\n'), blocks };
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export interface RenderedDiagram {
  key: string;
  svg: string;
  css: string;
  cssDark: string;
  typeCss: string;
  typeCssDark: string;
}

export function figureHtml(key: string, caption: string, svg: string, type = ''): string {
  const cap = caption.trim();
  const tagged = type ? svg.replace('<svg ', `<svg data-mmdt="${escapeAttr(type)}" `) : svg;
  return (
    `<figure class="diagram" id="diagram-${escapeAttr(key)}">\n` +
    `<div class="diagram-frame" data-mermaid-key="${escapeAttr(key)}">${tagged}</div>\n` +
    (cap ? `<figcaption class="diagram-caption">${escapeHtml(cap)}</figcaption>\n` : '') +
    '</figure>'
  );
}

export function mergeDiagramCss(rendered: Iterable<RenderedDiagram>): {
  css: string;
  typeOf: Map<string, string>;
} {
  const groups = new Map<string, { light: string; dark: string }>();
  const typeOf = new Map<string, string>();
  const perDiagram: string[] = [];
  for (const d of rendered) {
    if (!d.svg) continue;
    const type = crypto
      .createHash('sha1')
      .update(d.typeCss)
      .update('\0')
      .update(d.typeCssDark)
      .digest('hex')
      .slice(0, 10);
    typeOf.set(d.key, type);
    if (!groups.has(type)) groups.set(type, { light: d.typeCss, dark: d.typeCssDark });
    if (d.css.trim()) perDiagram.push(d.css.trim());
    if (d.cssDark.trim()) perDiagram.push(d.cssDark.trim());
  }

  const blocks: string[] = [];
  for (const [type, g] of groups) {
    const sel = `svg[data-mmdt="${type}"]`;
    blocks.push(g.light.split('svg[data-mmd]').join(sel).trim());
    blocks.push(g.dark.split('svg[data-mmd]').join(sel).trim());
  }
  return { css: [...blocks, ...perDiagram].filter(Boolean).join('\n'), typeOf };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function diagramHash(block: MermaidBlock, version: string, fontStack = SYSTEM_FONT_STACK): string {
  const h = crypto.createHash('sha256');
  h.update(version);
  h.update('\0');
  h.update(block.source);
  h.update('\0');
  h.update(JSON.stringify(renderTheme(fontStack)));
  h.update('\0');
  h.update(fontStack);
  h.update('\0');
  h.update(STYLE_REVISION);
  return h.digest('hex').slice(0, 20);
}

interface CacheEntry {
  svg: string;
  css: string;
  cssDark: string;
  typeCss: string;
  typeCssDark: string;
}

interface RenderJob {
  hash: string;
  source: string;
}

interface MermaidRenderer {
  render(blocks: MermaidBlock[], hashFor: (block: MermaidBlock) => string): Promise<Map<string, RenderedDiagram>>;
  close(): Promise<void>;
}

export class PlaywrightMermaidRenderer implements MermaidRenderer {
  private browser: BrowserLike | null = null;
  private page: PageLike | null = null;
  private launchError: string | null = null;
  private readonly cacheDir: string;
  private fontServer: http.Server | null = null;
  private readonly themeDir: string;
  private readonly mermaidPath: string;
  private readonly executablePath: string | null;
  readonly fontStack: string;

  constructor({ cacheDir, themeDir, mermaidPath, executablePath = null }: {
    cacheDir: string;
    themeDir: string;
    mermaidPath: string;
    executablePath?: string | null;
  }) {
    this.cacheDir = cacheDir;
    this.themeDir = themeDir;
    this.mermaidPath = mermaidPath;
    this.executablePath = executablePath ?? process.env.MERMAID_CHROMIUM ?? null;
    const family = themeFontFace(themeDir)?.family ?? null;
    this.fontStack = family ? `"${family}", ${SYSTEM_FONT_STACK}` : SYSTEM_FONT_STACK;
  }

  private cacheFile(hash: string): string {
    return path.join(this.cacheDir, hash + '.json');
  }

  private readCache(hash: string): CacheEntry | null {
    try {
      const e = JSON.parse(fs.readFileSync(this.cacheFile(hash), 'utf8')) as CacheEntry;
      const ok =
        typeof e?.svg === 'string' &&
        typeof e?.css === 'string' &&
        typeof e?.cssDark === 'string' &&
        typeof e?.typeCss === 'string' &&
        typeof e?.typeCssDark === 'string';
      return ok ? e : null;
    } catch {
      return null;
    }
  }

  private writeCache(hash: string, entry: CacheEntry): void {
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const dest = this.cacheFile(hash);
    fs.writeFileSync(dest + '.tmp', JSON.stringify(entry));
    fs.renameSync(dest + '.tmp', dest);
  }

  private async launch(): Promise<void> {
    if (this.launchError) throw new BuildError(this.launchError);
    try {
      const mod = (await import('playwright-core')) as unknown as {
        chromium: { launch(opts: Record<string, unknown>): Promise<BrowserLike> };
      };
      const opts: Record<string, unknown> = { headless: true, args: ['--font-render-hinting=none'] };
      const exe = this.executablePath || findChromiumExecutable();
      if (exe) opts.executablePath = exe;
      this.browser = await mod.chromium.launch(opts);
      this.page = await this.browser.newPage();
    } catch (err) {
      this.launchError =
        `Mermaid prerendering needs Chromium, but launching it failed: ${(err as Error).message}\n` +
        '  Install: npx playwright-core install chromium\n' +
        '  Or set MERMAID_CHROMIUM=/path/to/chrome';
      throw new BuildError(this.launchError);
    }
    try {
      // Headless Chromium blocks file:// font loads, so the theme fonts ride a
      // throwaway local HTTP origin; with fallback metrics baked foreignObjects
      // are too narrow and CJK labels clip.
      const face = themeFontFace(this.themeDir);
      let boot = '<!doctype html><html><head><meta charset="utf-8"><style></style></head><body></body></html>';
      if (face) {
        const fontOrigin = await this.startFontServer();
        const faces = fs
          .readFileSync(path.join(this.fontDir(), face.dir, 'faces.css'), 'utf8')
          .replace(/url\(\s*(['"]?)\.\//g, (_m, q: string) => `url(${q}${fontOrigin}/`);
        boot = `<!doctype html><html><head><meta charset="utf-8"><style>${faces.replace(/<\/style/gi, '<\\/style')}</style></head><body></body></html>`;
        // about:blank is a null origin; ACAO:* lets the @font-face loads pass.
        await this.page.setContent(boot, { waitUntil: 'load' });
        await this.page.evaluate(async (fontFamily: string) => {
          await document.fonts.load(`16px ${fontFamily}`, 'noteflow字体宽度测量分配prefill任务');
          await document.fonts.ready;
        }, this.fontStack);
      } else {
        await this.page.setContent(boot, { waitUntil: 'load' });
      }
      await this.page.addScriptTag({ path: this.mermaidPath });
    } catch (err) {
      this.fontServer?.close();
      this.fontServer = null;
      this.launchError = `Mermaid prerender page failed to start: ${(err as Error).message}`;
      throw new BuildError(this.launchError);
    }
  }

  private fontDir(): string {
    // faces.css references ./<family>/<file>; the server root is fonts/.
    return path.resolve(this.themeDir, 'fonts');
  }

  private async startFontServer(): Promise<string> {
    const dir = this.fontDir();
    const server = http.createServer((req, res) => {
      const send = (status: number, type: string, body: string | Buffer): void => {
        // about:blank is a null origin; a CORS wildcard lets its fonts through.
        res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*' });
        res.end(body);
      };
      try {
        const name = path.normalize(decodeURIComponent((req.url || '').split('?')[0])).replace(/^([/\\])+/, '');
        const full = path.join(dir, name);
        if (!isInside(dir, full) || !fs.statSync(full, { throwIfNoEntry: false })?.isFile()) {
          send(404, 'text/plain', 'not found');
          return;
        }
        const type = full.endsWith('.css') ? 'text/css' : 'font/woff2';
        send(200, type, fs.readFileSync(full));
      } catch {
        send(400, 'text/plain', 'bad request');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    this.fontServer = server;
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    return `http://127.0.0.1:${port}`;
  }

  async render(blocks: MermaidBlock[], hashFor: (block: MermaidBlock) => string): Promise<Map<string, RenderedDiagram>> {
    const out = new Map<string, RenderedDiagram>();
    const pending: MermaidBlock[] = [];
    const pendingHashes = new Set<string>();
    for (const b of blocks) {
      const hash = hashFor(b);
      const cached = this.readCache(hash);
      if (cached) out.set(b.key, { key: b.key, ...cached });
      else if (!pendingHashes.has(hash)) {
        pendingHashes.add(hash);
        pending.push(b);
      }
    }
    if (!pending.length) return out;
    if (!this.page) await this.launch();

    const jobs: RenderJob[] = pending.map((b) => ({ hash: hashFor(b), source: b.source }));
    const results = (await this.page!.evaluate(renderInPage, {
      jobs,
      themes: renderTheme(this.fontStack),
      fontFamily: this.fontStack,
    })) as InPageResult[];

    for (let i = 0; i < jobs.length; i++) {
      const r = results[i];
      if (!r || r.error) {
        throw new BuildError(
          `Mermaid rendering failed (${pending[i].key}): ${r?.error ?? 'no output'}\n` +
            '  Source:\n' +
            pending[i].source
              .split('\n')
              .slice(0, 14)
              .map((l) => '    ' + l)
              .join('\n'),
        );
      }
      const entry: CacheEntry = {
        svg: r.svg,
        css: r.css,
        cssDark: r.cssDark,
        typeCss: r.typeCss,
        typeCssDark: r.typeCssDark,
      };
      this.writeCache(jobs[i].hash, entry);
      for (const b of blocks) {
        if (hashFor(b) === jobs[i].hash) out.set(b.key, { key: b.key, ...entry });
      }
    }
    return out;
  }

  async close(): Promise<void> {
    const page = this.page;
    this.page = null;
    if (page) await page.close().catch(() => {});
    const browser = this.browser;
    this.browser = null;
    if (browser) await browser.close().catch(() => {});
    this.fontServer?.close();
    this.fontServer = null;
  }
}

interface InPageResult {
  svg: string;
  css: string;
  cssDark: string;
  typeCss: string;
  typeCssDark: string;
  error?: string;
}

interface PageLike {
  setContent(html: string, opts?: Record<string, unknown>): Promise<void>;
  addScriptTag(opts: { path: string }): Promise<unknown>;
  evaluate(fn: unknown, arg?: unknown): Promise<unknown>;
  close(): Promise<void>;
}
interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

/** The theme's sans family and its `fonts/<dir>/faces.css` directory, if any. */
function themeFontFace(themeDir: string): { family: string; dir: string } | null {
  const fontsDir = path.join(themeDir, 'fonts');
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(fontsDir).filter((d) => fs.existsSync(path.join(fontsDir, d, 'faces.css'))).sort();
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const m = /font-family:\s*['"]([^'"]+)['"]/.exec(fs.readFileSync(path.join(fontsDir, dir, 'faces.css'), 'utf8'));
    if (m) return { family: m[1], dir };
  }
  return null;
}

export function mermaidVersion(mermaidPath: string): string {
  try {
    const pkg = path.join(path.dirname(mermaidPath), '..', 'package.json');
    return String(JSON.parse(fs.readFileSync(pkg, 'utf8')).version || '');
  } catch {
    return '';
  }
}

function findChromiumExecutable(): string | null {
  const rels = [
    'chrome-linux64/chrome',
    'chrome-linux/chrome',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'chrome-win/chrome.exe',
  ];
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(process.env.HOME || '', '.cache/ms-playwright'),
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'),
  ].filter(Boolean) as string[];
  for (const root of roots) {
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse();
    } catch {
      continue;
    }
    for (const d of dirs) {
      for (const rel of rels) {
        const p = path.join(root, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

// Serialized via toString() and run in the browser page: no module scope.

async function renderInPage({
  jobs,
  themes,
  fontFamily,
}: {
  jobs: RenderJob[];
  themes: { light: { name: string; vars: Record<string, string> }; dark: { name: string; vars: Record<string, string> } };
  fontFamily: string;
}): Promise<InPageResult[]> {
  const mermaid = (globalThis as unknown as {
    mermaid: {
      initialize(cfg: unknown): void;
      render(id: string, src: string): Promise<{ svg: string }>;
    };
  }).mermaid;

  const PAINT = ['fill', 'stroke', 'stop-color', 'flood-color', 'color'];

  const warm = document.createElement('div');
  warm.textContent = jobs.map((j) => j.source).join('\n');
  warm.setAttribute(
    'style',
    'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;font-family:' + fontFamily,
  );
  document.body.appendChild(warm);
  // unicode-range subsets load on demand; have the faces covering these
  // glyphs ready before mermaid's first getBBox.
  await document.fonts.load(`16px ${fontFamily}`, warm.textContent || '');

  const parse = (raw: string): SVGSVGElement => {
    const host = document.createElement('div');
    host.innerHTML = raw;
    const svg = host.querySelector('svg');
    if (!svg) throw new Error('mermaid produced no <svg>');
    return svg as unknown as SVGSVGElement;
  };

  const all = (root: Element): Element[] => [root, ...root.querySelectorAll('*')];

  const liftStyles = (svg: SVGSVGElement, scope: string): string => {
    let css = '';
    for (const s of [...svg.querySelectorAll('style')]) {
      css += (s.textContent || '') + '\n';
      s.remove();
    }
    const id = svg.getAttribute('id') || '';
    if (id) css = css.split('#' + id).join(scope);
    return css;
  };

  const extractStyles = (svg: SVGSVGElement, scope: string, into: string[]): void => {
    const seen = new Map<string, string>();
    let n = 0;
    for (const el of [...svg.querySelectorAll('[style]')]) {
      const raw = el.getAttribute('style') || '';
      el.removeAttribute('style');
      const decls = raw
        .split(';')
        .map((d) => d.trim())
        .filter((d) => d && d.indexOf(':') > 0 && !/^undefined$/i.test(d) && !/NaN/.test(d));
      if (!decls.length) continue;
      const key = decls.join(';');
      let cls = seen.get(key);
      if (!cls) {
        cls = 'ms' + n++;
        seen.set(key, cls);
        into.push(scope + ' .' + cls + '{' + key + '}');
      }
      el.classList.add(cls);
    }
  };

  const results: InPageResult[] = [];
  for (const job of jobs) {
    try {
      const scope = 'svg[data-mmd="' + job.hash + '"]';
      const render = async (themeName: string, vars: Record<string, string | boolean>, id: string): Promise<SVGSVGElement> => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: themeName,
          themeVariables: vars,
          flowchart: { htmlLabels: true, useMaxWidth: false },
          sequence: { useMaxWidth: false },
          gantt: { useMaxWidth: false },
        });
        return parse((await mermaid.render(id, job.source)).svg);
      };

      const lightSvg = await render(themes.light.name, themes.light.vars, 'mmd-l-' + job.hash);
      const darkSvg = await render(themes.dark.name, themes.dark.vars, 'mmd-d-' + job.hash);

      const typeScope = 'svg[data-mmd]';
      const lightType = liftStyles(lightSvg, typeScope);
      const darkType = liftStyles(darkSvg, typeScope)
        .replace(/drop-shadow\(\s*1px 2px 2px rgba\(\s*185,\s*185,\s*185,\s*1\s*\)\s*\)/g, 'drop-shadow(0 1px 2px rgba(0,0,0,0.55))')
        .split(typeScope)
        .join('[data-theme="dark"] ' + typeScope);
      // The dark theme adds decorative paint-server nodes (linearGradient and
      // stops) the default theme lacks; skip them when pairing elements.
      const isDecorative = (el: Element): boolean =>
        el.tagName === 'linearGradient' || el.tagName === 'stop' || el.tagName === 'radialGradient' || el.tagName === 'pattern';
      const lightEls = all(lightSvg).filter((el) => !isDecorative(el));
      const darkEls = all(darkSvg).filter((el) => !isDecorative(el));
      // Stock themes can diverge structurally beyond the decorative cases;
      // keep a light-only diagram rather than abort the build over cosmetics.
      const pairable =
        lightEls.length === darkEls.length && lightEls.every((el, i) => el.tagName === darkEls[i].tagName);

      const darkScope = '[data-theme="dark"] ' + scope;
      const lightRules: string[] = [];
      const darkRules: string[] = [];
      const paintClass = new Map<string, string>();
      let paintN = 0;

      for (let i = 0; pairable && i < lightEls.length; i++) {
        const le = lightEls[i];
        const de = darkEls[i];
        if (le.tagName.toLowerCase() === 'svg') continue;

        const lightPaint: string[] = [];
        const darkPaint: string[] = [];
        for (const a of [...le.attributes]) {
          if (PAINT.indexOf(a.name) < 0) continue;
          const lv = a.value;
          const dv = de.getAttribute(a.name) || a.value;
          lightPaint.push(a.name + ':' + lv);
          darkPaint.push(a.name + ':' + dv);
        }
        if (!lightPaint.length) continue;

        if (lightPaint.join(';') === darkPaint.join(';')) {
          // identical paints in both themes stay as plain attributes
          continue;
        }

        const key = lightPaint.join(';') + '|' + darkPaint.join(';');
        let cls = paintClass.get(key);
        if (!cls) {
          cls = 'mp' + paintN++;
          paintClass.set(key, cls);
          lightRules.push(scope + ' .' + cls + '{' + lightPaint.join(';') + '}');
          darkRules.push(darkScope + ' .' + cls + '{' + darkPaint.join(';') + '}');
        }
        le.classList.add(cls);
        for (const a of [...le.attributes]) if (PAINT.indexOf(a.name) >= 0) le.removeAttribute(a.name);
      }

      const styleRules: string[] = [];
      extractStyles(lightSvg, scope, styleRules);
      lightSvg.removeAttribute('style');

      const vb = lightSvg.viewBox.baseVal;
      if (vb && vb.width && vb.height) {
        lightSvg.setAttribute('width', String(Math.ceil(vb.width)));
        lightSvg.setAttribute('height', String(Math.ceil(vb.height)));
        lightSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      }
      lightSvg.setAttribute('data-mmd', job.hash);
      lightSvg.removeAttribute('id');

      results.push({
        svg: lightSvg.outerHTML,
        css: lightRules.join('\n') + '\n' + styleRules.join('\n'),
        cssDark: darkRules.join('\n'),
        typeCss: lightType,
        typeCssDark: darkType,
      });
    } catch (err) {
      results.push({
        svg: '',
        css: '',
        cssDark: '',
        typeCss: '',
        typeCssDark: '',
        error: String((err as Error).message || err),
      });
    }
  }
  warm.remove();
  return results;
}

export function sourceFigure(key: string, caption: string, source: string): string {
  const cap = caption.trim();
  return (
    `<figure class="diagram diagram-source" id="diagram-${escapeAttr(key)}">\n` +
    '<p class="diagram-error-note">Diagram not prerendered (mermaid was skipped at build time); source below:</p>\n' +
    `<pre class="diagram-error-src"><code>${escapeHtml(source)}</code></pre>\n` +
    (cap ? `<figcaption class="diagram-caption">${escapeHtml(cap)}</figcaption>\n` : '') +
    '</figure>'
  );
}

// ------------------------------------------------------ build-time stage

export interface MermaidState {
  renderer: PlaywrightMermaidRenderer | null;
  rendered: Map<string, RenderedDiagram>;
  cssText: string;
  sourceByPage: Map<string, Map<string, MermaidBlock>>;
  captionOf: (key: string) => string;
  typeOf: Map<string, string>;
}

export async function prepareMermaid(opts: {
  pages: Page[];
  themeDir: string;
  mermaidBin: string;
  noMermaid: boolean;
  root: string;
  cacheDir: string;
  strict: boolean;
}): Promise<MermaidState> {
  const { pages, themeDir, mermaidBin, noMermaid, root, cacheDir } = opts;
  const blocks: MermaidBlock[] = [];
  const sourceByPage = new Map<string, Map<string, MermaidBlock>>();
  const captionByKey = new Map<string, string>();
  for (const page of pages) {
    const { markdown, blocks: found } = extractMermaid(page.content, page.abbrlink);
    if (!found.length) continue;
    blocks.push(...found);
    for (const b of found) captionByKey.set(b.key, b.caption);
    sourceByPage.set(page.relPath, new Map(found.map((b) => [b.key, b])));
    page.content = markdown;
  }
  const captionOf = (key: string): string => captionByKey.get(key) ?? '';
  const empty = (): Map<string, RenderedDiagram> =>
    new Map(blocks.map((b) => [b.key, { key: b.key, svg: '', css: '', cssDark: '', typeCss: '', typeCssDark: '' }]));

  const renderer =
    noMermaid || !blocks.length
      ? null
      : new PlaywrightMermaidRenderer({ cacheDir: path.join(root, cacheDir, 'mermaid'), themeDir, mermaidPath: mermaidBin });

  let rendered: Map<string, RenderedDiagram> = empty();
  if (renderer) {
    if (!fs.existsSync(mermaidBin)) throw new BuildError(`mermaid not found: ${mermaidBin}\n  Run npm install before building.`);
    log.info(`✓ mermaid: prerendering ${blocks.length} diagrams`);
    const t = Date.now();
    try {
      const version = mermaidVersion(mermaidBin);
      rendered = await renderer.render(blocks, (b) => diagramHash(b, version, renderer.fontStack));
      log.info(`  mermaid rendering done in ${Date.now() - t}ms`);
    } catch (err) {
      const msg = (err as Error).message;
      // Fail closed: only the *known* browser-missing error may degrade to
      // source figures, and only without --strict-mermaid.
      const browserMissing = /needs Chromium, but launching it failed/.test(msg);
      await renderer.close();
      if (!browserMissing || opts.strict) throw err;
      rendered = empty();
      log.warn(`  mermaid prerendering unavailable; ${blocks.length} diagrams will show as source:\n  ${msg.split('\n')[0]}`);
    }
  } else if (blocks.length) {
    log.info(`  Skipped mermaid prerendering (--no-mermaid); ${blocks.length} diagrams shown as source`);
  }

  const merged = mergeDiagramCss(rendered.values());
  const hasDiagrams = [...rendered.values()].some((d) => d.svg);
  return {
    renderer,
    rendered,
    cssText: hasDiagrams ? merged.css + '\n' : '',
    sourceByPage,
    captionOf,
    typeOf: merged.typeOf,
  };
}

/** Replace the mermaid placeholders in a converted page with rendered figures. */
export function applyMermaid(body: string, page: Page, m: MermaidState): string {
  if (!m.sourceByPage.has(page.relPath)) return body;
  return body.replace(/<div class="mermaid-host"[^>]*data-mermaid-key="([^"]+)"[^>]*>\s*<\/div>/g, (whole, key: string) => {
    const diagram = m.rendered.get(key);
    if (!diagram) return whole;
    if (!diagram.svg) return sourceFigure(key, m.captionOf(key), m.sourceByPage.get(page.relPath)?.get(key)?.source ?? '');
    return figureHtml(key, m.captionOf(key), diagram.svg, m.typeOf.get(key));
  });
}
