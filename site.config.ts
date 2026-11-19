// Site configuration — the only file you need to edit to run NoteFlow on your
// own content. CLI flags (--content, --out) and the PANDOC_BIN env var take
// precedence over the values here.
//
// Personal overrides: create site.config.local.mjs (gitignored) that
// default-exports the keys to change — they are merged on top of this file.
// The same file at the content root also works, so the settings travel with the
// notes repo; a project-root copy wins over it.
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

  // Optional: a header GitHub icon linking to your repository. Remove to hide.
  // repoUrl: 'https://github.com/you/your-notes',

  // Optional: hovering a note's title shows a pencil that opens that file's
  // edit page in your forge (Gitea by default; 'github' and 'gitlab' supported).
  // edit: {
  //   repoUrl: 'https://git.example.com/you/notes',
  //   branch: 'main',        // default 'main'
  //   provider: 'gitea',     // default 'gitea'
  //   root: 'docs',          // where the content dir sits in the repo; '' when it is the repo root
  // },

  // Footer: omit the block for the theme mark, "© <year> <siteName>" and the
  // author line. Every field is optional and renders only when set.
  // footer: {
  //   copyright: '© {year} {site}',      // {year} and {site} are filled in
  //   since: 2024,                       // makes the year a 2024–<this year> range
  //   copyrightUrl: '/about',            // link the © line (site path or URL)
  //   author: 'you',                     // renders "By you" after the © line
  //   authorUrl: 'https://github.com/you',
  //   icp: '京ICP备00000000号',        // 备案号, linked to beian.miit.gov.cn
  //   credit: false,                     // drop the mark and the project link
  // },

  // Comments via GitHub Discussions: add a giscus block (repo, repoId, …)
  // to enable; remove it to disable (frame-src becomes 'none').
  // giscus: { repo: 'user/repo', repoId: '…', category: 'Announcements', categoryId: '…' },
};

export default config;
