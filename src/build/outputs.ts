// Writing the rendered site to disk, plus the content/dist hashes for the
// manifest.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BuildError, hashFileInto, realInside, toPosix, walkFiles } from '../core/util.ts';

/** Resolve under `dist`; an escape (crafted abbrlink `../../x`, or a symlink
 *  inside dist) is a hard error. */
function outPath(dist: string, rel: string): string {
  const root = path.resolve(dist);
  const abs = path.resolve(root, toPosix(rel));
  if (!realInside(root, abs)) throw new BuildError(`output path escapes the root: ${rel}`);
  return abs;
}

/** temp + rename; a concurrent reader never sees a half-written file. */
export function writeAtomic(absPath: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath + '.tmp', content);
  fs.renameSync(absPath + '.tmp', absPath);
}

/** Existing dist files by rel path. Attachments list as `null` bytes: stale
 *  ones still get collected, but a video is never read into memory. */
function readTree(dir: string): Map<string, Buffer | null> {
  const out = new Map<string, Buffer | null>();
  let files: string[];
  try {
    files = walkFiles(dir);
  } catch {
    return out;
  }
  for (const abs of files) {
    const rel = toPosix(path.relative(dir, abs));
    out.set(rel, rel.startsWith('assets/') ? null : fs.readFileSync(abs));
  }
  return out;
}

interface WriteResult {
  written: number;
  removed: number;
  total: number;
}

/** Diff-based write: emit only changed bytes, delete files that no longer
 *  belong; `keep` paths (attachments, build-info.json) survive collection. */
export function writeDiff(dist: string, files: Map<string, string | Buffer>, keep: ReadonlySet<string>): WriteResult {
  const wanted = new Map<string, Buffer>();
  for (const [rel, content] of files) wanted.set(toPosix(rel), Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
  const existing = readTree(dist);

  let written = 0;
  for (const [rel, bytes] of wanted) {
    const prev = existing.get(rel);
    if (prev && prev.equals(bytes)) continue;
    writeAtomic(outPath(dist, rel), bytes);
    written++;
  }

  let removed = 0;
  for (const rel of existing.keys()) {
    if (wanted.has(rel) || keep.has(rel)) continue;
    fs.rmSync(outPath(dist, rel));
    removed++;
  }
  return { written, removed, total: wanted.size };
}

/** Copy into dist unless the destination exists (the URL embeds the content
 *  hash). Streamed by the OS, so a video never sits in memory and a killed
 *  build leaves no truncated file under an immutable URL. */
export function writeMissing(
  dist: string,
  rel: string,
  srcAbs: string,
  /** Size/mtime captured when the URL's hash was computed. An edit in between
   *  would put bytes under a URL claiming a different hash, cached forever. */
  expect?: { size: number; mtimeMs: number },
): boolean {
  const abs = outPath(dist, rel);
  if (fs.existsSync(abs)) return false;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = abs + '.tmp';
  try {
    fs.copyFileSync(srcAbs, tmp);
    const after = fs.statSync(srcAbs);
    if (expect && (after.size !== expect.size || after.mtimeMs !== expect.mtimeMs)) {
      throw new BuildError(`attachment changed while the build was running: ${rel} (rebuild)`);
    }
    fs.renameSync(tmp, abs);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return true;
}

/** rel path + bytes into an open hash; the zero byte keeps "ab"/"c" and "a"/"bc" distinct. */
function hashEntry(h: crypto.Hash, rel: string, abs: string): void {
  h.update(rel);
  h.update('\0');
  hashFileInto(h, abs);
  h.update('\0');
}

/** sha256 over every content file's rel path + bytes; skips dot-directories. */
export function hashContent(root: string): string {
  const h = crypto.createHash('sha256');
  for (const abs of walkFiles(root)) {
    const rel = toPosix(path.relative(root, abs));
    if (rel.split('/').some((seg) => seg.startsWith('.'))) continue;
    hashEntry(h, rel, abs);
  }
  return h.digest('hex');
}

/** sha256 over dist rel paths + bytes, excluding build-info.json (written
 *  after the hash; deploy.sh excludes it the same way). */
export function hashDist(dir: string): string {
  const h = crypto.createHash('sha256');
  for (const abs of walkFiles(dir)) {
    const rel = toPosix(path.relative(dir, abs));
    if (rel === 'build-info.json') continue;
    hashEntry(h, rel, abs);
  }
  return h.digest('hex');
}

/** sha256-<base64> over the URL-encoded value, as CSP defines style attributes. */
export function styleHash(style: string): string {
  const encoded = style
    .replace(/%/g, '%25')
    .replace(/&/g, '%26')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/[<>]/g, (c) => (c === '<' ? '%3C' : '%3E'));
  return 'sha256-' + crypto.createHash('sha256').update(encoded, 'utf8').digest('base64');
}