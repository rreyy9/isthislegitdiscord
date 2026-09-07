import { useEffect, useState } from 'react';
import type { UpdateState } from '../preload';
import { bridge } from './bridge';
import { api, getClientVersion, getServerUrl } from './api';
import { compareVersions } from './version';

/**
 * Knowing an update exists, and doing something about it.
 *
 * Two sources, because they answer at different times. `/api/config` carries
 * the newest published build, which is how a client that has just started
 * finds out; and `client:update-available` arrives over the socket when one is
 * published, which is how an app that has been open all evening finds out
 * without reconnecting.
 *
 * Either way this is a notice. Nobody is stopped from chatting because a newer
 * build exists -- an out-of-date client keeps working, which is the whole
 * point of the additive rules on the server side.
 */

export interface Updates {
  /** The newest version the server has, when it is newer than this build. */
  available: string | null;
  /** What the updater itself is doing. */
  state: UpdateState;
  /** True when this build is below the server's floor and must not be used. */
  blocked: boolean;
  download: () => void;
  install: () => void;
  recheck: () => void;
}

const IDLE: UpdateState = {
  stage: 'idle',
  version: null,
  percent: 0,
  message: null,
};

/* A one-slot bus, so the socket handler in Chat can reach the banner in App. */
type Listener = (version: string) => void;
const listeners = new Set<Listener>();

/** Called by the socket handler when the server announces a build. */
export function noteUpdateAvailable(version: string): void {
  for (const l of listeners) l(version);
}

/**
 * `ready` is not optional politeness. Both the server address and this build's
 * own version are read by `initApi()`, and this hook is called from the same
 * component that calls it -- so an ungated effect runs first, asks the default
 * `localhost:3000` for its config, and compares against an empty version
 * string. The check then silently never fires, which is the worst way for a
 * notification to fail. Pass true once the app is signed in.
 */
export function useUpdates(ready: boolean): Updates {
  const [available, setAvailable] = useState<string | null>(null);
  const [state, setState] = useState<UpdateState>(IDLE);
  const [blocked, setBlocked] = useState(false);

  /** Ask the updater to look, which also points it at the current server. */
  function recheck() {
    void bridge
      .checkForUpdate(getServerUrl())
      .then(setState)
      .catch(() => undefined);
  }

  useEffect(() => {
    if (!ready) return;
    let alive = true;

    // What the server says it has. An older server has no such field and
    // returns undefined, which reads as "nothing published" -- the reason
    // every added field is optional to whoever reads it.
    void api
      .config()
      .then((cfg) => {
        if (!alive) return;
        const mine = getClientVersion();
        if (
          cfg.latestClientVersion &&
          mine &&
          compareVersions(cfg.latestClientVersion, mine) > 0
        ) {
          setAvailable(cfg.latestClientVersion);
          recheck();
        }
        // The floor. Expected to be null; when it is not, this build is one
        // the server has said it cannot talk to safely.
        if (
          cfg.minClientVersion &&
          mine &&
          compareVersions(mine, cfg.minClientVersion) < 0
        ) {
          setBlocked(true);
          recheck();
        }
      })
      .catch(() => undefined);

    // What main is doing about it.
    void bridge.updateState().then((s) => alive && setState(s));
    const offState = bridge.onUpdateState((s) => alive && setState(s));

    const onAnnounced: Listener = (version) => {
      if (!alive) return;
      const mine = getClientVersion();
      if (!mine || compareVersions(version, mine) > 0) {
        setAvailable(version);
        recheck();
      }
    };
    listeners.add(onAnnounced);

    return () => {
      alive = false;
      offState();
      listeners.delete(onAnnounced);
    };
  }, [ready]);

  return {
    available,
    state,
    blocked,
    download: () => void bridge.downloadUpdate().then(setState),
    install: () => void bridge.installUpdate(),
    recheck,
  };
}
