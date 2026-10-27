import { getPlatformProxy } from 'wrangler';
import { readFileSync, readdirSync } from 'node:fs';
import type { Env } from '../server/env';
import { handleApi } from '../server/api/router';

/** Real local D1 (workerd/SQLite) with the app's migrations applied, isolated per test file. */
export async function setupEnv(extra: Partial<Env> = {}) {
  const proxy = await getPlatformProxy<Env>({ configPath: 'wrangler.toml', persist: false });
  const env = { ...proxy.env, CREDENTIALS_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))), PASSWORD_ITERATIONS: '1000', ...extra } as Env;
  for (const f of readdirSync('migrations').sort()) {
    const sql = readFileSync(`migrations/${f}`, 'utf8').replace(/--.*$/gm, '');
    for (const stmt of sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) await env.DB.prepare(stmt).run();
  }
  return { env, dispose: () => proxy.dispose() };
}

/** Default fetch for tests: any unexpected network call fails loudly instead of reaching a real service. */
export const offline = (async (input: RequestInfo | URL) => {
  throw new Error(`Unexpected network call in test: ${String(input).split('?')[0]}`);
}) as typeof fetch;

export class Client {
  cookie = '';
  constructor(private env: Env, private fetchImpl: typeof fetch = offline) {}
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const init: RequestInit = { method, headers: { 'x-chembrain': '1', origin: 'https://chembrain.test', cookie: this.cookie, ...headers } };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)['content-type'] = 'application/json';
    }
    const res = await handleApi(new Request(`https://chembrain.test${path}`, init), this.env, this.fetchImpl);
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON (exports) */
    }
    return { status: res.status, data, text, headers: res.headers };
  }
  async signup(username: string) {
    // Distinct client IP per test user so the per-IP sign-up limit does not interfere.
    return this.call('POST', '/api/auth/signup', { username, password: 'correct-horse-battery' }, { 'cf-connecting-ip': `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
  }
}
