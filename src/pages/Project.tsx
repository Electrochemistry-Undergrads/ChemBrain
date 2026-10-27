import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Badge, Notice, Spinner } from '../components/ui';
import { BriefTab } from './project/BriefTab';
import { PapersTab } from './project/PapersTab';
import { WorkspaceTab } from './project/WorkspaceTab';
import { ResultsTab } from './project/ResultsTab';

export interface ProjectData {
  project: { id: string; name: string; isDemo: boolean; brief: { description?: string } | null; searchPlan: any; createdAt: string; updatedAt: string };
  coverage: Record<string, number>;
  latestJob: { id: string; status: string } | null;
  metaConfigured: boolean;
}

export function ProjectPage() {
  const { id = '' } = useParams();
  const [data, setData] = useState<ProjectData | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const reload = useCallback(() => api<ProjectData>(`/api/projects/${id}`).then(setData).catch((e) => setError(e.message)), [id]);
  useEffect(() => {
    reload();
  }, [reload]);
  if (error && !data) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Spinner />;
  const p = data.project;
  const rename = async () => {
    if (name.trim()) await api(`/api/projects/${id}`, { method: 'PATCH', body: { name } });
    setEditing(false);
    reload();
  };
  const tab = (to: string, label: string) => (
    <NavLink to={`/projects/${id}/${to}`} className={({ isActive }) => (isActive ? 'tab active' : 'tab')}>
      {label}
    </NavLink>
  );
  return (
    <section className="page">
      <div className="page-head">
        <div className="grow">
          <p className="eyebrow">Project {p.isDemo && <Badge tone="info">Demonstration · bundled CC BY papers, not live publisher calls</Badge>}</p>
          {editing ? (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                rename();
              }}
            >
              <label className="sr-only" htmlFor="pname">
                Project name
              </label>
              <input id="pname" className="title-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
              <button className="btn btn-sm btn-primary">Save</button>
            </form>
          ) : (
            <h1 className="page-title">
              {p.name}{' '}
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setName(p.name);
                  setEditing(true);
                }}
              >
                Rename
              </button>
            </h1>
          )}
        </div>
      </div>
      {!data.metaConfigured && <Notice tone="warn">Meta analysis is not configured yet. You can search for, retrieve and read papers now (search terms come from your description’s keywords); evidence extraction and proposals will start once it is.</Notice>}
      <nav className="tabs tabs-line" aria-label="Project sections">
        {tab('describe', '1 · Describe')}
        {tab('papers', '2 · Papers')}
        {tab('workspace', '3 · Workspace')}
        {tab('results', '4 · Results')}
      </nav>
      <Routes>
        <Route index element={<Navigate to={p.searchPlan || p.isDemo ? 'papers' : 'describe'} replace />} />
        <Route path="describe" element={<BriefTab data={data} reload={reload} />} />
        <Route path="brief" element={<Navigate to="../describe" replace />} />
        <Route path="papers" element={<PapersTab data={data} reload={reload} />} />
        <Route path="workspace" element={<WorkspaceTab data={data} reload={reload} />} />
        <Route path="results" element={<ResultsTab data={data} />} />
      </Routes>
    </section>
  );
}
