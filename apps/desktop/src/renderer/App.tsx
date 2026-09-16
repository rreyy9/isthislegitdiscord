import { useCallback, useEffect, useState } from 'react';
import { api, getToken, initApi, setToken, type Me } from './api';
import { Login } from './components/Login';
import { Chat } from './components/Chat';
import { ImageViewerProvider } from './components/ImageViewer';
import { UpdateBanner, UpdateRequired } from './components/UpdateBanner';
import { PartyWindow } from './components/PartyWindow';
import { useUpdates } from './updates';

/**
 * Which window this renderer is.
 *
 * One bundle serves both windows -- main creates the second with `#party` on
 * the URL -- so the build config needs no second entry point and the preload,
 * the CSP and every module below are shared. Read once at module load rather
 * than from a hook: a window does not become a different window while it is
 * open, and reading it as state would mean a frame of the wrong app.
 */
const isPartyWindow = window.location.hash === '#party';

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

  /**
   * Your own profile, changed from the settings screen or from another machine
   * signed in as you. Held up here because it is what `me` is: Chat draws from
   * it, and re-fetching /api/me to learn what this app just saved would be a
   * round trip to be told something it was already handed.
   *
   * Stable, because Chat hands it to the socket handlers and a new identity
   * every render would tear the socket down and rebuild it every render.
   */
  const onMeChanged = useCallback((me: Me) => {
    setState((prev) => (prev.phase === 'chat' ? { phase: 'chat', me } : prev));
  }, []);

  if (state.phase === 'loading') {
    return <div className="login-wrap"><div className="empty">Loading…</div></div>;
  }
  if (state.phase === 'login') {
    // The party window cannot sign anybody in: the token lives in main and is
    // shared, so a party window without one means the main window is at the
    // login screen and there is nothing here to watch yet.
    if (isPartyWindow) {
      return (
        <div className="party-window">
          <div className="pw-empty">Sign in from the main window first.</div>
        </div>
      );
    }
    return <Login onDone={() => void resolveSession()} />;
  }

  /**
   * The party window stops here: no chat, no update banner, no image viewer.
   *
   * Above the `updates.blocked` check below on purpose. That screen is the main
   * window's job -- it is where the update button is -- and putting a second
   * copy of it in a window somebody opened to watch a video would be two
   * dialogs about one problem.
   */
  if (isPartyWindow) return <PartyWindow me={state.me} />;
  // A floor the server has set, and this build is under it. Expected never to
  // happen: an out-of-date client is normally notified and left alone.
  if (updates.blocked) return <UpdateRequired updates={updates} />;

  // The image viewer sits above Chat rather than inside it: the lightbox and
  // the right-click menu are app-level overlays, and every image that wants
  // them is somewhere under here.
  return (
    <ImageViewerProvider>
      <Chat
        me={state.me}
        onMeChanged={onMeChanged}
        onSignOut={() => setState({ phase: 'login' })}
        // Handed down so the settings screen can show what this build is and
        // offer the update, rather than the banner being the only place an
        // update is ever mentioned.
        updates={updates}
      />
      <UpdateBanner updates={updates} />
    </ImageViewerProvider>
  );
}
