import { describe, expect, it } from 'vitest';
import { policyFetch, UpstreamError } from '../server/http/fetcher';
import { elsevierEntitlement, elsevierRetrieve, testElsevier } from '../server/connectors/elsevier';
import { springerRetrieve, springerSearch, testSpringer } from '../server/connectors/springer';
import { testWiley, wileyRetrieve } from '../server/connectors/wiley';
import { retrievePaper } from '../server/connectors';
import { publisherOf, isOpenLicense } from '../server/connectors/publishers';
import type { ConnectorContext } from '../server/connectors/types';
import { normalizeUnit } from '../server/evidence/units';
import { matchQuote, valueInQuote } from '../server/evidence/verify';

// LABELLED FIXTURES: simulated publisher responses. They test ChemBrain's handling of documented
// behaviours; they do not verify live access to any publisher.
type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
function mockFetch(h: Handler) {
  const calls: { url: string; headers: Headers }[] = [];
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), headers: new Headers(init.headers) });
    return h(url, init);
  }) as typeof fetch;
  return { f, calls };
}
const memDb = () => {
  const rows = new Map<string, number>();
  return {
    prepare: (_sql: string) => ({
      bind: (key: string, now: number, interval: number) => ({
        first: async () => {
          const prev = rows.get(key);
          const fresh = prev === undefined || prev + interval <= now;
          if (fresh) rows.set(key, now);
          return { window_start: fresh ? now : prev, count: fresh ? 1 : 2 };
        },
      }),
    }),
  } as unknown as D1Database;
};
const ctxWith = (f: typeof fetch, creds: ConnectorContext['creds'] = {}, settings: ConnectorContext['settings'] = {}): ConnectorContext => ({ env: { DB: memDb() } as never, userId: 'u1', creds, settings, fetch: f });
const paper = (doi: string) => ({ doi, title: 'A film', publisher: null });

describe('policyFetch', () => {
  it('retries 429 honoring Retry-After, then succeeds', async () => {
    let n = 0;
    const { f } = mockFetch(() => (++n === 1 ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : new Response('ok')));
    const r = await policyFetch('https://api.example.org/x', {}, { service: 'X', retries: 2 }, f);
    expect(await r.text()).toBe('ok');
    expect(n).toBe(2);
  });
  it('gives up after bounded retries with an explicit reason', async () => {
    const { f, calls } = mockFetch(() => new Response('', { status: 503 }));
    await expect(policyFetch('https://api.example.org/x', {}, { service: 'X', retries: 1 }, f)).rejects.toThrow(/temporary error/);
    expect(calls.length).toBe(2);
  });
  it('does not wait out long Retry-After values inside a request', async () => {
    const { f, calls } = mockFetch(() => new Response('', { status: 429, headers: { 'retry-after': '3600' } }));
    const err = await policyFetch('https://api.example.org/x', {}, { service: 'X', retries: 3 }, f).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.retryAfterMs).toBeGreaterThan(3_000_000);
    expect(calls.length).toBe(1);
  });
  it('times out', async () => {
    const f = ((_: RequestInfo, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted'))))) as typeof fetch;
    await expect(policyFetch('https://slow.example.org', {}, { service: 'Slow', timeoutMs: 50, retries: 0 }, f)).rejects.toThrow(/did not respond/);
  });
  it('refuses redirects to unexpected hosts and never forwards credentials cross-host', async () => {
    const { f } = mockFetch(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }));
    await expect(policyFetch('https://api.elsevier.com/a', { headers: { 'X-ELS-APIKey': 'k' } }, { service: 'Elsevier', redirectHosts: ['api.elsevier.com'] }, f)).rejects.toThrow(/unexpected site/);
    const m = mockFetch((u) => (u.hostname === 'api.wiley.com' ? new Response(null, { status: 302, headers: { location: 'https://files.example-cdn.net/a.pdf' } }) : new Response('%PDF-1.7 ...')));
    await policyFetch('https://api.wiley.com/x', { headers: { 'Wiley-TDM-Client-Token': 'tok' } }, { service: 'Wiley', redirectHosts: ['wiley.com'], foreignRedirectStripHeaders: ['Wiley-TDM-Client-Token'] }, m.f);
    expect(m.calls[1].headers.get('wiley-tdm-client-token')).toBeNull();
    expect(m.calls[0].headers.get('wiley-tdm-client-token')).toBe('tok');
  });
});

describe('Elsevier connector', () => {
  it('reads XML open_access entitlement and sends a safely encoded DOI query', async () => {
    const { f, calls } = mockFetch(() => new Response('<entitlement-response><document-entitlement status="found"><entitled>open_access</entitled></document-entitlement></entitlement-response>'));
    expect((await elsevierEntitlement(ctxWith(f, { elsevier: { apiKey: 'key' } }), '10.1016/S0014-5793(01)03313-0')).entitled).toBe(true);
    expect(new URL(calls[0].url).searchParams.get('doi')).toBe('10.1016/S0014-5793(01)03313-0');
    expect(calls[0].headers.get('accept')).toBe('text/xml');
  });
  it('does not let an entitlement HTTP 500 block authenticated Article Retrieval', async () => {
    const { f, calls } = mockFetch((u) => u.pathname.includes('entitlement')
      ? new Response('', { status: 500, headers: { 'retry-after': '99' } })
      : new Response('<full-text-retrieval-response><originalText/></full-text-retrieval-response>'));
    const r = await elsevierRetrieve(ctxWith(f, { elsevier: { apiKey: 'key' } }), paper('10.1016/j.x.2020.1'));
    expect(r.status).toBe('full_text');
    expect(r.entitlement).toBe('unknown');
    expect(calls).toHaveLength(2);
  });
  it('validates the key independently and warns when the entitlement service fails', async () => {
    const { f } = mockFetch((u) => u.pathname.includes('entitlement')
      ? new Response('', { status: 500, headers: { 'retry-after': '99' } })
      : new Response('<full-text-retrieval-response><coredata/></full-text-retrieval-response>'));
    const checks = await testElsevier(ctxWith(f, { elsevier: { apiKey: 'key' } }));
    expect(checks.find((c) => c.name === 'API key')?.status).toBe('pass');
    expect(checks.find((c) => c.name === 'Entitlement service')?.status).toBe('warn');
    expect(checks.find((c) => c.name === 'Subscription entitlement')?.status).toBe('warn');
  });
  it('accepts Article Retrieval when this key lacks Entitlement API permission', async () => {
    for (const status of [401, 403]) {
      const { f } = mockFetch((u) => u.pathname.includes('entitlement')
        ? new Response('', { status })
        : new Response('<full-text-retrieval-response><originalText/></full-text-retrieval-response>'));
      const ctx = ctxWith(f, { elsevier: { apiKey: 'key' } });
      expect((await elsevierRetrieve(ctx, paper('10.1016/j.x.2020.1'))).status).toBe('full_text');
      const checks = await testElsevier(ctx);
      expect(checks.find((c) => c.name === 'API key')?.status).toBe('pass');
      expect(checks.find((c) => c.name === 'Subscription entitlement')?.status).toBe('warn');
    }
  });
  it('still rejects credentials that the Article Retrieval API rejects', async () => {
    const { f } = mockFetch(() => new Response('', { status: 401 }));
    const ctx = ctxWith(f, { elsevier: { apiKey: 'invalid-key' } });
    expect((await elsevierRetrieve(ctx, paper('10.1016/j.x.2020.1'))).status).toBe('credentials_invalid');
    expect((await testElsevier(ctx)).find((c) => c.name === 'API key')?.status).toBe('fail');
  });
  it('reports missing credentials plainly', async () => {
    const r = await elsevierRetrieve(ctxWith(mockFetch(() => new Response('')).f), paper('10.1016/j.x.2020.1'));
    expect(r.status).toBe('credentials_missing');
  });
  it('does not assume the cloud server has campus IP entitlement', async () => {
    const { f, calls } = mockFetch(() => Response.json({ 'entitlement-response': { 'document-entitlement': { entitled: false } } }));
    const r = await elsevierRetrieve(ctxWith(f, { elsevier: { apiKey: 'key' } }), paper('10.1016/j.x.2020.1'));
    expect(r.status).toBe('institutional_connection_required');
    expect(r.reason).toMatch(/institutional token/);
    expect(calls).toHaveLength(1); // no full-text request after a negative entitlement
    expect(calls[0].headers.get('x-els-apikey')).toBe('key');
  });
  it('sends the institutional token and retrieves XML when entitled', async () => {
    const { f, calls } = mockFetch((u) => (u.pathname.includes('entitlement') ? Response.json({ 'entitlement-response': { 'document-entitlement': { entitled: true } } }) : new Response('<full-text-retrieval-response/>', { headers: { 'content-type': 'text/xml' } })));
    const r = await elsevierRetrieve(ctxWith(f, { elsevier: { apiKey: 'key', instToken: 'inst' } }), paper('10.1016/j.x.2020.1'));
    expect(r.status).toBe('full_text');
    expect(calls[1].url).toContain('view=FULL');
    expect(calls[1].headers.get('x-els-insttoken')).toBe('inst');
    expect(calls[1].headers.get('accept')).toBe('text/xml');
  });
  it('classifies quota exhaustion', async () => {
    const { f } = mockFetch((u) => (u.pathname.includes('entitlement') ? Response.json({ 'entitlement-response': { 'document-entitlement': { entitled: true } } }) : new Response('', { status: 429, headers: { 'x-els-status': 'QUOTA_EXCEEDED - Quota Exceeded', 'retry-after': '99999' } })));
    const r = await elsevierRetrieve(ctxWith(f, { elsevier: { apiKey: 'key' } }), paper('10.1016/j.x.2020.1'));
    expect(r.status).toBe('rate_limited');
  });
});

describe('Wiley connector', () => {
  it('probes a real HTTPS download redirect without following it, and explains subscription 403 separately', async () => {
    const { f, calls } = mockFetch((u) => u.pathname.includes('fsn3')
      ? new Response(null, { status: 302, headers: { location: 'https://files.wiley.com/article.pdf' } })
      : new Response(null, { status: 403 }));
    const ctx = ctxWith(f, { wiley: { tdmToken: 'token' } });
    // This test checks redirect classification, not pacing (covered below).
    ctx.env.DB = { prepare: () => ({ bind: () => ({ first: async () => ({ window_start: Date.now(), count: 1 }) }) }) } as unknown as D1Database;
    const checks = await testWiley(ctx);
    expect(checks.map((c) => c.status)).toEqual(['pass', 'warn']);
    expect(checks[1].message).toMatch(/accepted your token/);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => new URL(c.url).hostname === 'api.wiley.com')).toBe(true);
  });
  it('does not treat refused or login redirects as proof of a valid token', async () => {
    for (const location of ['http://files.wiley.com/article.pdf', 'https://onlinelibrary.wiley.com/login']) {
      const { f } = mockFetch(() => new Response(null, { status: 302, headers: { location } }));
      const ctx = ctxWith(f, { wiley: { tdmToken: 'token' } });
      ctx.env.DB = { prepare: () => ({ bind: () => ({ first: async () => ({ window_start: Date.now(), count: 1 }) }) }) } as unknown as D1Database;
      expect((await testWiley(ctx))[0].status).toBe('fail');
    }
  });
  it('maps 403/404 to invalid token and institutional-network requirement', async () => {
    const r403 = await wileyRetrieve(ctxWith(mockFetch(() => new Response('', { status: 403 })).f, { wiley: { tdmToken: 't' } }), paper('10.1002/x.1'));
    expect(r403.status).toBe('credentials_invalid');
    const r404 = await wileyRetrieve(ctxWith(mockFetch(() => new Response('', { status: 404 })).f, { wiley: { tdmToken: 't' } }), paper('10.1002/x.2'));
    expect(r404.status).toBe('institutional_connection_required');
  });
  it('rejects HTML login pages served instead of a PDF', async () => {
    const r = await wileyRetrieve(ctxWith(mockFetch(() => new Response('<!DOCTYPE html><title>Login</title>', { headers: { 'content-type': 'text/html' } })).f, { wiley: { tdmToken: 't' } }), paper('10.1002/x.3'));
    expect(r.status).toBe('failed');
    expect(r.reason).toMatch(/not a PDF/);
  });
  it('enforces the documented 10-second interval per user', async () => {
    const ctx = ctxWith(mockFetch(() => new Response('%PDF-1.7')).f, { wiley: { tdmToken: 't' } });
    expect((await wileyRetrieve(ctx, paper('10.1002/x.4'))).status).toBe('full_text');
    const second = await wileyRetrieve(ctx, paper('10.1002/x.5'));
    expect(second.status).toBe('rate_limited');
    expect(second.retryAfterMs).toBeGreaterThan(9000);
  });
});

describe('Springer Nature connector', () => {
  it('uses API-specific keys for discovery, OA, and subscription retrieval', async () => {
    const creds = { springer: { apiKey: 'legacy', metaApiKey: 'meta-key', openAccessApiKey: 'oa-key', fullTextApiKey: 'full-key/metric' } };
    const { f, calls } = mockFetch((u) => u.pathname.startsWith('/meta')
      ? Response.json({ records: [] })
      : u.pathname.startsWith('/openaccess') ? new Response('<response><records/></response>') : new Response('<article><body/></article>'));
    const ctx = ctxWith(f, creds, { springer: { fullTextAgreement: true } });
    await springerSearch(ctx, 'chemistry');
    const attempts = await springerRetrieve(ctx, paper('10.1038/nchem.1'));
    expect(calls.map((c) => new URL(c.url).searchParams.get('api_key'))).toEqual(['meta-key', 'oa-key', 'full-key/metric']);
    expect(attempts.at(-1)?.status).toBe('full_text');
  });
  it('allows an OA-only connection without failing a missing Meta API key', async () => {
    const { f, calls } = mockFetch(() => new Response('<article><body/></article>'));
    const ctx = ctxWith(f, { springer: { openAccessApiKey: 'oa-only' } });
    expect((await testSpringer(ctx)).map((c) => c.status)).toEqual(['skipped', 'pass', 'skipped']);
    expect(calls).toHaveLength(1);
    expect((await springerRetrieve(ctx, paper('10.1038/s41598-020-70651-5')))[0].status).toBe('full_text');
  });
  it('keeps an existing shared OA-only key usable while warning that metadata access is unavailable', async () => {
    const { f } = mockFetch((u) => u.pathname.startsWith('/meta') ? new Response('', { status: 401 }) : new Response('<article><body/></article>'));
    const checks = await testSpringer(ctxWith(f, { springer: { apiKey: 'existing-oa-key' } }));
    expect(checks.map((c) => c.status)).toEqual(['warn', 'pass', 'skipped']);
    expect(checks[0].message).toMatch(/shared key works/);
    const explicit = await testSpringer(ctxWith(f, { springer: { metaApiKey: 'invalid-meta-key', openAccessApiKey: 'working-oa-key' } }));
    expect(explicit.map((c) => c.status)).toEqual(['fail', 'pass', 'skipped']);
  });
  it('fails a shared key rejected by all APIs instead of reporting a working connection', async () => {
    const { f } = mockFetch(() => new Response('', { status: 401 }));
    expect((await testSpringer(ctxWith(f, { springer: { apiKey: 'invalid-shared-key' } }))).map((c) => c.status)).toEqual(['fail', 'fail', 'skipped']);
  });
  it('still tries approved Full Text access when the OA key is rejected or missing', async () => {
    for (const oaKey of ['bad-oa', undefined]) {
      const { f, calls } = mockFetch((u) => u.pathname.startsWith('/openaccess') ? new Response(null, { status: 401 }) : new Response('<article><body/></article>'));
      const ctx = ctxWith(f, { springer: { openAccessApiKey: oaKey, fullTextApiKey: 'full/metric' } }, { springer: { fullTextAgreement: true } });
      const attempts = await springerRetrieve(ctx, paper('10.1038/nchem.1'));
      expect(attempts.at(-1)?.status).toBe('full_text');
      expect(calls.at(-1)?.url).toContain('/xmldata/jats');
    }
  });
  it('uses the Open Access API and never treats an OA key as subscription access', async () => {
    const { f, calls } = mockFetch(() => new Response('<response><result><total>0</total></result><records/></response>'));
    const attempts = await springerRetrieve(ctxWith(f, { springer: { apiKey: 'k' } }), paper('10.1038/nchem.1'));
    expect(attempts.map((a) => a.status)).toEqual(['not_applicable', 'agreement_required']);
    expect(calls.every((c) => !c.url.includes('/xmldata/'))).toBe(true);
  });
  it('only calls the Full Text API when the user declares an agreement', async () => {
    const { f, calls } = mockFetch((u) => (u.pathname.startsWith('/openaccess') ? new Response('<response><records/></response>') : new Response('', { status: 403 })));
    const attempts = await springerRetrieve(ctxWith(f, { springer: { apiKey: 'k' } }, { springer: { fullTextAgreement: true } }), paper('10.1038/nchem.1'));
    expect(calls.some((c) => c.url.includes('/xmldata/jats'))).toBe(true);
    expect(attempts[1].status).toBe('agreement_required');
  });
  it('connection test skips subscription checks without an agreement', async () => {
    const { f } = mockFetch((u) => (u.pathname.startsWith('/meta') ? Response.json({ records: [] }) : new Response('<response><records><article><front/></article></records></response>')));
    const checks = await testSpringer(ctxWith(f, { springer: { apiKey: 'k' } }));
    expect(checks.map((c) => c.status)).toEqual(['pass', 'pass', 'skipped']);
  });
});

describe('routing and retrieval honesty', () => {
  it('keeps website Springer retrieval OA-only even with legacy full-text credentials and settings', async () => {
    const { f, calls } = mockFetch((u) => u.hostname === 'api.springernature.com'
      ? new Response('<response><records/></response>')
      : Response.json({ resultList: { result: [] } }));
    const result = await retrievePaper(ctxWith(f, { springer: { apiKey: 'legacy', metaApiKey: 'metadata', fullTextApiKey: 'full/metric' } }, { springer: { fullTextAgreement: true } }), paper('10.1038/test.1'));
    expect(result.attempts.every((a) => a.connector !== 'springer_fulltext')).toBe(true);
    expect(calls.filter((c) => new URL(c.url).hostname === 'api.springernature.com').map((c) => new URL(c.url).pathname)).toEqual(['/openaccess/jats']);
  });
  it('does not call the removed Elsevier server connection even with saved credentials', async () => {
    const { f, calls } = mockFetch(() => Response.json({ resultList: { result: [] } }));
    const result = await retrievePaper(ctxWith(f, { elsevier: { apiKey: 'saved-key' } }), paper('10.1016/j.test.1'));
    expect(result.success).toBeNull();
    expect(result.attempts[0].reason).toMatch(/Elsevier from this browser/);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => new URL(c.url).hostname !== 'api.elsevier.com')).toBe(true);
  });
  it('routes DOIs to publishers', () => {
    expect(publisherOf('10.1016/j.foodhyd.2020.1')).toBe('elsevier');
    expect(publisherOf('10.1002/app.1')).toBe('wiley');
    expect(publisherOf('10.1038/s41598-020-70651-5')).toBe('springer');
    expect(publisherOf('10.1021/acs.x', 'American Chemical Society')).toBeNull();
    expect(isOpenLicense('https://creativecommons.org/licenses/by/4.0/')).toBe(true);
    expect(isOpenLicense('https://www.elsevier.com/tdm/userlicense/1.0/')).toBe(false);
  });
  it('never counts a missing full text as success, and keeps every attempt', async () => {
    const { f } = mockFetch((u) => (u.hostname === 'www.ebi.ac.uk' ? Response.json({ resultList: { result: [] } }) : new Response('', { status: 404 })));
    const r = await retrievePaper(ctxWith(f, { wiley: { tdmToken: 't' } }), paper('10.1002/x.9'));
    expect(r.success).toBeNull();
    expect(r.attempts.map((a) => a.connector)).toEqual(['europepmc', 'wiley']);
  });
});

describe('units and quotes', () => {
  it('converts unambiguous units, keeps originals, and refuses bare %', () => {
    expect(normalizeUnit(2, 'h')).toEqual({ value: 120, unit: 'min', note: 'Converted from 2 h.' });
    expect(normalizeUnit(298.15, 'K').value).toBeCloseTo(25);
    expect(normalizeUnit(5, 'mM')).toMatchObject({ value: 0.005, unit: 'mol/L' });
    expect(normalizeUnit(5, 'mm')).toMatchObject({ value: 5000, unit: 'μm' });
    expect(normalizeUnit(30, '%').value).toBeNull();
    expect(normalizeUnit(30, 'g·m/m²·s·Pa').value).toBeNull();
    expect(normalizeUnit(null, 'h').value).toBeNull();
  });
  it('matches quotes across hyphenation, ligatures and whitespace, and checks values', () => {
    const src = 'The films were dried at 40 °C for 24 h in a desic-\ncator; ﬁlm thickness was 0.12 mm.';
    expect(matchQuote('dried at 40 °C for 24 h', src)).toBe('exact');
    expect(matchQuote('in a desiccator; film thickness was 0.12 mm', src)).toBe('normalized');
    expect(matchQuote('dried at 60 °C for 24 h', src)).toBe('not_found');
    expect(valueInQuote(0.12, 'film thickness was 0.12 mm')).toBe(true);
    expect(valueInQuote(1000, 'a load of 1,000 N')).toBe(true);
    expect(valueInQuote(1.2e-10, 'WVP of 1.2 × 10−10 g/m s Pa')).toBe(true);
    expect(valueInQuote(25, 'dried at 40 °C')).toBe(false);
  });
});
