// The closing stage: audit the written tree, then write the manifest (repo
// root) and the CSP hash copy inside dist/ that serve.ts reads.
import path from 'node:path';
import { BuildError } from '../core/util.ts';
import { runAuditDetailed } from './audit.ts';
import { hashContent, hashDist, styleHash, writeAtomic } from './outputs.ts';
import type { AppConfig } from '../core/config.ts';
import type { Page, PrivateItem } from '../core/types.ts';

export interface ManifestInput {
  dist: string;
  contentRoot: string;
  pages: Page[];
  privateItems: PrivateItem[];
  cfg: AppConfig;
  skipAudit: boolean;
  /** Everything postprocess collected; the audit must not find more. */
  bodyInlineStyles: ReadonlySet<string>;
  counts: { published: number; indexes: number; assets: number; searchDocs: number };
  buildTime: Date;
  pandocVersion: string | undefined;
  scriptHashes: string[];
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
  let inlineStyles: string[] = [];
  if (!input.skipAudit) {
    inlineStyles = audit.inlineStyles;
    // Anything the audit sees in the final output but postprocess did not
    // collect would ship unhashed in the meta CSP.
    const unknown = audit.inlineStyles.filter((s) => !input.bodyInlineStyles.has(s));
    if (unknown.length) {
      throw new BuildError(
        `Output audit failed: ${unknown.length} inline style attribute(s) appeared after postprocess; the meta CSP would block them:\n` +
          unknown.slice(0, 5).map((s) => `  - ${s.slice(0, 60)}`).join('\n'),
      );
    }
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
      inlineScriptHashes: input.scriptHashes,
      inlineStyleHashes: inlineStyles.map(styleHash),
    },
  };
  writeAtomic(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  writeAtomic(
    path.join(input.dist, 'build-info.json'),
    JSON.stringify({ buildId: manifest.buildId, builtAt: manifest.builtAt, csp: manifest.csp }) + '\n',
  );
  return { counts: manifest.counts };
}