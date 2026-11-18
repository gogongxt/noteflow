// The link policy: leaving the site opens a new tab, page navigation stays in
// the current one. Applied at build time so it holds without JavaScript and
// re-checked by the output audit, which fails the build on a violation.
import { getAttr, setAttr, type P5Any } from '../core/dom.ts';

const WEB_SCHEMES = new Set(['http', 'https', 'ftp']);

/** A built attachment URL (`/assets/<abbrlink>/…`): a download, not a page. */
export const ATTACHMENT_PATH = /^\/assets\/[^/]+\//;

/** True for an absolute web URL on another host. The site's own pages stay
 *  internal whatever the scheme; mailto:/tel: are not cross-tab links. */
export function isOffsiteHref(href: string, host: string): boolean {
  const raw = String(href || '').trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1].toLowerCase();
  if (!scheme || !WEB_SCHEMES.has(scheme)) return false;
  try {
    return new URL(raw).host.toLowerCase() !== host.toLowerCase();
  } catch {
    return false;
  }
}

/** Append the new-tab tokens to a link's rel, keeping every author token. */
export function newTabRel(existing: string | undefined): string {
  const tokens = new Set(String(existing || '').split(/\s+/).filter(Boolean));
  tokens.add('noopener');
  tokens.add('noreferrer');
  return [...tokens].join(' ');
}

/** Make an anchor open off-site, without handing the new page a window handle. */
export function markExternal(node: P5Any): void {
  setAttr(node, 'target', '_blank');
  setAttr(node, 'rel', newTabRel(getAttr(node, 'rel')));
}