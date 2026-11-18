// Docs-site profile: the project's own documentation, built by noteflow and
// deployed to GitHub Pages (./start.sh build --config site.config.docs.ts).
import type { AppConfig } from './src/core/config.ts';

const config: AppConfig = {
  // The /noteflow pathname is the base path every emitted URL carries; rename
  // the repo → change it here. A custom domain just drops the path.
  url: 'https://gogongxt.github.io/noteflow',
  siteName: 'NoteFlow',
  lang: 'en',
  description: 'NoteFlow — a pandoc-powered knowledge-base static site generator',

  // Header GitHub icon → this repository.
  repoUrl: 'https://github.com/gogongxt/noteflow',

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

  // Pages cannot send response headers; the CSP rides in a <meta> tag instead.
  cspMeta: true,
};

export default config;
