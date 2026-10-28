import type { Env } from '../env';
import { ApiError } from '../http/respond';
import { b64encode, nowIso, sha256Hex } from '../util';
import { rateLimit } from './session';

const PREFIX = 'cbl_';
const LINK_DAYS = 7;

/** What a link code grants: uploads into one project, on behalf of its owner. */
export interface LinkGrant {
  ownerId: string;
  projectId: string;
  aiPermitted: boolean;
}

/** Creates a code for a project, replacing any earlier one. The plain code is returned once and never stored. */
export async function createLinkCode(env: Env, ownerId: string, projectId: string, aiPermitted: boolean) {
  const code = PREFIX + b64encode(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]!);
  const expires = new Date(Date.now() + LINK_DAYS * 86400_000).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM link_codes WHERE project_id = ? AND owner_id = ?').bind(projectId, ownerId),
    env.DB.prepare('INSERT INTO link_codes (code_hash, owner_id, project_id, ai_permitted, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(await sha256Hex(code), ownerId, projectId, aiPermitted ? 1 : 0, nowIso(), expires),
  ]);
  return { code, expiresAt: expires };
}

/**
 * Link routes authenticate with `Authorization: Bearer cbl_…` only. Session cookies are ignored,
 * so a browser can't be tricked into using them, and a code never works on the other routes.
 */
export async function requireLink(env: Env, req: Request): Promise<LinkGrant> {
  const m = /^Bearer\s+(cbl_[A-Za-z0-9_-]{20,100})$/.exec(req.headers.get('authorization') ?? '');
  if (!m) throw new ApiError(401, 'link_required', 'Send the link code from your ChemBrain project.');
  const hash = await sha256Hex(m[1]);
  const row = await env.DB.prepare('SELECT owner_id, project_id, ai_permitted, expires_at FROM link_codes WHERE code_hash = ?')
    .bind(hash)
    .first<{ owner_id: string; project_id: string; ai_permitted: number; expires_at: string }>();
  if (!row || row.expires_at < nowIso()) throw new ApiError(401, 'link_invalid', 'This link code is expired or was replaced. Create a new one in the project’s Papers tab.');
  await rateLimit(env, `link:${hash.slice(0, 32)}`, 300, 3600);
  await env.DB.prepare('UPDATE link_codes SET last_used_at = ? WHERE code_hash = ?').bind(nowIso(), hash).run();
  return { ownerId: row.owner_id, projectId: row.project_id, aiPermitted: row.ai_permitted === 1 };
}
