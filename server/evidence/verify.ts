/**
 * Deterministic evidence checks. A model-proposed quote is accepted only if it occurs in the cited
 * chunk of the retrieved document, and a numeric value is accepted only if it appears in that quote.
 */

export type QuoteMatch = 'exact' | 'normalized' | 'not_found';

export function normalizeForMatch(s: string) {
  return s
    .normalize('NFKC')
    .replace(/­/g, '') // soft hyphen
    .replace(/[‐-―−﹣－]/g, '-')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/µ/g, 'μ')
    .replace(/(\w)-\s+(\w)/g, '$1$2') // line-break hyphenation
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const alnum = (s: string) => normalizeForMatch(s).replace(/[^\p{L}\p{N}]+/gu, '');

export function matchQuote(quote: string, source: string): QuoteMatch {
  if (!quote || quote.trim().length < 8) return 'not_found';
  if (source.includes(quote)) return 'exact';
  const nq = normalizeForMatch(quote);
  if (normalizeForMatch(source).includes(nq)) return 'normalized';
  const aq = alnum(quote);
  if (aq.length >= 12 && alnum(source).includes(aq)) return 'normalized';
  return 'not_found';
}

/** True when the number (in any common formatting) appears in the quote. */
export function valueInQuote(value: number, quote: string) {
  const q = normalizeForMatch(quote).replace(/(\d),(\d{3})\b/g, '$1$2').replace(/(\d)\s+(\d{3})\b/g, '$1$2');
  const nums = [...q.matchAll(/-?\d+(?:[.,]\d+)?(?:\s*[×x]\s*10\s*\^?\s*[-−]?\d+|e[-+]?\d+)?/gi)].map((m) => parseLooseNumber(m[0]));
  return nums.some((n) => n !== null && (n === value || Math.abs(n - value) <= Math.abs(value) * 1e-9 || Math.abs(n) === Math.abs(value)));
}

function parseLooseNumber(s: string): number | null {
  const sci = /^(-?\d+(?:[.,]\d+)?)\s*[×x]\s*10\s*\^?\s*([-−]?\d+)$/i.exec(s);
  if (sci) return Number(sci[1].replace(',', '.')) * 10 ** Number(sci[2].replace('−', '-'));
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
