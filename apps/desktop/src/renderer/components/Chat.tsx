import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  setToken,
  type BanDto,
  type ChannelDto,
  type GuildDto,
  type MemberDto,
  type MessageDto,
  type Me,
  type PublicUserDto,
} from '../api';
import { MessageContent } from './MessageContent';
import {
  applyMention,
  matchUsers,
  mentionName,
  mentionQuery,
  parseMentionIds,
  toMarkup,
  toPlain,
  type MentionQuery,
  type MentionUser,
} from '../mention-utils';
import { playPing } from '../ping';
import {
  connectSocket,
  disconnectSocket,
  joinChannel,
  leaveChannel,
  typingStart,
  typingStop,
} from '../socket';
import { bridge } from '../bridge';
import { noteUpdateAvailable } from '../updates';
import { useVoice, type VoiceSettings } from '../voice';
import type { NotificationSettings } from '../../preload';
import {
  ScreenPicker,
  ScreenStage,
  SettingsModal,
  UserVolumeMenu,
  VoicePanel,
} from './Voice';
import { Avatar } from './Avatar';
import { useImageActions } from './ImageViewer';
import { NetworkButton } from './NetworkStats';

type Status = 'connected' | 'disconnected' | 'connecting';

/**
 * A message plus client-only fields for optimistic rendering: `pending` while
 * the server has not confirmed it, and `previews` so a pasted image is visible
 * immediately rather than after the round trip.
 */
type Msg = MessageDto & { pending?: boolean; previews?: string[] };

function timeOf(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
/** Today and Yesterday by name; anything older gets its date. */
function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const midnight = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(today) - midnight(d)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString([], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}
const sameDay = (a: string, b: string) =>
  new Date(a).toDateString() === new Date(b).toDateString();
/**
 * "Today at 14:32", "12 March at 09:10". The pin board is read out of order
 * by definition — the whole list is old messages — so every row there has to
 * carry its own date rather than lean on a separator above it.
 */
const stamp = (iso: string) => `${dayLabel(iso)} at ${timeOf(iso)}`;

/**
 * An indefinite mute is stored as a date in the year 9999, so that every check
 * is one comparison. Nobody wants to read that date, hence this.
 */
const isForever = (iso: string) => new Date(iso).getFullYear() > 9000;

/**
 * What a mute says. "Microphone", explicitly, every time it is written: the
 * word "muted" on its own reads as "silenced everywhere", which is what this
 * used to do and no longer does.
 */
function muteLabel(iso: string) {
  if (isForever(iso)) return 'Microphone muted indefinitely';
  const d = new Date(iso);
  const sameDayAsNow = d.toDateString() === new Date().toDateString();
  return `Microphone muted until ${
    sameDayAsNow
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleString([], {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })
  }`;
}

/**
 * How long ago somebody was last here, in the smallest number of characters
 * that answers the question.
 *
 * Coarse on purpose, and coarser the further back it goes: under a name in a
 * narrow column, "2h" is the whole of what anyone wants to know, and the exact
 * minute of an absence three days old is noise. Anything past a week stops
 * being a duration and becomes a date, because "23d" is not something people
 * read as a length of time.
 *
 * `now` is passed in rather than read here so that every row in one render
 * measures from the same instant, and so the caller controls how often the
 * whole column re-renders.
 */
function lastSeenLabel(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/**
 * A clock that ticks once a minute.
 *
 * The member list draws durations, and a duration that was rendered once is
 * wrong a minute later. A minute is also the resolution of the shortest label
 * it produces, so nothing finer would show.
 */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** The menu is drawn against the viewport, so its box has to be known up front. */
const MENU_WIDTH = 158;
const MENU_HEIGHT = 265;

/** Same, for the account menu — which opens upwards, out of the footer. */
const ACCOUNT_MENU_HEIGHT = 42;

const MUTE_OPTIONS: { label: string; minutes: number | null }[] = [
  { label: '5 minutes', minutes: 5 },
  { label: '1 hour', minutes: 60 },
  { label: '1 day', minutes: 60 * 24 },
  { label: '1 week', minutes: 60 * 24 * 7 },
  { label: 'Indefinitely', minutes: null },
];

/** What a confirm modal needs to know. Kick, ban and delete all use it. */
interface Confirmation {
  title: string;
  body: string;
  confirmLabel: string;
  run: () => Promise<void>;
}

export function Chat({
  me,
  onMeChanged,
  onSignOut,
}: {
  me: Me;
  /** Your own profile changed — here, or on another machine you are signed in on. */
  onMeChanged: (me: Me) => void;
  onSignOut: () => void;
}) {
  const [guilds, setGuilds] = useState<GuildDto[]>([]);
  const [members, setMembers] = useState<MemberDto[]>([]);
  /** Drives the "last seen" durations in the member list; see useMinuteClock. */
  const now = useMinuteClock();
  const [activeChannel, setActiveChannel] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [draft, setDraft] = useState('');
  const [typingUsers, setTypingUsers] = useState<Record<string, number>>({});
  /** Occupants of every voice channel, from the server's LiveKit webhooks. */
  const [voiceByChannel, setVoiceByChannel] = useState<Record<string, string[]>>({});
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>({
    inputDeviceId: null,
    outputDeviceId: null,
    pushToTalk: false,
    pttBinding: null,
    pttLabel: null,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    gateMode: 'off',
    gateThreshold: -45,
    userVolumes: {},
    rejoinLastChannel: false,
  });
  /** Settings arrive from main, so nothing that reads them may act before. */
  const [settingsReady, setSettingsReady] = useState(false);
  /** The voice channel this client was in when it last stopped, if any. */
  const [lastVoiceChannelId, setLastVoiceChannelId] = useState<string | null>(
    null,
  );
  /** A call an update interrupted, owed back on this launch. See below. */
  const [rejoinAfterUpdate, setRejoinAfterUpdate] = useState<string | null>(
    null,
  );
  /** The text channel that was open when the app last closed, if any. */
  const [lastTextChannelId, setLastTextChannelId] = useState<string | null>(
    null,
  );
  /**
   * Whether the message list is parked at the bottom. Everything about new
   * messages hangs off this: scrolled to the end, they push the view along;
   * scrolled back, they leave the reader where they are and light up the
   * jump button instead.
   */
  const [atBottom, setAtBottom] = useState(true);
  /** A message arrived while the reader was scrolled back up. */
  const [hasNew, setHasNew] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  /** Images pasted or dropped, held locally until the message is sent. */
  const [pending, setPending] = useState<{ file: File; preview: string }[]>([]);
  /** channelId -> last message id this user has read. */
  const [reads, setReads] = useState<Record<string, string>>({});
  /** Newest message id seen per channel, so unread is a comparison of two ids. */
  const [latest, setLatest] = useState<Record<string, string>>({});
  /**
   * channelId -> how many unread tags it holds. Kept apart from `reads`
   * because the two say different things: a channel with new messages is worth
   * a look eventually, and a channel where somebody has said your name is
   * worth a look now. One is a dot; this one is a number.
   */
  const [mentionCounts, setMentionCounts] = useState<Record<string, number>>({});
  /** What the app may do when somebody tags you. Persisted in settings.json. */
  const [notifications, setNotifications] = useState<NotificationSettings>({
    mentions: true,
    sound: true,
  });
  /**
   * The tag being typed in the composer, and which row of the list is
   * selected. Null whenever the popup is closed, which is most of the time.
   */
  const [mentionPicker, setMentionPicker] = useState<
    (MentionQuery & { index: number }) | null
  >(null);
  /** The message currently open for editing, and its working copy. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  /**
   * Which member's moderation menu is open, and where to draw it. The members
   * list scrolls, so the menu is positioned against the viewport rather than
   * the row — inside the scroll box it would be clipped.
   */
  const [menuFor, setMenuFor] = useState<{
    userId: string;
    x: number;
    y: number;
  } | null>(null);
  /** Whose per-person volume popup is open, and where to draw it. */
  const [volumeFor, setVolumeFor] = useState<{
    userId: string;
    x: number;
    y: number;
  } | null>(null);
  /**
   * Whether the account menu in the footer is open, and where its button is.
   * Settings used to be reachable only from the voice panel, which appears
   * only once you are in a call — so the one screen that decides which
   * microphone you speak into could not be opened before speaking.
   */
  const [accountMenu, setAccountMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  /**
   * Admin only. Right-click menu on a channel row, and the dialog behind it.
   * Creating and renaming share one dialog because they are the same form —
   * a name, and for a new one the kind, which the section it was started from
   * has already decided.
   */
  const [channelMenu, setChannelMenu] = useState<{
    channel: ChannelDto;
    x: number;
    y: number;
  } | null>(null);
  const [channelEdit, setChannelEdit] = useState<
    | { mode: 'create'; guildId: string; kind: ChannelDto['kind'] }
    | { mode: 'rename'; channel: ChannelDto }
    | null
  >(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [showBans, setShowBans] = useState(false);
  /**
   * The pin board: whether it is open, and what is on it.
   *
   * Fetched when it is opened rather than on every channel switch. The icon in
   * the header is there whether or not anything is pinned — the same way
   * Discord's is — so nothing on screen depends on knowing the answer before
   * somebody asks for it, and the switch costs one query less.
   */
  const [pinsOpen, setPinsOpen] = useState(false);
  const [pins, setPins] = useState<MessageDto[] | null>(null);
  const [pinsError, setPinsError] = useState<string | null>(null);
  /**
   * Bumped whenever the board is known to be stale — a pin, an unpin, or
   * somebody else's. State rather than a call, because the socket handlers are
   * registered once and a loader captured there would be frozen on the channel
   * that happened to be open at the time.
   */
  const [pinsVersion, setPinsVersion] = useState(0);
  /** Set when the server says we were kicked or banned; the app stops here. */
  const [removed, setRemoved] = useState<{
    kind: 'kick' | 'ban';
    reason: string | null;
  } | null>(null);
  /** A refused moderation action, shown briefly rather than swallowed. */
  const [banner, setBanner] = useState<string | null>(null);

  /**
   * Our own row in the member list is where the client learns both its role
   * and its mute — there is no separate "who am I allowed to do things to"
   * call, and every check the UI makes is repeated on the server anyway.
   *
   * Read this early because the voice hook needs the mute: it decides whether
   * to open the microphone at all, and the answer has to be ready before the
   * first render that could join a call.
   */
  const myMember = members.find((m) => m.user.id === me.id);
  const iAmAdmin = myMember?.role === 'ADMIN';
  const myMutedUntil = myMember?.mutedUntil ?? null;
  /**
   * An admin has taken our microphone away.
   *
   * The server is what actually enforces it — the join token carries no right
   * to publish audio — so this is not the enforcement. It is what stops the
   * client from opening the capture device and offering a track that would be
   * refused, and what puts a reason on screen instead of a mic button that
   * looks live and changes nothing.
   */
  const iAmMuted = Boolean(myMutedUntil && new Date(myMutedUntil) > new Date());

  const voice = useVoice(voiceSettings, iAmMuted);

  // Main needs to know, because an update that lands mid-call has to leave the
  // channel properly before the process is taken away — and because the
  // banner says so before the button is pressed.
  useEffect(() => {
    void bridge.setInCall(voice.channelId !== null);
  }, [voice.channelId]);

  /**
   * The channel an update took us out of, held here as well as in settings.
   *
   * On disk it is what the new build reads on the way back up. In memory it is
   * what puts us back if the install never happens — a declined UAC prompt
   * leaves this app running, and it would be a poor trade to have quietly
   * dropped somebody out of a call for an update that did not occur.
   */
  const leftForUpdateRef = useRef<string | null>(null);

  /**
   * Leave the call on main's say-so, and answer when it is done.
   *
   * The answer is the point: main is waiting on it, because a process killed
   * mid-call leaves a participant sitting in the room until LiveKit times the
   * connection out. `voice.leave` awaits the disconnect, so by the time this
   * replies, the channel really is empty of us.
   */
  useEffect(
    () =>
      bridge.onLeaveVoiceForUpdate(() => {
        void (async () => {
          const channelId = voice.channelId;
          leftForUpdateRef.current = channelId;
          if (channelId) {
            // Written before the leave rather than after: this is the record
            // the new build reads, and the app may be killed at any point once
            // main has its answer.
            await bridge.setSettings({ rejoinAfterUpdate: channelId });
            await voice.leave();
          }
          await bridge.voiceLeftForUpdate();
        })();
      }),
    [voice.channelId, voice.leave],
  );

  /** The install fell through; put back the call it was given up for. */
  useEffect(
    () =>
      bridge.onRejoinVoiceAfterUpdate(() => {
        const channelId = leftForUpdateRef.current;
        leftForUpdateRef.current = null;
        void bridge.setSettings({ rejoinAfterUpdate: null });
        if (channelId) void voice.join(channelId);
      }),
    [voice.join],
  );

  const msgsRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  /**
   * Ids chosen from the tag list while writing this message.
   *
   * The draft holds names, not ids — it is a plain textarea — so the ids are
   * worked out again on the way out. That is unambiguous except when two
   * people answer to the same string, and this is what settles it: the one
   * actually clicked wins. A ref rather than state because nothing on screen
   * depends on it, and it is cleared with the draft.
   */
  const pickedRef = useRef<Set<string>>(new Set());
  /**
   * The exact draft and caret a pick just produced.
   *
   * Completing a tag leaves the caret just past "@John Smith ", and walking
   * back from there finds an `@` followed by a name that matches perfectly —
   * so the list would reopen on the tag that was just finished. Anything typed
   * afterwards changes the text or moves the caret, and the list is free
   * again.
   */
  const justPickedRef = useRef<{ text: string; caret: number } | null>(null);
  const activeChannelRef = useRef<string | null>(null);
  /**
   * `loadReads` is redeclared every render, and the socket handlers are
   * registered once -- so a guild refresh triggered by a socket event has to
   * reach the current one through a ref, not the one that existed at mount.
   */
  const loadReadsRef = useRef<(gs?: GuildDto[]) => Promise<void>>(async () => {});
  const lastSeenIdRef = useRef<string | null>(null);
  const typingSentRef = useRef(false);
  /**
   * channelId -> the message the reader had got to. Held in a ref rather than
   * in state because it is written on every scroll frame and read only when a
   * channel opens; nothing on screen depends on it.
   */
  const positionsRef = useRef<Record<string, string>>({});
  const atBottomRef = useRef(true);
  /** Pending debounced write of `positionsRef` to settings.json. */
  const saveTimerRef = useRef<number | null>(null);

  activeChannelRef.current = activeChannel;
  /**
   * The socket handlers are registered once, on mount, so anything they read
   * has to be read through a ref or it is frozen at whatever it was then —
   * and these are switches somebody flips while the app is running.
   */
  const notificationsRef = useRef(notifications);
  notificationsRef.current = notifications;
  /** Same reason: a tag arriving has to resolve names against the live list. */
  const membersRef = useRef<MemberDto[]>(members);
  membersRef.current = members;

  const activeChannelObj = guilds
    .flatMap((g) => g.channels)
    .find((c) => c.id === activeChannel);

  /* ---------------------------------------------------------- mentions */

  /** Everyone who can be tagged: the member list, in the shape the helpers use. */
  const mentionUsers = useMemo<MentionUser[]>(
    () => members.map((m) => m.user),
    [members],
  );

  /**
   * A `<@id>` to the name to draw for it.
   *
   * Resolved at draw time rather than baked into the message, which is the
   * whole reason ids travel on the wire: somebody renames themselves and every
   * message that ever tagged them says the new name, with nothing rewritten.
   *
   * Memoised on the member list because it runs once per tag per message on
   * every render of the list.
   */
  const lookupMention = useMemo(() => {
    const byId = new Map(members.map((m) => [m.user.id, m.user]));
    return (id: string) => {
      const user = byId.get(id);
      if (!user) return null;
      return { name: mentionName(user), self: id === me.id };
    };
  }, [members, me.id]);

  /** One tagged id back to the person, for turning markers into names. */
  const lookupUser = useCallback(
    (id: string): MentionUser | null =>
      members.find((m) => m.user.id === id)?.user ?? null,
    [members],
  );

  /** What is in the tag list right now, for the query being typed. */
  const mentionMatches = useMemo(
    () => (mentionPicker ? matchUsers(mentionUsers, mentionPicker.query) : []),
    [mentionPicker, mentionUsers],
  );

  /* ------------------------------------------------------ initial + socket */

  useEffect(() => {
    void bridge.getSettings().then((s) => {
      setVoiceSettings(s.voice);
      setNotifications(s.notifications);
      setLastVoiceChannelId(s.lastVoiceChannelId);
      setRejoinAfterUpdate(s.rejoinAfterUpdate);
      setLastTextChannelId(s.lastTextChannelId);
      positionsRef.current = s.chatPositions;
      setSettingsReady(true);
    });
  }, []);

  /** Clicking a notification takes you to the message it was about. */
  useEffect(
    () => bridge.onNotificationActivate(({ channelId }) => setActiveChannel(channelId)),
    [],
  );

  /**
   * The number on the dock or launcher icon, where the OS draws one.
   *
   * Every unread tag across every channel, because that is what an icon badge
   * means everywhere else: not "something happened", but "this many things are
   * waiting for you".
   */
  useEffect(() => {
    const total = Object.values(mentionCounts).reduce((a, b) => a + b, 0);
    void bridge.setBadgeCount(total);
  }, [mentionCounts]);

  async function updateNotifications(patch: Partial<NotificationSettings>) {
    const next = { ...notifications, ...patch };
    setNotifications(next);
    await bridge.setSettings({ notifications: next });
  }

  /** Persisted in main's settings.json, and applied to a live call at once. */
  async function updateVoiceSettings(patch: Partial<VoiceSettings>) {
    const next = { ...voiceSettings, ...patch };
    setVoiceSettings(next);
    await bridge.setSettings({ voice: next });
    if (patch.inputDeviceId) await voice.setInputDevice(patch.inputDeviceId);
    if (patch.outputDeviceId) await voice.setOutputDevice(patch.outputDeviceId);
  }

  /** One person's playback level. 100% is stored as no entry at all. */
  function setUserVolume(userId: string, volume: number) {
    const next = { ...voiceSettings.userVolumes };
    if (volume >= 1) delete next[userId];
    else next[userId] = volume;
    void updateVoiceSettings({ userVolumes: next });
  }

  /**
   * Joining and leaving voice both go through here, so that "the channel I was
   * in" is written down at the moment it changes. Leaving clears it: walking
   * out of a channel on purpose and being put back in on the next launch is
   * not what the setting offers.
   */
  function joinVoice(channelId: string) {
    setLastVoiceChannelId(channelId);
    void bridge.setSettings({ lastVoiceChannelId: channelId });
    void voice.join(channelId);
  }

  function leaveVoice() {
    setLastVoiceChannelId(null);
    void bridge.setSettings({ lastVoiceChannelId: null });
    void voice.leave();
  }

  /**
   * The guild list, refetched whole rather than patched.
   *
   * The server answers with the channels this account may see, already in
   * order, so a refetch is correct for every way the list can change -- a
   * channel added, renamed, reordered or deleted -- where a delta would need a
   * separate event per operation and a copy of the sort on this side.
   */
  const loadGuilds = useCallback(async () => {
    const gs = await api.guilds();
    setGuilds(gs);
    return gs;
  }, []);

  /**
   * Pending coalesce of `guild:changed`. An admin adding three channels in a
   * row fires three events, and every connected client would otherwise refetch
   * three times; the list is only ever read whole, so the last one wins.
   */
  const guildReloadRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (guildReloadRef.current !== null) {
        window.clearTimeout(guildReloadRef.current);
      }
    },
    [],
  );

  /**
   * Reload the list, then the unread marks for it.
   *
   * The second half is not optional: unread is `latest > lastRead`, and a
   * channel this client has never heard of has no entry on either side -- so
   * without this a brand new channel would sit there with no dot until the app
   * was restarted, which is most of the bug this is here to fix.
   */
  const refreshGuilds = useCallback(async () => {
    try {
      const gs = await loadGuilds();
      await loadReadsRef.current(gs);
      return gs;
    } catch {
      /* a failed refresh leaves the old list; the next event tries again */
      return null;
    }
  }, [loadGuilds]);

  const loadMembers = useCallback(async () => {
    try {
      const rows = await api.members();
      // The server returns one row per membership, so anyone who belongs to
      // two guilds arrives twice. This panel lists people, not memberships —
      // and duplicate React keys are how that first showed up.
      const byUser = new Map<string, MemberDto>();
      for (const m of rows) {
        const seen = byUser.get(m.user.id);
        // Keep the admin row if they hold the role in any guild.
        if (!seen || (seen.role !== 'ADMIN' && m.role === 'ADMIN')) {
          byUser.set(m.user.id, m);
        }
      }
      setMembers([...byUser.values()]);
    } catch {
      /* ignore */
    }
  }, []);

  /**
   * Somebody's display name or picture changed: redraw them everywhere.
   *
   * Everywhere is the point. A user is drawn from three different copies of
   * themselves — the member list, the author on each loaded message, and the
   * author on each pin — and a rename that reached only the first would leave
   * the old name sitting on every message they had already sent, until a
   * reload nobody has a reason to do.
   *
   * `@` mentions are not in that list because they never needed to be: those
   * travel as ids and are resolved against the member list at draw time.
   */
  const applyUserUpdate = useCallback(
    (u: PublicUserDto) => {
      const patch = <T extends { author: MessageDto['author'] }>(rows: T[]) =>
        rows.map((row) =>
          row.author.id === u.id
            ? {
                ...row,
                author: {
                  ...row.author,
                  displayName: u.displayName,
                  image: u.image,
                },
              }
            : row,
        );

      setMembers((prev) =>
        prev.map((m) =>
          m.user.id === u.id
            ? {
                ...m,
                user: {
                  ...m.user,
                  displayName: u.displayName,
                  image: u.image,
                },
              }
            : m,
        ),
      );
      setMessages(patch);
      setPins((prev) => (prev ? patch(prev) : prev));
      if (u.id === me.id) onMeChanged(u);
    },
    [me.id, onMeChanged],
  );

  useEffect(() => {
    (async () => {
      const gs = await loadGuilds();
      await loadMembers();
      // A client starting up mid-call would otherwise see empty voice channels
      // until the next person joined or left.
      await loadVoiceState();
      await loadReads(gs);
      await loadMentions();
    })();

    connectSocket({
      onStatus: setStatus,
      onMessage: (m) => {
        // Recorded for every channel, not just the open one: that is what
        // makes the unread dot appear on a channel you are not looking at.
        setLatest((prev) =>
          !prev[m.channelId] || m.id > prev[m.channelId]
            ? { ...prev, [m.channelId]: m.id }
            : prev,
        );
        if (m.channelId !== activeChannelRef.current) return;
        setMessages((prev) => {
          // Replace our own optimistic copy when the echo arrives (matched by
          // clientNonce); otherwise append. Guard against double-delivery.
          if (m.clientNonce) {
            const i = prev.findIndex((x) => x.clientNonce === m.clientNonce);
            if (i >= 0) {
              const next = prev.slice();
              next[i] = m;
              return next;
            }
          }
          if (prev.some((x) => x.id === m.id)) return prev;
          return [...prev, m];
        });
        lastSeenIdRef.current = m.id;
        // Reading the end of the channel means following it; reading further
        // back means being left there, with the jump button to say why.
        if (atBottomRef.current) requestAnimationFrame(scrollToBottom);
        else setHasNew(true);
        void markRead(m.channelId, m.id);
      },
      onMessageUpdated: (m) =>
        setMessages((prev) =>
          prev.map((x) => (x.id === m.id ? { ...x, ...m } : x)),
        ),
      // Deleted messages are removed outright rather than tombstoned: history
      // filters them server-side too, so a reload would not bring them back.
      onMessageDeleted: ({ id }) => {
        setMessages((prev) => prev.filter((x) => x.id !== id));
        // A deleted message is off the board too. The server already filters
        // it out of the list; this is what takes it off the one on screen.
        setPins((prev) => prev?.filter((x) => x.id !== id) ?? prev);
      },
      onPinChanged: ({ channelId, messageId, pinnedAt }) => {
        if (channelId !== activeChannelRef.current) return;
        setMessages((prev) =>
          prev.map((x) => (x.id === messageId ? { ...x, pinnedAt } : x)),
        );
        // The board is re-asked for rather than patched: an unpin removes a
        // row this client may never have had, and a pin adds one that may be a
        // thousand messages further back than anything loaded.
        setPinsVersion((v) => v + 1);
      },
      onMention: ({ message, channelName }) => {
        // The badge counts what is still unread. A tag in the channel that is
        // open is not: `onMessage` marks it read as it arrives, so counting it
        // here would light a number that the next render immediately clears.
        if (message.channelId !== activeChannelRef.current) {
          setMentionCounts((prev) => ({
            ...prev,
            [message.channelId]: (prev[message.channelId] ?? 0) + 1,
          }));
        }
        announceMention(message, channelName);
      },
      onMemberUpdated: ({ userId, mutedUntil }) =>
        setMembers((prev) =>
          prev.map((m) => (m.user.id === userId ? { ...m, mutedUntil } : m)),
        ),
      onRemoved: (p) => {
        // The server has already cut the socket loose; stop reconnecting to a
        // guild we are no longer in.
        setRemoved({ kind: p.kind, reason: p.reason });
        disconnectSocket();
      },
      onGuildChanged: () => {
        // Debounced rather than immediate: see `guildReloadRef`.
        if (guildReloadRef.current !== null) {
          window.clearTimeout(guildReloadRef.current);
        }
        guildReloadRef.current = window.setTimeout(() => {
          guildReloadRef.current = null;
          void refreshGuilds();
        }, 250);
      },
      onUserUpdated: applyUserUpdate,
      onPresence: ({ userId, online, lastSeenAt }) => {
        // Applied here rather than waited for: the dot and the duration under
        // a name are the whole of what this event changes, and both are in
        // the payload, so neither has to sit wrong for a round trip.
        setMembers((prev) =>
          prev.map((m) =>
            m.user.id === userId ? { ...m, online, lastSeenAt } : m,
          ),
        );
        // Still refetched, because presence is also the first thing heard
        // about somebody who has joined the server since this list was built.
        void loadMembers();
      },
      // Forwarded to the update banner, which lives above this component.
      onUpdateAvailable: ({ version }) => noteUpdateAvailable(version),
      onVoiceParticipants: ({ channelId, userIds }) =>
        setVoiceByChannel((prev) => {
          if (userIds.length === 0) {
            const { [channelId]: _gone, ...rest } = prev;
            return rest;
          }
          return { ...prev, [channelId]: userIds };
        }),
      onTyping: ({ channelId, userId, typing }) => {
        if (channelId !== activeChannelRef.current || userId === me.id) return;
        setTypingUsers((prev) => {
          const next = { ...prev };
          if (typing) next[userId] = Date.now();
          else delete next[userId];
          return next;
        });
      },
      onReconnected: () => {
        // Backfill anything missed while the socket was down.
        const ch = activeChannelRef.current;
        if (ch) void backfill(ch);
        void loadMembers();
        void loadVoiceState();
        // Channels added or removed while this client was away produced an
        // event nobody was there to hear, so the list is re-asked for rather
        // than repaired -- and it carries the unread marks with it, which is
        // why there is no `loadReads` of its own here.
        void refreshGuilds();
        // Tags that arrived while the socket was down produced no event, so
        // the counts are re-asked for rather than repaired.
        void loadMentions();
        // Same for pins: an event missed while offline cannot be replayed.
        setPinsVersion((v) => v + 1);
      },
    });

    return () => disconnectSocket();
  }, [applyUserUpdate, loadMembers, refreshGuilds, me.id]);

  // Expire stale typing indicators (a client that died mid-type).
  useEffect(() => {
    const t = setInterval(() => {
      setTypingUsers((prev) => {
        const cutoff = Date.now() - 6000;
        const next: Record<string, number> = {};
        for (const [k, v] of Object.entries(prev)) if (v > cutoff) next[k] = v;
        return Object.keys(next).length === Object.keys(prev).length ? prev : next;
      });
    }, 2000);
    return () => clearInterval(t);
  }, []);

  /**
   * A mute lifts on a deadline, and nothing pushes an event when it passes —
   * so wake up once at the deadline and refresh, or the panel would go on
   * saying the microphone is gone until the next reconnect. The server hands
   * it back on its own sweep; this is only about what is drawn.
   */
  useEffect(() => {
    if (!myMutedUntil || isForever(myMutedUntil)) return;
    const ms = new Date(myMutedUntil).getTime() - Date.now();
    if (ms <= 0) return;
    // setTimeout overflows past ~24.8 days and fires immediately; a mute that
    // far out can wait for the next reload.
    if (ms > 2_000_000_000) return;
    const t = setTimeout(() => void loadMembers(), ms + 500);
    return () => clearTimeout(t);
  }, [myMutedUntil, loadMembers]);

  /**
   * Walk back into a voice channel this client was in before it stopped.
   *
   * Two reasons to, and they are not the same thing. `rejoinLastChannel` is a
   * standing preference: put me back where I was, every launch. Anything in
   * `rejoinAfterUpdate` is a debt from one particular restart — an update
   * closed a call that was in progress — and it is paid whether or not that
   * preference is on, because nobody chose to leave.
   *
   * Guarded by a ref rather than by state because it has to happen exactly
   * once. The guild list and the settings arrive independently, so this runs
   * again when the second of them lands — and by then somebody may already
   * have left the channel it is about to put them back into.
   */
  const rejoinedRef = useRef(false);
  useEffect(() => {
    if (rejoinedRef.current || !settingsReady) return;
    // Nothing can be decided before the channel list is here, including
    // whether a stored id is stale.
    if (guilds.length === 0) return;

    const target =
      rejoinAfterUpdate ??
      (voiceSettings.rejoinLastChannel ? lastVoiceChannelId : null);

    // A debt is settled by this pass either way. The channel may have been
    // deleted, or we may have been kicked out of it while the app was down;
    // that is an answer, not a reason to try again on some later launch.
    if (rejoinAfterUpdate) {
      setRejoinAfterUpdate(null);
      void bridge.setSettings({ rejoinAfterUpdate: null });
    }
    if (!target) return;

    const channel = guilds
      .flatMap((g) => g.channels)
      .find((c) => c.id === target && c.kind === 'VOICE');
    // For the standing preference, a channel that is not there is left alone
    // and tried again next time.
    if (!channel) return;
    rejoinedRef.current = true;
    void voice.join(channel.id);
  }, [
    guilds,
    settingsReady,
    voiceSettings.rejoinLastChannel,
    lastVoiceChannelId,
    rejoinAfterUpdate,
    voice.join,
  ]);

  // Any click outside the moderation menu closes it, the way a menu should.
  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuFor]);

  // Same for the volume popup.
  useEffect(() => {
    if (!volumeFor) return;
    const close = () => setVolumeFor(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [volumeFor]);

  // And for the account menu.
  useEffect(() => {
    if (!accountMenu) return;
    const close = () => setAccountMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [accountMenu]);

  // And for the channel menu.
  useEffect(() => {
    if (!channelMenu) return;
    const close = () => setChannelMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [channelMenu]);

  // And for the pin board, which is a popover under the header like the rest.
  useEffect(() => {
    if (!pinsOpen) return;
    const close = () => setPinsOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [pinsOpen]);

  /**
   * Fetch the board while it is open — on opening it, on switching channel
   * with it open, and whenever `pinsVersion` says it has gone stale.
   *
   * The old list is left on screen until the new one lands, so a pin arriving
   * while somebody is reading does not blank the panel under them.
   */
  useEffect(() => {
    if (!pinsOpen || !activeChannel) return;
    let cancelled = false;
    setPinsError(null);
    (async () => {
      try {
        const rows = await api.pins(activeChannel);
        if (!cancelled) setPins(rows);
      } catch (e: any) {
        if (cancelled) return;
        setPinsError(e?.message ?? 'Could not load the pinned messages.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pinsOpen, activeChannel, pinsVersion]);

  // Errors from a refused action are worth reading, not worth keeping.
  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 5000);
    return () => clearTimeout(t);
  }, [banner]);

  /* --------------------------------------------------------- channel load */

  /**
   * Reopen the channel that was on screen when the app last closed, once the
   * guild list and the stored settings are both in. Guarded by a ref because
   * it must happen exactly once: after this, the channel is whichever one the
   * reader has clicked since.
   */
  const reopenedRef = useRef(false);
  useEffect(() => {
    if (reopenedRef.current || !settingsReady || guilds.length === 0) return;
    reopenedRef.current = true;
    const texts = guilds.flatMap((g) => g.channels).filter((c) => c.kind === 'TEXT');
    // A channel that has since been deleted falls back to the first one,
    // which is where a first-ever launch starts anyway.
    const target = texts.find((c) => c.id === lastTextChannelId) ?? texts[0];
    if (target) setActiveChannel(target.id);
  }, [guilds, settingsReady, lastTextChannelId]);

  /**
   * A channel can vanish under the reader — an admin deletes it, here or in
   * the console — and until the list is repaired what is left is a dead id:
   * the header names a channel that is gone, sending 404s, with no row in the
   * sidebar to click instead. So whenever the list changes, check that what is
   * open is still in it.
   *
   * Keyed on the list rather than done inside the socket handler on purpose:
   * it then covers every way the list can change, including the refetch on
   * reconnect, without the check being written twice.
   */
  useEffect(() => {
    if (guilds.length === 0) return;
    const channels = guilds.flatMap((g) => g.channels);

    if (activeChannel && !channels.some((c) => c.id === activeChannel)) {
      const texts = channels.filter((c) => c.kind === 'TEXT');
      setActiveChannel(texts[0]?.id ?? null);
    }
    // The call is already over — the server closes the room with the channel —
    // but this client would sit in it holding a dead track and a panel naming
    // somewhere that no longer exists.
    if (voice.channelId && !channels.some((c) => c.id === voice.channelId)) {
      leaveVoice();
    }
  }, [guilds, activeChannel, voice.channelId]);

  /** Remember which channel to come back to. */
  useEffect(() => {
    if (!activeChannel) return;
    void bridge.setSettings({ lastTextChannelId: activeChannel });
  }, [activeChannel]);

  /**
   * How many extra pages of history to walk back through looking for the
   * message the reader was last on. Far enough to cover a channel left in the
   * middle of a busy evening, short enough that opening one never hangs.
   */
  const MAX_RESTORE_PAGES = 5;

  useEffect(() => {
    // Settings carry the reading position, so a channel opened before they
    // land would open at the bottom and then overwrite it.
    if (!activeChannel || !settingsReady) return;
    let cancelled = false;
    joinChannel(activeChannel);
    setMessages([]);
    setTypingUsers({});
    setHasNew(false);
    clearPending();
    // The board belongs to the channel it was opened from, so it closes with
    // it rather than hanging over the next one showing the wrong pins.
    setPinsOpen(false);
    setPins(null);
    (async () => {
      const anchor = positionsRef.current[activeChannel] ?? null;
      const page = await api.history(activeChannel);
      if (cancelled) return;
      let loaded = page.messages;
      let next = page.nextCursor;
      // Page back until the remembered message is in hand. Ids are UUIDv7, so
      // "older than everything loaded" is a plain string compare — and an
      // anchor newer than the oldest loaded message that still is not there
      // was deleted, so there is nothing to page back to.
      for (let i = 0; anchor && next && i < MAX_RESTORE_PAGES; i++) {
        if (loaded.some((m) => m.id === anchor)) break;
        if (loaded.length > 0 && anchor > loaded[0].id) break;
        const older = await api.history(activeChannel, next);
        if (cancelled) return;
        loaded = [...older.messages, ...loaded];
        next = older.nextCursor;
      }
      setMessages(loaded);
      setCursor(next);
      const last = loaded[loaded.length - 1];
      lastSeenIdRef.current = last?.id ?? null;
      if (last) {
        setLatest((prev) => ({ ...prev, [activeChannel]: last.id }));
        void markRead(activeChannel, last.id);
      }
      requestAnimationFrame(() => {
        // Nothing to restore to if the reader was already at the end.
        const restored =
          Boolean(anchor) && anchor !== last?.id && scrollToMessage(anchor!);
        if (!restored) scrollToBottom();
        holdAt(restored ? anchor : null);
        updateScrollState();
      });
    })();
    return () => {
      cancelled = true;
      releaseHold();
      leaveChannel(activeChannel);
    };
  }, [activeChannel, settingsReady]);

  /**
   * Read state plus the newest message id per channel. Both are needed: unread
   * is `latest > lastRead`, and ids are UUIDv7 so that comparison is a string
   * compare with no timestamps involved.
   */
  async function loadReads(guildList?: GuildDto[]) {
    try {
      const rows = await api.reads();
      setReads(
        Object.fromEntries(
          rows
            .filter((r) => r.lastReadMessageId)
            .map((r) => [r.channelId, r.lastReadMessageId as string]),
        ),
      );

      // One cheap page per text channel to learn what the newest message is.
      const gs = guildList ?? guilds;
      const texts = gs.flatMap((g) => g.channels).filter((c) => c.kind === 'TEXT');
      const heads = await Promise.all(
        texts.map(async (c) => {
          try {
            const page = await api.history(c.id, undefined, 1);
            return [c.id, page.messages[page.messages.length - 1]?.id] as const;
          } catch {
            return [c.id, undefined] as const;
          }
        }),
      );
      setLatest((prev) => {
        const next = { ...prev };
        for (const [id, head] of heads) if (head) next[id] = head;
        return next;
      });
    } catch {
      /* unread marks are cosmetic; never break chat over them */
    }
  }

  loadReadsRef.current = loadReads;

  /** Unread tags per channel, straight from the server. */
  async function loadMentions() {
    try {
      const rows = await api.mentions();
      setMentionCounts(Object.fromEntries(rows.map((r) => [r.channelId, r.count])));
    } catch {
      /* the badge is cosmetic; never break chat over it */
    }
  }

  /**
   * Somebody said your name: make it known.
   *
   * Three things happen, and they are deliberately separate. The sound plays
   * whenever tags are audible at all, including for the channel on screen —
   * that is the point of a ping, and it is the half people actually react to.
   * The OS notification is held back for a message you are not already looking
   * at, because a toast about something two inches away is only ever noise.
   * Whether either is allowed is a setting, since the one thing worse than a
   * missed tag is one that cannot be switched off.
   *
   * The text is the message, trimmed. Notifying without saying what was said
   * makes people open the app to find out, which is the opposite of the job.
   */
  function announceMention(message: MessageDto, channelName: string) {
    const settings = notificationsRef.current;
    if (settings.sound) playPing();
    if (!settings.mentions) return;

    // Already in front of them: the message is on screen and the window has
    // focus, so there is nothing left to tell them.
    const looking =
      message.channelId === activeChannelRef.current && document.hasFocus();
    if (looking) return;

    const who = message.author.displayName || message.author.username;
    // The body is what the toast shows, so tags in it are rendered as names
    // rather than as the ids they travel as.
    const body = toPlain(message.content, (id) => {
      const user = membersRef.current.find((m) => m.user.id === id)?.user;
      return user ?? null;
    }).trim();

    void bridge.notifyMention({
      title: `${who} in #${channelName}`,
      // An image with no caption is still worth a notification; saying so
      // beats an empty toast.
      body: body || 'Sent an attachment',
      channelId: message.channelId,
      messageId: message.id,
    });
  }

  /** Tell the server how far we have read, and stop the dot locally at once. */
  async function markRead(channelId: string, messageId: string) {
    setReads((prev) =>
      !prev[channelId] || messageId > prev[channelId]
        ? { ...prev, [channelId]: messageId }
        : prev,
    );
    // Reading a channel is what clears its tags, and it is always the newest
    // loaded message that gets marked — so there is nothing left above the
    // marker to still be waiting.
    setMentionCounts((prev) => {
      if (!prev[channelId]) return prev;
      const { [channelId]: _read, ...rest } = prev;
      return rest;
    });
    try {
      await api.markRead(channelId, messageId);
    } catch {
      /* it will be retried the next time the channel is opened */
    }
  }

  const isUnread = (channelId: string) => {
    const head = latest[channelId];
    if (!head || channelId === activeChannel) return false;
    const read = reads[channelId];
    return !read || head > read;
  };

  async function loadVoiceState() {
    try {
      const state = await api.voiceState();
      setVoiceByChannel(
        Object.fromEntries(state.map((s) => [s.channelId, s.userIds])),
      );
    } catch {
      /* voice state is cosmetic; a failure here must not break chat */
    }
  }

  async function backfill(channelId: string) {
    const since = lastSeenIdRef.current;
    const page = await api.history(channelId);
    setMessages((prev) => {
      const known = new Set(prev.map((m) => m.id));
      const fresh = page.messages.filter(
        (m) => !known.has(m.id) && (!since || m.id > since),
      );
      return fresh.length ? [...prev, ...fresh] : prev;
    });
    const last = page.messages[page.messages.length - 1];
    if (last) lastSeenIdRef.current = last.id;
    if (atBottomRef.current) requestAnimationFrame(scrollToBottom);
  }

  async function loadOlder() {
    if (!activeChannel || !cursor) return;
    const box = msgsRef.current;
    const prevHeight = box?.scrollHeight ?? 0;
    const page = await api.history(activeChannel, cursor);
    setMessages((prev) => [...page.messages, ...prev]);
    setCursor(page.nextCursor);
    requestAnimationFrame(() => {
      if (box) box.scrollTop = box.scrollHeight - prevHeight;
    });
  }

  function scrollToBottom() {
    const box = msgsRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }

  /** What the jump button does: to the end, and stop counting arrivals. */
  function jumpToLatest() {
    releaseHold();
    scrollToBottom();
    setHasNew(false);
  }

  /* ------------------------------------------------- reading position */

  /** Anything this close to the end counts as being at the end. */
  const BOTTOM_SLACK = 40;

  /**
   * Put a message at the bottom of the view, which is where it was when the
   * reader last saw it — what they had read stays on screen, and whatever
   * arrived since is below, waiting. False if the message is not loaded.
   */
  function scrollToMessage(id: string) {
    const box = msgsRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-mid="${CSS.escape(id)}"]`);
    if (!box || !el) return false;
    const offset =
      el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTop = Math.max(0, offset + el.offsetHeight - box.clientHeight);
    return true;
  }

  /** The bottom-most message with any part of it on screen. */
  function bottomVisibleId(box: HTMLElement) {
    const limit = box.getBoundingClientRect().bottom;
    let found: string | null = null;
    for (const child of box.children) {
      const id = (child as HTMLElement).dataset.mid;
      if (!id) continue; // the "load earlier" button, and unsent messages
      if (child.getBoundingClientRect().top >= limit) break;
      found = id;
    }
    return found;
  }

  /**
   * Called on every scroll: tracks whether the jump button is needed, and
   * writes down where the reader has got to. The write is debounced because
   * this runs dozens of times a second and lands on disk in main.
   */
  function updateScrollState() {
    const box = msgsRef.current;
    const channelId = activeChannelRef.current;
    if (!box || !channelId) return;
    const gap = box.scrollHeight - box.scrollTop - box.clientHeight;
    const bottom = gap <= BOTTOM_SLACK;
    atBottomRef.current = bottom;
    setAtBottom(bottom);
    if (bottom) setHasNew(false);

    const id = bottomVisibleId(box);
    if (!id || positionsRef.current[channelId] === id) return;
    positionsRef.current = { ...positionsRef.current, [channelId]: id };
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(savePositions, 500);
  }

  /* ------------------------------------------------------------- holding */

  const holdTimerRef = useRef<number | null>(null);

  /**
   * Keep the view on a message — or on the end, for a null id — for a moment
   * after landing there. Attachments are fetched after the message they hang
   * off, so the list keeps growing underneath for a second or two; without
   * this the reader arrives in the right place and then slides away from it.
   */
  function holdAt(id: string | null) {
    releaseHold();
    const until = Date.now() + 2500;
    holdTimerRef.current = window.setInterval(() => {
      // A held message that has gone (deleted under us) ends the hold early.
      const held = id === null ? Boolean(msgsRef.current) : scrollToMessage(id);
      if (id === null) scrollToBottom();
      if (!held || Date.now() > until) releaseHold();
    }, 100);
  }

  /** Any scrolling of the reader's own ends the hold at once. */
  function releaseHold() {
    if (holdTimerRef.current !== null) clearInterval(holdTimerRef.current);
    holdTimerRef.current = null;
  }

  useEffect(() => releaseHold, []);

  function savePositions() {
    saveTimerRef.current = null;
    void bridge.setSettings({ chatPositions: positionsRef.current });
  }

  /**
   * Closing the app is exactly the moment the position matters, and it is the
   * one moment a debounced write would be thrown away.
   */
  useEffect(() => {
    const flush = () => {
      if (saveTimerRef.current === null) return;
      clearTimeout(saveTimerRef.current);
      savePositions();
    };
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      flush();
    };
  }, []);

  /* ------------------------------------------------------------- sending */

  /* -------------------------------------------------------- attachments */

  const MAX_FILES = 10;

  /** Accepts pasted or dropped images, holding them until the message is sent. */
  function addFiles(files: File[]) {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) return;
    setPending((prev) => {
      const room = MAX_FILES - prev.length;
      const taken = images.slice(0, Math.max(0, room));
      return [
        ...prev,
        ...taken.map((file) => ({ file, preview: URL.createObjectURL(file) })),
      ];
    });
  }

  function removePending(index: number) {
    setPending((prev) => {
      URL.revokeObjectURL(prev[index].preview);
      return prev.filter((_, i) => i !== index);
    });
  }

  function clearPending() {
    setPending((prev) => {
      for (const p of prev) URL.revokeObjectURL(p.preview);
      return [];
    });
  }

  /** Ctrl+V of a screenshot: the clipboard carries it as a file item. */
  function onPaste(e: React.ClipboardEvent) {
    const files = [...e.clipboardData.items]
      .filter((i) => i.kind === 'file')
      .map((i) => i.getAsFile())
      .filter((f): f is File => f !== null && f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault(); // otherwise the filename lands in the textarea too
      addFiles(files);
    }
  }

  /* ------------------------------------------------------------- sending */

  async function send() {
    // Names become ids here, once, on the way out. The textarea has held plain
    // text the whole time it was being written, which is what keeps the
    // composer a textarea; see mention-utils.ts.
    const content = toMarkup(draft, mentionUsers, pickedRef.current).trim();
    const files = pending.map((p) => p.file);
    // A pasted screenshot with nothing typed is a perfectly good message.
    if ((!content && files.length === 0) || !activeChannel) return;
    const nonce = crypto.randomUUID();
    const optimistic: Msg = {
      id: 'pending-' + nonce,
      channelId: activeChannel,
      author: {
        id: me.id,
        username: me.username ?? me.id,
        displayName: me.displayName,
        image: me.image,
      },
      content,
      createdAt: new Date().toISOString(),
      editedAt: null,
      deletedAt: null,
      clientNonce: nonce,
      // The server will validate these; this is only so the optimistic copy
      // draws the same pills as the echo that replaces it. Your own id cannot
      // be in it -- tagging yourself is not a tag.
      mentions: parseMentionIds(content).filter((id) => id !== me.id),
      attachments: [],
      previews: pending.map((p) => p.preview),
      pending: true,
    };
    setMessages((prev) => [...prev, optimistic]);
    setDraft('');
    pickedRef.current = new Set();
    setMentionPicker(null);
    // Previews are shown from the optimistic copy until the echo replaces it.
    const previews = pending.map((p) => p.preview);
    setPending([]);
    stopTyping();
    requestAnimationFrame(scrollToBottom);

    try {
      const saved = files.length
        ? await api.sendWithFiles(activeChannel, content, nonce, files)
        : await api.send(activeChannel, content, nonce);
      for (const url of previews) URL.revokeObjectURL(url);
      // The socket echo usually lands first; reconcile either way by nonce.
      setMessages((prev) => {
        const i = prev.findIndex((x) => x.clientNonce === nonce);
        if (i < 0) return prev;
        const next = prev.slice();
        next[i] = saved;
        return next;
      });
    } catch {
      setMessages((prev) =>
        prev.map((x) =>
          x.clientNonce === nonce ? { ...x, content: content + '  (failed to send)' } : x,
        ),
      );
    }
  }

  /**
   * Open, move or close the tag list from wherever the caret now is.
   *
   * Driven by the caret rather than by the last keystroke, so it behaves the
   * same whether the `@` was typed, pasted, or arrived at with an arrow key.
   * The selected row resets to the top on every change: after another
   * character the old row is answering a question nobody asked any more.
   */
  function syncMentionPicker(text: string, caret: number) {
    const done = justPickedRef.current;
    if (done && done.text === text && done.caret === caret) {
      setMentionPicker(null);
      return;
    }
    justPickedRef.current = null;

    const query = mentionQuery(text, caret);
    // Nothing matching closes it. That is what stops an "@" in ordinary prose
    // from leaving a popup hanging over the rest of the sentence.
    if (!query || matchUsers(mentionUsers, query.query, 1).length === 0) {
      setMentionPicker(null);
      return;
    }
    setMentionPicker({ ...query, index: 0 });
  }

  /** Put the chosen name in the draft and remember whose it was. */
  function chooseMention(user: MentionUser) {
    if (!mentionPicker) return;
    const next = applyMention(draft, mentionPicker, user);
    pickedRef.current.add(user.id);
    justPickedRef.current = next;
    setDraft(next.text);
    setMentionPicker(null);
    // React has not written the new value yet, so the caret is placed after it
    // has -- otherwise it lands at the end of the old text.
    requestAnimationFrame(() => {
      const box = composerRef.current;
      if (!box) return;
      box.focus();
      box.setSelectionRange(next.caret, next.caret);
    });
  }

  function onDraftChange(v: string, caret: number) {
    setDraft(v);
    syncMentionPicker(v, caret);
    if (!activeChannel) return;
    if (v && !typingSentRef.current) {
      typingSentRef.current = true;
      typingStart(activeChannel);
    } else if (!v) {
      stopTyping();
    }
  }
  function stopTyping() {
    if (activeChannel && typingSentRef.current) {
      typingSentRef.current = false;
      typingStop(activeChannel);
    }
  }

  /* ------------------------------------------------- editing and deleting */

  /**
   * Your own messages, and not one that is still in flight. A mute does not
   * come into it — the server stopped refusing edits from muted people when
   * mute stopped meaning anything about text.
   */
  const canEdit = (m: Msg) => m.author.id === me.id && !m.pending;
  /** Your own, or anyone's if you administer the server. */
  const canDelete = (m: Msg) => (m.author.id === me.id || iAmAdmin) && !m.pending;

  function beginEdit(m: Msg) {
    setEditingId(m.id);
    // The edit box shows names, the same as the composer does. Editing a
    // message should not mean editing around a row of ids.
    setEditDraft(toPlain(m.content, (id) => lookupUser(id)));
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft('');
  }

  async function saveEdit(m: Msg) {
    // Back to markers, the same conversion `send` does. Compared against the
    // stored content afterwards, so re-saving an untouched message with tags
    // in it is still recognised as no change.
    const content = toMarkup(editDraft, mentionUsers).trim();
    if (content === m.content) return cancelEdit();
    // Emptying a message is how Discord users delete one, so treat it that way
    // rather than bouncing it off the server's "cannot be empty".
    if (!content && m.attachments.length === 0) {
      cancelEdit();
      askDelete(m);
      return;
    }

    // Show the edit at once; the socket echo confirms it a moment later.
    const before = m.content;
    setMessages((prev) =>
      prev.map((x) =>
        x.id === m.id ? { ...x, content, editedAt: new Date().toISOString() } : x,
      ),
    );
    cancelEdit();
    try {
      await api.editMessage(m.channelId, m.id, content);
    } catch (e: any) {
      setMessages((prev) =>
        prev.map((x) =>
          x.id === m.id ? { ...x, content: before, editedAt: m.editedAt } : x,
        ),
      );
      setBanner(e?.message ?? 'Could not edit that message.');
    }
  }

  function askDelete(m: Msg) {
    const mine = m.author.id === me.id;
    setConfirmation({
      title: 'Delete message',
      body: mine
        ? 'This removes it for everyone. It cannot be undone.'
        : `This removes ${m.author.displayName || m.author.username}'s message for everyone.`,
      confirmLabel: 'Delete',
      run: async () => {
        // The broadcast removes it everywhere, including here; doing it
        // locally first only avoids a visible round trip.
        setMessages((prev) => prev.filter((x) => x.id !== m.id));
        try {
          await api.deleteMessage(m.channelId, m.id);
        } catch (e: any) {
          setBanner(e?.message ?? 'Could not delete that message.');
          void backfill(m.channelId);
        }
      },
    });
  }

  /* ----------------------------------------------------------------- pins */

  /**
   * Refused server-side too; this only decides what the hover row offers. A
   * pin is the one thing in a channel everybody is shown whether they asked
   * for it or not, which is why it is an admin's call.
   */
  const canPin = (m: Msg) =>
    iAmAdmin && !m.pending && activeChannelObj?.kind === 'TEXT';

  /**
   * Pin or unpin, from the hover row or from the board itself.
   *
   * Takes a message rather than an id because the board holds messages that
   * are not in `messages` at all — pinning something from March and then
   * unpinning it from the panel touches nothing in the list, and the map below
   * is simply a no-op in that case.
   */
  async function togglePin(m: MessageDto) {
    const wasPinned = Boolean(m.pinnedAt);
    // Flip it here first; the socket echo confirms it a moment later.
    setMessages((prev) =>
      prev.map((x) =>
        x.id === m.id
          ? { ...x, pinnedAt: wasPinned ? null : new Date().toISOString() }
          : x,
      ),
    );
    if (wasPinned) setPins((prev) => prev?.filter((x) => x.id !== m.id) ?? prev);

    try {
      if (wasPinned) await api.unpinMessage(m.channelId, m.id);
      else await api.pinMessage(m.channelId, m.id);
    } catch (e: any) {
      setMessages((prev) =>
        prev.map((x) =>
          x.id === m.id ? { ...x, pinnedAt: m.pinnedAt ?? null } : x,
        ),
      );
      setBanner(e?.message ?? 'Could not change that pin.');
    }
    // Either way: on success to pick up what the server actually stored, and
    // on failure to put back the row that was removed optimistically.
    setPinsVersion((v) => v + 1);
  }

  /* ----------------------------------------------------------- moderation */

  /** Every action here is refused server-side too; this only shapes the UI. */
  const canModerate = (m: MemberDto) =>
    iAmAdmin && m.user.id !== me.id && m.role !== 'ADMIN';

  async function run(action: () => Promise<unknown>, whenFailed: string) {
    try {
      await action();
      await loadMembers();
    } catch (e: any) {
      setBanner(e?.message ?? whenFailed);
    }
  }

  const nameOf = (m: MemberDto) => m.user.displayName || m.user.username;

  function askKick(m: MemberDto) {
    setConfirmation({
      title: `Kick ${nameOf(m)}`,
      body: 'They are removed from the server and dropped from any call. They can come back with a new invite.',
      confirmLabel: 'Kick',
      run: () => run(() => api.kick(m.guildId, m.user.id), 'Could not kick them.'),
    });
  }

  /**
   * Delete a channel, with the warning it deserves: the messages go with it,
   * on a cascade, and nothing here or on the server keeps a copy.
   *
   * Nothing is removed locally first, unlike a message deletion. The server
   * broadcasts `guild:changed` and every client — this one included — refetches
   * the list, so an optimistic removal would only be a second code path to the
   * same place, and a wrong one if the server refuses.
   */
  function askDeleteChannel(c: ChannelDto) {
    setConfirmation({
      title: `Delete #${c.name}`,
      body:
        c.kind === 'VOICE'
          ? 'The channel goes for everyone, and anyone still in the call is dropped.'
          : 'The channel and every message in it go for everyone. This cannot be undone.',
      confirmLabel: 'Delete',
      run: async () => {
        try {
          await api.deleteChannel(c.id);
        } catch (e: any) {
          // The likely refusal is the last text channel, and the server says
          // so in words worth passing straight through.
          setBanner(e?.message || 'Could not delete the channel.');
        }
      },
    });
  }

  function askBan(m: MemberDto) {
    setConfirmation({
      title: `Ban ${nameOf(m)}`,
      body: 'They are removed, signed out, and cannot rejoin with this account. Lift it from the ban list.',
      confirmLabel: 'Ban',
      run: () => run(() => api.ban(m.guildId, m.user.id), 'Could not ban them.'),
    });
  }

  async function signOut() {
    await setToken('');
    disconnectSocket();
    onSignOut();
  }

  /* --------------------------------------------------------------- render */

  const nameOfUser = (id: string) => {
    const u = members.find((m) => m.user.id === id)?.user;
    return u ? u.displayName || u.username : 'someone';
  };

  /** The voice roster has ids, not people; the member list is where the rest is. */
  const imageOfUser = (id: string) =>
    members.find((m) => m.user.id === id)?.user.image ?? null;

  const voiceChannelObj = guilds
    .flatMap((g) => g.channels)
    .find((c) => c.id === voice.channelId);

  /** Live speaking/muted state exists only for the room we are actually in. */
  const peerFor = (channelId: string, userId: string) =>
    channelId === voice.channelId
      ? voice.peers.find((p) => p.identity === userId)
      : undefined;

  const typingNames = Object.keys(typingUsers)
    .map((id) => members.find((m) => m.user.id === id)?.user)
    .filter(Boolean)
    .map((u) => u!.displayName || u!.username);

  return (
    <div className="app">
      {/* -------- sidebar -------- */}
      <div className="col sidebar">
        <div className="sb-head">{guilds[0]?.name ?? 'isthislegit'}</div>
        <div className="sb-scroll">
          {guilds.map((g) => (
            <div key={g.id}>
              <div className="sb-section">
                Text
                {iAmAdmin && (
                  <button
                    className="sb-add"
                    title="Create a text channel"
                    onClick={() =>
                      setChannelEdit({ mode: 'create', guildId: g.id, kind: 'TEXT' })
                    }
                  >
                    +
                  </button>
                )}
              </div>
              {g.channels.filter((c) => c.kind === 'TEXT').map((c) => {
                const pings = mentionCounts[c.id] ?? 0;
                return (
                  <div
                    key={c.id}
                    className={
                      'chan' +
                      (c.id === activeChannel ? ' active' : '') +
                      (isUnread(c.id) || pings > 0 ? ' unread' : '')
                    }
                    title={iAmAdmin ? 'Right-click to rename or delete' : undefined}
                    onClick={() => setActiveChannel(c.id)}
                    onContextMenu={(e) => {
                      if (!iAmAdmin) return;
                      e.preventDefault();
                      setChannelMenu({ channel: c, x: e.clientX, y: e.clientY });
                    }}
                  >
                    <span className="hash">#</span>
                    {c.name}
                    {/* The number wins over the dot: both say "unread", and
                        only one of them says somebody wants you. */}
                    {pings > 0 ? (
                      <span
                        className="ping-badge"
                        title={`${pings} message${pings === 1 ? '' : 's'} mentioning you`}
                      >
                        {pings > 99 ? '99+' : pings}
                      </span>
                    ) : (
                      isUnread(c.id) && <span className="unread-dot" />
                    )}
                  </div>
                );
              })}
              {(g.channels.some((c) => c.kind === 'VOICE') || iAmAdmin) && (
                <>
                  {/* Shown to an admin even when empty: otherwise there is
                      nowhere to click to make the first voice channel. */}
                  <div className="sb-section">
                    Voice
                    {iAmAdmin && (
                      <button
                        className="sb-add"
                        title="Create a voice channel"
                        onClick={() =>
                          setChannelEdit({
                            mode: 'create',
                            guildId: g.id,
                            kind: 'VOICE',
                          })
                        }
                      >
                        +
                      </button>
                    )}
                  </div>
                  {g.channels.filter((c) => c.kind === 'VOICE').map((c) => {
                    const occupants = voiceByChannel[c.id] ?? [];
                    const here = voice.channelId === c.id;
                    return (
                      <div key={c.id}>
                        <div
                          className={'chan' + (here ? ' in-voice' : '')}
                          title={
                            here ? 'You are in this channel' : 'Join voice'
                          }
                          onClick={() => (here ? leaveVoice() : joinVoice(c.id))}
                          onContextMenu={(e) => {
                            if (!iAmAdmin) return;
                            e.preventDefault();
                            setChannelMenu({
                              channel: c,
                              x: e.clientX,
                              y: e.clientY,
                            });
                          }}
                        >
                          <span className="hash">🔊</span>
                          {c.name}
                          {occupants.length > 0 && (
                            <span className="chan-count">{occupants.length}</span>
                          )}
                        </div>
                        {/* Occupants are known for every voice channel, not just
                            the one we are in — that is what the webhooks buy. */}
                        {occupants.map((id) => {
                          const peer = peerFor(c.id, id);
                          return (
                            <div
                              key={id}
                              className={
                                'voice-mem' + (peer?.speaking ? ' speaking' : '')
                              }
                              title={
                                id === me.id
                                  ? undefined
                                  : 'Right-click to set how loud they are'
                              }
                              onContextMenu={(e) => {
                                if (id === me.id) return;
                                e.preventDefault();
                                setVolumeFor({
                                  userId: id,
                                  x: e.clientX,
                                  y: e.clientY,
                                });
                              }}
                            >
                              <Avatar
                                className="tiny"
                                name={nameOfUser(id)}
                                image={imageOfUser(id)}
                              />
                              <span className="vm-name">{nameOfUser(id)}</span>
                              {peer?.muted && <span className="vm-icon">🔇</span>}
                              {peer?.screenSharing && (
                                <span className="vm-icon">🖥</span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          ))}
        </div>
        <VoicePanel
          voice={voice}
          channelName={voiceChannelObj?.name ?? ''}
          pushToTalk={voiceSettings.pushToTalk}
          pttLabel={voiceSettings.pttBinding ? voiceSettings.pttLabel : null}
          serverMuted={iAmMuted ? muteLabel(myMutedUntil!) : null}
          onLeave={leaveVoice}
        />

        <div className="footer">
          {/* The whole avatar-and-name block is the button, not just the
              picture: it is the biggest thing down here, and a caret on the
              end is what says so. */}
          <button
            className={'footer-user' + (accountMenu ? ' open' : '')}
            title="Account and settings"
            onClick={(e) => {
              e.stopPropagation();
              if (accountMenu) return setAccountMenu(null);
              const r = e.currentTarget.getBoundingClientRect();
              setAccountMenu({ x: r.left, y: r.top });
            }}
          >
            <Avatar
              size={30}
              name={me.displayName || me.username || '?'}
              image={me.image}
            />
            <div className="name">{me.displayName || me.username}</div>
            <span className="footer-caret">▾</span>
          </button>
          <button onClick={signOut}>Sign out</button>
          <NetworkButton status={status} voice={voice} />
        </div>
      </div>

      {/* -------- chat -------- */}
      <div className="col chat">
        <div className="chat-head">
          <span className="hash" style={{ color: 'var(--faint)' }}>
            {activeChannelObj?.kind === 'VOICE' ? '🔊' : '#'}
          </span>
          {activeChannelObj?.name ?? '—'}
          {/* Always there, whether or not anything is pinned: an icon that
              came and went with the board's contents would be a control
              nobody could learn the position of. */}
          {activeChannelObj?.kind === 'TEXT' && (
            <button
              className={'pin-btn' + (pinsOpen ? ' on' : '')}
              title="Pinned messages"
              onClick={(e) => {
                // Or the window listener that closes it would see this very
                // click and shut it again on the way up.
                e.stopPropagation();
                setPinsOpen((open) => !open);
              }}
            >
              📌
            </button>
          )}
          <div className={'status-dot ' + status} title={status} />
          <span className="status-label">
            {status === 'connected' ? 'live' : status === 'connecting' ? 'reconnecting…' : 'offline'}
          </span>

          {pinsOpen && activeChannelObj && (
            <PinsPanel
              channelName={activeChannelObj.name}
              pins={pins}
              error={pinsError}
              canPin={iAmAdmin}
              onUnpin={(m) => void togglePin(m)}
              onClose={() => setPinsOpen(false)}
              lookupMention={lookupMention}
            />
          )}
        </div>

        {banner && <div className="banner">{banner}</div>}

        <ScreenStage voice={voice} />

        <div className="msgs-wrap">
          <div
            className="msgs"
            ref={msgsRef}
            onScroll={updateScrollState}
            onWheel={releaseHold}
            onPointerDown={releaseHold}
            onKeyDown={releaseHold}
          >
            {cursor && (
              <button className="load-more" onClick={loadOlder}>
                Load earlier messages
              </button>
            )}
            {messages.length === 0 ? (
              <div className="empty">No messages yet. Say something.</div>
            ) : (
              messages.map((m, i) => {
                const prev = messages[i - 1];
                const newDay = !prev || !sameDay(prev.createdAt, m.createdAt);
                // A day boundary always starts a fresh block, even for the same
                // author a minute apart across midnight.
                const grouped =
                  prev &&
                  !newDay &&
                  prev.author.id === m.author.id &&
                  new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000;
                return (
                  // `data-mid` is how the reading position is both read off the
                  // list and restored to it. Unsent messages are left untagged:
                  // their ids do not survive the round trip.
                  <div key={m.id} data-mid={m.pending ? undefined : m.id}>
                    {newDay && (
                      <div className="day-sep">
                        <span>{dayLabel(m.createdAt)}</span>
                      </div>
                    )}
                    <div
                      className={
                        'msg' +
                        (grouped ? ' grouped' : '') +
                        (m.pending ? ' pending' : '') +
                        // Tinted, with a bar down the side. Scrolling back
                        // through an evening, this is what makes the message
                        // that was about you findable without reading them all.
                        //
                        // Optional, because a server older than this feature
                        // sends no such field, and a client that assumed it
                        // would throw on every message in the list rather than
                        // quietly go without the highlight.
                        (m.mentions?.includes(me.id) ? ' mentions-me' : '')
                      }
                    >
                      {grouped ? (
                        <div className="avatar spacer" />
                      ) : (
                        <Avatar
                          name={m.author.displayName || m.author.username}
                          image={m.author.image}
                        />
                      )}
                      <div className="msg-body">
                        {/* Above the author line, not inside it: a grouped
                            message has no author line, and the mark still has
                            to say which message it is about. */}
                        {m.pinnedAt && (
                          <div className="pinned-mark">📌 Pinned</div>
                        )}
                        {!grouped && (
                          <div className="msg-head">
                            <span className="msg-author">{m.author.displayName || m.author.username}</span>
                            <span className="msg-time">{timeOf(m.createdAt)}</span>
                          </div>
                        )}
                        {editingId === m.id ? (
                          <div className="msg-edit">
                            <textarea
                              autoFocus
                              rows={Math.min(10, editDraft.split('\n').length)}
                              value={editDraft}
                              onChange={(e) => setEditDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') {
                                  e.preventDefault();
                                  cancelEdit();
                                } else if (e.key === 'Enter' && !e.shiftKey) {
                                  e.preventDefault();
                                  void saveEdit(m);
                                }
                              }}
                            />
                            <div className="msg-edit-hint">
                              escape to <a onClick={cancelEdit}>cancel</a> · enter to{' '}
                              <a onClick={() => void saveEdit(m)}>save</a>
                            </div>
                          </div>
                        ) : (
                          <>
                            <MessageContent
                              content={m.content}
                              attachments={m.attachments}
                              edited={Boolean(m.editedAt)}
                              lookupMention={lookupMention}
                            />
                            {/* Our own pasted images, shown before the server echo. */}
                            {m.previews?.map((url) => (
                              <PreviewImage key={url} url={url} />
                            ))}
                          </>
                        )}
                      </div>
                      {editingId !== m.id &&
                        (canEdit(m) || canPin(m) || canDelete(m)) && (
                          <div className="msg-actions">
                            {canPin(m) && (
                              <button
                                className={m.pinnedAt ? 'on' : undefined}
                                title={m.pinnedAt ? 'Unpin' : 'Pin to channel'}
                                onClick={() => void togglePin(m)}
                              >
                                📌
                              </button>
                            )}
                            {canEdit(m) && (
                              <button title="Edit" onClick={() => beginEdit(m)}>
                                ✎
                              </button>
                            )}
                            {canDelete(m) && (
                              <button
                                className="danger"
                                title={
                                  m.author.id === me.id ? 'Delete' : 'Delete as admin'
                                }
                                onClick={() => askDelete(m)}
                              >
                                🗑
                              </button>
                            )}
                          </div>
                        )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {!atBottom && (
            <button
              className={'jump-latest' + (hasNew ? ' fresh' : '')}
              onClick={jumpToLatest}
              title="Jump to the newest message"
            >
              <span className="jump-arrow">↓</span>
              {hasNew ? 'New messages' : 'Jump to latest'}
            </button>
          )}
        </div>

        <div className="typing">
          {typingNames.length === 1 && `${typingNames[0]} is typing…`}
          {typingNames.length === 2 && `${typingNames[0]} and ${typingNames[1]} are typing…`}
          {typingNames.length > 2 && 'Several people are typing…'}
        </div>

        <div
          className="composer"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            addFiles([...e.dataTransfer.files]);
          }}
        >
          {pending.length > 0 && (
            <div className="staged">
              {pending.map((p, i) => (
                <div className="staged-item" key={p.preview}>
                  <img src={p.preview} alt="" />
                  <button
                    className="staged-x"
                    onClick={() => removePending(i)}
                    title="Remove"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {mentionPicker && mentionMatches.length > 0 && (
            <MentionPicker
              matches={mentionMatches}
              index={mentionPicker.index}
              onHover={(i) =>
                setMentionPicker((prev) => (prev ? { ...prev, index: i } : prev))
              }
              onPick={chooseMention}
            />
          )}
          <textarea
            ref={composerRef}
            rows={1}
            value={draft}
            // A mute is not consulted here any more. It takes the microphone
            // and leaves the keyboard, so a muted person types as normal.
            placeholder={
              activeChannelObj
                ? pending.length
                  ? 'Add a message, or press Enter to send'
                  : `Message #${activeChannelObj.name}`
                : ''
            }
            disabled={!activeChannelObj || activeChannelObj.kind !== 'TEXT'}
            onChange={(e) => onDraftChange(e.target.value, e.target.selectionStart)}
            onPaste={onPaste}
            // Moving the caret with the mouse or the arrow keys can land in or
            // out of a half-typed tag, so the list is re-checked from wherever
            // the caret ended up rather than only when the text changes.
            onSelect={(e) => {
              const box = e.currentTarget;
              if (document.activeElement === box) {
                syncMentionPicker(box.value, box.selectionStart);
              }
            }}
            onBlur={() => {
              stopTyping();
              setMentionPicker(null);
            }}
            onKeyDown={(e) => {
              // While the list is open it owns the keys that move around it,
              // and nothing else: every other key still types.
              if (mentionPicker && mentionMatches.length > 0) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  const step = e.key === 'ArrowDown' ? 1 : -1;
                  setMentionPicker((prev) =>
                    prev
                      ? {
                          ...prev,
                          // Wraps, so holding one arrow key cannot strand the
                          // selection at an end of a short list.
                          index:
                            (prev.index + step + mentionMatches.length) %
                            mentionMatches.length,
                        }
                      : prev,
                  );
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  chooseMention(mentionMatches[mentionPicker.index]);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setMentionPicker(null);
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
        </div>
      </div>

      {/* -------- members -------- */}
      <div className="col members">
        <div className="sb-head row" style={{ fontSize: 13 }}>
          Members
          {iAmAdmin && (
            <button className="head-btn" onClick={() => setShowBans(true)}>
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
                        if (menuFor?.userId === m.user.id) return setMenuFor(null);
                        const r = e.currentTarget.getBoundingClientRect();
                        setMenuFor({ userId: m.user.id, x: r.right, y: r.bottom });
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
                              setMenuFor(null);
                              void run(
                                () => api.mute(m.guildId, m.user.id, o.minutes),
                                'Could not mute them.',
                              );
                            }}
                          >
                            {o.label}
                          </button>
                        ))}
                        {m.mutedUntil && (
                          <button
                            onClick={() => {
                              setMenuFor(null);
                              void run(
                                () => api.unmute(m.guildId, m.user.id),
                                'Could not unmute them.',
                              );
                            }}
                          >
                            Unmute
                          </button>
                        )}
                        <div className="menu-sep" />
                        <button
                          className="danger"
                          onClick={() => {
                            setMenuFor(null);
                            askKick(m);
                          }}
                        >
                          Kick
                        </button>
                        <button
                          className="danger"
                          onClick={() => {
                            setMenuFor(null);
                            askBan(m);
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

      <ScreenPicker />
      {volumeFor && (
        <UserVolumeMenu
          name={nameOfUser(volumeFor.userId)}
          volume={voiceSettings.userVolumes[volumeFor.userId] ?? 1}
          x={volumeFor.x}
          y={volumeFor.y}
          onChange={(v) => setUserVolume(volumeFor.userId, v)}
        />
      )}
      {accountMenu && (
        // Opens upwards: the button it belongs to is the last row on screen.
        <div
          className="menu"
          style={{ left: accountMenu.x, top: accountMenu.y - ACCOUNT_MENU_HEIGHT }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              setAccountMenu(null);
              setShowSettings(true);
            }}
          >
            ⚙ Settings
          </button>
        </div>
      )}
      {channelMenu && (
        <div
          className="menu"
          style={{ left: channelMenu.x, top: channelMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="menu-label">
            {channelMenu.channel.kind === 'VOICE' ? '🔊' : '#'}{' '}
            {channelMenu.channel.name}
          </div>
          <button
            onClick={() => {
              setChannelEdit({ mode: 'rename', channel: channelMenu.channel });
              setChannelMenu(null);
            }}
          >
            Rename
          </button>
          <div className="menu-sep" />
          <button
            className="danger"
            onClick={() => {
              askDeleteChannel(channelMenu.channel);
              setChannelMenu(null);
            }}
          >
            Delete channel
          </button>
        </div>
      )}
      {channelEdit && (
        <ChannelModal
          edit={channelEdit}
          onClose={() => setChannelEdit(null)}
          onDone={(channel) => {
            const creating = channelEdit.mode === 'create';
            setChannelEdit(null);
            void (async () => {
              // Refreshed here rather than left to this client's own
              // `guild:changed`, and awaited before anything is opened: the
              // list is what decides whether a channel exists, and opening one
              // that is not in it yet trips the check that closes channels
              // which have gone.
              const gs = await refreshGuilds();
              const exists = gs?.some((g) =>
                g.channels.some((c) => c.id === channel.id),
              );
              // Open what was just made, rather than leaving the person who
              // made it to go and find it. A voice channel is not opened:
              // creating one is not the same as joining the call.
              if (creating && exists && channel.kind === 'TEXT') {
                setActiveChannel(channel.id);
              }
            })();
          }}
        />
      )}
      {showSettings && (
        <SettingsModal
          me={me}
          settings={voiceSettings}
          notifications={notifications}
          voice={voice}
          onChange={(patch) => void updateVoiceSettings(patch)}
          onNotificationsChange={(patch) => void updateNotifications(patch)}
          onProfileSaved={applyUserUpdate}
          onClose={() => setShowSettings(false)}
        />
      )}
      {showBans && guilds[0] && (
        <BansModal guildId={guilds[0].id} onClose={() => setShowBans(false)} />
      )}
      {confirmation && (
        <ConfirmModal
          confirmation={confirmation}
          onClose={() => setConfirmation(null)}
        />
      )}
      {removed && (
        <div className="modal-wrap">
          <div className="modal">
            <div className="modal-head">
              {removed.kind === 'ban' ? 'You were banned' : 'You were removed'}
            </div>
            <div className="modal-body">
              <p style={{ margin: 0 }}>
                {removed.kind === 'ban'
                  ? 'An admin banned you from this server. This account cannot rejoin.'
                  : 'An admin removed you from this server. You can come back with a new invite.'}
              </p>
              {removed.reason && <p className="hint">Reason: {removed.reason}</p>}
            </div>
            <div className="modal-foot">
              <button onClick={() => void signOut()}>Sign out</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The list that opens when you type `@`.
 *
 * Sits in the composer's own box rather than at the caret. A popup that
 * follows the caret needs the text measured to know where that is, which for a
 * textarea means rendering a mirror of it off-screen — a lot of machinery for
 * a box that is two lines tall, where the caret is never far from the left.
 *
 * `onMouseDown` rather than `onClick`, because clicking here blurs the
 * textarea and the blur closes the list: the click would land on nothing.
 */
function MentionPicker({
  matches,
  index,
  onHover,
  onPick,
}: {
  matches: MentionUser[];
  index: number;
  onHover: (index: number) => void;
  onPick: (user: MentionUser) => void;
}) {
  return (
    <div className="mention-picker">
      <div className="mention-picker-head">Members</div>
      {matches.map((user, i) => (
        <button
          key={user.id}
          className={'mention-row' + (i === index ? ' on' : '')}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(user);
          }}
        >
          <Avatar
            className="tiny"
            name={mentionName(user)}
            image={user.image}
          />
          <span className="mention-row-name">{mentionName(user)}</span>
          {/* Only when it says something the name does not, which is how you
              tell two people apart who have picked the same display name. */}
          {user.displayName && user.displayName !== user.username && (
            <span className="mention-row-handle">{user.username}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** One of our own pasted images, shown until the server echo replaces it. */
function PreviewImage({ url }: { url: string }) {
  const { imageProps } = useImageActions();
  return (
    <div className="attach">
      <img src={url} alt="" {...imageProps({ src: url, name: 'image' })} />
    </div>
  );
}

/* ----------------------------------------------------------- pin board */

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
function PinsPanel({
  channelName,
  pins,
  error,
  canPin,
  onUnpin,
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
          <div className="pin-row" key={m.id}>
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
              <button
                className="pin-unpin"
                title="Unpin"
                onClick={() => onUnpin(m)}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- modals */

/** One modal for every "are you sure" in the app: delete, kick, ban. */
function ConfirmModal({
  confirmation,
  onClose,
}: {
  confirmation: Confirmation;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="modal-wrap" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">{confirmation.title}</div>
        <div className="modal-body">
          <p style={{ margin: 0 }}>{confirmation.body}</p>
        </div>
        <div className="modal-foot">
          <button onClick={onClose}>Cancel</button>
          <button
            className="danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await confirmation.run();
              onClose();
            }}
          >
            {confirmation.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Create a channel, or rename one. Admin only, and refused again on the server.
 *
 * One dialog for both because they are one form: a name. The kind is not a
 * control — a new channel takes it from the section the `+` was clicked in,
 * and an existing one cannot change it, since a text channel full of messages
 * is not a voice room and there is nothing sensible to do with the history.
 */
function ChannelModal({
  edit,
  onClose,
  onDone,
}: {
  edit:
    | { mode: 'create'; guildId: string; kind: ChannelDto['kind'] }
    | { mode: 'rename'; channel: ChannelDto };
  onClose: () => void;
  onDone: (channel: ChannelDto) => void;
}) {
  const creating = edit.mode === 'create';
  const kind = creating ? edit.kind : edit.channel.kind;
  const [name, setName] = useState(creating ? '' : edit.channel.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * What the server's schema accepts, checked here only to say so before a
   * round trip. Spaces are the one people actually hit, and turning them into
   * dashes is what every other chat app does, so the field does it as they
   * type rather than refusing afterwards.
   */
  const clean = (v: string) => v.replace(/\s+/g, '-').replace(/[#@]/g, '').slice(0, 64);
  const valid = name.length > 0;

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const channel = creating
        ? await api.createChannel(edit.guildId, { name, kind })
        : await api.renameChannel(edit.channel.id, name);
      onDone(channel);
    } catch (e: any) {
      setError(e?.message || 'Could not save the channel.');
      setBusy(false);
    }
  }

  return (
    <div className="modal-wrap" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          {creating
            ? `Create a ${kind === 'VOICE' ? 'voice' : 'text'} channel`
            : `Rename #${edit.channel.name}`}
        </div>
        <div className="modal-body">
          {error && <div className="banner">{error}</div>}
          <label htmlFor="channel-name">Channel name</label>
          <div className="channel-name-field">
            <span className="hash">{kind === 'VOICE' ? '🔊' : '#'}</span>
            <input
              id="channel-name"
              autoFocus
              value={name}
              placeholder={kind === 'VOICE' ? 'general-voice' : 'new-channel'}
              onChange={(e) => setName(clean(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
                if (e.key === 'Escape') onClose();
              }}
            />
          </div>
          <p className="hint">
            {kind === 'VOICE'
              ? 'Everyone on the server can see it and join the call.'
              : 'Everyone on the server can see it and read it.'}
          </p>
        </div>
        <div className="modal-foot">
          <button onClick={onClose}>Cancel</button>
          <button disabled={!valid || busy} onClick={() => void submit()}>
            {creating ? 'Create' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The ban list, and the only way to lift one. Lifting a ban does not put
 * anyone back in the server — they still need an invite — which is why this
 * says "Lift" rather than "Restore".
 */
function BansModal({ guildId, onClose }: { guildId: string; onClose: () => void }) {
  const [bans, setBans] = useState<BanDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBans(await api.bans(guildId));
    } catch (e: any) {
      setError(e?.message ?? 'Could not load the ban list.');
    }
  }, [guildId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="modal-wrap" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">Banned accounts</div>
        <div className="modal-body">
          {error && <div className="banner">{error}</div>}
          {!bans && !error && <div className="hint">Loading…</div>}
          {bans?.length === 0 && <div className="hint">Nobody is banned.</div>}
          {bans?.map((b) => (
            <div className="ban-row" key={b.userId}>
              <div>
                <div>{b.displayName || b.username}</div>
                <div className="hint inline">
                  banned by {b.bannedBy ?? 'an admin'} ·{' '}
                  {new Date(b.createdAt).toLocaleDateString()}
                  {b.reason ? ` · ${b.reason}` : ''}
                </div>
              </div>
              <button
                onClick={async () => {
                  try {
                    await api.unban(guildId, b.userId);
                    await load();
                  } catch (e: any) {
                    setError(e?.message ?? 'Could not lift that ban.');
                  }
                }}
              >
                Lift ban
              </button>
            </div>
          ))}
        </div>
        <div className="modal-foot">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
