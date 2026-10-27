import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { Badge, Notice, Spinner } from '../../components/ui';
import { EvidenceViewer } from '../../components/EvidenceViewer';
import type { Evidence } from './WorkspaceTab';
import type { ProjectData } from '../Project';

interface Report {
  id: string;
  model: string;
  createdAt: string;
  report: {
    proposal: any;
    papers: Record<string, { id: string; title: string; doi: string | null; year: number | null }>;
    evidence: Record<string, string>;
    validation: { removedReferences: number; unsupportedStatements: string[]; evidenceUsed: number; papersUsed: number };
    model: string;
    generatedAt: string;
  };
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
        <p className="muted">No proposal yet. Run the analysis from the <Link to={`/projects/${id}/workspace`}>Workspace</Link>.</p>
      </div>
    );
  const r = rep.report;
  const p = r.proposal;
  const refNum = new Map<string, number>();
  const Cite = ({ refs }: { refs: string[] }) => (
    <>
      {refs
        .filter((x) => r.evidence[x])
        .map((x) => {
          const evId = r.evidence[x];
          const ev = evidence.get(evId);
          if (!refNum.has(x)) refNum.set(x, refNum.size + 1);
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
  const Section = ({ title, children, note }: { title: string; children: ReactNode; note?: string }) => (
    <section className="card report-section">
      <h2 className="card-title">{title}</h2>
      {note && <p className="hint">{note}</p>}
      {children}
    </section>
  );

  return (
    <div className="report">
      <div className="row between wrap">
        <p className="small muted">
          Generated {new Date(rep.createdAt).toLocaleString()} by {rep.model} from {r.validation.evidenceUsed} verified evidence items across {r.validation.papersUsed} papers.
        </p>
        <div className="row">
          <a className="btn btn-sm" href={`/api/projects/${id}/export.md`}>
            Export Markdown
          </a>
          <a className="btn btn-sm" href={`/api/projects/${id}/export.json`}>
            Export JSON
          </a>
        </div>
      </div>
      <Notice tone="warn">This is an AI-assisted research plan built from the cited passages. It has not been experimentally validated and requires your review before any laboratory work.</Notice>
      {data.project.isDemo && <Notice tone="info">Demonstration: the papers are bundled CC BY 4.0 copies from Europe PMC, not live publisher retrievals. The analysis itself was a live Meta run.</Notice>}
      {(r.validation.removedReferences > 0 || r.validation.unsupportedStatements.length > 0) && (
        <Notice tone="info">
          Citation validation removed {r.validation.removedReferences} reference(s) to unknown evidence{r.validation.unsupportedStatements.length ? ` and dropped or flagged ${r.validation.unsupportedStatements.length} uncited statement(s)` : ''}.
        </Notice>
      )}

      <Section title="Assessment">
        <p className="assessment">{p.assessment}</p>
      </Section>

      <Section title="Ranked approaches" note="Each approach describes what the cited paper(s) did. Numbers in green open the exact supporting passage.">
        {[...p.approaches]
          .sort((a: any, b: any) => a.rank - b.rank)
          .map((a: any) => (
            <article key={a.rank} className="approach">
              <h3>
                <span className="rank">{a.rank}</span> {a.name} <P refs={a.papers} /> <Badge tone={a.evidence_strength === 'strong' ? 'good' : a.evidence_strength === 'moderate' ? 'info' : 'warn'}>{a.evidence_strength} evidence</Badge>
              </h3>
              <p>{a.summary}</p>
              <div className="grid-3">
                <div>
                  <h4>Ingredients (published)</h4>
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
                  <h4>Method (published)</h4>
                  <ol className="small">
                    {a.method.map((m: any, k: number) => (
                      <li key={k}>
                        {m.step} {m.evidence.length ? <Cite refs={m.evidence} /> : <Badge tone="warn">uncited</Badge>}
                      </li>
                    ))}
                  </ol>
                </div>
                <div>
                  <h4>Reported performance</h4>
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
                <strong>Fit to brief:</strong> {a.fit_to_brief}
              </p>
              {a.risks.length > 0 && (
                <p className="small">
                  <strong>Risks:</strong> {a.risks.join('; ')}
                </p>
              )}
            </article>
          ))}
      </Section>

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
        <Section title="Experimental-method comparison">
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
                    <td>{row.method}</td>
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
        <Section title="Reported performance and test conditions" note="Values are shown as reported. Comparisons across papers are only meaningful when test conditions match.">
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

      <div className="grid-2">
        <Section title="Conflicting findings">
          {p.conflicts.length ? (
            <ul className="plain">
              {p.conflicts.map((c: any, k: number) => (
                <li key={k}>
                  <strong>{c.topic}:</strong> {c.description} <Cite refs={c.evidence} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">None identified.</p>
          )}
        </Section>
        <Section title="Missing evidence">
          <ul className="plain">
            {p.missing_evidence.map((m: string, k: number) => (
              <li key={k}>{m}</li>
            ))}
          </ul>
        </Section>
      </div>

      <Section title="ChemBrain’s proposed adaptations" note="These are ChemBrain’s suggestions, not published methods. Each builds on the cited evidence and needs experimental testing.">
        <ul className="plain">
          {p.adaptations.map((a: any, k: number) => (
            <li key={k} className="adaptation">
              <Badge tone="info">Proposed, not published</Badge> {a.proposal} <Cite refs={a.basis} />
              <div className="small muted">Caveat: {a.caveat}</div>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Proposed next experiments">
        {p.next_experiments.map((x: any, k: number) => (
          <article key={k} className="experiment">
            <h3>{x.title}</h3>
            <p>{x.rationale}</p>
            <p className="small">
              <strong>Design:</strong> {x.design}
            </p>
            <p className="small">
              <strong>Measure:</strong> {x.measurements.join('; ')} <Cite refs={x.basis} />
            </p>
          </article>
        ))}
      </Section>

      <Section title="What the sources do not establish">
        <ul className="plain">
          {p.not_established.map((m: string, k: number) => (
            <li key={k}>{m}</li>
          ))}
        </ul>
      </Section>

      <Section title="Papers">
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
