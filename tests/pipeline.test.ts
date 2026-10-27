import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, setupEnv } from './helpers';
import { fakeMeta } from './fixtures';
import type { Env } from '../server/env';

let env: Env;
let dispose: () => Promise<void>;
beforeAll(async () => {
  ({ env, dispose } = await setupEnv({ MODEL_API_KEY: 'LLM_1_test-key-not-real' }));
});
afterAll(() => dispose());

async function runToEnd(c: Client, pid: string, jobId: string, max = 80) {
  let last: any;
  for (let i = 0; i < max; i++) {
    last = (await c.call('POST', `/api/projects/${pid}/jobs/${jobId}/step`)).data;
    if (['complete', 'complete_with_errors', 'paused', 'cancelled'].includes(last.job.status)) return last;
    if (last.nextRunAt) await env.DB.prepare("UPDATE job_tasks SET lease_until = NULL WHERE status = 'pending'").run(); // skip back-off waits in tests
  }
  return last;
}

describe('demo workflow with fixture Meta responses', () => {
  it('retrieves bundled papers, extracts evidence, rejects unsupported quotes, validates citations, and exports', async () => {
    const meta = fakeMeta({ failFirst: 1 }); // first Meta call fails with 503 to exercise retry
    const c = new Client(env, meta.impl);
    await c.signup('pipeline_user');
    const pid = (await c.call('POST', '/api/projects/demo')).data.project.id;
    const jobId = (await c.call('POST', `/api/projects/${pid}/jobs`)).data.jobId;
    expect((await c.call('POST', `/api/projects/${pid}/jobs`)).status).toBe(409); // one job at a time
    const end = await runToEnd(c, pid, jobId);
    expect(end.job.status).toBe('complete');
    expect(end.failures).toEqual([]);

    const papers = (await c.call('GET', `/api/projects/${pid}/papers`)).data.papers;
    for (const p of papers) {
      expect(p.retrieval_status).toBe('full_text_retrieved');
      expect(p.parse_status).toBe('parsed');
      expect(p.ai_permission).toBe('open_license');
      expect(p.analysis_status).toBe('analysis_complete');
      expect(p.connector).toBe('demo_bundle');
      expect(p.retrieval_log[0].reason).toMatch(/Not a live publisher call/);
    }
    const ev = (await c.call('GET', `/api/projects/${pid}/evidence`)).data.evidence;
    const fabricated = ev.filter((e: any) => e.subject === 'fabricated');
    expect(fabricated.length).toBeGreaterThan(0);
    expect(fabricated.every((e: any) => e.quote_match === 'not_found' && e.check_status === 'unsupported')).toBe(true);
    const mismatch = ev.filter((e: any) => e.subject === 'value mismatch');
    expect(mismatch.every((e: any) => e.check_status === 'unsupported' && /does not appear/.test(e.check_note))).toBe(true);
    const good = ev.filter((e: any) => e.subject === 'test item');
    expect(good.length).toBeGreaterThan(0);
    expect(good.every((e: any) => e.quote_match !== 'not_found' && e.check_status === 'supported')).toBe(true);
    // Every stored quote that is accepted actually occurs in its cited chunk.
    for (const e of good.slice(0, 5)) {
      const chunk = (await c.call('GET', `/api/projects/${pid}/chunks/${e.chunk_id}`)).data.chunk;
      expect(chunk.text.replace(/\s+/g, ' ')).toContain(e.quote.replace(/\s+/g, ' '));
    }
    const fabricatedIds = new Set(fabricated.map((e: any) => e.id));

    const rep = (await c.call('GET', `/api/projects/${pid}/report`)).data.report.report;
    expect(rep.validation.removedReferences).toBe(3); // P99, E9999 twice
    expect(rep.proposal.approaches[0].performance).toEqual([]); // value with only an invalid citation is dropped
    expect(rep.validation.unsupportedStatements.join(' ')).toMatch(/WVP/);
    expect(Object.values(rep.evidence).some((id) => fabricatedIds.has(id))).toBe(false);

    const md = (await c.call('GET', `/api/projects/${pid}/export.md`)).text;
    expect(md).toMatch(/Demonstration project/);
    expect(md).toMatch(/\[\^e1\]:/);
    expect(md).not.toContain('LLM_1_test-key-not-real');
    const js = (await c.call('GET', `/api/projects/${pid}/export.json`)).text;
    expect(js).not.toContain('LLM_1_test-key-not-real');
    expect(JSON.parse(js).notice).toMatch(/not been experimentally validated/);

    const q = await c.call('POST', `/api/projects/${pid}/questions`, { question: 'Which plasticizer concentration was used for the starch films?' });
    expect(q.status).toBe(200);
    expect(q.data.citations[0].match).not.toBe('not_found');
    expect(meta.calls.filter((x) => x === 'evidence_extraction').length).toBeGreaterThanOrEqual(4);
  });

  it('recovers a task whose worker died mid-step (expired lease)', async () => {
    const meta = fakeMeta();
    const c = new Client(env, meta.impl);
    await c.signup('recovery_user');
    const pid = (await c.call('POST', '/api/projects/demo')).data.project.id;
    const jobId = (await c.call('POST', `/api/projects/${pid}/jobs`)).data.jobId;
    // Simulate a crash: the first task is left "running" with a lease that has expired.
    await env.DB.prepare("UPDATE job_tasks SET status = 'running', attempts = 1, lease_until = ? WHERE job_id = ? AND seq = 0").bind(Date.now() - 1000, jobId).run();
    const end = await runToEnd(c, pid, jobId);
    expect(end.job.status).toBe('complete');
  });

  it('pauses (not fails) when Meta is not configured, and keeps retrieval results', async () => {
    const { env: e2, dispose: d2 } = await setupEnv({ MODEL_API_KEY: undefined });
    const c = new Client(e2);
    await c.signup('nometa_user');
    const pid = (await c.call('POST', '/api/projects/demo')).data.project.id;
    const jobId = (await c.call('POST', `/api/projects/${pid}/jobs`)).data.jobId;
    let last: any;
    for (let i = 0; i < 5; i++) last = (await c.call('POST', `/api/projects/${pid}/jobs/${jobId}/step`)).data;
    expect(last.job.status).toBe('paused');
    expect(last.job.error).toMatch(/MODEL_API_KEY/);
    const papers = (await c.call('GET', `/api/projects/${pid}/papers`)).data.papers;
    expect(papers.filter((p: any) => p.retrieval_status === 'full_text_retrieved').length).toBe(1);
    await d2();
  });

  it('enforces the per-job model budget', async () => {
    const { env: e3, dispose: d3 } = await setupEnv({ MODEL_API_KEY: 'LLM_1_x', META_JOB_TOKEN_BUDGET: '1500' });
    const c = new Client(e3, fakeMeta().impl);
    await c.signup('budget_user');
    const pid = (await c.call('POST', '/api/projects/demo')).data.project.id;
    const jobId = (await c.call('POST', `/api/projects/${pid}/jobs`)).data.jobId;
    let last: any;
    for (let i = 0; i < 12; i++) last = (await c.call('POST', `/api/projects/${pid}/jobs/${jobId}/step`)).data;
    expect(last.job.status).toBe('paused');
    expect(last.job.error).toMatch(/budget/);
    await d3();
  });
});
