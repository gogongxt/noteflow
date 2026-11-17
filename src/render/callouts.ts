// Unified semantic classes for GFM alerts and fenced-div callouts; the label
// moves into data-note (CSS draws the title).
import { classesOf, dropAttr, getAttr, setAttr, type P5Any } from '../core/dom.ts';

const CALLOUT_KINDS: Record<string, string> = {
  note: 'Note',
  info: 'Info',
  tip: 'Tip',
  success: 'Success',
  warning: 'Warning',
  caution: 'Danger',
  important: 'Important',
  danger: 'Danger',
};

export function normalizeCallout(div: P5Any): void {
  const classes = classesOf(div);
  const isAlert = classes.includes('alert');
  if (!isAlert && !classes.includes('callout')) return;

  const kind = classes.find((c) => c in CALLOUT_KINDS) ?? (isAlert ? 'note' : '');
  let label = getAttr(div, 'title') || getAttr(div, 'data-note') || '';

  if (isAlert && Array.isArray(div.childNodes)) {
    const idx = div.childNodes.findIndex((n) => n.nodeName === 'div' && classesOf(n).includes('title'));
    if (idx >= 0) div.childNodes.splice(idx, 1);
  }

  const next = ['callout'];
  if (kind) next.push(kind);
  for (const c of classes) {
    if (c === 'callout' || c === 'alert' || c === 'title' || c in CALLOUT_KINDS) continue;
    next.push(c);
  }
  setAttr(div, 'class', [...new Set(next)].join(' '));

  label = label.trim() || (kind ? CALLOUT_KINDS[kind] : '');
  dropAttr(div, 'title');
  if (label) setAttr(div, 'data-note', label);
  else dropAttr(div, 'data-note');
}
