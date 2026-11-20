// Mirror-mode git for the serving host: the content dir follows one remote
// branch. Every operation goes against the configured remote URL directly, so
// the clone's own `origin` never matters. A mirror never merges — `reset
// --hard FETCH_HEAD`, unconditionally: the build's abbrlink write-backs are
// deterministic (the same slug is recomputed on the next build), so resetting
// them away costs nothing, and hand edits on a serving mirror are not a thing
// to protect — edit notes where you edit them.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BuildError } from '../core/util.ts';

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

/** A remote URL may carry a token (https://<token>@host/…); git echoes URLs in
 *  errors, so keep credentials out of logs. */
const redact = (s: string): string => s.replace(/(https?:\/\/)[^@/\s]+@/g, '$1***@');

function git(args: string[], cwd: string, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: 16 << 20, env: GIT_ENV }, (err, _stdout, stderr) => {
      if (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new BuildError('git executable not found; the sync mode shells out to git — install it'));
          return;
        }
        // Enough context for callers to classify failures (a rejected push
        // names its reason a few lines above the hints).
        const tail = String(stderr).trim().split('\n').slice(-8).join(' ').slice(0, 400);
        reject(new BuildError(`git ${args[0]} failed: ${redact(tail) || err.message}`));
        return;
      }
      resolve(_stdout);
    });
  });
}

export interface GitSyncOpts {
  dir: string;
  remote: string;
  branch: string;
}

export class GitSync {
  private opts: GitSyncOpts;

  constructor(opts: GitSyncOpts) {
    this.opts = opts;
  }

  private get dir(): string {
    return this.opts.dir;
  }

  private cwd(): string {
    return fs.existsSync(this.dir) ? this.dir : path.dirname(path.resolve(this.dir));
  }

  /** Clone into `dir` if it is not already a repository. True when cloned. */
  async ensureCloned(): Promise<boolean> {
    if (fs.existsSync(path.join(this.dir, '.git'))) {
      // A clone killed mid-flight leaves a .git that is not a usable
      // repository; fetch against it would only fail cryptically every tick.
      await git(['rev-parse', '--git-dir'], this.dir).catch(() => {
        throw new BuildError(`sync: ${this.dir} holds a broken .git (an interrupted clone?); remove the directory and start again`);
      });
      return false;
    }
    if (fs.existsSync(this.dir) && fs.readdirSync(this.dir).length > 0) {
      throw new BuildError(`sync: ${this.dir} exists and is not a git repository; refusing to clone into it`);
    }
    await git(['clone', '--branch', this.opts.branch, this.opts.remote, this.dir], path.dirname(path.resolve(this.dir)), 600_000);
    // The clone's origin would persist the token in .git/config; every
    // operation already goes through the configured URL, so drop it.
    await git(['remote', 'remove', 'origin'], this.dir).catch(() => {});
    return true;
  }

  private async head(): Promise<string | null> {
    try {
      return (await git(['rev-parse', 'HEAD'], this.dir)).trim();
    } catch {
      return null; // no commits yet
    }
  }

  private async remoteSha(): Promise<string> {
    const out = await git(['ls-remote', this.opts.remote, `refs/heads/${this.opts.branch}`], this.cwd(), 30_000);
    const sha = out.trim().split('\t')[0];
    if (!/^[0-9a-f]{40,}$/.test(sha ?? '')) {
      throw new BuildError(`sync: branch '${this.opts.branch}' not found on ${this.opts.remote}`);
    }
    return sha;
  }

  /** Fetch and hard-reset onto the remote tip; `changed` is false when the
   *  local HEAD already is that tip (the common poll outcome). */
  async sync(): Promise<{ changed: boolean; sha: string }> {
    const remote = await this.remoteSha();
    if (remote === (await this.head())) return { changed: false, sha: remote };
    await git(['fetch', '--no-tags', this.opts.remote, this.opts.branch], this.dir, 600_000);
    await git(['reset', '--hard', 'FETCH_HEAD'], this.dir);
    return { changed: true, sha: remote };
  }

  /** Commit exactly `files` (absolute paths inside the tree) and push to the
   *  remote. 'nothing' when none is modified. A lost push race (someone pushed
   *  past us) drops the commit onto the remote's newer tip — the pins simply
   *  regenerate on the next build; anything else (permissions, protected
   *  branch) throws. */
  async commitAndPush(files: string[], message: string): Promise<'pushed' | 'nothing' | 'dropped'> {
    const dirty = await git(['--no-optional-locks', 'status', '--porcelain', '--', ...files], this.dir);
    if (!dirty.trim()) return 'nothing';
    await git(['add', '--', ...files], this.dir);
    await git(['-c', 'user.name=noteflow', '-c', 'user.email=noteflow@localhost', 'commit', '-m', message], this.dir);
    try {
      await git(['push', this.opts.remote, `HEAD:refs/heads/${this.opts.branch}`], this.dir, 120_000);
      return 'pushed';
    } catch (err) {
      if (!(err instanceof BuildError) || !/rejected|non-fast-forward|fetch first/.test(err.message)) throw err;
      await git(['fetch', '--no-tags', this.opts.remote, this.opts.branch], this.dir, 600_000);
      await git(['reset', '--hard', 'FETCH_HEAD'], this.dir);
      return 'dropped';
    }
  }
}
