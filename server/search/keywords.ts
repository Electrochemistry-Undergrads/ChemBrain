/**
 * Search plan built from the researcher's free-text description when Meta is not configured:
 * content words in their original order, one query for the whole description and one per clause.
 */
const STOP = new Set(
  `a an the and or of for to in on with without by from as at into onto via that which who whose this these those it its is are be been being
   i we you they my our your their me us want wants wanted need needs would like should could can will must may might
   make making made develop developing create creating produce producing design designing find get use using used
   something some any very really quite more most less least also just about into than then so such
   compound material product thing stuff based kind type good better best new novel`
    .split(/\s+/)
    .filter(Boolean),
);

function contentWords(text: string) {
  const out: string[] = [];
  for (const raw of text.match(/[\p{L}\p{N}][\p{L}\p{N}()\-+/.]*[\p{L}\p{N})]|[\p{L}\p{N}]/gu) ?? []) {
    const w = raw.replace(/\.$/, '');
    const lw = w.toLowerCase();
    if (STOP.has(lw) || (w.length < 3 && !/\d/.test(w) && w !== w.toUpperCase())) continue;
    if (!out.some((o) => o.toLowerCase() === lw)) out.push(w);
  }
  return out;
}

export function keywordPlan(description: string) {
  const all = contentWords(description);
  const queries: string[] = [];
  const add = (words: string[], min: number) => {
    const q = words.slice(0, 8).join(' ');
    // Skip fragments too short to be a useful query, and clauses already covered by a longer query.
    if (words.length >= min && !queries.some((x) => x.toLowerCase().includes(q.toLowerCase()))) queries.push(q);
  };
  add(all, 2);
  for (const clause of description.split(/[.;,\n]|\band\b|\bwith\b/i)) add(contentWords(clause), 3);
  if (!queries.length && all.length) queries.push(all.join(' '));
  return {
    interpretation: 'Search terms taken from your description. Meta-based planning (which infers target properties and constraints) runs once the Meta API is configured.',
    target_properties: [] as string[],
    queries: queries.slice(0, 4).map((query) => ({ query, rationale: 'Keywords from your description' })),
    inclusion_criteria: [] as string[],
    exclusion_criteria: [] as string[],
  };
}
