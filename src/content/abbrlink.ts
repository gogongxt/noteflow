// abbrlink: the CRC32 URL slug in frontmatter, `crc32Hex(title + "|" + date)`
// with the date cut to YYYY-MM-DD. The build and the `backfill-abbrlink` CLI
// must compute and verify write-back identically, or a note gets two URLs.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BuildError, crc32Hex, datePart, log, parseArgs, runCli, toPosix, walkFiles } from '../core/util.ts';
import { loadConfig, repoPath } from '../core/config.ts';
import type { Page, TreeNode } from '../core/types.ts';
import { injectAbbrlink, parseNote, readAbbrlink, splitSource } from './frontmatter.ts';
import { INDEX_FILE, SORT_FILE } from './scan.ts';

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

interface MissingEntry {
  path: string;
  raw: string;
  title: string;
  date: string | null;
  abbrlink: string;
}

interface CollectResult {
  missing: MissingEntry[];
  existing: Map<string, string>;
}

const SKIP_FILE = new Set([SORT_FILE, INDEX_FILE]);

/** Every note missing an abbrlink under `contentRoot`, plus the slugs already in use. */
function collectMissing(contentRoot: string): CollectResult {
  const missing: MissingEntry[] = [];
  const existing = new Map<string, string>();
  for (const abs of walkFiles(contentRoot)) {
    const base = path.basename(abs);
    const rel = toPosix(path.relative(contentRoot, abs));
    if (rel.split('/').some((seg) => seg.startsWith('.') || seg.startsWith('_'))) continue;
    if (!base.endsWith('.md') || SKIP_FILE.has(base)) continue;
    const raw = fs.readFileSync(abs, 'utf8');
    const { data, error } = parseNote(raw);
    if (error) throw new BuildError(`${rel}: ${error}`);
    const cur = readAbbrlink(data);
    if (cur) {
      existing.set(cur, rel);
      continue;
    }
    const title = String(data?.title ?? base.slice(0, -3));
    const date = rawDateString(splitSource(raw).yaml, data);
    missing.push({ path: abs, raw, title, date, abbrlink: computeAbbrlink(title, date) });
  }
  return { missing, existing };
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
          `Cannot write back abbrlink to ${w.path} (${code}). The content directory must be writable: ` +
            'a note gets its abbrlink once, on its first build. Mount it read-write, or add abbrlinks ahead of time.',
        );
      }
      throw err;
    }
  }
  return writes.length;
}

/** Compute missing slugs, refuse collisions, and (in fix mode) write them back. */
export function assignAbbrlinks(root: TreeNode, pageByNode: Map<TreeNode, Page>, pages: Page[], fix: boolean): void {
  const seen = new Map<string, string>();
  const writes: { path: string; raw: string; abbrlink: string; label: string }[] = [];
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

  if (!writes.length) return;
  if (!fix) {
    throw new BuildError(`Notes missing abbrlink (--check mode does not write back):\n${writes.map((w) => `  - ${w.label}`).join('\n')}`);
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
  log.info(`✓ Wrote back abbrlink: ${prepared.length} files`);
}

// ------------------------------------------------------------- CLI entry

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const check = args.check === true;
  const contentRoot = typeof args.content === 'string' ? path.resolve(args.content) : repoPath((await loadConfig()).contentDir);
  const { missing, existing } = collectMissing(contentRoot);
  const seen = new Map(existing);
  if (!missing.length) {
    console.log('✓ Every note already has an abbrlink');
    return;
  }
  for (const m of missing) assertUnique(seen, { abbrlink: m.abbrlink, label: toPosix(path.relative(contentRoot, m.path)) });
  for (const m of missing) console.log(`${check ? 'missing' : 'write'} ${m.abbrlink}  ${toPosix(path.relative(contentRoot, m.path))}`);
  if (check) process.exit(1);
  const writes = missing.map((m) => ({ path: m.path, text: injectAbbrlink(m.raw, m.abbrlink, toPosix(path.relative(contentRoot, m.path))) }));
  console.log(`✓ Wrote back ${writeAbbrlinks(writes)} files`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(main);
}