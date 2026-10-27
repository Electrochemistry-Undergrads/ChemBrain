import { policyFetch, readCapped, UpstreamError } from '../http/fetcher';
import { normalizeDoi } from '../util';
import type { Candidate, PaperRef, RetrievalAttempt } from './types';

/**
 * Europe PMC REST API. Full text is available only for its open-access subset, as JATS XML
 * (https://www.ebi.ac.uk/europepmc/webservices/rest/{PMCID}/fullTextXML).
 */
const BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest';
const POLICY = { service: 'Europe PMC', timeoutMs: 20_000, retries: 2, minIntervalMs: 100, redirectHosts: ['www.ebi.ac.uk', 'ebi.ac.uk'] };

interface EpmcResult {
  pmcid?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  pubYear?: string;
  journalInfo?: { journal?: { title?: string } };
  abstractText?: string;
  isOpenAccess?: 'Y' | 'N';
  inEPMC?: 'Y' | 'N';
  license?: string;
}

const clean = (s?: string) => (s ? s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null);

export async function europePmcSearch(query: string, pageSize = 15, fetchImpl: typeof fetch = fetch): Promise<Candidate[]> {
  const params = new URLSearchParams({ query, format: 'json', resultType: 'core', pageSize: String(pageSize) });
  const res = await policyFetch(`${BASE}/search?${params}`, {}, POLICY, fetchImpl);
  if (!res.ok) throw new Error(`Europe PMC search failed (HTTP ${res.status}).`);
  const j = (await res.json()) as { resultList?: { result?: EpmcResult[] } };
  return (j.resultList?.result ?? [])
    .filter((r) => r.title)
    .map((r) => ({
      doi: normalizeDoi(r.doi),
      title: clean(r.title)!.replace(/\.$/, ''),
      authors: r.authorString ?? null,
      year: r.pubYear ? Number(r.pubYear) : null,
      venue: r.journalInfo?.journal?.title ?? null,
      publisher: null,
      abstract: clean(r.abstractText),
      landingUrl: r.doi ? `https://doi.org/${r.doi}` : r.pmcid ? `https://europepmc.org/article/PMC/${r.pmcid}` : null,
      license: r.isOpenAccess === 'Y' && r.license ? r.license : null,
      source: 'europepmc',
    }));
}

/** Finds the open-access PMC record for a DOI and retrieves its JATS full text. */
export async function europePmcRetrieve(paper: PaperRef, fetchImpl: typeof fetch = fetch): Promise<RetrievalAttempt> {
  const connector = 'europepmc';
  if (!paper.doi) return { connector, status: 'not_applicable', reason: 'Europe PMC lookup needs a DOI.' };
  try {
    const params = new URLSearchParams({ query: `DOI:"${paper.doi}"`, format: 'json', resultType: 'core', pageSize: '1' });
    const s = await policyFetch(`${BASE}/search?${params}`, {}, POLICY, fetchImpl);
    if (!s.ok) return { connector, status: 'failed', reason: `Europe PMC search returned HTTP ${s.status}.` };
    const r = ((await s.json()) as { resultList?: { result?: EpmcResult[] } }).resultList?.result?.[0];
    if (!r || normalizeDoi(r.doi) !== paper.doi) return { connector, status: 'not_found', reason: 'Not indexed in Europe PMC.' };
    if (r.isOpenAccess !== 'Y' || !r.pmcid) {
      return { connector, status: 'not_applicable', reason: 'Europe PMC has no open-access full text for this paper.' };
    }
    const res = await policyFetch(`${BASE}/${r.pmcid}/fullTextXML`, { headers: { accept: 'application/xml' } }, POLICY, fetchImpl);
    if (res.status === 404) return { connector, status: 'not_found', reason: 'Europe PMC lists the paper as open access but has no full-text XML.' };
    if (!res.ok) return { connector, status: 'failed', reason: `Europe PMC full text returned HTTP ${res.status}.` };
    const bytes = await readCapped(res, 15_000_000);
    return {
      connector,
      status: 'full_text',
      reason: `Open-access JATS XML from Europe PMC (${r.pmcid}).`,
      entitlement: 'open_access',
      file: { bytes, contentType: 'application/xml', format: 'jats', versionLabel: `Europe PMC open-access XML (${r.pmcid}); may be the accepted manuscript or the published version`, license: r.license },
    };
  } catch (e) {
    return fromUpstream(connector, e);
  }
}

export function fromUpstream(connector: string, e: unknown): RetrievalAttempt {
  if (e instanceof UpstreamError) {
    return { connector, status: e.kind === 'rate_limited' ? 'rate_limited' : 'failed', reason: e.message, retryAfterMs: e.retryAfterMs };
  }
  return { connector, status: 'failed', reason: 'Unexpected error while contacting the service.' };
}
