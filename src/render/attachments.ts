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

interface AssetNamer {
  assign(pageAbbr: string, srcRel: string): string;
  entries(): AssetEntry[];
  count(): number;
}

export function makeAssetNamer(realRoot: string): AssetNamer {
  const byPage = new Map<string, Map<string, AssetEntry>>();
  const used = new Map<string, Set<string>>();
  return {
    assign(pageAbbr, srcRel) {
      let m = byPage.get(pageAbbr);
      if (!m) byPage.set(pageAbbr, (m = new Map()));
      const known = m.get(srcRel);
      if (known) return known.outRel;
      if (!used.has(pageAbbr)) used.set(pageAbbr, new Set());
      const names = used.get(pageAbbr)!;
      const abs = resolveAsset(realRoot, srcRel);
      const st = fs.statSync(abs);
      const hash = hashFile8(abs);
      const base = path.posix.basename(srcRel);
      let name = hashedName(base, hash);
      let n = 2;
      while (names.has(name)) name = hashedName(base, `${hash}-${n++}`);
      names.add(name);
      const entry = { pageAbbr, srcRel, outRel: `assets/${pageAbbr}/${name}`, abs, stat: { size: st.size, mtimeMs: st.mtimeMs } };
      m.set(srcRel, entry);
      return entry.outRel;
    },
    entries() {
      return [...byPage.values()].flatMap((m) => [...m.values()]);
    },
    count() {
      return this.entries().length;
    },
  };
}