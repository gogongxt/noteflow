// abbrlink: the CRC32 URL slug in frontmatter, `crc32Hex(title + "|" + date)`
// with the date cut to YYYY-MM-DD. A note without one gets its slug written
// into its frontmatter by the first build that meets it — commit the change
// like any other edit. `--check` stays read-only and computes on the fly.
import fs from 'node:fs';
import { BuildError, crc32Hex, datePart, log } from '../core/util.ts';
import type { Page, TreeNode } from '../core/types.ts';
import { injectAbbrlink, parseNote } from './frontmatter.ts';

export { crc32Hex };

/** URL slug for a note; `title` and `date` are exactly what the source says. */
export function computeAbbrlink(title: string, dateRaw: string | null): string {
  return crc32Hex(`${title}|${datePart(dateRaw) ?? ''}`);
}

/** URL slug for a directory index page; the prefix keeps it clear of note slugs. */
export function computeIndexAbbrlink(relDir: string): string {
  return crc32Hex(`index|${relDir}`);
}

/** The date as written in frontmatter — a timezone-dependent toISOString would
 *  change the slug, and for `updated` it would show the previous day. */
export function rawDateString(
  yamlText: string,
  data: { date?: unknown; updated?: unknown } | null,
  field: 'date' | 'updated' = 'date',
): string | null {
  if (data?.[field] == null) return null;
  const m = new RegExp(`^${field}[ \\t]*:[ \\t]*(.+)$`, 'm').exec(yamlText);
  if (m) {
    let v = m[1].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v;
  }
  return datePart(data[field]);
}

/** Refuse a duplicate slug: silently changing a published URL is worse than failing. */
export function assertUnique(seen: Map<string, string>, entry: { abbrlink: string; label: string }): void {
  const prev = seen.get(entry.abbrlink);
  if (prev !== undefined && prev !== entry.label) {
    throw new BuildError(`abbrlink collision: ${entry.abbrlink} is used by both ${prev} and ${entry.label}`);
  }
  seen.set(entry.abbrlink, entry.label);
}

/** Atomically write the entries' pre-injected texts, temp + rename. */
export function writeAbbrlinks(writes: { path: string; text: string }[]): number {
  for (const w of writes) {
    const tmp = w.path + '.tmp';
    try {
      fs.writeFileSync(tmp, w.text);
      fs.renameSync(tmp, w.path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM') {
        throw new BuildError(
          `Cannot write abbrlink to ${w.path} (${code}). The content directory must be writable: ` +
            'a note gets its abbrlink once, on its first build. Mount it read-write.',
        );
      }
      throw err;
    }
  }
  return writes.length;
}

/** Compute missing slugs, refuse collisions, and (in fix mode) write them back.
 *  Check mode touches nothing and returns the unpinned notes' rel paths. */
export function assignAbbrlinks(root: TreeNode, pageByNode: Map<TreeNode, Page>, pages: Page[], fix: boolean): string[] {
  const seen = new Map<string, string>();
  const writes: { path: string; raw: string; abbrlink: string; label: string }[] = [];
  const unpinned: string[] = [];
  const nodes: TreeNode[] = [];
  (function walk(n: TreeNode): void {
    for (const c of n.children) {
      nodes.push(c);
      walk(c);
    }
  })(root);

  for (const node of nodes) {
    if (!node.mdPath) continue;
    const page = pageByNode.get(node);
    const st = node.state;
    if (page) {
      if (!page.abbrlink) {
        page.abbrlink = computeAbbrlink(page.title, page.date);
        st.abbrlink = page.abbrlink;
        writes.push({ path: node.mdPath, raw: st.raw, abbrlink: page.abbrlink, label: node.relPath });
      }
      assertUnique(seen, { abbrlink: page.abbrlink, label: node.relPath });
    } else if (!st.abbrlink) {
      st.abbrlink = computeAbbrlink(st.title, st.date);
      writes.push({ path: node.mdPath, raw: st.raw, abbrlink: st.abbrlink, label: node.relPath });
      assertUnique(seen, { abbrlink: st.abbrlink, label: node.relPath });
    } else {
      assertUnique(seen, { abbrlink: st.abbrlink, label: node.relPath });
    }
  }
  for (const p of pages) if (p.kind === 'index') assertUnique(seen, { abbrlink: p.abbrlink, label: p.relPath + '/_index' });

  if (!writes.length) return [];
  if (!fix) {
    for (const w of writes) unpinned.push(w.label);
    return unpinned;
  }
  // Verified write-back: re-read each file so an edit saved mid-build is not
  // overwritten with the stale snapshot.
  const prepared = writes.map((entry) => {
    const current = fs.readFileSync(entry.path, 'utf8');
    if (current !== entry.raw) {
      const reparsed = parseNote(current);
      if (reparsed.error) {
        throw new BuildError(`${entry.label}: source changed mid-build and the new bytes have no readable frontmatter: ${reparsed.error}`);
      }
    }
    return { path: entry.path, text: injectAbbrlink(current, entry.abbrlink, entry.label) };
  });
  writeAbbrlinks(prepared);
  log.info(`✓ Wrote back abbrlink: ${prepared.length} files — commit them with the note`);
  return [];
}
