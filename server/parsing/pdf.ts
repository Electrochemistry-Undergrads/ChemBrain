import { classifyHeading, type ParsedDocument, type ParsedSection, type SectionKind } from './types';

const KNOWN_HEADINGS =
  /^((\d{1,2}(\.\d{1,2}){0,3}\.?|[IVX]{1,4}\.)\s+)?(abstract|introduction|background|experimental( section| details| procedures?)?|materials?( and methods?)?|methods?|methodology|results?( and discussion)?|discussion|conclusions?|acknowledge?ments?|references|supporting information|supplementary (information|material)|associated content|author information|notes|data availability|declaration of competing interest|credit authorship contribution statement)\s*:?$/i;
const NUMBERED_HEADING = /^(\d{1,2}(\.\d{1,2}){0,3}\.?|[IVX]{1,4}\.)\s+[A-Z][^.!?]{2,90}$/;

export interface PdfLine {
  text: string;
  size: number;
}

/**
 * Turns per-page text lines into sections. Headings are recognised by standard section names or
 * numbered-heading patterns, preferring lines set larger than the body text. Each section piece is
 * tied to one page so evidence keeps its page reference.
 */
export function sectionsFromPages(rawPages: PdfLine[][]): ParsedSection[] {
  const pages = stripRunningHeaders(rawPages);
  const sizes = pages.flat().map((l) => l.size).filter((s) => s > 0).sort((a, b) => a - b);
  const bodySize = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
  const out: ParsedSection[] = [];
  let heading = 'Front matter';
  let kind: SectionKind = 'body';
  let top: SectionKind = 'body';
  for (let p = 0; p < pages.length; p++) {
    let buf: string[] = [];
    const flush = () => {
      const text = joinLines(buf);
      if (text) out.push({ heading, kind, page: p + 1, pageEnd: p + 1, text });
      buf = [];
    };
    for (const line of pages[p]) {
      const t = line.text.trim();
      if (!t) continue;
      const looksHeading =
        t.length <= 100 && (KNOWN_HEADINGS.test(t) || (NUMBERED_HEADING.test(t) && (bodySize === 0 || line.size >= bodySize * 1.02)));
      if (looksHeading) {
        flush();
        heading = t;
        const k = classifyHeading(t);
        const isSub = /^\d{1,2}\.\d/.test(t);
        if (!isSub) top = k;
        kind = k === 'body' && isSub ? top : k;
        continue;
      }
      buf.push(t);
    }
    flush();
  }
  return out;
}

/** Removes running headers/footers: short lines that recur (ignoring digits) on many pages. */
export function stripRunningHeaders(pages: PdfLine[][]): PdfLine[][] {
  if (pages.length < 3) return pages;
  const key = (t: string) => t.replace(/[\d\s]+/g, '').toLowerCase();
  const counts = new Map<string, number>();
  for (const page of pages) {
    const seen = new Set<string>();
    for (const l of [...page.slice(0, 4), ...page.slice(-4)]) {
      const k = key(l.text);
      if (k.length >= 3 && l.text.length <= 140 && !seen.has(k)) {
        seen.add(k);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.4));
  return pages.map((page) => page.filter((l, i) => !((i < 4 || i >= page.length - 4) && (counts.get(key(l.text)) ?? 0) >= threshold)));
}

function joinLines(lines: string[]) {
  let s = '';
  for (const l of lines) {
    if (!s) s = l;
    else if (/[a-z]-$/.test(s) && /^[a-z]/.test(l)) s = s.slice(0, -1) + l; // de-hyphenate line breaks
    else s += ' ' + l;
  }
  return s.replace(/\s{2,}/g, ' ').trim();
}

export async function parsePdf(bytes: Uint8Array): Promise<ParsedDocument> {
  const { getDocumentProxy, extractTextItems } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { isEvalSupported: false, disableFontFace: true } as never);
  const { totalPages, items } = await extractTextItems(pdf);
  const pages: PdfLine[][] = items.map((pageItems) => {
    const lines: PdfLine[] = [];
    let cur = '';
    let size = 0;
    let prevEnd: number | null = null;
    for (const it of pageItems) {
      // Insert a space where the layout leaves a horizontal gap between text items on one line.
      const gap = prevEnd !== null && it.x - prevEnd > Math.max(1, (it.fontSize || 10) * 0.15);
      if (gap && cur && !/\s$/.test(cur) && !/^\s/.test(it.str)) cur += ' ';
      cur += it.str;
      prevEnd = it.x + it.width;
      size = Math.max(size, it.fontSize || 0);
      if (it.hasEOL) {
        lines.push({ text: cur, size });
        cur = '';
        size = 0;
        prevEnd = null;
      }
    }
    if (cur) lines.push({ text: cur, size });
    return lines;
  });
  const chars = pages.flat().reduce((a, l) => a + l.text.length, 0);
  const notes: string[] = ['Parsed from PDF: tables and equations are extracted as plain text and may lose layout.'];
  if (totalPages > 0 && chars / totalPages < 200) {
    notes.push('The PDF has little or no extractable text (it may be scanned images). OCR is not performed.');
  }
  let title: string | undefined;
  try {
    const meta = await pdf.getMetadata();
    const t = (meta.info as Record<string, unknown>)?.Title;
    if (typeof t === 'string' && t.trim().length > 10) title = t.trim();
  } catch {
    /* metadata is optional */
  }
  const firstPagesText = pages.slice(0, 2).flat().map((l) => l.text).join(' ');
  const doiMatch = /\b(10\.\d{4,9}\/[^\s"<>]+?)(?=[\s"<>]|www\.|https?:|$)/i.exec(firstPagesText);
  await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.();
  return {
    format: 'pdf',
    title,
    doi: doiMatch ? doiMatch[1].replace(/[.,;)\]]+$/, '').toLowerCase() : undefined,
    sections: sectionsFromPages(pages),
    supplementary: [],
    pageCount: totalPages,
    openingText: firstPagesText.slice(0, 20000),
    notes,
  };
}
