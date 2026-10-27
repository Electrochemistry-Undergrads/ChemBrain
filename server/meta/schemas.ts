import { z } from 'zod';

/** JSON Schema for the Meta API's response_format, derived from the same zod schema we validate with. */
export function jsonSchemaOf(schema: z.ZodTypeAny): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { target: 'draft-2020-12' }) as Record<string, unknown>;
  return rest;
}

const str = z.string().max(2000);
const nstr = z.string().max(2000).nullable();

export const SearchPlan = z.strictObject({
  interpretation: z.string().max(1500),
  target_properties: z.array(str).max(12),
  queries: z.array(z.strictObject({ query: z.string().max(200), rationale: z.string().max(400) })).min(1).max(8),
  inclusion_criteria: z.array(str).max(8),
  exclusion_criteria: z.array(str).max(8),
});
export type SearchPlan = z.infer<typeof SearchPlan>;

export const Screening = z.strictObject({
  ratings: z.array(z.strictObject({ ref: z.string().max(10), relevance: z.number().min(0).max(1), reason: z.string().max(300) })).max(60),
});

export const CATEGORIES = [
  'objective',
  'material',
  'ingredient',
  'equipment',
  'method_step',
  'condition',
  'characterization',
  'result',
  'hazard',
  'limitation',
  'unsuccessful_approach',
] as const;

export const Extraction = z.strictObject({
  items: z
    .array(
      z.strictObject({
        chunk_ref: z.string().max(12),
        category: z.enum(CATEGORIES),
        subject: z.string().max(200),
        role: nstr,
        value_text: z.string().max(200).nullable(),
        value_num: z.number().nullable(),
        unit: z.string().max(60).nullable(),
        conditions: z.string().max(400).nullable(),
        quote: z.string().max(600),
        uncertainty: z.string().max(300).nullable(),
      }),
    )
    .max(80),
  not_reported: z.array(z.string().max(300)).max(15),
});
export type Extraction = z.infer<typeof Extraction>;

export const Check = z.strictObject({
  checks: z
    .array(
      z.strictObject({
        evidence_ref: z.string().max(12),
        verdict: z.enum(['supported', 'partially_supported', 'unsupported']),
        note: z.string().max(300),
      }),
    )
    .max(200),
});

const refs = z.array(z.string().max(12)).max(20);

export const Proposal = z.strictObject({
  assessment: z.string().max(4000),
  approaches: z
    .array(
      z.strictObject({
        rank: z.number().int().min(1).max(10),
        name: z.string().max(200),
        summary: z.string().max(1500),
        papers: z.array(z.string().max(10)).max(10),
        synthesis_method: z.strictObject({ name: z.string().min(1).max(200), evidence: refs }).nullable(),
        equipment: z.array(z.strictObject({ name: z.string().min(1).max(200), purpose: z.enum(['synthesis', 'characterization', 'unspecified']), evidence: refs })).max(20),
        ingredients: z.array(z.strictObject({ name: z.string().max(200), role: nstr, amount: nstr, evidence: refs })).max(20),
        method: z.array(z.strictObject({ step: z.string().max(600), evidence: refs })).max(20),
        performance: z.array(z.strictObject({ property: z.string().max(200), value: z.string().max(200), test_conditions: nstr, evidence: refs })).max(20),
        fit_to_brief: z.string().max(1000),
        risks: z.array(z.string().max(400)).max(10),
        evidence_strength: z.enum(['strong', 'moderate', 'weak']),
      }),
    )
    .max(6),
  ingredient_comparison: z
    .array(
      z.strictObject({
        ingredient: z.string().max(200),
        role: nstr,
        uses: z.array(z.strictObject({ paper: z.string().max(10), amount: nstr, evidence: refs })).max(10),
      }),
    )
    .max(30),
  method_comparison: z
    .array(
      z.strictObject({
        method: z.string().max(200),
        uses: z.array(z.strictObject({ paper: z.string().max(10), conditions: nstr, evidence: refs })).max(10),
        note: nstr,
      }),
    )
    .max(20),
  performance_comparison: z
    .array(
      z.strictObject({
        property: z.string().max(200),
        entries: z.array(z.strictObject({ paper: z.string().max(10), value: z.string().max(200), test_conditions: nstr, evidence: refs })).max(12),
        comparable: z.boolean(),
        comparability_note: z.string().max(600),
      }),
    )
    .max(20),
  conflicts: z.array(z.strictObject({ topic: z.string().max(200), description: z.string().max(1000), evidence: refs })).max(10),
  missing_evidence: z.array(z.string().max(500)).max(15),
  adaptations: z.array(z.strictObject({ proposal: z.string().max(1000), basis: refs, caveat: z.string().max(500) })).max(10),
  next_experiments: z
    .array(
      z.strictObject({
        title: z.string().max(200),
        rationale: z.string().max(1000),
        design: z.string().max(1500),
        measurements: z.array(z.string().max(200)).max(10),
        basis: refs,
      }),
    )
    .max(8),
  not_established: z.array(z.string().max(500)).max(15),
});
export type Proposal = z.infer<typeof Proposal>;

export const Answer = z.strictObject({
  answer: z.string().max(4000),
  citations: z.array(z.strictObject({ chunk_ref: z.string().max(12), quote: z.string().max(600) })).max(12),
  insufficient_evidence: z.boolean(),
});
export type Answer = z.infer<typeof Answer>;
