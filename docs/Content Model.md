---
title: Content model
public: true
description: Nodes, ordering, frontmatter and privacy — how your Markdown tree becomes the page tree
abbrlink: "cb1b852e"
---

The page tree is derived entirely from **filesystem paths**. No parent-child
relationships or ordering are declared inside Markdown; `.md` files stay pure,
and the directory layout is the structure.

# Nodes

A **node** is the merge of a `.md` file and a folder of the same name:

```
node page1  =  page1.md  ∪  page1/
```

The `.md` provides the body, the folder provides children. Either may exist alone:

| Form | Meaning |
|---|---|
| `x.md` only | Leaf page, no children |
| `x/` only | Grouping node: empty body, children render below it |
| `x.md` + `x/` | Standard page: body content and child pages |

`_index.md` inside a directory is the alternative way to give that directory a
body instead of a sibling `x.md`; both are supported and equivalent.

```text
notes/
├── page1.md                  # body of page1
├── page1/                    # children of page1
│   ├── sort.txt              # order of page1's children
│   ├── page1-1.md
│   └── page1-2/              # children can nest further
│       ├── sort.txt
│       └── page1-2-1.md
├── page2.md
└── sort.txt                  # order of root-level nodes
```

# Ordering

Each directory may contain a `sort.txt` listing its **direct child nodes** in
order, one name per line (no `.md` extension). `#` comments and blank lines are
ignored. Ordering is non-recursive: a subdirectory orders itself.

The final order is:

```
declared nodes that exist (in declared order)
  + undeclared nodes, sorted by pinyin, appended as a block at the tail
```

Fault tolerance is deliberate — writing should never block publishing:

- A declared name that does not exist → a warning, the build continues.
- No `sort.txt` → the whole directory sorts by pinyin.
- Pinyin ordering uses `Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })`,
  so `page2` precedes `page10` and case or accents never reorder anything.
  (Latin text falls back to the same collation's default ordering.)

# Collection rules

- Only `.md` files and directories form nodes; `sort.txt` and anything else is
  ignored.
- Hidden entries (starting with `.`) are skipped — use them for drafts.
- A `.md` file and a folder sharing a name merge into one node.
- Names are case-sensitive, matching the filesystem.

# Front matter

```yaml
---
title: Docker practice notes
public: true
description: optional page description for cards and the feed
abbrlink: "796542b0"   # assigned on first build, never change it by hand
date: 2026-09-12       # optional; enables archives, feed and the date display
tags: [docker, ops]
---
```

- `public: true` is what publishes a note. Everything else stays private and
  never enters the output — not the page, its attachments, its search entry, nor
  its title.
- `abbrlink` is written back once and pins the note's URL forever, surviving
  renames and reorganizations.
- `date` is optional; only dated notes enter archives and the RSS feed.
  `updated` shows a separate "updated" line when it differs from the date.
- Links between notes use relative Markdown paths; the build rewrites them to
  stable `/posts/<abbrlink>` URLs and fails on any broken one.
- `title` is the page title, so the body doesn't need an H1 of its own: headings
  inside the note start at `#` and read as the page's own outline.

# Privacy

Privacy works by **physical exclusion**: private content is never built, so it
cannot leak through search, feeds, archives or the sitemap.

- A node is public only when its frontmatter says `public: true`.
- A private parent keeps its whole subtree private, regardless of a child's own
  flag.
- A public page referencing a private attachment is downgraded to plain text
  rather than shipping a link to a file that is not there.
- The build is fail-closed: any private-content probe found in the output aborts
  the build.

See [Markdown syntax](./Syntax.md) for every supported construct, with source
and rendering side by side.