export type SectionKind = 'abstract' | 'body' | 'methods' | 'results' | 'table' | 'figure' | 'supplementary' | 'references' | 'other';

export interface ParsedSection {
  heading: string;
  kind: SectionKind;
  label?: string;
  page?: number;
  pageEnd?: number;
  text: string;
}

export interface SupplementaryItem {
  label: string;
  caption?: string;
  href?: string;
  /** Whether ChemBrain retrieved and parsed the file. Supplementary files are never counted as the article. */
  retrieved: boolean;
}

export interface ParsedDocument {
  format: 'jats' | 'elsevier_xml' | 'pdf';
  title?: string;
  doi?: string;
  license?: string;
  sections: ParsedSection[];
  supplementary: SupplementaryItem[];
  pageCount?: number;
  /** PDF only: raw text of the first pages, used for identity checks. */
  openingText?: string;
  notes: string[];
}

const METHODS_RE = /\b(experimental|materials?(\s+and\s+methods?)?|methods?|methodology|synthesis|preparation|fabrication|procedures?|characteri[sz]ation|sample preparation)\b/i;
const RESULTS_RE = /\b(results?|discussion|performance|properties)\b/i;
const REFS_RE = /^(references?|bibliography|literature cited)\b/i;
const SI_RE = /\b(supporting information|supplementary|electronic supplementary)\b/i;

export function classifyHeading(heading: string): SectionKind {
  const h = heading.replace(/^[\dIVX.\s]+/, '').trim();
  if (REFS_RE.test(h)) return 'references';
  if (SI_RE.test(h)) return 'supplementary';
  if (/^abstract\b/i.test(h)) return 'abstract';
  if (METHODS_RE.test(h)) return 'methods';
  if (RESULTS_RE.test(h)) return 'results';
  return 'body';
}

/** Section kinds that represent the article's own scientific content (used for completeness). */
export const CONTENT_KINDS: SectionKind[] = ['body', 'methods', 'results', 'table', 'figure'];

export function bodyChars(doc: ParsedDocument) {
  return doc.sections.filter((s) => CONTENT_KINDS.includes(s.kind)).reduce((a, s) => a + s.text.length, 0);
}
