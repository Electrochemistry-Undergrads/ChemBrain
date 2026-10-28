import { createLinkCode } from '../auth/link';
import { ApiError, json } from '../http/respond';
import { acceptUpload } from './papers';
import { ownedPaper, ownedProject } from './access';
import type { Route } from './router';

/**
 * paperfetch link: ChemBrain's servers are not on a campus network, so they can't open
 * subscription papers. paperfetch, running on the researcher's own computer, can. The researcher
 * creates a link code here; paperfetch uses it to list the project's papers that still lack full
 * text and to upload the copies it got through the researcher's library.
 */
export const linkRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/projects/:id/link',
    handler: async ({ env, user, params }) => {
      await ownedProject(env, user.id, params.id);
      const row = await env.DB.prepare('SELECT ai_permitted, created_at, expires_at, last_used_at FROM link_codes WHERE project_id = ? AND owner_id = ?')
        .bind(params.id, user.id)
        .first<{ ai_permitted: number; created_at: string; expires_at: string; last_used_at: string | null }>();
      const received = await env.DB.prepare("SELECT COUNT(*) AS n FROM documents WHERE project_id = ? AND owner_id = ? AND connector IN ('paperfetch', 'paperfetch_attested')")
        .bind(params.id, user.id)
        .first<{ n: number }>();
      return json({
        link: row ? { aiPermitted: row.ai_permitted === 1, createdAt: row.created_at, expiresAt: row.expires_at, lastUsedAt: row.last_used_at, expired: row.expires_at < new Date().toISOString() } : null,
        received: received?.n ?? 0,
      });
    },
  },
  {
    method: 'POST',
    path: '/api/projects/:id/link',
    handler: async ({ env, user, params, body }) => {
      await ownedProject(env, user.id, params.id);
      const b = await body<{ canRead?: boolean; aiPermitted?: boolean }>();
      if (b.canRead !== true) throw new ApiError(400, 'attest', 'Confirm that you are entitled to read the papers you send.');
      const { code, expiresAt } = await createLinkCode(env, user.id, params.id, b.aiPermitted === true);
      return json({ code, expiresAt }, 201);
    },
  },
  {
    method: 'DELETE',
    path: '/api/projects/:id/link',
    handler: async ({ env, user, params }) => {
      await ownedProject(env, user.id, params.id);
      await env.DB.prepare('DELETE FROM link_codes WHERE project_id = ? AND owner_id = ?').bind(params.id, user.id).run();
      return json({ ok: true });
    },
  },
  {
    method: 'GET',
    path: '/api/link/papers',
    link: true,
    handler: async ({ env, link }) => {
      const project = await ownedProject(env, link!.ownerId, link!.projectId);
      const { results } = await env.DB.prepare(
        `SELECT id, doi, title, selected FROM papers
         WHERE project_id = ? AND owner_id = ? AND doi IS NOT NULL AND retrieval_status != 'full_text_retrieved'
         ORDER BY selected DESC, relevance DESC NULLS LAST, created_at LIMIT 200`,
      )
        .bind(link!.projectId, link!.ownerId)
        .all<{ id: string; doi: string; title: string; selected: number }>();
      return json({ project: { name: project.name }, papers: results.map((p) => ({ ...p, selected: p.selected === 1 })) });
    },
  },
  {
    method: 'POST',
    path: '/api/link/papers/:pid/upload',
    link: true,
    handler: async ({ env, req, params, link }) => {
      const paper = await ownedPaper(env, link!.ownerId, link!.projectId, params.pid);
      // The researcher made both statements when creating the code, so the form carries no attestations.
      return acceptUpload(env, req, paper, link!.ownerId, link!.projectId, (form) => {
        const via = String(form.get('source') ?? '').replace(/[^\w .,:/()-]/g, '').slice(0, 80);
        return {
          attestAi: link!.aiPermitted,
          connector: link!.aiPermitted ? 'paperfetch_attested' : 'paperfetch',
          versionLabel: () => `Sent from paperfetch on the researcher's computer${via ? ` (${via})` : ''}`,
          reasonPrefix: 'Sent from paperfetch.',
        };
      });
    },
  },
];
