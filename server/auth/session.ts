import type { Env } from '../env';
import { ApiError } from '../http/respond';
import { b64encode, nowIso, sha256Hex } from '../util';

const COOKIE = '__Host-cb_session';
const SESSION_DAYS = 14;

export interface AuthUser {
  id: string;
  username: string;
}

export async function createSession(env: Env, userId: string, days = SESSION_DAYS) {
  const token = b64encode(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]!);
  const expires = new Date(Date.now() + days * 86400_000);
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), userId, nowIso(), expires.toISOString())
    .run();
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expires.toUTCString()}`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function readToken(req: Request) {
  const cookie = req.headers.get('cookie') || '';
  for (const part of cookie.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === COOKIE) return part.slice(i + 1);
  }
  return null;
}

export async function getUser(env: Env, req: Request): Promise<AuthUser | null> {
  const token = readToken(req);
  if (!token || token.length < 20) return null;
  const row = await env.DB.prepare(
    'SELECT u.id, u.username, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
  )
    .bind(await sha256Hex(token))
    .first<{ id: string; username: string; expires_at: string }>();
  if (!row || row.expires_at < nowIso()) return null;
  return { id: row.id, username: row.username };
}

export async function destroySession(env: Env, req: Request) {
  const token = readToken(req);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
}

export async function requireUser(env: Env, req: Request) {
  const u = await getUser(env, req);
  if (!u) throw new ApiError(401, 'unauthenticated', 'Please sign in.');
  return u;
}

/**
 * Cross-site request protection for state-changing requests: the browser must send the same
 * origin and our custom header (which cross-origin forms cannot set without a CORS preflight).
 */
export function checkCsrf(req: Request) {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const origin = req.headers.get('origin');
  const self = new URL(req.url).origin;
  if ((origin && origin !== self) || req.headers.get('x-chembrain') !== '1') {
    throw new ApiError(403, 'csrf', 'This request was blocked because it did not come from the ChemBrain app.');
  }
}

/** Fixed-window limiter stored in D1, used for sign-in and sign-up attempts. */
export async function rateLimit(env: Env, key: string, limit: number, windowSec: number) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, window_start) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start + ?3 <= ?2 THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start + ?3 <= ?2 THEN ?2 ELSE rate_limits.window_start END
     RETURNING count`,
  )
    .bind(key, now, windowSec)
    .first<{ count: number }>();
  if (row && row.count > limit) throw new ApiError(429, 'rate_limited', 'Too many attempts. Please wait a few minutes and try again.');
}
