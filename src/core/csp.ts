// The site's CSP, in one place. Preview (serve.ts, plain http) and production
// (gen-nginx.ts) send identical directives except upgrade-insecure-requests,
// which production adds — under it WebKit rewrites http subresources to https,
// so the plain-http preview would load nothing. build.test.ts pins this.
import type { AppConfig } from './config.ts';
import { frameOriginsOf, frameSrcOf } from './config.ts';

export interface CspHashes {
  script: string[];
  style: string[];
}

/** <meta> CSP placeholder (cspMeta): rendered into every page, swapped for the
 *  real policy once the style hashes are known. The full tag — not the bare
 *  token — is the swap key, so a note quoting the token in prose is untouched.
 *  A leftover fails the audit. */
const CSP_META_PLACEHOLDER = '__NOTEFLOW_CSP__';
export const CSP_META_TAG = `<meta http-equiv="Content-Security-Policy" content="${CSP_META_PLACEHOLDER}">`;

const HASH = /^sha256-[A-Za-z0-9+/=]+$/;

/** Validated, sorted hash arrays out of a parsed build manifest. Sorted at
 *  ingestion: the manifest records hashes in content-scan order, which varies
 *  with the content tree — the CSP string must not. Malformed entries throw
 *  rather than becoming source tokens no browser would ever match. */
export function hashesOf(manifest: unknown): CspHashes {
  const m = manifest as { csp?: { inlineScriptHashes?: unknown; inlineStyleHashes?: unknown } } | null;
  const list = (v: unknown): string[] => {
    if (!Array.isArray(v)) return [];
    for (const h of v) {
      if (typeof h !== 'string' || !HASH.test(h)) {
        throw new Error(`malformed CSP hash entry in manifest: ${JSON.stringify(h)}`);
      }
    }
    return [...(v as string[])].sort();
  };
  return { script: list(m?.csp?.inlineScriptHashes), style: list(m?.csp?.inlineStyleHashes) };
}

/** Audit/DOM checks must accept exactly the origins the CSP allows for frames. */
export function allowsFrame(src: string, cfg: AppConfig): boolean {
  try {
    return frameOriginsOf(cfg).includes(new URL(src).origin);
  } catch {
    return false;
  }
}

export function buildCsp(hashes: CspHashes, cfg: AppConfig, production = false): string {
  const quoted = (xs: string[]): string[] => xs.map((h) => `'${h}'`);
  return [
    "default-src 'self'",
    // Any https image origin: notes embed external image hosts (owner
    // decision 2026-11-16); images are passive content.
    "img-src 'self' data: https:",
    `style-src ${["'self'", "'unsafe-hashes'", ...quoted(hashes.style)].join(' ')}`,
    `script-src ${["'self'", ...quoted(hashes.script)].join(' ')}`,
    "connect-src 'self'",
    // Comments widget + the video embed hosts (src/core/config.ts).
    `frame-src ${frameSrcOf(cfg)}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    ...(production ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}
