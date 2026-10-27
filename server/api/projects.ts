import { z } from 'zod';
import { discover, loadConnectorContext } from '../connectors';
import { publisherOf } from '../connectors/publishers';
import { DEMO_PAPERS } from '../demo/papers.generated';
import { ApiError, json } from '../http/respond';
import { metaConfigured, MetaError } from '../meta/client';
import { planSearch, screenCandidates } from '../jobs/analysis';
import { keywordPlan } from '../search/keywords';
import { newId, normalizeDoi, nowIso, parseJson } from '../util';
import { coverage, ownedProject } from './access';
import type { Route } from './router';

/** The researcher's brief is a single free-text description of the compound or material. */
const Brief = z.object({ description: z.string().trim().min(10).max(3000) });

const DEMO_BRIEF: z.infer<typeof Brief> = {
  description:
    'A biodegradable, water-resistant packaging film for dry foods, made from bio-based ingredients by solution casting below 100 °C. It should have low water vapour permeability and stay flexible.',
};

/** Short project name from the first clause of a description. */
function nameFrom(description: string) {
  const first = description.split(/[.;\n]/)[0].trim();
  return first.length > 70 ? `${first.slice(0, 67).replace(/\s+\S*$/, '')}…` : first || 'Untitled project';
}

const MAX_DISCOVERED = 300;

export const projectRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/projects',
    handler: async ({ env, user }) => {
      const { results } = await env.DB.prepare(
        `SELECT p.id, p.name, p.is_demo, p.created_at, p.updated_at,
           (SELECT COUNT(*) FROM papers WHERE project_id = p.id AND owner_id = p.owner_id) AS paper_count,
           (SELECT COUNT(*) FROM reports WHERE project_id = p.id AND owner_id = p.owner_id) AS report_count
         FROM projects p WHERE p.owner_id = ? ORDER BY p.updated_at DESC`,
      )
        .bind(user.id)
        .all();
      return json({ projects: results });
    },
  },
  {
    method: 'POST',
    path: '/api/projects',
    handler: async ({ env, user, body }) => {
      const { name, description } = await body<{ name?: string; description?: string }>();
      let brief: z.infer<typeof Brief> | null = null;
      if (description !== undefined) {
        const parsed = Brief.safeParse({ description });
        if (!parsed.success) throw new ApiError(400, 'bad_brief', 'Describe your compound or material in at least a few words.');
        brief = parsed.data;
      }
      const n = (name ?? '').trim().slice(0, 120) || (brief ? nameFrom(brief.description) : 'Untitled project');
      const id = newId('prj');
      const now = nowIso();
      await env.DB.prepare('INSERT INTO projects (id, owner_id, name, brief_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, user.id, n, brief ? JSON.stringify(brief) : null, now, now)
        .run();
      return json({ project: { id, name: n } }, 201);
    },
  },
  {
    method: 'POST',
    path: '/api/projects/demo',
    handler: async ({ env, user }) => {
      const id = newId('prj');
      const now = nowIso();
      const stmts = [
        env.DB.prepare('INSERT INTO projects (id, owner_id, name, is_demo, brief_json, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)').bind(
          id, user.id, 'Demonstration · Water-resistant biodegradable film', JSON.stringify(DEMO_BRIEF), now, now,
        ),
      ];
      for (const d of DEMO_PAPERS) {
        // Metadata was read from the bundled article itself, so citations resolve to the supplied documents.
        stmts.push(
          env.DB.prepare(
            `INSERT INTO papers (id, project_id, owner_id, doi, title, year, venue, publisher, abstract, landing_url, license, discovered_via,
              relevance, relevance_reason, relevance_method, selected, user_access, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'demo_bundle', NULL, 'Bundled demonstration paper', 'demo', 1, 'open_access', ?, ?)`,
          ).bind(newId('pap'), id, user.id, d.doi.toLowerCase(), d.title, d.year, d.venue, d.publisher, d.abstract, `https://doi.org/${d.doi}`, 'https://creativecommons.org/licenses/by/4.0/', now, now),
        );
      }
      await env.DB.batch(stmts);
      return json({ project: { id } }, 201);
    },
  },
  {
    method: 'GET',
    path: '/api/projects/:id',
    handler: async ({ env, user, params }) => {
      const p = await ownedProject(env, user.id, params.id);
      const job = await env.DB.prepare('SELECT id, status FROM jobs WHERE project_id = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 1').bind(p.id, user.id).first();
      return json({
        project: { id: p.id, name: p.name, isDemo: Boolean(p.is_demo), brief: parseJson(p.brief_json, null), searchPlan: parseJson(p.search_plan_json, null), createdAt: p.created_at, updatedAt: p.updated_at },
        coverage: await coverage(env, user.id, p.id),
        latestJob: job ?? null,
        metaConfigured: metaConfigured(env),
      });
    },
  },
  {
    method: 'PATCH',
    path: '/api/projects/:id',
    handler: async ({ env, user, params, body }) => {
      await ownedProject(env, user.id, params.id);
      const b = await body<{ name?: string; brief?: unknown }>();
      if (b.name !== undefined) {
        const n = String(b.name).trim().slice(0, 120);
        if (!n) throw new ApiError(400, 'bad_name', 'Project name cannot be empty.');
        await env.DB.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ? AND owner_id = ?').bind(n, nowIso(), params.id, user.id).run();
      }
      if (b.brief !== undefined) {
        const parsed = Brief.safeParse(b.brief);
        if (!parsed.success) throw new ApiError(400, 'bad_brief', 'Describe your compound or material in at least a few words.');
        await env.DB.prepare('UPDATE projects SET brief_json = ?, updated_at = ? WHERE id = ? AND owner_id = ?').bind(JSON.stringify(parsed.data), nowIso(), params.id, user.id).run();
      }
      return json({ ok: true });
    },
  },
  {
    method: 'DELETE',
    path: '/api/projects/:id',
    handler: async ({ env, user, params }) => {
      await ownedProject(env, user.id, params.id);
      const keys = await env.DB.prepare('SELECT storage_key FROM documents WHERE project_id = ? AND owner_id = ? AND storage_key IS NOT NULL').bind(params.id, user.id).all<{ storage_key: string }>();
      if (env.DOCS && keys.results.length) await env.DOCS.delete(keys.results.map((k) => k.storage_key));
      // Foreign keys cascade to papers, documents, chunks, evidence, jobs, reports, and questions.
      await env.DB.prepare('DELETE FROM projects WHERE id = ? AND owner_id = ?').bind(params.id, user.id).run();
      return json({ ok: true });
    },
  },
  {
    method: 'POST',
    path: '/api/projects/:id/plan',
    handler: async ({ env, user, params, fetch }) => {
      const p = await ownedProject(env, user.id, params.id);
      const brief = parseJson<{ description?: string } | null>(p.brief_json, null);
      if (!brief?.description) throw new ApiError(400, 'no_brief', 'Describe your compound or material first.');
      if (!metaConfigured(env)) {
        // Without Meta, search with keywords from the description (clearly labelled as such).
        const plan = { ...keywordPlan(brief.description), method: 'keywords', createdAt: nowIso() };
        await env.DB.prepare('UPDATE projects SET search_plan_json = ?, updated_at = ? WHERE id = ? AND owner_id = ?').bind(JSON.stringify(plan), nowIso(), p.id, user.id).run();
        return json({ plan });
      }
      try {
        const res = await planSearch(env, { ownerId: user.id, projectId: p.id, stage: 'search_planning' }, brief, fetch);
        const plan = { ...res.data, method: 'meta', model: res.model, createdAt: nowIso() };
        await env.DB.prepare('UPDATE projects SET search_plan_json = ?, updated_at = ? WHERE id = ? AND owner_id = ?').bind(JSON.stringify(plan), nowIso(), p.id, user.id).run();
        return json({ plan });
      } catch (e) {
        if (e instanceof MetaError) throw new ApiError(e.code === 'not_configured' ? 503 : 502, `meta_${e.code}`, e.message);
        throw e;
      }
    },
  },
  {
    method: 'PUT',
    path: '/api/projects/:id/plan',
    handler: async ({ env, user, params, body }) => {
      const p = await ownedProject(env, user.id, params.id);
      const { queries } = await body<{ queries?: string[] }>();
      const qs = (queries ?? []).map((q) => String(q).trim().slice(0, 200)).filter(Boolean).slice(0, 8);
      if (!qs.length) throw new ApiError(400, 'no_queries', 'Add at least one search query.');
      const prev = parseJson<Record<string, unknown>>(p.search_plan_json, {});
      const plan = { ...prev, queries: qs.map((q) => ({ query: q, rationale: 'Edited by researcher' })), method: prev.method ?? 'manual', editedAt: nowIso() };
      await env.DB.prepare('UPDATE projects SET search_plan_json = ?, updated_at = ? WHERE id = ? AND owner_id = ?').bind(JSON.stringify(plan), nowIso(), p.id, user.id).run();
      return json({ plan });
    },
  },
  {
    method: 'POST',
    path: '/api/projects/:id/discover',
    handler: async ({ env, user, params, fetch }) => {
      const p = await ownedProject(env, user.id, params.id);
      const plan = parseJson<{ queries?: { query: string }[] }>(p.search_plan_json, {});
      const queries = (plan.queries ?? []).map((q) => q.query).slice(0, 6);
      if (!queries.length) throw new ApiError(400, 'no_plan', 'Create or enter search queries first.');
      const ctx = await loadConnectorContext(env, user.id, fetch);
      const { candidates, errors } = await discover(ctx, queries, 10);
      const existing = await env.DB.prepare('SELECT doi, title FROM papers WHERE project_id = ? AND owner_id = ?').bind(p.id, user.id).all<{ doi: string | null; title: string }>();
      const have = new Set(existing.results.map((r) => r.doi ?? r.title.toLowerCase()));
      const fresh = candidates.filter((c) => !have.has(c.doi ?? c.title.toLowerCase())).slice(0, Math.max(0, MAX_DISCOVERED - existing.results.length));
      const now = nowIso();
      // Rank by simple term overlap first; Meta screening refines it in /screen.
      const brief = parseJson<{ description?: string }>(p.brief_json, {});
      const terms = new Set(`${brief.description ?? ''} ${queries.join(' ')}`.toLowerCase().match(/[a-z]{4,}/g) ?? []);
      const lexical = (t: string) => {
        const words = new Set(t.toLowerCase().match(/[a-z]{4,}/g) ?? []);
        let hit = 0;
        for (const w of terms) if (words.has(w)) hit++;
        return terms.size ? Math.min(1, hit / Math.min(terms.size, 12)) : 0;
      };
      const stmts = fresh.map((c) =>
        env.DB.prepare(
          `INSERT OR IGNORE INTO papers (id, project_id, owner_id, doi, title, authors, year, venue, publisher, abstract, landing_url, license, discovered_via,
             relevance, relevance_reason, relevance_method, user_access, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'keyword', ?, ?, ?)`,
        ).bind(
          newId('pap'), p.id, user.id, c.doi, c.title.slice(0, 500), c.authors, c.year, c.venue, c.publisher ?? publisherName(c.doi), c.abstract?.slice(0, 6000) ?? null, c.landingUrl, c.license, c.source,
          Math.round(lexical(`${c.title} ${c.abstract ?? ''}`) * 100) / 100, 'Keyword overlap with your description (not yet ranked by Meta)', c.license && /creativecommons|cc by|open access/i.test(c.license) ? 'open_access' : 'unknown', now, now,
        ),
      );
      for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
      return json({ added: stmts.length, totalCandidates: candidates.length, sourceErrors: errors });
    },
  },
  {
    method: 'POST',
    path: '/api/projects/:id/screen',
    handler: async ({ env, user, params, fetch }) => {
      const p = await ownedProject(env, user.id, params.id);
      const brief = parseJson(p.brief_json, null);
      const { results } = await env.DB.prepare("SELECT id, title, abstract, year, venue FROM papers WHERE project_id = ? AND owner_id = ? AND relevance_method = 'keyword' ORDER BY relevance DESC LIMIT 40")
        .bind(p.id, user.id)
        .all<{ id: string; title: string; abstract: string | null; year: number | null; venue: string | null }>();
      if (!results.length) return json({ screened: 0 });
      const refs = new Map(results.map((r, i) => [`R${i + 1}`, r]));
      try {
        const res = await screenCandidates(env, { ownerId: user.id, projectId: p.id, stage: 'screening' }, brief, [...refs].map(([ref, r]) => ({ ref, ...r })), fetch);
        const stmts = res.data.ratings
          .filter((r) => refs.has(r.ref))
          .map((r) => env.DB.prepare("UPDATE papers SET relevance = ?, relevance_reason = ?, relevance_method = 'meta', updated_at = ? WHERE id = ? AND owner_id = ?").bind(r.relevance, r.reason, nowIso(), refs.get(r.ref)!.id, user.id));
        if (stmts.length) await env.DB.batch(stmts);
        return json({ screened: stmts.length, model: res.model });
      } catch (e) {
        if (e instanceof MetaError) throw new ApiError(e.code === 'not_configured' ? 503 : 502, `meta_${e.code}`, e.message);
        throw e;
      }
    },
  },
];

function publisherName(doi: string | null) {
  const p = publisherOf(normalizeDoi(doi), null);
  return p === 'elsevier' ? 'Elsevier' : p === 'wiley' ? 'Wiley' : p === 'springer' ? 'Springer Nature' : null;
}
