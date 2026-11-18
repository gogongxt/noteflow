// Fail-closed: only a literal boolean `true` is public, and a private parent
// makes the whole subtree private. Private content never enters Page[].
import fs from 'node:fs';
import { BuildError, nfc } from '../core/util.ts';
import { parseNote, readAbbrlink, splitSource } from './frontmatter.ts';
import { rawDateString, computeIndexAbbrlink } from './abbrlink.ts';
import type { Frontmatter, IndexPage, NodeState, NotePage, Page, ParsedNode, PrivateItem, SidebarItem, TreeNode } from '../core/types.ts';

function strictBool(value: unknown, field: string, label: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') {
    throw new BuildError(`${label}: frontmatter field ${field} must be a YAML boolean (true/false), got ${JSON.stringify(value)}`);
  }
  return value;
}

function normalizeTags(tags: unknown): string[] {
  if (tags == null) return [];
  const arr: unknown[] = Array.isArray(tags) ? tags : [tags];
  return arr.map((t) => nfc(String(t)).trim()).filter(Boolean);
}

/** Free text handed to parseSummary; numbers and dates are stringified so `summary: 42` / `2026-11-14` work. */
function normalizeSummary(value: unknown, label: string): string | null {
  if (value == null) return null;
  if (Array.isArray(value) || (typeof value === 'object' && !(value instanceof Date))) {
    throw new BuildError(`${label}: frontmatter field summary must be a string, got ${JSON.stringify(value)}`);
  }
  const raw = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  const text = nfc(raw).replace(/\r\n?/g, '\n').trim();
  return text || null;
}

/** YAML date objects must not become locale strings; keep YYYY-MM-DD. */
function normalizeDateLike(value: unknown, field: string, label: string): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new BuildError(`${label}: frontmatter field ${field} is an invalid date`);
    }
    return value.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  return text || null;
}

interface ResolveResult {
  root: TreeNode;
  pages: Page[];
  privateItems: PrivateItem[];
}

export function resolveTree(parsedRoot: ParsedNode): ResolveResult {
  const privateItems: PrivateItem[] = [];

  const root = parsedRoot as TreeNode;
  root.state = emptyState();
  for (const child of root.children) visit(child as TreeNode, true);

  const pages: Page[] = [];
  for (const child of root.children) collect(child as TreeNode, pages);
  return { root, pages, privateItems };

  function visit(node: TreeNode, parentPublic: boolean): void {
    let content = '';
    let data: Frontmatter = {};
    let raw = '';
    let title = node.name;
    let abbrlink: string | null = null;
    let date: string | null = null;

    if (node.mdPath) {
      raw = fs.readFileSync(node.mdPath, 'utf8');
      const src = splitSource(raw);
      const parsed = parseNote(raw);
      if (parsed.error) throw new BuildError(`${node.relPath}.md: ${parsed.error}`);
      data = parsed.data ?? {};
      content = parsed.content;
      if (data.title != null) title = nfc(String(data.title));
      abbrlink = readAbbrlink(data);
      date = rawDateString(src.yaml, data);
    }

    let isPublic = node.mdPath ? parentPublic && strictBool(data.public, 'public', node.relPath) : parentPublic;

    let indexData: Frontmatter | null = null;
    let indexContent = '';
    if (node.indexPath) {
      const idx = parseNote(fs.readFileSync(node.indexPath, 'utf8'));
      if (idx.error) throw new BuildError(`${node.relPath}/_index.md: ${idx.error}`);
      // `public` in _index.md is a directory-level switch: it makes the whole
      // subtree private. The note page's own frontmatter (if any) still has to
      // allow publishing too — both must be true.
      if (idx.data?.public !== undefined) {
        const idxPublic = strictBool(idx.data.public, 'public', `${node.relPath}/_index.md`);
        isPublic = isPublic && idxPublic;
      }
      indexData = idx.data;
      indexContent = idx.content;
      if (!node.mdPath && idx.data?.title != null) title = nfc(String(idx.data.title));
    }

    node.state = {
      own: !!node.mdPath,
      public: isPublic,
      title,
      date,
      tags: normalizeTags(data.tags),
      description: data.description == null ? null : String(data.description),
      summary: normalizeSummary(data.summary, node.relPath),
      updated: normalizeDateLike(data.updated, 'updated', node.relPath),
      abbrlink,
      content,
      raw,
      data,
      hasIndex: !!node.indexPath,
      indexData,
      indexContent,
    };

    if (node.mdPath && !isPublic) {
      privateItems.push({ kind: 'page', absPath: node.mdPath, relPath: node.relPath, title, abbrlink });
    }

    // Only the node where privacy starts needs a record: its relPath already
    // prefixes every private child's, attachments included.
    if (node.dirPath && !node.mdPath && parentPublic && !isPublic) {
      privateItems.push({ kind: 'dir', absPath: node.dirPath, relPath: node.relPath, title, abbrlink });
    }

    for (const child of node.children) visit(child as TreeNode, isPublic);

    const hasPublicNotesInSubtree = childrenHavePublicNote(node);
    node.needsIndex = isPublic && !node.mdPath && hasPublicNotesInSubtree;
    node.hasPublicContent = (isPublic && !!node.mdPath) || node.needsIndex || node.children.some((c) => c.hasPublicContent);
  }

  function childrenHavePublicNote(node: TreeNode): boolean {
    if (node.mdPath && node.state.public) return true;
    return node.children.some(childrenHavePublicNote);
  }

  function collect(node: TreeNode, out: Page[]): void {
    if (!node.hasPublicContent) return;
    const st = node.state;
    if (node.mdPath && st.public) {
      const page: NotePage = {
        kind: 'note',
        node,
        relPath: node.relPath,
        title: st.title,
        date: st.date,
        updated: st.updated,
        tags: st.tags,
        description: st.description,
        summary: st.summary,
        abbrlink: st.abbrlink ?? '',
        href: '',
        html: '',
        toc: [],
        // Absent field means enabled; a wrong type fails the build rather than silently loosening.
        comments: st.data.comments == null ? true : strictBool(st.data.comments, 'comments', node.relPath),
        childPages: [],
        content: st.content,
        raw: st.raw,
        data: st.data,
      };
      out.push(page);
    } else if (node.needsIndex) {
      const page: IndexPage = {
        kind: 'index',
        node,
        relPath: node.relPath,
        title: st.indexData?.title != null ? nfc(String(st.indexData.title)) : node.name,
        date: null,
        updated: null,
        tags: [],
        description: st.indexData?.description == null ? null : String(st.indexData.description),
        summary: normalizeSummary(st.indexData?.summary, `${node.relPath}/_index.md`),
        abbrlink: computeIndexAbbrlink(node.relPath),
        href: '',
        html: '',
        toc: [],
        // Index pages are auto-generated listings and have no discussion thread of their own.
        comments: false,
        content: st.indexContent,
        raw: '',
        data: st.indexData ?? {},
        childPages: [],
      };
      out.push(page);
    }
    for (const c of node.children) collect(c as TreeNode, out);
  }
}

/** Immediate public children only; grandchildren are not pulled up. */
export function collectChildPages(node: TreeNode, pageByNode: Map<TreeNode, Page>): Page[] {
  const out: Page[] = [];
  for (const c of node.children) {
    if (!c.hasPublicContent) continue;
    const cp = pageByNode.get(c);
    if (cp) out.push(cp);
  }
  return out;
}

function emptyState(): NodeState {
  return {
    own: false,
    public: true,
    title: '',
    date: null,
    tags: [],
    description: null,
    summary: null,
    updated: null,
    abbrlink: null,
    content: '',
    raw: '',
    data: {},
    hasIndex: false,
    indexData: null,
    indexContent: '',
  };
}

export function buildSidebar(root: TreeNode, pageByRelPath: Map<string, Page>): SidebarItem[] {
  return root.children.map((c) => sidebarItem(c as TreeNode, pageByRelPath)).filter((x): x is SidebarItem => x !== null);

  function sidebarItem(node: TreeNode, pageMap: Map<string, Page>): SidebarItem | null {
    if (!node.hasPublicContent) return null;
    const own = pageMap.get(node.relPath) ?? null;
    const children = node.children.map((c) => sidebarItem(c as TreeNode, pageMap)).filter((x): x is SidebarItem => x !== null);
    return {
      name: node.name,
      relPath: node.relPath,
      title: own?.title ?? node.state.title,
      href: own ? own.href : null,
      children,
    };
  }
}
