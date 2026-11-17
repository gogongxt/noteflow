import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Directories tmpDir() created; removed by cleanupTmpDirs() in `after`. */
const created: string[] = [];

export function tmpDir(prefix = 'blog-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function cleanupTmpDirs(): void {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
}

export function writeFile(root: string, rel: string, content: string | Buffer): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

export function titleOf(html: string): string {
  return html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '';
}

export function readOut(dist: string, rel: string): string {
  return fs.readFileSync(path.join(dist, rel), 'utf8');
}

export function exists(dist: string, rel: string): boolean {
  return fs.existsSync(path.join(dist, rel));
}

export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
