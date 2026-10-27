import { config } from '../env';
import { hashPassword, validateNewPassword, validateUsername, verifyPassword } from '../auth/password';
import { clearCookie, createSession, destroySession, getUser, rateLimit } from '../auth/session';
import { ApiError, json } from '../http/respond';
import { b64encode, newId, nowIso } from '../util';
import type { Route } from './router';

function clientKey(req: Request) {
  return req.headers.get('cf-connecting-ip') || 'local';
}

export const authRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/auth/me',
    public: true,
    handler: async ({ env, req }) => {
      const u = await getUser(env, req);
      return json({ user: u ? { username: u.username, guest: u.username.startsWith('guest-') } : null, signupOpen: config(env).allowSignup, guestsOpen: config(env).allowGuests });
    },
  },
  {
    // Private guest workspace for this browser: a real server-side account with an unguessable
    // session cookie and no password. Everything it creates is private to that session.
    method: 'POST',
    path: '/api/auth/guest',
    public: true,
    handler: async ({ env, req }) => {
      if (!config(env).allowGuests) throw new ApiError(403, 'guests_closed', 'Guest workspaces are not available right now.');
      const existing = await getUser(env, req);
      if (existing) return json({ user: { username: existing.username, guest: existing.username.startsWith('guest-') } });
      await rateLimit(env, `guest:${clientKey(req)}`, 30, 3600);
      const id = newId('usr');
      const username = `guest-${id.slice(-10)}`;
      // Unusable password: guests cannot sign in with a password, only with their session.
      const unusable = b64encode(crypto.getRandomValues(new Uint8Array(32)));
      await env.DB.prepare('INSERT INTO users (id, username, password_hash, password_salt, password_iterations, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, username, unusable, b64encode(crypto.getRandomValues(new Uint8Array(16))), config(env).passwordIterations, nowIso())
        .run();
      return json({ user: { username, guest: true } }, 201, { 'set-cookie': await createSession(env, id, 180) });
    },
  },
  {
    method: 'POST',
    path: '/api/auth/signup',
    public: true,
    handler: async ({ env, req, body }) => {
      if (!config(env).allowSignup) throw new ApiError(403, 'signup_closed', 'New accounts are not being accepted right now.');
      await rateLimit(env, `signup:${clientKey(req)}`, 5, 3600);
      const { username = '', password = '' } = await body<{ username?: string; password?: string }>();
      const uErr = validateUsername(username);
      if (uErr) throw new ApiError(400, 'bad_username', uErr);
      if (/^guest-/i.test(username)) throw new ApiError(400, 'bad_username', 'Usernames starting with “guest-” are reserved.');
      const pErr = validateNewPassword(password);
      if (pErr) throw new ApiError(400, 'bad_password', pErr);
      const exists = await env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(username).first();
      if (exists) throw new ApiError(409, 'username_taken', 'That username is taken.');
      const h = await hashPassword(password, config(env).passwordIterations);
      const id = newId('usr');
      await env.DB.prepare('INSERT INTO users (id, username, password_hash, password_salt, password_iterations, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, username, h.hash, h.salt, h.iterations, nowIso())
        .run();
      return json({ user: { username } }, 201, { 'set-cookie': await createSession(env, id) });
    },
  },
  {
    method: 'POST',
    path: '/api/auth/login',
    public: true,
    handler: async ({ env, req, body }) => {
      const { username = '', password = '' } = await body<{ username?: string; password?: string }>();
      await rateLimit(env, `login:${clientKey(req)}`, 20, 900);
      await rateLimit(env, `login-user:${username.toLowerCase()}`, 10, 900);
      const row = await env.DB.prepare('SELECT id, username, password_hash, password_salt, password_iterations FROM users WHERE username = ?')
        .bind(username)
        .first<{ id: string; username: string; password_hash: string; password_salt: string; password_iterations: number }>();
      // Hash even for unknown usernames so response time does not reveal which usernames exist.
      const stored = row ? { hash: row.password_hash, salt: row.password_salt, iterations: row.password_iterations } : { hash: 'x', salt: 'AAAAAAAAAAAAAAAAAAAAAA==', iterations: config(env).passwordIterations };
      const ok = (await verifyPassword(password, stored)) && row;
      if (!row || !ok) throw new ApiError(401, 'bad_credentials', 'Username or password is incorrect.');
      return json({ user: { username: row.username } }, 200, { 'set-cookie': await createSession(env, row.id) });
    },
  },
  {
    method: 'POST',
    path: '/api/auth/logout',
    public: true,
    handler: async ({ env, req }) => {
      await destroySession(env, req);
      return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
    },
  },
  {
    method: 'DELETE',
    path: '/api/account',
    handler: async ({ env, user, body }) => {
      const { confirm } = await body<{ confirm?: string }>();
      if (confirm !== user.username) throw new ApiError(400, 'confirm', 'Type your username to confirm account deletion.');
      // Cascades remove sessions, projects, papers, documents, chunks, evidence, reports, and credentials.
      const keys = await env.DB.prepare('SELECT storage_key FROM documents WHERE owner_id = ? AND storage_key IS NOT NULL').bind(user.id).all<{ storage_key: string }>();
      if (env.DOCS && keys.results.length) await env.DOCS.delete(keys.results.map((k) => k.storage_key));
      await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();
      return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
    },
  },
];
