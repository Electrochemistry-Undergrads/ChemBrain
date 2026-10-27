import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Badge, Notice, Spinner } from '../components/ui';
import { runSearch, STAGE_TEXT, type SearchStage } from '../lib/search';

interface ProjectRow {
  id: string;
  name: string;
  is_demo: number;
  created_at: string;
  updated_at: string;
  paper_count: number;
  report_count: number;
}

export function Dashboard() {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [description, setDescription] = useState('');
  const [stage, setStage] = useState<SearchStage | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const nav = useNavigate();
  const load = () => api<{ projects: ProjectRow[] }>('/api/projects').then((r) => setProjects(r.projects)).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const search = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    let projectId: string | null = null;
    try {
      projectId = (await api('/api/projects', { body: { description } })).project.id;
      await runSearch(projectId!, setStage);
      nav(`/projects/${projectId}/papers`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
      setStage(null);
      if (projectId) load();
    }
  };
  const demo = async () => {
    setBusy(true);
    try {
      const r = await api('/api/projects/demo', { method: 'POST' });
      nav(`/projects/${r.project.id}/workspace`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  const rename = async (id: string) => {
    if (!renameValue.trim()) return;
    await api(`/api/projects/${id}`, { method: 'PATCH', body: { name: renameValue } }).catch((e) => setError(e.message));
    setRenaming(null);
    load();
  };
  const remove = async (p: ProjectRow) => {
    if (!confirm(`Delete “${p.name}”? Its papers, retrieved documents, evidence and reports will be permanently deleted.`)) return;
    await api(`/api/projects/${p.id}`, { method: 'DELETE' }).catch((e) => setError(e.message));
    load();
  };

  return (
    <section className="page">
      <div className="dash-hero">
        <div>
          <p className="eyebrow">A workspace for chemistry research</p>
          <h1 className="display">
            Chemistry,
            <br />
            <em>connected.</em>
          </h1>
        </div>
        <div>
          <p className="intro">
            Describe the product or material you want to make. ChemBrain finds the research, retrieves the papers you are entitled to read, extracts ingredients, methods and results with Meta’s models, and proposes approaches — with every value traced to the exact passage it came from.
          </p>
          <ol className="steps">
            <li>
              <span className="num">01</span>
              <div>
                <h2>Brief</h2>
                <p>Target properties, constraints, excluded solvents, equipment.</p>
              </div>
            </li>
            <li>
              <span className="num">02</span>
              <div>
                <h2>Evidence</h2>
                <p>Full papers through your own Elsevier, Wiley and Springer Nature access.</p>
              </div>
            </li>
            <li>
              <span className="num">03</span>
              <div>
                <h2>Proposal</h2>
                <p>Ranked approaches, comparisons, gaps and next experiments — all cited.</p>
              </div>
            </li>
          </ol>
        </div>
      </div>
      <h2 className="section-title">Your projects</h2>
      {error && <Notice tone="bad">{error}</Notice>}
      <div className="grid-2">
        <form className="card" onSubmit={search}>
          <label htmlFor="describe" className="card-title">
            Describe your compound or material
          </label>
          <textarea
            id="describe"
            rows={4}
            placeholder="e.g. A biodegradable, water-resistant packaging film made from starch or chitosan, cast from water below 100 °C."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={3000}
            disabled={busy}
          />
          <p className="hint">A sentence or two is enough. ChemBrain works out the search terms, finds papers, and ranks them.</p>
          <div className="row">
            <button className="btn btn-primary" disabled={busy || description.trim().length < 10}>
              {busy ? 'Searching…' : 'Find papers'}
            </button>
            {stage && (
              <span className="small muted" role="status" aria-live="polite">
                <Spinner label="Searching" /> {STAGE_TEXT[stage]}
              </span>
            )}
          </div>
        </form>
        <div className="card card-accent">
          <h2 className="card-title">Demonstration</h2>
          <p className="muted">
            A ready-made project with four real, CC BY 4.0 papers on water-resistant biodegradable films. The papers are bundled copies from Europe PMC — clearly labelled, and not live publisher retrievals.
          </p>
          <button className="btn" onClick={demo} disabled={busy}>
            Open a demonstration project
          </button>
        </div>
      </div>
      {!projects ? (
        <Spinner />
      ) : projects.length === 0 ? (
        <p className="muted empty">No projects yet.</p>
      ) : (
        <ul className="project-list">
          {projects.map((p) => (
            <li key={p.id} className="project-row">
              {renaming === p.id ? (
                <form
                  className="row grow"
                  onSubmit={(e) => {
                    e.preventDefault();
                    rename(p.id);
                  }}
                >
                  <label className="sr-only" htmlFor={`rn-${p.id}`}>
                    New name
                  </label>
                  <input id={`rn-${p.id}`} autoFocus value={renameValue} onChange={(e) => setRenameValue(e.target.value)} maxLength={120} />
                  <button className="btn btn-sm btn-primary">Save</button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRenaming(null)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <Link to={`/projects/${p.id}`} className="project-link grow">
                  <span className="project-name">{p.name}</span>
                  <span className="project-meta">
                    {p.is_demo ? <Badge tone="info">Demonstration</Badge> : null} {p.paper_count} papers · {p.report_count ? `${p.report_count} report${p.report_count > 1 ? 's' : ''}` : 'no report yet'} · updated {new Date(p.updated_at).toLocaleDateString()}
                  </span>
                </Link>
              )}
              {renaming !== p.id && (
                <div className="row">
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      setRenaming(p.id);
                      setRenameValue(p.name);
                    }}
                  >
                    Rename
                  </button>
                  <button className="btn btn-sm btn-ghost danger" onClick={() => remove(p)}>
                    Delete
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
