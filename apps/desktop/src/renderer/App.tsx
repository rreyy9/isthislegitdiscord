import { useEffect, useState } from 'react';
import { api, getToken, initApi, setToken, type Me } from './api';
import { Login } from './components/Login';
import { Chat } from './components/Chat';
import { ImageViewerProvider } from './components/ImageViewer';

type State =
  | { phase: 'loading' }
  | { phase: 'login' }
  | { phase: 'chat'; me: Me };

export function App() {
  const [state, setState] = useState<State>({ phase: 'loading' });

  async function resolveSession() {
    await initApi();
    if (getToken()) {
      try {
        const me = await api.me();
        setState({ phase: 'chat', me });
        return;
      } catch {
        // Stored token is stale — clear it and show login.
        await setToken('');
      }
    }
    setState({ phase: 'login' });
  }

  useEffect(() => {
    void resolveSession();
  }, []);

  if (state.phase === 'loading') {
    return <div className="login-wrap"><div className="empty">Loading…</div></div>;
  }
  if (state.phase === 'login') {
    return <Login onDone={() => void resolveSession()} />;
  }
  // The image viewer sits above Chat rather than inside it: the lightbox and
  // the right-click menu are app-level overlays, and every image that wants
  // them is somewhere under here.
  return (
    <ImageViewerProvider>
      <Chat me={state.me} onSignOut={() => setState({ phase: 'login' })} />
    </ImageViewerProvider>
  );
}
