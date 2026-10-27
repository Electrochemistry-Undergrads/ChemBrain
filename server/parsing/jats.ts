import { child, childrenNamed, elements, findAll, findFirst, localName, parseXml, textOf, type XmlNode } from './xml';
import { classifyHeading, type ParsedDocument, type ParsedSection, type SectionKind } from './types';
import { normalizeDoi } from '../util';

/** JATS (NLM) XML as served by Springer Nature Open Access API and Europe PMC / PMC. */
export function parseJats(xml: string): ParsedDocument {
  const root = parseXml(xml);
  const article = findFirst(root, 'article');
  if (!article) throw new Error('Not a JATS article (no <article> element).');
  const front = child(article, 'front');
  const meta = findFirst(front, 'article-meta');
  const doiNode = childrenNamed(meta, 'article-id').find((n) => n.attrs['pub-id-type'] === 'doi');
  const title = textOf(findFirst(findFirst(meta, 'title-group'), 'article-title'));
  const lic = findFirst(meta, 'license');
  const licenseRef = findFirst(meta, 'license_ref');
  const licLink = lic && findAll(lic, 'ext-link').find((e) => /creativecommons\.org/.test(e.attrs['xlink:href'] ?? ''));
  const license =
    (licenseRef && textOf(licenseRef)) || lic?.attrs['xlink:href'] || licLink?.attrs['xlink:href'] || (lic ? textOf(lic).slice(0, 300) : undefined);

  const sections: ParsedSection[] = [];
  const notes: string[] = [];
  const abs = childrenNamed(meta, 'abstract').filter((a) => !a.attrs['abstract-type'] || a.attrs['abstract-type'] === 'normal');
  for (const a of abs.length ? abs : childrenNamed(meta, 'abstract').slice(0, 1)) {
    sections.push({ heading: 'Abstract', kind: 'abstract', text: textOf(a, new Set(['title'])) });
  }

  const body = child(article, 'body');
  if (body) walkBody(body, [], sections);
  const back = child(article, 'back');
  if (back) {
    for (const s of childrenNamed(back, 'sec')) walkSec(s, [], sections);
    for (const app of findAll(back, 'app')) walkSec(app, ['Appendix'], sections);
  }
  const floats = child(article, 'floats-group');
  if (floats) collectFloats(floats, sections, 'Floats');

  const supplementary = findAll(article, 'supplementary-material').map((s) => ({
    label: textOf(child(s, 'label')) || textOf(findFirst(s, 'title')) || 'Supplementary material',
    caption: textOf(child(s, 'caption')).slice(0, 400) || undefined,
    href: s.attrs['xlink:href'] || findFirst(s, 'media')?.attrs['xlink:href'],
    retrieved: false,
  }));
  if (!body) notes.push('The XML contains no <body>; only front matter is available.');

  return { format: 'jats', title, doi: normalizeDoi(doiNode ? textOf(doiNode) : null) ?? undefined, license, sections, supplementary, notes };
}

function walkBody(body: XmlNode, path: string[], out: ParsedSection[]) {
  let loose: string[] = [];
  const flush = () => {
    if (loose.length) out.push({ heading: path.join(' › ') || 'Main text', kind: 'body', text: loose.join('\n\n') });
    loose = [];
  };
  for (const c of elements(body)) {
    const ln = localName(c.name);
    if (ln === 'sec') {
      flush();
      walkSec(c, path, out);
    } else if (ln === 'table-wrap' || ln === 'fig') {
      out.push(floatSection(c, path));
    } else if (ln === 'p') {
      loose.push(textOf(c, new Set(['table-wrap', 'fig'])));
      collectFloats(c, out, path.join(' › '));
    }
  }
  flush();
}

function walkSec(sec: XmlNode, parentPath: string[], out: ParsedSection[]) {
  const t = textOf(child(sec, 'title')) || textOf(child(sec, 'label')) || 'Section';
  const path = [...parentPath, t];
  const heading = path.join(' › ');
  const top = parentPath.length ? classifyHeading(parentPath[0]) : 'body';
  let kind: SectionKind = classifyHeading(t);
  if (kind === 'body' && top !== 'body') kind = top;
  if (sec.attrs['sec-type'] && /method|material/i.test(sec.attrs['sec-type'])) kind = 'methods';
  if (localName(sec.name) === 'ref-list') return;
  const paras: string[] = [];
  for (const c of elements(sec)) {
    const ln = localName(c.name);
    if (ln === 'sec') {
      if (paras.length) out.push({ heading, kind, text: paras.join('\n\n') });
      paras.length = 0;
      walkSec(c, path, out);
    } else if (ln === 'table-wrap' || ln === 'fig') {
      out.push(floatSection(c, path));
    } else if (ln !== 'title' && ln !== 'label') {
      paras.push(textOf(c, new Set(['table-wrap', 'fig'])));
      collectFloats(c, out, heading);
    }
  }
  const text = paras.filter(Boolean).join('\n\n');
  if (text) out.push({ heading, kind, text });
}

function collectFloats(node: XmlNode, out: ParsedSection[], heading: string | string[]) {
  for (const f of [...findAll(node, 'table-wrap'), ...findAll(node, 'fig')]) {
    out.push(floatSection(f, Array.isArray(heading) ? heading : [heading]));
  }
}

function floatSection(f: XmlNode, path: string[]): ParsedSection {
  const isTable = localName(f.name) === 'table-wrap';
  const label = textOf(child(f, 'label')) || (isTable ? 'Table' : 'Figure');
  const caption = textOf(child(f, 'caption'));
  const table = isTable ? textOf(findFirst(f, 'table')) : '';
  const foot = isTable ? textOf(child(f, 'table-wrap-foot')) : '';
  return {
    heading: [...path.filter(Boolean), label].join(' › '),
    kind: isTable ? 'table' : 'figure',
    label,
    text: [caption, table, foot].filter(Boolean).join('\n'),
  };
}
