// A minimal parse5 tree model and traversal helpers, shared by every module
// that rewrites or inspects pandoc output. Values are plain mutable objects:
// parse5 accepts them back via serialize() as a fragment.
export type P5Any = {
  nodeName: string;
  tagName?: string;
  namespaceURI?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: P5Any[];
  parentNode?: P5Any | null;
  value?: string;
};

export const HTML_NS = 'http://www.w3.org/1999/xhtml';
export const SVG_NS = 'http://www.w3.org/2000/svg';

/** Returned from a walk callback to skip a node's children. */
export const SKIP = Symbol('skip');

/** Depth-first walk. Children added during the walk are not visited (snapshot). */
export function walk(node: P5Any, cb: (n: P5Any) => unknown): void {
  if (cb(node) === SKIP || !node.childNodes) return;
  for (const child of [...node.childNodes]) walk(child, cb);
}

export function getAttr(node: P5Any, name: string): string | undefined {
  return node.attrs?.find((a) => a.name === name)?.value;
}

export function setAttr(node: P5Any, name: string, value: string): void {
  if (!node.attrs) node.attrs = [];
  const a = node.attrs.find((x) => x.name === name);
  if (a) a.value = value;
  else node.attrs.push({ name, value });
}

export function dropAttr(node: P5Any, name: string): void {
  if (node.attrs) node.attrs = node.attrs.filter((a) => a.name !== name);
}

export function classesOf(node: P5Any): string[] {
  return (getAttr(node, 'class') || '').split(/\s+/).filter(Boolean);
}

/** Plain text of a subtree; `<math>` is opaque and `<br>` reads as a space. */
export function textOf(node: P5Any): string {
  let out = '';
  const visit = (n: P5Any): void => {
    if (n.nodeName === '#text') out += n.value ?? '';
    else if (n.nodeName === 'math') return;
    else if (n.nodeName === 'br') out += ' ';
    else n.childNodes?.forEach(visit);
  };
  visit(node);
  return out.replace(/\s+/g, ' ').trim();
}

export function element(tag: string, cls?: string, ns = HTML_NS): P5Any {
  return { nodeName: tag, tagName: tag, namespaceURI: ns, attrs: cls ? [{ name: 'class', value: cls }] : [], childNodes: [], parentNode: null };
}

export function text(parent: P5Any, value: string): P5Any {
  const t: P5Any = { nodeName: '#text', value, parentNode: parent };
  parent.childNodes!.push(t);
  return t;
}

export function append(parent: P5Any, child: P5Any): void {
  child.parentNode = parent;
  parent.childNodes!.push(child);
}

/** Replace `node` in its parent's child list with `sub`. */
export function replaceNode(node: P5Any, sub: P5Any): void {
  const parent = node.parentNode;
  if (!parent?.childNodes) return;
  sub.parentNode = parent;
  parent.childNodes[parent.childNodes.indexOf(node)] = sub;
}

/** Turn `node` into a plain-text span (placeholder for private/broken content). */
export function replaceWithText(node: P5Any, label: string): void {
  node.nodeName = 'span';
  node.tagName = 'span';
  node.namespaceURI = HTML_NS;
  node.attrs = [];
  node.childNodes = [];
  text(node, label);
}

/** True when `node` has an ancestor matching `pred`, stopping at <body>/<html>. */
export function hasAncestor(node: P5Any, pred: (n: P5Any) => boolean): boolean {
  for (let p = node.parentNode; p; p = p.parentNode) {
    if (pred(p)) return true;
    const t = p.tagName || p.nodeName;
    if (t === 'body' || t === 'html') return false;
  }
  return false;
}