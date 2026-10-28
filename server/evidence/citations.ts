import type { Proposal } from '../meta/schemas';

interface EvidenceRef { paper_id: string; check_status: string }

/** Checks reference existence and paper ownership; scientific support still requires source review. */
export function validateProposal(proposal: Proposal, evidence: Map<string, EvidenceRef>, papers: Map<string, string>) {
  let removedReferences = 0;
  const unsupportedStatements: string[] = [];
  const valid = (refs: string[], paperIds?: Set<string>) => [...new Set(refs.filter((ref) => {
    const item = evidence.get(ref);
    if (!item || (paperIds && !paperIds.has(item.paper_id))) { removedReferences++; return false; }
    return true;
  }))];
  const keep = (refs: string[], statement: string, paperIds?: Set<string>) => {
    const result = valid(refs, paperIds);
    if (!result.length) unsupportedStatements.push(statement);
    return result;
  };
  const p = proposal;
  p.assessment_evidence = keep(p.assessment_evidence, 'Overview');
  if (!p.assessment_evidence.length) p.assessment = 'The supplied sources do not support a conclusion for this request. Review the available evidence or add more relevant papers.';
  for (const a of p.approaches) {
    a.papers = [...new Set(a.papers.filter((ref) => papers.has(ref) || (removedReferences++, false)))];
    const ids = new Set(a.papers.map((ref) => papers.get(ref)!));
    a.summary_evidence = keep(a.summary_evidence, `${a.name}: summary`, ids);
    if (!a.summary_evidence.length) a.summary = 'The source passages do not support a summary for this approach.';
    if (a.synthesis_method) {
      a.synthesis_method.evidence = keep(a.synthesis_method.evidence, `${a.name}: synthesis method ${a.synthesis_method.name}`, ids);
      if (!a.synthesis_method.evidence.length) a.synthesis_method = null;
    }
    a.equipment = a.equipment.filter((i) => (i.evidence = keep(i.evidence, `${a.name}: equipment ${i.name}`, ids)).length);
    a.ingredients = a.ingredients.filter((i) => (i.evidence = keep(i.evidence, `${a.name}: ingredient ${i.name}`, ids)).length);
    a.method = a.method.filter((m) => (m.evidence = keep(m.evidence, `${a.name}: step “${m.step.slice(0, 80)}”`, ids)).length);
    a.performance = a.performance.filter((x) => (x.evidence = keep(x.evidence, `${a.name}: ${x.property} = ${x.value}`, ids)).length);
    const refs = [...a.summary_evidence, ...(a.synthesis_method?.evidence ?? []), ...[...a.equipment, ...a.ingredients, ...a.method, ...a.performance].flatMap((x) => x.evidence)];
    const supportedPapers = new Set(refs.filter((r) => evidence.get(r)?.check_status === 'supported').map((r) => evidence.get(r)!.paper_id));
    if (!a.summary_evidence.length || !supportedPapers.size) a.evidence_strength = 'weak';
    else if (supportedPapers.size < 2 && a.evidence_strength === 'strong') a.evidence_strength = 'moderate';
  }
  const matchesPaper = (row: { paper: string; evidence: string[] }) => {
    const id = papers.get(row.paper);
    if (!id) { removedReferences++; return false; }
    row.evidence = valid(row.evidence, new Set([id]));
    return row.evidence.length > 0;
  };
  p.ingredient_comparison = p.ingredient_comparison.filter((r) => (r.uses = r.uses.filter(matchesPaper)).length);
  p.method_comparison = p.method_comparison.filter((r) => (r.uses = r.uses.filter(matchesPaper)).length);
  p.performance_comparison = p.performance_comparison.filter((r) => {
    r.entries = r.entries.filter(matchesPaper);
    if (new Set(r.entries.map((e) => e.paper)).size < 2) {
      r.comparable = false;
      r.comparability_note = 'Fewer than two papers have cited measurements for this comparison.';
    }
    return r.entries.length;
  });
  p.conflicts = p.conflicts.filter((c) => (c.evidence = keep(c.evidence, `Conflict: ${c.topic}`)).length);
  p.adaptations = p.adaptations.filter((a) => (a.basis = keep(a.basis, `Adaptation: ${a.proposal}`)).length);
  p.next_experiments = p.next_experiments.filter((x) => (x.basis = keep(x.basis, `Experiment: ${x.title}`)).length);

  // Traverse only reference fields: prose containing a string such as "E99" is not a citation.
  const used = new Set([
    ...p.assessment_evidence,
    ...p.approaches.flatMap((a) => [...a.summary_evidence, ...(a.synthesis_method?.evidence ?? []), ...[...a.equipment, ...a.ingredients, ...a.method, ...a.performance].flatMap((x) => x.evidence)]),
    ...p.ingredient_comparison.flatMap((r) => r.uses.flatMap((u) => u.evidence)),
    ...p.method_comparison.flatMap((r) => r.uses.flatMap((u) => u.evidence)),
    ...p.performance_comparison.flatMap((r) => r.entries.flatMap((u) => u.evidence)),
    ...p.conflicts.flatMap((c) => c.evidence), ...p.adaptations.flatMap((a) => a.basis), ...p.next_experiments.flatMap((x) => x.basis),
  ]);
  return { used, removedReferences, unsupportedStatements };
}
