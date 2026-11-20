// Print the dist hash exactly as the build computes it; deploy.sh compares it
// against the manifest so a modified dist/ can never be uploaded.
import { hashDist } from '../build/outputs.ts';
import { loadConfig, repoPath, ROOT } from '../core/config.ts';
import { argPath, fatal } from '../core/util.ts';

const arg = process.argv[2];
const dir = arg !== undefined ? argPath('<dir>', arg, ROOT) : repoPath((await loadConfig().catch(fatal)).outDir);
process.stdout.write(hashDist(dir));
