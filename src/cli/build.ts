// Build entry: parse argv, run the pipeline, and reduce any failure to one
// message plus a non-zero exit code.
import { BuildError, log, parseArgs } from '../core/util.ts';
import { buildSite } from '../build/pipeline.ts';

const t0 = Date.now();
const root = process.cwd();

buildSite({ args: parseArgs(process.argv.slice(2)), root, t0 }).catch((err) => {
  if (err instanceof BuildError) log.error(err.message);
  else console.error(err);
  process.exit(1);
});