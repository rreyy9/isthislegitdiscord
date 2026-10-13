import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, type MemberActivityDto, type MemberDto } from '../api';
import { Avatar } from './Avatar';
import { durationLabel, lastSeenLabel, muteLabel, stamp, timeOf } from './chat-format';

/** Wide enough for "Online since" and a time without wrapping either. */
export const CARD_WIDTH = 260;
/** Gap between the card and the member column it hangs off. */
const CARD_GAP = 8;

/**
 * The profile card that opens beside a name in the member list.
 *
 * Two sources, on purpose. Whether somebody is online or away arrives live
 * through `member`, because presence events already keep the list current.
 * When they last did something does not -- it moves on every keystroke and is
 * never broadcast -- so the card asks for it once when it opens, and draws the
 * list's copy until the answer lands.
 *
 * Placed to the left of the row, because the member column is the right-hand
 * edge of the window, and nudged up if it would run off the bottom. The height
 * is measured rather than assumed, since a muted member or one in voice has
 * more rows than one who is neither.
 */
export function MemberCard({
  member,
  anchor,
  now,
  voiceChannel,
  onMouseEnter,
  onMouseLeave,
}: {
  member: MemberDto;
  /** The row's box, from getBoundingClientRect, when the card opened. */
  anchor: { top: number; left: number };
  now: number;
  /** Name of the voice channel they are in, or null. */
  voiceChannel: string | null;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const userId = member.user.id;
  const [fresh, setFresh] = useState<MemberActivityDto | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(anchor.top);

  useEffect(() => {
    let live = true;
    setFresh(null);
    api
      .memberActivity(userId)
      .then((a) => {
        if (live) setFresh(a);
      })
      .catch(() => {
        // An older server has no such route. The list's copy is a little
        // stale but it is the same kind of answer, so the card still works.
      });
    return () => {
      live = false;
    };
  }, [userId]);

  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0;
    setTop(Math.max(CARD_GAP, Math.min(anchor.top, window.innerHeight - height - CARD_GAP)));
  }, [anchor.top, member, fresh, voiceChannel]);

  const name = member.user.displayName || member.user.username;
  const online = member.online;
  const away = online && (member.away ?? false);
  const status = !online ? 'Offline' : away ? 'Away' : 'Online';
  const onlineSince = online ? (member.onlineSince ?? fresh?.onlineSince ?? null) : null;
  // Whichever is newer. A presence event can have moved the list's copy on
  // since the fetch was answered, and the fetch is newer than a list that was
  // built when the app opened.
  const lastActiveAt = newest(member.lastActiveAt ?? null, fresh?.lastActiveAt ?? null);

  return (
    <div
      ref={ref}
      className="member-card"
      style={{ left: anchor.left - CARD_WIDTH - CARD_GAP, top, width: CARD_WIDTH }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mc-head">
        <div className="mc-avatar">
          <Avatar name={name} image={member.user.image} size={80} />
          <div className={'mc-dot ' + (!online ? 'off' : away ? 'away' : 'on')} />
        </div>
        <div className="mc-names">
          <div className="mc-name">{name}</div>
          <div className="mc-user">@{member.user.username}</div>
          <div className="mc-badges">
            <span className={'mc-status ' + (!online ? 'off' : away ? 'away' : 'on')}>
              {status}
            </span>
            {member.role === 'ADMIN' && <span className="mc-role">Admin</span>}
          </div>
        </div>
      </div>

      <dl className="mc-rows">
        {onlineSince ? (
          <Row label="Online since" title={stamp(onlineSince)}>
            {sinceLabel(onlineSince)} · {durationLabel(onlineSince, now)}
          </Row>
        ) : (
          !online &&
          member.lastSeenAt && (
            <Row label="Last seen" title={stamp(member.lastSeenAt)}>
              {lastSeenLabel(member.lastSeenAt, now)}
            </Row>
          )
        )}
        <Row label="Last active" title={lastActiveAt ? stamp(lastActiveAt) : undefined}>
          {lastActiveAt ? lastSeenLabel(lastActiveAt, now) : 'Unknown'}
        </Row>
        {voiceChannel && <Row label="In voice">🔊 {voiceChannel}</Row>}
        {member.mutedUntil && <Row label="Muted">{muteLabel(member.mutedUntil)}</Row>}
        {member.joinedAt && (
          <Row label="Member since" title={stamp(member.joinedAt)}>
            {new Date(member.joinedAt).toLocaleDateString([], {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })}
          </Row>
        )}
      </dl>
    </div>
  );
}

function Row({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mc-row">
      <dt>{label}</dt>
      <dd title={title}>{children}</dd>
    </div>
  );
}

/** "18:42" today, "Yesterday at 23:10" otherwise. */
function sinceLabel(iso: string) {
  return new Date(iso).toDateString() === new Date().toDateString()
    ? timeOf(iso)
    : stamp(iso);
}

function newest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a) > new Date(b) ? a : b;
}
