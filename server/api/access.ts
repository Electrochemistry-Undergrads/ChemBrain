import type { Env } from '../env';
import { notFound } from '../http/respond';

/**
 * Every lookup is scoped to the signed-in owner. Objects owned by someone else are reported as
 * "not found" (never "forbidden") so IDs cannot be probed.
 */
export async function ownedProject(env: Env, ownerId: string, projectId: string) {
  const p = await env.DB.prepare('SELECT id, name, is_demo, brief_json, search_plan_json, created_at, updated_at FROM projects WHERE id = ? AND owner_id = ?')
    .bind(projectId, ownerId)
    .first<{ id: string; name: string; is_demo: number; brief_json: string | null; search_plan_json: string | null; created_at: string; updated_at: string }>();
  if (!p) throw notFound();
  return p;
}

export async function ownedPaper(env: Env, ownerId: string, projectId: string, paperId: string) {
  const p = await env.DB.prepare('SELECT * FROM papers WHERE id = ? AND project_id = ? AND owner_id = ?').bind(paperId, projectId, ownerId).first<Record<string, unknown> & { id: string; doi: string | null; title: string; project_id: string; owner_id: string; publisher: string | null; license: string | null; user_access: string }>();
  if (!p) throw notFound();
  return p;
}

export async function coverage(env: Env, ownerId: string, projectId: string) {
  const r = await env.DB.prepare(
    `SELECT
       COUNT(*) AS discovered,
       SUM(selected) AS selected,
       SUM(CASE WHEN user_access IN ('open_access','entitled','user_confirmed') THEN 1 ELSE 0 END) AS confirmed_readable,
       SUM(CASE WHEN user_access = 'unknown' THEN 1 ELSE 0 END) AS unknown_access,
       SUM(CASE WHEN retrieval_status = 'full_text_retrieved' THEN 1 ELSE 0 END) AS full_text_retrieved,
       SUM(CASE WHEN retrieval_status = 'full_text_retrieved' AND user_access IN ('open_access','entitled','user_confirmed') THEN 1 ELSE 0 END) AS readable_and_retrieved,
       SUM(CASE WHEN parse_status = 'parsed' THEN 1 ELSE 0 END) AS parsed,
       SUM(CASE WHEN parse_status IN ('parsing_incomplete','unreadable') THEN 1 ELSE 0 END) AS parsing_incomplete,
       SUM(CASE WHEN analysis_status = 'analysis_complete' THEN 1 ELSE 0 END) AS analyzed,
       SUM(CASE WHEN retrieval_status = 'abstract_only' THEN 1 ELSE 0 END) AS abstract_only,
       SUM(CASE WHEN retrieval_status = 'institutional_connection_required' THEN 1 ELSE 0 END) AS blocked_network,
       SUM(CASE WHEN retrieval_status = 'permission_required' THEN 1 ELSE 0 END) AS blocked_permission,
       SUM(CASE WHEN retrieval_status = 'retrieval_failed' THEN 1 ELSE 0 END) AS blocked_technical,
       SUM(CASE WHEN selected = 1 AND ai_permission = 'not_confirmed' AND retrieval_status = 'full_text_retrieved' THEN 1 ELSE 0 END) AS ai_not_confirmed
     FROM papers WHERE owner_id = ? AND project_id = ?`,
  )
    .bind(ownerId, projectId)
    .first<Record<string, number | null>>();
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(r ?? {})) out[k] = v ?? 0;
  // Coverage of readable papers: a readable paper that failed to retrieve stays in the denominator.
  out.readable_coverage_pct = out.confirmed_readable ? Math.round((1000 * out.readable_and_retrieved) / out.confirmed_readable) / 10 : 0;
  return out;
}
