// Print config values for shell scripts: `node src/cli/config-print.ts [--config <file>] <key> [key...]`
// One node boot per script invocation, and the exact same resolution path as
// the builder itself (site.config.ts ← site.config.local.mjs ← defaults; a
// named --config profile replaces that stack entirely).
import path from 'node:path';
import { parseArgs } from '../core/util.ts';
import { loadConfig } from '../core/config.ts';

const args = parseArgs(process.argv.slice(2));
const keys = args._;
if (!keys.length) {
  console.error('Usage: node src/cli/config-print.ts [--config <file>] <key> [key...]   (e.g. contentDir outDir)');
  process.exit(1);
}
const cfg = await loadConfig(typeof args.config === 'string' ? path.resolve(process.cwd(), String(args.config)) : undefined);
for (const k of keys) {
  const v = (cfg as unknown as Record<string, unknown>)[k];
  if (v == null) {
    console.error(`✗ unknown config key: ${k}`);
    process.exit(1);
  }
  console.log(String(v));
}
