import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, type Me, type MemberDto } from '../api';
import { connectSocket, disconnectSocket, idleEvents } from '../socket';
import { useWatchParty } from '../watch-party';
import { decideSync, positionNow } from '../watch-party-sync';
import {
  embedUrl,
  formatDuration,
  YouTubePlayer,
  YT_ENDED,
} from '../youtube-player';
import type { WatchPartyStateDto, WatchPartyVideoDto } from '../watch-party-types';
import { Avatar } from './Avatar';
import { bridge } from '../bridge';

/**
 * The watch party window: everything in the second window, and nothing else.
 *
 * It is the same renderer bundle as the chat, loaded into its own
 * `BrowserWindow` with `#party` on the URL -- so it has its own socket, its own
 * React tree, and no idea the chat exists. The gateway counts connections per
 * user, so a person with both windows open is one online person with two
 * sockets, which is a case it already handled before this feature existed.
 *
 * Voice is deliberately absent. The LiveKit join token sets `identity` to the
 * user id, and a second window joining the same room as the same identity
 * evicts the first -- so the call stays in the main window and people talk over
 * the video exactly as they already were.
 */

/** How often the player is checked against the room. See `decideSync`. */
const SYNC_INTERVAL_MS = 1000;

export function PartyWindow({ me }: { me: Me }) {
  const party = useWatchParty(me.id);
  const [status, setStatus] = useState<'connected' | 'disconnected' | 'connecting'>(
    'connecting',
  );
  const [members, setMembers] = useState<MemberDto[]>([]);
  const [ready, setReady] = useState(false);

  const { discover, resync, handlers } = party;

  /* ------------------------------------------------------------- the wire */

  useEffect(() => {
    connectSocket({
      ...idleEvents(),
      ...handlers,
      onStatus: setStatus,
      // A reconnect is a new socket, and rooms are per socket: without this the
      // window looks connected and silently stops hearing chat.
      onReconnected: resync,
    });
    return () => disconnectSocket();
  }, [handlers, resync]);

  /**
   * Find the party this window was opened for.
   *
   * There is only one per guild, so "the party in the first guild" is the whole
   * of the lookup. A broadcast that went out before this socket existed is one
   * this window never heard, which is why it has to ask rather than wait.
   */
  useEffect(() => {
    if (status !== 'connected') return;
    let cancelled = false;
    void (async () => {
      const guilds = await api.guilds().catch(() => []);
      const guildId = guilds[0]?.id;
      if (cancelled || !guildId) return setReady(true);
      void api.members().then((m) => !cancelled && setMembers(m)).catch(() => {});
      await discover(guildId);
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [status, discover]);

  /**
   * Put *this socket* in the party's room, for every party it sees.
   *
   * Membership is per person; the room is per socket, and those are not the
   * same question. When the main window has already joined, this person is
   * a watcher before this window has said anything -- so a check of "am I in
   * the party" is true, the join is skipped, and this window sits outside the
   * room it needs to be in. It looks perfectly connected and never receives a
   * single line of chat, which is exactly what it did.
   *
   * So: always join, on every party id this window sees. `party:join` is
   * idempotent by design for precisely this, and the server only broadcasts
   * when the watcher list actually changed.
   */
  const { party: current, join } = party;
  useEffect(() => {
    if (!current?.id) return;
    void join();
    // Keyed on the id rather than the object: the state arrives again on every
    // play, pause and seek, and rejoining on each would be a message a second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, join]);

  /* ------------------------------------------------------------- the cast */

  const people = useMemo(() => {
    const byId = new Map<string, { name: string; image: string | null }>();
    for (const m of members) {
      byId.set(m.user.id, {
        name: m.user.displayName || m.user.username,
        image: m.user.image,
      });
    }
    return byId;
  }, [members]);

  const nameOf = useCallback(
    (id: string) => (id === me.id ? 'You' : people.get(id)?.name ?? 'Someone'),
    [people, me.id],
  );
  const imageOf = useCallback((id: string) => people.get(id)?.image ?? null, [people]);

  if (!ready) {
    return (
      <div className="party-window">
        <div className="pw-empty">Finding the watch party…</div>
      </div>
    );
  }

  if (!party.party) {
    return (
      <div className="party-window">
        <div className="pw-empty">
          <div className="pw-empty-title">No watch party running</div>
          <div className="pw-empty-sub">
            Start one from the sidebar in the main window, and this window will
            fill in.
          </div>
        </div>
      </div>
    );
  }

  return (
    <PartyStage
      party={party}
      state={party.party}
      me={me}
      status={status}
      nameOf={nameOf}
      imageOf={imageOf}
    />
  );
}

/* --------------------------------------------------------------- the stage */

/**
 * Split out from the window above so everything below here can assume there is
 * a party. Without the split, every hook in the player would have to be written
 * to do nothing for the case where there is nothing to play.
 */
function PartyStage({
  party,
  state,
  me,
  status,
  nameOf,
  imageOf,
}: {
  party: ReturnType<typeof useWatchParty>;
  state: WatchPartyStateDto;
  me: Me;
  status: 'connected' | 'disconnected' | 'connecting';
  nameOf: (id: string) => string;
  imageOf: (id: string) => string | null;
}) {
  const nowPlaying = state.queue[0] ?? null;
  const isHost = state.hostId === me.id;

  const frameRef = useRef<HTMLIFrameElement>(null);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const lastCorrectionRef = useRef<number | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [length, setLength] = useState<number | null>(null);
  const [volume, setVolume] = useState(70);
  /**
   * Captions, for this viewer only -- the same kind of thing as volume, and
   * deliberately not room state. Two people watching the same video want
   * different answers here, and neither is the host's to decide.
   *
   * Starts on, matching `cc_load_policy=1` in the embed URL, and lives on this
   * component rather than per video: somebody who turned subtitles off once
   * meant it for the evening, not for one clip.
   */
  const [captionsOn, setCaptionsOn] = useState(true);

  /**
   * Everything the sync loop reads, kept in a ref.
   *
   * The loop runs on an interval and must see the current state without being
   * rebuilt every time the state changes -- a `setInterval` recreated on each
   * `party:updated` would restart its own clock several times a second while
   * somebody scrubs.
   */
  const live = useRef({ state, isHost, party });
  live.current = { state, isHost, party };

  /* ------------------------------------------------------------ the player */

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame || !nowPlaying) return;

    setUnreachable(false);
    lastCorrectionRef.current = null;

    const player = new YouTubePlayer(frame, {
      onReady: () => {
        player.setVolume(volume);
        // The URL turns captions on for every video, so this only has to do
        // something when the viewer has since turned them off. Re-applied per
        // video because each one is a fresh player that never heard the toggle.
        if (!captionsOn) player.setCaptions(false);
        // Where the room is *now*, not where it was when this window opened:
        // the frame takes a moment to load and the video did not wait.
        const target = positionNow(
          live.current.state,
          Date.now(),
          live.current.party.skewMs,
        );
        player.seek(target);
        if (live.current.state.playing) player.play();
        else player.pause();
      },
      onInfo: (info) => {
        setElapsed(info.currentTime);
        setLength(info.duration > 0 ? info.duration : null);

        // Only the host reports the end. Everybody's player reaches it, and
        // without this the queue would jump forward once per person in the
        // room -- the id in the event is the second guard, for a report that
        // arrives after somebody already skipped.
        if (info.state === YT_ENDED && live.current.isHost) {
          const current = live.current.state.queue[0];
          if (current) live.current.party.videoEnded(current.id);
        }
      },
      onUnreachable: () => setUnreachable(true),
    });
    playerRef.current = player;

    return () => {
      player.destroy();
      playerRef.current = null;
    };
    // Rebuilt per video, because the iframe is replaced per video. `volume` is
    // read once here and pushed by its own effect afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nowPlaying?.id]);

  /** Local, and nobody else hears it change. */
  useEffect(() => {
    playerRef.current?.setVolume(volume);
  }, [volume]);

  useEffect(() => {
    playerRef.current?.setCaptions(captionsOn);
  }, [captionsOn]);

  /* -------------------------------------------------------------- the sync */

  useEffect(() => {
    const id = window.setInterval(() => {
      const player = playerRef.current;
      const { state: current, party: hook } = live.current;
      if (!player?.isReady || current.queue.length === 0) return;

      const now = Date.now();
      const target = positionNow(current, now, hook.skewMs);
      const action = decideSync({
        target,
        actual: player.info.currentTime,
        playing: current.playing,
        state: player.info.state,
        lastCorrectionAt: lastCorrectionRef.current,
        now,
      });

      if (action.kind === 'none') return;
      lastCorrectionRef.current = now;
      if (action.kind === 'seek') player.seek(action.to);
      else if (action.kind === 'play') player.play();
      else player.pause();
    }, SYNC_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  /**
   * A host action, applied to their own player at once as well as sent.
   *
   * Without the local half, the host's own video waits for the round trip and
   * then for the next pass of the sync loop -- up to a second and a bit of
   * nothing after pressing their own play button, which reads as a dropped
   * click and gets pressed again. Everyone else is a second behind by design;
   * the person doing it should not be.
   *
   * The cooldown is stamped here too, so the loop does not immediately
   * "correct" a player that is doing exactly what it was just told.
   */
  const hostControl = useCallback(
    (action: 'play' | 'pause' | 'skip' | 'seek', position?: number) => {
      party.control(action, position);
      const player = playerRef.current;
      if (!player?.isReady) return;
      lastCorrectionRef.current = Date.now();
      if (action === 'play') player.play();
      else if (action === 'pause') player.pause();
      else if (action === 'seek' && position !== undefined) player.seek(position);
      // A skip replaces the video, so there is no local command worth sending:
      // the new state rebuilds the frame.
    },
    [party],
  );

  /**
   * Where to start the frame, worked out once per video.
   *
   * It must not come from a value that changes on every render. `src` is an
   * attribute React keeps in step with what it is given, so a start position
   * recomputed from `Date.now()` each time made a *new* URL on every render --
   * and setting `src` reloads an iframe. Every volume change, every position
   * report, every `party:updated` was therefore restarting the video.
   *
   * It is only an optimisation in any case: `onReady` seeks to wherever the
   * room actually is. This is what stops the first frame being of second zero.
   */
  const startAt = useMemo(
    () =>
      Math.floor(
        positionNow(live.current.state, Date.now(), live.current.party.skewMs),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nowPlaying?.id],
  );

  /** Where the room is at this instant, for a click that has just happened. */
  const targetNow = useCallback(
    () => positionNow(live.current.state, Date.now(), live.current.party.skewMs),
    [],
  );

  /* ------------------------------------------------------------ the layout */

  // Deliberately no render-time position here. Anything derived from
  // `Date.now()` during render changes on every pass, and the last thing that
  // depended on one was reloading the iframe. The two callers that need the
  // room's position now read it at the moment of the click, from `targetNow`.
  const duration = length ?? nowPlaying?.duration ?? null;
  const progress =
    duration && duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 0;

  return (
    <div className="party-window">
      <div className="pw-main">
        <div className="pw-stage">
          {nowPlaying ? (
            <iframe
              // Keyed by the queue entry, not the video id: the same video
              // queued twice is two entries, and the second one has to start
              // from the beginning rather than reuse a frame sitting at the end
              // of the first.
              key={nowPlaying.id}
              ref={frameRef}
              className="pw-frame"
              src={embedUrl(nowPlaying.videoId, startAt)}
              // `clipboard-write` is delegated because the player asks for it
              // -- its own menu copies a video URL -- and a permissions policy
              // that denies it logs a violation on every press. Nothing here
              // reads the clipboard; `clipboard-read` stays denied.
              //
              // No `allowFullScreen` beside this: `allow` already carries
              // `fullscreen`, and having both makes React warn that one takes
              // precedence over the other.
              allow="autoplay; encrypted-media; picture-in-picture; clipboard-write; fullscreen"
              title={nowPlaying.title}
            />
          ) : (
            <div className="pw-nothing">
              <div className="pw-nothing-glyph">🎬</div>
              <div className="pw-nothing-title">Nothing queued</div>
              <div className="pw-nothing-sub">
                Paste a YouTube link in the chat below to start the evening.
              </div>
            </div>
          )}

          <div className="pw-badges">
            <span className={'pw-badge ' + (status === 'connected' ? 'ok' : 'bad')}>
              {status === 'connected'
                ? '● in sync'
                : status === 'connecting'
                  ? '● reconnecting'
                  : '● offline'}
            </span>
            {isHost ? (
              <span className="pw-badge host">you are the host</span>
            ) : (
              <span className="pw-badge">{nameOf(state.hostId)} is driving</span>
            )}
          </div>

          {/* The one failure this window cannot paper over. See the note at the
              top of youtube-player.ts: the player is driven by postMessage, and
              a frame that never answers the handshake is a frame nothing can
              control. Saying so beats a black rectangle. */}
          {unreachable && (
            <div className="pw-unreachable">
              <b>The player is not answering.</b>
              <span>
                This video cannot be controlled from here — it may be one
                YouTube refuses to embed. Ask the host to skip it.
              </span>
            </div>
          )}
        </div>

        <div className="pw-transport">
          <div className="pw-scrub">
            <span className="pw-time">{formatDuration(elapsed)}</span>
            <div
              className={'pw-track' + (isHost ? ' seekable' : '')}
              title={isHost ? 'Seek for everyone' : 'Only the host can seek'}
              onClick={(e) => {
                if (!isHost || !duration) return;
                const box = e.currentTarget.getBoundingClientRect();
                const ratio = (e.clientX - box.left) / box.width;
                hostControl('seek', Math.max(0, ratio * duration));
              }}
            >
              <div className="pw-fill" style={{ width: `${progress}%` }} />
              <div className="pw-knob" style={{ left: `${progress}%` }} />
            </div>
            <span className="pw-time">{formatDuration(duration)}</span>
          </div>

          <div className="pw-controls">
            <button
              className="pw-ctl big"
              disabled={!isHost || !nowPlaying}
              title={isHost ? (state.playing ? 'Pause' : 'Play') : 'Only the host can'}
              onClick={() => hostControl(state.playing ? 'pause' : 'play')}
            >
              {state.playing ? '⏸' : '▶'}
            </button>
            <button
              className="pw-ctl"
              disabled={!isHost || !nowPlaying}
              title="Back 10 seconds, for everyone"
              onClick={() => hostControl('seek', Math.max(0, targetNow() - 10))}
            >
              ⏪ 10
            </button>
            <button
              className="pw-ctl"
              disabled={!isHost || !nowPlaying}
              title="Forward 10 seconds, for everyone"
              onClick={() => hostControl('seek', targetNow() + 10)}
            >
              10 ⏩
            </button>
            <button
              className="pw-ctl"
              disabled={!isHost || !nowPlaying}
              title="Skip to the next video"
              onClick={() => hostControl('skip')}
            >
              ⏭ Skip
            </button>

            <div className="pw-volume">
              <button
                className={'pw-ctl cc' + (captionsOn ? ' on' : '')}
                onClick={() => setCaptionsOn((on) => !on)}
                title={
                  captionsOn
                    ? 'Subtitles on — yours only, if this video has them'
                    : 'Subtitles off — yours only'
                }
                aria-pressed={captionsOn}
              >
                CC
              </button>
              <span title="Your volume. Nobody else hears this change.">🔊</span>
              <input
                className="slider"
                type="range"
                min={0}
                max={100}
                value={volume}
                onChange={(e) => setVolume(Number(e.target.value))}
              />
              <span className="pw-vol-cap">{volume}%</span>
            </div>
          </div>

          <div className="pw-note">
            {isHost
              ? 'Play, pause, seek and skip go out to everyone. Volume and subtitles are yours alone.'
              : `${nameOf(state.hostId)} controls playback. Volume and subtitles are yours alone.`}
          </div>
        </div>
      </div>

      <PartyRail
        party={party}
        state={state}
        me={me}
        isHost={isHost}
        nameOf={nameOf}
        imageOf={imageOf}
      />
    </div>
  );
}

/* ---------------------------------------------------------------- the rail */

function PartyRail({
  party,
  state,
  me,
  isHost,
  nameOf,
  imageOf,
}: {
  party: ReturnType<typeof useWatchParty>;
  state: WatchPartyStateDto;
  me: Me;
  isHost: boolean;
  nameOf: (id: string) => string;
  imageOf: (id: string) => string | null;
}) {
  const [draft, setDraft] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // Pinned to the bottom, because this is a conversation happening now rather
  // than a history anybody scrolls back through -- there is none to scroll to.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [party.chat.length]);

  async function send() {
    const text = draft.trim();
    if (!text) return;
    setDraft('');

    // One composer, two jobs: a link queues, anything else is said. The parse
    // decides, so there is no second field to find and no mode to be in.
    const result = await party.queueLink(text);
    if (result === 'queued') {
      setHint(null);
      return;
    }
    if (result === 'not-a-video') {
      party.say(text);
      setHint(null);
      return;
    }
    setHint('That could not be added to the queue.');
  }

  const upNext = state.queue.slice(1);

  return (
    <div className="pw-rail">
      <div className="pw-watchers">
        {state.watchers.map((id) => (
          <span
            key={id}
            className={'pw-watcher' + (id === state.hostId ? ' host' : '')}
            title={
              id === state.hostId ? `${nameOf(id)} — host` : nameOf(id)
            }
          >
            <Avatar className="tiny" name={nameOf(id)} image={imageOf(id)} />
            {id === state.hostId && <span className="pw-crown">👑</span>}
          </span>
        ))}
        <span className="pw-count">{state.watchers.length} watching</span>
      </div>

      <div className="pw-rail-head">
        Up next <span className="n">· {upNext.length}</span>
      </div>
      <div className="pw-queue">
        {state.queue.length === 0 && (
          <div className="pw-queue-empty">The queue is empty.</div>
        )}
        {state.queue.map((item, index) => (
          <QueueRow
            key={item.id}
            item={item}
            playing={index === 0}
            // You may always take back your own. The host may take anything,
            // and that button is drawn differently so using a host's power
            // never looks like using your own.
            canRemove={item.addedBy === me.id || isHost}
            asHost={item.addedBy !== me.id && isHost}
            addedByName={nameOf(item.addedBy)}
            addedByImage={imageOf(item.addedBy)}
            onRemove={() => party.unqueue(item.id)}
          />
        ))}
      </div>

      <div className="pw-rail-head">
        Party chat <span className="n">· not saved</span>
      </div>
      <div className="pw-chat" ref={scroller}>
        {party.chat.length === 0 && (
          <div className="pw-chat-empty">
            Nothing said yet. Chat here is gone when the party ends.
          </div>
        )}
        {party.chat.map((line) => (
          <div key={line.id} className="pw-line">
            <span className="pw-who">{nameOf(line.userId)}</span>
            <span className="pw-said">{line.content}</span>
          </div>
        ))}
      </div>

      <div className="pw-composer">
        {party.error && (
          <div className="pw-error" role="button" onClick={party.clearError}>
            {party.error}
          </div>
        )}
        <input
          value={draft}
          placeholder="Message, or paste a YouTube link to queue it"
          maxLength={2000}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="pw-hint">
          {hint ?? 'Chat here never reaches the text channels.'}
        </div>
      </div>

      <div className="pw-rail-foot">
        <button
          onClick={() => {
            void party.leave();
            void bridge.closePartyWindow();
          }}
          title="Leave the watch party and close this window"
        >
          Leave party
        </button>
      </div>
    </div>
  );
}

function QueueRow({
  item,
  playing,
  canRemove,
  asHost,
  addedByName,
  addedByImage,
  onRemove,
}: {
  item: WatchPartyVideoDto;
  playing: boolean;
  canRemove: boolean;
  asHost: boolean;
  addedByName: string;
  addedByImage: string | null;
  onRemove: () => void;
}) {
  return (
    <div className={'pw-q' + (playing ? ' playing' : '')}>
      {/* `mqdefault` is 320x180 and exists for every video; `maxres` does not,
          and a missing one is a broken picture rather than a smaller one. The
          host serves it over https, which `img-src` already allows because the
          message embeds draw their posters from the same place. */}
      <div className="pw-q-thumb">
        <img
          src={`https://i.ytimg.com/vi/${item.videoId}/mqdefault.jpg`}
          alt=""
          loading="lazy"
        />
        {/* Only when somebody actually knows. A queued video's length is not
            something the client is told -- see the note on `duration`. */}
        {item.duration !== null && (
          <span className="pw-q-len">{formatDuration(item.duration)}</span>
        )}
      </div>
      <div className="pw-q-meta">
        {playing && <div className="pw-q-now">Now playing</div>}
        {/* No `title` tooltip: the whole title is on screen, so there is
            nothing for a hover to reveal. */}
        <div className="pw-q-title">{item.title}</div>
        <div className="pw-q-by">
          <Avatar className="tiny" name={addedByName} image={addedByImage} />
          {addedByName}
        </div>
      </div>
      {canRemove && (
        <button
          className={'pw-q-x' + (asHost ? ' as-host' : '')}
          title={asHost ? 'Remove — host' : 'Remove — you added this'}
          onClick={onRemove}
        >
          ✕
        </button>
      )}
    </div>
  );
}
