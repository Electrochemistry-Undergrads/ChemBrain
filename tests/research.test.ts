import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPublicationChecker } from '../server/research/publications';
import { validateProposal } from '../server/evidence/citations';
import { compareAndPropose } from '../server/jobs/analysis';
import { PublicationNotes } from '../src/components/PublicationNotes';
import { publicationMessage } from '../shared/publications';
import { resultsFixture } from './results-fixture';
import { fakeMeta, sse } from './fixtures';
import { Client, setupEnv } from './helpers';
import type { Env } from '../server/env';

const paper = (id = 'p1', doi: string | null = '10.5555/original') => ({ id, doi, title: `Test paper ${id}` });
const update = (type: string, DOI = '10.5555/notice') => ({ type, DOI, updated: { 'date-time': '2026-10-01T00:00:00Z' } });
const metadata = (doi: string, fields = {}) => Response.json({ message: { DOI: doi, title: ['Test paper'], ...fields } });

describe('publication updates', () => {
  it('checks the original record, deduplicates publisher/Retraction Watch notices, and caches metadata without credentials', async () => {
    const check = createPublicationChecker();
    const upstream = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => metadata('10.5555/original', {
      'updated-by': [{ ...update('retraction'), source: 'publisher' }, { ...update('retraction'), source: 'retraction-watch' }],
    }));
    const [result] = await check({} as Env, [paper()], upstream as typeof fetch);
    expect(result.exclusion).toBe('retracted');
    expect(result.notices).toEqual([{ kind: 'retraction', doi: '10.5555/notice', date: '2026-10-01' }]);
    expect(upstream.mock.calls[0][0]).toBe('https://api.crossref.org/works/10.5555%2Foriginal');
    const headers = new Headers(upstream.mock.calls[0][1]?.headers);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('cookie')).toBe(false);
    expect((await check({} as Env, [paper('p2')], upstream as typeof fetch))[0].paperId).toBe('p2');
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('does not confuse a notice with the paper it updates, and flags corrections and concerns', async () => {
    const check = createPublicationChecker();
    const upstream = (async (input: RequestInfo | URL) => {
      const doi = decodeURIComponent(new URL(String(input)).pathname.slice('/works/'.length));
      return metadata(doi, doi.endsWith('notice') ? { 'update-to': [update('retraction', '10.5555/original')] }
        : doi.endsWith('reinstated') ? { 'updated-by': [update('retraction'), update('reinstatement', '10.5555/reinstatement')] }
        : { 'updated-by': [update('correction'), update('expression_of_concern', '10.5555/concern')] });
    }) as typeof fetch;
    const [notice, original] = await check({} as Env, [paper('n', '10.5555/notice'), paper()], upstream);
    expect(notice.exclusion).toBe('notice');
    expect(original.exclusion).toBeNull();
    expect(original.notices.map((n) => n.kind)).toEqual(['correction', 'concern']);
    expect(publicationMessage(original)).toMatch(/expression of concern/);
    const [reinstated] = await check({} as Env, [paper('r', '10.5555/reinstated')], upstream);
    expect(reinstated.exclusion).toBe('review_required');
    expect(publicationMessage(reinstated)).toMatch(/reinstatement notices require review/);
  });

  it('keeps missing identifiers, lookup failures, wrong records, and malformed responses distinct from a successful check', async () => {
    const check = createPublicationChecker();
    const upstream = vi.fn().mockResolvedValueOnce(new Response('outage', { status: 503 }))
      .mockResolvedValueOnce(metadata('10.5555/wrong')).mockResolvedValueOnce(new Response('{bad json'))
      .mockImplementation(async () => metadata('10.5555/original'));
    expect((await check({} as Env, [paper('none', null)], upstream as typeof fetch))[0].status).toBe('no_doi');
    expect(upstream).not.toHaveBeenCalled();
    for (let i = 0; i < 3; i++) expect((await check({} as Env, [paper()], upstream as typeof fetch))[0].status).toBe('unavailable');
    const [success] = await check({} as Env, [paper()], upstream as typeof fetch);
    expect(success.status).toBe('checked');
    expect(publicationMessage(success)).toBe('');
    expect(upstream).toHaveBeenCalledTimes(4); // outages are not cached
  });

  it('bounds requests and refuses redirects to other hosts', async () => {
    const check = createPublicationChecker();
    const upstream = vi.fn(async (input: RequestInfo | URL) => metadata(decodeURIComponent(new URL(String(input)).pathname.slice('/works/'.length))));
    const results = await check({} as Env, Array.from({ length: 26 }, (_, i) => paper(`p${i}`, `10.5555/cap-${i}`)), upstream as typeof fetch);
    expect(upstream).toHaveBeenCalledTimes(24);
    expect(results.slice(24).every((r) => r.status === 'not_checked')).toBe(true);
    const redirect = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://unexpected.example/metadata' } }));
    expect((await check({} as Env, [paper()], redirect as typeof fetch))[0].status).toBe('unavailable');
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it('keeps the interface quiet for older or unflagged reports and displays linked notices safely', () => {
    expect(renderToStaticMarkup(createElement(PublicationNotes, {}))).toBe('');
    const base = { ...paper(), paperId: 'p1', status: 'checked' as const, checkedAt: '2026-10-28T12:00:00Z', notices: [], exclusion: null };
    expect(renderToStaticMarkup(createElement(PublicationNotes, { checks: [base] }))).toBe('');
    const html = renderToStaticMarkup(createElement(PublicationNotes, { checks: [{ ...base, title: '<script>test</script>', exclusion: 'retracted', notices: [{ kind: 'retraction', doi: '10.5555/a(b)', date: null }] }] }));
    expect(html).toContain('1 source excluded');
    expect(html).toContain('https://doi.org/10.5555%2Fa%28b%29');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});

describe('proposal citation checks', () => {
  const evidence = () => new Map([['E1', { paper_id: 'p1', check_status: 'supported' }], ['E2', { paper_id: 'p1', check_status: 'partially_supported' }], ['E3', { paper_id: 'p2', check_status: 'supported' }]]);
  const papers = () => new Map([['P1', 'p1'], ['P2', 'p2']]);

  it('removes fabricated ingredients, steps and comparisons, including citations to the wrong paper', () => {
    const p = structuredClone(resultsFixture);
    p.approaches[0].ingredients = [{ name: 'invented ingredient', role: null, amount: null, evidence: ['E9999'] }];
    p.approaches[0].method.push({ step: 'Wrong paper', evidence: ['E3'] });
    p.method_comparison[0].uses[0].evidence = ['E3'];
    p.conflicts = [{ topic: 'invented', description: 'unsupported', evidence: [] }];
    p.adaptations = [{ proposal: 'invented', caveat: '', basis: ['E99'] }];
    const result = validateProposal(p, evidence(), papers());
    expect(p.approaches[0].ingredients).toEqual([]);
    expect(p.approaches[0].method.map((m) => m.step)).not.toContain('Wrong paper');
    expect(p.method_comparison).toEqual([]);
    expect(p.conflicts).toEqual([]);
    expect(p.adaptations).toEqual([]);
    expect(result.removedReferences).toBe(4);
    expect(result.unsupportedStatements.join(' ')).toContain('invented ingredient');
  });

  it('caps confidence for single-paper or partially supported claims and never treats prose as a reference', () => {
    const p = structuredClone(resultsFixture);
    p.approaches[0].evidence_strength = 'strong';
    p.approaches[0].name = 'E9999';
    const ev = evidence();
    ev.get('E3')!.check_status = 'partially_supported';
    const result = validateProposal(p, ev, papers());
    expect(p.approaches[0].evidence_strength).toBe('moderate');
    expect(p.approaches[1].evidence_strength).toBe('weak');
    expect(result.used.has('E9999')).toBe(false);
  });

  it('withholds uncited summaries and prevents a one-paper performance comparison', () => {
    const p = structuredClone(resultsFixture);
    p.assessment_evidence = ['E9999'];
    p.approaches[0].summary_evidence = [];
    p.performance_comparison = [{ property: 'test', entries: [{ paper: 'P1', value: '1', test_conditions: null, evidence: ['E1'] }], comparable: true, comparability_note: 'Direct comparison' }];
    validateProposal(p, evidence(), papers());
    expect(p.assessment).not.toContain('UI test fixture');
    expect(p.approaches[0].summary).toMatch(/do not support/);
    expect(p.performance_comparison[0].comparable).toBe(false);
  });
});

let env: Env;
let dispose: () => Promise<void>;
beforeAll(async () => { ({ env, dispose } = await setupEnv({ MODEL_API_KEY: 'LLM_1_test-key-not-real' })); });
afterAll(() => dispose());

async function seed(label: string, fetchImpl: typeof fetch) {
  const client = new Client(env, fetchImpl);
  await client.signup(label);
  const owner = (await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(label).first<{ id: string }>())!.id;
  const pid = (await client.call('POST', '/api/projects', { description: 'Compare sol-gel and hydrothermal synthesis of test oxide.' })).data.project.id;
  for (const suffix of ['a', 'b']) {
    const id = `${label}-${suffix}`;
    const quote = `The test oxide ${suffix} was prepared using a synthetic test method at 100 degrees.`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO papers (id, project_id, owner_id, doi, title, discovered_via, selected, ai_permission, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'fixture', 1, 'open_license', '2026-10-28', '2026-10-28')").bind(id, pid, owner, `10.5555/${id}`, `Test oxide ${suffix}`),
      env.DB.prepare("INSERT INTO documents (id, paper_id, project_id, owner_id, connector, format, content_sha256, completeness, identity_json, char_count, section_count, retrieved_at) VALUES (?, ?, ?, ?, 'fixture', 'jats', 'fixture', 'complete', '{}', 100, 1, '2026-10-28')").bind(`doc-${id}`, id, pid, owner),
      env.DB.prepare("INSERT INTO chunks (id, document_id, paper_id, project_id, owner_id, seq, kind, text) VALUES (?, ?, ?, ?, ?, 1, 'text', ?)").bind(`chunk-${id}`, `doc-${id}`, id, pid, owner, quote),
      env.DB.prepare("INSERT INTO evidence (id, project_id, paper_id, document_id, chunk_id, owner_id, category, subject, quote, quote_match, check_status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'method_step', 'test oxide', ?, 'exact', 'supported', '2026-10-28')").bind(`ev-${id}`, pid, id, `doc-${id}`, `chunk-${id}`, owner, quote),
    ]);
  }
  return { client, pid, owner };
}

describe('research pipeline publication checks', () => {
  it('excludes a retracted source before Meta, preserves correction notices in exports, and checks question quotes', async () => {
    const meta = fakeMeta();
    let proposalPrompt = '';
    let questionPrompt = '';
    let fabricateAnswer = false;
    const upstream = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.crossref.org') {
        const doi = decodeURIComponent(url.pathname.slice('/works/'.length));
        return metadata(doi, { 'updated-by': [update(doi.endsWith('-a') ? 'retraction' : 'correction')] });
      }
      const body = JSON.parse(String(init?.body));
      if (body.response_format.json_schema.name === 'research_proposal') proposalPrompt = body.messages[1].content;
      if (body.response_format.json_schema.name === 'grounded_answer') {
        questionPrompt = body.messages[1].content;
        if (fabricateAnswer) return sse(JSON.stringify({ answer: 'The oxide has miraculous performance.', citations: [{ chunk_ref: 'Q1', quote: 'This quote does not appear in the test source document.' }], insufficient_evidence: false }));
      }
      return meta.impl(input, init);
    }) as typeof fetch;
    const { client, pid, owner } = await seed('research_mixed', upstream);
    const report = (await compareAndPropose(env, { ownerId: owner, projectId: pid, stage: 'comparison' }, { description: 'Compare test oxide methods.' }, upstream))!;
    expect(Object.values(report.papers).map((p) => p.title)).toEqual(['Test oxide b']);
    expect(proposalPrompt).not.toContain('Test oxide a');
    expect(proposalPrompt).toContain('publication update');
    expect(report.publicationChecks?.find((c) => c.title === 'Test oxide a')?.exclusion).toBe('retracted');
    await env.DB.prepare("INSERT INTO reports (id, project_id, owner_id, model, report_json, created_at) VALUES ('mixed-report', ?, ?, 'test', ?, '2026-10-28')").bind(pid, owner, JSON.stringify(report)).run();
    const md = (await client.call('GET', `/api/projects/${pid}/export.md`)).text;
    expect(md).toContain('Retracted paper excluded');
    expect(md).toContain('[Correction](https://doi.org/10.5555%2Fnotice)');
    expect(md).toContain('Test assessment. [^e1]');
    const answer = await client.call('POST', `/api/projects/${pid}/questions`, { question: 'Compare preparation of the test oxide.' });
    expect(answer.data.answer.insufficient_evidence).toBe(false);
    expect(questionPrompt).not.toContain('oxide a');
    expect(questionPrompt).toContain('oxide b');
    fabricateAnswer = true;
    const rejected = await client.call('POST', `/api/projects/${pid}/questions`, { question: 'What is the performance of the test oxide?' });
    expect(rejected.data.answer.insufficient_evidence).toBe(true);
    expect(rejected.data.answer.answer).not.toContain('miraculous');
    expect(rejected.data.citations).toEqual([]);
  });

  it('does not generate a proposal when every available source is retracted', async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL) => metadata(decodeURIComponent(new URL(String(input)).pathname.slice('/works/'.length)), { 'updated-by': [update('retraction')] }));
    const { client, pid, owner } = await seed('research_excluded', upstream as typeof fetch);
    await expect(compareAndPropose(env, { ownerId: owner, projectId: pid, stage: 'comparison' }, {}, upstream as typeof fetch)).rejects.toMatchObject({ code: 'excluded_sources' });
    expect(upstream.mock.calls.every(([input]) => String(input).startsWith('https://api.crossref.org/'))).toBe(true);
    const answer = await client.call('POST', `/api/projects/${pid}/questions`, { question: 'How was the test oxide prepared?' });
    expect(answer.data.answer.insufficient_evidence).toBe(true);
    expect(answer.data.answer.answer).toMatch(/excluded/);
  });
});
