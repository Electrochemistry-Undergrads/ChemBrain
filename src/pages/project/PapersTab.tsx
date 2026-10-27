import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { ACCESS, AI, ANALYSIS, CONNECTOR_NAME, PARSE, PROVIDER_NAME, RETRIEVAL } from '../../lib/labels';
import { Badge, Details, Drawer, Notice, Spinner, StatusBadge } from '../../components/ui';
import { Coverage } from './Coverage';
import { SearchedFor } from './BriefTab';
import type { ProjectData } from '../Project';
import { BrowserElsevier } from '../../components/BrowserElsevier';
import { browserElsevierState, importBrowserElsevierPaper, subscribeBrowserElsevier } from '../../lib/elsevier-browser';

export interface Paper {
  id: string;
  doi: string | null;
  title: string;
  authors: string | null;
  year: number | null;
  venue: string | null;
  publisher: string | null;
  provider: string | null;
  abstract: string | null;
  landing_url: string | null;
  license: string | null;
  discovered_via: string;
  relevance: number | null;
  relevance_reason: string | null;
  relevance_method: string | null;
  selected: number;
  user_access: string;
  retrieval_status: string;
  retrieval_reason: string | null;
  retrieval_log: { connector: string; status: string; reason: string }[];
  parse_status: string;
  ai_permission: string;
  analysis_status: string;
  document_id: string | null;
  connector: string | null;
  completeness: string | null;
  version_label: string | null;
  page_count: number | null;
  char_count: number | null;
  has_methods: number | null;
  supplementary: { label: string; caption?: string; retrieved: boolean }[];
  parse_notes: string | null;
  evidence_count: number;
}

export function PapersTab({ data, reload }: { data: ProjectData; reload: () => void }) {
  const id = data.project.id;
  const [papers, setPapers] = useState<Paper[] | null>(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(null);
  const [doi, setDoi] = useState('');
  const [upload, setUpload] = useState<Paper | null>(null);
  const browser = useSyncExternalStore(subscribeBrowserElsevier, browserElsevierState);
  const [browserProgress, setBrowserProgress] = useState('');
  const nav = useNavigate();
  const load = () => api<{ papers: Paper[] }>(`/api/projects/${id}/papers`).then((r) => setPapers(r.papers));
  useEffect(() => {
    load();
  }, [id]);

  const act = async (what: string, fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(what);
    setMsg(null);
    try {
      await fn();
      await load();
      reload();
      after?.();
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const toggle = (p: Paper) => act('sel', () => api(`/api/projects/${id}/papers/${p.id}`, { method: 'PATCH', body: { selected: !p.selected } }));
  const canRead = (p: Paper, v: boolean) => act('read', () => api(`/api/projects/${id}/papers/${p.id}`, { method: 'PATCH', body: { canRead: v } }));
  const remove = (p: Paper) => confirm(`Remove “${p.title.slice(0, 80)}” from this project?`) && act('del', () => api(`/api/projects/${id}/papers/${p.id}`, { method: 'DELETE' }));
  const addDoi = (e: FormEvent) => {
    e.preventDefault();
    act('doi', () => api(`/api/projects/${id}/papers`, { body: { doi } }), () => setDoi(''));
  };
  const screen = () => act('screen', () => api(`/api/projects/${id}/screen`, { method: 'POST' }));
  const selectTop = (n: number) => {
    const ids = (papers ?? []).slice(0, n).map((p) => p.id);
    act('sel', () => api(`/api/projects/${id}/papers/select`, { body: { ids, selected: true } }));
  };
  const analyse = () => act('job', () => api(`/api/projects/${id}/jobs`, { method: 'POST' }), () => nav(`/projects/${id}/workspace`));
  const retrieveInBrowser = async () => {
    const targets = (papers ?? []).filter((p) => p.selected && p.provider === 'elsevier' && p.doi && p.retrieval_status !== 'full_text_retrieved');
    setBusy('browser');
    setMsg(null);
    let imported = 0;
    const failures: string[] = [];
    try {
      for (const [index, paper] of targets.entries()) {
        setBrowserProgress(`Retrieving ${index + 1} of ${targets.length}…`);
        try {
          const result = await importBrowserElsevierPaper(id, paper.id, paper.doi!);
          if (result.completeness === 'complete' || result.completeness === 'partial') imported++;
          else failures.push(`${paper.title.slice(0, 65)}: the document was imported but could not be parsed completely.`);
        } catch (error) {
          failures.push(`${paper.title.slice(0, 65)}: ${(error as Error).message}`);
          if (!browserElsevierState().enabled) break;
        }
      }
      await load();
      reload();
      setMsg({ tone: failures.length ? 'warn' : 'good', text: `${imported} Elsevier paper(s) retrieved through your browser and imported. ${failures.join(' ')}${imported ? ' You can now analyse the selected papers.' : ''}` });
    } catch (error) {
      setMsg({ tone: 'bad', text: (error as Error).message });
    } finally { setBusy(null); setBrowserProgress(''); }
  };

  if (!papers) return <Spinner />;
  const shown = papers.filter((p) => !filter || `${p.title} ${p.doi} ${p.venue} ${p.publisher}`.toLowerCase().includes(filter.toLowerCase()));
  const selected = papers.filter((p) => p.selected).length;
  const unscreened = papers.some((p) => p.relevance_method === 'keyword');

  return (
    <div className="stack">
      <div className="toolbar">
        <label className="sr-only" htmlFor="pf">
          Filter papers
        </label>
        <input id="pf" type="search" placeholder="Search papers…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="btn btn-ghost" onClick={() => selectTop(8)} disabled={busy !== null}>
          Select top {Math.min(8, papers.length)}
        </button>
        {browser.enabled && papers.some((p) => p.selected && p.provider === 'elsevier' && p.doi && p.retrieval_status !== 'full_text_retrieved') && (
          <button className="btn" disabled={busy !== null} onClick={retrieveInBrowser}>
            {busy === 'browser' ? browserProgress : 'Download Elsevier papers'}
          </button>
        )}
        <button className="btn btn-primary" onClick={analyse} disabled={busy !== null || !selected}>
          Analyze{selected ? ` (${selected})` : ''}
        </button>
      </div>
      <div className="row between"><p className="hint">{shown.length} papers · {selected} selected</p><span className="hint">Select papers to include in your analysis.</span></div>
      <details className="compact-details add-paper">
        <summary>Add a paper</summary>
        <form className="row" onSubmit={addDoi}>
          <label className="grow" htmlFor="adoi">Paper DOI
            <input id="adoi" placeholder="10.… or https://doi.org/…" value={doi} onChange={(e) => setDoi(e.target.value)} />
          </label>
          <button className="btn" disabled={!doi || busy !== null}>Add</button>
        </form>
      </details>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {papers.length === 0 && <p className="muted empty">No papers yet. Start a search from Idea, or add a paper above.</p>}
      {papers.length > 0 && shown.length === 0 && <p className="muted empty">No matching papers.</p>}
      <ul className="paper-list">
        {shown.map((p) => (
          <PaperRow key={p.id} p={p} onToggle={() => toggle(p)} onCanRead={(v) => canRead(p, v)} onUpload={() => setUpload(p)} onRemove={() => remove(p)} />
        ))}
      </ul>
      <Details title="Search & download details">
        <Coverage c={data.coverage} />
        {data.project.brief?.description && <p className="small">{data.project.brief.description}</p>}
        {data.project.searchPlan?.queries?.length > 0 && <SearchedFor plan={data.project.searchPlan} />}
        {unscreened && <button className="btn" onClick={screen} disabled={busy !== null || !data.metaConfigured}>{busy === 'screen' ? 'Sorting…' : 'Sort matches with AI'}</button>}
        {papers.some((p) => p.provider === 'elsevier') && <BrowserElsevier />}
      </Details>
      <UploadDrawer projectId={id} paper={upload} onClose={() => setUpload(null)} onDone={() => (setUpload(null), load(), reload())} />
    </div>
  );
}

function PaperRow({ p, onToggle, onCanRead, onUpload, onRemove }: { p: Paper; onToggle: () => void; onCanRead: (v: boolean) => void; onUpload: () => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`paper ${p.selected ? 'paper-selected' : ''}`}>
      <div className="paper-main">
        <label className="paper-check">
          <input type="checkbox" checked={Boolean(p.selected)} onChange={onToggle} aria-label={`Select ${p.title}`} />
        </label>
        <div className="grow">
          <div className="paper-title">{p.title}</div>
          <div className="paper-meta">
            {p.year ?? 'Year unknown'} · {p.provider ? PROVIDER_NAME[p.provider] : p.publisher ?? p.venue ?? 'Unknown publisher'}
            {p.doi && (
              <>
                {' '}
                ·{' '}
                <a href={`https://doi.org/${p.doi}`} target="_blank" rel="noreferrer">
                  Open paper ↗
                </a>
              </>
            )}
          </div>
          <div className="badges">
            {p.analysis_status === 'analysis_complete' ? <Badge tone="good">Analyzed</Badge> : p.document_id && p.ai_permission === 'not_confirmed' ? <Badge tone="warn">AI permission needed</Badge> : <StatusBadge map={RETRIEVAL} value={p.retrieval_status} />}
          </div>
        </div>
        <div className="row paper-actions">
        {p.retrieval_status !== 'full_text_retrieved' && <button className="btn btn-sm" onClick={onUpload}>Upload PDF</button>}
        <button className="btn btn-ghost btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Less' : 'Details'}
        </button>
        </div>
      </div>
      {open && (
        <div className="paper-details">
          {p.relevance_reason && <p className="small muted">Match: {p.relevance_reason}</p>}
          <div className="badges"><StatusBadge map={ACCESS} value={p.user_access} /><StatusBadge map={PARSE} value={p.parse_status} />{p.document_id && <StatusBadge map={AI} value={p.ai_permission} />}<StatusBadge map={ANALYSIS} value={p.analysis_status} /></div>
          <p className="abstract">{p.abstract ?? <span className="muted">No abstract available from the discovery sources.</span>}</p>
          {p.retrieval_reason && <p className="small">{p.retrieval_reason}</p>}
          {p.retrieval_log.length > 0 && (
            <div>
              <p className="small muted">Download history</p>
              <ul className="plain small attempts">
                {p.retrieval_log.map((a, i) => (
                  <li key={i}>
                    <Badge tone={a.status === 'full_text' ? 'good' : a.status === 'not_applicable' || a.status === 'not_found' ? 'neutral' : 'warn'}>{a.status.replace(/_/g, ' ')}</Badge> <strong>{CONNECTOR_NAME[a.connector] ?? a.connector}:</strong> {a.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {p.document_id && (
            <p className="small">
              <strong>Document:</strong> {p.version_label} · via {CONNECTOR_NAME[p.connector ?? ''] ?? p.connector} · 
              {p.page_count ? `${p.page_count} pages · ` : ''}
              {p.char_count?.toLocaleString()} characters · {p.has_methods ? 'methods section found' : 'no methods section detected'} · completeness: {p.completeness}
              {p.supplementary.length > 0 && ` · supporting information: ${p.supplementary.length} file(s) listed, not retrieved`}
            </p>
          )}
          <div className="row">
            {p.user_access === 'unknown' || p.user_access === 'not_entitled' ? (
              <button className="btn btn-sm" onClick={() => onCanRead(true)}>
                I can read this paper
              </button>
            ) : p.user_access === 'user_confirmed' ? (
              <button className="btn btn-sm btn-ghost" onClick={() => onCanRead(false)}>
                Undo “I can read this”
              </button>
            ) : null}
            {p.retrieval_status !== 'full_text_retrieved' && (
              <button className="btn btn-sm" onClick={onUpload}>
                Upload PDF or XML
              </button>
            )}
            {p.landing_url && (
              <a className="btn btn-sm btn-ghost" href={p.landing_url} target="_blank" rel="noreferrer">
                Publisher page ↗
              </a>
            )}
            <button className="btn btn-sm btn-ghost danger" onClick={onRemove}>
              Remove
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function UploadDrawer({ projectId, paper, onClose, onDone }: { projectId: string; paper: Paper | null; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [canRead, setCanRead] = useState(false);
  const [ai, setAi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!paper) return null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setErr('');
    const form = new FormData();
    form.set('file', file);
    form.set('canRead', String(canRead));
    form.set('aiPermitted', String(ai));
    try {
      await api(`/api/projects/${projectId}/papers/${paper.id}/upload`, { form });
      onDone();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer open onClose={onClose} title="Upload paper">
      <form className="form" onSubmit={submit}>
        <p>
          <strong>{paper.title}</strong>
        </p>
        <p className="small muted">
          Upload your copy of the full article. The file must match this paper.
        </p>
        <label>
          PDF or XML file (up to 30 MB)
          <input type="file" accept="application/pdf,.pdf,.xml,application/xml,text/xml" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
        </label>
        <label className="check">
          <input type="checkbox" checked={canRead} onChange={(e) => setCanRead(e.target.checked)} required />
          <span>I have permission to read and upload this paper.</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} />
          <span>My licence allows sending this paper to Meta for analysis. Not needed for openly licensed papers.</span>
        </label>
        {err && <Notice tone="bad">{err}</Notice>}
        <button className="btn btn-primary" disabled={busy || !file || !canRead}>
          {busy ? 'Uploading…' : 'Upload'}
        </button>
      </form>
    </Drawer>
  );
}
