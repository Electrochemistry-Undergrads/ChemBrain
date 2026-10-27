import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Badge, Notice, Spinner } from '../components/ui';

interface Conn {
  provider: 'elsevier' | 'wiley' | 'springer';
  configured: boolean;
  settings: { aiProcessingAttested?: boolean; fullTextAgreement?: boolean };
  savedFields: string[];
  lastTestAt: string | null;
  lastTest: { ok: boolean; checks: { name: string; status: string; message: string }[] } | null;
  updatedAt: string | null;
}

const INFO: Record<Conn['provider'], { title: string; fields: { key: string; label: string; required: boolean; help: string }[]; about: string[]; docs: string }> = {
  elsevier: {
    title: 'Elsevier · ScienceDirect',
    fields: [
      { key: 'apiKey', label: 'API key', required: true, help: 'From dev.elsevier.com → My API Key. It identifies the application; on its own it does not grant article access.' },
      { key: 'instToken', label: 'Institutional token (optional)', required: false, help: 'Issued by your library or Elsevier to your institution. It lets subscription entitlement work from outside the campus network.' },
    ],
    about: [
      'ChemBrain retrieves structured full-text XML through the Article Retrieval API after checking entitlement.',
      'Elsevier grants subscription access by campus IP address or an institutional token. ChemBrain runs in the cloud, so your campus IP access does not carry over. Without a token, only open-access articles are retrievable.',
    ],
    docs: 'https://dev.elsevier.com/tecdoc_api_authentication.html',
  },
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
    fields: [{ key: 'apiKey', label: 'API key', required: true, help: 'From dev.springernature.com. Used for the Meta (discovery) and Open Access APIs.' }],
    about: [
      'Discovery uses the Meta API; open-access full text comes from the Open Access API as JATS XML.',
      'Subscription articles (for example most Nature-branded journals) need the separate Full Text API under an approved text-and-data-mining agreement. A free or open-access key does not unlock them.',
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
        ChemBrain uses <strong>your own</strong> publisher access. Credentials are encrypted on the server, used only for your requests, never shown again after saving, and never sent to the AI model. You can remove them at any time. Never enter your university password here.
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
      <div className="conn-grid">
        {data.connections.map((c) => (
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

function ConnectionCard({ conn, onChange, canSave }: { conn: Conn; onChange: () => void; canSave: boolean }) {
  const info = INFO[conn.provider];
  const [values, setValues] = useState<Record<string, string>>({});
  const [attest, setAttest] = useState(Boolean(conn.settings.aiProcessingAttested));
  const [agreement, setAgreement] = useState(Boolean(conn.settings.fullTextAgreement));
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [test, setTest] = useState(conn.lastTest);

  const save = async () => {
    setBusy('save');
    setMsg(null);
    try {
      const hasSecrets = info.fields.some((f) => values[f.key]?.trim());
      await api(`/api/connections/${conn.provider}`, {
        method: 'PUT',
        body: { secrets: hasSecrets ? values : undefined, settings: { aiProcessingAttested: attest, fullTextAgreement: agreement } },
      });
      setValues({});
      setMsg({ tone: 'good', text: 'Saved. Run a connection test to check access.' });
      onChange();
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const runTest = async () => {
    setBusy('test');
    try {
      setTest(await api(`/api/connections/${conn.provider}/test`, { method: 'POST' }));
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    if (!confirm(`Remove your ${info.title} credentials? They will be deleted from the server.`)) return;
    await api(`/api/connections/${conn.provider}`, { method: 'DELETE' });
    setTest(null);
    onChange();
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
              placeholder={conn.savedFields.includes(f.key) ? 'Saved — enter a new value to replace' : ''}
              value={values[f.key] ?? ''}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            />
            <span className="hint">{f.help}</span>
          </label>
        ))}
        {conn.provider === 'springer' && (
          <label className="check">
            <input type="checkbox" checked={agreement} onChange={(e) => setAgreement(e.target.checked)} />
            <span>I hold an approved Springer Nature full-text (TDM) agreement for this key. Leave unchecked if you only have a free or open-access key.</span>
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} />
          <span>
            My institution’s licence with {info.title.split(' ·')[0]} permits sending subscription article text to an external AI service (Meta) for my research analysis. ChemBrain cannot infer this from subscription access; open-licence papers are analysed regardless.
          </span>
        </label>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <div className="row">
          <button className="btn btn-primary" disabled={!canSave || busy !== null}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="btn" disabled={!conn.configured || busy !== null} onClick={runTest}>
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
          {conn.configured && (
            <button type="button" className="btn btn-ghost danger" onClick={remove}>
              Remove
            </button>
          )}
          <a className="small" href={info.docs} target="_blank" rel="noreferrer">
            Publisher documentation ↗
          </a>
        </div>
      </form>
      {test && (
        <div className="test-result" aria-live="polite">
          <p className="small muted">Live test{conn.lastTestAt ? ` · ${new Date(conn.lastTestAt).toLocaleString()}` : ''}</p>
          <ul className="plain">
            {test.checks.map((c) => (
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
