import { parseRetryAfter, policyFetch, readCapped } from '../http/fetcher';
import { fromUpstream } from './europepmc';
import type { ConnectorContext, PaperRef, RetrievalAttempt, TestCheck } from './types';

/**
 * Elsevier ScienceDirect APIs (https://dev.elsevier.com):
 * - Article Entitlement API: /content/article/entitlement/doi/{doi} (6 requests/s)
 * - Article Retrieval API: /content/article/doi/{doi}?view=FULL, Accept text/xml (10 requests/s)
 * The API key identifies the application only. Subscription entitlement comes from the caller's
 * institutional IP or an institutional token (X-ELS-Insttoken). ChemBrain's servers are not on a
 * campus network, so without an institutional token only open-access articles are entitled.
 */
const BASE = 'https://api.elsevier.com/content/article';
const POLICY = { service: 'Elsevier', timeoutMs: 30_000, retries: 2, minIntervalMs: 170, redirectHosts: ['api.elsevier.com'] };

function headers(ctx: ConnectorContext, accept: string): Record<string, string> {
  const h: Record<string, string> = { 'X-ELS-APIKey': ctx.creds.elsevier!.apiKey, accept };
  if (ctx.creds.elsevier?.instToken) h['X-ELS-Insttoken'] = ctx.creds.elsevier.instToken;
  return h;
}

const encDoi = (doi: string) => doi.split('/').map(encodeURIComponent).join('/');

export async function elsevierEntitlement(ctx: ConnectorContext, doi: string): Promise<{ status: number; entitled: boolean | null; message?: string }> {
  const res = await policyFetch(`${BASE}/entitlement/doi/${encDoi(doi)}`, { headers: headers(ctx, 'application/json') }, POLICY, ctx.fetch);
  if (!res.ok) {
    await res.body?.cancel();
    return { status: res.status, entitled: null };
  }
  const j = (await res.json()) as { 'entitlement-response'?: { 'document-entitlement'?: { entitled?: boolean | string; message?: string } } };
  const d = j['entitlement-response']?.['document-entitlement'];
  const ent = d?.entitled;
  return { status: res.status, entitled: ent === true || ent === 'true' ? true : ent === false || ent === 'false' ? false : null, message: d?.message };
}

export async function elsevierRetrieve(ctx: ConnectorContext, paper: PaperRef): Promise<RetrievalAttempt> {
  const connector = 'elsevier';
  if (!paper.doi) return { connector, status: 'not_applicable', reason: 'Elsevier retrieval needs a DOI.' };
  if (!ctx.creds.elsevier?.apiKey) {
    return { connector, status: 'credentials_missing', reason: 'Add your Elsevier API key (and your library’s institutional token, if you have one) under Publisher connections.' };
  }
  try {
    const ent = await elsevierEntitlement(ctx, paper.doi);
    if (ent.status === 401) return { connector, status: 'credentials_invalid', reason: 'Elsevier rejected the API key or institutional token.' };
    if (ent.status === 404) return { connector, status: 'not_found', reason: 'Elsevier does not recognise this DOI.' };
    if (ent.entitled === false) {
      return ctx.creds.elsevier.instToken
        ? { connector, status: 'not_entitled', entitlement: 'not_entitled', reason: 'Elsevier reports that your institutional token is not entitled to this article.' }
        : {
            connector,
            status: 'institutional_connection_required',
            entitlement: 'unknown',
            reason: 'Elsevier grants subscription access by campus IP address or an institutional token. ChemBrain runs in the cloud, not on your campus network, so add an institutional token from your library or upload the PDF you can open yourself.',
          };
    }
    const res = await policyFetch(`${BASE}/doi/${encDoi(paper.doi)}?view=FULL`, { headers: headers(ctx, 'text/xml') }, POLICY, ctx.fetch);
    if (res.status === 401) return { connector, status: 'credentials_invalid', reason: 'Elsevier rejected the API key or institutional token.' };
    if (res.status === 403) return { connector, status: ctx.creds.elsevier.instToken ? 'not_entitled' : 'institutional_connection_required', reason: 'Elsevier could not validate entitlement for the full text.' };
    if (res.status === 404) return { connector, status: 'not_found', reason: 'Elsevier has no full-text record for this DOI.' };
    if (res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      return { connector, status: 'rate_limited', reason: res.headers.get('x-els-status')?.includes('QUOTA') ? 'Your Elsevier weekly API quota is used up.' : 'Elsevier rate limit reached.', retryAfterMs: Number.isFinite(reset) && reset > 0 ? reset * 1000 - Date.now() : parseRetryAfter(res.headers.get('retry-after')) };
    }
    if (!res.ok) return { connector, status: 'failed', reason: `Elsevier returned HTTP ${res.status}.` };
    const bytes = await readCapped(res, 20_000_000);
    return {
      connector,
      status: 'full_text', // provisional: the parser downgrades to abstract-only if originalText is missing
      reason: 'Full-text XML from the Elsevier Article Retrieval API.',
      entitlement: ent.entitled ? 'entitled' : 'unknown',
      file: { bytes, contentType: 'text/xml', format: 'elsevier_xml', versionLabel: 'Elsevier Article Retrieval API XML (view=FULL)' },
    };
  } catch (e) {
    return fromUpstream(connector, e);
  }
}

const OA_TEST_DOI = '10.1016/j.heliyon.2024.e36608'; // Heliyon, open access
const SUB_TEST_DOI = '10.1016/j.electacta.2012.12.090'; // Electrochimica Acta, subscription

export async function testElsevier(ctx: ConnectorContext): Promise<TestCheck[]> {
  if (!ctx.creds.elsevier?.apiKey) return [{ name: 'API key', status: 'fail', message: 'No API key saved.' }];
  const checks: TestCheck[] = [];
  try {
    const oa = await elsevierEntitlement(ctx, OA_TEST_DOI);
    if (oa.status === 401) return [{ name: 'API key', status: 'fail', message: 'Elsevier rejected the API key or institutional token (HTTP 401).' }];
    checks.push(oa.status === 200 ? { name: 'API key', status: 'pass', message: 'Elsevier accepted the API key.' } : { name: 'API key', status: 'fail', message: `Elsevier returned HTTP ${oa.status} for the entitlement check.` });
    const sub = await elsevierEntitlement(ctx, SUB_TEST_DOI);
    if (sub.entitled) {
      checks.push({ name: 'Subscription entitlement', status: 'pass', message: ctx.creds.elsevier.instToken ? 'Your institutional token is entitled to a subscription test article.' : 'Entitled to a subscription test article.' });
    } else {
      checks.push({
        name: 'Subscription entitlement',
        status: 'warn',
        message: ctx.creds.elsevier.instToken
          ? 'Not entitled to the subscription test article with your institutional token. Your institution may not subscribe to that journal, or the token may not be linked to this API key.'
          : 'Not entitled from ChemBrain’s servers. Campus IP access does not carry over to the cloud; ask your library for an institutional token, or upload PDFs you can open.',
      });
    }
  } catch (e) {
    checks.push({ name: 'Elsevier API', status: 'fail', message: (e as Error).message });
  }
  return checks;
}
