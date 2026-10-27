import type { ParsedDocument, ParsedSection, SectionKind } from './types';

export interface Chunk {
  seq: number;
  section: string;
  kind: SectionKind;
  label?: string;
  pageStart?: number;
  pageEnd?: number;
  text: string;
}

const MAX = 3500;

/**
 * Splits sections into bounded chunks at paragraph and sentence boundaries. Consecutive pieces of
 * the same section (e.g. across PDF pages) are merged while they fit, keeping the page range.
 * Tables and figures stay whole so a quoted value keeps its caption context.
 */
export function chunkDocument(doc: ParsedDocument): Chunk[] {
  const merged: ParsedSection[] = [];
  for (const s of doc.sections) {
    const prev = merged[merged.length - 1];
    if (prev && prev.heading === s.heading && prev.kind === s.kind && !s.label && !prev.label && prev.text.length + s.text.length < MAX) {
      prev.text += '\n\n' + s.text;
      prev.pageEnd = s.pageEnd ?? s.page ?? prev.pageEnd;
    } else merged.push({ ...s });
  }
  const chunks: Chunk[] = [];
  for (const s of merged) {
    for (const piece of split(s.text, s.kind === 'table' ? MAX * 3 : MAX)) {
      chunks.push({
        seq: chunks.length,
        section: s.heading,
        kind: s.kind,
        label: s.label,
        pageStart: s.page,
        pageEnd: s.pageEnd ?? s.page,
        text: piece,
      });
    }
  }
  return chunks;
}

function split(text: string, max: number): string[] {
  if (text.length <= max) return text.trim() ? [text.trim()] : [];
  const out: string[] = [];
  let cur = '';
  const units = text.split(/\n{2,}/).flatMap((p) => (p.length > max ? p.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) ?? [p] : [p]));
  for (const u of units) {
    const piece = u.length > max ? u.match(new RegExp(`[\\s\\S]{1,${max}}`, 'g'))! : [u];
    for (const p of piece) {
      if (cur && cur.length + p.length + 2 > max) {
        out.push(cur.trim());
        cur = '';
      }
      cur += cur ? (/\s$/.test(cur) ? '' : '\n\n') + p : p;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
