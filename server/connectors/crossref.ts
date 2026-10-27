import { policyFetch } from '../http/fetcher';
import { normalizeDoi } from '../util';
import type { Candidate } from './types';
import type { Env } from '../env';

/**
 * Crossref REST API (https://api.crossref.org). Discovery and metadata only: a Crossref record or
 * its "link" URLs are never treated as a retrieved paper.
 * Polite pool (mailto): 10 requests per interval, concurrency 3; we stay sequential and paced.
 */
const POLICY = { service: 'Crossref', timeoutMs: 15_000, retries: 2, minIntervalMs: 120, redirectHosts: ['api.crossref.org'] };

function ua(env: Env) {
  return `ChemBrain/0.1 (https://chembrain.pages.dev${env.CONTACT_EMAIL ? `; mailto:${env.CONTACT_EMAIL}` : ''})`;
}

interface CrossrefWork {
  DOI?: string;
  title?: string[];
  author?: { given?: string; family?: string; name?: string }[];
  issued?: { 'date-parts'?: number[][] };
  'container-title'?: string[];
  publisher?: string;
  abstract?: string;
  URL?: string;
  license?: { URL?: string; 'content-version'?: string }[];
  type?: string;
}

export function stripJatsTags(s: string | undefined | null) {
  if (!s) return null;
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/^\s*Abstract\s*/i, '').trim() || null;
}

export function workToCandidate(w: CrossrefWork, source = 'crossref'): Candidate | null {
  const title = w.title?.[0]?.replace(/<[^>]+>/g, '').trim();
  if (!title) return null;
  const authors = (w.author || []).slice(0, 6).map((a) => a.name || [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean);
  const vor = (w.license || []).find((l) => l['content-version'] === 'vor') ?? w.license?.[0];
  return {
    doi: normalizeDoi(w.DOI),
    title,
    authors: authors.length ? authors.join(', ') + ((w.author?.length ?? 0) > 6 ? ', et al.' : '') : null,
    year: w.issued?.['date-parts']?.[0]?.[0] ?? null,
    venue: w['container-title']?.[0] ?? null,
    publisher: w.publisher ?? null,
    abstract: stripJatsTags(w.abstract),
    landingUrl: w.DOI ? `https://doi.org/${w.DOI}` : null,
    license: vor?.URL ?? null,
    source,
  };
}

export async function crossrefSearch(env: Env, query: string, rows = 15, fetchImpl: typeof fetch = fetch): Promise<Candidate[]> {
  const params = new URLSearchParams({
    'query.bibliographic': query,
    rows: String(rows),
    filter: 'type:journal-article',
    select: 'DOI,title,author,issued,container-title,publisher,abstract,URL,license,type',
  });
  if (env.CONTACT_EMAIL) params.set('mailto', env.CONTACT_EMAIL);
  const res = await policyFetch(`https://api.crossref.org/works?${params}`, { headers: { 'user-agent': ua(env) } }, POLICY, fetchImpl);
  if (!res.ok) throw new Error(`Crossref search failed (HTTP ${res.status}).`);
  const j = (await res.json()) as { message?: { items?: CrossrefWork[] } };
  return (j.message?.items ?? []).map((w) => workToCandidate(w)).filter((c): c is Candidate => c !== null);
}

export async function crossrefLookup(env: Env, doi: string, fetchImpl: typeof fetch = fetch): Promise<Candidate | null> {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}${env.CONTACT_EMAIL ? `?mailto=${encodeURIComponent(env.CONTACT_EMAIL)}` : ''}`;
  const res = await policyFetch(url, { headers: { 'user-agent': ua(env) } }, POLICY, fetchImpl);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Crossref lookup failed (HTTP ${res.status}).`);
  const j = (await res.json()) as { message?: CrossrefWork };
  return j.message ? workToCandidate(j.message) : null;
}
