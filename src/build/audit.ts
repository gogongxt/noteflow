// Attribute checks must parse the HTML: code samples legitimately contain
// strings like "javascript:".
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'parse5';
import { BITMAP_DATA_MIMES, decodeEntities, decodeURIComponentSafe, toPosix, walkFiles } from '../core/util.ts';
import { allowsFrame } from '../core/csp.ts';
import { hasAncestor, walk, type P5Any } from '../core/dom.ts';
import { ATTACHMENT_PATH, isOffsiteHref, newTabRel } from '../render/links.ts';
import { siteHostOf, basePathOf, type AppConfig } from '../core/config.ts';
import { CSP_META_TAG } from '../core/csp.ts';
import type { Page, PrivateItem } from '../core/types.ts';

interface AuditResult {
  findings: Finding[];
  inlineStyles: string[];
}

interface AuditInput {
  dist: string;
  pages: Page[];
  privateItems: PrivateItem[];
  cfg: AppConfig;
}

interface Finding {
  file: string;
  msg: string;
}

const DANGEROUS_SCHEME = /^(javascript|vbscript|file|data):/i;
// BITMAP_DATA_MIMES is shared with sanitize and the card generator; only <img>
// may additionally carry the generator's x-icon favicons.
const SAFE_DATA = new RegExp(`^data:(?:${BITMAP_DATA_MIMES.join('|')});base64,`, 'i');
const SAFE_DATA_IMG = new RegExp(`^data:(?:${[...BITMAP_DATA_MIMES, 'image/x-icon'].join('|')});base64,`, 'i');

/** URL attributes that must be scheme-checked and, when local, exist on disk.
 *  Media URLs are passive content too; a missing local file is a dead player. */
const URL_ATTRS: Record<string, string[]> = {
  a: ['href'], link: ['href'], script: ['src'], img: ['src'],
  video: ['src', 'poster'], audio: ['src'], source: ['src'], track: ['src'],
};

export function runAuditDetailed(input: AuditInput): AuditResult {
  const findings: Finding[] = [];
  const files = walkFiles(input.dist);

  for (const f of files) {
    const rel = toPosix(path.relative(input.dist, f));
    const base = path.posix.basename(rel);
    if (base.endsWith('.md') || base === 'sort.txt' || base === '_index.md' ||
        base === '.env' || rel.split('/').includes('.git') || rel.split('/').some((s) => s.startsWith('.'))) {
      findings.push({ file: rel, msg: 'file that must not be published found in output' });
    }
  }

  for (const f of files) {
    if (fs.lstatSync(f).isSymbolicLink()) findings.push({ file: toPosix(path.relative(input.dist, f)), msg: 'symbolic link found in output' });
  }

  const probes = buildPrivateProbes(input.privateItems);
  const probeFiles = files.filter((f) => f.endsWith('.html') || f.endsWith('.xml') || f.endsWith('.json'));
  for (const f of probeFiles) {
    const raw = fs.readFileSync(f, 'utf8');
    const decoded = decodeEntities(decodeJsonEscapes(raw).normalize('NFC'));
    for (const p of probes) {
      if (decoded.includes(p)) findings.push({ file: toPosix(path.relative(input.dist, f)), msg: 'private content probe (title or path) found in output' });
    }
  }

  const inlineStyles = new Set<string>();
  const existsSet = new Set(files.map((f) => toPosix(path.relative(input.dist, f))));
  const siteHost = siteHostOf(input.cfg.url);
  // Hoisted once: this sits in the innermost loop over every URL attribute.
  const base = basePathOf(input.cfg.url);
  const stripBase = (url: string): string | null => {
    if (!base) return url;
    if (url === base) return '/';
    if (url.startsWith(base + '/')) return url.slice(base.length);
    return null; // without the base path the URL 404s in production
  };
  for (const f of files.filter((x) => x.endsWith('.html'))) {
    const rel = toPosix(path.relative(input.dist, f));
    const src = fs.readFileSync(f, 'utf8');
    if (input.cfg.cspMeta && src.includes(CSP_META_TAG)) {
      findings.push({ file: rel, msg: 'meta CSP placeholder was not replaced' });
    }
    const tree = parse(src) as unknown as P5Any;
    walk(tree, (node) => {
      for (const a of node.attrs ?? []) {
        const name = a.name.toLowerCase();
        if (name.startsWith('on')) findings.push({ file: rel, msg: `event handler attribute ${a.name} on <${node.nodeName}>` });
        if (a.name === 'style') {
          if (/expression\s*\(|url\s*\(/i.test(a.value)) findings.push({ file: rel, msg: 'style attribute contains expression()/url()' });
          else inlineStyles.add(a.value);
        }
      }
      if (node.nodeName === 'script') {
        const body = (node.childNodes ?? []).map((c) => c.value ?? '').join('');
        const src = node.attrs?.find((a) => a.name === 'src')?.value;
        if (body.includes('/*BLOG_THEME_INIT*/')) findings.push({ file: rel, msg: 'theme init script was not replaced' });
        if (!src && !body.trim()) findings.push({ file: rel, msg: 'empty inline script' });
        // Widget scripts are src-only; a body means inline code slipped past sanitize.
        if (src && body.trim()) findings.push({ file: rel, msg: 'script with src must have an empty body (inline code is not allowed)' });
      }
      if (node.nodeName === 'iframe') {
        // The only frame the CSP allows is the comments widget.
        const src = node.attrs?.find((a) => a.name === 'src')?.value ?? '';
        if (src && !allowsFrame(src, input.cfg)) {
          findings.push({ file: rel, msg: `iframe points to an unauthorized origin: ${src.slice(0, 60)}` });
        }
      }
      for (const attr of URL_ATTRS[node.nodeName] ?? []) {
        const url = node.attrs?.find((a) => a.name === attr)?.value;
        if (!url) continue;
        if (DANGEROUS_SCHEME.test(url) && !(node.nodeName === 'img' ? SAFE_DATA_IMG : SAFE_DATA).test(url)) {
          findings.push({ file: rel, msg: `<${node.nodeName}> uses a dangerous scheme: ${url.slice(0, 40)}` });
          continue;
        }
        if (url.startsWith('//')) findings.push({ file: rel, msg: `protocol-relative URL: ${url.slice(0, 60)}` });
        if (url.startsWith('/') && !url.startsWith('//')) {
          const stripped = stripBase(url.split('#')[0].split('?')[0]);
          if (stripped === null) {
            findings.push({ file: rel, msg: `internal link lacks the site's base path: ${url.slice(0, 60)}` });
          } else {
            const pathOnly = decodeURIComponentSafe(stripped).slice(1);
            if (pathOnly) {
              const base = pathOnly.replace(/\/$/, '');
              const candidates = [pathOnly, `${base}/index.html`];
              if (!candidates.some((c) => existsSet.has(c))) {
                findings.push({ file: rel, msg: `internal link points to a nonexistent file: ${url}` });
              }
            }
          }
        }
        // Off-site and attachment links open a new tab; everything else is
        // page navigation. Code blocks quote markup, so they are exempt.
        if (node.nodeName === 'a' && !insideCode(node)) {
          const target = node.attrs?.find((a) => a.name === 'target')?.value;
          const relValue = node.attrs?.find((a) => a.name === 'rel')?.value ?? '';
          // Attachment URLs carry the base path like every internal URL.
          const policyUrl = url.startsWith('/') && !url.startsWith('//') ? stripBase(url) ?? url : url;
          if (isOffsiteHref(policyUrl, siteHost) || ATTACHMENT_PATH.test(policyUrl)) {
            const relTokens = new Set(relValue.split(/\s+/));
            const needed = newTabRel(relValue).split(' ');
            const missing = needed.filter((t) => !relTokens.has(t));
            if (target !== '_blank' || missing.length) {
              findings.push({ file: rel, msg: `off-site link must open a new tab (add target="_blank" rel="${needed.join(' ')}"): ${url.slice(0, 60)}` });
            }
          } else if (url.startsWith('/') && !url.startsWith('//') && target === '_blank') {
            findings.push({ file: rel, msg: `internal link must stay in the current tab (drop target): ${url.slice(0, 60)}` });
          }
        }
      }
      if (node.nodeName === '#text' && /\/Users\/|\/home\/[a-z]+\/|\/private\/tmp\//.test(node.value ?? '')) {
        // Fenced samples and link-card og text legitimately quote local paths.
        if (!insidePre(node) && !insideLinkCard(node)) findings.push({ file: rel, msg: 'absolute local path found in body text' });
      }
      if (node.nodeName === '#text') {
        const tag = (node.value ?? '').match(/\{%\s*([a-z_]+)/i);
        if (tag && !insideCode(node) && !insideLinkCard(node)) {
          findings.push({ file: rel, msg: `unconverted template tag in body text: ${tag[0]}…` });
        }
      }
    });
  }

  const pageAbbrs = new Set(input.pages.map((p) => p.abbrlink));
  for (const f of files) {
    const rel = toPosix(path.relative(input.dist, f));
    const m = rel.match(/^assets\/([^/]+)\//);
    if (m && !pageAbbrs.has(m[1])) findings.push({ file: rel, msg: 'attachment cannot be traced back to a public page' });
  }

  return { findings: dedupe(findings), inlineStyles: [...inlineStyles] };
}

function buildPrivateProbes(items: PrivateItem[]): string[] {
  const out = new Set<string>();
  for (const it of items) {
    const title = it.title.normalize('NFC').trim();
    // Short generic titles ("CSS") and common dir names ("drafts") appear in
    // public text; probing them would abort builds on false positives.
    if (it.kind === 'page' && title.length >= 6) out.add(title);
    out.add('/' + it.relPath + '.html');
    out.add('/' + it.relPath + '/');
    if (it.abbrlink) {
      // Probe both URL shapes: the old site used .html, the new one is directory-style with no extension.
      out.add(`/posts/${it.abbrlink}.html`);
      out.add(`/posts/${it.abbrlink}`);
      out.add(`/posts/${it.abbrlink}/`);
      out.add(`assets/${it.abbrlink}/`);
    }
  }
  return [...out];
}

function decodeJsonEscapes(s: string): string {
  return s.replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** True when the node sits inside <pre>/<code>, where syntax is quoted, not live. */
function insideCode(node: P5Any): boolean {
  return insidePre(node) || hasAncestor(node as never, (n) => (n.tagName || n.nodeName) === 'code');
}

/** True only inside fenced/indented blocks (<pre>), not inline `<code>` in prose. */
function insidePre(node: P5Any): boolean {
  return hasAncestor(node as never, (n) => (n.tagName || n.nodeName) === 'pre');
}

/** True inside link-card text: fetched og metadata, where a linked site
 *  quoting "/home/…" or "{% raw %}" in its description is content, not a leak. */
function insideLinkCard(node: P5Any): boolean {
  for (let p = node.parentNode; p; p = p.parentNode) {
    const cls = p.attrs?.find((a) => a.name === 'class')?.value ?? '';
    if (cls.split(/\s+/).includes('link-card')) return true;
  }
  return false;
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const k = f.file + '\0' + f.msg;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
