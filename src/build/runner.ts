// Build child processes: a crash cannot poison the parent, and config edits
// take effect because every build re-reads them. Single-flight: requests
// arriving while a build runs coalesce into one follow-up.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

export interface BuildOpts {
  args: string[];
  cwd: string;
}

export interface BuildEvents {
  start(): void;
  exit(code: number, ms: number): void;
}

function spawnBuild({ args, cwd }: BuildOpts): ChildProcess {
  return spawn(process.execPath, [path.join(cwd, 'src/cli/build.ts'), ...args], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, PANDOC_BIN: process.env.PANDOC_BIN || 'pandoc' },
  });
}

export class BuildRunner {
  private child: ChildProcess | null = null;
  private pending = false;
  private opts: BuildOpts & { events: BuildEvents };

  constructor(opts: BuildOpts & { events: BuildEvents }) {
    this.opts = opts;
  }

  get busy(): boolean {
    return this.child !== null;
  }

  request(): void {
    if (this.child) {
      this.pending = true;
      return;
    }
    this.go();
  }

  kill(): void {
    this.pending = false;
    this.child?.kill('SIGTERM');
  }

  private go(): void {
    this.opts.events.start();
    const t0 = Date.now();
    const child = spawnBuild(this.opts);
    this.child = child;
    let done = false;
    const finish = (code: number): void => {
      if (done) return;
      done = true;
      this.child = null;
      this.opts.events.exit(code, Date.now() - t0);
      if (this.pending) {
        this.pending = false;
        this.go();
      }
    };
    // A spawn failure (ENOENT) fires 'error' without any 'exit'.
    child.on('exit', (code) => finish(code ?? 1));
    child.on('error', () => finish(1));
  }
}

/** One-shot build; resolves the child's exit code. */
export function runBuildChild(opts: BuildOpts): Promise<number> {
  const child = spawnBuild(opts);
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}
