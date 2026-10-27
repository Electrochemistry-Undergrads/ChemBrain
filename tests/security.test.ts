import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, setupEnv } from './helpers';
import type { Env } from '../server/env';
import { encryptSecret, redact } from '../server/crypto/secrets';
import { loadConnectorContext } from '../server/connectors';

let env: Env;
let dispose: () => Promise<void>;
const alice = () => new Client(env);

beforeAll(async () => {
  ({ env, dispose } = await setupEnv());
});
afterAll(() => dispose());

describe('authentication', () => {
  it('requires sign-in for private endpoints', async () => {
    const c = alice();
    expect((await c.call('GET', '/api/projects')).status).toBe(401);
  });
  it('signs up, rejects bad passwords, and sets a secure session cookie', async () => {
    const c = alice();
    expect((await c.call('POST', '/api/auth/signup', { username: 'weak', password: 'short' })).status).toBe(400);
    expect((await c.call('POST', '/api/auth/signup', { username: 'name@example.com', password: 'long-enough-pw' })).status).toBe(400);
    const r = await c.signup('auth_user');
    expect(r.status).toBe(201);
    expect(r.headers.get('set-cookie')).toMatch(/__Host-cb_session=.*HttpOnly; Secure; SameSite=Lax/);
    expect((await c.call('GET', '/api/auth/me')).data.user.username).toBe('auth_user');
    const bad = new Client(env);
    expect((await bad.call('POST', '/api/auth/login', { username: 'auth_user', password: 'wrong-password' })).status).toBe(401);
    expect((await bad.call('POST', '/api/auth/login', { username: 'auth_user', password: 'correct-horse-battery' })).status).toBe(200);
    await c.call('POST', '/api/auth/logout');
    expect((await c.call('GET', '/api/projects')).status).toBe(401);
  });
  it('blocks cross-site state changes', async () => {
    const c = alice();
    await c.signup('csrf_user');
    const r = await c.call('POST', '/api/projects', { name: 'x' }, { origin: 'https://evil.example', 'x-chembrain': '' });
    expect(r.status).toBe(403);
  });
});

describe('cross-user isolation', () => {
  it('prevents one user from reading or changing another user’s data through guessed ids, search, exports, and evidence', async () => {
    const a = alice();
    await a.signup('owner_a');
    const b = new Client(env);
    await b.signup('intruder_b');
    const demo = await a.call('POST', '/api/projects/demo');
    const pid = demo.data.project.id;
    const papers = (await a.call('GET', `/api/projects/${pid}/papers`)).data.papers;
    expect(papers.length).toBe(4);
    const paperId = papers[0].id;
    // Insert a document/chunk/evidence row for A directly to probe evidence endpoints.
    const now = new Date().toISOString();
    const ownerA = (await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind('owner_a').first<{ id: string }>())!.id;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO documents (id, paper_id, project_id, owner_id, connector, format, content_sha256, completeness, identity_json, char_count, section_count, retrieved_at) VALUES ('doc_a', ?, ?, ?, 'test', 'jats', 'x', 'complete', '{}', 10, 1, ?)").bind(paperId, pid, ownerA, now),
      env.DB.prepare("INSERT INTO chunks (id, document_id, paper_id, project_id, owner_id, seq, kind, text) VALUES ('chk_a', 'doc_a', ?, ?, ?, 0, 'methods', 'Secret glycerol method at 40 °C.')").bind(paperId, pid, ownerA),
      env.DB.prepare("INSERT INTO evidence (id, project_id, paper_id, document_id, chunk_id, owner_id, category, subject, quote, quote_match, created_at) VALUES ('ev_a', ?, ?, 'doc_a', 'chk_a', ?, 'condition', 'drying', 'Secret glycerol method at 40 °C.', 'exact', ?)").bind(pid, paperId, ownerA, now),
    ]);
    const probes: [string, string, unknown?][] = [
      ['GET', `/api/projects/${pid}`],
      ['GET', `/api/projects/${pid}/papers`],
      ['GET', `/api/projects/${pid}/papers/${paperId}/document`],
      ['GET', `/api/projects/${pid}/chunks/chk_a`],
      ['GET', `/api/projects/${pid}/evidence`],
      ['GET', `/api/projects/${pid}/report`],
      ['GET', `/api/projects/${pid}/export.json`],
      ['GET', `/api/projects/${pid}/export.md`],
      ['GET', `/api/projects/${pid}/questions`],
      ['POST', `/api/projects/${pid}/questions`, { question: 'What glycerol method was used?' }],
      ['PATCH', `/api/projects/${pid}`, { name: 'hijacked' }],
      ['PATCH', `/api/projects/${pid}/papers/${paperId}`, { selected: false }],
      ['DELETE', `/api/projects/${pid}/papers/${paperId}`],
      ['POST', `/api/projects/${pid}/jobs`],
      ['POST', `/api/projects/${pid}/discover`],
      ['DELETE', `/api/projects/${pid}`],
    ];
    for (const [m, path, body] of probes) {
      const r = await b.call(m, path, body);
      expect(r.status, `${m} ${path}`).toBe(404);
      expect(r.text).not.toContain('Secret glycerol');
    }
    // B's own listings never include A's project.
    expect((await b.call('GET', '/api/projects')).data.projects).toEqual([]);
    // A's own chunk lookup within a project B created also fails (project id + owner must both match).
    const bp = (await b.call('POST', '/api/projects', { name: 'mine' })).data.project.id;
    expect((await b.call('GET', `/api/projects/${bp}/chunks/chk_a`)).status).toBe(404);
    // A still has everything.
    expect((await a.call('GET', `/api/projects/${pid}/chunks/chk_a`)).data.chunk.text).toContain('Secret glycerol');
    expect((await a.call('GET', `/api/projects/${pid}`)).data.project.name).not.toBe('hijacked');
  });
});

describe('credentials', () => {
  it('does not mark an all-warning upstream outage as a verified connection', async () => {
    const upstream = (async () => new Response('', { status: 500, headers: { 'retry-after': '99' } })) as typeof fetch;
    const a = new Client(env, upstream);
    await a.signup('outage_creds');
    await a.call('PUT', '/api/connections/elsevier', { secrets: { apiKey: 'outage-test-key-not-real' } });
    const result = await a.call('POST', '/api/connections/elsevier/test');
    expect(result.status).toBe(200);
    expect(result.data.ok).toBe(false);
    expect(result.data.checks.every((c: any) => c.status === 'warn')).toBe(true);
    expect(result.text).not.toContain('outage-test-key-not-real');
  });
  it('merges partial credential updates, keeps blank saved fields, and clears stale tests', async () => {
    const a = alice();
    await a.signup('partial_creds');
    const userId = (await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind('partial_creds').first<{ id: string }>())!.id;
    expect((await a.call('PUT', '/api/connections/elsevier', { secrets: { apiKey: 'original-key', instToken: 'original-token' } })).status).toBe(200);
    expect((await a.call('PUT', '/api/connections/elsevier', { secrets: { instToken: 'new-token' } })).status).toBe(200);
    expect((await loadConnectorContext(env, userId)).creds.elsevier).toEqual({ apiKey: 'original-key', instToken: 'new-token' });
    expect((await a.call('PUT', '/api/connections/elsevier', { secrets: { apiKey: 'new-key', instToken: '' } })).status).toBe(200);
    expect((await loadConnectorContext(env, userId)).creds.elsevier).toEqual({ apiKey: 'new-key', instToken: 'new-token' });
    await env.DB.prepare("UPDATE connections SET last_test_at = '2026-01-01', last_test_json = '{}' WHERE owner_id = ?").bind(userId).run();
    expect((await a.call('PUT', '/api/connections/elsevier', { settings: { aiProcessingAttested: true } })).status).toBe(200);
    const connection = (await a.call('GET', '/api/connections')).data.connections.find((c: any) => c.provider === 'elsevier');
    expect(connection.lastTest).toBeNull();
    expect(connection.lastTestAt).toBeNull();
  });
  it('accepts only the active Springer OA field and preserves it on blank updates', async () => {
    const a = alice();
    await a.signup('springer_creds');
    const userId = (await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind('springer_creds').first<{ id: string }>())!.id;
    expect((await a.call('PUT', '/api/connections/springer', { secrets: { openAccessApiKey: 'oa-secret-key' } })).status).toBe(200);
    expect((await a.call('PUT', '/api/connections/springer', { secrets: { metaApiKey: 'meta-secret-key', openAccessApiKey: '', fullTextApiKey: 'full-secret/metric' } })).status).toBe(200);
    expect((await loadConnectorContext(env, userId)).creds.springer).toEqual({ openAccessApiKey: 'oa-secret-key' });
    const listing = await a.call('GET', '/api/connections');
    expect(listing.text).not.toContain('secret-key');
    expect(listing.text).not.toContain('full-secret');
    expect(listing.data.connections.find((c: any) => c.provider === 'springer').savedFields).toEqual(['openAccessApiKey']);
  });
  it('uses an existing shared Springer key for OA without activating removed API scopes', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      expect(url.searchParams.get('api_key')).toBe('legacy-key-not-real');
      return new Response('<response><records><article><body/></article></records></response>');
    }) as typeof fetch;
    const a = new Client(env, fetchImpl);
    await a.signup('legacy_springer');
    const userId = (await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind('legacy_springer').first<{ id: string }>())!.id;
    const cipher = await encryptSecret(env.CREDENTIALS_KEY!, userId, 'springer', JSON.stringify({ apiKey: 'legacy-key-not-real', metaApiKey: 'removed-meta-key', fullTextApiKey: 'removed-full-key/metric' }));
    await env.DB.prepare('INSERT INTO connections (id, owner_id, provider, secret_ciphertext, secret_iv, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind('legacy_springer_connection', userId, 'springer', cipher.ciphertext, cipher.iv, JSON.stringify({ savedFields: ['apiKey', 'metaApiKey', 'fullTextApiKey'], fullTextAgreement: true, aiProcessingAttested: true }), '2026-10-27', '2026-10-27').run();
    const context = await loadConnectorContext(env, userId);
    expect(context.creds.springer).toEqual({ openAccessApiKey: 'legacy-key-not-real' });
    expect(context.settings.springer).toEqual({ fullTextAgreement: false, aiProcessingAttested: false });
    const test = await a.call('POST', '/api/connections/springer/test');
    expect(test.data.ok).toBe(true);
    expect(test.data.checks.map((c: any) => c.name)).toEqual(['Open Access full text']);
    expect(calls).toEqual(['/openaccess/jats']);
    expect((await a.call('PUT', '/api/connections/springer', { secrets: { openAccessApiKey: 'replacement-oa-key' } })).status).toBe(200);
    expect((await a.call('GET', '/api/connections')).data.connections.find((c: any) => c.provider === 'springer').savedFields).toEqual(['openAccessApiKey']);
  });
  it('stores publisher credentials encrypted, never returns them, and supports revocation', async () => {
    const a = alice();
    await a.signup('cred_user');
    const secret = 'ELSKEY_abcdefghijklmnop123456';
    expect((await a.call('PUT', '/api/connections/elsevier', { secrets: { apiKey: secret, instToken: 'INST_zyxwvutsrqponm98765' }, settings: { aiProcessingAttested: false } })).status).toBe(200);
    const row = await env.DB.prepare("SELECT secret_ciphertext, settings_json FROM connections WHERE provider = 'elsevier'").first<{ secret_ciphertext: string; settings_json: string }>();
    expect(row!.secret_ciphertext).not.toContain('ELSKEY');
    expect(row!.settings_json).not.toContain('ELSKEY');
    const list = await a.call('GET', '/api/connections');
    expect(list.text).not.toContain(secret);
    expect(list.data.connections.find((c: any) => c.provider === 'elsevier').configured).toBe(true);
    // Another user cannot use or see it.
    const b = new Client(env);
    await b.signup('cred_other');
    expect((await b.call('GET', '/api/connections')).data.connections.every((c: any) => !c.configured)).toBe(true);
    // Ciphertext moved to another user's row does not decrypt (bound to user and provider).
    expect((await a.call('DELETE', '/api/connections/elsevier')).status).toBe(200);
    expect((await a.call('GET', '/api/connections')).data.connections.find((c: any) => c.provider === 'elsevier').configured).toBe(false);
  });
  it('refuses to store credentials when the encryption key is not configured', async () => {
    const { env: e2, dispose: d2 } = await setupEnv({ CREDENTIALS_KEY: undefined });
    const c = new Client(e2);
    await c.signup('nokey_user');
    expect((await c.call('PUT', '/api/connections/wiley', { secrets: { tdmToken: 'abcdefabcdef' } })).status).toBe(503);
    await d2();
  });
  it('redacts known secrets and credential-shaped strings', () => {
    const s = redact('upstream said apiKey=ABCDEF1234567890XYZ and Bearer LLM_123_placeholder_value_for_test; token mykey-very-secret-1', ['mykey-very-secret-1']);
    expect(s).not.toContain('ABCDEF1234567890XYZ');
    expect(s).not.toContain('placeholder_value_for_test');
    expect(s).not.toContain('mykey-very-secret-1');
  });
});

describe('sign-in rate limiting', () => {
  it('limits repeated sign-up attempts from one address', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await new Client(env).call('POST', '/api/auth/signup', { username: `rl_user_${i}`, password: 'correct-horse-battery' }, { 'cf-connecting-ip': '192.0.2.1' });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 201)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});

describe('guest workspaces (no sign-in page)', () => {
  it('gives each browser its own private workspace that others cannot reach', async () => {
    const g1 = new Client(env);
    const r1 = await g1.call('POST', '/api/auth/guest', undefined, { 'cf-connecting-ip': '198.51.100.7' });
    expect(r1.status).toBe(201);
    expect(r1.data.user.guest).toBe(true);
    expect(r1.headers.get('set-cookie')).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    // Calling again with the same session returns the same workspace instead of a new one.
    expect((await g1.call('POST', '/api/auth/guest')).data.user.username).toBe(r1.data.user.username);
    const pid = (await g1.call('POST', '/api/projects', { name: 'guest project' })).data.project.id;
    const g2 = new Client(env);
    await g2.call('POST', '/api/auth/guest', undefined, { 'cf-connecting-ip': '198.51.100.8' });
    expect((await g2.call('GET', `/api/projects/${pid}`)).status).toBe(404);
    expect((await g2.call('GET', '/api/projects')).data.projects).toEqual([]);
    // Guests have no usable password.
    const login = await new Client(env).call('POST', '/api/auth/login', { username: r1.data.user.username, password: 'anything-at-all' });
    expect(login.status).toBe(401);
  });
  it('reserves the guest- prefix for named accounts', async () => {
    const r = await new Client(env).call('POST', '/api/auth/signup', { username: 'guest-abc', password: 'correct-horse-battery' }, { 'cf-connecting-ip': '198.51.100.9' });
    expect(r.status).toBe(400);
  });
});
