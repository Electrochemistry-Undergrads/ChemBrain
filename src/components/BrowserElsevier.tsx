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
    setMessage({ tone: 'good', text: 'Enabled for this tab. In Papers, select Elsevier articles and click Retrieve Elsevier using this browser before starting analysis.' });
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
      setMessage({ tone: 'good', text: 'Browser connection passed: Elsevier returned full-text XML directly to this browser. You can now retrieve selected Elsevier papers in the Papers tab.' });
    } catch (error) {
      setMessage({ tone: 'bad', text: (error as Error).message });
    } finally { setBusy(false); }
  };
  return (
    <div className="card">
      <div className="row between">
        <h2 className="card-title">Elsevier from this browser</h2>
        <Badge tone={browser.enabled ? 'good' : 'neutral'}>{browser.enabled ? 'Enabled for this tab' : 'Off'}</Badge>
      </div>
      <p className="small">Use your computer’s network when the server connection fails. Your browser requests articles directly from Elsevier, then sends the XML to ChemBrain for identity checks, parsing, and analysis. Use your campus network or an institution-supported VPN when needed.</p>
      <form className="form" onSubmit={submit}>
        <label>
          Elsevier API key for this browser
          <input type="password" autoComplete="off" spellCheck={false} value={key} disabled={busy} onChange={(e) => setKey(e.target.value)} placeholder={browser.enabled ? 'Enabled — enter a key to replace' : ''} />
          <span className="hint">Kept only in this tab’s memory; re-enter after refreshing or closing the tab. Saved server credentials are never read back. Do not enter an institutional token here.</span>
        </label>
        <p className="hint">In Elsevier’s key settings, add <code>{window.location.origin}</code> to CORS Domains, with no trailing slash.</p>
        <label className="check">
          <input type="checkbox" checked={attest} disabled={busy} onChange={(e) => { setAttest(e.target.checked); attestBrowserElsevier(e.target.checked); }} />
          <span>My licence permits sending Elsevier subscription article text to Meta for analysis. Open-licence papers do not need this confirmation.</span>
        </label>
        {message && <Notice tone={message.tone}>{message.text}</Notice>}
        <div className="row wrap">
          <button className="btn btn-primary" disabled={busy || !key.trim()}>Use this browser</button>
          <button type="button" className="btn" disabled={busy || (!key.trim() && !browser.enabled)} onClick={test}>{busy ? 'Testing browser…' : 'Test browser connection'}</button>
          {browser.enabled && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { forgetBrowserElsevier(); setKey(''); setAttest(false); setMessage(null); }}>Forget browser key</button>}
        </div>
      </form>
    </div>
  );
}
