// Local preview: dist/ with production's security headers and cache policy
// (minus upgrade-insecure-requests — this is plain http).
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { decodeURIComponentSafe, fatal, parseArgs, realInside } from '../core/util.ts';
import { basePathOf, loadConfig, repoPath } from '../core/config.ts';
import { buildCsp, hashesOf, type CspHashes } from '../core/csp.ts';
import { ATTACHMENT_TYPES } from '../render/attachments.ts';

const args = parseArgs(process.argv.slice(2));
const cfg = await loadConfig(
  args.config ? path.resolve(process.cwd(), String(args.config)) : undefined,
  typeof args.content === 'string' ? path.resolve(process.cwd(), args.content) : undefined,
).catch(fatal);
// URL space carries the base path, dist/ does not — like on the real host.
const BASE = basePathOf(cfg.url);
const ROOT = path.resolve(String(args.root || cfg.outDir));
// The preview routinely serves through a symlink (deploy's current →
// releases/<id>). `rel` and the escape check must be computed against where
// the bytes really live, or /static/ stops looking immutable.
const REAL_ROOT = fs.realpathSync(ROOT);
const PORT = Number(args.port || process.env.PORT || 7060);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`✗ invalid port: ${String(args.port)}`);
  process.exit(1);
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.pdf': 'application/pdf',
};

/** Types come from the build's own table: a new media type must not be served
 *  as octet-stream (Safari then refuses to play it). nginx mirrors the set. */
for (const [ext, mime] of Object.entries(ATTACHMENT_TYPES)) {
  TYPES['.' + ext] = mime.startsWith('text/') ? `${mime}; charset=utf-8` : mime;
}

/** Re-read on manifest mtime change, never per request (the manifest is written
 *  atomically). A missing manifest keeps the last good hashes. */
const MANIFEST_SOURCES = (): string[] => [path.join(ROOT, 'build-info.json'), repoPath(cfg.manifestFile)];
let hashCache: { key: string; hashes: CspHashes } | null = null;

function cspHashes(): CspHashes {
  const src = MANIFEST_SOURCES().find((p) => fs.existsSync(p));
  if (!src) return hashCache?.hashes ?? { script: [], style: [] };
  try {
    const key = `${src}:${fs.statSync(src).mtimeMs}`;
    if (hashCache?.key === key) return hashCache.hashes;
    const hashes = hashesOf(JSON.parse(fs.readFileSync(src, 'utf8')));
    if (hashes.script.length || hashes.style.length) hashCache = { key, hashes };
    return hashCache?.hashes ?? { script: [], style: [] };
  } catch {
    return hashCache?.hashes ?? { script: [], style: [] };
  }
}

function securityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': buildCsp(cspHashes(), cfg),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
}

/** Mirrors deploy/nginx/noteflow.conf. Content-addressed URLs (/static/,
 *  assets/<abbrlink>/…) are immutable; everything else revalidates. */
function cacheControl(rel: string): string {
  if (rel.startsWith('static/') || rel.startsWith('assets/')) return 'public, max-age=31536000, immutable';
  return 'no-cache';
}

/** Map a URL path to a file under ROOT, honoring a directory's index.html. */
async function resolveFile(urlPath: string): Promise<string | null> {
  const decoded = decodeURIComponentSafe(urlPath);
  if (decoded.includes('\0')) return null;
  const abs = path.normalize(path.join(ROOT, decoded));
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  // The lexical check above cannot see where a symlink lands.
  const real = await fsp.realpath(abs).catch(() => null);
  if (!real) return null;
  if (!realInside(REAL_ROOT, real)) return null;
  const st = await fsp.stat(real).catch(() => null);
  if (!st) return null;
  if (st.isDirectory()) {
    const idx = path.join(real, 'index.html');
    const ist = await fsp.stat(idx).catch(() => null);
    return ist?.isFile() ? idx : null;
  }
  return st.isFile() ? real : null;
}

/** Legacy `/posts/<abbrlink>.html` → `/posts/<abbrlink>` (mirrors nginx). */
function legacyPostRedirect(req: IncomingMessage): string | null {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (BASE && pathname !== BASE && !pathname.startsWith(BASE + '/')) return null;
  const stripped = BASE ? pathname.slice(BASE.length) || '/' : pathname;
  const m = stripped.match(/^\/posts\/([^/]+)\.html$/);
  if (!m) return null;
  const seg = decodeURIComponentSafe(m[1]);
  if (!/^[\w.-]+$/.test(seg) || seg.includes('..')) return null;
  const qs = (req.url || '').includes('?') ? '?' + (req.url || '').split('?').slice(1).join('?') : '';
  return `${BASE}/posts/${encodeURIComponent(seg)}${qs}`;
}

function plain(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function send(res: ServerResponse, status: number, headers: Record<string, string>, body: Buffer): void {
  res.writeHead(status, headers);
  res.end(body);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const loc = legacyPostRedirect(req);
  if (loc) {
    res.writeHead(301, { Location: loc });
    res.end();
    return;
  }

  let rawPath = new URL(req.url || '/', 'http://localhost').pathname;
  if (BASE) {
    const qs = (req.url || '').includes('?') ? '?' + (req.url || '').split('?').slice(1).join('?') : '';
    if (rawPath === '/' || rawPath === '') {
      res.writeHead(301, { Location: BASE + '/' + qs });
      res.end();
      return;
    }
    if (rawPath === BASE) {
      res.writeHead(301, { Location: BASE + '/' + qs });
      res.end();
      return;
    }
    if (!rawPath.startsWith(BASE + '/')) {
      plain(res, 404, '404 (this site is served under ' + BASE + '/)');
      return;
    }
    rawPath = rawPath.slice(BASE.length) || '/';
  }
  // Like nginx's try_files; never 301 to a trailing slash (see csp.ts).
  const file = await resolveFile(rawPath);
  if (!file) {
    const notFound = path.join(ROOT, '404.html');
    if (!fs.existsSync(notFound)) {
      plain(res, 404, '404');
      return;
    }
    send(res, 404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...securityHeaders() }, await fsp.readFile(notFound));
    return;
  }

  const rel = path.relative(REAL_ROOT, file).split(path.sep).join('/');
  const { size, mtimeMs } = await fsp.stat(file);
  const cache = cacheControl(rel);
  const immutable = cache === 'public, max-age=31536000, immutable';
  // Headers come from metadata, so a video is never read to answer a HEAD or a
  // 304 — and the body is always streamed, never buffered whole.
  const etag = `"${crypto.createHash('sha256').update(`${rel}:${size}:${mtimeMs}`).digest('base64url').slice(0, 27)}"`;
  const headers: Record<string, string | number> = {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    ETag: etag,
    'Cache-Control': cache,
    'Accept-Ranges': 'bytes',
    ...securityHeaders(),
  };

  // Immutable URLs skip revalidation entirely; everything else may answer 304.
  if (!immutable && req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  // Range lets <video> seek and is what Safari requires before playing at all.
  const range = rangeOf(req.headers.range, size);
  if (range === 'invalid') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }
  const status = range ? 206 : 200;
  const body = range
    ? { 'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': String(range.end - range.start + 1) }
    : { 'Content-Length': String(size) };
  res.writeHead(status, { ...headers, ...body });
  if (req.method === 'HEAD' || size === 0) {
    res.end();
    return;
  }
  const stream = range ? fs.createReadStream(file, { start: range.start, end: range.end }) : fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy()); // client aborted a seek: stop reading
  stream.pipe(res);
}

/** `bytes=a-b` / `bytes=a-` / `bytes=-n`; null for no (usable) range. A
 *  multi-range request is answered with the whole file, which is legal. */
function rangeOf(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  const raw = String(header ?? '').trim();
  if (raw.includes(',')) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!m || (!m[1] && !m[2])) return null;
  if (size === 0) return 'invalid';
  if (!m[1]) {
    const n = Number(m[2]);
    return n === 0 ? 'invalid' : { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return start > end || start >= size ? 'invalid' : { start, end };
}

const server = createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch {
    // A client disconnect or a rebuild swapping files must not kill the server.
    try {
      if (!res.headersSent) plain(res, 500, '500');
    } catch {
      /* socket already gone */
    }
  }
});

server.on('clientError', (_err, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));

server.listen(PORT, () => {
  console.log(
    `Previewing ${path.relative(process.cwd(), ROOT) || 'dist'}/ at http://localhost:${PORT}${BASE ? BASE + '/' : '/'}  (CSP as production, minus upgrade-insecure-requests — this is http)`,
  );
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Port ${PORT} is already in use. A previous preview process may still be running:\n` +
        `  · Use it directly: http://localhost:${PORT}/\n` +
        `  · ./start.sh serve stops a stale preview of this project and retries\n` +
        `  · Or pick another port: ./start.sh serve 7061\n` +
        `  · Or kill the process: fuser -k ${PORT}/tcp`,
    );
    process.exit(1);
  }
  throw err;
});