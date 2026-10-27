import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { attestBrowserElsevier, browserElsevierState, configureBrowserElsevier, forgetBrowserElsevier, retrieveElsevierInBrowser, subscribeBrowserElsevier } from '../lib/elsevier-browser';
import { Badge, Notice } from './ui';

export function BrowserElsevier() {
  const browser = useSyncExternalStore(subscribeBrowserElsevier, browserElsevierState);
  const [key, setKey] = useState('');
  const [attest, setAttest] = useState(browser.aiProcessingAttested);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  useEffect(() => { setAttest(browser.aiProcessingAttested); }, [browser.aiProcessingAttested]);
  const activate = () => {
    configureBrowserElsevier(key, attest);
    setKey('');
    setMessage({ tone: 'good', text: 'Connected for this tab. Download Elsevier papers from Papers.' });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    try { activate(); } catch (error) { setMessage({ tone: 'bad', text: (error as Error).message }); }
  };
  const test = async () => {
    setBusy(true);
    setMessage(null);
    try {
      if (key.trim()) { configureBrowserElsevier(key, attest); setKey(''); }
      await retrieveElsevierInBrowser('10.1016/j.heliyon.2024.e36608');
      setMessage({ tone: 'good', text: 'Connection working.' });
    } catch (error) {
      setMessage({ tone: 'bad', text: (error as Error).message });
    } finally { setBusy(false); }
  };
  return (
    <div className="card">
      <div className="row between">
        <h2 className="card-title">Elsevier</h2>
        <Badge tone={browser.enabled ? 'good' : 'neutral'}>{browser.enabled ? 'Connected' : 'Not set'}</Badge>
      </div>
      <p className="small muted">Uses this browser. Campus access may be needed.</p>
      <form className="form" onSubmit={submit}>
        <label>
          API key
          <input type="password" autoComplete="off" spellCheck={false} value={key} disabled={busy} onChange={(e) => setKey(e.target.value)} />
          <span className="hint">For this tab only. Re-enter after a reload.</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={attest} disabled={busy} onChange={(e) => { setAttest(e.target.checked); attestBrowserElsevier(e.target.checked); }} />
          <span>My licence allows sending Elsevier subscription papers to Meta for analysis. Not needed for openly licensed papers.</span>
        </label>
        {message && <Notice tone={message.tone}>{message.text}</Notice>}
        <div className="row wrap">
          <button className="btn btn-primary" disabled={busy || !key.trim()}>Connect</button>
          <button type="button" className="btn" disabled={busy || (!key.trim() && !browser.enabled)} onClick={test}>{busy ? 'Testing…' : 'Test'}</button>
          {browser.enabled && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { forgetBrowserElsevier(); setKey(''); setAttest(false); setMessage(null); }}>Disconnect</button>}
        </div>
      </form>
      <details className="compact-details">
        <summary>Setup & access limits</summary>
        <p className="small">In Elsevier’s key settings, add <code>{window.location.origin}</code> to CORS Domains without a trailing slash.</p>
        <p className="small">Articles download through your browser and are sent to ChemBrain for analysis. Use your campus network or university VPN for subscription access.</p>
        <a className="small" href="https://dev.elsevier.com/" target="_blank" rel="noreferrer">Get a key ↗</a>
      </details>
    </div>
  );
}
