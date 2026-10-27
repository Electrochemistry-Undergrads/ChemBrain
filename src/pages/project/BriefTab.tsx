import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { Notice } from '../../components/ui';
import type { ProjectData } from '../Project';

const FIELDS: { key: string; label: string; placeholder: string; required?: boolean; rows?: number }[] = [
  { key: 'product', label: 'Desired product or material', placeholder: 'A biodegradable, water-resistant packaging film', required: true, rows: 2 },
  { key: 'targetProperties', label: 'Target properties', placeholder: 'Water vapour permeability below …, tensile strength above …, transparency', rows: 3 },
  { key: 'intendedUse', label: 'Intended use', placeholder: 'Packaging for dry foods' },
  { key: 'excluded', label: 'Excluded ingredients or solvents', placeholder: 'No chloroform, DMF or fluorinated additives' },
  { key: 'equipment', label: 'Available equipment', placeholder: 'Solution casting, drying oven, tensile tester, DSC' },
  { key: 'constraints', label: 'Temperature, processing or environmental constraints', placeholder: 'Below 100 °C; aqueous processing; home-compostable' },
  { key: 'costPreference', label: 'Cost preference (optional)', placeholder: 'Low-cost, food-grade' },
  { key: 'sustainabilityPreference', label: 'Sustainability preference (optional)', placeholder: 'Bio-based feedstocks' },
];

export function BriefTab({ data, reload }: { data: ProjectData; reload: () => void }) {
  const id = data.project.id;
  const [brief, setBrief] = useState<Record<string, string>>(data.project.brief ?? {});
  const [plan, setPlan] = useState<any>(data.project.searchPlan);
  const [queries, setQueries] = useState<string>((data.project.searchPlan?.queries ?? []).map((q: any) => q.query).join('\n'));
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(null);
  const nav = useNavigate();

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const save = () => api(`/api/projects/${id}`, { method: 'PATCH', body: { brief } });
  const planWithMeta = () =>
    run('plan', async () => {
      await save();
      const r = await api(`/api/projects/${id}/plan`, { method: 'POST' });
      setPlan(r.plan);
      setQueries(r.plan.queries.map((q: any) => q.query).join('\n'));
      reload();
    });
  const discover = () =>
    run('discover', async () => {
      await save();
      await api(`/api/projects/${id}/plan`, { method: 'PUT', body: { queries: queries.split('\n') } });
      const r = await api(`/api/projects/${id}/discover`, { method: 'POST' });
      reload();
      if (r.sourceErrors?.length) setMsg({ tone: 'warn', text: `Added ${r.added} papers. Some sources failed: ${r.sourceErrors.join('; ')}` });
      else nav(`/projects/${id}/papers`);
    });

  return (
    <div className="grid-2 wide-left">
      <form
        className="card form"
        onSubmit={(e) => {
          e.preventDefault();
          run('save', async () => {
            await save();
            setMsg({ tone: 'good', text: 'Brief saved.' });
            reload();
          });
        }}
      >
        <h2 className="card-title">Product brief</h2>
        {FIELDS.map((f) => (
          <label key={f.key}>
            {f.label}
            {f.rows ? (
              <textarea rows={f.rows} required={f.required} placeholder={f.placeholder} value={brief[f.key] ?? ''} onChange={(e) => setBrief({ ...brief, [f.key]: e.target.value })} />
            ) : (
              <input required={f.required} placeholder={f.placeholder} value={brief[f.key] ?? ''} onChange={(e) => setBrief({ ...brief, [f.key]: e.target.value })} />
            )}
          </label>
        ))}
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <div className="row">
          <button className="btn" disabled={busy !== null}>
            {busy === 'save' ? 'Saving…' : 'Save brief'}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy !== null || !brief.product} onClick={planWithMeta}>
            {busy === 'plan' ? 'Planning with Meta…' : 'Plan search with Meta'}
          </button>
        </div>
      </form>
      <div className="card form">
        <h2 className="card-title">Search plan</h2>
        {plan?.interpretation && (
          <>
            <p>{plan.interpretation}</p>
            {plan.target_properties?.length > 0 && (
              <p className="small muted">
                <strong>Target properties:</strong> {plan.target_properties.join('; ')}
              </p>
            )}
            {plan.model && <p className="hint">Planned by {plan.model}. Edit the queries freely.</p>}
          </>
        )}
        <label>
          Search queries (one per line)
          <textarea rows={8} value={queries} onChange={(e) => setQueries(e.target.value)} placeholder="starch film water vapor permeability&#10;chitosan film hydrophobic coating" />
        </label>
        <p className="hint">Each query searches Crossref, Europe PMC, and Springer Nature (if connected). Duplicates are merged by DOI and title.</p>
        <button className="btn btn-primary" disabled={busy !== null || !queries.trim()} onClick={discover}>
          {busy === 'discover' ? 'Searching…' : 'Find papers'}
        </button>
      </div>
    </div>
  );
}
