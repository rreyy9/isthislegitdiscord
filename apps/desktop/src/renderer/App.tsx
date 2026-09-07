import { useEffect, useState } from 'react';
import { api, getToken, initApi, setToken, type Me } from './api';
import { Login } from './components/Login';
import { Chat } from './components/Chat';
import { ImageViewerProvider } from './components/ImageViewer';
import { UpdateBanner, UpdateRequired } from './components/UpdateBanner';
import { useUpdates } from './updates';

type State =
  | { phase: 'loading' }
  | { phase: 'login' }
  | { phase: 'chat'; me: Me };

export function App() {
  const [state, setState] = useState<State>({ phase: 'loading' });
  // Only once signed in: the server address and this build's version are both
  // read by initApi(), and asking before that answers about the wrong server.
  const updates = useUpdates(state.phase === 'chat');

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
  // A floor the server has set, and this build is under it. Expected never to
  // happen: an out-of-date client is normally notified and left alone.
  if (updates.blocked) return <UpdateRequired updates={updates} />;

  // The image viewer sits above Chat rather than inside it: the lightbox and
  // the right-click menu are app-level overlays, and every image that wants
  // them is somewhere under here.
  return (
    <ImageViewerProvider>
      <Chat me={state.me} onSignOut={() => setState({ phase: 'login' })} />
      <UpdateBanner updates={updates} />
    </ImageViewerProvider>
  );
}
