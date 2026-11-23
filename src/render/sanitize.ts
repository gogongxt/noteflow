// The security boundary for everything pandoc emits: an output-side allowlist
// (notes rely on raw HTML, so parsing cannot be disabled). Anything not listed
// is silently dropped, so a new Markdown extension needs an entry and a test.
import sanitizeHtml from 'sanitize-html';
import { BITMAP_DATA_MIMES } from '../core/util.ts';

// Compiled once — transformTags runs it for every img of every page.
const DATA_URI_IMG_OK = new RegExp(`^data:(?:${[...BITMAP_DATA_MIMES, 'image/x-icon'].join('|')});base64,[a-z0-9+/=\\s]+$`, 'i');

// Inline interactive HTML — the second channel: a note may write <style>, an
// inline <script>, and the elements a UI needs (buttons, SVG, canvas, form
// controls) straight into its Markdown. The build hashes every inline
// script/style/handler into the CSP, so what ships runs exactly as written,
// and nothing else does. `eval` stays blocked (no 'unsafe-eval'); a style value
// that fetches or executes is refused by postprocess (see css-safety.ts).
const SVG_TAGS = [
  'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'defs', 'lineargradient', 'radialgradient', 'stop', 'use', 'symbol',
  'marker', 'clippath', 'mask', 'pattern', 'title', 'desc', 'filter', 'fegaussianblur',
  'feoffset', 'femerge', 'femergenode', 'fecomposite', 'feblend', 'feflood',
  // SMIL animation (tag names lowercase here; parse5 restores animateMotion/
  // animateTransform casing on output).
  'animate', 'animatemotion', 'animatetransform',
];

const MATH_TAGS = [
  'math', 'semantics', 'annotation', 'mrow', 'mi', 'mn', 'mo', 'ms', 'mtext', 'msup', 'msub', 'msubsup',
  'mfrac', 'msqrt', 'mroot', 'mspace', 'mstyle', 'mtable', 'mtr', 'mtd', 'munder', 'mover', 'munderover',
  'mphantom', 'mpadded', 'menclose', 'merror', 'mfenced', 'mstack', 'mlongdiv', 'mglyph',
];

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
  ...MATH_TAGS,
  // Channel 2: interactive HTML written in the note.
  'style', 'button', 'select', 'option', 'optgroup', 'textarea', 'dialog', 'canvas',
  'progress', 'meter', 'output',
  ...SVG_TAGS,
  // Widget channel (WIDGET_SRC): a src-only script. The transform below keeps
  // an inline body too and hands its bytes to postprocess for the CSP hash.
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
// Channel-2 class hooks: any CSS-identifier-shaped name. sanitize-html tests
// each class name whole, so this can never match a selector.
const CSS_IDENT_CLASS = /^[A-Za-z_][A-Za-z0-9_-]*$/;
// Widget mounts live in the `w-` namespace, so a note's own widget needs no
// per-widget whitelist entry and `grep w-` finds every hook on the site.
const WIDGET_CLASS = /^w-[a-z0-9-]+$/;

// The widget channel: a note may load code shipped next to itself. Exactly two
// forms pass — a src-only <script> with a relative .js path, and
// <link rel="stylesheet"> with a relative .css path. postprocess rewrites them
// to hashed same-origin /assets/ URLs, which CSP already allows.
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

// A <script> type the browser does not execute as script: inert data blocks
// (JSON-LD, importmap). type="module" is dropped — module bodies would need
// their own import resolution and are not part of this channel.
export const INERT_SCRIPT_TYPE = /^(?:application\/(?:ld\+)?json|importmap|text\/plain)$/i;

// Event-handler attributes: `on*` in the allowlist (a name no browser knows is
// inert), and this shape when a value is hashed for the CSP. A static list
// would go stale as browsers add events — the hash only ever permits the bytes
// it covers, so a name that never fires costs nothing.
export const HANDLER_ATTR = /^on[a-z]+$/;

// SVG presentation + geometry + SMIL attributes (lowercase: htmlparser2 hands
// them to sanitize-html downcased; parse5 restores the camelCase on output).
const SVG_ATTRS = [
  'viewbox', 'preserveaspectratio', 'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity',
  'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'points',
  'transform', 'transform-origin', 'opacity', 'offset', 'stop-color', 'stop-opacity', 'gradientunits',
  'gradienttransform', 'fx', 'fy', 'spreadmethod', 'href', 'xlink:href', 'clip-path', 'clip-rule',
  'mask', 'filter', 'stddeviation', 'dx', 'dy', 'in', 'in2', 'result', 'mode', 'type',
  'values', 'dur', 'begin', 'end', 'repeatcount', 'keytimes', 'calcmode', 'keysplines', 'attributename',
  'from', 'to', 'by', 'text-anchor', 'font-size', 'font-family', 'font-weight', 'dominant-baseline',
];

const MATH_ATTRS = [
  'xmlns', 'display', 'encoding', 'href', 'mathvariant', 'mathsize', 'stretchy', 'fence',
  'separator', 'notation', 'accent', 'accentunder', 'columnalign', 'rowspacing', 'columnspacing',
  'linethickness', 'scriptlevel', 'largeop', 'movablelimits', 'form', 'lspace', 'rspace', 'depth',
  'alttext', 'width', 'height',
];

// Attributes every element may carry. Style values are guarded by postprocess
// (a hashed style attribute that fetches or executes would defeat the point).
const UNIVERSAL_ATTRS = [
  'id', 'class', 'title', 'dir', 'lang', 'style', 'role', 'on*',
  // Channel-2 extension points: data hooks for the note's own script, and the
  // ARIA names a custom control needs (`aria-*` also covers aria-label).
  'data-*', 'aria-*',
];

/** Per-tag extras. A tag's list is OR-ed with '*', so it only adds names. */
const ATTRIBUTES: Record<string, string[]> = {
  '*': UNIVERSAL_ATTRS,
  a: ['href', 'name', 'rel', 'download'],
  // pandoc emits `{width=50%}` as a style rule; postprocess guard applies.
  img: ['src', 'alt', 'width', 'height', 'loading', 'decoding'],
  // Free-form controls. `checked`/`disabled` are attributes, not values, so an
  // authored checkbox stays live; postprocess only disables a task-list's own.
  input: ['type', 'checked', 'disabled', 'value', 'name', 'placeholder', 'min', 'max', 'step',
    'minlength', 'maxlength', 'pattern', 'readonly', 'required', 'multiple', 'accept', 'list'],
  button: ['type', 'name', 'value', 'disabled'],
  select: ['name', 'disabled', 'multiple', 'size', 'required'],
  option: ['value', 'label', 'selected', 'disabled'],
  optgroup: ['label', 'disabled'],
  textarea: ['name', 'disabled', 'rows', 'cols', 'placeholder', 'readonly', 'required',
    'minlength', 'maxlength', 'wrap'],
  label: ['for'],
  dialog: ['open'],
  canvas: ['width', 'height'],
  progress: ['value', 'max'],
  meter: ['value', 'min', 'max', 'low', 'high', 'optimum'],
  output: ['name', 'for'],
  video: ['src', 'poster', 'width', 'height', 'controls', 'preload', 'loop', 'muted', 'playsinline'],
  audio: ['src', 'controls', 'preload', 'loop', 'muted'],
  source: ['src', 'type'],
  track: ['src', 'kind', 'srclang', 'label', 'default'],
  th: ['colspan', 'rowspan', 'scope'],
  td: ['colspan', 'rowspan'],
  col: ['span'],
  colgroup: ['span'],
  ol: ['start', 'type'],
  details: ['open'],
  li: ['value'],
  // A src script (widget channel) or an inline body (channel 2); the transform
  // below keeps exactly one of those forms.
  script: ['src', 'defer', 'type'],
  link: ['rel', 'href'],
};

// MathML and SVG attributes belong to their subtrees, not to every element.
for (const tag of MATH_TAGS) ATTRIBUTES[tag] = MATH_ATTRS;
for (const tag of SVG_TAGS) ATTRIBUTES[tag] = SVG_ATTRS;

type Attribs = Record<string, string>;
type TransformFn = (tagName: string, attribs: Attribs) => { tagName: string; attribs: Attribs };

export const SANITIZE_OPTIONS = {
  allowedTags: TAGS,
  allowedAttributes: ATTRIBUTES as Record<string, string[]>,
  allowedClasses: {
    // Channel 2 writes ordinary class names (.viz, .chart, .step); a class is
    // only a selector hook, so any CSS-identifier-shaped name is admitted.
    '*': [...CLASSES, 'mermaid-host', WIDGET_CLASS, CSS_IDENT_CLASS],
    pre: [...CLASSES, LANG_CLASS],
    code: [...CLASSES, LANG_CLASS],
  },
  transformTags: {
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
    // A relative src is the widget channel (rewritten to a hashed /assets/
    // URL); a src-less body is channel 2 — kept verbatim, its bytes hashed
    // into the CSP. Anything else degrades to a span.
    script: ((tagName: string, attribs: Attribs) => {
      const type = (attribs.type || '').trim();
      if (widgetRefOk(attribs.src, 'js')) {
        const a: Attribs = { src: attribs.src };
        if (attribs.defer !== undefined) a.defer = '';
        if (type) a.type = type;
        return { tagName, attribs: a };
      }
      if (attribs.src) return { tagName: 'span', attribs: {} };
      if (type && !INERT_SCRIPT_TYPE.test(type)) return { tagName: 'span', attribs: {} };
      // JSON-LD / importmap survive as inert data; a bare body is live code.
      const a: Attribs = {};
      if (type) a.type = type;
      return { tagName, attribs: a };
    }) as TransformFn,
    link: ((tagName: string, attribs: Attribs) => {
      if ((attribs.rel || '') === 'stylesheet' && widgetRefOk(attribs.href, 'css')) {
        return { tagName, attribs: { rel: 'stylesheet', href: attribs.href } };
      }
      return { tagName: 'span', attribs: {} };
    }) as TransformFn,
  },
  // 'script' in allowedTags trips the library's warning; the transform leaves
  // only a relative .js reference or an inline body.
  allowVulnerableTags: true,
  allowedSchemes: ['http', 'https', 'mailto', 'tel', 'ftp'],
  // img may inline small bitmaps as data: URIs (the transformTags rule above
  // whitelists the exact mimes).
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowProtocolRelative: false,
  // Style values pass through as written: the CSP hash covers those exact
  // bytes, and postprocess refuses a value that fetches or executes.
  parseStyleAttributes: false,
  nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'xmp', 'iframe', 'object', 'embed'],
};

export function sanitize(fragment: string): string {
  return sanitizeHtml(fragment, SANITIZE_OPTIONS as sanitizeHtml.IOptions);
}