import { parseRetryAfter, policyFetch, readCapped, UpstreamError } from '../http/fetcher';
import { findFirst, parseXml, textOf } from '../parsing/xml';
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
  // Query-string DOI avoids path routing/escaping problems. Use the API's default XML format
  // rather than making full-text retrieval depend on the entitlement JSON representation.
  const params = new URLSearchParams({ doi });
  const res = await policyFetch(`${BASE}/entitlement/?${params}`, { headers: headers(ctx, 'text/xml') }, POLICY, ctx.fetch);
  if (!res.ok) {
    await res.body?.cancel();
    return { status: res.status, entitled: null };
  }
  const body = new TextDecoder().decode(await readCapped(res, 1_000_000));
  let ent: unknown;
  let status: string | undefined;
  if (body.trimStart().startsWith('{')) {
    const j = JSON.parse(body);
    const docs = j['entitlement-response']?.['document-entitlement'];
    const d = Array.isArray(docs) ? docs[0] : docs;
    ent = d?.entitled;
    status = d?.['@status'];
  } else {
    const doc = findFirst(parseXml(body), 'document-entitlement');
    ent = textOf(findFirst(doc, 'entitled'));
    status = doc?.attrs.status;
  }
  return { status: status === 'not_found' ? 404 : res.status, entitled: ent === true || ent === 'true' || ent === 'open_access' ? true : ent === false || ent === 'false' ? false : null };
}

const temporaryError = (e: unknown) => e instanceof UpstreamError && e.kind === 'http' && e.status !== null && e.status >= 500;

export async function elsevierRetrieve(ctx: ConnectorContext, paper: PaperRef): Promise<RetrievalAttempt> {
  const connector = 'elsevier';
  if (!paper.doi) return { connector, status: 'not_applicable', reason: 'Elsevier retrieval needs a DOI.' };
  if (!ctx.creds.elsevier?.apiKey) {
    return { connector, status: 'credentials_missing', reason: 'Add your Elsevier API key (and your library’s institutional token, if you have one) under Publisher connections.' };
  }
  try {
    let ent: Awaited<ReturnType<typeof elsevierEntitlement>>;
    try {
      ent = await elsevierEntitlement(ctx, paper.doi);
    } catch (e) {
      if (!temporaryError(e)) throw e;
      // Article Retrieval enforces entitlement itself. A broken preflight must not block it.
      ent = { status: (e as UpstreamError).status!, entitled: null };
    }
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
    let oa: Awaited<ReturnType<typeof elsevierEntitlement>>;
    try {
      oa = await elsevierEntitlement(ctx, OA_TEST_DOI);
    } catch (e) {
      if (!temporaryError(e)) throw e;
      oa = { status: (e as UpstreamError).status!, entitled: null };
    }
    if (oa.status === 401) return [{ name: 'API key', status: 'fail', message: 'Elsevier rejected the API key or institutional token (HTTP 401).' }];
    if (oa.status === 200 && oa.entitled !== null) {
      checks.push({ name: 'API key', status: 'pass', message: 'Elsevier accepted the API key.' });
    } else {
      checks.push({ name: 'Entitlement service', status: 'warn', message: `The entitlement preflight could not confirm access (HTTP ${oa.status}). Checking the Article Retrieval API separately; this does not establish that your key is invalid.` });
      const res = await policyFetch(`${BASE}/doi/${encDoi(OA_TEST_DOI)}?view=META`, { headers: headers(ctx, 'text/xml') }, POLICY, ctx.fetch);
      const valid = res.ok && /<full-text-retrieval-response[\s>]/.test(new TextDecoder().decode(await readCapped(res, 1_000_000)));
      if (!res.ok) await res.body?.cancel();
      checks.push({ name: 'API key', status: valid ? 'pass' : 'fail', message: valid ? 'Elsevier accepted the key for Article Retrieval. Full-text access is checked separately for each paper.' : `Article Retrieval could not validate this connection (HTTP ${res.status}). Check the key, its ScienceDirect API permissions, and any institutional token.` });
    }
  } catch (e) {
    checks.push({ name: 'Elsevier API', status: temporaryError(e) ? 'warn' : 'fail', message: `${(e as Error).message}${temporaryError(e) ? ' This is an upstream service error, not evidence of an invalid key.' : ''}` });
  }
  try {
    const sub = await elsevierEntitlement(ctx, SUB_TEST_DOI);
    if (sub.entitled) {
      checks.push({ name: 'Subscription entitlement', status: 'pass', message: ctx.creds.elsevier.instToken ? 'Your institutional token is entitled to a subscription test article.' : 'Entitled to a subscription test article.' });
    } else {
      checks.push({
        name: 'Subscription entitlement',
        status: 'warn',
        message: sub.entitled === null
          ? `Could not confirm subscription entitlement (HTTP ${sub.status}).${sub.status === 403 ? ' This key may not have Entitlement API permission; Article Retrieval checks access separately for each paper.' : ' Retry the test later.'}`
          : ctx.creds.elsevier.instToken
          ? 'Not entitled to the subscription test article with your institutional token. Your institution may not subscribe to that journal, or the token may not be linked to this API key.'
          : 'Not entitled from ChemBrain’s servers. Campus IP access does not carry over to the cloud; ask your library for an institutional token, or upload PDFs you can open.',
      });
    }
  } catch (e) {
    checks.push({ name: 'Subscription entitlement', status: 'warn', message: `${(e as Error).message} Subscription access could not be confirmed.` });
  }
  return checks;
}
