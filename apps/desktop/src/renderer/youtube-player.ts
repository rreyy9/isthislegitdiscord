/**
 * A YouTube embed, driven by postMessage rather than by YouTube's own script.
 *
 * The obvious way to do this is `https://www.youtube.com/iframe_api`, and this
 * app cannot have it. The renderer's CSP is `default-src 'self'` with no
 * `script-src` exception on purpose -- the note in `index.html` puts it plainly:
 * the renderer runs no code it did not ship with, and that is what makes the
 * broad `connect-src` safe. Loading a third-party script to play a video would
 * spend the one rule holding the rest of it up.
 *
 * So this talks to the iframe directly. The protocol below is exactly what
 * YouTube's own library speaks over the wire -- `enablejsapi=1`, a `listening`
 * handshake, `command` frames out, `infoDelivery` frames back -- with the
 * library's job done here instead. `frame-src` already allows the origin
 * because message embeds use it, so no CSP change goes with this file.
 *
 * It is undocumented, which is the honest cost. What that buys is a player
 * that cannot execute anything YouTube ships, in a window that also holds a
 * chat. The failure mode is handled rather than assumed away: if the handshake
 * gets no answer, `onUnreachable` fires and the window says so instead of
 * showing a black rectangle forever.
 *
 * ---------------------------------------------------------------------------
 * The `origin` problem, which is worth knowing about before this is packaged
 * ---------------------------------------------------------------------------
 * `enablejsapi` wants an `origin` parameter naming the page that will be
 * posting commands. In dev the renderer is served over http and has a real
 * one; in a packaged build it loads from `file://`, where `location.origin` is
 * the string "null" and there is nothing truthful to send. The parameter is
 * omitted in that case rather than sent as a lie, which is what YouTube's own
 * widget does for a null-origin opener and which works today.
 *
 * Inbound messages are checked against the two YouTube origins regardless, so
 * nothing else on the page can drive the player by shouting at it.
 */

/** The two origins a player frame may speak from. Nothing else is listened to. */
const PLAYER_ORIGINS = [
  'https://www.youtube-nocookie.com',
  'https://www.youtube.com',
];

/** Where commands are sent. Matches the `src` below. */
const EMBED_ORIGIN = 'https://www.youtube-nocookie.com';

/** YouTube's player states, from the same table their library exposes. */
export const YT_UNSTARTED = -1;
export const YT_ENDED = 0;
export const YT_PLAYING = 1;
export const YT_PAUSED = 2;
export const YT_BUFFERING = 3;
export const YT_CUED = 5;

export interface PlayerInfo {
  /** Seconds into the video, as the player last reported it. */
  currentTime: number;
  /** Total seconds, or 0 before the player knows. */
  duration: number;
  state: number;
}

export interface PlayerHooks {
  /** The handshake completed: commands from here on will land. */
  onReady: () => void;
  /** A position/state report. Arrives several times a second while playing. */
  onInfo: (info: PlayerInfo) => void;
  /**
   * The handshake got no answer. Almost always the `origin` question above,
   * and the one thing this module cannot paper over -- so it is surfaced
   * rather than retried forever behind a spinner.
   */
  onUnreachable: () => void;
}

/**
 * Build the embed URL for a video.
 *
 * `controls=0` because the host drives from our transport bar and YouTube's
 * own scrubber would be a second set of controls that only one person in the
 * room is allowed to touch. `rel=0` keeps the end card from offering somebody
 * else's video to a room that did not queue it.
 */
export function embedUrl(videoId: string, startSeconds: number): string {
  const params = new URLSearchParams({
    enablejsapi: '1',
    controls: '0',
    rel: '0',
    playsinline: '1',
    // Autoplay is asked for, and the party window is created with an autoplay
    // policy that grants it -- see `createPartyWindow` in main. Without both,
    // the first video of the evening sits paused for everyone but whoever
    // clicked something.
    autoplay: '1',
    fs: '1',
    modestbranding: '1',
    // Captions on wherever the video has them. Deliberately a fixed part of
    // the URL rather than something the toggle writes: `src` is an attribute
    // React keeps in step with what it is given, and changing it reloads the
    // iframe -- which is the bug that used to restart the video every time
    // somebody touched the volume. So the URL carries the default and the
    // toggle goes over postMessage, where it costs nothing.
    cc_load_policy: '1',
  });
  if (startSeconds > 0) params.set('start', String(Math.floor(startSeconds)));

  // Only when the page has one to tell the truth about. See the note above.
  const origin = window.location.origin;
  if (origin && origin !== 'null' && /^https?:/.test(origin)) {
    params.set('origin', origin);
  }

  return `${EMBED_ORIGIN}/embed/${videoId}?${params}`;
}

/**
 * Wraps one iframe for as long as it is on screen.
 *
 * Deliberately not a React component: it owns a window-level message listener
 * and a handshake timer, and the thing React is good at -- re-rendering on
 * state change -- is exactly what a video element must not do. The component
 * makes one of these, hands it the element, and tears it down on unmount.
 */
export class YouTubePlayer {
  private readonly frame: HTMLIFrameElement;
  private readonly hooks: PlayerHooks;
  private ready = false;
  private handshake: number | null = null;
  private listener: ((e: MessageEvent) => void) | null = null;
  private onFrameLoad: (() => void) | null = null;
  private destroyed = false;

  /** The last report, so a caller can ask where the video is without waiting. */
  info: PlayerInfo = { currentTime: 0, duration: 0, state: YT_UNSTARTED };

  constructor(frame: HTMLIFrameElement, hooks: PlayerHooks) {
    this.frame = frame;
    this.hooks = hooks;

    this.listener = (e: MessageEvent) => this.receive(e);
    window.addEventListener('message', this.listener);

    // Nothing may be posted until the frame is actually on YouTube's origin.
    //
    // A freshly created iframe is not empty: it holds an `about:blank`
    // document that inherits *this* page's origin, and `postMessage` with a
    // target origin that does not match the recipient throws -- synchronously,
    // out through whatever called it, which is how a play button ends up doing
    // nothing at all. Waiting for `load` is the whole fix.
    //
    // `contentDocument` is the test for whether that has already happened: it
    // reads as null once the frame is cross-origin, and non-null while it is
    // still the same-origin blank. So a frame that loaded before this ran is
    // handled without waiting for an event that has already fired.
    if (frame.contentWindow && frame.contentDocument === null) {
      this.startHandshake();
    } else {
      this.onFrameLoad = () => {
        if (!this.destroyed) this.startHandshake();
      };
      frame.addEventListener('load', this.onFrameLoad);
    }
  }

  /**
   * Say "I am listening" until the player answers.
   *
   * Repeated rather than sent once: the frame may not have run its own script
   * when this starts, and a single message into a frame that is not ready yet
   * is a message nobody hears. Their library does the same thing.
   */
  private startHandshake() {
    let attempts = 0;
    const tick = () => {
      if (this.destroyed || this.ready) return;
      attempts += 1;
      // Ten seconds of asking. Long enough for a slow frame on a cold start,
      // short enough that somebody staring at a blank player gets told.
      if (attempts > 50) {
        this.stopHandshake();
        this.hooks.onUnreachable();
        return;
      }
      this.post({ event: 'listening', id: 1, channel: 'widget' });
    };
    tick();
    this.handshake = window.setInterval(tick, 200);
  }

  private stopHandshake() {
    if (this.handshake !== null) {
      window.clearInterval(this.handshake);
      this.handshake = null;
    }
  }

  private post(payload: unknown) {
    // Guarded rather than trusted. `contentWindow` is null between a `src`
    // change and the new document, and for the window either side of a
    // navigation the origin may not be YouTube's yet -- which makes
    // `postMessage` throw rather than return. A command lost in that gap is
    // the correct outcome, because the state that produced it is re-applied
    // when the frame is ready; a command that throws takes the caller with it,
    // and the caller is usually somebody's click on play.
    try {
      this.frame.contentWindow?.postMessage(JSON.stringify(payload), EMBED_ORIGIN);
    } catch {
      // Not ours yet. The handshake retries, and a control re-issues from the
      // next pass of the sync loop.
    }
  }

  private receive(e: MessageEvent) {
    if (this.destroyed) return;
    if (!PLAYER_ORIGINS.includes(e.origin)) return;
    if (e.source !== this.frame.contentWindow) return;

    let data: any;
    try {
      data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    } catch {
      // The frame sends things this module has no use for, and some of them
      // are not JSON. Not an error, just not ours.
      return;
    }
    if (!data || typeof data !== 'object') return;

    if (data.event === 'onReady' || data.event === 'initialDelivery') {
      if (!this.ready) {
        this.ready = true;
        this.stopHandshake();
        this.hooks.onReady();
      }
    }

    const info = data.info;
    if (info && typeof info === 'object') {
      // `infoDelivery` carries whichever fields changed, so each one is kept
      // from the last report rather than reset to zero by a frame that only
      // mentioned the other two.
      this.info = {
        currentTime:
          typeof info.currentTime === 'number' ? info.currentTime : this.info.currentTime,
        duration: typeof info.duration === 'number' ? info.duration : this.info.duration,
        state: typeof info.playerState === 'number' ? info.playerState : this.info.state,
      };
      this.hooks.onInfo(this.info);
    } else if (data.event === 'onStateChange' && typeof data.info === 'number') {
      this.info = { ...this.info, state: data.info };
      this.hooks.onInfo(this.info);
    }
  }

  /* ------------------------------------------------------------ commands */

  private command(func: string, args: unknown[] = []) {
    this.post({ event: 'command', func, args });
  }

  play() {
    this.command('playVideo');
  }
  pause() {
    this.command('pauseVideo');
  }
  /**
   * `allowSeekAhead` is true: the second argument tells the player it may ask
   * the network for a part of the video it has not buffered, which is the
   * whole point when the seek came from somebody else's click.
   */
  seek(seconds: number) {
    this.command('seekTo', [Math.max(0, seconds), true]);
  }
  /** 0..100, YouTube's scale. Local only -- nobody else hears this change. */
  setVolume(percent: number) {
    this.command('setVolume', [Math.round(Math.min(100, Math.max(0, percent)))]);
  }

  /**
   * Turn captions on or off, for this viewer only.
   *
   * Both module names are sent because the player has had two: `captions` is
   * the HTML5 one and `cc` was the old Flash player's. An unknown module is
   * ignored, so sending both costs a message and covers whichever this embed
   * turns out to be.
   *
   * There is no reply and no way to read the result back -- `infoDelivery`
   * says nothing about captions -- so the button that calls this reflects what
   * was asked for rather than what happened. That is honest for a preference
   * whose failure mode is "the video has no subtitles", which is not something
   * this app could fix anyway.
   */
  setCaptions(on: boolean) {
    const module = on ? 'loadModule' : 'unloadModule';
    this.command(module, ['captions']);
    this.command(module, ['cc']);
  }
  mute() {
    this.command('mute');
  }
  unMute() {
    this.command('unMute');
  }

  get isReady() {
    return this.ready;
  }

  destroy() {
    this.destroyed = true;
    this.stopHandshake();
    if (this.listener) window.removeEventListener('message', this.listener);
    if (this.onFrameLoad) this.frame.removeEventListener('load', this.onFrameLoad);
    this.listener = null;
    this.onFrameLoad = null;
  }
}

/**
 * The video's title, best effort.
 *
 * oEmbed is the only endpoint that answers without an API key, and it answers
 * with a title and nothing about length. A key would mean shipping one in a
 * client that ten friends install, which is a worse trade than a queue that
 * sometimes draws a video id.
 *
 * Never throws: a failure here must not stop a video being queued. The id is
 * a poor title and an excellent fallback.
 */
export async function fetchVideoTitle(videoId: string): Promise<string> {
  try {
    const url =
      'https://www.youtube.com/oembed?format=json&url=' +
      encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return videoId;
    const body = (await res.json()) as { title?: unknown };
    return typeof body.title === 'string' && body.title.trim()
      ? body.title.trim()
      : videoId;
  } catch {
    return videoId;
  }
}

/**
 * mm:ss, or h:mm:ss past an hour.
 *
 * `null` is the only thing that means "nobody knows" -- zero means zero, and
 * draws as `0:00`. The same function sets the elapsed time in the transport,
 * where a video that has just started is at zero seconds rather than at an
 * unknown position, and a queue row whose length YouTube never told us passes
 * `null` to say so.
 */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
