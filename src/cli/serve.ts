// Local preview: dist/ with production's security headers and cache policy
// (minus upgrade-insecure-requests — this is plain http). With --sync and a
// configured sync block it is the serving daemon: poll the notes remote,
// hard-reset the content dir onto it, rebuild into the served root, pin new
// notes' abbrlinks back into the repository.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { decodeURIComponentSafe, fatal, parseArgs, realInside, realPath } from '../core/util.ts';
import { basePathOf, loadConfig, repoPath, CONFIG_FILES, LOCAL_CONFIG_FILE, ROOT as REPO_ROOT, type AppConfig, type SyncConfig } from '../core/config.ts';
import { buildCsp, hashesOf, type CspHashes } from '../core/csp.ts';
import { ATTACHMENT_TYPES } from '../render/attachments.ts';
import { GitSync } from '../sync/git.ts';
import { pushAbbrlinkPins } from '../sync/pins.ts';
import { BuildRunner, runBuildChild } from '../build/runner.ts';

const args = parseArgs(process.argv.slice(2));
const CONFIG_ARG = args.config ? path.resolve(process.cwd(), String(args.config)) : undefined;
const CONTENT_ARG = typeof args.content === 'string' ? path.resolve(process.cwd(), args.content) : undefined;
const cfg = await loadConfig(CONFIG_ARG, CONTENT_ARG).catch(fatal);
const ROOT = path.resolve(String(args.root || cfg.outDir));
// The preview routinely serves through a symlink (deploy's current →
// releases/<id>). `rel` and the escape check must be computed against where
// the bytes really live, or /static/ stops looking immutable. realPath, not
// realpathSync: in sync mode the dir may not exist until the first build.
const REAL_ROOT = realPath(ROOT);
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

/** The daemon outlives config edits, and a sync clone can introduce a
 *  notes-root site.config.local.mjs that was not there at boot — so the
 *  serving-facing config is re-read when any file of the stack changes
 *  (mtime probe, like cspHashes). Paths (outDir, the sync dir) stay boot-frozen. */
let cfgFresh: AppConfig = cfg;
let cfgKey = '';
async function refreshCfg(): Promise<void> {
  const contentDir = cfgFresh.contentDir;
  const files = CONFIG_ARG
    ? [CONFIG_ARG]
    : [repoPath(CONFIG_FILES[0]), repoPath(LOCAL_CONFIG_FILE), path.resolve(REPO_ROOT, contentDir, LOCAL_CONFIG_FILE)];
  const key = files.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join(':');
  if (key === cfgKey) return;
  try {
    cfgFresh = await loadConfig(CONFIG_ARG, CONTENT_ARG);
    cfgKey = key;
  } catch {
    /* a config edit that no longer parses keeps the last good config */
  }
}

/** Re-read on manifest mtime change, never per request (the manifest is written
 *  atomically). A missing manifest keeps the last good hashes. */
const MANIFEST_SOURCES = (): string[] => [path.join(ROOT, 'build-info.json'), repoPath(cfgFresh.manifestFile)];
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
    'Content-Security-Policy': buildCsp(cspHashes(), cfgFresh),
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
function legacyPostRedirect(req: IncomingMessage, base: string): string | null {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (base && pathname !== base && !pathname.startsWith(base + '/')) return null;
  const stripped = base ? pathname.slice(base.length) || '/' : pathname;
  const m = stripped.match(/^\/posts\/([^/]+)\.html$/);
  if (!m) return null;
  const seg = decodeURIComponentSafe(m[1]);
  if (!/^[\w.-]+$/.test(seg) || seg.includes('..')) return null;
  const qs = (req.url || '').includes('?') ? '?' + (req.url || '').split('?').slice(1).join('?') : '';
  return `${base}/posts/${encodeURIComponent(seg)}${qs}`;
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
  await refreshCfg();
  // URL space carries the base path, dist/ does not — like on the real host.
  const base = basePathOf(cfgFresh.url);
  const loc = legacyPostRedirect(req, base);
  if (loc) {
    res.writeHead(301, { Location: loc });
    res.end();
    return;
  }

  let rawPath = new URL(req.url || '/', 'http://localhost').pathname;
  if (base) {
    const qs = (req.url || '').includes('?') ? '?' + (req.url || '').split('?').slice(1).join('?') : '';
    if (rawPath === '/' || rawPath === '') {
      res.writeHead(301, { Location: base + '/' + qs });
      res.end();
      return;
    }
    if (rawPath === base) {
      res.writeHead(301, { Location: base + '/' + qs });
      res.end();
      return;
    }
    if (!rawPath.startsWith(base + '/')) {
      plain(res, 404, '404 (this site is served under ' + base + '/)');
      return;
    }
    rawPath = rawPath.slice(base.length) || '/';
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

// ---- sync daemon (config.sync + --sync) -------------------------------------
// The config block travels with the notes repository, so it alone must not
// turn every machine's preview into a resetting mirror: the daemon arms only
// with an explicit --sync (docker's entrypoint passes it). Startup: clone if
// needed, sync once, build when anything moved or there is no dist yet — with
// a dist already present, a startup failure only degrades to serving it;
// without one there is nothing to serve, so exit non-zero. Afterwards: poll;
// a failure backs off and repeats its message only on change.
const syncCfg: SyncConfig | undefined = cfg.sync;
if (args.sync === true && !syncCfg) {
  console.error('✗ --sync: no sync block in the config (site.config.local.mjs: sync: { remote, branch })');
  process.exit(1);
}
if (args.sync === true && syncCfg) {
  const syncLog = (msg: string): void => console.log(`\x1b[2m[${new Date().toLocaleTimeString()}]\x1b[0m ${msg}`);
  // Pin and build paths stay pinned to the boot config regardless of later edits.
  const buildArgs = [...process.argv.slice(2), '--out', ROOT, '--manifest', path.resolve(REPO_ROOT, cfg.manifestFile)];
  const contentDir = path.resolve(REPO_ROOT, String(args.content || cfg.contentDir));
  const git = new GitSync({ dir: contentDir, remote: syncCfg.remote, branch: syncCfg.branch ?? 'master', proxy: syncCfg.proxy });
  const pins = { sync: git, manifestFile: path.resolve(REPO_ROOT, cfg.manifestFile), contentDir, log: syncLog };
  let pinning = false;
  let pinsPaused = false;
  const pinAfterBuild = (): void => {
    if (pinning || pinsPaused) return;
    pinning = true;
    pushAbbrlinkPins(pins)
      .then((retry) => {
        if (retry) runner.request();
      })
      .catch((err) => {
        // A hard push failure (permissions, protected branch) leaves the pins
        // unpushed; retrying every build would only churn — wait for the
        // remote content to move again.
        pinsPaused = true;
        console.error(`[sync] pin push failed; pinning paused until the next content change: ${err instanceof Error ? err.message : err}`);
      })
      .finally(() => {
        pinning = false;
      });
  };
  const runner = new BuildRunner({
    args: buildArgs,
    cwd: REPO_ROOT,
    events: {
      start: () => syncLog('Rebuilding…'),
      exit: (code, ms) => {
        if (code === 0) {
          syncLog(`Build OK (${ms}ms)`);
          pinAfterBuild();
        } else {
          console.error(`[sync] build FAILED (exit ${code}); still serving the previous dist — the next push retries`);
        }
      },
    },
  });
  const hasDist = (): boolean => fs.existsSync(path.join(ROOT, 'build-info.json'));

  const startup = async (): Promise<void> => {
    const cloned = await git.ensureCloned();
    const res = await git.sync();
    if (!cloned && !res.changed && hasDist()) {
      syncLog(`sync: up to date, ${syncCfg.branch}@${res.sha.slice(0, 8)}`);
      return;
    }
    syncLog(cloned ? 'sync: cloned; building…' : `sync: ${syncCfg.branch} → ${res.sha.slice(0, 8)}; building…`);
    if ((await runBuildChild({ args: buildArgs, cwd: REPO_ROOT })) !== 0) {
      throw new Error('the initial build failed (see its output above)');
    }
    if (await pushAbbrlinkPins(pins)) runner.request();
  };

  const tick = async (): Promise<void> => {
    if (!runner.busy && !pinning) {
      try {
        // ensureCloned is an existsSync no-op once cloned; it lets the poll
        // recover from a first clone that failed while an old dist served.
        await git.ensureCloned();
        const res = await git.sync();
        fails = 0;
        lastError = '';
        if (res.changed) {
          pinsPaused = false;
          syncLog(`sync: ${syncCfg.branch} → ${res.sha.slice(0, 8)}, rebuilding`);
          runner.request();
        }
      } catch (err) {
        fails++;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== lastError) {
          lastError = msg;
          console.error(`[sync] ${msg}`);
        }
      }
    }
    setTimeout(tick, (fails ? intervalMs * Math.min(fails, 5) : intervalMs)).unref();
  };

  const intervalMs = (syncCfg.intervalSec ?? 15) * 1000;
  let fails = 0;
  let lastError = '';

  try {
    await startup();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!hasDist()) {
      console.error(`✗ sync startup failed and there is no dist to serve: ${msg}`);
      process.exit(1);
    }
    console.error(`[sync] startup failed, serving the existing dist: ${msg}`);
  }
  setTimeout(tick, intervalMs).unref();
}

server.listen(PORT, () => {
  const base = basePathOf(cfgFresh.url);
  console.log(
    `Previewing ${path.relative(process.cwd(), ROOT) || 'dist'}/ at http://localhost:${PORT}${base ? base + '/' : '/'}  (CSP as production, minus upgrade-insecure-requests — this is http)`,
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