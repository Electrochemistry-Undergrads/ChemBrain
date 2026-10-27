import { crossrefLookup } from '../connectors/crossref';
import { publisherOf, PROVIDER_LABEL } from '../connectors/publishers';
import { ApiError, json, notFound } from '../http/respond';
import { aiPermissionFor, ingestDocument, parseStatusFor, retrievalStatusFor } from '../jobs/documents';
import { newId, normalizeDoi, nowIso, parseJson } from '../util';
import { ownedPaper, ownedProject } from './access';
import type { Route } from './router';

const MAX_UPLOAD = 30_000_000;

export const paperRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/projects/:id/papers',
    handler: async ({ env, user, params }) => {
      await ownedProject(env, user.id, params.id);
      const { results } = await env.DB.prepare(
        `SELECT p.id, p.doi, p.title, p.authors, p.year, p.venue, p.publisher, p.abstract, p.landing_url, p.license, p.discovered_via, p.relevance,
           p.relevance_reason, p.relevance_method, p.selected, p.user_access, p.retrieval_status, p.retrieval_reason, p.retrieval_log_json, p.parse_status,
           p.ai_permission, p.analysis_status,
           d.id AS document_id, d.connector, d.format, d.completeness, d.version_label, d.page_count, d.char_count, d.has_methods, d.supplementary_json, d.parse_notes, d.identity_json,
           (SELECT COUNT(*) FROM evidence e WHERE e.paper_id = p.id AND e.owner_id = p.owner_id) AS evidence_count
         FROM papers p LEFT JOIN documents d ON d.paper_id = p.id AND d.owner_id = p.owner_id
         WHERE p.project_id = ? AND p.owner_id = ? ORDER BY p.selected DESC, p.relevance DESC NULLS LAST, p.created_at`,
      )
        .bind(params.id, user.id)
        .all<Record<string, unknown>>();
      return json({
        papers: results.map((r) => ({
          ...r,
          provider: publisherOf(r.doi as string | null, r.publisher as string | null),
          retrieval_log: parseJson(r.retrieval_log_json as string, []),
          supplementary: parseJson(r.supplementary_json as string, []),
          identity: parseJson(r.identity_json as string, null),
          retrieval_log_json: undefined,
          supplementary_json: undefined,
          identity_json: undefined,
        })),
      });
    },
  },
  {
    method: 'POST',
    path: '/api/projects/:id/papers',
    handler: async ({ env, user, params, body, fetch }) => {
      await ownedProject(env, user.id, params.id);
      const { doi: raw } = await body<{ doi?: string }>();
      const doi = normalizeDoi(raw);
      if (!doi) throw new ApiError(400, 'bad_doi', 'Enter a DOI such as 10.1038/s41598-020-70651-5.');
      const dup = await env.DB.prepare('SELECT id FROM papers WHERE project_id = ? AND owner_id = ? AND doi = ?').bind(params.id, user.id, doi).first();
      if (dup) throw new ApiError(409, 'duplicate', 'This paper is already in the project.');
      const meta = await crossrefLookup(env, doi, fetch).catch(() => null);
      if (!meta) throw new ApiError(404, 'doi_not_found', 'Crossref has no record of this DOI. Check it and try again.');
      const now = nowIso();
      const id = newId('pap');
      await env.DB.prepare(
        `INSERT INTO papers (id, project_id, owner_id, doi, title, authors, year, venue, publisher, abstract, landing_url, license, discovered_via, selected, relevance_reason, relevance_method, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 1, 'Added by researcher', 'manual', ?, ?)`,
      )
        .bind(id, params.id, user.id, doi, meta.title, meta.authors, meta.year, meta.venue, meta.publisher, meta.abstract, meta.landingUrl, meta.license, now, now)
        .run();
      return json({ paper: { id } }, 201);
    },
  },
  {
    method: 'PATCH',
    path: '/api/projects/:id/papers/:pid',
    handler: async ({ env, user, params, body }) => {
      const paper = await ownedPaper(env, user.id, params.id, params.pid);
      const b = await body<{ selected?: boolean; canRead?: boolean }>();
      if (b.selected !== undefined) await env.DB.prepare('UPDATE papers SET selected = ?, updated_at = ? WHERE id = ? AND owner_id = ?').bind(b.selected ? 1 : 0, nowIso(), paper.id, user.id).run();
      if (b.canRead !== undefined) {
        // The researcher's own statement that they can read the paper (e.g. via their library).
        const next = b.canRead ? (paper.user_access === 'unknown' || paper.user_access === 'not_entitled' ? 'user_confirmed' : paper.user_access) : paper.user_access === 'user_confirmed' ? 'unknown' : paper.user_access;
        await env.DB.prepare('UPDATE papers SET user_access = ?, updated_at = ? WHERE id = ? AND owner_id = ?').bind(next, nowIso(), paper.id, user.id).run();
      }
      return json({ ok: true });
    },
  },
  {
    method: 'POST',
    path: '/api/projects/:id/papers/select',
    handler: async ({ env, user, params, body }) => {
      await ownedProject(env, user.id, params.id);
      const { ids, selected } = await body<{ ids?: string[]; selected?: boolean }>();
      const list = (ids ?? []).slice(0, 100);
      if (!list.length) return json({ ok: true });
      await env.DB.batch(list.map((pid) => env.DB.prepare('UPDATE papers SET selected = ?, updated_at = ? WHERE id = ? AND project_id = ? AND owner_id = ?').bind(selected ? 1 : 0, nowIso(), pid, params.id, user.id)));
      return json({ ok: true });
    },
  },
  {
    method: 'DELETE',
    path: '/api/projects/:id/papers/:pid',
    handler: async ({ env, user, params }) => {
      const paper = await ownedPaper(env, user.id, params.id, params.pid);
      const keys = await env.DB.prepare('SELECT storage_key FROM documents WHERE paper_id = ? AND owner_id = ? AND storage_key IS NOT NULL').bind(paper.id, user.id).all<{ storage_key: string }>();
      if (env.DOCS && keys.results.length) await env.DOCS.delete(keys.results.map((k) => k.storage_key));
      await env.DB.prepare('DELETE FROM papers WHERE id = ? AND owner_id = ?').bind(paper.id, user.id).run();
      return json({ ok: true });
    },
  },
  {
    method: 'POST',
    path: '/api/projects/:id/papers/:pid/upload',
    handler: async ({ env, user, params, req }) => {
      const paper = await ownedPaper(env, user.id, params.id, params.pid);
      const len = Number(req.headers.get('content-length') || 0);
      if (len > MAX_UPLOAD) throw new ApiError(413, 'too_large', 'Files up to 30 MB are supported.');
      const form = await req.formData().catch(() => null);
      const file = form?.get('file');
      if (!file || typeof file === 'string') throw new ApiError(400, 'no_file', 'Choose a PDF or XML file to upload.');
      const attestRead = form!.get('canRead') === 'true';
      if (!attestRead) throw new ApiError(400, 'attest', 'Confirm that you are entitled to read this paper before uploading it.');
      const attestAi = form!.get('aiPermitted') === 'true';
      const bytes = new Uint8Array(await (file as File).arrayBuffer());
      if (bytes.length > MAX_UPLOAD) throw new ApiError(413, 'too_large', 'Files up to 30 MB are supported.');
      const r = await ingestDocument(env, { ...paper, owner_id: user.id, project_id: params.id }, bytes, {
        connector: attestAi ? 'user_upload_attested' : 'user_upload',
        format: 'auto',
        contentType: (file as File).type || null,
        versionLabel: `Uploaded by the researcher (${(file as File).name.slice(0, 100)})`,
      });
      if (!r.ok) throw new ApiError(422, 'rejected', r.reason);
      const status = retrievalStatusFor(r.completeness!);
      await env.DB.prepare(
        'UPDATE papers SET user_access = ?, retrieval_status = ?, retrieval_reason = ?, parse_status = ?, ai_permission = ?, analysis_status = ?, selected = 1, updated_at = ? WHERE id = ? AND owner_id = ?',
      )
        .bind(
          paper.user_access === 'open_access' || paper.user_access === 'entitled' ? paper.user_access : 'user_confirmed',
          status, `Uploaded by you. ${r.reason}`, parseStatusFor(r.completeness!), aiPermissionFor(r.license ?? paper.license, attestAi), 'not_started', nowIso(), paper.id, user.id,
        )
        .run();
      return json({ ok: true, completeness: r.completeness, identity: r.identity, chunks: r.chunkCount });
    },
  },
  {
    method: 'GET',
    path: '/api/projects/:id/papers/:pid/document',
    handler: async ({ env, user, params }) => {
      const paper = await ownedPaper(env, user.id, params.id, params.pid);
      const doc = await env.DB.prepare('SELECT id, connector, format, version_label, license, completeness, page_count, char_count, has_methods, supplementary_json, parse_notes, identity_json, retrieved_at FROM documents WHERE paper_id = ? AND owner_id = ?')
        .bind(paper.id, user.id)
        .first<Record<string, unknown>>();
      if (!doc) throw notFound();
      const { results: chunks } = await env.DB.prepare('SELECT id, seq, section, kind, label, page_start, page_end, text FROM chunks WHERE document_id = ? AND owner_id = ? ORDER BY seq')
        .bind(doc.id, user.id)
        .all();
      return json({ paper: { id: paper.id, title: paper.title, doi: paper.doi }, document: { ...doc, supplementary: parseJson(doc.supplementary_json as string, []), identity: parseJson(doc.identity_json as string, null) }, chunks });
    },
  },
  {
    method: 'GET',
    path: '/api/projects/:id/chunks/:cid',
    handler: async ({ env, user, params }) => {
      await ownedProject(env, user.id, params.id);
      const c = await env.DB.prepare(
        `SELECT c.id, c.seq, c.section, c.kind, c.label, c.page_start, c.page_end, c.text, p.id AS paper_id, p.title AS paper_title, p.doi, d.version_label, d.format
         FROM chunks c JOIN papers p ON p.id = c.paper_id JOIN documents d ON d.id = c.document_id
         WHERE c.id = ? AND c.project_id = ? AND c.owner_id = ?`,
      )
        .bind(params.cid, params.id, user.id)
        .first();
      if (!c) throw notFound();
      return json({ chunk: c });
    },
  },
  {
    method: 'GET',
    path: '/api/providers',
    handler: async () => json({ providers: PROVIDER_LABEL }),
  },
];
