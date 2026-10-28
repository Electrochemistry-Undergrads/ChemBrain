import type { Proposal } from '../server/meta/schemas';

/** Synthetic UI fixture, never served by production and not a real research proposal. */
export const resultsFixture: Proposal = {
  assessment: 'UI test fixture: compare Sol-Gel and hydrothermal synthesis. This is not a live Meta result.',
  assessment_evidence: ['E1', 'E3'],
  approaches: [
    {
      rank: 1, name: 'Sol-Gel route', summary: 'Sol-Gel is the synthesis method in this synthetic example.', papers: ['P1'],
      summary_evidence: ['E1'],
      synthesis_method: { name: 'Sol-Gel', evidence: ['E1'] },
      equipment: [{ name: 'Scanning electron microscope', purpose: 'characterization', evidence: ['E2'] }],
      ingredients: [], method: [{ step: 'The fixture describes a Sol-Gel route.', evidence: ['E1'] }], performance: [],
      fit_to_brief: 'The SEM is listed for characterization, not synthesis.', risks: [], evidence_strength: 'moderate',
    },
    {
      rank: 2, name: 'Hydrothermal route', summary: 'A second synthetic approach for testing filters.', papers: ['P2'],
      summary_evidence: ['E3'],
      synthesis_method: { name: 'Hydrothermal', evidence: ['E3'] },
      equipment: [{ name: 'Autoclave', purpose: 'synthesis', evidence: ['E3'] }, { name: 'Custom test instrument', purpose: 'unspecified', evidence: ['E3'] }],
      ingredients: [], method: [], performance: [], fit_to_brief: 'An autoclave is listed for synthesis.', risks: [], evidence_strength: 'weak',
    },
  ],
  ingredient_comparison: [],
  method_comparison: [{ method: 'Sol-Gel', uses: [{ paper: 'P1', conditions: null, evidence: ['E1'] }], note: 'Synthetic fixture.' }],
  performance_comparison: [], conflicts: [], missing_evidence: [], adaptations: [], next_experiments: [], not_established: [],
};
