// Docs-site profile: the project's own documentation, built by noteflow and
// deployed to GitHub Pages (--config site.config.docs.mjs). A profile replaces
// the personal config stack entirely: no site.config.local override is read.
/** @type {import('./src/core/config.ts').AppConfig} */
export default {
  // The /noteflow pathname is the base path every emitted URL carries; rename
  // the repo → change it here. A custom domain just drops the path.
  url: 'https://gogongxt.github.io/noteflow',
  siteName: 'NoteFlow',
  lang: 'en',
  description: 'NoteFlow — a pandoc-powered knowledge-base static site generator',

  // Header GitHub icon → this repository.
  repoUrl: 'https://github.com/gogongxt/noteflow',

  // Hovering a page title offers to edit its source file here; the content
  // tree is the docs/ directory of this repository.
  edit: {
    repoUrl: 'https://github.com/gogongxt/noteflow',
    branch: 'master',
    provider: 'github',
    root: 'docs',
  },

  // The mark and © line link this repository; the author credit is the one
  // config-driven piece here.
  footer: {
    copyrightUrl: 'https://github.com/gogongxt/noteflow',
    author: 'gogongxt',
    authorUrl: 'https://github.com/gogongxt',
  },

  contentDir: 'docs',
  outDir: 'dist-docs',
  themeDir: 'themes/default',
  cacheDir: '.cache',
  manifestFile: '.build-manifest.docs.json',

  postPattern: '/posts/{abbrlink}',
  pageSize: { home: 20, feed: 20 },

  mermaid: { theme: 'redux-color' },

  // Public by design: the ids locate the repo/category, not grant write access.
  giscus: {
    repo: 'gogongxt/noteflow',
    repoId: 'R_kgDOVyD3CA',
    category: 'Announcements',
    categoryId: 'DIC_kwDOVyD3CM4DLfXx',
    lang: 'en',
  },

  // Pages cannot send response headers; the CSP rides in a <meta> tag instead.
  cspMeta: true,
};
