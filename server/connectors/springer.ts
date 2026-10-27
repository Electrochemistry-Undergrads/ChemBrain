import { policyFetch, readCapped } from '../http/fetcher';
import { normalizeDoi } from '../util';
import { fromUpstream } from './europepmc';
import type { Candidate, ConnectorContext, PaperRef, RetrievalAttempt, TestCheck } from './types';

/**
 * Springer Nature APIs (https://dev.springernature.com):
 * - Meta API v2 for discovery: /meta/v2/json
 * - Open Access API for open-access full text: /openaccess/jats
 * - Full Text API (/xmldata/jats) only for users who hold an approved TDM agreement. An open-access
 *   or metadata key does not unlock subscription articles; we never treat it as if it did.
 * Basic plan: 100 requests/min and 500/day per API; we pace at ~1 request per 650 ms.
 */
const BASE = 'https://api.springernature.com';
const POLICY = { service: 'Springer Nature', timeoutMs: 25_000, retries: 2, minIntervalMs: 650, redirectHosts: ['api.springernature.com'] };

interface MetaRecord {
  doi?: string;
  title?: string;
  creators?: { creator?: string }[];
  publicationName?: string;
  publisher?: string;
  publicationDate?: string;
  abstract?: string | { p?: string | string[] };
  openaccess?: string;
  url?: { format?: string; value?: string }[];
}

function abstractOf(a: MetaRecord['abstract']) {
  if (!a) return null;
  if (typeof a === 'string') return a.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const p = Array.isArray(a.p) ? a.p.join(' ') : a.p;
  return p ? p.replace(/\s+/g, ' ').trim() : null;
}

export async function springerSearch(ctx: ConnectorContext, query: string, pageSize = 20): Promise<Candidate[]> {
  const key = ctx.creds.springer?.metaApiKey || ctx.creds.springer?.apiKey;
  if (!key) return [];
  const params = new URLSearchParams({ q: query, p: String(Math.min(pageSize, 25)), s: '1', api_key: key });
  const res = await policyFetch(`${BASE}/meta/v2/json?${params}`, {}, POLICY, ctx.fetch);
  if (!res.ok) throw new Error(`Springer Nature search failed (HTTP ${res.status}).`);
  const j = (await res.json()) as { records?: MetaRecord[] };
  return (j.records ?? [])
    .filter((r) => r.title)
    .map((r) => ({
      doi: normalizeDoi(r.doi),
      title: r.title!.trim(),
      authors: (r.creators ?? []).slice(0, 6).map((c) => c.creator).filter(Boolean).join('; ') || null,
      year: r.publicationDate ? Number(r.publicationDate.slice(0, 4)) : null,
      venue: r.publicationName ?? null,
      publisher: r.publisher ?? 'Springer Nature',
      abstract: abstractOf(r.abstract),
      landingUrl: r.doi ? `https://doi.org/${r.doi}` : null,
      license: r.openaccess === 'true' ? 'open access (Springer Nature)' : null,
      source: 'springer',
    }));
}

function jatsKey(ctx: ConnectorContext, path: '/openaccess/jats' | '/xmldata/jats') {
  const creds = ctx.creds.springer;
  return (path === '/openaccess/jats' ? creds?.openAccessApiKey : creds?.fullTextApiKey) || creds?.apiKey;
}

async function jats(ctx: ConnectorContext, path: '/openaccess/jats' | '/xmldata/jats', doi: string) {
  const params = new URLSearchParams({ q: `doi:${doi}`, p: '1', api_key: jatsKey(ctx, path)! });
  return policyFetch(`${BASE}${path}?${params}`, { headers: { accept: 'application/xml' } }, POLICY, ctx.fetch);
}

export async function springerRetrieve(ctx: ConnectorContext, paper: PaperRef): Promise<RetrievalAttempt[]> {
  if (!paper.doi) return [{ connector: 'springer_oa', status: 'not_applicable', reason: 'Springer Nature lookup needs a DOI.' }];
  const attempts: RetrievalAttempt[] = [];
  if (!jatsKey(ctx, '/openaccess/jats')) {
    attempts.push({ connector: 'springer_oa', status: 'credentials_missing', reason: 'Add a Springer Nature Open Access API key (or a shared key enabled for that API) under Publisher connections.' });
  } else try {
    const res = await jats(ctx, '/openaccess/jats', paper.doi);
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      attempts.push({ connector: 'springer_oa', status: 'credentials_invalid', reason: 'Springer Nature rejected the Open Access credential. Verify that Open Access API access is active in API Management and copy its credential into the Open Access API key field.' });
    } else if (!res.ok) {
      await res.body?.cancel();
      attempts.push({ connector: 'springer_oa', status: 'failed', reason: `Springer Nature Open Access API returned HTTP ${res.status}.` });
    } else {
      const bytes = await readCapped(res, 15_000_000);
      const text = new TextDecoder().decode(bytes);
      if (/<article[\s>]/.test(text)) {
        return [{ connector: 'springer_oa', status: 'full_text', reason: 'Open-access JATS XML from the Springer Nature Open Access API.', entitlement: 'open_access', file: { bytes, contentType: 'application/xml', format: 'jats', versionLabel: 'Springer Nature open-access JATS (version of record)' } }];
      }
      attempts.push({ connector: 'springer_oa', status: 'not_applicable', reason: 'Not available through the Springer Nature Open Access API (the article is not open access).' });
    }
  } catch (e) {
    attempts.push(fromUpstream('springer_oa', e));
  }

  if (!ctx.settings.springer?.fullTextAgreement) {
    attempts.push({
      connector: 'springer_fulltext',
      status: 'agreement_required',
      reason: 'Subscription Springer Nature articles need the Full Text API, which requires an approved text-and-data-mining agreement. It is not enabled for your connection.',
    });
    return attempts;
  }
  if (!jatsKey(ctx, '/xmldata/jats')) {
    attempts.push({ connector: 'springer_fulltext', status: 'credentials_missing', reason: 'Add your approved Full Text API credential as key/metric, copied from Springer Nature API Management.' });
    return attempts;
  }
  try {
    const res = await jats(ctx, '/xmldata/jats', paper.doi);
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      attempts.push({ connector: 'springer_fulltext', status: 'agreement_required', reason: 'Springer Nature refused Full Text API access. Check that the agreement is active and the Full Text API credential includes the API metric (key/metric).' });
    } else if (!res.ok) {
      await res.body?.cancel();
      attempts.push({ connector: 'springer_fulltext', status: 'failed', reason: `Springer Nature Full Text API returned HTTP ${res.status}.` });
    } else {
      const bytes = await readCapped(res, 15_000_000);
      if (/<article[\s>]/.test(new TextDecoder().decode(bytes))) {
        attempts.push({ connector: 'springer_fulltext', status: 'full_text', reason: 'Full text from the Springer Nature Full Text API under your agreement.', entitlement: 'entitled', file: { bytes, contentType: 'application/xml', format: 'jats', versionLabel: 'Springer Nature Full Text API JATS (version of record)' } });
      } else {
        attempts.push({ connector: 'springer_fulltext', status: 'not_entitled', reason: 'The Full Text API returned no article for this DOI under your agreement.', entitlement: 'not_entitled' });
      }
    }
  } catch (e) {
    attempts.push(fromUpstream('springer_fulltext', e));
  }
  return attempts;
}

const OA_TEST_DOI = '10.1038/s41598-020-70651-5'; // Scientific Reports, CC BY
const SUB_TEST_DOI = '10.1038/nchem.1368'; // Nature Chemistry, subscription

export async function testSpringer(ctx: ConnectorContext): Promise<TestCheck[]> {
  const checks: TestCheck[] = [];
  const sharedKeyRejections: TestCheck[] = [];
  const creds = ctx.creds.springer;
  if (!creds || !Object.values(creds).some(Boolean)) return [{ name: 'API key', status: 'fail', message: 'No API key saved.' }];
  const metaKey = creds.metaApiKey || creds.apiKey;
  if (!metaKey) checks.push({ name: 'Meta API (discovery)', status: 'skipped', message: 'No Meta API key saved. Add it to enable Springer discovery; other discovery sources still work.' });
  else try {
    const params = new URLSearchParams({ q: `doi:${OA_TEST_DOI}`, p: '1', api_key: metaKey });
    const res = await policyFetch(`${BASE}/meta/v2/json?${params}`, {}, POLICY, ctx.fetch);
    const check: TestCheck = res.ok ? { name: 'Meta API (discovery)', status: 'pass', message: 'Key accepted for metadata search.' } : { name: 'Meta API (discovery)', status: 'fail', message: `Springer Nature returned HTTP ${res.status}. Verify that the Meta API is active in API Management and use its credential in the Meta API key field. An Open Access credential may not enable metadata search.` };
    checks.push(check);
    if (!creds.metaApiKey && (res.status === 401 || res.status === 403)) sharedKeyRejections.push(check);
    await res.body?.cancel();
  } catch (e) {
    checks.push({ name: 'Meta API (discovery)', status: 'fail', message: (e as Error).message });
  }
  const probeJats = async (name: string, path: '/openaccess/jats' | '/xmldata/jats', doi: string) => {
    if (!jatsKey(ctx, path)) {
      checks.push({ name, status: 'skipped', message: path === '/openaccess/jats' ? 'No Open Access API key saved.' : 'No Full Text API credential saved. Copy key/metric from API Management.' });
      return;
    }
    try {
      const res = await jats(ctx, path, doi);
      if (!res.ok) {
        await res.body?.cancel();
        const check: TestCheck = { name, status: 'fail', message: `Springer Nature returned HTTP ${res.status}. Check that this API is active and its credential is correct.${path === '/xmldata/jats' ? ' Full Text API credentials must include the API metric (key/metric).' : ' Copy the Open Access API credential into its own field.'}` };
        checks.push(check);
        const explicitKey = path === '/openaccess/jats' ? creds.openAccessApiKey : creds.fullTextApiKey;
        if (!explicitKey && (res.status === 401 || res.status === 403)) sharedKeyRejections.push(check);
        return;
      }
      const xml = new TextDecoder().decode(await readCapped(res, 15_000_000));
      const ok = /<article[\s>]/.test(xml);
      checks.push({ name, status: ok ? 'pass' : 'warn', message: ok ? 'Retrieved the test article as JATS XML.' : 'The API responded, but did not return the test article. This can reflect coverage or agreement limits; it does not establish that the key is invalid.' });
    } catch (e) {
      checks.push({ name, status: 'fail', message: (e as Error).message });
    }
  };
  await probeJats('Open Access full text', '/openaccess/jats', OA_TEST_DOI);
  if (!ctx.settings.springer?.fullTextAgreement) {
    checks.push({ name: 'Subscription full text', status: 'skipped', message: 'Not enabled. Subscription articles require an approved Springer Nature full-text agreement; an open-access key does not grant them.' });
  } else {
    await probeJats('Subscription full text', '/xmldata/jats', SUB_TEST_DOI);
  }
  // Existing single-key connections may be enabled for only one API. Preserve that working
  // capability without labelling the whole connection invalid. Explicit API-key errors still fail.
  if (checks.some((c) => c.status === 'pass')) {
    for (const check of sharedKeyRejections) {
      check.status = 'warn';
      check.message += ' The shared key works for another API; that connection remains usable.';
    }
  }
  return checks;
}
