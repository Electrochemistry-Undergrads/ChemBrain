import { useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../App';
import { Details, Notice } from '../components/ui';

export function AccountPage() {
  const { user, refresh } = useSession();
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState('');
  const del = async () => {
    try {
      await api('/api/account', { method: 'DELETE', body: { confirm: confirmText } });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="page narrow">
      <h1 className="page-title">Settings</h1>
      {user?.guest && (
        <div className="card">
          <p>
            This workspace belongs to this browser. Clearing site cookies will lose access to it.
          </p>
        </div>
      )}
      <Details title="Privacy & storage">
        <ul className="plain">
          <li>Retrieved papers are stored as parsed text, private to your account, and are never shared with other users or used to train models.</li>
          <li>Original files are not kept after parsing unless the server is configured to retain them in private storage.</li>
          <li>Deleting a project deletes its papers, documents, evidence, and reports. Removing a publisher connection deletes the stored credential.</li>
          <li>Analysis uses Meta’s standard API mode, in which Meta states that content is not used to train its models.</li>
        </ul>
      </Details>
      <Details title="Delete workspace" className="danger-zone">
        <p className="muted">Permanently deletes all projects, papers, results and saved keys.</p>
        <label>
          Type <code>{user?.username}</code> to confirm
          <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
        </label>
        {error && <Notice tone="bad">{error}</Notice>}
        <button className="btn danger-btn" disabled={confirmText !== user?.username} onClick={del}>
          Delete everything
        </button>
      </Details>
    </section>
  );
}
