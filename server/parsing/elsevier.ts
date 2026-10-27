import { child, childrenNamed, elements, findAll, findFirst, localName, parseXml, textOf, type XmlNode } from './xml';
import { classifyHeading, type ParsedDocument, type ParsedSection, type SectionKind } from './types';
import { normalizeDoi } from '../util';

/**
 * Elsevier Article Retrieval API full-text XML (full-text-retrieval-response). Structured body
 * text lives under originalText › xocs:doc › … › ce:sections. When the caller is not entitled
 * the response carries only coredata (metadata and abstract), which we report as abstract-only.
 */
export function parseElsevierXml(xml: string): ParsedDocument {
  const root = parseXml(xml);
  const resp = findFirst(root, 'full-text-retrieval-response');
  if (!resp) throw new Error('Not an Elsevier full-text-retrieval-response document.');
  const core = child(resp, 'coredata');
  const title = textOf(findFirst(core, 'title'));
  const doi = normalizeDoi(textOf(findFirst(core, 'doi'))) ?? undefined;
  const oaLicense = textOf(findFirst(core, 'openaccessUserLicense')) || undefined;
  const sections: ParsedSection[] = [];
  const notes: string[] = [];

  const original = child(resp, 'originalText');
  const abstractNode = findFirst(original, 'abstract');
  const abstractText = abstractNode ? textOf(abstractNode, new Set(['section-title'])) : textOf(findFirst(core, 'description'));
  if (abstractText) sections.push({ heading: 'Abstract', kind: 'abstract', text: abstractText.replace(/^Abstract\s*/i, '') });

  const ceSections = findFirst(original, 'sections');
  if (ceSections) {
    for (const s of childrenNamed(ceSections, 'section')) walk(s, [], sections);
    const loose = elements(ceSections).filter((e) => localName(e.name) === 'para');
    if (loose.length) sections.push({ heading: 'Main text', kind: 'body', text: loose.map((p) => textOf(p)).join('\n\n') });
  } else {
    const raw = findFirst(original, 'rawtext');
    if (raw && textOf(raw).length > 2000) {
      sections.push({ heading: 'Full text (unstructured)', kind: 'body', text: textOf(raw) });
      notes.push('Elsevier returned unstructured raw text without section markup.');
    }
  }

  for (const t of findAll(original, 'table')) sections.push(floatOf(t, 'table'));
  for (const f of findAll(original, 'figure')) sections.push(floatOf(f, 'figure'));

  const supplementary = findAll(original, 'e-component').map((e) => ({
    label: textOf(child(e, 'label')) || 'Supplementary material',
    caption: textOf(child(e, 'caption')).slice(0, 400) || undefined,
    href: findFirst(e, 'link')?.attrs['locator'],
    retrieved: false,
  }));
  if (!original) notes.push('No originalText element: the API returned metadata only (not entitled, or view not FULL).');

  return { format: 'elsevier_xml', title, doi, license: oaLicense, sections, supplementary, notes };
}

function walk(sec: XmlNode, parent: string[], out: ParsedSection[]) {
  const label = textOf(child(sec, 'label'));
  const t = textOf(child(sec, 'section-title')) || 'Section';
  const path = [...parent, label ? `${label} ${t}` : t];
  const heading = path.join(' › ');
  let kind: SectionKind = classifyHeading(t);
  const top = parent.length ? classifyHeading(parent[0]) : 'body';
  if (kind === 'body' && top !== 'body') kind = top;
  const paras: string[] = [];
  for (const c of elements(sec)) {
    const ln = localName(c.name);
    if (ln === 'section') {
      if (paras.length) out.push({ heading, kind, text: paras.join('\n\n') });
      paras.length = 0;
      walk(c, path, out);
    } else if (ln === 'para' || ln === 'list' || ln === 'display' || ln === 'textbox') {
      paras.push(textOf(c, new Set(['float-anchor'])));
    }
  }
  if (paras.length) out.push({ heading, kind, text: paras.join('\n\n') });
}

function floatOf(n: XmlNode, kind: 'table' | 'figure'): ParsedSection {
  const label = textOf(child(n, 'label')) || (kind === 'table' ? 'Table' : 'Figure');
  const caption = textOf(child(n, 'caption'));
  const body = kind === 'table' ? textOf(findFirst(n, 'tgroup') ?? n, new Set(['label', 'caption'])) : '';
  const legend = textOf(child(n, 'legend')) + textOf(child(n, 'table-footnote'));
  return { heading: label, kind, label, text: [caption, body, legend].filter(Boolean).join('\n') };
}
