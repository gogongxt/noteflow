// Site configuration — the only file you need to edit to run noteflow on your
// own content. CLI flags (--content, --out) and the PANDOC_BIN env var take
// precedence over the values here.
//
// Personal overrides: create site.config.local.ts (or .mjs; gitignored) that
// default-exports the keys to change — they are merged on top of this file.
import type { AppConfig } from './src/core/config.ts';

const config: AppConfig = {
  url: 'https://example.com',
  siteName: 'my notes',
  lang: 'en',
  description: 'Personal knowledge base and blog',

  // Content: a separate private repository in real use (gitignored). The
  // build falls back to docs/ (this project's own documentation) when the
  // configured directory is absent.
  contentDir: 'notes',
  outDir: 'dist',
  themeDir: 'themes/default',
  cacheDir: '.cache',
  manifestFile: '.build-manifest.json',

  // Note URLs: built as posts/<abbrlink>/index.html, exposed as extensionless paths.
  postPattern: '/posts/{abbrlink}',
  pageSize: { home: 20, feed: 20 },

  // Comments via GitHub Discussions: add a giscus block (repo, repoId, …)
  // to enable; remove it to disable (frame-src becomes 'none').
  // giscus: { repo: 'user/repo', repoId: '…', category: 'Announcements', categoryId: '…' },
};

export default config;
