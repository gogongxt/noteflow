// The serving host is the only machine that runs builds, so it is also the
// only one that can pin abbrlinks into the repository: after a successful
// build, commit exactly the files the build wrote (listed in the manifest —
// never anything else) and push. Returns true when a lost push race asks for
// one rebuild to retry.
import fs from 'node:fs';
import path from 'node:path';
import type { GitSync } from './git.ts';

export async function pushAbbrlinkPins(opts: {
  sync: GitSync;
  manifestFile: string;
  contentDir: string;
  log: (msg: string) => void;
}): Promise<boolean> {
  let manifest: { abbrlinkWrites?: string[] };
  try {
    manifest = JSON.parse(fs.readFileSync(opts.manifestFile, 'utf8'));
  } catch {
    return false;
  }
  let files = (manifest.abbrlinkWrites ?? []).map((rel) => path.join(opts.contentDir, rel));
  if (!files.length) return false;
  const present = files.filter((f) => fs.existsSync(f));
  if (present.length < files.length) {
    // A sync reset ran between build and pin; the vanished notes' pins
    // regenerate on their next build.
    opts.log(`sync: ${files.length - present.length} pinned file(s) vanished before the push; pinning the rest`);
    files = present;
    if (!files.length) return false;
  }
  const res = await opts.sync.commitAndPush(files, `noteflow: assign ${files.length} abbrlink(s)`);
  if (res === 'pushed') opts.log(`sync: pinned ${files.length} abbrlink(s), pushed`);
  if (res === 'dropped') {
    opts.log('sync: pin push lost a race to a newer commit; rebuilding to retry');
    return true;
  }
  return false;
}
