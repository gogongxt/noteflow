---
title: noteflow
public: true
description: A pandoc-powered static site builder for a personal knowledge base
abbrlink: "26b90233"
---

A static site builder for a personal knowledge base — write Markdown in your own git repository, publish only what you mark public.

You keep everything — drafts, private notes, published posts — in one Markdown tree under version control. noteflow turns that tree into a fast static site:

- **Directory tree = sidebar.** `x.md` beside an `x/` directory is the standard page-with-children form; `_index.md` customizes a directory's landing page; `sort.txt` pins ordering.
- **Privacy by physical exclusion.** Only notes with `public: true` are built; everything else (and its attachments) never enters `dist/`. Private content cannot leak through search, feeds, or archives because it is simply not there.
- **Stable URLs.** Every note gets a CRC32-based `abbrlink` written back into its frontmatter once; the URL `/posts/<abbrlink>` then survives renames and reorganization.
- **pandoc-powered Markdown.** A long-lived `pandoc server` converts content; the Node side does link rewriting, sanitizing, and template rendering. Mermaid diagrams are pre-rendered in headless Chromium at build time; audio and video use native `<audio>`/`<video>` with content-addressed attachments, so no player library is needed under strict CSP.
- **Security-first output.** Strict CSP (no inline scripts/styles except build-time sha256-hashed ones), no CDN, no external fonts, fail-closed builds (broken links and private-content leaks abort the build). The local preview serves the exact same security headers as production nginx.

Start with [Getting Started](./Getting%20Started.md), or read [Content model](./Content%20Model.md) for the directory, ordering and privacy conventions.
