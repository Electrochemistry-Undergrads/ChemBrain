import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes } from 'react-router-dom';
import { api } from './lib/api';
import { Notice, Spinner } from './components/ui';
import { Dashboard } from './pages/Dashboard';
import { ProjectPage } from './pages/Project';
import { ConnectionsPage } from './pages/Connections';
import { AccountPage } from './pages/Account';
import { forgetBrowserElsevier } from './lib/elsevier-browser';

interface Session {
  user: { username: string; guest: boolean } | null;
  refresh: () => Promise<void>;
}
const SessionCtx = createContext<Session>({ user: null, refresh: async () => {} });
export const useSession = () => useContext(SessionCtx);

export function App() {
  const [state, setState] = useState<{ user: Session['user'] } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { forgetBrowserElsevier(); }, [state?.user?.username]);
  // No sign-in page: each browser gets its own private workspace (a server-side guest account).
  const refresh = useCallback(async () => {
    try {
      const me = await api<{ user: Session['user'] }>('/api/auth/me');
      if (me.user) return setState(me);
      const g = await api<{ user: Session['user'] }>('/api/auth/guest', { method: 'POST' });
      setState({ user: g.user });
    } catch (e) {
      setError((e as Error).message);
      setState({ user: null });
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  if (!state) {
    return (
      <div className="center-page">
        <Spinner />
      </div>
    );
  }
  return (
    <SessionCtx.Provider value={{ ...state, refresh }}>
      <a href="#main" className="skip">
        Skip to content
      </a>
      <div className="shell">
        <Header />
        <main id="main">
          {state.user ? (
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/projects/:id/*" element={<ProjectPage />} />
              <Route path="/connections" element={<ConnectionsPage />} />
              <Route path="/account" element={<AccountPage />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          ) : (
            <section className="page narrow">
              <Notice tone="bad">ChemBrain could not open your workspace{error ? `: ${error}` : '.'} Please reload the page.</Notice>
            </section>
          )}
        </main>
        <footer className="footer">
          <span className="footer-brand">ChemBrain</span>
          <span>Work in progress · Check AI suggestions before use.</span>
        </footer>
      </div>
    </SessionCtx.Provider>
  );
}

function Header() {
  const { user } = useSession();
  return (
    <header className="header">
      <Link to="/" className="brand">
        ChemBrain
      </Link>
      {user ? (
        <nav className="nav" aria-label="Main">
          <NavLink to="/" end>
            Projects
          </NavLink>
          <NavLink to="/connections">Connections</NavLink>
          <NavLink to="/account">Settings</NavLink>
        </nav>
      ) : (
        <div className="status-pill">
          <span className="dot" aria-hidden="true" />
          Research workspace
        </div>
      )}
    </header>
  );
}

function NotFound() {
  return (
    <section className="page">
      <h1 className="page-title">Not found</h1>
      <p className="muted">
        This page does not exist, or it belongs to another account. <Link to="/">Back to projects</Link>
      </p>
    </section>
  );
}
