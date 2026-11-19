import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class BuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildError';
  }
}

/** A CLI death: a BuildError prints as one line, anything else is a bug and
 *  keeps its stack. */
export function fatal(err: unknown): never {
  if (err instanceof BuildError) console.error(`✗ ${err.message}`);
  else console.error(err);
  process.exit(1);
}

/** Run a CLI body through `fatal`. */
export function runCli(main: () => Promise<void>): void {
  main().catch(fatal);
}

interface Log {
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
}

/** Never print private titles or paths. */
export const log: Log = {
  info: (...a) => console.log(...a),
  warn: (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
};

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export function nfc(s: string | null | undefined): string {
  return String(s ?? '').normalize('NFC');
}

/** Escape text and quoted attribute values for HTML. */
export function esc(str: unknown): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Decode the HTML entities pandoc emits so text can be compared to frontmatter. */
export function decodeEntities(s: string): string {
  return String(s)
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    // Last: decoding `&amp;` first would turn `&amp;lt;` into `<` in one pass.
    .replace(/&amp;/g, '&');
}

export function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Encode each path segment; a literal % stays %25 (never un-escaped back). */
export function encodePath(p: string): string {
  return p
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

export function isInside(root: string, p: string): boolean {
  const r = path.resolve(root);
  const x = path.resolve(p);
  return x === r || x.startsWith(r + path.sep);
}

/** Symlinks resolved on both sides; for paths that `isInside` must not mistake
 *  for an escape (/srv/current → /srv/releases/x). A path that does not exist
 *  yet resolves through its deepest existing ancestor. */
export function realInside(root: string, p: string): boolean {
  const real = (x: string): string => {
    const rest: string[] = [];
    let cur = path.resolve(x);
    for (;;) {
      try {
        return path.join(fs.realpathSync(cur), ...rest);
      } catch {
        const parent = path.dirname(cur);
        if (parent === cur) return path.resolve(x);
        rest.unshift(path.basename(cur));
        cur = parent;
      }
    }
  };
  const r = real(root);
  const x = real(p);
  return x === r || x.startsWith(r + path.sep);
}

/** 'YYYY-MM-DD' prefix of a date value, or null. */
export function datePart(value: unknown): string | null {
  if (value == null) return null;
  const m = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

type CliValue = string | boolean | string[];

export interface CliArgs {
  _: string[];
  [key: string]: CliValue;
}

/** Flags that consume the next argv element as their value. */
const VALUE_FLAGS = new Set(['content', 'out', 'manifest', 'port', 'root', 'dir', 'date', 'search-limit', 'link-cache', 'out-file', 'config']);

/** A value is consumed only for a registered value flag, so `--check notes`
 *  never eats `notes`; `--no-X` maps to X=false; `--flag=value` always wins. */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      args._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) {
      args[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (a.startsWith('--no-')) {
      args[a.slice(5)] = false;
    } else {
      const key = a.slice(2);
      args[key] = VALUE_FLAGS.has(key) && i + 1 < argv.length ? argv[++i] : true;
    }
  }
  return args;
}

/** A boolean option's value, treating the inline string 'false' as off. */
export function boolArg(v: CliValue | undefined, dflt: boolean): boolean {
  if (v === undefined || v === true) return dflt;
  return !(v === false || v === 'false');
}

/** Data-URI image mimes user content may carry; sanitize, the audit and the
 *  card generator all build their regexes from this list. */
export const BITMAP_DATA_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'] as const;

export function collator(): Intl.Collator {
  return new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32Hex(str: string): string {
  let crc = 0xffffffff;
  for (const b of Buffer.from(String(str), 'utf8')) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

/** First 8 hex chars of sha256 — enough to rule out collisions for a site's asset set. */
export function hash8(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 8);
}

/** Same digest as hash8, streamed: attachments can be videos far larger than
 *  a buffer we want to hold. */
export function hashFile8(absPath: string): string {
  const h = crypto.createHash('sha256');
  hashFileInto(h, absPath);
  return h.digest('hex').slice(0, 8);
}

/** Feed a file's bytes into an open hash without loading it whole. */
export function hashFileInto(h: crypto.Hash, absPath: string): void {
  const buf = Buffer.allocUnsafe(1 << 20);
  const fd = fs.openSync(absPath, 'r');
  try {
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
}

/** Insert the hash before the final extension: `fonts/a.woff2` → `fonts/a.<hash>.woff2`. */
export function hashedName(name: string, hash: string): string {
  const ext = path.posix.extname(name);
  const stem = ext ? name.slice(0, name.length - ext.length) : name;
  return `${stem}.${hash}${ext}`;
}

export function staticUrl(rel: string, base = ''): string {
  return (base ? base.replace(/\/+$/, '') : '') + '/static/' + rel.split(path.sep).join('/');
}

/** Every regular file under `dir`, as absolute paths, sorted by posix rel path. */
export function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(dir);
  // Code-unit sort, not localeCompare: hash order must not depend on ICU.
  return out.sort((a, b) => {
    const ra = toPosix(path.relative(dir, a));
    const rb = toPosix(path.relative(dir, b));
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });
}