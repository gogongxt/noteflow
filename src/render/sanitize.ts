// The security boundary for everything pandoc emits: an output-side allowlist
// (notes rely on raw HTML, so parsing cannot be disabled). Anything not listed
// is silently dropped, so a new Markdown extension needs an entry and a test.
import sanitizeHtml from 'sanitize-html';
import { BITMAP_DATA_MIMES } from '../core/util.ts';

// Compiled once — transformTags runs it for every img of every page.
const DATA_URI_IMG_OK = new RegExp(`^data:(?:${[...BITMAP_DATA_MIMES, 'image/x-icon'].join('|')});base64,[a-z0-9+/=\\s]+$`, 'i');

const TAGS = [
  'p', 'br', 'hr', 'div', 'span', 'section',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'a', 'img', 'figure', 'figcaption',
  'b', 'i', 'em', 'strong', 'del', 's', 'sup', 'sub', 'kbd', 'mark', 'u', 'small', 'q', 'cite', 'abbr',
  'code', 'pre', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'colgroup', 'col',
  'details', 'summary', 'label', 'input',
  // Native media only (media-src falls back to default-src 'self'). autoplay
  // and crossorigin are not whitelisted, so playback waits for the user.
  'audio', 'video', 'source', 'track',
  'math', 'semantics', 'annotation', 'mrow', 'mi', 'mn', 'mo', 'ms', 'mtext', 'msup', 'msub', 'msubsup',
  'mfrac', 'msqrt', 'mroot', 'mspace', 'mstyle', 'mtable', 'mtr', 'mtd', 'munder', 'mover', 'munderover',
  'mphantom', 'mpadded', 'menclose', 'merror', 'mfenced', 'mstack', 'mlongdiv', 'mglyph',
  // Widget channel (see WIDGET_SRC); transformTags reduces 'script' to a
  // relative .js src before it can reach the output.
  'script', 'link',
];

const CLASSES = [
  // Only appears on pandoc's fallback span for math texmath could not parse.
  'math',
  'level1', 'level2', 'level3', 'level4', 'level5', 'level6',
  'sourceCode', 'numberLines', 'lineAnchors', 'lineNumbers',
  'task-list', 'callout', 'footnotes', 'footnote-ref', 'footnote-back', 'column', 'columns',
  'tabs', 'tab',
  // [text](url){.link-preview}: survives sanitize as a plain link; the build
  // later expands it into a link card (src/render/link-preview.ts).
  'link-preview',
  // [url](…){.embed}: expanded at build time into the provider iframe.
  'embed', 'embed-fallback',
  'demo',
  'alert', 'title',
  'mermaid', 'language-mermaid', 'lang-mermaid', 'mermaid-source',
  'note', 'tip', 'warning', 'important', 'caution', 'danger', 'success', 'info',
  'emoji',
  'accent',
  'annotation', 'at', 'bn', 'bu', 'cf', 'ch', 'cn', 'co', 'cv', 'do',
  'dt', 'dv', 'er', 'ex', 'fl', 'fu', 'im', 'in', 'kw', 'op', 'ot', 'pp', 'sc', 'ss', 'st', 'va', 'vs', 'wa',
];

const LANG_CLASS = /^[a-z][a-z0-9_+-]*$/;
// Widget mounts live in the `w-` namespace, so a note's own widget needs no
// per-widget whitelist entry and `grep w-` finds every hook on the site.
const WIDGET_CLASS = /^w-[a-z0-9-]+$/;

// The widget channel (owner decision 2026-11-21): a note may load code shipped
// next to itself. Exactly two forms pass — a src-only <script> with a relative
// .js path, and <link rel="stylesheet"> with a relative .css path. postprocess
// rewrites them to hashed same-origin /assets/ URLs, which CSP already allows.
const WIDGET_SRC = /^[a-z0-9][a-z0-9._\/ -]*\.(js|css)$/i;
const widgetRefOk = (value: string | undefined, ext: 'js' | 'css'): boolean => {
  if (!value) return false;
  // `./` prefixes are the house style (./media/demo.webm); strip them, then
  // any surviving dot-starting segment is a `../` escape or a dotfile.
  const bare = value.replace(/^(\.\/)+/, '');
  if (!bare.toLowerCase().endsWith('.' + ext)) return false;
  if (!WIDGET_SRC.test(bare)) return false;
  return !bare.split('/').some((seg) => seg.startsWith('.'));
};

const MATH_ATTRS = [
  'xmlns', 'display', 'encoding', 'href', 'mathvariant', 'mathsize', 'stretchy', 'fence',
  'separator', 'notation', 'accent', 'accentunder', 'columnalign', 'rowspacing', 'columnspacing',
  'linethickness', 'scriptlevel', 'largeop', 'movablelimits', 'form', 'lspace', 'rspace', 'depth', 'alttext',
];

// Keys are CSS selectors, not property names; an attribute name silently
// selects no rule and filters nothing.
const ALLOWED_STYLES = {
  '*': {
    color: [/^#[0-9a-f]{3,8}$/i, /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/i, /^[a-z]{3,20}$/i],
    'background-color': [/^#[0-9a-f]{3,8}$/i, /^[a-z]{3,20}$/i],
    'text-align': [/^(left|right|center|justify)$/i],
    'font-weight': [/^(normal|bold|[1-9]00)$/],
    'font-style': [/^(normal|italic|oblique)$/],
    'text-decoration': [/^(underline|line-through|none)$/],
  },
  // pandoc emits `style="width:50.0%"` for ![x](img.png){width=50%}; without a
  // rule here the whitelist silently drops it (the documented trap).
  img: {
    width: [/^\d+(\.\d+)?(px|em|rem|%)$/i],
    height: [/^\d+(\.\d+)?(px|em|rem|%)$/i],
  },
} as Record<string, Record<string, RegExp[]>>;

type Attribs = Record<string, string>;
type TransformFn = (tagName: string, attribs: Attribs) => { tagName: string; attribs: Attribs };

export const SANITIZE_OPTIONS = {
  allowedTags: TAGS,
  allowedAttributes: {
    '*': ['id', 'class', 'title', 'dir', 'lang', 'style', 'role', 'aria-label', 'data-emoji', ...MATH_ATTRS],
    a: ['href', 'title', 'id', 'class', 'name', 'rel'],
    img: ['src', 'alt', 'width', 'height', 'style', 'title', 'loading', 'decoding', 'data-inline'],
    input: ['type', 'checked', 'disabled'],
    video: ['src', 'poster', 'width', 'height', 'controls', 'preload', 'loop', 'muted', 'playsinline'],
    audio: ['src', 'controls', 'preload', 'loop', 'muted'],
    source: ['src', 'type'],
    track: ['src', 'kind', 'srclang', 'label', 'default'],
    code: ['class', 'id'],
    // A fence's `title` becomes the code block's centered header.
    pre: ['class', 'id', 'title'],
    div: ['class', 'id', 'data-note', 'data-icon', 'data-title', 'data-mermaid-key', 'style'],
    th: ['class', 'id', 'style', 'colspan', 'rowspan', 'scope'],
    td: ['class', 'id', 'style', 'colspan', 'rowspan'],
    col: ['span', 'style'],
    colgroup: ['span', 'style'],
    ol: ['start', 'type'],
    details: ['open'],
    li: ['value'],
    math: ['xmlns', 'display'],
    annotation: ['encoding'],
    script: ['src', 'defer'],
    link: ['rel', 'href'],
  } as Record<string, string[]>,
  allowedClasses: {
    '*': [...CLASSES, 'mermaid-host', WIDGET_CLASS],
    pre: [...CLASSES, LANG_CLASS],
    code: [...CLASSES, LANG_CLASS],
  },
  allowedStyles: ALLOWED_STYLES,
  transformTags: {
    input: ((_tagName: string, attribs: Attribs) => {
      if (attribs.type !== 'checkbox') return { tagName: 'span', attribs: {} };
      const a: Attribs = { type: 'checkbox' };
      if ('checked' in attribs) a.checked = 'checked';
      a.disabled = 'disabled';
      return { tagName: 'input', attribs: a };
    }) as TransformFn,
    img: ((tagName: string, attribs: Attribs) => {
      const src = attribs.src || '';
      if (/^\s*data:/i.test(src) && !DATA_URI_IMG_OK.test(src)) {
        delete attribs.src;
      }
      return { tagName, attribs };
    }) as TransformFn,
    a: ((tagName: string, attribs: Attribs) => {
      if (attribs.href && /^\s*\/\//.test(attribs.href)) delete attribs.href;
      return { tagName, attribs };
    }) as TransformFn,
    // Widget channel gates: keep exactly src (+defer) / rel+href, or degrade
    // to a plain span — an inline body then appears as escaped text
    // (fail-visible beats fail-invisible).
    script: ((tagName: string, attribs: Attribs) => {
      if (widgetRefOk(attribs.src, 'js')) {
        const a: Attribs = { src: attribs.src };
        if (attribs.defer !== undefined) a.defer = '';
        return { tagName, attribs: a };
      }
      return { tagName: 'span', attribs: {} };
    }) as TransformFn,
    link: ((tagName: string, attribs: Attribs) => {
      if ((attribs.rel || '') === 'stylesheet' && widgetRefOk(attribs.href, 'css')) {
        return { tagName, attribs: { rel: 'stylesheet', href: attribs.href } };
      }
      return { tagName: 'span', attribs: {} };
    }) as TransformFn,
  },
  // 'script' in allowedTags trips the library's warning; the transform above
  // has already reduced it to a relative .js filename.
  allowVulnerableTags: true,
  allowedSchemes: ['http', 'https', 'mailto', 'tel', 'ftp'],
  // img may inline small bitmaps as data: URIs (the transformTags rule above
  // whitelists the exact mimes).
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowProtocolRelative: false,
  nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'xmp', 'iframe', 'object', 'embed'],
};

export function sanitize(fragment: string): string {
  return sanitizeHtml(fragment, SANITIZE_OPTIONS as sanitizeHtml.IOptions);
}
