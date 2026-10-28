import type { Env } from '../env';
import { policyFetch, readCapped } from '../http/fetcher';
import { normalizeDoi, nowIso } from '../util';
import type { PublicationCheck, PublicationNotice } from '../../shared/publications';

type Paper = { id: string; title: string; doi: string | null };
type MetadataCheck = Pick<PublicationCheck, 'status' | 'checkedAt' | 'notices' | 'exclusion'>;
const TTL = 60 * 60 * 1000;
const MAX_SOURCES = 24;

function noticeKind(value: unknown): PublicationNotice['kind'] | null {
  if (typeof value !== 'string') return null;
  const type = value.toLowerCase().replace(/[ _]/g, '-');
  if (type === 'retraction' || type === 'partial-retraction') return 'retraction';
  if (type === 'withdrawal' || type === 'withdrawn' || type === 'removal') return 'withdrawal';
  if (type === 'expression-of-concern' || type === 'concern') return 'concern';
  if (['correction', 'erratum', 'corrigendum', 'addendum', 'clarification'].includes(type)) return 'correction';
  if (type === 'reinstatement') return 'reinstatement';
  return type ? 'update' : null;
}

function notices(value: unknown): PublicationNotice[] {
  if (!Array.isArray(value)) return [];
  const out = new Map<string, PublicationNotice>();
  for (const row of value.slice(0, 100)) {
    if (!row || typeof row !== 'object') continue;
    const kind = noticeKind(row.type);
    if (!kind) continue;
    const doi = typeof row.DOI === 'string' ? normalizeDoi(row.DOI) : null;
    const dateTime = row.updated?.['date-time'];
    const date = typeof dateTime === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(dateTime) ? dateTime.slice(0, 10) : null;
    // Crossref can supply the same notice from both the publisher and Retraction Watch.
    out.set(`${kind}:${doi ?? ''}:${date ?? ''}`, { kind, doi, date });
  }
  return [...out.values()].slice(0, 20);
}

/** Injectable cache so tests never share mocked metadata with other checks. No credentials used. */
export function createPublicationChecker() {
  const cache = new Map<string, { expires: number; value: MetadataCheck }>();
  const pending = new Map<string, Promise<MetadataCheck>>();
  return async function check(env: Env, papers: Paper[], fetchImpl: typeof fetch = fetch): Promise<PublicationCheck[]> {
    let requested = 0;
    const results: PublicationCheck[] = [];
    const lookup = async (paper: Paper): Promise<PublicationCheck> => {
      const doi = normalizeDoi(paper.doi);
      const base = { paperId: paper.id, title: paper.title, doi, checkedAt: null, notices: [], exclusion: null } satisfies Omit<PublicationCheck, 'status'>;
      if (!doi) return { ...base, status: 'no_doi' };
      const saved = cache.get(doi);
      if (saved && saved.expires > Date.now()) return { ...base, ...saved.value };
      if (!pending.has(doi)) {
        if (requested++ >= MAX_SOURCES) return { ...base, status: 'not_checked' };
        pending.set(doi, (async (): Promise<MetadataCheck> => {
          try {
            const query = env.CONTACT_EMAIL ? `?${new URLSearchParams({ mailto: env.CONTACT_EMAIL })}` : '';
            const res = await policyFetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}${query}`, {
              headers: { accept: 'application/json', 'user-agent': 'ChemBrain/0.1 (https://chembrain.pages.dev)' },
            }, { service: 'Crossref updates', timeoutMs: 5000, retries: 0, minIntervalMs: 150, redirectHosts: ['api.crossref.org'], maxRedirects: 1 }, fetchImpl);
            if (!res.ok) throw new Error('Metadata unavailable');
            const data = JSON.parse(new TextDecoder().decode(await readCapped(res, 1_000_000)));
            const work = data?.message;
            if (!work || typeof work.DOI !== 'string' || normalizeDoi(work.DOI) !== doi) throw new Error('Wrong metadata record');
            if (['updated-by', 'update-to'].some((key) => work[key] !== undefined && !Array.isArray(work[key]))) throw new Error('Malformed update metadata');
            // The original paper has `updated-by`; `update-to` belongs to the notice itself.
            const updates = notices(work['updated-by']);
            const isNotice = notices(work['update-to']).length > 0;
            const title = Array.isArray(work.title) && typeof work.title[0] === 'string' ? work.title[0] : '';
            const retracted = updates.some((n) => n.kind === 'retraction') || /^\s*retracted\s*[:\[]/i.test(title);
            const withdrawn = updates.some((n) => n.kind === 'withdrawal') || /^\s*withdrawn\s*[:\[]/i.test(title);
            const reinstated = updates.some((n) => n.kind === 'reinstatement');
            const value: MetadataCheck = { status: 'checked', checkedAt: nowIso(), notices: updates,
              exclusion: (retracted || withdrawn) && reinstated ? 'review_required' : retracted ? 'retracted' : withdrawn ? 'withdrawn' : isNotice ? 'notice' : null };
            if (cache.size >= 256) cache.delete(cache.keys().next().value!);
            cache.set(doi, { expires: Date.now() + TTL, value });
            return value;
          } catch {
            // A service outage must never turn into an assertion that a source has no updates.
            return { status: 'unavailable', checkedAt: nowIso(), notices: [], exclusion: null };
          }
        })());
      }
      try { return { ...base, ...await pending.get(doi)! }; }
      finally { pending.delete(doi); }
    };
    // Bounded to three requests at a time and 24 uncached DOIs per analysis step.
    for (let i = 0; i < papers.length; i += 3) results.push(...await Promise.all(papers.slice(i, i + 3).map(lookup)));
    return results;
  };
}

export const checkPublications = createPublicationChecker();
