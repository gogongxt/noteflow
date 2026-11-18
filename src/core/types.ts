import type { ParsedNode } from '../content/scan.ts';
export type { ParsedNode };

export interface Frontmatter {
  title?: unknown;
  date?: unknown;
  updated?: unknown;
  description?: unknown;
  summary?: unknown;
  tags?: unknown;
  public?: unknown;
  abbrlink?: unknown;
  comments?: unknown;
  [unknownField: string]: unknown;
}

export interface NodeState {
  own: boolean;
  public: boolean;
  title: string;
  date: string | null;
  tags: string[];
  description: string | null;
  summary: string | null;
  updated: string | null;
  abbrlink: string | null;
  content: string;
  raw: string;
  data: Frontmatter;
  hasIndex: boolean;
  indexData: Frontmatter | null;
  indexContent: string;
}

export interface TreeNode extends ParsedNode {
  state: NodeState;
  needsIndex: boolean;
  hasPublicContent: boolean;
  children: TreeNode[];
}

interface PageBase {
  relPath: string;
  abbrlink: string;
  href: string;
  title: string;
  date: string | null;
  updated: string | null;
  tags: string[];
  description: string | null;
  /** Raw frontmatter text; parseSummary (content/summary.ts) owns the block grammar. */
  summary: string | null;
  html: string;
  toc: TocItem[];
  /** Only an explicit `comments: false` makes this false; otherwise it follows whether the site configured giscus. */
  comments: boolean;
  /** Immediate public children; empty for leaves. Filled after conversion in the pipeline. */
  childPages: Page[];
}

export interface NotePage extends PageBase {
  kind: 'note';
  node: TreeNode;
  content: string;
  raw: string;
  data: Frontmatter;
}

export interface IndexPage extends PageBase {
  kind: 'index';
  node: TreeNode;
  content: string;
  raw: string;
  data: Frontmatter;
}

export type Page = NotePage | IndexPage;

export interface TocItem {
  /** The page title comes from frontmatter and is never a TOC entry, so a
   *  level 1 here is always the author's own body heading. */
  level: 1 | 2 | 3;
  id: string;
  text: string;
}

export interface SidebarItem {
  name: string;
  relPath: string;
  title: string;
  href: string | null;
  children: SidebarItem[];
}

export interface PrivateItem {
  /** `dir` is a directory switched private by `_index.md`; it guards the whole prefix. */
  kind: 'page' | 'file' | 'dir';
  absPath: string;
  relPath: string;
  title: string;
  abbrlink?: string | null;
}

/** Content-hashed static asset URLs the layout links to (filled by the build). */
export interface AssetUrls {
  style: string;
  app: string;
  /** The soft-navigation module; app.js imports it by its hashed name. */
  spa: string;
  search: string;
  media: string;
  /** Lazy-loaded in pages that render comments. */
  comments: string;
  favicon: string;
  /** The square touch icon for home-screen bookmarks. */
  touchIcon: string;
  /** The wide theme mark, used by the header brand and the footer credit. */
  mark: string;
  /** Empty when the theme ships no fonts. */
  fonts: string;
  /** Empty when no page has a mermaid diagram. */
  diagrams: string;
  /** Empty when the search index is not built. */
  searchIndex: string;
}
