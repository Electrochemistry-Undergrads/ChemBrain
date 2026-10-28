import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, setupEnv } from './helpers';
import type { Env } from '../server/env';

let env: Env;
let dispose: () => Promise<void>;

beforeAll(async () => {
  ({ env, dispose } = await setupEnv());
});
afterAll(() => dispose());

/** What paperfetch sends: minimal JATS with the DOI, a methods section and SI. */
function jats(doi: string, title: string) {
  const para = 'The precursor solution was stirred at 80 °C for 2 h under nitrogen, then cooled and washed three times with ethanol. ';
  return `<?xml version="1.0" encoding="UTF-8"?>
<article><front><article-meta><article-id pub-id-type="doi">${doi}</article-id>
<title-group><article-title>${title}</article-title></title-group></article-meta></front>
<body><sec><title>Results and discussion</title><p>${para.repeat(40)}</p></sec>
<sec sec-type="methods"><title>Experimental section</title><p>${para.repeat(40)}</p></sec>
<sec><title>Supporting Information</title><sec><title>ja0c01234_si_001.pdf</title><p>Synthesis of compound 3: ${para}</p></sec></sec></body></article>`;
}

function form(xml: string) {
  const f = new FormData();
  f.set('file', new File([xml], 'paper.xml', { type: 'application/xml' }));
  f.set('source', 'oa-link:crossref-tdm, published version');
  return f;
}

/** A client with no session cookie, the way paperfetch calls the API. */
const paperfetch = (code: string) => {
  const c = new Client(env);
  return (method: string, path: string, body?: unknown) => c.call(method, path, body, { authorization: `Bearer ${code}`, 'x-chembrain': '', origin: '' });
};

async function projectWithPapers(name: string) {
  const c = new Client(env);
  await c.signup(name);
  const pid = (await c.call('POST', '/api/projects/demo')).data.project.id as string;
  const papers = (await c.call('GET', `/api/projects/${pid}/papers`)).data.papers as { id: string; doi: string; title: string }[];
  return { c, pid, papers };
}

describe('paperfetch link codes', () => {
  it('requires the read attestation and returns a code once', async () => {
    const { c, pid } = await projectWithPapers('link_owner');
    expect((await c.call('POST', `/api/projects/${pid}/link`, { aiPermitted: true })).status).toBe(400);
    const r = await c.call('POST', `/api/projects/${pid}/link`, { canRead: true, aiPermitted: true });
    expect(r.status).toBe(201);
    expect(r.data.code).toMatch(/^cbl_[A-Za-z0-9_-]{40,}$/);
    const state = (await c.call('GET', `/api/projects/${pid}/link`)).data;
    expect(state.link.aiPermitted).toBe(true);
    expect(JSON.stringify(state)).not.toContain(r.data.code);
  });

  it('lists missing papers and accepts uploads with the code, which then count as full text', async () => {
    const { c, pid, papers } = await projectWithPapers('link_upload');
    const code = (await c.call('POST', `/api/projects/${pid}/link`, { canRead: true, aiPermitted: true })).data.code;
    const pf = paperfetch(code);
    const list = await pf('GET', '/api/link/papers');
    expect(list.status).toBe(200);
    expect(list.data.papers.map((p: { id: string }) => p.id).sort()).toEqual(papers.map((p) => p.id).sort());

    const target = papers[0];
    // Demo papers are CC BY; clear the licence so the code's AI attestation is what counts.
    await env.DB.prepare('UPDATE papers SET license = NULL WHERE id = ?').bind(target.id).run();
    const up = await pf('POST', `/api/link/papers/${target.id}/upload`, form(jats(target.doi, target.title)));
    expect(up.status).toBe(200);
    expect(up.data.completeness).toBe('complete');
    const after = (await c.call('GET', `/api/projects/${pid}/papers`)).data.papers.find((p: { id: string }) => p.id === target.id);
    expect(after).toMatchObject({ retrieval_status: 'full_text_retrieved', ai_permission: 'user_attested', connector: 'paperfetch_attested', has_methods: 1, selected: 1 });
    expect(after.version_label).toContain('crossref-tdm');
    const doc = (await c.call('GET', `/api/projects/${pid}/papers/${target.id}/document`)).data;
    expect(doc.chunks.some((k: { text: string }) => k.text.includes('Synthesis of compound 3'))).toBe(true);
    expect((await pf('GET', '/api/link/papers')).data.papers.some((p: { id: string }) => p.id === target.id)).toBe(false);
    expect((await c.call('GET', `/api/projects/${pid}/link`)).data.received).toBe(1);
  });

  it('marks papers as needing AI permission when the code was created without it', async () => {
    const { c, pid, papers } = await projectWithPapers('link_noai');
    const code = (await c.call('POST', `/api/projects/${pid}/link`, { canRead: true })).data.code;
    const t = papers[1];
    await env.DB.prepare('UPDATE papers SET license = NULL WHERE id = ?').bind(t.id).run();
    expect((await paperfetch(code)('POST', `/api/link/papers/${t.id}/upload`, form(jats(t.doi, t.title)))).status).toBe(200);
    const after = (await c.call('GET', `/api/projects/${pid}/papers`)).data.papers.find((p: { id: string }) => p.id === t.id);
    expect(after.connector).toBe('paperfetch');
    expect(after.ai_permission).toBe('not_confirmed');
  });

  it('rejects a document that is a different paper', async () => {
    const { c, pid, papers } = await projectWithPapers('link_mismatch');
    const code = (await c.call('POST', `/api/projects/${pid}/link`, { canRead: true })).data.code;
    const r = await paperfetch(code)('POST', `/api/link/papers/${papers[0].id}/upload`, form(jats('10.1021/jacs.9b99999', 'Something else entirely')));
    expect(r.status).toBe(422);
  });

  it('is scoped to one project and never works as a session', async () => {
    const a = await projectWithPapers('link_scope_a');
    const b = await projectWithPapers('link_scope_b');
    const otherOfA = (await a.c.call('POST', '/api/projects/demo')).data.project.id;
    const otherPaper = (await a.c.call('GET', `/api/projects/${otherOfA}/papers`)).data.papers[0];
    const code = (await a.c.call('POST', `/api/projects/${a.pid}/link`, { canRead: true })).data.code;
    const pf = paperfetch(code);
    const xml = jats(b.papers[0].doi, b.papers[0].title);
    expect((await pf('POST', `/api/link/papers/${b.papers[0].id}/upload`, form(xml))).status).toBe(404);
    expect((await pf('POST', `/api/link/papers/${otherPaper.id}/upload`, form(jats(otherPaper.doi, otherPaper.title)))).status).toBe(404);
    expect((await pf('GET', '/api/projects')).status).toBe(401);
    expect((await pf('GET', `/api/projects/${a.pid}/papers`)).status).toBe(401);
    // A signed-in browser without the code can't use the link routes.
    expect((await a.c.call('GET', '/api/link/papers')).status).toBe(401);
    expect((await paperfetch('cbl_' + 'x'.repeat(43))('GET', '/api/link/papers')).status).toBe(401);
  });

  it('stops working when revoked, replaced or expired', async () => {
    const { c, pid } = await projectWithPapers('link_revoke');
    const first = (await c.call('POST', `/api/projects/${pid}/link`, { canRead: true })).data.code;
    const second = (await c.call('POST', `/api/projects/${pid}/link`, { canRead: true })).data.code;
    expect((await paperfetch(first)('GET', '/api/link/papers')).status).toBe(401);
    expect((await paperfetch(second)('GET', '/api/link/papers')).status).toBe(200);
    expect((await c.call('DELETE', `/api/projects/${pid}/link`)).status).toBe(200);
    expect((await paperfetch(second)('GET', '/api/link/papers')).status).toBe(401);
    const third = (await c.call('POST', `/api/projects/${pid}/link`, { canRead: true })).data.code;
    await env.DB.prepare("UPDATE link_codes SET expires_at = '2000-01-01T00:00:00.000Z' WHERE project_id = ?").bind(pid).run();
    expect((await paperfetch(third)('GET', '/api/link/papers')).status).toBe(401);
    expect((await c.call('GET', `/api/projects/${pid}/link`)).data.link.expired).toBe(true);
  });
});
