// Per-page cache for the expensive half of the build: pandoc conversion plus
// the body HTML pass. The entry is keyed on everything those two steps read, so
// a stale entry is impossible rather than merely unlikely.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { toPosix, walkFiles } from '../core/util.ts';
import { resolveAsset, type PinnedAsset } from '../render/attachments.ts';
import type { Page, TocItem } from '../core/types.ts';
import type { BrokenLink } from '../render/postprocess-types.ts';

export interface CachedRender {
  html: string;
  toc: TocItem[];
  inlineStyles: string[];
  assets: PinnedAsset[];
  broken: BrokenLink[];
  warnings: string[];
  privateWarns: string[];
}

const VERSION = 'r1';

function isRender(r: CachedRender | undefined): r is CachedRender {
  return (
    !!r &&
    typeof r.html === 'string' &&
    Array.isArray(r.toc) &&
    Array.isArray(r.inlineStyles) &&
    Array.isArray(r.assets) &&
    Array.isArray(r.broken) &&
    Array.isArray(r.warnings) &&
    Array.isArray(r.privateWarns)
  );
}

/** What every page's conversion depends on, hashed once per build. The source
 *  tree rides in whole: any edit to the renderer invalidates all entries, which
 *  costs one full rebuild and needs no revision constant kept in sync. */
export function renderCacheRoot(opts: {
  pandocVersion: string;
  urlMap: ReadonlyMap<string, string>;
  privateRels: Iterable<string>;
  basePath: string;
  siteHost: string;
  allowPrivateAssets: boolean;
  /** The real content root: the same abbrlink under a different tree renders
   *  different bytes. */
  contentRoot: string;
  /** Directories whose every file the two cached steps read. */
  srcDirs: string[];
}): string {
  const h = crypto.createHash('sha256');
  h.update(VERSION);
  h.update('\0');
  h.update(opts.pandocVersion);
  h.update('\0');
  for (const [rel, href] of [...opts.urlMap].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    h.update(rel);
    h.update('\0');
    h.update(href);
    h.update('\0');
  }
  h.update('\0');
  for (const rel of [...opts.privateRels].sort()) h.update(rel + '\0');
  h.update('\0');
  h.update(opts.basePath);
  h.update('\0');
  h.update(opts.siteHost);
  h.update('\0');
  h.update(String(opts.allowPrivateAssets));
  h.update('\0');
  h.update(opts.contentRoot);
  h.update('\0');
  for (const dir of opts.srcDirs) {
    for (const abs of walkFiles(dir)) {
      h.update(toPosix(path.relative(dir, abs)));
      h.update('\0');
      h.update(fs.readFileSync(abs));
      h.update('\0');
    }
  }
  return h.digest('hex');
}

export class RenderCache {
  private readonly dir: string;
  private readonly root: string;
  private readonly write: boolean;
  private readonly contentRoot: string;
  private readonly live = new Set<string>();
  private reused = 0;
  private converted = 0;
  private seq = 0;

  constructor({ dir, root, write, contentRoot }: { dir: string; root: string; write: boolean; contentRoot: string }) {
    this.dir = dir;
    this.root = root;
    this.write = write;
    this.contentRoot = contentRoot;
  }

  /** The worker's final outcome for one page, counted once per page. */
  note(reused: boolean): void {
    if (reused) this.reused++;
    else this.converted++;
  }

  /** The recorded attachment files still exist with the same bytes, else the
   *  rendered URLs would point at a file `writeMissing` cannot reproduce. */
  private intact(render: CachedRender): boolean {
    for (const a of render.assets) {
      let abs: string;
      try {
        abs = resolveAsset(this.contentRoot, a.srcRel);
      } catch {
        return false;
      }
      const st = fs.statSync(abs);
      if (st.size !== a.size || st.mtimeMs !== a.mtimeMs) return false;
    }
    return true;
  }

  private keyOf(page: Page): string {
    return crypto.createHash('sha256').update(this.root).update('\0').update(page.relPath).update('\0').update(page.abbrlink).update('\0').update(page.content).digest('hex');
  }

  private fileOf(page: Page): string {
    return path.join(this.dir, `${page.abbrlink}.json`);
  }

  /** Returns the entry only when it was written for exactly this page state. */
  get(page: Page): CachedRender | null {
    this.live.add(page.abbrlink);
    let raw: string;
    try {
      raw = fs.readFileSync(this.fileOf(page), 'utf8');
    } catch {
      return null;
    }
    try {
      const entry = JSON.parse(raw) as { key?: string; render?: CachedRender };
      if (entry.key !== this.keyOf(page) || !isRender(entry.render) || !this.intact(entry.render)) return null;
      return entry.render;
    } catch {
      return null;
    }
  }

  /** A miss is never fatal: two builds may share this directory, so an entry
   *  can vanish between the read and the rename, or a parallel build may finalize
   *  the destination first. A lost write only costs one re-conversion. */
  put(page: Page, render: CachedRender): void {
    if (!this.write) return;
    fs.mkdirSync(this.dir, { recursive: true });
    const dest = this.fileOf(page);
    const tmp = `${dest}.${process.pid}-${this.seq++}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ key: this.keyOf(page), render }));
      fs.renameSync(tmp, dest);
    } catch {
      fs.rmSync(tmp, { force: true });
    }
  }

  /** Drop entries for pages that are gone or private now. */
  prune(): void {
    if (!this.write) return;
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      // A temp file from a concurrent build: its own put() will rename or drop it.
      if (name.endsWith('.tmp')) continue;
      if (!name.endsWith('.json')) continue;
      if (this.live.has(name.slice(0, -5))) continue;
      fs.rmSync(path.join(this.dir, name), { force: true });
    }
  }

  report(): void {
    if (!this.reused && !this.converted) return;
    const total = this.reused + this.converted;
    process.stdout.write(`  render cache: ${this.reused} of ${total} pages reused\n`);
  }
}