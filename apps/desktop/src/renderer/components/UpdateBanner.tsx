import type { Updates } from '../updates';
import { getClientVersion } from '../api';

/**
 * The update notice.
 *
 * A pill in the corner, never a dialog and never a block. An out-of-date
 * client keeps working, so this waits for somebody to have a moment rather
 * than taking one from them -- and installing is always their button to press,
 * because restarting closes a window somebody may be typing in.
 */
export function UpdateBanner({ updates }: { updates: Updates }) {
  const { available, state, justUpdated } = updates;

  // The receipt for a restart that worked. Checked before the early returns
  // below: after an update there is nothing newer to report, which is the
  // point, and the idle state would otherwise swallow it.
  if (justUpdated && state.stage === 'idle') {
    return (
      <div className="upd upd-done">
        <span>Updated to {getClientVersion()}.</span>
      </div>
    );
  }

  // Nothing published that is newer than this build, and nothing in flight.
  if (!available && state.stage === 'idle') return null;
  if (state.stage === 'checking') return null;

  const version = state.version ?? available;

  let body: React.ReactNode;
  switch (state.stage) {
    case 'downloading':
      body = (
        <>
          <span>Downloading {version}…</span>
          <span className="upd-bar">
            <span style={{ width: `${state.percent}%` }} />
          </span>
          <span className="upd-why">{state.percent}%</span>
        </>
      );
      break;

    case 'ready':
      body = (
        <>
          <span>Version {version} is ready.</span>
          {/* Said before the button is pressed, not after. A restart is much
              easier to agree to when you know what it is going to cost — a UAC
              prompt, or a minute out of the channel you are sitting in. */}
          <span className="upd-why">
            {/* A message on a ready update means a previous attempt was
                abandoned — most often a permission prompt that got a no.
                It outranks the advance warnings, which it has overtaken. */}
            {state.message ??
              (state.inCall
                ? 'You will drop out of the call and be put back in.'
                : state.elevates
                  ? 'Windows will ask for permission.'
                  : null)}
          </span>
          <button className="upd-go" onClick={updates.install}>
            Restart &amp; install
          </button>
        </>
      );
      break;

    // The window is on its way out; the progress window in main takes over
    // from here. This exists for the moment between the click and the hide.
    case 'installing':
      body = <span>Installing {version}…</span>;
      break;

    case 'unsupported':
      // An https-only feed, or a build running from source. Both are worth
      // saying plainly, because the alternative is a client that looks like
      // it is ignoring an update for no reason.
      body = (
        <>
          <span>Version {version} is available.</span>
          <span className="upd-why">{state.message}</span>
        </>
      );
      break;

    case 'error':
      // Said once. There is no second update path to fall back to; the
      // recovery is the installer, by hand.
      body = (
        <>
          <span>Could not update to {version}.</span>
          <span className="upd-why">{state.message}</span>
          <button className="upd-go" onClick={updates.recheck}>
            Try again
          </button>
        </>
      );
      break;

    default:
      body = (
        <>
          <span>Version {version} is available.</span>
          <button className="upd-go" onClick={updates.download}>
            Download
          </button>
        </>
      );
  }

  return <div className={`upd upd-${state.stage}`}>{body}</div>;
}

/**
 * The floor, on the rare occasion the server sets one.
 *
 * Blocking is a last resort and expected never to happen -- it is here so that
 * a change which genuinely cannot be made compatible has somewhere to land
 * other than ten people watching the app misbehave.
 */
export function UpdateRequired({ updates }: { updates: Updates }) {
  const { state } = updates;
  return (
    <div className="login-wrap">
      <div className="login">
        <h1>Update required</h1>
        <p className="sub">
          This server needs a newer version of the app than the one installed.
        </p>
        {state.stage === 'ready' ? (
          <>
            <button className="primary" onClick={updates.install}>
              Restart &amp; install
            </button>
            {state.elevates && (
              <p className="sub" style={{ margin: '10px 0 0' }}>
                Windows will ask for permission.
              </p>
            )}
          </>
        ) : state.stage === 'installing' ? (
          <p className="sub">Installing…</p>
        ) : state.stage === 'downloading' ? (
          <p className="sub">Downloading… {state.percent}%</p>
        ) : state.stage === 'available' ? (
          <button className="primary" onClick={updates.download}>
            Download update
          </button>
        ) : (
          <p className="sub">
            {state.message ??
              'Ask whoever runs the server for the current installer.'}
          </p>
        )}
      </div>
    </div>
  );
}
