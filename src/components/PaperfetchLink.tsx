import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { Badge, Notice } from './ui';

interface LinkState {
  link: { aiPermitted: boolean; createdAt: string; expiresAt: string; lastUsedAt: string | null; expired: boolean } | null;
  received: number;
}

const SETUP_URL = 'https://github.com/Electrochemistry-Undergrads/ChemBrain/tree/main/paperfetch#readme';
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Lets paperfetch on the researcher's own computer send papers into this project. ChemBrain's
 * servers aren't on a campus network; the researcher's computer is.
 */
export function PaperfetchLink({ projectId, missing, onReceived }: { projectId: string; missing: number; onReceived: () => void }) {
  const [state, setState] = useState<LinkState | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [canRead, setCanRead] = useState(false);
  const [ai, setAi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const load = () => api<LinkState>(`/api/projects/${projectId}/link`).then(setState).catch(() => setState({ link: null, received: 0 }));
  useEffect(() => {
    load();
  }, [projectId]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const create = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api<{ code: string }>(`/api/projects/${projectId}/link`, { body: { canRead, aiPermitted: ai } });
      setCode(r.code);
      setCopied(false);
      await load();
    });
  };
  const revoke = () => run(async () => {
    await api(`/api/projects/${projectId}/link`, { method: 'DELETE' });
    setCode(null);
    await load();
  });
  const check = () => run(async () => {
    const before = state?.received ?? 0;
    const next = await api<LinkState>(`/api/projects/${projectId}/link`);
    setState(next);
    onReceived();
    setMsg({ tone: 'good', text: next.received > before ? `${next.received - before} new paper(s) received.` : 'No new papers yet.' });
  });

  const command = code ? `python -m paperfetch push ${window.location.origin} ${code}` : '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const active = state?.link && !state.link.expired;

  return (
    <details className="compact-details add-paper">
      <summary>Send papers from your campus computer{missing ? ` (${missing} without full text)` : ''}</summary>
      <p className="small">
        ChemBrain’s servers aren’t on a university network, so they can’t open subscription papers. <a href={SETUP_URL} target="_blank" rel="noreferrer">paperfetch ↗</a> runs
        on your computer, downloads the papers in this project that your library gives you (on campus or VPN), and sends them here.
        Papers it can’t download, mostly ACS and RSC, are listed for you to save into its <code>inbox</code> folder; run it again to send them.
      </p>
      {state && state.received > 0 && <p className="small">{state.received} paper(s) received from paperfetch so far.</p>}
      {code ? (
        <div className="stack">
          <p className="small">Run this in the paperfetch folder. The code is shown once and works for 7 days, only for uploads to this project.</p>
          <div className="command">
            <code>{command}</code>
            <button type="button" className="btn btn-sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
          <div className="row wrap">
            <button type="button" className="btn btn-sm" disabled={busy} onClick={check}>{busy ? 'Checking…' : 'Check for sent papers'}</button>
            <button type="button" className="btn btn-sm btn-ghost danger" disabled={busy} onClick={revoke}>Revoke code</button>
          </div>
        </div>
      ) : (
        <form className="form" onSubmit={create}>
          {active && (
            <p className="small">
              <Badge tone="good">Code active</Badge> until {when(state!.link!.expiresAt)}
              {state!.link!.lastUsedAt ? ` · last used ${when(state!.link!.lastUsedAt)}` : ' · not used yet'}. A new code replaces it.
            </p>
          )}
          <label className="check">
            <input type="checkbox" checked={canRead} onChange={(e) => setCanRead(e.target.checked)} required />
            <span>I’m entitled to read the papers I send, through my library or institution.</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} />
            <span>My licences allow sending these papers to Meta for analysis. Not needed for openly licensed papers.</span>
          </label>
          <div className="row wrap">
            <button className="btn btn-primary btn-sm" disabled={busy || !canRead}>{busy ? 'Creating…' : active ? 'Create a new code' : 'Create link code'}</button>
            {active && <button type="button" className="btn btn-sm btn-ghost danger" disabled={busy} onClick={revoke}>Revoke code</button>}
          </div>
        </form>
      )}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </details>
  );
}
