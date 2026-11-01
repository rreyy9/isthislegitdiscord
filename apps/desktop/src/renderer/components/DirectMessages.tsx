import { useMemo, useState } from 'react';
import type { DirectMessageDto, MemberDto, PublicUserDto } from '../api';
import { Avatar } from './Avatar';

/**
 * Direct messages in the sidebar, and the dialogs that start and change them.
 *
 * Presentational, like the panels in ChatPanels.tsx: every action is a
 * callback, so nothing here calls the API or knows what a refusal should say.
 */

/** The longest a group may be, counting yourself. Mirrors `MAX_GROUP_DM`. */
export const MAX_GROUP_DM = 10;

const nameOf = (u: PublicUserDto) => u.displayName || u.username;

/** What a conversation is called: its person, or its group's name or people. */
export function dmTitle(dm: DirectMessageDto): string {
  if (dm.kind === 'direct') return dm.users[0] ? nameOf(dm.users[0]) : 'Nobody';
  if (dm.name) return dm.name;
  if (dm.users.length === 0) return 'Just you';
  return dm.users.map(nameOf).join(', ');
}

/**
 * The Direct messages section.
 *
 * Its own block with its own scroll, under the server's channels rather than
 * inside their list: the channels are the server's furniture and stay put, and
 * however many conversations pile up here they scroll by themselves instead of
 * pushing the channels off the top.
 */
export function DmSection({
  dms,
  activeChannel,
  members,
  unreadCount,
  isUnread,
  onOpen,
  onNew,
  onClose,
}: {
  dms: DirectMessageDto[];
  activeChannel: string | null;
  /** For the presence dot on a one-to-one row. */
  members: MemberDto[];
  unreadCount: (channelId: string) => number;
  isUnread: (channelId: string) => boolean;
  onOpen: (channelId: string) => void;
  onNew: () => void;
  onClose: (dm: DirectMessageDto) => void;
}) {
  const presence = (userId: string) => {
    const m = members.find((x) => x.user.id === userId);
    return !m?.online ? 'off' : m.away ? 'away' : 'on';
  };

  return (
    <div className="dm-section">
      <div className="sb-section dm-head">
        Direct messages
        <button className="sb-add" title="New message" onClick={onNew}>
          +
        </button>
      </div>
      <div className="dm-scroll">
        {dms.length === 0 && (
          <button className="dm-empty" onClick={onNew}>
            Start a conversation
          </button>
        )}
        {dms.map((dm) => {
          const count = unreadCount(dm.channelId);
          const unread = count > 0 || isUnread(dm.channelId);
          const first = dm.users[0];
          const gone = dm.kind === 'direct' && !dm.canSend;
          return (
            <div
              key={dm.channelId}
              className={
                'chan dm-row' +
                (dm.channelId === activeChannel ? ' active' : '') +
                (unread ? ' unread' : '')
              }
              title={dmTitle(dm)}
              onClick={() => onOpen(dm.channelId)}
            >
              <span className="dm-avatar">
                {dm.kind === 'group' ? (
                  <span className="dm-group-icon">{Math.min(dm.users.length + 1, 99)}</span>
                ) : (
                  <>
                    <Avatar
                      className="tiny"
                      name={first ? nameOf(first) : '?'}
                      image={first?.image}
                    />
                    {first && !gone && <span className={'dm-dot ' + presence(first.id)} />}
                  </>
                )}
              </span>
              <span className="dm-name">{dmTitle(dm)}</span>
              {count > 0 ? (
                <span className="ping-badge" title={`${count} unread`}>
                  {count > 99 ? '99+' : count}
                </span>
              ) : (
                unread && <span className="unread-dot" />
              )}
              <button
                className="dm-close"
                title={dm.kind === 'group' ? 'Close (you stay in the group)' : 'Close'}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(dm);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Pick people: for a new conversation, or to add to a group.
 *
 * One person opens your DM with them; more than one makes a group, and only
 * then does the name field appear, since a one-to-one DM is always called by
 * the person in it.
 */
export function PickPeopleModal({
  members,
  meId,
  exclude = [],
  room,
  title,
  confirmLabel,
  allowName,
  onClose,
  onDone,
}: {
  members: MemberDto[];
  meId: string;
  /** Already in the group, and so not offered. */
  exclude?: string[];
  /** How many more people fit. */
  room: number;
  title: string;
  confirmLabel: (count: number) => string;
  /** Offer a name once two or more are picked. */
  allowName: boolean;
  onClose: () => void;
  onDone: (userIds: string[], name: string) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const people = useMemo(() => {
    const q = query.trim().toLowerCase();
    return members
      .filter((m) => m.user.id !== meId && !exclude.includes(m.user.id))
      .filter(
        (m) =>
          !q ||
          m.user.username.toLowerCase().includes(q) ||
          (m.user.displayName ?? '').toLowerCase().includes(q),
      )
      .sort((a, b) => nameOf(a.user).localeCompare(nameOf(b.user)));
  }, [members, meId, exclude, query]);

  const toggle = (id: string) =>
    setPicked((prev) =>
      prev.includes(id)
        ? prev.filter((x) => x !== id)
        : prev.length >= room
          ? prev
          : [...prev, id],
    );

  async function submit() {
    if (picked.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onDone(picked, name.trim());
      onClose();
    } catch (e: any) {
      setError(e?.message || 'That did not work.');
      setBusy(false);
    }
  }

  return (
    <div className="modal-wrap" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">{title}</div>
        <div className="modal-body">
          {error && <div className="banner">{error}</div>}
          <input
            id="dm-pick-search"
            className="dm-pick-search"
            autoFocus
            placeholder="Find someone"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'Enter' && people.length === 1 && picked.length === 0) {
                toggle(people[0].user.id);
              }
            }}
          />
          <div className="dm-pick-list">
            {people.length === 0 && <div className="hint">Nobody matches.</div>}
            {people.map((m) => {
              const on = picked.includes(m.user.id);
              return (
                <label key={m.user.id} className={'dm-pick' + (on ? ' on' : '')}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!on && picked.length >= room}
                    onChange={() => toggle(m.user.id)}
                  />
                  <Avatar className="tiny" name={nameOf(m.user)} image={m.user.image} />
                  <span className="dm-pick-name">{nameOf(m.user)}</span>
                  <span className="dm-pick-user">@{m.user.username}</span>
                </label>
              );
            })}
          </div>
          {allowName && picked.length >= 2 && (
            <>
              <label htmlFor="dm-group-name">Group name (optional)</label>
              <input
                id="dm-group-name"
                className="dm-pick-search"
                maxLength={60}
                value={name}
                placeholder="Named after the people in it"
                onChange={(e) => setName(e.target.value)}
              />
            </>
          )}
          <p className="hint">
            🔒 Messages are end-to-end encrypted. Only the people in the conversation can
            read them, on devices that were set up before the message was sent. Files
            can’t be sent in direct messages yet.
          </p>
        </div>
        <div className="modal-foot">
          <button onClick={onClose}>Cancel</button>
          <button disabled={picked.length === 0 || busy} onClick={() => void submit()}>
            {confirmLabel(picked.length)}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Rename a group. Empty goes back to naming it after its people. */
export function RenameGroupModal({
  dm,
  onClose,
  onDone,
}: {
  dm: DirectMessageDto;
  onClose: () => void;
  onDone: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(dm.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    try {
      await onDone(name.trim());
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Could not rename the group.');
      setBusy(false);
    }
  }

  return (
    <div className="modal-wrap" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">Rename group</div>
        <div className="modal-body">
          {error && <div className="banner">{error}</div>}
          <label htmlFor="dm-rename">Group name</label>
          <input
            id="dm-rename"
            className="dm-pick-search"
            autoFocus
            maxLength={60}
            value={name}
            placeholder={dm.users.map(nameOf).join(', ')}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
              if (e.key === 'Escape') onClose();
            }}
          />
          <p className="hint">Everyone in the group sees the new name. The name itself is not encrypted.</p>
        </div>
        <div className="modal-foot">
          <button onClick={onClose}>Cancel</button>
          <button disabled={busy} onClick={() => void submit()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
