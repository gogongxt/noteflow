// Build entry: parse argv and run the pipeline.
import { parseArgs, runCli } from '../core/util.ts';
import { ROOT } from '../core/config.ts';
import { buildSite } from '../build/pipeline.ts';

const t0 = Date.now();
runCli(async () => {
  await buildSite({ args: parseArgs(process.argv.slice(2)), root: ROOT, t0 });
});
