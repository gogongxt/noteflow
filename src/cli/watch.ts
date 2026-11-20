// Watch mode: rebuild on content/theme/config changes. Each rebuild is a child
// process (a crash cannot poison the watcher; config edits take effect), debounced
// so an editor save-storm is one rebuild.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, CONFIG_FILES, repoPath, ROOT, type AppConfig } from '../core/config.ts';
import { argPath, fatal, parseArgs } from '../core/util.ts';
import { BuildRunner } from '../build/runner.ts';

const args = parseArgs(process.argv.slice(2));
const DEBOUNCE_MS = 300;

function log(msg: string): void {
  console.log(`\x1b[2m[${new Date().toLocaleTimeString()}]\x1b[0m ${msg}`);
}

const runner = new BuildRunner({
  args: process.argv.slice(2),
  cwd: ROOT,
  events: {
    start: () => log('Rebuilding…'),
    exit: (code, ms) =>
      log(code === 0 ? `Build OK (${ms}ms) — refresh the browser` : `Build FAILED (exit ${code}); fix the error, saving the file retries`),
  },
});

let timer: NodeJS.Timeout | null = null;

function scheduleRebuild(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => runner.request(), DEBOUNCE_MS);
}

// fs.watch is recursive on Linux; the periodic sweep re-establishes watchers
// after builds add/remove directories or a config file appears.
const watchers = new Map<string, fs.FSWatcher>();

function watchTree(dir: string): void {
  if (watchers.has(dir) || !fs.existsSync(dir)) return;
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(dir, { recursive: true }, (_event, file) => {
      const rel = String(file ?? '');
      // Editor temp files: .#foo (emacs), foo.swp/.swx (vim), 4913 (vim dir marker)
      if (/(^|\/)\.|(^|\/)4913$/.test(rel) || /\.(swp|swx|tmp|crdownload)$/.test(rel)) return;
      scheduleRebuild();
    });
  } catch {
    return; // unwatchable dir: the build itself will complain
  }
  track(watcher, dir);
}

function watchFile(file: string): void {
  if (watchers.has(file) || !fs.existsSync(file)) return;
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(file, () => scheduleRebuild());
  } catch {
    return;
  }
  track(watcher, file);
}

function track(watcher: fs.FSWatcher, key: string): void {
  const forget = (): void => {
    watchers.delete(key);
  };
  watcher.on('error', forget);
  watcher.on('close', forget);
  watchers.set(key, watcher);
}

/** Watch the content tree, theme, builder sources, and config files. */
function watchAll(cfg: AppConfig): void {
  watchTree(contentArg ?? repoPath(cfg.contentDir));
  watchTree(repoPath(cfg.themeDir));
  watchTree(path.join(ROOT, 'src')); // builder/theme-JS changes rebuild too
  for (const f of CONFIG_FILES) watchFile(repoPath(f));
  if (configArg) watchFile(configArg);
}

const configArg = typeof args.config === 'string' ? argPath('--config', args.config, ROOT) : undefined;
const contentArg = typeof args.content === 'string' ? argPath('--content', args.content, ROOT) : undefined;
const cfg = await loadConfig(configArg, contentArg).catch(fatal);
if (!fs.existsSync(contentArg ?? repoPath(cfg.contentDir))) {
  console.error(`Content directory not found: ${contentArg ?? repoPath(cfg.contentDir)}`);
  process.exit(1);
}

console.log(`noteflow watch: rebuilding on changes under ${cfg.contentDir}/, ${cfg.themeDir}/, src/ and the config files`);
console.log('  Initial build…');
watchAll(cfg);
runner.request();

// Re-establish watchers periodically (directories and config files appear).
setInterval(() => {
  loadConfig(configArg, contentArg).then(watchAll, () => {});
}, 5000).unref();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    runner.kill();
    process.exit(0);
  });
}