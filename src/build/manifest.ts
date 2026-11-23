// The closing stage: audit the written tree, then write the manifest (repo
// root) and the CSP hash copy inside dist/ that serve.ts reads.
import path from 'node:path';
import { BuildError } from '../core/util.ts';
import { runAuditDetailed } from './audit.ts';
import { cspHash, hashContent, hashDist, writeAtomic } from './outputs.ts';
import type { AppConfig } from '../core/config.ts';
import type { Page, PrivateItem } from '../core/types.ts';

export interface ManifestInput {
  dist: string;
  contentRoot: string;
  pages: Page[];
  privateItems: PrivateItem[];
  cfg: AppConfig;
  skipAudit: boolean;
  counts: { published: number; indexes: number; assets: number; searchDocs: number };
  buildTime: Date;
  pandocVersion: string | undefined;
  /** The CSP the pages shipped with. The audit re-derives hashes from the
   *  written output and refuses anything this list does not cover. */
  scriptHashes: string[];
  styleHashes: string[];
  /** Content-rel paths whose frontmatter this build wrote an abbrlink into —
   *  the sync daemon commits exactly these files back to the notes remote. */
  abbrlinkWrites: string[];
}

export interface FinishedBuild {
  counts: { published: number; indexes: number; private: number; assets: number; searchDocs: number };
}

export function finishBuild(input: ManifestInput, manifestFile: string): FinishedBuild {
  // --skip-audit only waives the "style hashes are complete" claim (gen-nginx
  // refuses such a manifest); private-content and link findings always fail.
  const audit = runAuditDetailed({ dist: input.dist, pages: input.pages, privateItems: input.privateItems, cfg: input.cfg });
  if (audit.findings.length) {
    throw new BuildError(
      `Output audit failed (${audit.findings.length} findings):\n` +
        audit.findings.slice(0, 30).map((f) => `  - ${f.file}: ${f.msg}`).join('\n'),
    );
  }
  const styleHashes = input.styleHashes;
  if (!input.skipAudit) {
    // The CSP hashes are the execution boundary; the audit proves they close
    // over the written tree. It re-hashes every inline style/script/handler it
    // finds and refuses any the build published no hash for — a guard for
    // stages that run after the page set was fixed, since those are the only
    // ones that could add code the CSP does not cover.
    const unclosed = (seen: string[], hashed: readonly string[], what: string): void => {
      const known = new Set(hashed);
      const unknown = [...new Set(seen.map(cspHash))].filter((h) => !known.has(h));
      if (unknown.length) {
        throw new BuildError(
          `Output audit failed: ${unknown.length} ${what} in the written output ${unknown.length === 1 ? 'is' : 'are'} not covered by the CSP hashes; the browser would block ${unknown.length === 1 ? 'it' : 'them'}:\n` +
            unknown.slice(0, 5).map((h) => `  - ${h}`).join('\n'),
        );
      }
    };
    unclosed(audit.inlineStyles, styleHashes, 'inline style value(s)');
    unclosed(audit.inlineScripts, input.scriptHashes, 'inline script body(ies)');
    unclosed(audit.inlineHandlers, input.scriptHashes, 'event-handler value(s)');
  }

  const buildId = input.buildTime.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const manifest = {
    buildId,
    builtAt: input.buildTime.toISOString(),
    pandocVersion: input.pandocVersion,
    counts: { ...input.counts, private: input.privateItems.length },
    contentHash: hashContent(input.contentRoot),
    distHash: hashDist(input.dist),
    abbrlinkWrites: input.abbrlinkWrites,
    // --skip-audit style hashes are incomplete; gen-nginx must refuse them.
    audited: !input.skipAudit,
    csp: {
      inlineScriptHashes: [...new Set(input.scriptHashes)],
      inlineStyleHashes: [...new Set(styleHashes)],
    },
  };
  writeAtomic(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  writeAtomic(
    path.join(input.dist, 'build-info.json'),
    JSON.stringify({ buildId: manifest.buildId, builtAt: manifest.builtAt, csp: manifest.csp }) + '\n',
  );
  return { counts: manifest.counts };
}