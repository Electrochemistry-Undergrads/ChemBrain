import { bodyChars, type ParsedDocument } from './types';
import { normalizeDoi } from '../util';

export type Completeness = 'complete' | 'partial' | 'abstract_only' | 'unreadable';

export interface IdentityCheck {
  expectedDoi: string | null;
  foundDoi: string | null;
  doiMatch: boolean | null;
  titleSimilarity: number | null;
  verdict: 'match' | 'probable' | 'mismatch' | 'unverifiable';
  reason: string;
}

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'for', 'on', 'with', 'to', 'by', 'from', 'via', 'as', 'at', 'its']);

function tokens(s: string) {
  return new Set(
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOP.has(t)),
  );
}

/** Share of the expected title's words that appear in the candidate text (0–1). */
export function titleCoverage(expected: string, candidate: string) {
  const a = tokens(expected);
  if (!a.size) return 0;
  const b = tokens(candidate);
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / a.size;
}

/**
 * Confirms the retrieved document is the requested paper: a DOI match is decisive; otherwise the
 * expected title must be largely present in the document's title or opening text.
 */
export function checkIdentity(doc: ParsedDocument, expected: { doi: string | null; title: string }): IdentityCheck {
  const expectedDoi = normalizeDoi(expected.doi);
  const foundDoi = normalizeDoi(doc.doi);
  const opening = [doc.title ?? '', ...doc.sections.slice(0, 3).map((s) => s.text.slice(0, 1500))].join(' ');
  const sim = expected.title ? Math.max(titleCoverage(expected.title, doc.title ?? ''), titleCoverage(expected.title, opening)) : null;
  // A PDF's first pages often run the DOI into neighbouring text; an exact occurrence of the
  // requested DOI there is as decisive as a parsed DOI field.
  const compact = (doc.openingText ?? '').toLowerCase().replace(/\s+/g, '');
  if (expectedDoi && compact.includes(expectedDoi)) {
    return { expectedDoi, foundDoi: expectedDoi, doiMatch: true, titleSimilarity: sim, verdict: 'match', reason: 'The requested DOI appears in the document.' };
  }
  if (expectedDoi && foundDoi) {
    const doiMatch = expectedDoi === foundDoi;
    return {
      expectedDoi, foundDoi, doiMatch, titleSimilarity: sim,
      verdict: doiMatch ? 'match' : 'mismatch',
      reason: doiMatch ? 'The document DOI matches the requested paper.' : `The document's DOI (${foundDoi}) differs from the requested paper.`,
    };
  }
  if (sim !== null && sim >= 0.8) return { expectedDoi, foundDoi, doiMatch: null, titleSimilarity: sim, verdict: 'probable', reason: 'The requested title appears in the document; no DOI was found to confirm it.' };
  if (sim !== null && sim < 0.5) return { expectedDoi, foundDoi, doiMatch: null, titleSimilarity: sim, verdict: 'mismatch', reason: 'The document text does not match the requested title.' };
  return { expectedDoi, foundDoi, doiMatch: null, titleSimilarity: sim, verdict: 'unverifiable', reason: 'Neither a DOI nor a clear title match was found in the document.' };
}

export function assessCompleteness(doc: ParsedDocument): { completeness: Completeness; hasMethods: boolean; reason: string } {
  const chars = bodyChars(doc);
  const hasMethods = doc.sections.some((s) => s.kind === 'methods');
  const scanned = doc.notes.some((n) => n.includes('little or no extractable text'));
  if (scanned) return { completeness: 'unreadable', hasMethods, reason: 'No extractable text layer (likely a scanned document).' };
  if (chars < 2500) return { completeness: 'abstract_only', hasMethods, reason: `Only ${chars} characters of article body text were found; this is not a complete article.` };
  const hasResults = doc.sections.some((s) => s.kind === 'results');
  if (chars < 8000 || (!hasMethods && !hasResults && doc.format !== 'pdf')) {
    return { completeness: 'partial', hasMethods, reason: 'Body text was found, but it is short or lacks recognisable methods/results sections.' };
  }
  return { completeness: 'complete', hasMethods, reason: hasMethods ? 'Full article body including methods.' : 'Full article body; no section explicitly labelled as methods was detected.' };
}

/** Rejects content that is obviously not an article: HTML login pages, tiny files, error JSON. */
export function sniffContent(bytes: Uint8Array, contentType: string | null): { kind: 'pdf' | 'xml' | 'html' | 'json' | 'unknown' } {
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  if (head.startsWith('%pdf-')) return { kind: 'pdf' };
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || (contentType ?? '').includes('text/html')) return { kind: 'html' };
  if (head.startsWith('<?xml') || head.startsWith('<')) return { kind: 'xml' };
  if (head.startsWith('{') || head.startsWith('[')) return { kind: 'json' };
  return { kind: 'unknown' };
}
