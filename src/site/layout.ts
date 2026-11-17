// The site shell: the layout contract and the render context shared by every page template.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page, SidebarItem, AssetUrls } from '../core/types.ts';
import type { SiteConfig } from '../core/config.ts';

export interface PrevNext {
  prev: Page | null;
  next: Page | null;
}

export interface SiteCtx {
  site: SiteConfig;
  pages: Page[];
  sidebar: SidebarItem[];
  ancestorsOf: Map<string, SidebarItem[]>;
  prevNext: Map<string, PrevNext>;
  home: Page[];
  counts: { published: number; indexes: number };
  /** tagKey (`tagKey()`) → URL path segment, shared by links and emitted dirs. */
  tagSlugs: Map<string, string>;
  themeInitSrc: string;
  uiBootSrc: string;
  /** Content-hashed static asset URLs; a no-JS build still renders identical HTML. */
  assets: AssetUrls;
  builtAt: Date;
}

export interface Theme {
  layout: string;
}

export async function loadTheme(themeDir: string): Promise<Theme> {
  const layout = await fs.readFile(path.join(themeDir, 'layout.html'), 'utf8');
  if (!layout.includes('{{main}}')) {
    throw new Error(`layout.html is missing the {{main}} token: ${themeDir}`);
  }
  return { layout };
}

export function fillLayout(layout: string, vars: Record<string, string>): string {
  return layout.replace(/\{\{([a-z_]+)\}\}/g, (m, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? '') : m,
  );
}
