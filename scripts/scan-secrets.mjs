// Pre-push secret scan: checks every file git would commit (tracked + staged + untracked, minus
// ignored) and the built site for credentials, private keys, and email addresses.
// Usage: node scripts/scan-secrets.mjs   (exit code 1 on findings)
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const files = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' }).split('\n').filter(Boolean);
const forbiddenNames = [
  /^\.dev\.vars(?:\.|$)/, /^\.deploy\.env$/, /^\.env(?:\..+)?$/,
  /^\.(?:npmrc|netrc)$/, /\.(?:pem|key|p12|pfx)$/i, /^id_(?:rsa|ed25519|ecdsa)$/,
  /\.(?:log|db|sqlite|sqlite3)(?:-(?:wal|shm))?$/i,
];
const patterns = [
  ['Meta API key', /LLM_\d{3,}[A-Za-z0-9_-]{16,}/],
  ['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Cloudflare token assignment', /CLOUDFLARE_API_TOKEN\s*=\s*[A-Za-z0-9_-]{20,}/],
  ['Generic secret assignment', /(MODEL_API_KEY|CREDENTIALS_KEY|ELSEVIER_API_KEY|ELSEVIER_INSTTOKEN|WILEY_TDM_TOKEN|SPRINGER_(?:API_KEY|META_API_KEY|OA_API_KEY|FULLTEXT_API_KEY))[\t ]*=[\t ]*['"]?[A-Za-z0-9+/_=-]{12,}/],
  ['Bearer token', /Bearer\s+[A-Za-z0-9._-]{30,}/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['Email address', /[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com)[A-Za-z0-9-]+\.[A-Za-z.]{2,}/],
];
// Email addresses are allowed only in these files (placeholders / documentation of formats).
const emailAllowed = new Set(['scripts/scan-secrets.mjs', 'package-lock.json']);
const findings = [];
const scan = (path, text) => {
  for (const [name, re] of patterns) {
    if (name === 'Email address' && emailAllowed.has(path)) continue;
    // The server bundle is never served publicly (Pages does not expose _worker.js), and minified
    // code produces random "a@b.cd"-like strings; credential patterns still apply to it.
    if (name === 'Email address' && path.includes('_worker.js')) continue;
    const m = re.exec(text);
    if (m && !/example|placeholder|test-key-not-real|LLM_1_x\b/i.test(m[0])) findings.push(`${path}: ${name}`);
  }
};
for (const f of files) {
  const name = f.split('/').pop();
  if (name !== '.env.example' && forbiddenNames.some((re) => re.test(name))) findings.push(`${f}: file must not be committed`);
  if (!existsSync(f) || statSync(f).size > 5_000_000) continue;
  if (f.startsWith('server/demo/')) continue; // CC BY article text; emails were stripped at generation time and are tested
  scan(f, readFileSync(f, 'utf8'));
}
if (existsSync('dist')) {
  const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  for (const f of walk('dist')) if (/\.(js|html|css|json|txt)$/.test(f)) scan(f, readFileSync(f, 'utf8'));
}
if (findings.length) {
  console.error('Secret scan FAILED:\n' + [...new Set(findings)].map((x) => '  - ' + x).join('\n'));
  process.exit(1);
}
console.log(`Secret scan passed (${files.length} files${existsSync('dist') ? ' + dist' : ''}).`);
