// Print the dist hash exactly as the build computes it; deploy.sh compares it
// against the manifest so a modified dist/ can never be uploaded.
import path from 'node:path';
import { hashDist } from '../build/outputs.ts';
import { loadConfig } from '../core/config.ts';

const arg = process.argv[2];
const dir = path.resolve(arg || (await loadConfig()).outDir);
process.stdout.write(hashDist(dir));