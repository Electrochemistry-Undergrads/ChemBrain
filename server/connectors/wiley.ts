import { policyFetch, readCapped } from '../http/fetcher';
import { sniffContent } from '../parsing/quality';
import { sleep } from '../util';
import { fromUpstream } from './europepmc';
import type { ConnectorContext, PaperRef, RetrievalAttempt, TestCheck } from './types';
import type { Env } from '../env';

/**
 * Wiley Text and Data Mining API
 * (https://onlinelibrary.wiley.com/library-info/resources/text-and-datamining):
 * GET https://api.wiley.com/onlinelibrary/tdm/v1/articles/{DOI} with header Wiley-TDM-Client-Token.
 * Delivers full-text PDF only, after a redirect to a file server. Limits: 3 articles/s and 60
 * requests per 10 minutes, i.e. one request every 10 s. Subscription content is served only to
 * requests from the subscribing institution's network; open-access content works anywhere.
 * Supporting information is not delivered by this API.
 */
const API = 'https://api.wiley.com/onlinelibrary/tdm/v1/articles/';
const POLICY = {
  service: 'Wiley',
  timeoutMs: 45_000,
  retries: 1,
  redirectHosts: ['wiley.com'],
  foreignRedirectStripHeaders: ['Wiley-TDM-Client-Token'],
  maxRedirects: 4,
  maxRetryAfterMs: 12_000,
};
export const WILEY_INTERVAL_MS = 10_000;

/** Per-user pacing stored in D1 so it holds across requests. Returns ms to wait (0 = go now). */
export async function wileyReserve(env: Env, userId: string): Promise<number> {
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, window_start) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start + ?3 <= ?2 THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start + ?3 <= ?2 THEN ?2 ELSE rate_limits.window_start END
     RETURNING window_start, count`,
  )
    .bind(`wiley:${userId}`, now, WILEY_INTERVAL_MS)
    .first<{ window_start: number; count: number }>();
  // count 1 means this call opened a new interval and may proceed.
  return row && row.count > 1 ? Math.max(1, row.window_start + WILEY_INTERVAL_MS - now) : 0;
}

export async function wileyRetrieve(ctx: ConnectorContext, paper: PaperRef): Promise<RetrievalAttempt> {
  const connector = 'wiley';
  if (!paper.doi) return { connector, status: 'not_applicable', reason: 'Wiley TDM retrieval needs a DOI.' };
  const token = ctx.creds.wiley?.tdmToken;
  if (!token) return { connector, status: 'credentials_missing', reason: 'Add your Wiley TDM token under Publisher connections.' };
  const wait = await wileyReserve(ctx.env, ctx.userId);
  if (wait > 0) return { connector, status: 'rate_limited', reason: 'Waiting for Wiley’s 10-second request interval.', retryAfterMs: wait };
  try {
    const res = await policyFetch(API + encodeURIComponent(paper.doi), { headers: { 'Wiley-TDM-Client-Token': token, accept: 'application/pdf' } }, POLICY, ctx.fetch);
    return await classify(connector, res);
  } catch (e) {
    return fromUpstream(connector, e);
  }
}

async function classify(connector: string, res: Response): Promise<RetrievalAttempt> {
  switch (res.status) {
    case 400:
      await res.body?.cancel();
      return { connector, status: 'credentials_missing', reason: 'Wiley did not receive a TDM token.' };
    case 403:
      await res.body?.cancel();
      return { connector, status: 'credentials_invalid', reason: 'Wiley says the TDM token is invalid or not registered.' };
    case 404:
      await res.body?.cancel();
      return {
        connector,
        status: 'institutional_connection_required',
        entitlement: 'unknown',
        reason: 'Wiley returned “no access”. For subscription articles Wiley only serves requests from your institution’s network, and ChemBrain’s servers are not on it. Open-access Wiley articles work from anywhere; for this one, upload the PDF you can open.',
      };
    case 429:
      await res.body?.cancel();
      return { connector, status: 'rate_limited', reason: 'Wiley rate limit reached.', retryAfterMs: 60_000 };
  }
  if (!res.ok) {
    await res.body?.cancel();
    return { connector, status: 'failed', reason: `Wiley returned HTTP ${res.status}.` };
  }
  const bytes = await readCapped(res, 40_000_000);
  if (sniffContent(bytes, res.headers.get('content-type')).kind !== 'pdf') {
    return { connector, status: 'failed', reason: 'Wiley responded, but the file was not a PDF (possibly a login or error page). It was discarded.' };
  }
  return { connector, status: 'full_text', reason: 'Full-text PDF from the Wiley TDM API.', entitlement: 'entitled', file: { bytes, contentType: 'application/pdf', format: 'pdf', versionLabel: 'Wiley TDM API PDF (version of record)' } };
}

const OA_TEST_DOI = '10.1002/fsn3.4482'; // Food Science & Nutrition, CC BY
const SUB_TEST_DOI = '10.1002/anie.201609489'; // Angewandte Chemie, subscription

/** Checks token validity without downloading the files: a redirect from the API means access. */
export async function testWiley(ctx: ConnectorContext): Promise<TestCheck[]> {
  const token = ctx.creds.wiley?.tdmToken;
  if (!token) return [{ name: 'TDM token', status: 'fail', message: 'No token saved.' }];
  const probe = async (doi: string) => {
    const wait = await wileyReserve(ctx.env, ctx.userId);
    if (wait > 0) await sleep(wait);
    const res = await policyFetch(API + encodeURIComponent(doi), { headers: { 'Wiley-TDM-Client-Token': token } }, { ...POLICY, maxRedirects: 0, redirectHosts: [] }, ctx.fetch).catch((e) => e as Error);
    if (res instanceof Error) return /redirect/.test(res.message) ? 302 : -1;
    await res.body?.cancel();
    return res.status;
  };
  const checks: TestCheck[] = [];
  const oa = await probe(OA_TEST_DOI);
  if (oa === 403) return [{ name: 'TDM token', status: 'fail', message: 'Wiley says the token is invalid or not registered. Re-copy it from your Wiley Online Library account (Text and Data Mining).' }];
  if (oa === 302 || oa === 200) checks.push({ name: 'TDM token', status: 'pass', message: 'Wiley accepted the token and offered an open-access test article.' });
  else checks.push({ name: 'TDM token', status: 'fail', message: oa === -1 ? 'Could not reach Wiley.' : `Unexpected response from Wiley (HTTP ${oa}).` });
  const sub = await probe(SUB_TEST_DOI);
  if (sub === 302 || sub === 200) checks.push({ name: 'Subscription access', status: 'pass', message: 'Wiley offered a subscription test article to ChemBrain’s server.' });
  else if (sub === 404) checks.push({ name: 'Subscription access', status: 'warn', message: 'No subscription access from ChemBrain’s servers. Wiley serves subscription articles only to your institution’s network; open-access articles still work, and you can upload PDFs you can open.' });
  else checks.push({ name: 'Subscription access', status: 'warn', message: `Could not confirm subscription access (HTTP ${sub}).` });
  return checks;
}
