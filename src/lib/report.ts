import type { Proposal } from '../../server/meta/schemas';
import { instrumentsIn } from '../../shared/instruments';

/** Older saved reports predate the structured synthesis and equipment fields. */
export type ReportApproach = Omit<Proposal['approaches'][number], 'synthesis_method' | 'equipment'> &
  Partial<Pick<Proposal['approaches'][number], 'synthesis_method' | 'equipment'>>;
export type StoredProposal = Omit<Proposal, 'approaches'> & { approaches: ReportApproach[] };

export function proposalMethods(proposal: StoredProposal) {
  return [...proposal.approaches.flatMap((a) => a.synthesis_method ? [a.synthesis_method.name] : []), ...proposal.method_comparison.map((m) => m.method)];
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export interface ReportedInstrument {
  name: string;
  purpose: 'synthesis' | 'characterization' | 'unspecified';
  evidence: string[];
  approaches: { rank: number; name: string }[];
}

export function reportedInstruments(approaches: ReportApproach[]) {
  const rows = new Map<string, ReportedInstrument>();
  for (const a of [...approaches].sort((a, b) => a.rank - b.rank)) {
    for (const equipment of a.equipment ?? []) {
      const key = `${normalize(equipment.name)}:${equipment.purpose}`;
      const row = rows.get(key) ?? { ...equipment, evidence: [], approaches: [] };
      row.evidence = [...new Set([...row.evidence, ...equipment.evidence])];
      if (!row.approaches.some((p) => p.rank === a.rank)) row.approaches.push({ rank: a.rank, name: a.name });
      rows.set(key, row);
    }
  }
  return [...rows.values()];
}

export function filterReportedInstruments(rows: ReportedInstrument[], query: string, group: string, purpose: string) {
  const terms = normalize(query).split(' ').filter(Boolean);
  return rows.filter((row) => {
    const instruments = instrumentsIn(row.name);
    const text = normalize([row.name, ...instruments.flatMap((i) => [i.name, ...i.aliases])].join(' '));
    return terms.every((t) => text.includes(t)) && (!purpose || row.purpose === purpose) &&
      (!group || (group === 'other' ? instruments.length === 0 : instruments.some((i) => i.group === group)));
  });
}
