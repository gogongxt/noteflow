// Build-time link cards: [x](https://…){.link-preview} alone on a line becomes a
// card. Metadata is fetched here (CSP forbids runtime fetching) and cached;
// external strings enter output as escaped text only. Failures stay plain links.
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import { parseFragment, serialize } from 'parse5';
import { BITMAP_DATA_MIMES, boolArg, log, type CliArgs } from '../core/util.ts';
import { walk, textOf, element, text, append, classesOf, getAttr, setAttr, type P5Any } from '../core/dom.ts';
import type { Page } from '../core/types.ts';
import { isOffsiteHref, markExternal } from './links.ts';

export interface LinkCardMeta {
  url: string;
  title: string;
  desc: string;
  host: string;
  icon?: { mime: string; b64: string };
}

interface CacheOk extends Omit<LinkCardMeta, 'url'> {
  ok: true;
  at: number;
}
interface CacheErr {
  ok: false;
  at: number;
  error: string;
  retry: 'net' | 'http';
  fast?: boolean;
  noCache?: boolean;
}
type CacheEntry = CacheOk | CacheErr;

const PAGE_TIMEOUT_MS = 8_000;
const ICON_TIMEOUT_MS = 5_000;
const BATCH_BUDGET_MS = 20_000;
const FETCH_CONCURRENCY = 4;
const TTL_NET_MS = 30 * 60_000;
const TTL_HTTP_MS = 24 * 3_600_000;
const HTML_CAP = 2 * 1024 * 1024; // early-flush pages put </head> at ~750KB
const ICON_CAP = 32 * 1024;
const REDIRECT_LIMIT = 4;
const UA = 'Mozilla/5.0 (compatible; noteflow-linkcard/0.1; +build-time metadata fetch)';

export interface LoadOptions {
  cacheDir: string;
  /** false for --no-link-fetch: cache only, never touch the network. */
  network: boolean;
  /** --refresh-links: refetch and overwrite cached entries (needs network). */
  refresh?: boolean;
}

export interface LoadResult {
  /** url → meta. Absent = degrade to the plain link (reason in notes). */
  cards: Map<string, LinkCardMeta>;
  notes: string[];
}

/** hrefs of external `a.link-preview` links in the final page html. Pages
 *  without a candidate class are skipped before paying for a parse. */
const LINK_PREVIEW_HINT = /class="[^"]*\blink-preview\b/;
export function collectLinkPreviewHrefs(html: string): string[] {
  if (!LINK_PREVIEW_HINT.test(html)) return [];
  const root = parseFragment(html) as unknown as P5Any;
  const out = new Set<string>();
  walk(root, (n) => {
    if (n.nodeName !== 'a') return undefined;
    if (!classesOf(n).includes('link-preview')) return undefined;
    const href = n.attrs?.find((a) => a.name === 'href')?.value ?? '';
    if (/^https?:\/\//i.test(href)) out.add(href);
    return undefined;
  });
  return [...out];
}

export async function loadCards(hrefs: string[], opts: LoadOptions): Promise<LoadResult> {
  const unique = [...new Set(hrefs)];
  const cacheFile = path.join(opts.cacheDir, 'cache.json');
  const cache = readCache(cacheFile);
  const cards = new Map<string, LinkCardMeta>();
  const notes: string[] = [];
  const queue: string[] = [];
  const refresh = opts.refresh === true && opts.network !== false;

  for (const href of unique) {
    let u: URL;
    try {
      u = new URL(href);
    } catch {
      notes.push(`invalid URL, plain link kept: ${href.slice(0, 80)}`);
      continue;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      notes.push(`not http(s), plain link kept: ${href.slice(0, 80)}`);
      continue;
    }
    const e = cache.get(href);
    if (e?.ok && !refresh) {
      cards.set(href, { url: href, ...e });
    } else if (e && !e.ok && !refresh && Date.now() - e.at < (e.retry === 'net' ? TTL_NET_MS : TTL_HTTP_MS)) {
      notes.push(`recently failed (${e.error}), retry later: ${u.host}`);
    } else if (!opts.network) {
      notes.push(`no cached metadata (fetch disabled), plain link kept: ${u.host}`);
    } else {
      queue.push(href);
    }
  }

  let dirty = false;
  if (queue.length) {
    const deadline = Date.now() + BATCH_BUDGET_MS;
    const dnsMemo = new Map<string, Promise<string[]>>();
    let transportFails = 0; // 3 in a row → network is down, skip the rest fast
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < queue.length) {
        const href = queue[cursor++];
        if (Date.now() >= deadline - 500) {
          notes.push(`skipped (time budget), retried next build: ${href.slice(0, 80)}`);
          continue;
        }
        if (transportFails >= 3) {
          notes.push(`skipped (network unreachable), retried next build: ${href.slice(0, 80)}`);
          continue;
        }
        const entry = await fetchEntry(href, deadline, dnsMemo);
        if (entry.ok) {
          transportFails = 0;
          cards.set(href, { url: href, ...entry });
          cache.set(href, entry);
          dirty = true;
          continue;
        }
        if (entry.retry === 'net' && entry.fast) transportFails += 1;
        else transportFails = 0;
        if (entry.noCache) {
          notes.push(`${entry.error}: ${href.slice(0, 80)}`);
          continue;
        }
        const prev = cache.get(href);
        if (prev?.ok) {
          // Keep the last good entry: a failed refresh must not destroy it.
          cards.set(href, { url: href, ...prev });
          notes.push(`refetch failed (${entry.error}), keeping cached card: ${href.slice(0, 80)}`);
        } else {
          notes.push(`${entry.error}: ${href.slice(0, 80)}`);
          cache.set(href, entry);
          dirty = true;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, worker));
  }

  if (dirty) {
    const live = new Set(unique);
    for (const k of cache.keys()) if (!live.has(k)) cache.delete(k);
    writeCache(cacheFile, cache);
  }
  return { cards, notes };
}

// ---------------------------------------------------------------- fetching

class FetchFail extends Error {
  kind: 'net' | 'http';
  /** Network problem (not the site): counts toward the fast-fail counter.
   *  Timeouts are deliberately false — a slow site must not fast-fail. */
  fast: boolean;
  /** Never negative-cache this failure (e.g. lost the batch-budget race). */
  noCache: boolean;
  constructor(kind: 'net' | 'http', msg: string, fast = false, noCache = false) {
    super(msg);
    this.kind = kind;
    this.fast = fast;
    this.noCache = noCache;
  }
}

interface Hop {
  res: Response;
  finalUrl: URL;
  ctrl: AbortController;
  clear(): void;
}

async function fetchEntry(href: string, deadline: number, dnsMemo: Map<string, Promise<string[]>>): Promise<CacheEntry> {
  try {
    const hop = await fetchTo(new URL(href), PAGE_TIMEOUT_MS, deadline, dnsMemo);
    try {
      if (hop.res.status !== 200) throw new FetchFail('http', `HTTP ${hop.res.status}`);
      const ct = (hop.res.headers.get('content-type') ?? '').split(';')[0];
      if (ct && !/text\/html|application\/xhtml/i.test(ct)) throw new FetchFail('http', `not html (${ct})`);
      const { buf, headEnd } = await readCapped(hop, HTML_CAP, '</head>');
      const head = extractHead(decodeBody(buf.subarray(0, headEnd), hop.res.headers.get('content-type') ?? ''));
      const title = cleanText(head.ogTitle || head.title, 200) || hop.finalUrl.hostname;
      const desc = cleanText(head.ogDesc || head.desc, 300);
      const icon = await fetchIcon(head.icons, hop.finalUrl, deadline, dnsMemo);
      return { ok: true, at: Date.now(), title, desc, host: displayHost(hop.finalUrl), icon };
    } finally {
      hop.clear();
    }
  } catch (err) {
    if (err instanceof FetchFail) {
      return { ok: false, at: Date.now(), error: err.message, retry: err.kind, fast: err.fast, noCache: err.noCache };
    }
    // Unknown failures get the short TTL: a builder bug must not pin a link
    // as broken for a day.
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, at: Date.now(), error: msg.split('\n')[0].slice(0, 120), retry: 'net', fast: true };
  }
}

/** GET with manual redirects: every hop is re-validated against private nets. */
async function fetchTo(start: URL, timeoutMs: number, deadline: number, dnsMemo: Map<string, Promise<string[]>>): Promise<Hop> {
  let url = start;
  for (let i = 0; i <= REDIRECT_LIMIT; i++) {
    await assertPublicHost(url, dnsMemo);
    const ctrl = new AbortController();
    const ms = Math.min(timeoutMs, deadline - Date.now());
    if (ms <= 0) throw new FetchFail('net', 'time budget exhausted', false, true);
    const timer = setTimeout(() => ctrl.abort(), ms);
    // clear() cancels an unconsumed body so the socket returns to the pool.
    const clear = (): void => {
      clearTimeout(timer);
      void hop?.res.body?.cancel().catch(() => {});
    };
    let hop: Hop | undefined;
    try {
      const res = await fetch(url, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': UA },
      });
      hop = { res, finalUrl: url, ctrl, clear };
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        clearTimeout(timer);
        void res.body?.cancel().catch(() => {});
        hop = undefined;
        if (!loc) throw new FetchFail('http', 'redirect without location');
        url = new URL(loc, url);
        continue;
      }
      return hop;
    } catch (err) {
      clear();
      if (err instanceof FetchFail) throw err;
      throw new FetchFail('net', `fetch failed: ${summarize(err)}`, true);
    }
  }
  throw new FetchFail('http', 'too many redirects');
}

interface ReadResult {
  buf: Buffer;
  /** Bytes through the marker (or the whole buffer when absent). */
  headEnd: number;
}

/** Read at most `cap` bytes, stopping once `marker` appears. */
async function readCapped(hop: Hop, cap: number, marker?: string): Promise<ReadResult> {
  if (!hop.res.body) return { buf: Buffer.alloc(0), headEnd: 0 };
  const chunks: Buffer[] = [];
  let total = 0;
  let tail = Buffer.alloc(0); // the marker may straddle chunk boundaries
  const markerBuf = marker ? Buffer.from(marker) : null;
  try {
    for await (const c of hop.res.body as AsyncIterable<Uint8Array>) {
      const chunk = Buffer.from(c);
      chunks.push(chunk);
      total += chunk.byteLength;
      if (total > cap) throw new FetchFail('http', 'response too large');
      if (markerBuf) {
        if (chunk.includes(markerBuf)) break;
        if (Buffer.concat([tail, chunk.subarray(0, markerBuf.length - 1)]).includes(markerBuf)) break;
        tail = chunk.subarray(Math.max(0, chunk.length - (markerBuf.length - 1)));
      }
    }
  } catch (err) {
    if (err instanceof FetchFail) throw err;
    if (hop.ctrl.signal.aborted) throw new FetchFail('net', `timeout: ${summarize(err)}`);
    throw new FetchFail('net', `body read failed: ${summarize(err)}`, true);
  }
  const buf = Buffer.concat(chunks);
  if (!marker) return { buf, headEnd: buf.length };
  // Case-insensitive final scan: the per-chunk fast path is case-sensitive.
  const idx = buf.toString('latin1').toLowerCase().indexOf(marker);
  return { buf, headEnd: idx < 0 ? buf.length : idx + marker.length };
}

function summarize(err: unknown): string {
  const e = err as { message?: string; cause?: unknown };
  if (e?.cause) return String(e.cause);
  return e?.message || String(err);
}

/** Legacy CN sites still serve GBK/gb2312; UTF-8-only would bake mojibake. */
function decodeBody(buf: Buffer, contentType: string): string {
  const cs = /charset=([\w-]+)/i.exec(contentType)?.[1];
  if (cs && !/utf-?8/i.test(cs)) {
    try {
      return new TextDecoder(cs.toLowerCase()).decode(buf);
    } catch {
      // unsupported label → utf-8 is the best guess left
    }
  }
  return buf.toString('utf8');
}

/** Race the icon candidates; among the winners pick the best-ranked. */
async function fetchIcon(candidates: string[], base: URL, deadline: number, dnsMemo: Map<string, Promise<string[]>>): Promise<LinkCardMeta['icon']> {
  const list = [...candidates.slice(0, 2), new URL('/favicon.ico', base).href];
  const results = await Promise.all(
    list.map(async (href, rank) => {
      try {
        const hop = await fetchTo(new URL(href, base), ICON_TIMEOUT_MS, deadline, dnsMemo);
        try {
          if (hop.res.status !== 200) return null;
          const { buf } = await readCapped(hop, ICON_CAP);
          const mime = sniffImage(buf);
          return mime ? { rank, mime, b64: buf.toString('base64') } : null;
        } finally {
          hop.clear();
        }
      } catch {
        return null;
      }
    }),
  );
  const best = results.filter((r): r is { rank: number; mime: string; b64: string } => r != null).sort((a, b) => a.rank - b.rank)[0];
  return best ? { mime: best.mime, b64: best.b64 } : undefined;
}

/** Byte sniffing is the only authority on what may ship: declared types lie. */
function sniffImage(b: Buffer): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 6 && b.subarray(0, 3).toString() === 'GIF') return 'image/gif';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'image/x-icon';
  return null; // SVG is rejected: the audit's data-URI whitelist is bitmaps + x-icon
}

// ------------------------------------------------------------- SSRF guard

/** Rejects non-http(s) schemes and any host resolving into a private network,
 *  per redirect hop and icon fetch. Defense-in-depth against accidental
 *  internal URLs (a rebinding server can still race check-then-fetch). */
export async function assertPublicHost(u: URL, memo?: Map<string, Promise<string[]>>): Promise<void> {
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new FetchFail('http', `blocked scheme ${u.protocol}`);
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!h) throw new FetchFail('http', 'empty host');
  if (h.includes(':')) {
    if (blockedV6(h)) throw new FetchFail('http', `blocked host ${h}`);
    return;
  }
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (v4) {
    if (blockedV4(Number(v4[1]), Number(v4[2]))) throw new FetchFail('http', `blocked host ${h}`);
    return;
  }
  let addrs: string[];
  if (memo?.has(h)) {
    addrs = await memo.get(h)!;
  } else {
    // getaddrinfo has no timeout of its own; a blackholed resolver must not
    // outlive the batch budget.
    let rej: ((e: Error) => void) | undefined;
    const t = setTimeout(() => rej?.(new FetchFail('net', 'dns timeout', true)), 5_000);
    t.unref();
    const p = new Promise<string[]>((resolve, reject) => {
      rej = reject;
      dns.lookup(h, { all: true }).then(
        (r) => resolve(r.map((x) => x.address)),
        (err) => reject(new FetchFail('net', `dns failed: ${summarize(err)}`, true)),
      );
    });
    memo?.set(h, p);
    addrs = await p.finally(() => clearTimeout(t));
  }
  for (const addr of addrs) {
    const a = addr.toLowerCase();
    if (a.includes(':')) {
      if (blockedV6(a)) throw new FetchFail('http', `blocked host ${h} → ${a}`);
      continue;
    }
    const m = a.match(/^(\d{1,3})\.(\d{1,3})\./);
    if (m && blockedV4(Number(m[1]), Number(m[2]))) throw new FetchFail('http', `blocked host ${h} → ${a}`);
  }
}

function blockedV4(a: number, b: number): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true; // this-net, private, loopback, multicast/reserved
  if (a === 172 && b >= 16 && b < 32) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 100 && b >= 64 && b < 128) return true; // CGNAT (cloud metadata)
  return false;
}

/** Blocks by group range; v4-mapped/6to4/NAT64 embeddings recurse into v4. */
function blockedV6(s: string): boolean {
  let canon: string;
  try {
    canon = new URL(`http://[${s}]/`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return true;
  }
  const g = expandV6(canon);
  if (!g) return true;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if (g[0] === 0x2002) return blockedV4(g[1] >>> 8, g[1] & 0xff); // 6to4
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return blockedV4(g[6] >>> 8, g[6] & 0xff); // ::ffff:v4
  if (g[0] === 0x64 && g[1] === 0xff9b) return blockedV4(g[6] >>> 8, g[6] & 0xff); // NAT64
  return false;
}

/** Expands a canonical form: lowercase hex, at most one '::'. */
function expandV6(canon: string): number[] | null {
  const halves = canon.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => (part === '' ? [] : part.split(':').map(hex16));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  if (!head || !tail) return null;
  if (head.some((x) => Number.isNaN(x)) || tail.some((x) => Number.isNaN(x))) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  if (head.length + tail.length > 7) return null;
  return [...head, ...new Array(8 - head.length - tail.length).fill(0), ...tail];
}

function hex16(s: string): number {
  return /^[0-9a-f]{1,4}$/.test(s) ? parseInt(s, 16) : NaN;
}

// ------------------------------------------------------- head metadata

interface HeadInfo {
  ogTitle: string;
  ogDesc: string;
  desc: string;
  title: string;
  /** hrefs of <link rel=…icon…>, best first (ranking only; sniffing decides). */
  icons: string[];
}

export function extractHead(html: string): HeadInfo {
  const root = parseFragment(html) as unknown as P5Any;
  const info: HeadInfo = { ogTitle: '', ogDesc: '', desc: '', title: '', icons: [] };
  const iconCands: { href: string; score: number }[] = [];
  walk(root, (n) => {
    if (n.nodeName === 'title' && !info.title) info.title = textOf(n);
    if (n.nodeName === 'meta') {
      const prop = (getAttr(n, 'property') || getAttr(n, 'name') || '').toLowerCase();
      const content = getAttr(n, 'content') ?? '';
      if (prop === 'og:title' && !info.ogTitle) info.ogTitle = content;
      else if (prop === 'og:description' && !info.ogDesc) info.ogDesc = content;
      else if (prop === 'description' && !info.desc) info.desc = content;
    }
    if (n.nodeName === 'link') {
      const rel = (getAttr(n, 'rel') || '').toLowerCase().split(/\s+/);
      if (rel.some((r) => r === 'icon' || r === 'apple-touch-icon' || r === 'apple-touch-icon-precomposed')) {
        const href = getAttr(n, 'href');
        if (href) iconCands.push({ href, score: iconScore(rel, getAttr(n, 'sizes') || '') });
      }
    }
    return undefined;
  });
  info.icons = iconCands.sort((a, b) => b.score - a.score).map((c) => c.href);
  return info;
}

/** Pure ranking: icons rendered at ~24px beat 180px touch icons. */
function iconScore(rel: string[], sizes: string): number {
  const m = sizes.match(/(\d+)\s*[x×]\s*(\d+)/i);
  if (m) {
    const area = Number(m[1]) * Number(m[2]);
    return area >= 16 * 16 && area <= 64 * 64 ? 3 : 1;
  }
  return /any/i.test(sizes) ? 2 : rel.includes('icon') ? 1 : 0;
}

function cleanText(s: string, cap: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  const cps = Array.from(t); // never split a surrogate pair when truncating
  if (cps.length <= cap) return t;
  return cps.slice(0, cap - 1).join('').trimEnd() + '…';
}

function displayHost(u: URL): string {
  return u.hostname.replace(/^www\./, '');
}

// ---------------------------------------------------------------- cache

function readCache(file: string): Map<string, CacheEntry> {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries?: Record<string, CacheEntry> };
    const out = new Map<string, CacheEntry>();
    for (const [k, v] of Object.entries(data.entries ?? {})) {
      if (isSaneEntry(v)) out.set(k, v);
    }
    return out;
  } catch {
    return new Map();
  }
}

const ICON_MIME_OK = new RegExp(`^(?:${[...BITMAP_DATA_MIMES, 'image/x-icon'].join('|')})$`, 'i');

/** Re-establish the fresh-fetch invariants (mime set, size caps) before
 *  trusting a locally edited cache file. */
function isSaneEntry(v: unknown): v is CacheEntry {
  if (!v || typeof v !== 'object' || typeof (v as CacheEntry).ok !== 'boolean') return false;
  const e = v as CacheEntry;
  if (!e.ok) return typeof e.error === 'string';
  if (typeof e.title !== 'string' || e.title.length > 200) return false;
  if (typeof e.desc !== 'string' || e.desc.length > 300) return false;
  if (typeof e.host !== 'string' || !e.host) return false;
  if (e.icon != null) {
    if (!e.icon || typeof e.icon.mime !== 'string' || typeof e.icon.b64 !== 'string') return false;
    if (!ICON_MIME_OK.test(e.icon.mime)) return false;
    if (e.icon.b64.length > 48_000 || !/^[a-z0-9+/=\s]+$/i.test(e.icon.b64)) return false;
  }
  return true;
}

function writeCache(file: string, cache: Map<string, CacheEntry>): void {
  const entries: Record<string, CacheEntry> = {};
  for (const [k, v] of cache) entries[k] = v;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// ------------------------------------------------------- card expansion

export interface ExpandResult {
  html: string;
  expanded: number;
}

/** Promote sole-line `a.link-preview` links to card markup in place. Returns the
 *  input untouched when nothing expanded: the parse5 round-trip is not
 *  byte-preserving and must not churn output. */
export function expandLinkCards(html: string, cards: ReadonlyMap<string, LinkCardMeta>, siteHost = ''): ExpandResult {
  const root = parseFragment(html) as unknown as P5Any;
  let expanded = 0;
  walk(root, (n) => {
    if (n.nodeName !== 'a' || !classesOf(n).includes('link-preview')) return undefined;
    const href = getAttr(n, 'href') ?? '';
    const meta = href ? cards.get(href) : undefined;
    if (!meta) return undefined;
    if (insideHeading(n)) return undefined;
    const parent = n.parentNode;
    if (parent?.childNodes) {
      // Own-line rule: promote only when EVERY meaningful child of the
      // paragraph is (or became) a card link — the bookmark-list shape.
      const isCardLink = (c: P5Any): boolean =>
        c.nodeName === 'a' &&
        (classesOf(c).includes('link-card') || (classesOf(c).includes('link-preview') && cards.has(getAttr(c, 'href') ?? '')));
      const meaningful = parent.childNodes.filter((c) => !(c.nodeName === '#text' && !(c.value ?? '').trim()));
      if (meaningful.length === 0 || !meaningful.every(isCardLink)) return undefined;
    }
    const fallback = textOf(n);
    setAttr(n, 'class', [...classesOf(n).filter((c) => c !== 'link-preview'), 'link-card'].join(' '));
    // postprocess already did, but the card path stands alone. A card for the
    // site's own host is navigation and stays in the current tab.
    if (!siteHost || isOffsiteHref(href, siteHost)) markExternal(n);
    n.childNodes = cardChildren(meta, fallback);
    if (parent && parent.nodeName === 'p' && !classesOf(parent).includes('link-card-row')) {
      // Excludes the row from first-paragraph descriptions (site/page.ts) so
      // external og text cannot become the page's own summary.
      setAttr(parent, 'class', [...classesOf(parent), 'link-card-row'].join(' '));
    }
    expanded += 1;
    return undefined;
  });
  if (expanded === 0) return { html, expanded: 0 };
  return { html: serialize(root as never), expanded };
}

function insideHeading(n: P5Any): boolean {
  for (let p = n.parentNode; p; p = p.parentNode) {
    if (/^h[1-6]$/.test(p.nodeName)) return true;
  }
  return false;
}

/** All external strings enter as #text nodes; the serializer escapes them. */
function cardChildren(meta: LinkCardMeta, fallbackTitle: string): P5Any[] {
  const icon = element('span', 'lc-icon');
  if (meta.icon) {
    const img = element('img', 'lc-favicon');
    append(icon, img);
    img.attrs!.push(
      { name: 'src', value: `data:${meta.icon.mime};base64,${meta.icon.b64}` },
      { name: 'alt', value: '' },
      { name: 'width', value: '24' },
      { name: 'height', value: '24' },
      { name: 'loading', value: 'lazy' },
      { name: 'decoding', value: 'async' },
      { name: 'data-inline', value: '' }, // icons are not viewer content
    );
  } else {
    setAttr(icon, 'class', 'lc-icon lc-glyph');
    text(icon, meta.host.match(/[a-z0-9]/i)?.[0]?.toUpperCase() ?? '#');
  }

  const main = element('span', 'lc-main');
  const title = element('span', 'lc-title');
  append(main, title);
  text(title, meta.title || fallbackTitle || meta.host);
  const host = element('span', 'lc-host');
  append(main, host);
  text(host, meta.host);
  if (meta.desc) {
    const desc = element('span', 'lc-desc');
    append(main, desc);
    text(desc, meta.desc);
  }

  return [icon, main];
}

// ------------------------------------------------------- build-time stage

/** Collect candidates, load metadata (cache/network per args), expand cards in place.
 *  `--check` must stay read-only and offline; an explicit --link-fetch wins. */
export async function expandPageCards(
  pages: Page[],
  opts: { args: CliArgs; root: string; cacheDir: string; siteHost: string; network?: boolean },
): Promise<void> {
  const pageCards = pages.map((p) => ({ p, hrefs: collectLinkPreviewHrefs(p.html) })).filter((x) => x.hrefs.length > 0);
  if (!pageCards.length) return;
  const cacheArg = opts.args['link-cache'];
  const cacheDir = typeof cacheArg === 'string' && cacheArg ? path.resolve(opts.root, cacheArg) : path.resolve(opts.root, opts.cacheDir, 'link-previews');
  const { cards, notes } = await loadCards(pageCards.flatMap((x) => x.hrefs), {
    cacheDir,
    network: boolArg(opts.args['link-fetch'], opts.network ?? true),
    refresh: opts.args['refresh-links'] === true || opts.args['refresh-links'] === 'true',
  });
  let expanded = 0;
  for (const { p, hrefs } of pageCards) {
    if (!hrefs.some((h) => cards.has(h))) continue;
    const r = expandLinkCards(p.html, cards, opts.siteHost);
    p.html = r.html;
    expanded += r.expanded;
  }
  log.info(`✓ Link cards: ${expanded} card(s) rendered${notes.length ? `, ${notes.length} degraded to plain links` : ''}`);
  for (const n of notes.slice(0, 10)) log.warn(`  link-preview: ${n}`);
}
