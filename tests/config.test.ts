import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/core/config.ts';

const SYNC = `export default { sync: { remote: 'https://example.com/notes.git' } };\n`;

/** A throwaway project root with a base config and an empty content dir. */
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noteflow-config-'));
  fs.writeFileSync(
    path.join(root, 'site.config.mjs'),
    `export default { url: 'https://example.com', siteName: 'test', contentDir: 'notes' };\n`,
  );
  fs.mkdirSync(path.join(root, 'notes'));
  return root;
}

test('the default stack reads a sync block at the content root', async () => {
  const root = tempRoot();
  try {
    fs.writeFileSync(path.join(root, 'notes', 'site.config.local.mjs'), SYNC);
    assert.ok((await loadConfig(undefined, undefined, root)).sync);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('projectRootOnly ignores a content-root local config', async () => {
  const root = tempRoot();
  try {
    fs.writeFileSync(path.join(root, 'notes', 'site.config.local.mjs'), SYNC);
    assert.equal((await loadConfig(undefined, undefined, root, { projectRootOnly: true })).sync, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('projectRootOnly still reads the project-root local config', async () => {
  const root = tempRoot();
  try {
    fs.writeFileSync(path.join(root, 'site.config.local.mjs'), SYNC);
    assert.ok((await loadConfig(undefined, undefined, root, { projectRootOnly: true })).sync);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
