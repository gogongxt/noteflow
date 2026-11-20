// Scaffold one note: frontmatter with a fresh date and abbrlink, saved into the
// content tree. The file it writes parses through the same frontmatter reader
// the build uses.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, BuildError, argPath, runCli } from '../core/util.ts';
import { computeAbbrlink } from '../content/abbrlink.ts';
import { parseNote } from '../content/frontmatter.ts';
import { loadConfig, repoPath, ROOT } from '../core/config.ts';

runCli(async () => {
  const args = parseArgs(process.argv.slice(2));
  const title = args._[0];
  if (!title) {
    console.error('Usage: node src/cli/new-post.ts "Title" [--dir subdir] [--public] [--date YYYY-MM-DD]');
    process.exit(1);
  }
  const contentRoot =
    typeof args.content === 'string' ? argPath('--content', args.content, ROOT) : repoPath((await loadConfig()).contentDir);
  const subDir = typeof args.dir === 'string' ? args.dir : '';
  const isPublic = args.public === true;
  // Local date; toISOString would slip a day past midnight in UTC+8.
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const date = typeof args.date === 'string' ? args.date : today;

  const dir = path.resolve(contentRoot, subDir);
  if (!dir.startsWith(path.resolve(contentRoot) + path.sep) && dir !== path.resolve(contentRoot)) {
    throw new BuildError(`Directory escapes the content root: ${subDir}`);
  }
  fs.mkdirSync(dir, { recursive: true });

  const safeName = String(title).replace(/[\\/:*?"<>|#]/g, '_').trim();
  if (!safeName) throw new BuildError(`Title has no usable characters for a filename: ${JSON.stringify(String(title))}`);
  let file = path.join(dir, `${safeName}.md`);
  let n = 2;
  while (fs.existsSync(file)) file = path.join(dir, `${safeName}-${n++}.md`);

  const abbrlink = computeAbbrlink(String(title), date);
  const fm = [
    '---',
    `title: ${JSON.stringify(String(title))}`,
    `date: ${date}`,
    isPublic ? 'public: true' : '# public: true  # flip on when ready to publish',
    `abbrlink: "${abbrlink}"`,
    '---',
    '',
    '',
  ].join('\n');
  fs.writeFileSync(file, fm);

  const rel = path.relative(contentRoot, file).split(path.sep).join('/');
  console.log(`✓ Created ${rel}`);
  console.log(`  URL: /posts/${abbrlink} ${isPublic ? '' : '(private for now; set public: true to publish)'}`);
  console.log(`  To pin its sort order, add the node below to ${path.relative(contentRoot, path.join(dir, 'sort.txt')) || 'sort.txt'}`);
  console.log(`  ${safeName}`);

  const parsed = parseNote(fs.readFileSync(file, 'utf8'));
  if (parsed.error || String(parsed.data?.abbrlink) !== abbrlink) throw new BuildError('Generated file failed to parse');
});
