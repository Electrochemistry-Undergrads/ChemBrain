import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, setupEnv } from './helpers';
import { keywordPlan } from '../server/search/keywords';
import type { Env } from '../server/env';

let env: Env;
let dispose: () => Promise<void>;
beforeAll(async () => {
  ({ env, dispose } = await setupEnv({ MODEL_API_KEY: undefined }));
});
afterAll(() => dispose());

describe('one-box search from a description', () => {
  it('builds keyword queries that keep chemistry terms and drop filler', () => {
    const p = keywordPlan('I want a biodegradable, water-resistant packaging film made from PLA or TiO2-filled chitosan, cast below 100 °C.');
    const all = p.queries.map((q) => q.query).join(' | ');
    expect(p.queries.length).toBeGreaterThan(0);
    expect(p.queries.length).toBeLessThanOrEqual(4);
    expect(all).toMatch(/biodegradable/);
    expect(all).toMatch(/PLA/);
    expect(all).toMatch(/TiO2-filled/);
    expect(all).not.toMatch(/\bwant\b|\bmade\b/);
    expect(p.queries.every((q) => q.query.split(' ').length <= 8)).toBe(true);
    expect(keywordPlan('A water-resistant biodegradable packaging film made from chitosan or starch, cast from water.').queries.map((q) => q.query)).not.toContain('cast water');
  });

  it('creates a named project from a description and plans a keyword search when Meta is not configured', async () => {
    const c = new Client(env);
    await c.signup('describe_user');
    expect((await c.call('POST', '/api/projects', { description: 'film' })).status).toBe(400);
    const r = await c.call('POST', '/api/projects', { description: 'A biodegradable, water-resistant packaging film from starch. Low water vapour permeability.' });
    expect(r.status).toBe(201);
    expect(r.data.project.name).toBe('A biodegradable, water-resistant packaging film from starch');
    const pid = r.data.project.id;
    const proj = (await c.call('GET', `/api/projects/${pid}`)).data.project;
    expect(proj.brief).toEqual({ description: 'A biodegradable, water-resistant packaging film from starch. Low water vapour permeability.' });
    const plan = await c.call('POST', `/api/projects/${pid}/plan`);
    expect(plan.status).toBe(200);
    expect(plan.data.plan.method).toBe('keywords');
    expect(plan.data.plan.queries[0].query).toMatch(/starch/);
    // Updating the description replaces it; the old multi-field brief is not accepted.
    expect((await c.call('PATCH', `/api/projects/${pid}`, { brief: { product: 'x' } })).status).toBe(400);
    expect((await c.call('PATCH', `/api/projects/${pid}`, { brief: { description: 'Chitosan coating for paper cups' } })).status).toBe(200);
  });
});
