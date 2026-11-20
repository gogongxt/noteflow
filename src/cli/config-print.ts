// Print config values for shell scripts:
//   config-print.ts [--config <file>] <key>…        one value per line
//   config-print.ts [--config <file>] --exists <key>  exit 0 when set, 1 when not
// One node boot per invocation, the builder's own resolution path.
import { BuildError, argPath, parseArgs, runCli } from '../core/util.ts';
import { loadConfig, ROOT } from '../core/config.ts';

const args = parseArgs(process.argv.slice(2));

runCli(async () => {
  const cfg = await loadConfig(typeof args.config === 'string' ? argPath('--config', args.config, ROOT) : undefined);
  if (typeof args.exists === 'string') {
    const v = (cfg as unknown as Record<string, unknown>)[args.exists];
    process.exit(v == null ? 1 : 0);
  }
  const keys = args._;
  if (!keys.length) {
    console.error('Usage: node src/cli/config-print.ts [--config <file>] <key> [key...]   (e.g. contentDir outDir)');
    process.exit(1);
  }
  for (const k of keys) {
    const v = (cfg as unknown as Record<string, unknown>)[k];
    if (v == null) throw new BuildError(`unknown config key: ${k}`);
    console.log(String(v));
  }
});
