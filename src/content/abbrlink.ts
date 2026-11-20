// abbrlink: the CRC32 URL slug in frontmatter, `crc32Hex(title + "|" + date)`
// with the date cut to YYYY-MM-DD. The slug is deterministic, so a note
// without one is computed on the fly and every machine agrees — the build
// never writes into the content tree. `backfill` is the one command that
// pins slugs into frontmatter; it is run deliberately and its result
// committed by the author.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BuildError, crc32Hex, datePart, parseArgs, runCli, toPosix, walkFiles } from '../core/util.ts';
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

/** Atomically write the entries' pre-injected texts, temp + rename. Backfill only. */
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
          `Cannot write abbrlink to ${w.path} (${code}). The content directory must be writable to pin slugs; ` +
            'run backfill where you edit and commit your notes, not on the serving mirror.',
        );
      }
      throw err;
    }
  }
  return writes.length;
}

/** Compute the slugs of unpinned notes in memory (never touching the source
 *  files), refuse collisions, and return the unpinned notes' rel paths. */
export function assignAbbrlinks(root: TreeNode, pageByNode: Map<TreeNode, Page>, pages: Page[]): string[] {
  const seen = new Map<string, string>();
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
        unpinned.push(node.relPath);
      }
      assertUnique(seen, { abbrlink: page.abbrlink, label: node.relPath });
    } else if (!st.abbrlink) {
      st.abbrlink = computeAbbrlink(st.title, st.date);
      unpinned.push(node.relPath);
      assertUnique(seen, { abbrlink: st.abbrlink, label: node.relPath });
    } else {
      assertUnique(seen, { abbrlink: st.abbrlink, label: node.relPath });
    }
  }
  for (const p of pages) if (p.kind === 'index') assertUnique(seen, { abbrlink: p.abbrlink, label: p.relPath + '/_index' });
  return unpinned;
}

// ------------------------------------------------------------- CLI entry

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const check = args.check === true;
  const cfg = await loadConfig(
    typeof args.config === 'string' ? path.resolve(process.cwd(), String(args.config)) : undefined,
    typeof args.content === 'string' ? path.resolve(process.cwd(), String(args.content)) : undefined,
  );
  const contentRoot = typeof args.content === 'string' ? path.resolve(process.cwd(), String(args.content)) : repoPath(cfg.contentDir);
  const { missing, existing } = collectMissing(contentRoot);
  const seen = new Map(existing);
  if (!missing.length) {
    console.log('✓ Every note already has an abbrlink');
    return;
  }
  for (const m of missing) assertUnique(seen, { abbrlink: m.abbrlink, label: toPosix(path.relative(contentRoot, m.path)) });
  for (const m of missing) console.log(`${check ? 'would pin' : 'pin'} ${m.abbrlink}  ${toPosix(path.relative(contentRoot, m.path))}`);
  if (check) return;
  const writes = missing.map((m) => ({ path: m.path, text: injectAbbrlink(m.raw, m.abbrlink, toPosix(path.relative(contentRoot, m.path))) }));
  console.log(`✓ Pinned ${writeAbbrlinks(writes)} files — review and commit them yourself`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(main);
}