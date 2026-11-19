---
title: Getting Started
public: true
description: Install, build, and preview your first NoteFlow site
abbrlink: "b0cf200a"
---

# Requirements

- **Node.js ≥ 22.18** (TypeScript runs on Node's native type stripping — no build step)
- **pandoc ≥ 3.0** with server support (`pandoc --version | grep server`)
- Headless Chromium, optional — only needed when content contains mermaid diagrams (`npx playwright-core install chromium`)

# First build

```bash
git clone https://github.com/gogongxt/noteflow.git
cd noteflow
npm install

./start.sh doctor     # check node / pandoc / content
./start.sh build      # build to dist/
./start.sh serve      # local preview at http://localhost:7060
```

Without a content directory of your own, the build falls back to `docs/` — this documentation tree, which doubles as the demo. Point `contentDir` in `site.config.mjs` at your own tree (a separate private repository, typically) to build the real site.

`./start.sh watch` rebuilds and re-previews while you edit; `./start.sh check` is the CI mode that never writes back missing abbrlinks.

# This documentation site

The docs you are reading are themselves built by NoteFlow and deployed to GitHub Pages under the repository's sub-path — see [Deployment](./Deployment.md).
