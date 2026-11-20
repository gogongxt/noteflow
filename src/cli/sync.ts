// One-shot mirror sync: clone if needed, fetch + reset onto the remote tip,
// rebuild when anything moved. The always-on daemon lives in serve.ts.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from '../core/config.ts';
import { BuildError, fatal, parseArgs } from '../core/util.ts';
import { GitSync } from '../sync/git.ts';
import { runBuildChild } from '../build/runner.ts';

const args = parseArgs(process.argv.slice(2));
const cfg = await loadConfig(
  args.config ? path.resolve(process.cwd(), String(args.config)) : undefined,
  typeof args.content === 'string' ? path.resolve(process.cwd(), String(args.content)) : undefined,
).catch(fatal);

if (!cfg.sync) fatal(new BuildError('sync is not configured: set sync: { remote, branch } in site.config.local.mjs'));

const git = new GitSync({
  dir: path.resolve(ROOT, String(args.content || cfg.contentDir)),
  remote: cfg.sync.remote,
  branch: cfg.sync.branch ?? 'master',
});

try {
  const cloned = await git.ensureCloned();
  const res = await git.sync();
  const at = `${cfg.sync.branch}@${res.sha.slice(0, 8)}`;
  console.log(cloned ? `✓ Cloned ${at}` : res.changed ? `✓ Updated to ${at}` : `✓ Up to date (${at})`);
  // Up to date is not built: a cron consumer must be able to rely on
  // "exit 0 ⇒ dist is fresh", so a missing dist builds too.
  const dist = path.resolve(ROOT, String(args.out || cfg.outDir));
  if (cloned || res.changed || args.build === true || !fs.existsSync(path.join(dist, 'build-info.json'))) {
    process.exit(await runBuildChild({ args: process.argv.slice(2).filter((a) => a !== '--build'), cwd: ROOT }));
  }
} catch (err) {
  fatal(err);
}
