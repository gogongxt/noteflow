// Tag model: one deterministic tag→URL map shared by links and emitted dirs.
import { crc32Hex } from '../core/util.ts';
import { siteUrlOf } from '../core/config.ts';
import type { Page } from '../core/types.ts';
import type { SiteCtx } from './layout.ts';

/** Filesystem name for a tag — the only source of its URL (href and emitted
 *  dir derive from one string). A leading dot (`.NET`, `..`) would create a
 *  hidden dir or overwrite dist/index.html. */
export function tagDir(tag: string): string {
  const name = String(tag).normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().replace(/^\.+/, '_');
  return name || '_';
}

/** Deterministic tag → directory map. Sanitized names can collide
 *  (`C/C++` vs `C_C++`); tagKey order resolves it, so a tag's URL cannot swap
 *  owners when content is reordered. */
export function buildTagSlugs(pages: Page[]): Map<string, string> {
  const byDir = new Map<string, string[]>(); // dir -> tagKeys claiming it
  for (const group of collectTags(pages).values()) {
    const dir = tagDir(group.name);
    byDir.set(dir, [...(byDir.get(dir) ?? []), group.key]);
  }
  const slugs = new Map<string, string>();
  for (const [dir, keys] of byDir) {
    keys.sort();
    keys.forEach((key, i) => slugs.set(key, i === 0 ? dir : `${dir}-${crc32Hex(key)}`));
  }
  return slugs;
}

/** Link to a tag's page; the dir table and the emitted directories share it. */
export function tagLink(ctx: SiteCtx, tag: string): string {
  const dir = ctx.tagSlugs.get(tagKey(tag)) ?? tagDir(tag);
  return siteUrlOf(ctx.site.url, `/tags/${encodeURIComponent(dir)}`);
}

export function tagKey(tag: string): string {
  return String(tag).normalize('NFC').toLowerCase();
}

export interface TagGroup {
  key: string;
  name: string;
  pages: Page[];
}

/** Case-insensitive tag merge; name keeps its first-seen spelling. */
export function collectTags(pages: Page[]): Map<string, TagGroup> {
  const map = new Map<string, TagGroup>();
  for (const p of pages) {
    if (p.kind === 'index') continue;
    const seen = new Set<string>();
    for (const raw of p.tags) {
      if (raw == null) continue;
      const name = String(raw).normalize('NFC').trim();
      if (!name) continue;
      const key = tagKey(name);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!map.has(key)) map.set(key, { key, name, pages: [] });
      map.get(key)!.pages.push(p);
    }
  }
  return map;
}
