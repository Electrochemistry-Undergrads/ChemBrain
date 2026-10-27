const commonMethods = [
  'sol[\\s‐‑–—-]*gel', 'hydrothermal', 'solvothermal', 'co[\\s‐‑–—-]*precipitation',
  'solution casting', 'solid[\\s‐‑–—-]*state(?: reaction| synthesis)?', 'combustion synthesis',
  'electrodeposition', 'electrospinning', 'chemical vapou?r deposition', 'physical vapou?r deposition',
  'mechanochemical synthesis', 'spray pyrolysis',
];
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Formatting only: supplied method names are never used to infer a published method. */
export function synthesisSegments(text: string, names: string[] = []) {
  const supplied = [...new Set(names.map((n) => n.replace(/\*\*/g, '').trim()).filter((n) => n.length >= 3))]
    .sort((a, b) => b.length - a.length).map(escapeRegex);
  const pattern = new RegExp(`\\*\\*([^*\\n]+)\\*\\*|(?<![\\p{L}\\p{N}])(?:${[...supplied, ...commonMethods].join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  const parts: { text: string; bold: boolean }[] = [];
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > end) parts.push({ text: text.slice(end, match.index), bold: false });
    parts.push({ text: match[1] ?? match[0], bold: true });
    end = match.index! + match[0].length;
  }
  if (end < text.length) parts.push({ text: text.slice(end), bold: false });
  return parts;
}

export function synthesisMarkdown(text: string, names: string[] = []) {
  return synthesisSegments(text, names).map((p) => p.bold ? `**${p.text}**` : p.text).join('');
}
