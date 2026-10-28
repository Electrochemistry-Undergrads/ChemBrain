import { publicationDoiUrl } from './publications';

/** Metadata comes from the paper record, never from the model's generated text. */
export interface ReportPaper {
  id: string;
  title: string;
  doi: string | null;
  year: number | null;
  venue?: string | null;
  publisher?: string | null;
  landingUrl?: string | null;
}

export function paperJournal(paper: ReportPaper) {
  const venue = paper.venue?.trim();
  if (venue) return venue;
  const publisher = paper.publisher?.trim();
  return publisher === 'American Chemical Society' ? 'ACS' : publisher || 'Paper';
}

export function paperHref(paper: ReportPaper) {
  const doi = paper.doi?.trim();
  if (doi && /^10\.\d{4,9}\/\S+$/.test(doi)) return publicationDoiUrl(doi);
  try {
    const url = new URL(paper.landingUrl ?? '');
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** Prefer the papers that support the named method over unrelated papers in the same approach. */
export function methodPapers(
  approach: { papers: string[]; synthesis_method?: { evidence: string[] } | null },
  papers: Record<string, ReportPaper>,
  evidenceIds: Record<string, string>,
  evidence: ReadonlyMap<string, { paper_id: string }>,
) {
  const candidates = [...new Map(approach.papers.filter((ref) => papers[ref]).map((ref) => [papers[ref].id, papers[ref]])).values()];
  const refs = approach.synthesis_method?.evidence;
  if (!refs?.length) return candidates;
  const sourceIds = new Set(refs.map((ref) => evidence.get(evidenceIds[ref])?.paper_id).filter(Boolean));
  if (sourceIds.size) return candidates.filter((p) => sourceIds.has(p.id));
  // Older reports or a pending evidence request can still identify a single unambiguous paper.
  return candidates.length === 1 ? candidates : [];
}
