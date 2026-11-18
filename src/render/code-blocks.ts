// Build-time code-block chrome: every pandoc <pre> ships wrapped in
// .sourceCode > .code-wrap — a head bar (title, language, copy) when either is
// known, a plain card otherwise. Nothing is reconstructed client-side.
import { append, classesOf, dropAttr, element, getAttr, setAttr, SVG_NS, text, type P5Any } from '../core/dom.ts';

const ICON_COPY_D = 'M9 9h10v10H9z M5 15V5h10';
const ICON_CHECK_D = 'M5 12.5l4.5 4.5L19 7.5';

// camelCase classes (numberSource, lineAnchors, …) never survive sanitize-html's LANG_CLASS.
const NON_LANG_CLASSES = new Set(['sourceCode', 'numberLines']);

function svgIcon(d: string, cls?: string): P5Any {
  const svg = element('svg', cls, SVG_NS);
  setAttr(svg, 'viewBox', '0 0 24 24');
  setAttr(svg, 'aria-hidden', 'true');
  const path = element('path', undefined, SVG_NS);
  setAttr(path, 'd', d);
  append(svg, path);
  return svg;
}

function codeLangOf(pre: P5Any): string {
  for (const c of classesOf(pre)) {
    if (!NON_LANG_CLASSES.has(c)) return c;
  }
  return '';
}

function copyButton(withLabel: boolean): P5Any {
  const btn = element('button', 'code-copy');
  setAttr(btn, 'type', 'button');
  setAttr(btn, 'title', 'Copy code');
  append(btn, svgIcon(ICON_COPY_D));
  append(btn, svgIcon(ICON_CHECK_D, 'icon-done'));
  if (withLabel) {
    const btnLabel = element('span', 'code-copy-label');
    text(btnLabel, 'Copy');
    append(btn, btnLabel);
  }
  return btn;
}

// Language-less blocks become `code-plain` cards with a corner copy button.
export function normalizeCodeBlock(pre: P5Any): void {
  const parent = pre.parentNode;
  const kids = parent?.childNodes;
  if (!kids) return;

  const preIsBoxed = parent.nodeName === 'div' && classesOf(parent).includes('sourceCode');
  const lang = codeLangOf(pre);
  // Highlighted blocks carry `title` on the sourceCode div; plain ones on <pre>.
  const title = ((preIsBoxed ? getAttr(parent, 'title') : '') || getAttr(pre, 'title') || '').trim();
  const box = preIsBoxed ? parent : element('div', 'sourceCode');
  if (!lang && !title && !classesOf(box).includes('code-plain')) {
    setAttr(box, 'class', [...classesOf(box), 'code-plain'].join(' '));
  }
  const boxKids = preIsBoxed ? kids : (box.childNodes = [pre]);
  if (!preIsBoxed) {
    box.parentNode = parent;
    kids[kids.indexOf(pre)] = box;
  }

  const wrap = element('div', 'code-wrap');
  if (lang || title) {
    const head = element('div', 'code-head');
    // Symmetric insets: the title centers without shifting the label or copy.
    if (title) {
      const t = element('span', 'code-title');
      text(t, title);
      append(head, t);
      // Consumed; a tooltip repeating the visible title is noise.
      dropAttr(pre, 'title');
      if (preIsBoxed) dropAttr(parent, 'title');
    }
    if (lang) {
      const label = element('span', 'code-lang');
      text(label, lang);
      append(head, label);
    }
    append(head, copyButton(true));
    append(wrap, head);
  } else {
    append(wrap, copyButton(false));
  }
  append(wrap, pre);
  boxKids[boxKids.indexOf(pre)] = wrap;
}
