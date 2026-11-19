// Display-math numbering and \ref/\label resolution. texmath drops \label and
// \tag but keeps the TeX in the MathML annotation, so both are recovered from
// there; every unresolvable ref fails the build.
import { append, classesOf, element, getAttr, replaceNode, replaceWithText, setAttr, SKIP, text, textOf, walk, type P5Any } from '../core/dom.ts';
import type { PostprocessCtx } from './postprocess-types.ts';
import { reportBroken } from './broken.ts';

/** Wrap display math in a numbered `.equation` span; `\label{k}` becomes
 *  id="eq-k", `\tag{x}` overrides the shown number. Returns label → number. */
export function numberEquations(root: P5Any, ctx: PostprocessCtx): Map<string, string> {
  const labels = new Map<string, string>();
  const ids = new Set<string>();
  walk(root, (node) => {
    const id = getAttr(node, 'id');
    if (id) ids.add(id);
    return undefined;
  });

  let n = 0;
  walk(root, (node) => {
    if (node.nodeName !== 'math' || getAttr(node, 'display') !== 'block') return undefined;
    const parent = node.parentNode;
    if (!parent?.childNodes) return undefined;
    n += 1;
    const tex = texOf(node);
    const tag = /\\(?:tag|tag\*)\s*\{([^}]*)\}/.exec(tex)?.[1].trim() ?? '';
    if (tag && !/^[0-9A-Za-z.*-]+$/.test(tag)) {
      ctx.onBroken?.({ relPath: ctx.pageRelPath, msg: `unsupported \\tag{${tag}}: only plain numbers or short labels (equation ${n})` });
      return SKIP;
    }
    const shown = tag || String(n);
    const wrap = element('span', 'equation');
    const no = element('span', 'eq-no');
    text(no, `(${shown})`);
    append(wrap, node);
    append(wrap, no);
    wrap.parentNode = parent;
    parent.childNodes[parent.childNodes.indexOf(node)] = wrap;

    const found = [...tex.matchAll(EQ_LABEL)].map((m) => m[1].trim());
    if (found.length > 1) {
      ctx.onBroken?.({ relPath: ctx.pageRelPath, msg: `several \\label on one equation: ${found.join(', ')} (equation ${n})` });
      return SKIP;
    }
    const label = found[0];
    if (label == null) return SKIP;
    const id = `eq-${label}`;
    if (!EQ_LABEL_OK.test(label)) ctx.onBroken?.({ relPath: ctx.pageRelPath, msg: `invalid math label: \\label{${label}}` });
    else if (labels.has(label)) ctx.onBroken?.({ relPath: ctx.pageRelPath, msg: `duplicate math label: \\label{${label}} (equations ${labels.get(label)} and ${n})` });
    else if (ids.has(id)) ctx.onBroken?.({ relPath: ctx.pageRelPath, msg: `math label collides with an existing id: ${id}` });
    else {
      labels.set(label, shown);
      setAttr(wrap, 'id', id);
    }
    return SKIP;
  });
  return labels;
}

const EQ_REF = /^\$+\s*\\(eq)?ref\s*\{([^}]*)\}\s*\$+$/;
const EQ_LABEL = /\\label\s*\{([^}]*)\}/g;
const EQ_LABEL_OK = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function texOf(math: P5Any): string {
  let ann: P5Any | undefined;
  walk(math, (n) => {
    if (ann) return SKIP;
    if (n.nodeName === 'annotation' && getAttr(n, 'encoding') === 'application/x-tex') ann = n;
    return undefined;
  });
  return (ann?.childNodes ?? []).map((c) => c.value ?? '').join('');
}

/** texmath rejects \ref/\eqref, so pandoc leaves `span.math` holding raw TeX;
 *  convert it to a link with the target's number (\eqref keeps parentheses). */
export function rewriteMathRefs(root: P5Any, labels: ReadonlyMap<string, string>, ctx: PostprocessCtx): void {
  walk(root, (node) => {
    if (node.nodeName !== 'span' || !classesOf(node).includes('math')) return undefined;
    const raw = textOf(node);
    const m = EQ_REF.exec(raw);
    if (!m) {
      if (!/\\(?:eq)?ref\s*\{/.test(raw)) return undefined;
      reportBroken(ctx, `\\ref inside a formula pandoc cannot parse; put it in its own $...$: ${raw.slice(0, 80)}`, node);
      replaceWithText(node, '(math error)');
      return SKIP;
    }
    const [, parens, label] = m;
    const num = labels.get(label.trim());
    if (!num) {
      reportBroken(ctx, `\\ref target not found on this page: ${raw}`, node);
      replaceWithText(node, parens ? '(??)' : '??');
      return SKIP;
    }
    const a = element('a', 'eq-ref');
    setAttr(a, 'href', `#eq-${encodeURIComponent(label.trim())}`);
    text(a, parens ? `(${num})` : num);
    replaceNode(node, a);
    return SKIP;
  });
}

/** A literal `\ref` in text means pandoc left the formula unparsed (e.g.
 *  `$ \ref{a} $` with inner spaces); fail the build rather than ship raw TeX. */
export function assertNoRawRefs(root: P5Any, ctx: PostprocessCtx): void {
  walk(root, (node) => {
    const raw = node.value ?? '';
    if (node.nodeName !== '#text' || !/\\(?:eq)?ref\s*\{/.test(raw)) return undefined;
    for (let cur = node.parentNode; cur; cur = cur.parentNode) {
      if (cur.nodeName === 'pre' || cur.nodeName === 'code') return undefined; // sample source
    }
    reportBroken(ctx, `unrendered \\ref in body text: ${raw.trim().slice(0, 80)}`, node);
    return undefined;
  });
}
