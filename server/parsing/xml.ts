/**
 * Small non-validating XML parser for publisher full text (JATS, Elsevier). It runs in the
 * Workers runtime (no DOMParser there), never fetches external entities or DTDs, and keeps
 * namespace prefixes in element names ("ce:section").
 */
export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: (XmlNode | string)[];
}

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', thinsp: ' ', ndash: '–', mdash: '—',
  deg: '°', plusmn: '±', times: '×', micro: 'µ', minus: '−', le: '≤', ge: '≥',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', mu: 'μ', lambda: 'λ', theta: 'θ',
  sigma: 'σ', pi: 'π', omega: 'ω', Delta: 'Δ', Omega: 'Ω', rarr: '→', larr: '←',
  hellip: '…', prime: '′', middot: '·', sdot: '⋅', ensp: ' ', emsp: ' ', lsquo: '‘',
  rsquo: '’', ldquo: '“', rdquo: '”', permil: '‰', sim: '∼', approx: '≈',
};

export function decodeEntities(s: string) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    return NAMED[e] ?? m;
  });
}

export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      pushText(stack[stack.length - 1], src.slice(i));
      break;
    }
    if (lt > i) pushText(stack[stack.length - 1], src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      const text = src.slice(lt + 9, end === -1 ? n : end);
      stack[stack.length - 1].children.push(text);
      i = end === -1 ? n : end + 3;
    } else if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      i = end === -1 ? n : end + 2;
    } else if (src.startsWith('<!', lt)) {
      // DOCTYPE, possibly with an internal subset in [...]. Skipped, never resolved.
      let j = lt + 2;
      let depth = 0;
      while (j < n) {
        const c = src[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
        j++;
      }
      i = j + 1;
    } else if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt);
      const name = src.slice(lt + 2, end === -1 ? n : end).trim();
      // Pop to the matching element; tolerate mismatched markup instead of failing the paper.
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      i = end === -1 ? n : end + 1;
    } else {
      const end = findTagEnd(src, lt + 1);
      let inner = src.slice(lt + 1, end);
      const selfClosing = inner.endsWith('/');
      if (selfClosing) inner = inner.slice(0, -1);
      const m = /^([^\s/>]+)/.exec(inner);
      const name = m ? m[1] : '';
      const node: XmlNode = { name, attrs: parseAttrs(inner.slice(name.length)), children: [] };
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) stack.push(node);
      i = end + 1;
    }
  }
  return root;
}

function findTagEnd(src: string, from: number) {
  let q: string | null = null;
  for (let j = from; j < src.length; j++) {
    const c = src[j];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '>') return j;
  }
  return src.length;
}

function parseAttrs(s: string) {
  const attrs: Record<string, string> = {};
  const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? '');
  return attrs;
}

function pushText(node: XmlNode, raw: string) {
  if (raw) node.children.push(decodeEntities(raw));
}

export const localName = (name: string) => {
  const i = name.indexOf(':');
  return i === -1 ? name : name.slice(i + 1);
};

export function elements(node: XmlNode): XmlNode[] {
  return node.children.filter((c): c is XmlNode => typeof c !== 'string');
}

export function child(node: XmlNode | undefined, local: string): XmlNode | undefined {
  if (!node) return undefined;
  return elements(node).find((c) => localName(c.name) === local);
}

export function childrenNamed(node: XmlNode | undefined, local: string): XmlNode[] {
  if (!node) return [];
  return elements(node).filter((c) => localName(c.name) === local);
}

/** Depth-first search for descendants with a given local name (does not descend into matches). */
export function findAll(node: XmlNode | undefined, local: string, out: XmlNode[] = []): XmlNode[] {
  if (!node) return out;
  for (const c of elements(node)) {
    if (localName(c.name) === local) out.push(c);
    else findAll(c, local, out);
  }
  return out;
}

export function findFirst(node: XmlNode | undefined, local: string): XmlNode | undefined {
  if (!node) return undefined;
  for (const c of elements(node)) {
    if (localName(c.name) === local) return c;
    const f = findFirst(c, local);
    if (f) return f;
  }
  return undefined;
}

const BLOCK = new Set(['p', 'para', 'simple-para', 'title', 'section-title', 'list-item', 'item', 'caption', 'label', 'tr', 'row', 'disp-formula', 'display', 'def-item', 'statement']);
const CELL = new Set(['td', 'th', 'entry']);

/** Text content with paragraph breaks for block elements and tabs between table cells. */
export function textOf(node: XmlNode | string | undefined, skip: Set<string> = new Set()): string {
  if (node === undefined) return '';
  if (typeof node === 'string') return node;
  const parts: string[] = [];
  walk(node);
  return parts
    .join('')
    .replace(/[  ]*\n[  \n]*/g, '\n')
    .replace(/[ \t ]{2,}/g, ' ')
    .trim();

  function walk(n: XmlNode) {
    for (const c of n.children) {
      if (typeof c === 'string') {
        parts.push(c.replace(/\s+/g, ' '));
        continue;
      }
      const ln = localName(c.name);
      if (skip.has(ln)) continue;
      if (BLOCK.has(ln)) parts.push('\n');
      walk(c);
      if (BLOCK.has(ln)) parts.push('\n');
      else if (CELL.has(ln)) parts.push('\t');
    }
  }
}
