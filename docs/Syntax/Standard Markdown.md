---
title: Standard Markdown
public: true
description: Inline formatting, headings, lists, tables, code, math, links — the everyday syntax
abbrlink: "c182255e"
---

The everyday Markdown syntax. Everything here is ordinary pandoc Markdown; the
[next page](./Features.md) covers what noteflow adds on top.

## Inline formatting

::: {.demo}
````markdown
**Bold**, *italic*, ***bold italic***, ~~strikethrough~~
`inline code`, ==highlighted==, H~2~O, x^2^
Underline with HTML: <u>underlined text</u>
````
**Bold**, *italic*, ***bold italic***, ~~strikethrough~~
`inline code`, ==highlighted==, H~2~O, x^2^
Underline with HTML: <u>underlined text</u>
:::

Smart punctuation (with `smart` on): typing `"quotes"`, `---`, `...` becomes
curly quotes, an em dash and an ellipsis.

Emoji shorts are converted too:

::: {.demo}
````markdown
:sparkles: :rocket: :warning: :memo:
````
:sparkles: :rocket: :warning: :memo:
:::

(Wrapping in backticks keeps it literal: `:sparkles:`)

## Headings and anchors

pandoc generates an `id` for every heading. Mixed-script headings get stable
anchors too.

### Custom ids and classes

::: {.demo}
````markdown
## A heading with a custom anchor {#my-anchor .accent}
````
## A heading with a custom anchor {#my-anchor .accent}
:::

`{#my-anchor}` overrides the auto id; `{.accent}` adds a class (styled in the
theme).

## Lists

::: {.demo}
````markdown
- An unordered list
  - one level in
    - and another level
- Another item

1. An ordered list
2. Second item
   - a mixed-in child

- [x] A completed task
- [ ] An open task
````
- An unordered list
  - one level in
    - and another level
- Another item

1. An ordered list
2. Second item
   - a mixed-in child

- [x] A completed task
- [ ] An open task
:::

## Blockquotes

::: {.demo}
````markdown
> An ordinary quote. It can span several lines,
> and hold a list inside:
>
> - First point
> - Second point
>
> — the attribution
````
> An ordinary quote. It can span several lines,
> and hold a list inside:
>
> - First point
> - Second point
>
> — the attribution
:::

## Tables

::: {.demo}
````markdown
| Left | Center | Right |
|:-----|:------:|------:|
| a    | b      | 1,234 |
| c    | d      | 5,678 |

: The table caption is the colon line under the table
````
| Left | Center | Right |
|:-----|:------:|------:|
| a    | b      | 1,234 |
| c    | d      | 5,678 |

: The table caption is the colon line under the table
:::

## Code blocks

Fenced code with a language tag is syntax-highlighted, with a copy button in the
corner.

::: {.demo}
````markdown
```js
const collator = new Intl.Collator('en', { numeric: true });
list.sort(collator.compare);
```
````
```js
const collator = new Intl.Collator('en', { numeric: true });
list.sort(collator.compare);
```
:::

Attributes work too: ```` ```{#my-code .numberLines} ```` shows line numbers.

::: {.demo}
````markdown
```python {.numberLines}
def greet(name):
    return f"Hello, {name}"
```
````
```python {.numberLines}
def greet(name):
    return f"Hello, {name}"
```
:::

A fence without a language (or with one the highlighter does not know) has no
highlighting, but the same frame and copy button:

::: {.demo}
````markdown
```
docker run --rm -it alpine sh
```
````
```
docker run --rm -it alpine sh
```
:::

Four leading spaces also make a code block, identical to a language-less fence:

::: {.demo}
````markdown
    const indented = () => {
        console.log('created by a four-space indent');
    };
````
    const indented = () => {
        console.log('created by a four-space indent');
    };
:::

Indented code works inside list items too (four spaces beyond the list content
column):

::: {.demo}
````markdown
- Step one: stage the changes

      git add .

- Step two: commit

      git commit -m "update"
````
- Step one: stage the changes

      git add .

- Step two: commit

      git commit -m "update"
:::

## Mathematics

Inline math uses `$...$`, display math `$$...$$`; the output is standard MathML.

::: {.demo}
````markdown
Inline mass–energy $E = mc^2$, and a display integral:

$$
\int_{0}^{1} x^2 \, dx = \frac{1}{3}
$$
````
Inline mass–energy $E = mc^2$, and a display integral:

$$
\int_{0}^{1} x^2 \, dx = \frac{1}{3}
$$
:::

Equations can carry a `\label`, referenced with `\ref` / `\eqref` (same page
only: texmath does not know either command, so the build adds ids and links
while numbering). `\tag{…}` overrides the displayed number; the counter still
advances:

::: {.demo}
````markdown
The mass–energy relation is $\ref{emc}$, that is $\eqref{emc}$.

$$
E = mc^2 \label{emc}
$$

$$
F = ma \tag{7}
$$
````
The mass–energy relation is $\ref{emc}$, that is $\eqref{emc}$.

$$
E = mc^2 \label{emc}
$$

$$
F = ma \tag{7}
$$
:::

## Links

::: {.demo}
````markdown
- Internal link: [Getting Started](../Getting%20Started.md)
- Internal link with an anchor: [the Pages anchor](../Deployment.md#github-pages)
- External link: [pandoc](https://pandoc.org)
- Bare link: https://example.com is autolinked
- Reference link: [pandoc][pd]; the definition can live anywhere in the file
````
- Internal link: [Getting Started](../Getting%20Started.md)
- Internal link with an anchor: [the Pages anchor](../Deployment.md#github-pages)
- External link: [pandoc](https://pandoc.org)
- Bare link: https://example.com is autolinked
- Reference link: [pandoc][pd]; the definition can live anywhere in the file
:::

[pd]: https://pandoc.org "the pandoc site"

## Footnotes

::: {.demo}
````markdown
The mass–energy relation follows from special relativity.[^1]

[^1]: From the 1905 paper "On the Electrodynamics of Moving Bodies".
````
The mass–energy relation follows from special relativity.[^1]

[^1]: From the 1905 paper "On the Electrodynamics of Moving Bodies".
:::

## Definition lists

::: {.demo}
````markdown
Term
:   Its explanation, possibly several paragraphs long.

Second term
:   Its explanation.
````
Term
:   Its explanation, possibly several paragraphs long.

Second term
:   Its explanation.
:::

## Collapsible blocks and raw HTML

HTML is allowed by default; `<details>` is the common way to collapse content:

::: {.demo}
````markdown
<details>
<summary>Click to expand</summary>

The collapsed content lives here; it can use **Markdown**, but needs a blank
line after `<summary>`.

</details>
````
<details>
<summary>Click to expand</summary>

The collapsed content lives here; it can use **Markdown**, but needs a blank
line after `<summary>`.

</details>
:::

## Rules and escaping

::: {.demo}
````markdown
Three hyphens make a rule:

---

To print a literal, escape with a backslash: \*not italic\*, \`not code\`, and
a price of \$5.
````
Three hyphens make a rule:

---

To print a literal, escape with a backslash: \*not italic\*, \`not code\`, and
a price of \$5.
:::

## Unsupported or degraded constructs

| Construct | Result |
|---|---|
| A link to a private page | Replaced with "private page", never a dead link |
| An image in a private directory | Replaced with "private image" |
| `\LaTeX` macros | `raw_tex` is off, so they show as literal text |
| A raw attribute `{=html}` | `raw_attribute` is off, so it shows as literal text |
| Auto-wrapping a lone image in `<figure>` | `implicit_figures` is off; images keep inline semantics |