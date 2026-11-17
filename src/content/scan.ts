import fs from 'node:fs';
import path from 'node:path';
import { BuildError, log, toPosix } from '../core/util.ts';

export const SORT_FILE = 'sort.txt';
export const INDEX_FILE = '_index.md';

export interface ParsedNode {
  name: string;
  relPath: string;
  mdPath: string | null;
  dirPath: string | null;
  indexPath: string | null;
  children: ParsedNode[];
}

interface NodeShape {
  dir: boolean;
  md: boolean;
}

const COLLATOR = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

function readSortList(dir: string): string[] {
  const file = path.join(dir, SORT_FILE);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.normalize('NFC'));
}

export function collectNodes(dir: string, relDir = ''): Map<string, NodeShape> {
  const nodes = new Map<string, NodeShape>();
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = e.name.normalize('NFC');
    if (name.startsWith('.') || name.startsWith('_')) continue;
    if (e.isSymbolicLink()) {
      throw new BuildError(`symbolic links are not allowed in the content tree: ${toPosix(path.join(relDir, e.name))}`);
    }
    if (e.isDirectory()) {
      const cur = nodes.get(name) ?? { dir: false, md: false };
      cur.dir = true;
      nodes.set(name, cur);
    } else if (e.isFile()) {
      if (!name.endsWith('.md')) continue; // sort.txt / attachments etc.
      const base = name.slice(0, -3);
      if (!base) continue; // a file literally named ".md"
      const cur = nodes.get(base) ?? { dir: false, md: false };
      cur.md = true;
      nodes.set(base, cur);
    } else {
      throw new BuildError(`non-regular file in the content tree: ${toPosix(path.join(relDir, e.name))}`);
    }
  }
  return nodes;
}

export function assertNoCaseCollision(nodes: Map<string, NodeShape>, relDir: string): void {
  const seen = new Map<string, string>();
  for (const name of nodes.keys()) {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      throw new BuildError(
        `nodes differing only by case in the same directory: ${toPosix(path.join(relDir, seen.get(key)!))} and ${toPosix(path.join(relDir, name))}`,
      );
    }
    seen.set(key, name);
  }
}

function sortChildren(nodes: Map<string, NodeShape>, declared: string[], relDir: string): string[] {
  const names = new Set(nodes.keys());
  const declaredSet = new Set(declared);
  const ordered: string[] = [];
  for (const name of declared) {
    if (names.has(name)) {
      if (!ordered.includes(name)) ordered.push(name);
    } else {
      log.warn(`[sort] ${toPosix(relDir) || '.'}/sort.txt declares a node that does not exist: ${name}`);
    }
  }
  const rest = [...names].filter((n) => !declaredSet.has(n)).sort(COLLATOR.compare);
  return [...ordered, ...rest];
}

interface ScanResult {
  root: ParsedNode;
  realRoot: string;
}

export function scanTree(contentRoot: string): ScanResult {
  const realRoot = fs.realpathSync(contentRoot);
  const root: ParsedNode = {
    name: '',
    relPath: '',
    mdPath: null,
    dirPath: realRoot,
    indexPath: null,
    children: [],
  };
  buildNode(root, realRoot, '');
  return { root, realRoot };
}

function buildNode(node: ParsedNode, absDir: string, relDir: string): void {
  const nodes = collectNodes(absDir, relDir);
  assertNoCaseCollision(nodes, relDir);
  const declared = readSortList(absDir);
  for (const name of sortChildren(nodes, declared, relDir)) {
    const info = nodes.get(name)!;
    const childRel = toPosix(path.join(relDir, name));
    const dirPath = info.dir ? path.join(absDir, name) : null;
    const indexPath = dirPath && fs.existsSync(path.join(dirPath, INDEX_FILE)) ? path.join(dirPath, INDEX_FILE) : null;
    const child: ParsedNode = {
      name,
      relPath: childRel,
      mdPath: info.md ? path.join(absDir, `${name}.md`) : null,
      dirPath: dirPath ? fs.realpathSync(dirPath) : null,
      indexPath,
      children: [],
    };
    node.children.push(child);
    if (child.dirPath) buildNode(child, child.dirPath, childRel);
  }
}

const RESERVED_ROOT = new Set(['archives', 'tags', 'feed.xml', '404.html', 'robots.txt']);

export function assertReserved(root: ParsedNode): void {
  for (const child of root.children) {
    const key = child.name.toLowerCase();
    if (RESERVED_ROOT.has(key) || RESERVED_ROOT.has(`${key}.md`)) {
      throw new BuildError(`root-level node name collides with a builder fixed route: ${child.name}`);
    }
  }
}
