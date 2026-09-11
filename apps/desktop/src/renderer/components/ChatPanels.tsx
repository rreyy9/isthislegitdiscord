import { useEffect, useRef } from 'react';
import type { MemberDto, MessageDto } from '../api';
import { MessageContent } from './MessageContent';
import { Avatar } from './Avatar';
import { lastSeenLabel, muteLabel, stamp } from './chat-format';

/**
 * The two popovers that list messages from somewhere else: search results and
 * the pin board.
 *
 * They live together because they are the same thing wearing two labels -- "a
 * list of messages elsewhere in this guild, click one to go there" -- and were
 * written to look alike on purpose. Keeping them in one file is what stops the
 * two drifting into two different presentations of one idea.
 *
 * Both take a `lookupMention` rather than the member list, because that is all
 * `MessageContent` needs to render a mention, and a panel that took the whole
 * roster would have to be re-rendered every time anybody's status changed.
 */

/**
 * Search, as a popover under the header.
 *
 * Deliberately the same shape as the pin board: both are "a list of messages
 * somewhere else in this guild, click one to go there", and giving them two
 * different presentations would be inventing a distinction that is not there.
 *
 * Results say which channel and when, because that is what the reader is
 * matching against — a search result stripped of its context is a sentence
 * with no way to judge whether it is the one being looked for.
 */
export function SearchPanel({
  text,
  onText,
  results,
  busy,
  error,
  channelName,
  onJump,
  onClose,
  lookupMention,
}: {
  text: string;
  onText: (value: string) => void;
  /** Null before anything has been searched for; empty for no matches. */
  results: MessageDto[] | null;
  busy: boolean;
  error: string | null;
  channelName: (channelId: string) => string;
  onJump: (channelId: string, messageId: string) => void;
  onClose: () => void;
  lookupMention: (id: string) => { name: string; self: boolean } | null;
}) {
  const input = useRef<HTMLInputElement>(null);
  // Opened to be typed in. Anything else means a click to open and a click to
  // focus, for a box that has exactly one use.
  useEffect(() => input.current?.focus(), []);

  return (
    <div className="pins-panel search-panel" onClick={(e) => e.stopPropagation()}>
      <div className="pins-head">
        <input
          ref={input}
          className="search-input"
          value={text}
          placeholder="Search this server"
          onChange={(e) => onText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
          }}
        />
        <button className="pins-x" title="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="pins-body">
        {error && <div className="banner">{error}</div>}
        {busy && !results && <div className="hint">Searching…</div>}
        {!error && !busy && text.trim().length < 2 && (
          <div className="pins-empty">
            <div className="pins-empty-mark">🔍</div>
            <div>Type at least two characters.</div>
            <div className="hint">
              Whole words. Quote a phrase to keep it together, and put a minus
              in front of a word to leave it out.
            </div>
          </div>
        )}
        {results?.length === 0 && !busy && (
          <div className="pins-empty">
            <div className="pins-empty-mark">🔍</div>
            <div>Nothing matched “{text.trim()}”.</div>
          </div>
        )}
        {results?.map((m) => (
          <button
            className="pin-row"
            key={m.id}
            title="Go to this message"
            onClick={() => onJump(m.channelId, m.id)}
          >
            <Avatar
              name={m.author.displayName || m.author.username}
              image={m.author.image}
            />
            <div className="pin-body">
              <div className="msg-head">
                <span className="msg-author">
                  {m.author.displayName || m.author.username}
                </span>
                <span className="search-where">
                  #{channelName(m.channelId)}
                </span>
                <span className="msg-time">{stamp(m.createdAt)}</span>
              </div>
              <MessageContent
                content={m.content}
                attachments={m.attachments}
                edited={Boolean(m.editedAt)}
                lookupMention={lookupMention}
              />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The pinned messages in one channel, as a popover under the header.
 *
 * A popover rather than a modal because it is a reference, not a decision:
 * people open it to check what was agreed, glance, and carry on typing. A
 * modal would dim the channel behind it and demand to be dismissed, which is
 * the wrong shape for something read mid-sentence.
 *
 * Newest post first, and every row stamped with the date it was *posted* —
 * not the date it was pinned. What people look for on a board is when the
 * thing was said; pinning last March's message this morning must not put it
 * above a message from an hour ago.
 */
export function PinsPanel({
  channelName,
  pins,
  error,
  canPin,
  onUnpin,
  onJump,
  onClose,
  lookupMention,
}: {
  channelName: string;
  /** Null until the first load lands; the panel opens before its contents do. */
  pins: MessageDto[] | null;
  error: string | null;
  /** Whether this user may take things off the board. Admins only. */
  canPin: boolean;
  onUnpin: (m: MessageDto) => void;
  /** Go to the message in the channel. What the whole board is for. */
  onJump: (messageId: string) => void;
  onClose: () => void;
  lookupMention: (id: string) => { name: string; self: boolean } | null;
}) {
  return (
    // The click guard is what keeps the panel open while it is being used:
    // the window listener that closes it treats every other click as "away".
    <div className="pins-panel" onClick={(e) => e.stopPropagation()}>
      <div className="pins-head">
        <span>Pinned messages</span>
        <button className="pins-x" title="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="pins-body">
        {error && <div className="banner">{error}</div>}
        {!pins && !error && <div className="hint">Loading…</div>}
        {pins?.length === 0 && (
          <div className="pins-empty">
            <div className="pins-empty-mark">📌</div>
            <div>Nothing is pinned in #{channelName} yet.</div>
            {canPin && (
              <div className="hint">
                Hover a message and use the pin button to put it here.
              </div>
            )}
          </div>
        )}
        {pins?.map((m) => (
          // A button, not a div with a click handler: it is a link to
          // somewhere, and the pin board is a list somebody may well be
          // tabbing through.
          <button
            className="pin-row"
            key={m.id}
            title="Go to this message"
            onClick={() => onJump(m.id)}
          >
            <Avatar
              name={m.author.displayName || m.author.username}
              image={m.author.image}
            />
            <div className="pin-body">
              <div className="msg-head">
                <span className="msg-author">
                  {m.author.displayName || m.author.username}
                </span>
                <span className="msg-time">{stamp(m.createdAt)}</span>
              </div>
              <MessageContent
                content={m.content}
                attachments={m.attachments}
                edited={Boolean(m.editedAt)}
                lookupMention={lookupMention}
              />
            </div>
            {canPin && (
              <span
                className="pin-unpin"
                role="button"
                tabIndex={0}
                title="Unpin"
                // Or unpinning would also navigate to the message it just
                // took off the board, which is the one place nobody wants to
                // be sent.
                onClick={(e) => {
                  e.stopPropagation();
                  onUnpin(m);
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.stopPropagation();
                  e.preventDefault();
                  onUnpin(m);
                }}
              >
                ×
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Where the moderation menu is, and who it is for. */
export interface MemberMenu {
  userId: string;
  x: number;
  y: number;
}

/** The menu is drawn against the viewport, so its box has to be known up front. */
const MENU_WIDTH = 158;
const MENU_HEIGHT = 265;

const MUTE_OPTIONS: { label: string; minutes: number | null }[] = [
  { label: '5 minutes', minutes: 5 },
  { label: '1 hour', minutes: 60 },
  { label: '1 day', minutes: 60 * 24 },
  { label: '1 week', minutes: 60 * 24 * 7 },
  { label: 'Indefinitely', minutes: null },
];

/**
 * The roster down the right-hand side, and the moderation menu it opens.
 *
 * Presentational, like the two panels above it: every action is a callback,
 * so the panel neither calls the API nor knows what a refused one should say.
 * That is what lets it sit here rather than inside the chat closure -- the
 * moderation menu is the only part of it with any behaviour, and all of that
 * behaviour is somebody else's.
 *
 * `menuFor` is owned by the caller because the same click-away handler that
 * closes the account and channel menus closes this one, and a menu that
 * closed itself would need that handler written twice.
 */
export function MembersPanel({
  members,
  now,
  iAmAdmin,
  menuFor,
  onMenuChange,
  canModerate,
  onShowBans,
  onMute,
  onUnmute,
  onKick,
  onBan,
}: {
  members: MemberDto[];
  /** Ticks once a minute, so the "last seen" durations do not go stale. */
  now: number;
  iAmAdmin: boolean;
  menuFor: MemberMenu | null;
  onMenuChange: (menu: MemberMenu | null) => void;
  /** Whether the moderation menu is offered at all for this member. */
  canModerate: (m: MemberDto) => boolean;
  onShowBans: () => void;
  /** Null minutes is indefinitely; see MUTE_OPTIONS. */
  onMute: (m: MemberDto, minutes: number | null) => void;
  onUnmute: (m: MemberDto) => void;
  onKick: (m: MemberDto) => void;
  onBan: (m: MemberDto) => void;
}) {
  return (
    <div className="col members">
      <div className="sb-head row" style={{ fontSize: 13 }}>
        Members
        {iAmAdmin && (
          <button className="head-btn" onClick={onShowBans}>
            Bans
          </button>
        )}
      </div>
      <div className="sb-scroll">
        {[...members]
          .sort((a, b) =>
            a.online === b.online
              ? (a.user.displayName || a.user.username).localeCompare(
                  b.user.displayName || b.user.username,
                )
              : a.online
                ? -1
                : 1,
          )
          .map((m) => (
            <div key={m.user.id} className={'mem' + (m.online ? '' : ' offline')}>
              <Avatar
                name={m.user.displayName || m.user.username}
                image={m.user.image}
              />
              {/* Name and last-seen share a column so the row keeps one
                  height whether or not there is a duration to show. */}
              <div className="mem-text">
                <div className="mname">
                  {m.user.displayName || m.user.username}
                </div>
                {!m.online && m.lastSeenAt && (
                  <div
                    className="mem-seen"
                    title={`Last seen ${stamp(m.lastSeenAt)}`}
                  >
                    {lastSeenLabel(m.lastSeenAt, now)}
                  </div>
                )}
              </div>
              {m.mutedUntil && (
                <span className="mem-muted" title={muteLabel(m.mutedUntil)}>
                  🔇
                </span>
              )}
              {canModerate(m) && (
                <div className="mem-menu-wrap" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="mem-more"
                    title="Moderate"
                    onClick={(e) => {
                      if (menuFor?.userId === m.user.id) return onMenuChange(null);
                      const r = e.currentTarget.getBoundingClientRect();
                      onMenuChange({ userId: m.user.id, x: r.right, y: r.bottom });
                    }}
                  >
                    ⋯
                  </button>
                  {menuFor?.userId === m.user.id && (
                    <div
                      className="menu"
                      style={{
                        left: menuFor.x - MENU_WIDTH,
                        // Flip up rather than off the bottom of the window.
                        top: Math.min(menuFor.y + 4, window.innerHeight - MENU_HEIGHT),
                      }}
                    >
                      <div className="menu-label">Mute microphone for</div>
                      {MUTE_OPTIONS.map((o) => (
                        <button
                          key={o.label}
                          onClick={() => {
                            onMenuChange(null);
                            onMute(m, o.minutes);
                          }}
                        >
                          {o.label}
                        </button>
                      ))}
                      {m.mutedUntil && (
                        <button
                          onClick={() => {
                            onMenuChange(null);
                            onUnmute(m);
                          }}
                        >
                          Unmute
                        </button>
                      )}
                      <div className="menu-sep" />
                      <button
                        className="danger"
                        onClick={() => {
                          onMenuChange(null);
                          onKick(m);
                        }}
                      >
                        Kick
                      </button>
                      <button
                        className="danger"
                        onClick={() => {
                          onMenuChange(null);
                          onBan(m);
                        }}
                      >
                        Ban
                      </button>
                    </div>
                  )}
                </div>
              )}
              <div className={'pdot ' + (m.online ? 'on' : 'off')} />
            </div>
          ))}
      </div>
    </div>
  );
}
