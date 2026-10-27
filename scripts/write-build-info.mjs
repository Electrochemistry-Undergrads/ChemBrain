// Writes public/build-info.json so the deployed release can be identified without secrets.
// Cloudflare Pages sets CF_PAGES_COMMIT_SHA and CF_PAGES_BRANCH during builds.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

let commit = process.env.CF_PAGES_COMMIT_SHA || '';
if (!commit) {
  try {
    commit = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    commit = 'unknown';
  }
}
const info = { app: 'chembrain', commit, branch: process.env.CF_PAGES_BRANCH || 'local', builtAt: new Date().toISOString() };
writeFileSync('public/build-info.json', JSON.stringify(info, null, 2) + '\n');
console.log('build-info', info.commit.slice(0, 12), info.branch);
