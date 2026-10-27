import { describe, expect, it } from 'vitest';
import { DEMO_PAPERS } from '../server/demo/papers.generated';
import { parseJats } from '../server/parsing/jats';
import { parseElsevierXml } from '../server/parsing/elsevier';
import { chunkDocument } from '../server/parsing/chunk';
import { assessCompleteness, checkIdentity, sniffContent } from '../server/parsing/quality';
import { sectionsFromPages } from '../server/parsing/pdf';
import { parseXml, textOf } from '../server/parsing/xml';

describe('XML parser', () => {
  it('decodes entities, keeps inline chemistry together, ignores DTDs', () => {
    const root = parseXml('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><p>H<sub>2</sub>O at 25&#x00B0;C &amp; &e;</p>');
    expect(textOf(root)).toBe('H2O at 25°C & &e;');
  });
  it('tolerates mismatched closing tags', () => {
    expect(textOf(parseXml('<a><b>one</a><c>two</c>'))).toContain('two');
  });
});

describe('JATS demo papers', () => {
  for (const p of DEMO_PAPERS) {
    it(`${p.doi} parses as a complete article with matching identity`, () => {
      const doc = parseJats(p.xml);
      expect(doc.doi).toBe(p.doi.toLowerCase());
      expect(doc.title && doc.title.length).toBeGreaterThan(20);
      expect(doc.sections.some((s) => s.kind === 'methods')).toBe(true);
      expect(doc.sections.some((s) => s.kind === 'table')).toBe(true);
      expect(assessCompleteness(doc).completeness).toBe('complete');
      expect(checkIdentity(doc, { doi: p.doi, title: doc.title! }).verdict).toBe('match');
      expect(checkIdentity(doc, { doi: '10.1000/other', title: 'x' }).verdict).toBe('mismatch');
      const chunks = chunkDocument(doc);
      expect(chunks.length).toBeGreaterThan(8);
      expect(Math.max(...chunks.filter((c) => c.kind !== 'table').map((c) => c.text.length))).toBeLessThanOrEqual(3500);
      expect(doc.license).toMatch(/creativecommons|Creative Commons/i);
      expect(p.xml).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
    });
  }
});

describe('Elsevier XML', () => {
  const meta = `<full-text-retrieval-response xmlns:dc="x" xmlns:prism="y"><coredata><prism:doi>10.1016/j.test.2020.1</prism:doi><dc:title>A test film</dc:title><dc:description>Short abstract.</dc:description></coredata></full-text-retrieval-response>`;
  it('reports metadata-only responses as abstract only', () => {
    const doc = parseElsevierXml(meta);
    expect(doc.doi).toBe('10.1016/j.test.2020.1');
    expect(assessCompleteness(doc).completeness).toBe('abstract_only');
    expect(doc.notes.join(' ')).toMatch(/metadata only/);
  });
  it('reads ce:sections with nested methods', () => {
    const para = '<ce:para>Glycerol (30 wt%) was added and the film was cast at 40 °C for 24 h. '.repeat(60) + '</ce:para>';
    const xml = `<full-text-retrieval-response><coredata><prism:doi>10.1016/j.test.2020.1</prism:doi><dc:title>A test film</dc:title></coredata><originalText><xocs:doc><xocs:serial-item><article><body><ce:sections><ce:section><ce:label>2</ce:label><ce:section-title>Materials and methods</ce:section-title><ce:section><ce:label>2.1</ce:label><ce:section-title>Film casting</ce:section-title>${para}</ce:section></ce:section><ce:section><ce:section-title>Results and discussion</ce:section-title>${para}${para}</ce:section></ce:sections></body></article></xocs:serial-item></xocs:doc></originalText></full-text-retrieval-response>`;
    const doc = parseElsevierXml(xml);
    const methods = doc.sections.find((s) => s.heading.includes('Film casting'));
    expect(methods?.kind).toBe('methods');
    expect(assessCompleteness(doc).completeness).toBe('complete');
  });
});

describe('PDF sectioning and content sniffing', () => {
  it('finds headings and keeps page numbers', () => {
    const L = (text: string, size = 10) => ({ text, size });
    const secs = sectionsFromPages([
      [L('A film paper', 16), L('Abstract', 11), L('We made films.'), L('1. Introduction', 11), L('Films are use-'), L('ful.')],
      [L('2. Experimental', 11), L('2.1 Materials', 11), L('Glycerol was used.'), L('References'), L('[1] X.')],
    ]);
    expect(secs.find((s) => s.heading === '1. Introduction')?.text).toBe('Films are useful.');
    const mat = secs.find((s) => s.heading === '2.1 Materials')!;
    expect(mat.kind).toBe('methods');
    expect(mat.page).toBe(2);
    expect(secs.find((s) => s.heading === 'References')?.kind).toBe('references');
  });
  it('strips running headers that repeat across pages', () => {
    const L = (text: string) => ({ text, size: 10 });
    const pages = [1, 2, 3, 4, 5].map((n) => [L(`${n}Vol.:(0123456789) Scientific Reports | (2020) 10:13622`), L(`Body text about ${['glycerol', 'sorbitol', 'chitosan', 'starch', 'gelatin'][n - 1]} films.`)]);
    const secs = sectionsFromPages(pages);
    expect(secs.map((s) => s.text).join(' ')).not.toMatch(/Scientific Reports/);
    expect(secs.map((s) => s.text).join(' ')).toMatch(/chitosan/);
  });
  it('recognises login pages as HTML, not articles', () => {
    expect(sniffContent(new TextEncoder().encode('<!DOCTYPE html><title>Sign in</title>'), 'text/html').kind).toBe('html');
    expect(sniffContent(new TextEncoder().encode('%PDF-1.7'), 'application/pdf').kind).toBe('pdf');
  });
});
