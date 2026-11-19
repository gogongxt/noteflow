import fs from 'node:fs';
import path from 'node:path';
import { BuildError, hashFile8, hashedName } from '../core/util.ts';

/** Extension → Content-Type for every publishable attachment. nginx and the
 *  preview server serve these types explicitly: Safari refuses media whose
 *  response is not a media type. Everything here is passive content. */
export const ATTACHMENT_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
  vtt: 'text/vtt',
};

export function resolveAsset(realRoot: string, srcRel: string): string {
  if (srcRel.split('/').some((seg) => seg.startsWith('.'))) {
    throw new BuildError(`attachments cannot be dotfiles: ${srcRel}`);
  }
  const ext = path.extname(srcRel).toLowerCase().slice(1);
  if (!(ext in ATTACHMENT_TYPES)) throw new BuildError(`attachment type ${ext ? '.' + ext : '(none)'} is not allowed: ${srcRel}`);
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(realRoot, srcRel));
  } catch {
    throw new BuildError(`attachment not found: ${srcRel}`);
  }
  if (!(real === realRoot || real.startsWith(realRoot + path.sep))) {
    throw new BuildError(`attachment escapes the content root (realpath check failed): ${srcRel}`);
  }
  if (!fs.statSync(real).isFile()) throw new BuildError(`attachment is not a regular file: ${srcRel}`);
  return real;
}

export interface AssetEntry {
  pageAbbr: string;
  srcRel: string;
  outRel: string;
  /** Copy source; streamed, so a video never sits in memory. */
  abs: string;
  /** Size/mtime when hashed, to detect an edit between hashing and copying. */
  stat: { size: number; mtimeMs: number };
}

/** An attachment a page rendered against, as recorded for a cached render. */
export interface PinnedAsset {
  srcRel: string;
  outRel: string;
  size: number;
  mtimeMs: number;
}

interface AssetNamer {
  /** Name the attachment's URL, hashing the file on first use. */
  assign(pageAbbr: string, srcRel: string): string;
  /** Re-register an attachment a cached page recorded, pinning the URL it
   *  rendered with; the cache has already verified the bytes are unchanged. */
  restore(pageAbbr: string, pinned: PinnedAsset): void;
  pinOf(pageAbbr: string, srcRel: string): PinnedAsset | undefined;
  entries(): AssetEntry[];
  count(): number;
}

export function makeAssetNamer(realRoot: string): AssetNamer {
  const byPage = new Map<string, Map<string, AssetEntry>>();
  const used = new Map<string, Set<string>>();
  const claim = (pageAbbr: string, srcRel: string, outRel: string, abs: string, stat: { size: number; mtimeMs: number }): AssetEntry => {
    let m = byPage.get(pageAbbr);
    if (!m) byPage.set(pageAbbr, (m = new Map()));
    if (!used.has(pageAbbr)) used.set(pageAbbr, new Set());
    used.get(pageAbbr)!.add(path.posix.basename(outRel));
    const entry = { pageAbbr, srcRel, outRel, abs, stat };
    m.set(srcRel, entry);
    return entry;
  };
  return {
    assign(pageAbbr, srcRel) {
      const known = byPage.get(pageAbbr)?.get(srcRel);
      if (known) return known.outRel;
      const abs = resolveAsset(realRoot, srcRel);
      const st = fs.statSync(abs);
      const hash = hashFile8(abs);
      const base = path.posix.basename(srcRel);
      let name = hashedName(base, hash);
      let n = 2;
      while (used.get(pageAbbr)?.has(name)) name = hashedName(base, `${hash}-${n++}`);
      return claim(pageAbbr, srcRel, `assets/${pageAbbr}/${name}`, abs, { size: st.size, mtimeMs: st.mtimeMs }).outRel;
    },
    restore(pageAbbr, pinned) {
      if (byPage.get(pageAbbr)?.has(pinned.srcRel)) return;
      claim(pageAbbr, pinned.srcRel, pinned.outRel, resolveAsset(realRoot, pinned.srcRel), { size: pinned.size, mtimeMs: pinned.mtimeMs });
    },
    pinOf(pageAbbr, srcRel) {
      const e = byPage.get(pageAbbr)?.get(srcRel);
      return e ? { srcRel: e.srcRel, outRel: e.outRel, size: e.stat.size, mtimeMs: e.stat.mtimeMs } : undefined;
    },
    entries() {
      return [...byPage.values()].flatMap((m) => [...m.values()]);
    },
    count() {
      return this.entries().length;
    },
  };
}