// LIVE integration check (not part of `npm test`). Reads credentials from .dev.vars.live-test,
// performs at most a handful of real requests per service, and prints only statuses and
// redacted messages. A pass here verifies the integration from THIS machine's network, which may
// differ from Cloudflare's (e.g. campus IP entitlement).
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { testElsevier } from '../../server/connectors/elsevier';
import { testSpringer } from '../../server/connectors/springer';
import { testWiley } from '../../server/connectors/wiley';
import { callMetaJson, checkModel } from '../../server/meta/client';
import { redact } from '../../server/crypto/secrets';
import { z } from 'zod';

const vars: Record<string, string> = {};
if (existsSync('.dev.vars.live-test')) {
  for (const line of readFileSync('.dev.vars.live-test', 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[2]) vars[m[1]] = m[2];
  }
}
const secrets = Object.values(vars);
const show = (label: string, checks: { name: string; status: string; message: string }[]) =>
  console.log(`\n${label}\n` + checks.map((c) => `  [${c.status}] ${c.name}: ${redact(c.message, secrets)}`).join('\n'));
const memDb = { prepare: () => ({ bind: () => ({ first: async () => ({ window_start: Date.now(), count: 1 }), run: async () => ({}) }) }), batch: async () => [] } as unknown as D1Database;
const ctx = (creds: object) => ({ env: { DB: memDb } as never, userId: 'live', creds, settings: {}, fetch });

describe('live integrations', () => {
  it.skipIf(!vars.ELSEVIER_API_KEY)('Elsevier', async () => {
    const checks = await testElsevier(ctx({ elsevier: { apiKey: vars.ELSEVIER_API_KEY, instToken: vars.ELSEVIER_INSTTOKEN || undefined } }));
    show('Elsevier', checks);
    expect(checks[0].status).not.toBe('fail');
  });
  it.skipIf(!vars.SPRINGER_API_KEY)('Springer Nature', async () => {
    const checks = await testSpringer(ctx({ springer: { apiKey: vars.SPRINGER_API_KEY } }));
    show('Springer Nature', checks);
    expect(checks[0].status).not.toBe('fail');
  });
  it.skipIf(!vars.WILEY_TDM_TOKEN)('Wiley', async () => {
    const checks = await testWiley(ctx({ wiley: { tdmToken: vars.WILEY_TDM_TOKEN } }));
    show('Wiley', checks);
    expect(checks[0].status).not.toBe('fail');
  });
  it.skipIf(!vars.MODEL_API_KEY)('Meta', async () => {
    const env = { DB: memDb, MODEL_API_KEY: vars.MODEL_API_KEY } as never;
    const status = await checkModel(env);
    console.log(`\nMeta: ${status.ok ? 'available' : 'unavailable'} (${status.model}) ${status.message}`);
    expect(status.ok).toBe(true);
    const schema = z.strictObject({ boiling_point_c: z.number(), quote: z.string() });
    const r = await callMetaJson(env, { ownerId: 'live', stage: 'question' }, {
      system: 'Answer only from the document. Respond with JSON matching the schema.',
      user: '<document>Water boils at 100 °C at 1 atm.</document> What is the boiling point in °C? Quote the sentence.',
      schema,
      jsonSchema: { type: 'object', properties: { boiling_point_c: { type: 'number' }, quote: { type: 'string' } }, required: ['boiling_point_c', 'quote'], additionalProperties: false },
      schemaName: 'live_check',
      maxCompletionTokens: 2000,
    }).catch((e) => ({ error: redact(String(e.message), secrets) }) as never);
    console.log('Meta structured output:', JSON.stringify((r as { data?: unknown }).data ?? r));
    expect((r as { data: { boiling_point_c: number } }).data.boiling_point_c).toBe(100);
  });
});
