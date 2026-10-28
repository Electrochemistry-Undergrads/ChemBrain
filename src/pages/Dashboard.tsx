import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Badge, Notice, Spinner } from '../components/ui';
import { runSearch, STAGE_TEXT, type SearchStage } from '../lib/search';
import { MaterialInput } from '../components/MaterialInput';

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
      nav(`/projects/${r.project.id}/papers`);
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
    <section className="page home">
      <div className="home-heading">
        <p className="workspace-label">Chemistry research workspace</p>
        <h1 className="page-title">What do you want<br /><span className="outline-type">to make?</span></h1>
        <p className="muted">Find papers. Explore ways to make it.</p>
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      <div className="glow-field" data-busy={busy || undefined}>
        <form className="card new-project" onSubmit={search}>
          <label htmlFor="describe" className="sr-only">
            Your idea
          </label>
          <MaterialInput
            id="describe"
            rows={3}
            value={description}
            onChange={setDescription}
            disabled={busy}
          />
          <div className="row between search-actions">
            <button className="btn btn-primary" disabled={busy || description.trim().length < 10}>
              {busy ? 'Searching…' : 'Find papers'}
            </button>
            {!busy && <button className="btn btn-ghost" type="button" onClick={demo}>Try an example</button>}
            {stage && (
              <span className="small muted" role="status" aria-live="polite">
                <Spinner label="Searching" /> {STAGE_TEXT[stage]}
              </span>
            )}
          </div>
        </form>
      </div>
      <div className="project-heading"><h2 className="section-title">Your projects</h2><span className="small muted">{projects ? String(projects.length).padStart(2, '0') : '—'}</span></div>
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
                  <span className="project-name">{p.is_demo ? p.name.replace(/^Demonstration · /, '') : p.name}</span>
                  <span className="project-meta">
                    {p.is_demo ? <Badge tone="info">Example</Badge> : null} {p.paper_count} papers {p.report_count > 0 ? '· Results ready' : ''}
                  </span>
                </Link>
              )}
              {renaming !== p.id && (
                <details className="project-actions">
                  <summary aria-label={`Options for ${p.name}`}>•••</summary>
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
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
