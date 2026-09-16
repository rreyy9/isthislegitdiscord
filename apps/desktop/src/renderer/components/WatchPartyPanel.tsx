import { useEffect, useRef, useState } from 'react';
import { Avatar } from './Avatar';
import type { WatchPartyStateDto } from '../watch-party-types';

/**
 * The watch party's two appearances in the main window: a section in the
 * channel list, and a strip above the voice panel.
 *
 * Presentation only. Everything here takes props and knows nothing about the
 * socket or the closure it is drawn from, which is what keeps `Chat.tsx` to a
 * handful of lines for this feature -- the lesson the README draws from the
 * reactions split.
 */

interface PartyPeople {
  nameOfUser: (id: string) => string;
  imageOfUser: (id: string) => string | null;
}

/* ------------------------------------------------------------- the section */

/**
 * The channel list's watch party section.
 *
 * The `+` is live for everybody, unlike the Text and Voice sections above it
 * where it is an admin's. That is the difference between the two kinds of
 * thing: a channel is the server's furniture and a party is an evening, and
 * needing an admin to start one would mean no parties on the evenings the
 * admin is out.
 */
export function WatchPartySection({
  party,
  meId,
  people,
  onStart,
  onOpen,
}: {
  party: WatchPartyStateDto | null;
  meId: string;
  people: PartyPeople;
  onStart: () => void;
  /** Click the live party: join it, or bring its window back. */
  onOpen: () => void;
}) {
  return (
    <>
      <div className="sb-section">
        Watch party
        <button className="sb-add" title="Start a watch party" onClick={onStart}>
          +
        </button>
      </div>

      {!party ? (
        <div className="chan party-empty" onClick={onStart} title="Start a watch party">
          <span className="hash">🎬</span>
          Start a watch party
        </div>
      ) : (
        <>
          <div
            className="chan party-live"
            onClick={onOpen}
            title={
              party.watchers.includes(meId)
                ? 'Open the watch party window'
                : 'Join this watch party'
            }
          >
            <span className="hash">🎬</span>
            {party.title}
            <span className="live-dot" title={`${party.watchers.length} watching`}>
              live
            </span>
          </div>
          {party.watchers.map((id) => (
            <div key={id} className="voice-mem">
              <Avatar
                className="tiny"
                name={people.nameOfUser(id)}
                image={people.imageOfUser(id)}
              />
              <span className="vm-name">{people.nameOfUser(id)}</span>
              {id === party.hostId && (
                <span className="vm-icon" title="Host — controls playback">
                  👑
                </span>
              )}
            </div>
          ))}
        </>
      )}
    </>
  );
}

/* --------------------------------------------------------------- the strip */

/**
 * The strip above the voice panel.
 *
 * Deliberately the same shape as `VoicePanel`: a status line with a way out, a
 * name, and buttons. The two say the same kind of thing -- here is something
 * you are currently in -- and one glance down the sidebar should answer it for
 * both without reading.
 *
 * Shown when there is a party at all, not only when you are in one. A party
 * running in the next room is exactly the thing worth a button.
 */
export function WatchPartyPanel({
  party,
  meId,
  windowOpen,
  error,
  onJoin,
  onLeave,
  onOpenWindow,
  onDismissError,
}: {
  party: WatchPartyStateDto | null;
  meId: string;
  /** Whether the separate window is up, which decides what the button offers. */
  windowOpen: boolean;
  error: string | null;
  onJoin: () => void;
  onLeave: () => void;
  onOpenWindow: () => void;
  onDismissError: () => void;
}) {
  if (!party) return null;

  const watching = party.watchers.includes(meId);
  const nowPlaying = party.queue[0];

  return (
    <div className="party-panel">
      <div className="pp-head">
        <span className="pp-dot" />
        <span className="pp-status">
          {watching ? 'In watch party' : 'Watch party live'}
        </span>
        {watching && (
          <button className="pp-leave" onClick={onLeave} title="Leave the watch party">
            Leave
          </button>
        )}
      </div>

      <div className="pp-title">
        🎬 {party.title}
        <span className="pp-count">
          · {party.watchers.length} watching
        </span>
      </div>

      {/* The one line somebody outside the party actually wants: not who is in
          it, but whether what is on is worth joining for. */}
      {nowPlaying ? (
        <div className="pp-now" title={nowPlaying.title}>
          {party.playing ? '▶' : '⏸'} {nowPlaying.title}
        </div>
      ) : (
        <div className="pp-now">Nothing queued yet</div>
      )}

      {error && (
        <div
          className="pp-error"
          role="button"
          title="Dismiss"
          onClick={onDismissError}
        >
          {error}
        </div>
      )}

      <div className="pp-buttons">
        {!watching ? (
          <button className="primary" onClick={onJoin}>
            Join
          </button>
        ) : (
          <button onClick={onOpenWindow}>
            {windowOpen ? 'Bring window here' : 'Open window'}
          </button>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- the modal */

/**
 * Naming a party before it opens.
 *
 * A dialog rather than starting one called "Watch party" straight away,
 * because the name is the whole of what the strip says to the eight people who
 * have not joined -- "Movie Night" and "bad music" are invitations, and a
 * default is not.
 */
export function StartPartyModal({
  onStart,
  onClose,
}: {
  onStart: (title: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  function submit() {
    const name = title.trim() || 'Watch party';
    onStart(name);
    onClose();
  }

  return (
    <div className="modal-wrap" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">Start a watch party</div>
        <div className="modal-body">
          <label>What is it called?</label>
          <input
            ref={input}
            value={title}
            maxLength={60}
            placeholder="Movie Night"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') onClose();
            }}
          />
          <div className="hint">
            Everyone on the server sees it in their sidebar and can join. The
            queue and the chat in it are gone when the party ends.
          </div>
        </div>
        <div className="modal-foot">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={submit}>
            Start
          </button>
        </div>
      </div>
    </div>
  );
}
