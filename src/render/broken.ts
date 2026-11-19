// Reporting a broken reference, together with the heading it sits under.
import { getAttr, textOf, type P5Any } from '../core/dom.ts';
import type { PostprocessCtx } from './postprocess-types.ts';

/** The nearest enclosing section's heading — the one thing that makes a failure
 *  in a long note findable, since pandoc gives us no line numbers. */
function whereOf(node: P5Any): string | undefined {
  for (let cur: P5Any | null | undefined = node; cur; cur = cur.parentNode) {
    if (cur.nodeName !== 'section' || !getAttr(cur, 'id')) continue;
    for (const child of cur.childNodes ?? []) {
      if (!/^h[1-6]$/.test(child.nodeName)) continue;
      const found = textOf(child).trim();
      if (found) return found.length > 60 ? found.slice(0, 59) + '…' : found;
    }
  }
  return undefined;
}

export function reportBroken(ctx: PostprocessCtx, msg: string, node: P5Any): void {
  ctx.onBroken?.({ relPath: ctx.pageRelPath, msg, where: whereOf(node) });
}