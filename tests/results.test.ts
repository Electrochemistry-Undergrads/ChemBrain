import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { INSTRUMENTS, instrumentsIn } from '../shared/instruments';
import { synthesisMarkdown } from '../shared/synthesis';
import { SynthesisText } from '../src/components/SynthesisText';
import { filterReportedInstruments, reportedInstruments } from '../src/lib/report';
import { InstrumentResults } from '../src/components/InstrumentResults';
import { Proposal, jsonSchemaOf } from '../server/meta/schemas';
import { toMarkdown } from '../server/api/reports';
import { resultsFixture } from './results-fixture';

describe('synthesis emphasis and equipment filters', () => {
  it('recognizes acronyms and full names without matching unrelated words', () => {
    expect(new Set(INSTRUMENTS.map((i) => i.id)).size).toBe(INSTRUMENTS.length);
    expect(instrumentsIn('SEM').map((i) => i.id)).toEqual(['sem']);
    expect(instrumentsIn('Scanning electron microscope').map((i) => i.id)).toEqual(['sem']);
    expect(instrumentsIn('Scanning electron microscopy and FT-IR').map((i) => i.id)).toEqual(['sem', 'ftir']);
    expect(instrumentsIn('assembly temperature')).toEqual([]);
  });

  it('renders method names in bold while escaping model-supplied HTML', () => {
    const html = renderToStaticMarkup(createElement(SynthesisText, { text: 'Try Sol–Gel, SOL-GEL and Custom (A+B). <script>alert(1)</script>', names: ['Custom (A+B)'] }));
    expect(html).toContain('<strong>Sol–Gel</strong>');
    expect(html).toContain('<strong>SOL-GEL</strong>');
    expect(html).toContain('<strong>Custom (A+B)</strong>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(synthesisMarkdown('**Sol-Gel** then solution casting')).toBe('**Sol-Gel** then **solution casting**');
  });

  it('filters individual reported instruments by aliases, category and purpose', () => {
    const rows = reportedInstruments(resultsFixture.approaches);
    expect(filterReportedInstruments(rows, 'SEM', '', '').map((r) => r.name)).toEqual(['Scanning electron microscope']);
    expect(filterReportedInstruments(rows, '', 'Heating & pressure', 'synthesis').map((r) => r.name)).toEqual(['Autoclave']);
    expect(filterReportedInstruments(rows, 'SEM', 'Heating & pressure', '')).toEqual([]);
    expect(filterReportedInstruments(rows, 'SEM', '', 'synthesis')).toEqual([]);
    expect(filterReportedInstruments(rows, '', 'other', '').map((r) => r.name)).toEqual(['Custom test instrument']);
    expect(filterReportedInstruments(rows, '', '', '').length).toBe(3);
  });

  it('preserves source and approach links when an instrument appears in multiple approaches', () => {
    const approaches = structuredClone(resultsFixture.approaches);
    approaches[1].equipment.push({ ...approaches[0].equipment[0], evidence: ['E3'] });
    const row = reportedInstruments(approaches)[0];
    expect(row.evidence).toEqual(['E2', 'E3']);
    expect(row.approaches.map((a) => a.rank)).toEqual([1, 2]);
  });

  it('requires structured model fields and explains how to populate older reports', () => {
    expect(Proposal.safeParse(resultsFixture).success).toBe(true);
    const schema = jsonSchemaOf(Proposal) as any;
    expect(schema.properties.approaches.items.required).toEqual(expect.arrayContaining(['synthesis_method', 'equipment']));
    const legacy = resultsFixture.approaches.map(({ equipment, synthesis_method, ...a }) => a);
    expect(reportedInstruments(legacy)).toEqual([]);
    expect(renderToStaticMarkup(createElement(InstrumentResults, { approaches: legacy, citations: () => null }))).toContain('Run a new analysis from Analysis');
  });

  it('keeps bold methods and equipment citations in Markdown exports, including old reports', () => {
    const data: Parameters<typeof toMarkdown>[0] = {
      generator: 'ChemBrain', exportedAt: '2026-10-27T12:00:00Z', notice: 'UI fixture.',
      project: { id: 'fixture', name: 'UI fixture', demonstration: false, brief: { description: 'test material' } },
      coverage: {}, papers: [], evidence: [],
      report: { id: 'fixture', model: 'UI fixture', createdAt: '2026-10-27T12:00:00Z', report: {
        proposal: resultsFixture, papers: { P1: { id: 'p1', title: 'Fixture 1', doi: null, year: null }, P2: { id: 'p2', title: 'Fixture 2', doi: null, year: null } },
        evidence: { E1: 'e1', E2: 'e2', E3: 'e3' }, validation: { removedReferences: 0, unsupportedStatements: [], evidenceUsed: 3, papersUsed: 2 }, model: 'UI fixture', generatedAt: '2026-10-27T12:00:00Z',
      } },
    };
    const md = toMarkdown(data);
    expect(md).toContain('Synthesis method: **Sol-Gel** [^e1]');
    expect(md).toContain('Scanning electron microscope (characterization) [^e2]');
    expect(md).toContain('| **Sol-Gel** |');
    const legacy = structuredClone(data);
    delete (legacy.report!.report!.proposal as any).assessment_evidence;
    for (const a of legacy.report!.report!.proposal.approaches) {
      delete (a as any).equipment;
      delete (a as any).synthesis_method;
      delete (a as any).summary_evidence;
    }
    expect(toMarkdown(legacy)).toContain('**Sol-Gel** is the synthesis method');
  });
});
