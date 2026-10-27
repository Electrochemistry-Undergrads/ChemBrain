import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Badge, Notice, Spinner } from '../components/ui';
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
    title: 'Wiley · Wiley-VCH',
    fields: [{ key: 'tdmToken', label: 'TDM client token', required: true, help: 'Sign in to Wiley Online Library, open Text and Data Mining, accept the licence, and copy your token.' }],
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
      { key: 'openAccessApiKey', label: 'Open Access API key', required: true, help: 'From dev.springernature.com → API Management. Copy the credential for the Open Access API to retrieve open-access full text.' },
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
      <p className="eyebrow">Your access</p>
      <h1 className="page-title">Publisher connections</h1>
      <p className="lede">
        ChemBrain uses <strong>your own</strong> publisher access. Server credentials are encrypted and never shown again after saving. The browser mode below keeps its key only in this tab. Keys are never sent to the AI model. Never enter your university password here.
      </p>
      {!data.encryptionConfigured && <Notice tone="bad">Credential storage is not configured on this server, so credentials cannot be saved yet.</Notice>}
      {error && <Notice tone="bad">{error}</Notice>}
      <div className="card">
        <h2 className="card-title">Meta analysis</h2>
        {meta ? (
          <p>
            <Badge tone={meta.ok ? 'good' : 'warn'}>{meta.ok ? 'Available' : 'Unavailable'}</Badge> Model <code>{meta.model}</code> — {meta.message}{' '}
            <span className="muted">
              Used today: {meta.usedToday.toLocaleString()} of {meta.dailyBudget.toLocaleString()} tokens.
            </span>
          </p>
        ) : (
          <Spinner />
        )}
        <p className="hint">Meta is configured by the ChemBrain operator; you don’t need your own key.</p>
      </div>
      <BrowserElsevier />
      <div className="conn-grid">
        {data.connections.filter((c): c is ServerConn => c.provider !== 'elsevier').map((c) => (
          <ConnectionCard key={c.provider} conn={c} onChange={load} canSave={data.encryptionConfigured} />
        ))}
      </div>
      <div className="card">
        <h2 className="card-title">Other sources</h2>
        <p className="muted">
          Crossref and Europe PMC are used without credentials: Crossref for discovery and metadata (never counted as full text), Europe PMC for open-access full text. For papers no connector can reach — including ACS and RSC, which offer no text-mining API to ChemBrain — upload the PDF you can open from the Papers tab.
        </p>
      </div>
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
      setMsg({ tone: 'good', text: 'Saved. Run a connection test to check access.' });
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
        <Badge tone={conn.configured ? 'good' : 'neutral'}>{conn.configured ? 'Saved' : 'Not connected'}</Badge>
      </div>
      <ul className="plain small">
        {info.about.map((a) => (
          <li key={a}>{a}</li>
        ))}
      </ul>
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
              placeholder={conn.savedFields.includes(f.key) || (conn.provider === 'springer' && conn.savedFields.includes('apiKey')) ? 'Saved — enter a new value to replace' : ''}
              value={values[f.key] ?? ''}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            />
            <span className="hint">{f.help}</span>
          </label>
        ))}
        {conn.provider === 'wiley' && <label className="check">
          <input type="checkbox" disabled={busy !== null} checked={attest} onChange={(e) => setAttest(e.target.checked)} />
          <span>
            My institution’s licence with {info.title.split(' ·')[0]} permits sending subscription article text to an external AI service (Meta) for my research analysis. ChemBrain cannot infer this from subscription access; open-licence papers are analysed regardless.
          </span>
        </label>}
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <div className="row">
          <button className="btn btn-primary" disabled={!canSave || busy !== null}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="btn" disabled={(!conn.configured && !hasSecrets) || !canSave || busy !== null} onClick={runTest}>
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
          {conn.configured && (
            <button type="button" className="btn btn-ghost danger" disabled={busy !== null} onClick={remove}>
              Remove
            </button>
          )}
          <a className="small" href={info.docs} target="_blank" rel="noreferrer">
            Publisher documentation ↗
          </a>
        </div>
      </form>
      {test && checks.length > 0 && (
        <div className="test-result" aria-live="polite">
          <p className="small muted">Live test{conn.lastTestAt ? ` · ${new Date(conn.lastTestAt).toLocaleString()}` : ''}</p>
          <ul className="plain">
            {checks.map((c) => (
              <li key={c.name}>
                <Badge tone={c.status === 'pass' ? 'good' : c.status === 'fail' ? 'bad' : c.status === 'warn' ? 'warn' : 'neutral'}>{c.status}</Badge> <strong>{c.name}:</strong> {c.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}
