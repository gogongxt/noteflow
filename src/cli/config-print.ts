// Print config values for shell scripts: `config-print.ts [--config <file>] <key>…`
// One node boot per invocation, the builder's own resolution path.
import path from 'node:path';
import { BuildError, parseArgs, runCli } from '../core/util.ts';
import { loadConfig } from '../core/config.ts';

const args = parseArgs(process.argv.slice(2));
const keys = args._;
if (!keys.length) {
  console.error('Usage: node src/cli/config-print.ts [--config <file>] <key> [key...]   (e.g. contentDir outDir)');
  process.exit(1);
}
runCli(async () => {
  const cfg = await loadConfig(
    typeof args.config === 'string' ? path.resolve(process.cwd(), String(args.config)) : undefined,
  );
  for (const k of keys) {
    const v = (cfg as unknown as Record<string, unknown>)[k];
    if (v == null) throw new BuildError(`unknown config key: ${k}`);
    console.log(String(v));
  }
});
