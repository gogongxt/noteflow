import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeAssetNamer } from '../src/render/attachments.ts';
import { cleanupTmpDirs, tmpDir, writeFile } from './helpers.ts';

test('assets: media extensions are publishable, other types still refuse', async () => {
  const root = tmpDir('assets-media-');
  writeFile(root, 'clip.mp4', 'x');
  writeFile(root, 'song.mp3', 'y');
  writeFile(root, 'subs.vtt', 'WEBVTT\n');
  writeFile(root, 'evil.html', '<script>');
  writeFile(root, 'evil.exe', 'MZ');
  // js/css publish too — the widget channel (2026-11-21); executables and
  // arbitrary documents still refuse.
  writeFile(root, 'widget.js', '1');
  writeFile(root, 'widget.css', '.w-x{}');
  const namer = makeAssetNamer(fs.realpathSync(root));
  assert.match(namer.assign('p', 'clip.mp4'), /\.mp4$/);
  assert.match(namer.assign('p', 'song.mp3'), /\.mp3$/);
  assert.match(namer.assign('p', 'subs.vtt'), /\.vtt$/);
  assert.match(namer.assign('p', 'widget.js'), /\.js$/);
  assert.match(namer.assign('p', 'widget.css'), /\.css$/);
  assert.throws(() => namer.assign('p', 'evil.html'), /not allowed/);
  assert.throws(() => namer.assign('p', 'evil.exe'), /not allowed/);
  cleanupTmpDirs();
});

test('assets: attachment URLs embed the content hash', () => {
  const root = tmpDir('assets-root-');
  writeFile(root, 'a.png', 'one');
  const realRoot = fs.realpathSync(root);
  const namer = makeAssetNamer(realRoot);
  const url = namer.assign('p', 'a.png');
  assert.match(url, /^assets\/p\/a\.[0-9a-f]{8}\.png$/);

  // Same bytes, same URL: a rebuild does not bust the browser cache.
  assert.equal(makeAssetNamer(realRoot).assign('p', 'a.png'), url);

  // Replacing the file in place must change the URL, or `immutable` would
  // serve the old bytes forever.
  writeFile(root, 'a.png', 'two');
  assert.notEqual(makeAssetNamer(realRoot).assign('p', 'a.png'), url);

  cleanupTmpDirs();
});

test('assets: same-named files from different directories stay distinct', () => {
  const root = tmpDir('assets-root-');
  writeFile(root, 'x/img/a.png', 'x-bytes');
  writeFile(root, 'y/img/a.png', 'y-bytes');
  const namer = makeAssetNamer(fs.realpathSync(root));
  const a = namer.assign('p', 'x/img/a.png');
  const b = namer.assign('p', 'y/img/a.png');
  assert.notEqual(a, b);
  assert.match(a, /a\.[0-9a-f]{8}\.png$/);
  assert.match(b, /a\.[0-9a-f]{8}\.png$/);
  cleanupTmpDirs();
});
