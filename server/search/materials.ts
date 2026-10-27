import { policyFetch, readCapped } from '../http/fetcher';

export interface MaterialSuggestions {
  suggestions: string[];
  available: boolean;
  source: 'PubChem';
}
const unavailable = (): MaterialSuggestions => ({ suggestions: [], available: false, source: 'PubChem' });

/** Bounded per-worker cache for public compound names; nothing is written to project data. */
export function createMaterialSuggester() {
  const cache = new Map<string, { expires: number; data: MaterialSuggestions }>();
  const pending = new Map<string, Promise<MaterialSuggestions>>();
  return async (query: string, fetchImpl: typeof fetch = fetch): Promise<MaterialSuggestions> => {
    const key = query.toLowerCase();
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.data;
    if (pending.has(key)) return pending.get(key)!;
    const request = (async () => {
      try {
        const url = `https://pubchem.ncbi.nlm.nih.gov/rest/autocomplete/compound/${encodeURIComponent(query)}/json?limit=6`;
        const response = await policyFetch(url, { headers: { accept: 'application/json' } }, {
          service: 'PubChem autocomplete', timeoutMs: 3000, retries: 0, minIntervalMs: 250,
          redirectHosts: ['pubchem.ncbi.nlm.nih.gov'], maxRedirects: 1,
        }, fetchImpl);
        if (!response.ok) { await response.body?.cancel(); return unavailable(); }
        const data = JSON.parse(new TextDecoder().decode(await readCapped(response, 32_000)));
        const terms: unknown = data.dictionary_terms?.compound;
        if (data.status?.code !== 0 || !Array.isArray(terms)) return unavailable();
        const seen = new Set<string>();
        const suggestions = terms.filter((term): term is string => {
          if (typeof term !== 'string' || !term.trim() || term.length > 200 || /[<>\u0000-\u001f]/.test(term)) return false;
          const normalized = term.trim().toLowerCase();
          if (seen.has(normalized)) return false;
          seen.add(normalized);
          return true;
        }).map((s) => s.trim()).slice(0, 6);
        const result: MaterialSuggestions = { suggestions, available: true, source: 'PubChem' };
        if (cache.size >= 128) cache.delete(cache.keys().next().value!);
        cache.set(key, { expires: Date.now() + 15 * 60_000, data: result });
        return result;
      } catch {
        // Suggestions are optional: an upstream outage must never prevent a normal search.
        return unavailable();
      }
    })();
    pending.set(key, request);
    try { return await request; } finally { pending.delete(key); }
  };
}

export const suggestMaterials = createMaterialSuggester();
