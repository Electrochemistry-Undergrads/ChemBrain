import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Badge, Details, Notice, Spinner } from '../components/ui';
import { BrowserElsevier } from '../components/BrowserElsevier';

interface Conn {
  provider: 'elsevier' | 'wiley' | 'springer';
  configured: boolean;
  settings: { aiProcessingAttested?: boolean };
  savedFields: string[];
  lastTestAt: string | null;
  lastTest: { ok: boolean; checks: { name: string; status: string; message: string }[] } | null;
  updatedAt: string | null;
}

type ServerConn = Omit<Conn, 'provider'> & { provider: 'wiley' | 'springer' };

const INFO: Record<ServerConn['provider'], { title: string; fields: { key: string; label: string; required: boolean; help: string }[]; about: string[]; docs: string }> = {
  wiley: {
    title: 'Wiley',
    fields: [{ key: 'tdmToken', label: 'Access token', required: true, help: 'Wiley Online Library → Text and Data Mining.' }],
    about: [
      'The Wiley TDM API delivers full-text PDFs, which ChemBrain parses. Supporting information is not included and is reported separately.',
      'Wiley serves subscription articles only to requests from your institution’s network. ChemBrain’s cloud servers are not on it, so subscription Wiley papers show “Institutional connection required”; open-access Wiley papers work. For those papers, upload the PDF you can open.',
      'Wiley allows one request every 10 seconds; ChemBrain paces requests automatically.',
    ],
    docs: 'https://onlinelibrary.wiley.com/library-info/resources/text-and-datamining',
  },
  springer: {
    title: 'Springer Nature',
    fields: [
      { key: 'openAccessApiKey', label: 'Open Access API key', required: true, help: 'Springer Nature → API Management → Open Access API.' },
    ],
    about: [
      'Retrieves open-access Springer Nature articles as JATS XML through the Open Access API.',
      'Paper discovery uses Crossref and Europe PMC. Activate Open Access API access in Springer Nature API Management before testing your key.',
    ],
    docs: 'https://dev.springernature.com/docs/api-endpoints/open-access/',
  },
};

export function ConnectionsPage() {
  const [data, setData] = useState<{ encryptionConfigured: boolean; connections: Conn[] } | null>(null);
  const [meta, setMeta] = useState<{ ok: boolean; model: string; message: string; usedToday: number; dailyBudget: number } | null>(null);
  const [error, setError] = useState('');
  const load = () => api('/api/connections').then(setData).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    api('/api/meta/status').then(setMeta).catch(() => setMeta(null));
  }, []);
  if (!data) return <Spinner />;
  return (
    <section className="page">
      <h1 className="page-title">Connections</h1>
      <p className="muted page-intro">Add a key to access more papers. Open papers work without one.</p>
      {!data.encryptionConfigured && <Notice tone="warn">Saving keys is unavailable on this server.</Notice>}
      {error && <Notice tone="bad">{error}</Notice>}
      <details className="card disclosure ai-status">
        <summary><span>Meta AI</span> <Badge tone={meta?.ok ? 'good' : 'warn'}>{meta?.ok ? 'Ready' : 'Unavailable'}</Badge></summary>
        <div className="disclosure-body">
        {meta ? (
          <p>
            <code>{meta.model}</code> — {meta.message}{' '}
            <span className="muted">
              Used today: {meta.usedToday.toLocaleString()} of {meta.dailyBudget.toLocaleString()} tokens.
            </span>
          </p>
        ) : (
          <Spinner />
        )}
        <p className="hint">AI is set up by the site owner. Paper search works without it.</p>
        </div>
      </details>
      <div className="conn-grid">
        <BrowserElsevier />
        {data.connections.filter((c): c is ServerConn => c.provider !== 'elsevier').map((c) => (
          <ConnectionCard key={c.provider} conn={c} onChange={load} canSave={data.encryptionConfigured} />
        ))}
      </div>
      <Details title="Sources & key privacy">
        <p>Keys saved here are encrypted and never sent to Meta. Elsevier’s key stays in this tab only. Never enter your university password.</p>
        <p>Search uses Crossref and Europe PMC. If a paper cannot be downloaded, upload your copy from Papers.</p>
      </Details>
    </section>
  );
}

function ConnectionCard({ conn, onChange, canSave }: { conn: ServerConn; onChange: () => Promise<void>; canSave: boolean }) {
  const info = INFO[conn.provider];
  const [values, setValues] = useState<Record<string, string>>({});
  const [attest, setAttest] = useState(Boolean(conn.settings.aiProcessingAttested));
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const test = conn.lastTest;
  const hasSecrets = info.fields.some((f) => values[f.key]?.trim());
  const dirty = hasSecrets || (conn.provider === 'wiley' && attest !== Boolean(conn.settings.aiProcessingAttested));
  const checks = test?.checks.filter((c) => conn.provider !== 'springer' || c.name === 'Open Access full text' || c.name === 'API key') ?? [];

  const persist = async () => {
    await api(`/api/connections/${conn.provider}`, {
      method: 'PUT',
      body: { secrets: hasSecrets ? values : undefined, settings: conn.provider === 'springer' ? { aiProcessingAttested: false, fullTextAgreement: false } : { aiProcessingAttested: attest } },
    });
    setValues({});
    await onChange();
  };

  const save = async () => {
    setBusy('save');
    setMsg(null);
    try {
      await persist();
      setMsg({ tone: 'good', text: 'Key saved.' });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const runTest = async () => {
    setBusy('test');
    setMsg(null);
    try {
      if (dirty) await persist();
      await api(`/api/connections/${conn.provider}/test`, { method: 'POST' });
      await onChange();
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    if (!confirm(`Remove your ${info.title} credentials? They will be deleted from the server.`)) return;
    setBusy('remove');
    setMsg(null);
    try {
      await api(`/api/connections/${conn.provider}`, { method: 'DELETE' });
      setValues({});
      setAttest(false);
      await onChange();
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="card conn-card">
      <div className="row between">
        <h2 className="card-title">{info.title}</h2>
        <Badge tone={conn.configured ? 'good' : 'neutral'}>{conn.configured ? 'Saved' : 'Not set'}</Badge>
      </div>
      <p className="small muted">{conn.provider === 'springer' ? 'For open-access Springer papers.' : 'For papers available through Wiley.'}</p>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {info.fields.map((f) => (
          <label key={f.key}>
            {f.label}
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              disabled={busy !== null}
              value={values[f.key] ?? ''}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            />
            <span className="hint">{f.help}</span>
          </label>
        ))}
        {conn.provider === 'wiley' && <label className="check">
          <input type="checkbox" disabled={busy !== null} checked={attest} onChange={(e) => setAttest(e.target.checked)} />
          <span>
            My licence allows sending Wiley subscription papers to Meta for analysis. Not needed for openly licensed papers.
          </span>
        </label>}
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <div className="row">
          <button className="btn btn-primary" disabled={!canSave || busy !== null}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="btn" disabled={(!conn.configured && !hasSecrets) || !canSave || busy !== null} onClick={runTest}>
            {busy === 'test' ? 'Testing…' : 'Test'}
          </button>
          {conn.configured && (
            <button type="button" className="btn btn-ghost danger" disabled={busy !== null} onClick={remove}>
              Remove
            </button>
          )}
        </div>
      </form>
      <details className="compact-details">
        <summary>Setup & access limits</summary>
        <ul className="plain small">{info.about.map((a) => <li key={a}>{a}</li>)}</ul>
        <a className="small" href={info.docs} target="_blank" rel="noreferrer">Get a key ↗</a>
      </details>
      {test && checks.length > 0 && (
        <div className="test-result" aria-live="polite">
          <Badge tone={checks.some((c) => c.status === 'fail') ? 'bad' : checks.some((c) => c.status === 'warn') ? 'warn' : 'good'}>{checks.some((c) => c.status === 'fail') ? 'Connection needs attention' : checks.some((c) => c.status === 'warn') ? 'Connected with limits' : 'Connection working'}</Badge>
          <details className="compact-details"><summary>Test details</summary>
          <p className="hint">{conn.lastTestAt ? new Date(conn.lastTestAt).toLocaleString() : ''}</p>
          <ul className="plain">
            {checks.map((c) => (
              <li key={c.name}>
                <Badge tone={c.status === 'pass' ? 'good' : c.status === 'fail' ? 'bad' : c.status === 'warn' ? 'warn' : 'neutral'}>{c.status}</Badge> <strong>{c.name}:</strong> {c.message}
              </li>
            ))}
          </ul>
          </details>
        </div>
      )}
    </article>
  );
}
