import { spawn, execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import net from 'node:net';
import { BuildError } from '../core/util.ts';

// Markdown dialect contract: a new extension also needs a sanitize.ts
// whitelist entry and a test (see AGENTS.md).
const FROM = [
  'markdown',
  '+task_lists',
  '+footnotes',
  '+pipe_tables',
  '+fenced_divs',
  '+definition_lists',
  '+strikeout',
  '+mark',
  '+alerts',
  '+emoji',
  '+tex_math_dollars',
  '+autolink_bare_uris',
  '+smart',
  '+fenced_code_attributes',
  '+header_attributes',
  '+link_attributes',
  '+bracketed_spans',
  '+inline_code_attributes',
  '+table_attributes',
  '-implicit_figures',
  '-yaml_metadata_block',
  '-raw_tex',
  '-raw_attribute',
].join('');

const TO = 'html5';

interface PostResult {
  status: number;
  text: string;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

interface PandocInfo {
  version: string;
  hasServer: boolean;
}

export function pandocVersion(bin: string): PandocInfo {
  const out = execFileSync(bin, ['--version'], { encoding: 'utf8' });
  const version = out.match(/^pandoc ([\d.]+)/m)?.[1] ?? '';
  const hasServer = /\+server/.test(out);
  return { version, hasServer };
}

function assertVersion(bin: string): PandocInfo {
  let info: PandocInfo;
  try {
    info = pandocVersion(bin);
  } catch {
    throw new BuildError(`pandoc not found: ${bin} (set PANDOC or the PANDOC_BIN env var)`);
  }
  const major = Number(info.version.split('.')[0] || 0);
  if (!(major >= 3)) throw new BuildError(`pandoc too old: ${info.version}, need >= 3.0`);
  if (!info.hasServer) throw new BuildError(`pandoc ${info.version} lacks the +server feature`);
  return info;
}

export class PandocServer {
  readonly bin: string;
  readonly timeoutMs: number;
  proc: ChildProcess | null = null;
  port: number | null = null;
  buildId: string;
  info: PandocInfo | null = null;
  private cleanupHooked = false;

  constructor({ bin = process.env.PANDOC_BIN || 'pandoc', timeoutMs = 30_000 }: { bin?: string; timeoutMs?: number } = {}) {
    this.bin = bin;
    this.timeoutMs = timeoutMs;
    this.buildId = `blog-${process.pid}-${Date.now().toString(36)}`;
  }

  async start(): Promise<this> {
    this.info = assertVersion(this.bin);
    this.port = await freePort();
    const proc = spawn(this.bin, ['server', '--port', String(this.port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BLOG_BUILD_ID: this.buildId },
    });
    this.proc = proc;
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null;
    });
    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    this.hookSignals();

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (this.proc === null) throw new BuildError(`pandoc server exited early: ${stderr.trim()}`);
      try {
        const res = await this.post({ text: 'ping', from: 'markdown', to: TO });
        if (res.status === 200) return this;
        throw new BuildError(`pandoc server health check failed: HTTP ${res.status} ${res.text}`);
      } catch (err) {
        if (err instanceof BuildError) throw err;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    throw new BuildError(`pandoc server not ready within 10s: ${stderr.trim()}`);
  }

  private hookSignals(): void {
    if (this.cleanupHooked) return;
    this.cleanupHooked = true;
    process.once('exit', () => this.stop());
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.once(sig, () => {
        this.stop();
        process.exit(130);
      });
    }
    process.once('uncaughtException', (err) => {
      this.stop();
      console.error(err);
      process.exit(1);
    });
  }

  private async post(payload: Record<string, unknown>): Promise<PostResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      return { status: res.status, text: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  }

  // 4xx aborts the build (builder configuration error); a 5xx while the server
  // is still alive is retried a couple of times — an empty-body 500 has been
  // observed as a one-off — before surfacing as a per-page conversion error.
  async convert(text: string, { sectionDivs = true } = {}): Promise<ConvertResult> {
    const payload: Record<string, unknown> = { text, from: FROM, to: TO, wrap: 'none' };
    if (sectionDivs) payload['section-divs'] = true;
    let res: PostResult;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await this.post(payload);
      } catch (err) {
        throw new BuildError(`pandoc request failed (timeout or process exited): ${(err as Error).message}`);
      }
      if (res.status === 200) return { html: res.text };
      if (res.status >= 400 && res.status < 500) {
        throw new BuildError(`pandoc rejected the request (HTTP ${res.status}): ${res.text.trim()} — this is a builder configuration error`);
      }
      if (this.proc === null) throw new BuildError(`pandoc server exited: ${res.text.trim()}`);
      if (attempt >= 2) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    return { html: null, error: res.text.trim() || `HTTP ${res.status} (empty body)` };
  }

  async smokeTest(): Promise<void> {
    const bad = await this.post({ text: 'x', from: 'definitely-not-a-format', to: TO });
    if (bad.status !== 500) throw new BuildError(`pandoc server smoke test failed: a bad 'from' should return 500, got ${bad.status}`);
    const ok = await this.convert('## 冒烟\n\n- [x] t\n');
    const html = ok.html ?? '';
    if (!/<section[^>]+class="level2"/.test(html) || !html.includes('id="冒烟"')) {
      throw new BuildError(`pandoc server smoke test failed: section-divs not in effect (${JSON.stringify(html.slice(0, 120))})`);
    }
    if (!html.includes('type="checkbox"')) throw new BuildError('pandoc server smoke test failed: task_lists not in effect');
  }

  stop(): void {
    const p = this.proc;
    if (!p) return;
    this.proc = null;
    try {
      p.kill('SIGTERM');
      setTimeout(() => {
        if (p.exitCode == null && p.signalCode == null) p.kill('SIGKILL');
      }, 500).unref();
    } catch {
    }
  }

  async waitExit(timeoutMs = 2000): Promise<void> {
    const p = this.proc;
    if (!p) return;
    this.stop();
    const start = Date.now();
    while (p.exitCode === null && p.signalCode === null && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

interface ConvertResult {
  html: string | null;
  error?: string;
}
