import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { runSearch, STAGE_TEXT, type SearchStage } from '../../lib/search';
import { Notice, Spinner } from '../../components/ui';
import type { ProjectData } from '../Project';

export function BriefTab({ data, reload }: { data: ProjectData; reload: () => void }) {
  const id = data.project.id;
  const plan = data.project.searchPlan;
  const [description, setDescription] = useState<string>(data.project.brief?.description ?? '');
  const [stage, setStage] = useState<SearchStage | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(null);
  const nav = useNavigate();

  const search = async () => {
    setMsg(null);
    try {
      await api(`/api/projects/${id}`, { method: 'PATCH', body: { brief: { description } } });
      const r = await runSearch(id, setStage);
      reload();
      if (r.sourceErrors?.length) setMsg({ tone: 'warn', text: `Added ${r.added} papers. Some sources failed: ${r.sourceErrors.join('; ')}` });
      else nav(`/projects/${id}/papers`);
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setStage(null);
    }
  };

  return (
    <div className="card form describe">
      <label htmlFor="describe-p" className="card-title">
        Your idea
      </label>
      <textarea
        id="describe-p"
        rows={5}
        placeholder="e.g. A biodegradable film that keeps food dry."
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        maxLength={3000}
        disabled={stage !== null}
      />
      <p className="hint">Add any materials or limits that matter to you.</p>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <div className="row">
        <button className="btn btn-primary" disabled={stage !== null || description.trim().length < 10} onClick={search}>
          {stage ? 'Searching…' : data.project.searchPlan ? 'Search again' : 'Find papers'}
        </button>
        {stage && (
          <span className="small muted" role="status" aria-live="polite">
            <Spinner label="Searching" /> {STAGE_TEXT[stage]}
          </span>
        )}
      </div>
      {plan?.queries?.length > 0 && <SearchedFor plan={plan} />}
    </div>
  );
}

/** Read-only summary of how ChemBrain searched, for transparency. */
export function SearchedFor({ plan }: { plan: any }) {
  return (
    <details className="searched">
      <summary className="small muted">
        Search details
      </summary>
      <p className="small">{plan.queries.map((q: { query: string }) => `“${q.query}”`).join(' · ')}</p>
      {plan.interpretation && <p className="small">{plan.interpretation}</p>}
      {plan.target_properties?.length > 0 && (
        <p className="small muted">
          <strong>Looking for:</strong> {plan.target_properties.join('; ')}
        </p>
      )}
      <p className="hint">{plan.method === 'meta' ? `Planned by ${plan.model ?? 'Meta'}.` : 'Keywords taken from your description.'}</p>
    </details>
  );
}
