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
  const key = ctx.creds.springer?.apiKey;
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

async function jats(ctx: ConnectorContext, path: '/openaccess/jats' | '/xmldata/jats', doi: string) {
  const params = new URLSearchParams({ q: `doi:${doi}`, api_key: ctx.creds.springer!.apiKey });
  return policyFetch(`${BASE}${path}?${params}`, { headers: { accept: 'application/xml' } }, POLICY, ctx.fetch);
}

export async function springerRetrieve(ctx: ConnectorContext, paper: PaperRef): Promise<RetrievalAttempt[]> {
  if (!paper.doi) return [{ connector: 'springer_oa', status: 'not_applicable', reason: 'Springer Nature lookup needs a DOI.' }];
  if (!ctx.creds.springer?.apiKey) {
    return [{ connector: 'springer_oa', status: 'credentials_missing', reason: 'Add your Springer Nature API key under Publisher connections to retrieve open-access Springer Nature articles.' }];
  }
  const attempts: RetrievalAttempt[] = [];
  try {
    const res = await jats(ctx, '/openaccess/jats', paper.doi);
    if (res.status === 401 || res.status === 403) {
      return [{ connector: 'springer_oa', status: 'credentials_invalid', reason: 'Springer Nature rejected the API key (it may be invalid or lack Open Access API access).' }];
    }
    if (!res.ok) attempts.push({ connector: 'springer_oa', status: 'failed', reason: `Springer Nature Open Access API returned HTTP ${res.status}.` });
    else {
      const bytes = await readCapped(res, 15_000_000);
      const text = new TextDecoder().decode(bytes);
      if (/<article[\s>]/.test(text)) {
        return [{ connector: 'springer_oa', status: 'full_text', reason: 'Open-access JATS XML from the Springer Nature Open Access API.', entitlement: 'open_access', file: { bytes, contentType: 'application/xml', format: 'jats', versionLabel: 'Springer Nature open-access JATS (version of record)' } }];
      }
      attempts.push({ connector: 'springer_oa', status: 'not_applicable', reason: 'Not available through the Springer Nature Open Access API (the article is not open access).' });
    }
  } catch (e) {
    return [fromUpstream('springer_oa', e)];
  }

  if (!ctx.settings.springer?.fullTextAgreement) {
    attempts.push({
      connector: 'springer_fulltext',
      status: 'agreement_required',
      reason: 'Subscription Springer Nature articles need the Full Text API, which requires an approved text-and-data-mining agreement. It is not enabled for your connection.',
    });
    return attempts;
  }
  try {
    const res = await jats(ctx, '/xmldata/jats', paper.doi);
    if (res.status === 401 || res.status === 403) {
      attempts.push({ connector: 'springer_fulltext', status: 'agreement_required', reason: 'Springer Nature refused Full Text API access for this key; an approved agreement is required.' });
    } else if (!res.ok) {
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
  if (!ctx.creds.springer?.apiKey) return [{ name: 'API key', status: 'fail', message: 'No API key saved.' }];
  try {
    const params = new URLSearchParams({ q: `doi:${OA_TEST_DOI}`, api_key: ctx.creds.springer.apiKey });
    const res = await policyFetch(`${BASE}/meta/v2/json?${params}`, {}, POLICY, ctx.fetch);
    checks.push(res.ok ? { name: 'Meta API (discovery)', status: 'pass', message: 'Key accepted for metadata search.' } : { name: 'Meta API (discovery)', status: 'fail', message: `Springer Nature returned HTTP ${res.status}. The key may be invalid or not enabled for the Meta API.` });
    await res.body?.cancel();
  } catch (e) {
    checks.push({ name: 'Meta API (discovery)', status: 'fail', message: (e as Error).message });
  }
  try {
    const res = await jats(ctx, '/openaccess/jats', OA_TEST_DOI);
    const ok = res.ok && /<article[\s>]/.test(await res.text());
    checks.push(ok ? { name: 'Open Access full text', status: 'pass', message: 'Retrieved a known open-access article as JATS XML.' } : { name: 'Open Access full text', status: 'fail', message: `Could not retrieve a known open-access article (HTTP ${res.status}).` });
  } catch (e) {
    checks.push({ name: 'Open Access full text', status: 'fail', message: (e as Error).message });
  }
  if (!ctx.settings.springer?.fullTextAgreement) {
    checks.push({ name: 'Subscription full text', status: 'skipped', message: 'Not enabled. Subscription articles require an approved Springer Nature full-text agreement; an open-access key does not grant them.' });
  } else {
    try {
      const res = await jats(ctx, '/xmldata/jats', SUB_TEST_DOI);
      const ok = res.ok && /<article[\s>]/.test(await res.text());
      checks.push(ok ? { name: 'Subscription full text', status: 'pass', message: 'Full Text API returned a subscription article under your agreement.' } : { name: 'Subscription full text', status: 'fail', message: `Full Text API did not return the test article (HTTP ${res.status}). Your agreement may not cover it or may not be active for this key.` });
    } catch (e) {
      checks.push({ name: 'Subscription full text', status: 'fail', message: (e as Error).message });
    }
  }
  return checks;
}
