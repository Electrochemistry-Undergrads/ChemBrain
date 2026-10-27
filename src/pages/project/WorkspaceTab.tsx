import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { CATEGORY, CHECK } from '../../lib/labels';
import { Badge, Details, Notice, Spinner } from '../../components/ui';
import { EvidenceViewer } from '../../components/EvidenceViewer';
import { Coverage } from './Coverage';
import type { Paper } from './PapersTab';
import type { ProjectData } from '../Project';

interface Progress {
  job: { id: string; status: string; tokensUsed: number; tokenBudget: number; error: string | null } | null;
  tasks?: { kind: string; status: string; n: number }[];
  failures?: { kind: string; paper_id: string | null; error: string | null }[];
  nextRunAt?: number | null;
}

export interface Evidence {
  id: string;
  paper_id: string;
  chunk_id: string;
  category: string;
  subject: string;
  role: string | null;
  value_text: string | null;
  unit: string | null;
  normalized_value: number | null;
  normalized_unit: string | null;
  conversion_note: string | null;
  conditions: string | null;
  quote: string;
  quote_match: string;
  check_status: string;
  check_note: string | null;
  uncertainty: string | null;
  section: string | null;
  label: string | null;
  page_start: number | null;
}

const STAGES: [string, string][] = [
  ['retrieve', 'Download papers'],
  ['extract', 'Read papers'],
  ['check', 'Check sources'],
  ['compare', 'Write results'],
];

export function WorkspaceTab({ data, reload }: { data: ProjectData; reload: () => void }) {
  const id = data.project.id;
  const [progress, setProgress] = useState<Progress | null>(null);
  const [papers, setPapers] = useState<Paper[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [err, setErr] = useState('');
  const [view, setView] = useState<{ chunkId: string; quote: string; title?: string; status?: string } | null>(null);
  const running = useRef(false);

  const refreshAll = async () => {
    const [pr, pp, ev] = await Promise.all([
      api<Progress>(`/api/projects/${id}/jobs/latest`),
      api<{ papers: Paper[] }>(`/api/projects/${id}/papers`),
      api<{ evidence: Evidence[] }>(`/api/projects/${id}/evidence`),
    ]);
    setProgress(pr);
    setPapers(pp.papers.filter((p) => p.selected));
    setEvidence(ev.evidence);
    return pr;
  };

  useEffect(() => {
    let cancelled = false;
    // Drive the job: each step processes one bounded task on the server.
    const loop = async () => {
      if (running.current) return;
      running.current = true;
      try {
        let pr = await refreshAll();
        let n = 0;
        while (!cancelled && pr.job?.status === 'running') {
          if (pr.nextRunAt && pr.nextRunAt > Date.now()) await new Promise((r) => setTimeout(r, Math.min(15000, pr.nextRunAt! - Date.now() + 200)));
          const step = await api<Progress & { ran: string | null }>(`/api/projects/${id}/jobs/${pr.job.id}/step`, { method: 'POST' });
          setProgress(step);
          if (++n % 2 === 0 || step.ran === 'retrieve' || step.ran === 'compare' || step.job?.status !== 'running') pr = await refreshAll();
          else pr = step;
          if (!step.ran && !step.nextRunAt) await new Promise((r) => setTimeout(r, 1500));
        }
        reload();
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        running.current = false;
      }
    };
    loop();
    return () => {
      cancelled = true;
    };
  }, [id, progress?.job?.status === 'running']);

  const control = async (action: 'resume' | 'cancel' | 'start') => {
    setErr('');
    try {
      if (action === 'start') await api(`/api/projects/${id}/jobs`, { method: 'POST' });
      else await api(`/api/projects/${id}/jobs/${progress!.job!.id}/${action}`, { method: 'POST' });
      await refreshAll();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (!progress) return <Spinner />;
  const job = progress.job;
  const count = (kind: string, status?: string) => (progress.tasks ?? []).filter((t) => t.kind === kind && (!status || t.status === status)).reduce((a, t) => a + t.n, 0);
  const paperTitle = (pid: string | null) => papers.find((p) => p.id === pid)?.title ?? '';

  return (
    <div className="stack">
      <div className="card">
        <div className="row between">
          <h2 className="card-title">Analysis</h2>
          {job && <JobBadge status={job.status} />}
        </div>
        {!data.metaConfigured && <Notice tone="warn">AI isn’t set up yet. Analysis will pause until it is.</Notice>}
        {!job ? (
          <div>
            <p className="muted">{papers.length} papers selected.</p>
            <button className="btn btn-primary" onClick={() => control('start')}>
              Start analysis
            </button>
          </div>
        ) : (
          <>
            <ol className="stages">
              {STAGES.map(([k, label]) => {
                const total = count(k);
                const done = count(k, 'done') + count(k, 'failed');
                return (
                  <li key={k} className={total && done === total ? 'stage done' : count(k, 'running') ? 'stage active' : 'stage'}>
                    <span className="stage-label">{label}</span>
                    <span className="stage-bar" aria-hidden="true">
                      <span style={{ width: total ? `${(100 * done) / total}%` : '0%' }} />
                    </span>
                    <span className="stage-count">{total ? `${done}/${total}` : 'Queued'}</span>
                  </li>
                );
              })}
            </ol>
            <p className="small muted" aria-live="polite">
              {progress.nextRunAt ? 'Waiting for the publisher… ' : ''}
              {job.status === 'running' ? 'Keep this tab open while analysis runs.' : ''}
            </p>
            <details className="compact-details"><summary>Usage</summary><p className="small">{job.tokensUsed.toLocaleString()} of {job.tokenBudget.toLocaleString()} AI tokens used.</p></details>
            {job.error && <Notice tone="warn">{job.error}</Notice>}
            {(progress.failures ?? []).length > 0 && (
              <details className="failures">
                <summary>{progress.failures!.length} step(s) failed</summary>
                <ul className="plain small">
                  {progress.failures!.map((f, i) => (
                    <li key={i}>
                      <strong>{f.kind}</strong> {paperTitle(f.paper_id) && `· ${paperTitle(f.paper_id).slice(0, 70)}`}: {f.error}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="row">
              {['paused', 'complete_with_errors', 'failed'].includes(job.status) && (
                <button className="btn btn-primary" onClick={() => control('resume')}>
                  Resume
                </button>
              )}
              {job.status === 'running' && (
                <button className="btn btn-ghost" onClick={() => control('cancel')}>
                  Cancel
                </button>
              )}
              {['complete', 'complete_with_errors', 'cancelled'].includes(job.status) && (
                <button className="btn" onClick={() => control('start')}>
                  Run again
                </button>
              )}
              {['complete', 'complete_with_errors'].includes(job.status) && (
                <Link className="btn btn-primary" to={`/projects/${id}/results`}>
                  View results
                </Link>
              )}
            </div>
          </>
        )}
        {err && <Notice tone="bad">{err}</Notice>}
      </div>

      <Questions projectId={id} disabled={!data.metaConfigured || !evidence.length} onOpen={setView} />
      <Details title={`Selected papers (${papers.length})`}><RetrievedPapers papers={papers} projectId={id} /></Details>
      <Details title="Source data"><EvidenceTable evidence={evidence} papers={papers} onOpen={setView} /></Details>
      <Details title="Paper status"><Coverage c={data.coverage} /></Details>
      <EvidenceViewer projectId={id} target={view} onClose={() => setView(null)} />
    </div>
  );
}

function JobBadge({ status }: { status: string }) {
  const map: Record<string, ['good' | 'warn' | 'bad' | 'info' | 'neutral', string]> = {
    running: ['info', 'Running'],
    paused: ['warn', 'Paused'],
    complete: ['good', 'Complete'],
    complete_with_errors: ['warn', 'Complete with errors'],
    cancelled: ['neutral', 'Cancelled'],
    failed: ['bad', 'Failed'],
  };
  const [tone, label] = map[status] ?? ['neutral', status];
  return <Badge tone={tone}>{label}</Badge>;
}

function RetrievedPapers({ papers, projectId }: { papers: Paper[]; projectId: string }) {
  const [doc, setDoc] = useState<{ title: string; chunks: { id: string; seq: number; section: string; kind: string; label: string | null; page_start: number | null; text: string }[]; document: any } | null>(null);
  const open = async (p: Paper) => {
    const r = await api(`/api/projects/${projectId}/papers/${p.id}/document`);
    setDoc({ title: p.title, chunks: r.chunks, document: r.document });
  };
  return (
    <div className="card">
      <h2 className="card-title">Selected papers</h2>
      <ul className="plain mini-papers">
        {papers.map((p) => (
          <li key={p.id}>
            <div className="small strong">{p.title}</div>
            <div className="small muted">
              {p.evidence_count} source notes
            </div>
            {p.document_id && (
              <button className="btn btn-ghost btn-sm" onClick={() => open(p)}>
                Read paper
              </button>
            )}
          </li>
        ))}
      </ul>
      {doc && (
        <div className="drawer-backdrop" onClick={() => setDoc(null)}>
          <div className="drawer" role="dialog" aria-modal="true" aria-label="Retrieved document" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
                <h2>{doc.title}</h2>
              <button className="btn btn-ghost" onClick={() => setDoc(null)} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="drawer-body">
              <p className="small muted">
                {doc.document.version_label} · completeness: {doc.document.completeness} · {doc.document.parse_notes}
              </p>
              {doc.document.supplementary?.length > 0 && <Notice tone="info">Supporting information listed but not retrieved: {doc.document.supplementary.map((s: any) => s.label).join(', ')}</Notice>}
              {doc.chunks.map((c) => (
                <section key={c.id} className="doc-chunk">
                  <h3 className="small">
                    {c.section} {c.label ? `· ${c.label}` : ''} {c.page_start ? `· p. ${c.page_start}` : ''}
                  </h3>
                  <p className="passage-plain">{c.text}</p>
                </section>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EvidenceTable({ evidence, papers, onOpen }: { evidence: Evidence[]; papers: Paper[]; onOpen: (v: { chunkId: string; quote: string; title?: string; status?: string }) => void }) {
  const [cat, setCat] = useState('');
  const [paper, setPaper] = useState('');
  const [showRejected, setShowRejected] = useState(false);
  const rows = useMemo(
    () => evidence.filter((e) => (!cat || e.category === cat) && (!paper || e.paper_id === paper) && (showRejected || (e.quote_match !== 'not_found' && e.check_status !== 'unsupported'))),
    [evidence, cat, paper, showRejected],
  );
  const rejected = evidence.filter((e) => e.quote_match === 'not_found' || e.check_status === 'unsupported').length;
  return (
    <div className="card">
      <div className="row between">
        <h2 className="card-title">Source notes</h2>
        <span className="small muted">
          {evidence.length - rejected} verified · {rejected} rejected
        </span>
      </div>
      <div className="row wrap">
        <label className="sr-only" htmlFor="evcat">
          Category
        </label>
        <select id="evcat" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">All categories</option>
          {Object.entries(CATEGORY).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="evpaper">
          Paper
        </label>
        <select id="evpaper" value={paper} onChange={(e) => setPaper(e.target.value)}>
          <option value="">All papers</option>
          {papers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title.slice(0, 60)}
            </option>
          ))}
        </select>
        <label className="check inline">
          <input type="checkbox" checked={showRejected} onChange={(e) => setShowRejected(e.target.checked)} /> Show rejected items
        </label>
      </div>
      {!evidence.length ? (
        <p className="muted">Notes appear as papers are analyzed.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Item</th>
                <th scope="col">Value</th>
                <th scope="col">Check</th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 300).map((e) => (
                <tr key={e.id}>
                  <td>{CATEGORY[e.category] ?? e.category}</td>
                  <td>
                    {e.subject}
                    {e.role && <span className="muted"> · {e.role}</span>}
                    {e.conditions && <div className="small muted">{e.conditions}</div>}
                    {e.uncertainty && <div className="small warn-text">{e.uncertainty}</div>}
                  </td>
                  <td>
                    {e.value_text ?? '—'}
                    {e.normalized_value !== null && e.conversion_note && (
                      <div className="small muted" title={e.conversion_note}>
                        = {e.normalized_value} {e.normalized_unit}
                      </div>
                    )}
                  </td>
                  <td>
                    <Badge tone={CHECK[e.check_status]?.[1] ?? 'neutral'} title={e.check_note ?? undefined}>
                      {e.quote_match === 'not_found' ? 'Quote not found' : CHECK[e.check_status]?.[0] ?? e.check_status}
                    </Badge>
                  </td>
                  <td>
                    <button className="link" onClick={() => onOpen({ chunkId: e.chunk_id, quote: e.quote, title: `${CATEGORY[e.category]}: ${e.subject}${e.value_text ? ` — ${e.value_text}` : ''}`, status: e.check_status })}>
                      {[e.section?.split(' › ').pop(), e.label, e.page_start ? `p.${e.page_start}` : null].filter(Boolean).join(' · ') || 'View'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Questions({ projectId, disabled, onOpen }: { projectId: string; disabled: boolean; onOpen: (v: { chunkId: string; quote: string }) => void }) {
  const [list, setList] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    api(`/api/projects/${projectId}/questions`).then((r) => setList(r.questions)).catch(() => {});
  }, [projectId]);
  const ask = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const r = await api(`/api/projects/${projectId}/questions`, { body: { question: q } });
      setList([{ id: Date.now(), question: q, answer: r }, ...list]);
      setQ('');
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <h2 className="card-title">Ask your papers</h2>
      <form className="row" onSubmit={ask}>
        <label className="sr-only" htmlFor="ask">
          Question
        </label>
        <input id="ask" className="grow" value={q} onChange={(e) => setQ(e.target.value)} disabled={disabled} />
        <button className="btn btn-primary" disabled={disabled || busy || q.length < 5}>
          {busy ? 'Reading…' : 'Ask'}
        </button>
      </form>
      {err && <Notice tone="bad">{err}</Notice>}
      {list.map((item) => (
        <div key={item.id} className="qa">
          <p className="strong">{item.question}</p>
          <p>{item.answer?.answer?.answer}</p>
          {item.answer?.answer?.insufficient_evidence && <Badge tone="warn">The sources do not fully answer this</Badge>}
          <ul className="plain small">
            {(item.answer?.citations ?? []).map((c: any, i: number) => (
              <li key={i}>
                <button className="link" onClick={() => onOpen({ chunkId: c.chunkId, quote: c.quote })}>
                  [{i + 1}] {c.paperTitle?.slice(0, 60)}
                </button>{' '}
                “{c.quote.slice(0, 140)}” {c.match === 'not_found' && <Badge tone="bad">quote not found in source</Badge>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
