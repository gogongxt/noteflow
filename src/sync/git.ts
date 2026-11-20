// Mirror-mode git for the serving host: the content dir is a read-only image
// of one remote branch. Every operation goes against the configured remote
// URL directly, so the clone's own `origin` never matters. A mirror never
// merges — `reset --hard FETCH_HEAD` — which is only safe because the build
// guarantees no tool ever writes into the content tree (see abbrlink.ts).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BuildError } from '../core/util.ts';

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

function git(args: string[], cwd: string, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: 16 << 20, env: GIT_ENV }, (err, _stdout, stderr) => {
      if (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new BuildError('git executable not found; the sync mode shells out to git — install it'));
          return;
        }
        const tail = String(stderr).trim().split('\n').slice(-2).join(' ').slice(0, 300);
        reject(new BuildError(`git ${args[0]} failed: ${tail || err.message}`));
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

  private async dirty(): Promise<boolean> {
    const out = await git(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'], this.dir);
    return out.trim() !== '';
  }

  /** Fetch and hard-reset onto the remote tip; `changed` is false when the
   *  local HEAD already is that tip (the common poll outcome). */
  async sync(): Promise<{ changed: boolean; sha: string }> {
    const remote = await this.remoteSha();
    if (remote === (await this.head())) return { changed: false, sha: remote };
    await git(['fetch', '--no-tags', this.opts.remote, this.opts.branch], this.dir, 600_000);
    if (await this.dirty()) {
      throw new BuildError(
        `sync: ${this.dir} has modified tracked files; refusing to reset --hard.\n` +
          '  Fix them where you edit notes — a serving mirror must stay clean.',
      );
    }
    await git(['reset', '--hard', 'FETCH_HEAD'], this.dir);
    return { changed: true, sha: remote };
  }
}
