// The git mirror: real repositories, offline (local path remotes). The flows
// the serving daemon depends on — clone-on-empty, no-op poll, update,
// dirty-tree refusal, unreachable remote — plus the validation of `sync`.
import { test, suite, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { GitSync } from '../src/sync/git.ts';
import { loadConfig } from '../src/core/config.ts';
import { cleanupTmpDirs, tmpDir } from './helpers.ts';

after(() => cleanupTmpDirs());

// Carries an identity: CI runners configure no global git user, and a
// pull --rebase commits even when no explicit commit is asked for.
const git = (args: string[], cwd: string): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).toString();

function commit(repo: string, file: string, text: string): void {
  fs.writeFileSync(path.join(repo, file), text);
  git(['add', file], repo);
  git(['commit', '-m', `update ${file}`], repo);
}

/** A bare remote plus a seeded clone with one pushed commit; returns [remote, seed]. */
function makeRemote(): [string, string] {
  const remote = tmpDir('sync-remote-');
  fs.rmdirSync(remote);
  git(['init', '--bare', '-b', 'master', remote], path.dirname(remote));
  const seed = tmpDir('sync-seed-');
  fs.rmdirSync(seed);
  git(['clone', remote, seed], path.dirname(seed));
  commit(seed, 'note.md', 'one\n');
  git(['push', '-u', 'origin', 'master'], seed);
  return [remote, seed];
}

const syncIn = (dir: string, remote: string): GitSync => new GitSync({ dir, remote, branch: 'master' });

test('clones into an empty target and refuses a non-repo directory', async () => {
  const [remote] = makeRemote();
  const dir = path.join(tmpDir('sync-work-'), 'notes');
  assert.equal(await syncIn(dir, remote).ensureCloned(), true);
  assert.ok(fs.existsSync(path.join(dir, 'note.md')));
  assert.equal(await syncIn(dir, remote).ensureCloned(), false, 'already a repo');

  const junk = tmpDir('sync-junk-');
  fs.writeFileSync(path.join(junk, 'x'), 'not a repo');
  await assert.rejects(syncIn(junk, remote).ensureCloned(), /not a git repository/);
});

test('poll outcome: no-op when up to date, reset when the tip moved', async () => {
  const [remote, seed] = makeRemote();
  const dir = path.join(tmpDir('sync-work-'), 'notes');
  await syncIn(dir, remote).ensureCloned();

  const s = syncIn(dir, remote);
  assert.equal((await s.sync()).changed, false);

  commit(seed, 'note.md', 'two\n');
  git(['push'], seed);
  assert.equal((await s.sync()).changed, true);
  assert.equal(fs.readFileSync(path.join(dir, 'note.md'), 'utf8'), 'two\n');

  // Every operation goes through the configured remote URL, and the clone
  // carries no origin at all (a token in it would sit in .git/config).
  assert.equal(git(['remote'], dir), '');
  commit(seed, 'note.md', 'three\n');
  git(['push'], seed);
  assert.equal((await s.sync()).changed, true);
  assert.equal(fs.readFileSync(path.join(dir, 'note.md'), 'utf8'), 'three\n');
});

test('local modifications are discarded by the unconditional reset; untracked files survive', async () => {
  const [remote, seed] = makeRemote();
  const dir = path.join(tmpDir('sync-work-'), 'notes');
  await syncIn(dir, remote).ensureCloned();

  commit(seed, 'note.md', 'two\n');
  git(['push'], seed);

  // The build's abbrlink write-backs look exactly like this: a tracked file
  // modified locally. The mirror must still follow the remote.
  fs.writeFileSync(path.join(dir, 'note.md'), 'a local edit to a tracked file\n');
  assert.equal((await syncIn(dir, remote).sync()).changed, true);
  assert.equal(fs.readFileSync(path.join(dir, 'note.md'), 'utf8'), 'two\n');

  // Untracked files survive: the mirror never runs git clean.
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'keep me\n');
  commit(seed, 'note.md', 'three\n');
  git(['push'], seed);
  await syncIn(dir, remote).sync();
  assert.equal(fs.readFileSync(path.join(dir, 'note.md'), 'utf8'), 'three\n');
  assert.ok(fs.existsSync(path.join(dir, 'untracked.txt')));
});

test('commitAndPush pins exactly the written files; a lost race drops the commit', async () => {
  const [remote, seed] = makeRemote();
  const dir = path.join(tmpDir('sync-work-'), 'notes');
  const s = syncIn(dir, remote);
  await s.ensureCloned();

  assert.equal(await s.commitAndPush([path.join(dir, 'note.md')], 'test pin'), 'nothing', 'unmodified file');

  // A build-style write-back: a tracked file modified locally.
  fs.writeFileSync(path.join(dir, 'note.md'), 'one\nabbrlink: "deadbeef"\n');
  assert.equal(await s.commitAndPush([path.join(dir, 'note.md')], 'test pin'), 'pushed');
  assert.match(git(['log', '-1', '--format=%s', 'master'], remote), /test pin/);

  // Race: the remote moves while the mirror pins on the old tip. The push is
  // rejected, the pin commit is dropped onto the remote's newer tip.
  commit(seed, 'other.md', 'unrelated\n');
  git(['pull', '--rebase', 'origin', 'master'], seed);
  git(['push'], seed);
  fs.writeFileSync(path.join(dir, 'note.md'), 'one\nabbrlink: "deadbeef"\nagain\n');
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'never committed\n');
  assert.equal(await s.commitAndPush([path.join(dir, 'note.md')], 'test pin 2'), 'dropped');
  assert.equal(fs.readFileSync(path.join(dir, 'note.md'), 'utf8'), 'one\nabbrlink: "deadbeef"\n');
  assert.ok(fs.existsSync(path.join(dir, 'untracked.txt')), 'untracked files stay untracked');
  assert.match(git(['log', '--format=%s', 'master'], remote), /test pin/);
  assert.doesNotMatch(git(['log', '--format=%s', 'master'], remote), /test pin 2/);
});

test('a hook-declined push is a hard failure, not a race; the commit is undone', async () => {
  const [remote, seed] = makeRemote();
  // Reject every push from here on (a protected branch behaves the same).
  fs.writeFileSync(path.join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n');
  fs.chmodSync(path.join(remote, 'hooks', 'pre-receive'), 0o755);
  const dir = path.join(tmpDir('sync-work-'), 'notes');
  const s = syncIn(dir, remote);
  await s.ensureCloned();

  fs.writeFileSync(path.join(dir, 'note.md'), 'one\nabbrlink: "deadbeef"\n');
  await assert.rejects(s.commitAndPush([path.join(dir, 'note.md')], 'test pin'), /git push failed/);
  // The local commit is rolled back to the remote tip: no rebuild loop can
  // form around a persistently failing push.
  assert.equal(fs.readFileSync(path.join(dir, 'note.md'), 'utf8'), 'one\n');
  assert.equal(git(['log', '--oneline'], dir).trim(), git(['log', '--oneline'], seed).trim());
});

test('an unreachable remote and a missing branch fail loudly, not silently', async () => {
  const gone = path.join(tmpDir('sync-gone-'), 'nope.git');
  const dir = path.join(tmpDir('sync-work-'), 'notes');
  await assert.rejects(syncIn(dir, gone).sync(), /git ls-remote failed/);

  const emptyRemote = tmpDir('sync-empty-');
  fs.rmdirSync(emptyRemote);
  git(['init', '--bare', '-b', 'master', emptyRemote], path.dirname(emptyRemote));
  const target = path.join(tmpDir('sync-work-'), 'notes2');
  await assert.rejects(syncIn(target, emptyRemote).ensureCloned(), /git clone failed/);
});

suite('sync config validation', () => {
  const profile = (body: string): string => {
    const f = path.join(tmpDir('sync-cfg-'), 'profile.mjs');
    fs.writeFileSync(f, `export default { url: 'https://e.com', siteName: 't', ${body} };\n`);
    return f;
  };

  test('remote is required; interval has a floor; scalars are rejected; proxy is a string', async () => {
    await assert.rejects(loadConfig(profile('sync: { branch: "master" }')), /sync\.remote/);
    await assert.rejects(loadConfig(profile('sync: { remote: "x", intervalSec: 1 }')), /intervalSec/);
    await assert.rejects(loadConfig(profile('sync: { remote: "x", proxy: 8080 }')), /sync\.proxy/);
    await assert.rejects(loadConfig(profile('sync: "ssh://x"')), /sync must be an object/);
    const ok = await loadConfig(profile("sync: { remote: 'x', proxy: 'http://127.0.0.1:7890' }"));
    assert.equal(ok.sync?.proxy, 'http://127.0.0.1:7890');
  });

  test('branch and intervalSec default, and the merged config is usable', async () => {
    const cfg = await loadConfig(profile('sync: { remote: "ssh://git@x/notes.git" }'));
    assert.equal(cfg.sync?.branch, 'master');
    assert.equal(cfg.sync?.intervalSec, 15);
  });
});
