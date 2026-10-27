import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { Badge, Details, Spinner } from '../../components/ui';
import { EvidenceViewer } from '../../components/EvidenceViewer';
import type { Evidence } from './WorkspaceTab';
import type { ProjectData } from '../Project';
import { SynthesisText } from '../../components/SynthesisText';
import { proposalMethods, type StoredProposal } from '../../lib/report';
import { InstrumentResults, instrumentPurpose } from '../../components/InstrumentResults';

interface Report {
  id: string;
  model: string;
  createdAt: string;
  report: {
    proposal: StoredProposal;
    papers: Record<string, { id: string; title: string; doi: string | null; year: number | null }>;
    evidence: Record<string, string>;
    validation: { removedReferences: number; unsupportedStatements: string[]; evidenceUsed: number; papersUsed: number };
    model: string;
    generatedAt: string;
  };
}

function Section({ title, children, note, collapsed = true }: { title: string; children: ReactNode; note?: string; collapsed?: boolean }) {
  if (collapsed) return <Details title={title}>{note && <p className="hint">{note}</p>}{children}</Details>;
  return <section className="card report-section">
    <h2 className="card-title">{title}</h2>
    {note && <p className="hint">{note}</p>}
    {children}
  </section>;
}

function ShortText({ text, names, limit = 300 }: { text: string; names: string[]; limit?: number }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > limit;
  const end = text.lastIndexOf(' ', limit);
  const shown = long && !expanded ? `${text.slice(0, end > limit / 2 ? end : limit)}…` : text;
  return <div className="short-text"><p><SynthesisText text={shown} names={names} /></p>{long && <button className="link" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : 'Read more'}</button>}</div>;
}

export function ResultsTab({ data }: { data: ProjectData }) {
  const id = data.project.id;
  const [rep, setRep] = useState<Report | null | undefined>(undefined);
  const [evidence, setEvidence] = useState<Map<string, Evidence>>(new Map());
  const [view, setView] = useState<{ chunkId: string; quote: string; title?: string; status?: string } | null>(null);
  useEffect(() => {
    api<{ report: Report | null }>(`/api/projects/${id}/report`).then((r) => setRep(r.report));
    api<{ evidence: Evidence[] }>(`/api/projects/${id}/evidence`).then((r) => setEvidence(new Map(r.evidence.map((e) => [e.id, e]))));
  }, [id]);
  if (rep === undefined) return <Spinner />;
  if (!rep?.report)
    return (
      <div className="card">
        <p className="muted">No results yet. <Link to={`/projects/${id}/workspace`}>Start an analysis</Link>.</p>
      </div>
    );
  const r = rep.report;
  const p = r.proposal;
  const methods = proposalMethods(p);
  const Text = ({ children }: { children: string }) => <SynthesisText text={children} names={methods} />;
  // Number references from the saved report so filtering instruments cannot renumber citations.
  const refNum = new Map(Object.keys(r.evidence).map((ref, i) => [ref, i + 1]));
  const Cite = ({ refs }: { refs: string[] }) => (
    <>
      {refs
        .filter((x) => r.evidence[x])
        .map((x) => {
          const evId = r.evidence[x];
          const ev = evidence.get(evId);
          return (
            <button
              key={x}
              className="cite"
              title={ev ? `“${ev.quote.slice(0, 160)}”` : 'Open source passage'}
              onClick={() => ev && setView({ chunkId: ev.chunk_id, quote: ev.quote, title: `${ev.subject}${ev.value_text ? ` — ${ev.value_text}` : ''}`, status: ev.check_status })}
              aria-label={`Open evidence ${refNum.get(x)}`}
            >
              {refNum.get(x)}
            </button>
          );
        })}
    </>
  );
  const P = ({ refs }: { refs: string[] }) => (
    <>
      {refs.map((x) =>
        r.papers[x] ? (
          <span key={x} className="paper-ref" title={r.papers[x].title}>
            {x}
          </span>
        ) : null,
      )}
    </>
  );
  return (
    <div className="report">
      <div className="row between wrap">
        <p className="small muted">
          {r.validation.papersUsed} papers · {new Date(rep.createdAt).toLocaleDateString()}
        </p>
        <details className="download-menu"><summary>Download</summary><div className="row">
          <a className="btn btn-sm" href={`/api/projects/${id}/export.md`}>
            Report (.md)
          </a>
          <a className="btn btn-sm" href={`/api/projects/${id}/export.json`}>
            Data (.json)
          </a>
        </div></details>
      </div>
      <p className="hint">AI suggestions, not experimentally validated. Review before lab use.</p>
      {data.project.isDemo && <p className="hint">Example uses bundled open-access papers.</p>}
      {(r.validation.removedReferences > 0 || r.validation.unsupportedStatements.length > 0) && (
        <details className="compact-details"><summary>Some source claims need review</summary><p className="small">{r.validation.removedReferences} invalid references removed. {r.validation.unsupportedStatements.length} claims removed or flagged.</p></details>
      )}

      <Section title="Overview" collapsed={false}>
        <ShortText text={p.assessment} names={methods} />
      </Section>

      <Section title="Suggested approaches" collapsed={false} note="Click a green number to see the source.">
        {[...p.approaches].sort((a, b) => a.rank - b.rank).map((a) => (
            <article key={a.rank} id={`approach-${a.rank}`} className="approach">
              <h3>
                <span className="rank">{a.rank}</span> <span><Text>{a.name}</Text></span>
              </h3>
              {a.synthesis_method && <p className="synthesis-method"><strong>{a.synthesis_method.name}</strong> <Cite refs={a.synthesis_method.evidence} /></p>}
              <ShortText text={a.summary} names={methods} limit={220} />
              <details className="approach-details"><summary>Ingredients, steps & details</summary><div className="stack">
              <div className="row"><P refs={a.papers} /><Badge tone={a.evidence_strength === 'strong' ? 'good' : a.evidence_strength === 'moderate' ? 'info' : 'warn'}>{a.evidence_strength} support</Badge></div>
              <div className="approach-equipment">
                <h4>Lab equipment</h4>
                {a.equipment?.length ? <ul className="plain small">
                  {a.equipment.map((i, k) => <li key={k}><strong>{i.name}</strong> <Badge>{instrumentPurpose(i.purpose)}</Badge> <Cite refs={i.evidence} /></li>)}
                </ul> : <p className="hint">Equipment not listed{a.equipment === undefined ? '. Run analysis again to add it' : ''}. Check the paper before proceeding.</p>}
              </div>
              <div className="grid-3">
                <div>
                  <h4>Ingredients</h4>
                  <ul className="plain small">
                    {a.ingredients.map((i: any, k: number) => (
                      <li key={k}>
                        <strong>{i.name}</strong>
                        {i.role && ` — ${i.role}`}
                        {i.amount && `: ${i.amount}`} {i.evidence.length ? <Cite refs={i.evidence} /> : <Badge tone="warn">uncited</Badge>}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h4>Steps from the paper</h4>
                  <ol className="small">
                    {a.method.map((m: any, k: number) => (
                      <li key={k}>
                        <Text>{m.step}</Text> {m.evidence.length ? <Cite refs={m.evidence} /> : <Badge tone="warn">uncited</Badge>}
                      </li>
                    ))}
                  </ol>
                </div>
                <div>
                  <h4>Reported results</h4>
                  <ul className="plain small">
                    {a.performance.map((m: any, k: number) => (
                      <li key={k}>
                        {m.property}: <strong>{m.value}</strong> {m.test_conditions && <span className="muted">({m.test_conditions})</span>} <Cite refs={m.evidence} />
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              <p className="small">
                <strong>Why it fits:</strong> <Text>{a.fit_to_brief}</Text>
              </p>
              {a.risks.length > 0 && (
                <p className="small">
                  <strong>Risks:</strong> <Text>{a.risks.join('; ')}</Text>
                </p>
              )}
              </div></details>
            </article>
          ))}
      </Section>

      <InstrumentResults approaches={p.approaches} citations={(refs) => <Cite refs={refs} />} />

      {p.ingredient_comparison.length > 0 && (
        <Section title="Ingredient comparison">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Ingredient</th>
                  <th scope="col">Role</th>
                  <th scope="col">Used in</th>
                </tr>
              </thead>
              <tbody>
                {p.ingredient_comparison.map((row: any, k: number) => (
                  <tr key={k}>
                    <td>{row.ingredient}</td>
                    <td>{row.role ?? '—'}</td>
                    <td>
                      {row.uses.map((u: any, j: number) => (
                        <div key={j}>
                          <P refs={[u.paper]} /> {u.amount ?? 'amount not reported'} <Cite refs={u.evidence} />
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {p.method_comparison.length > 0 && (
        <Section title="Compare methods">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Method</th>
                  <th scope="col">Conditions by paper</th>
                  <th scope="col">Note</th>
                </tr>
              </thead>
              <tbody>
                {p.method_comparison.map((row: any, k: number) => (
                  <tr key={k}>
                    <td><strong>{row.method}</strong></td>
                    <td>
                      {row.uses.map((u: any, j: number) => (
                        <div key={j}>
                          <P refs={[u.paper]} /> {u.conditions ?? 'not reported'} <Cite refs={u.evidence} />
                        </div>
                      ))}
                    </td>
                    <td className="small">{row.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {p.performance_comparison.length > 0 && (
        <Section title="Compare results" note="Only compare values measured under matching conditions.">
          {p.performance_comparison.map((row: any, k: number) => (
            <div key={k} className="perf">
              <h3>
                {row.property} {!row.comparable && <Badge tone="warn">not directly comparable</Badge>}
              </h3>
              <p className="small muted">{row.comparability_note}</p>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Paper</th>
                      <th scope="col">Value</th>
                      <th scope="col">Test conditions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {row.entries.map((e: any, j: number) => (
                      <tr key={j}>
                        <td>
                          <P refs={[e.paper]} />
                        </td>
                        <td>
                          {e.value} <Cite refs={e.evidence} />
                        </td>
                        <td>{e.test_conditions ?? <span className="muted">not reported</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </Section>
      )}

      {p.conflicts.length > 0 && <Section title="Where papers disagree">
          {p.conflicts.length ? (
            <ul className="plain">
              {p.conflicts.map((c: any, k: number) => (
                <li key={k}>
                  <strong>{c.topic}:</strong> <Text>{c.description}</Text> <Cite refs={c.evidence} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">None identified.</p>
          )}
        </Section>}
        {p.missing_evidence.length > 0 && <Section title="What’s missing">
          <ul className="plain">
            {p.missing_evidence.map((m: string, k: number) => (
              <li key={k}><Text>{m}</Text></li>
            ))}
          </ul>
        </Section>}

      {p.adaptations.length > 0 && <Section title="Ideas to explore" note="AI suggestions, not published methods. Testing required.">
        <ul className="plain">
          {p.adaptations.map((a: any, k: number) => (
            <li key={k} className="adaptation">
              <Text>{a.proposal}</Text> <Cite refs={a.basis} />
              <div className="small muted">Caveat: {a.caveat}</div>
            </li>
          ))}
        </ul>
      </Section>}

      {p.next_experiments.length > 0 && <Section title="Next experiments">
        {p.next_experiments.map((x: any, k: number) => (
          <article key={k} className="experiment">
            <h3>{x.title}</h3>
            <p><Text>{x.rationale}</Text></p>
            <p className="small">
              <strong>Design:</strong> <Text>{x.design}</Text>
            </p>
            <p className="small">
              <strong>Measure:</strong> {x.measurements.join('; ')} <Cite refs={x.basis} />
            </p>
          </article>
        ))}
      </Section>}

      {p.not_established.length > 0 && <Section title="Limitations">
        <ul className="plain">
          {p.not_established.map((m: string, k: number) => (
            <li key={k}><Text>{m}</Text></li>
          ))}
        </ul>
      </Section>}

      <Section title="Sources & report details">
        <p className="hint">{rep.model} · {r.validation.evidenceUsed} source notes · {new Date(rep.createdAt).toLocaleString()}</p>
        <ul className="plain">
          {Object.entries(r.papers).map(([ref, paper]) => (
            <li key={ref}>
              <span className="paper-ref">{ref}</span> {paper.title} ({paper.year ?? 'n.d.'}){' '}
              {paper.doi && (
                <a href={`https://doi.org/${paper.doi}`} target="_blank" rel="noreferrer">
                  doi:{paper.doi}
                </a>
              )}
            </li>
          ))}
        </ul>
      </Section>
      <EvidenceViewer projectId={id} target={view} onClose={() => setView(null)} />
    </div>
  );
}
