import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  setToken,
  type ChannelDto,
  type GuildDto,
  type MemberDto,
  type MessageDto,
  type Me,
  type PublicUserDto,
  type SendExtrasDto,
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
import {
  applyEmoji,
  emojiQuery,
  matchEmoji,
  toEmoji,
  type EmojiMatch,
  type EmojiQuery,
} from '../emoji-utils';
import { EMOJI_PAIRS, emojiFor } from '../emoji-data';
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
import { noteUpdateAvailable, type Updates } from '../updates';
import { useVoice, type VoiceSettings } from '../voice';
import type { Keybind, NotificationSettings } from '../../preload';
import {
  ScreenPicker,
  ScreenStage,
  SettingsModal,
  UserVolumeMenu,
  VoicePanel,
} from './Voice';
import { Avatar } from './Avatar';
import { EmojiBrowser } from './EmojiBrowser';
import { ReactionBar } from './ReactionBar';
import { useImageActions } from './ImageViewer';
import { NetworkButton } from './NetworkStats';
import {
  MAX_MESSAGE_CHARS,
  channelIcon,
  dayLabel,
  describeBytes,
  guessReactions,
  isForever,
  lastSeenLabel,
  muteLabel,
  quoteLine,
  sameDay,
  stamp,
  timeOf,
} from './chat-format';
import type { Confirmation, Msg, Staged, Status } from './chat-types';
import { PinsPanel, SearchPanel } from './ChatPanels';
import {
  BansModal,
  ChannelModal,
  ConfirmModal,
  ForwardModal,
} from './ChatModals';
import { ForwardCard, ReplyStrip, requoted, toRef } from './MessageRefs';





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


export function Chat({
  me,
  onMeChanged,
  onSignOut,
  updates,
}: {
  me: Me;
  /** Your own profile changed — here, or on another machine you are signed in on. */
  onMeChanged: (me: Me) => void;
  onSignOut: () => void;
  /** What this build is and whether the server has a newer one. See updates.ts. */
  updates: Updates;
}) {
  const [guilds, setGuilds] = useState<GuildDto[]>([]);
  const [members, setMembers] = useState<MemberDto[]>([]);
  /** Drives the "last seen" durations in the member list; see useMinuteClock. */
  const now = useMinuteClock();
  const [activeChannel, setActiveChannel] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  /**
   * The server said it was going down to be updated. Kept apart from `status`
   * rather than added to it as a fourth value: the connection really is
   * disconnected and then connecting, every consumer of that should carry on
   * treating it that way, and the only thing this changes is the word shown
   * next to the dot while it happens.
   */
  const [serverRestarting, setServerRestarting] = useState(false);
  const [draft, setDraft] = useState('');
  const [typingUsers, setTypingUsers] = useState<Record<string, number>>({});
  /** Occupants of every voice channel, from the server's LiveKit webhooks. */
  const [voiceByChannel, setVoiceByChannel] = useState<Record<string, string[]>>({});
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>({
    inputDeviceId: null,
    outputDeviceId: null,
    pushToTalk: false,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    gateMode: 'off',
    gateThreshold: -45,
    userVolumes: {},
    rejoinLastChannel: false,
  });
  /**
   * Every global keybinding. Held here rather than inside useVoice because it
   * is persisted settings like the rest, and the settings panel edits it.
   */
  const [keybinds, setKeybinds] = useState<Keybind[]>([]);
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
  /**
   * True while the view is parked in the middle of history rather than at the
   * live end — which is where a jump to a search result or an old pin leaves
   * it.
   *
   * Two things must not happen while it is set. The reading position must not
   * be overwritten with wherever the jump landed: somebody who looks up a
   * message from March and closes the app should come back to where they were
   * reading. And the channel must not be marked read to the newest loaded
   * message, because everything below the window is still unseen. Both are
   * lifted by `jumpToLatest`, which is what returns to the live end.
   */
  const [inHistory, setInHistory] = useState(false);
  /** The search panel under the header, and what is in it. */
  const [searchOpen, setSearchOpen] = useState(false);
  /**
   * Bumped to make the channel-load effect re-run for a jump within the
   * channel that is already open, where `activeChannel` does not change and
   * so nothing else would.
   */
  const [jumpNonce, setJumpNonce] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  /**
   * The message the composer is answering, if any.
   *
   * The whole message rather than its id, because the bar above the composer
   * has to draw who wrote it and what it said, and that message may be far
   * enough back that it is no longer in `messages` by the time the reply is
   * sent -- the list is finite and somebody can scroll while composing.
   */
  const [replyTo, setReplyTo] = useState<MessageDto | null>(null);
  /**
   * Whether this reply tags the person being answered. On by default, because
   * that is what replying is for; the switch is for the third message of a
   * back-and-forth, where they are plainly already reading.
   *
   * Reset with the reply rather than remembered: it is a decision about one
   * message, and a silent default that persisted from an hour ago would be a
   * setting nobody knew they had changed.
   */
  const [replyPing, setReplyPing] = useState(true);
  /** The message the forward dialog is open for, if it is open. */
  const [forwarding, setForwarding] = useState<MessageDto | null>(null);
  /**
   * Files pasted, dropped or picked, held locally until the message is sent.
   * `preview` is an object URL for a picture and null for everything else --
   * there is nothing to show for a zip, and a made-up thumbnail helps nobody.
   */
  const [pending, setPending] = useState<Staged[]>([]);
  /** The hidden input behind the attach button. */
  const fileInputRef = useRef<HTMLInputElement>(null);
  /**
   * This server's attachment limit, so an oversized file is refused in the box
   * rather than after it has been sent and uploaded.
   *
   * Null until the config call answers, and the check is skipped while it is —
   * the server enforces the same number, and a client that has not been told
   * yet must not invent a limit of its own. Re-read on every reconnect, which
   * is what makes a limit raised on the server and restarted into show up here
   * without restarting the client.
   */
  const [maxUploadBytes, setMaxUploadBytes] = useState<number | null>(null);
  const maxUploadRef = useRef<number | null>(null);
  maxUploadRef.current = maxUploadBytes;
  /**
   * How far each in-flight upload has got, keyed by the message's nonce.
   *
   * Separate from the outbox because it changes at the rate bytes leave the
   * machine and the outbox does not: putting it there would rebuild the whole
   * message list a hundred times a second for a large file.
   */
  const [uploads, setUploads] = useState<Record<string, number>>({});
  /**
   * Messages that have left the composer but have not landed, keyed by nonce.
   *
   * Holds the row itself, and the files, because both outlive the list. The
   * files because a failed send has to be retryable and a `File` cannot be
   * rebuilt from the row; the row because the list is replaced wholesale every
   * time a channel is opened, and the server has never heard of this message,
   * so without a copy here it would go on the first channel switch and take
   * whatever was typed with it. Dropped when the message lands, or when the
   * sender throws it away.
   */
  const outboxRef = useRef(
    // `extra` rides along for the same reason the files do: a retry re-sends
    // the message, and a reply that came back as a normal message on the
    // second attempt would have quietly dropped what it was answering.
    new Map<string, { row: Msg; files: File[]; extra: SendExtrasDto }>(),
  );
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
   * The tag or shortcode being typed in the composer, and which row of the
   * list is selected. Null whenever the popup is closed, which is most of the
   * time.
   *
   * One piece of state with a discriminator rather than one per list, and that
   * is the whole point: while a list is open it owns the arrow keys, Enter,
   * Tab and Escape, and two of them able to be open at once would mean two
   * handlers claiming the same keys. `MentionQuery` and `EmojiQuery` are the
   * same `{ start, query }` shape, so `kind` is the only thing that separates
   * them -- and it is what decides which list is drawn and what a pick does.
   */
  const [picker, setPicker] = useState<
    | ({ kind: 'mention'; index: number } & MentionQuery)
    | ({ kind: 'emoji'; index: number } & EmojiQuery)
    | null
  >(null);
  /**
   * Whether the emoji grid is open over the composer.
   *
   * Separate from `picker` and not part of its union: that one is a list the
   * caret is inside, driven by what is being typed and owning the arrow keys
   * while it is open. This is a panel somebody opened with a button, which
   * takes the focus itself and owns nothing in the textarea.
   */
  const [emojiBrowser, setEmojiBrowser] = useState(false);
  /**
   * The message whose reaction grid is open, if any. One at a time: two grids
   * on screen would both be claiming Escape and the next click.
   */
  const [reactingTo, setReactingTo] = useState<string | null>(null);
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
   * A line saying something worked, where the banner says something did not.
   *
   * Separate rather than a flag on `banner`, because the two are read
   * differently: an error is a thing to act on and a confirmation is a thing
   * to glance at, and one of them being drawn in the other's red box is how a
   * successful forward comes to look like a failed one.
   */
  const [notice, setNotice] = useState<string | null>(null);

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

  // `leaveVoice` is a hoisted declaration below, and is only ever called from
  // an event, so it is assigned long before anything can press the key.
  const voice = useVoice(voiceSettings, keybinds, iAmMuted, leaveVoice);

  /**
   * What the voice panel says to hold, or null if nothing would work.
   *
   * Every enabled push-to-talk binding, joined, rather than the first: an
   * action may be bound more than once, and a reminder that names one of two
   * keys is wrong about the other. Disabled rows are left out for the same
   * reason -- naming a key that has been switched off is worse than naming
   * none at all.
   */
  const pttLabel = useMemo(() => {
    const labels = keybinds
      .filter((k) => k.action === 'ptt' && k.enabled)
      .map((k) => k.label);
    return labels.length ? labels.join(' or ') : null;
  }, [keybinds]);

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
   * Where the caret was in the composer when it last had it.
   *
   * Kept because the emoji grid takes the focus the moment it opens -- its
   * search box wants it -- so by the time something is picked, the textarea's
   * own `selectionStart` has collapsed to the end. Without this, choosing an
   * emoji from the grid mid-sentence would append it to the paragraph.
   */
  const caretRef = useRef<number>(0);
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
   * Whether the view is parked in history, for the scroll handler and the
   * socket handlers to read. Same reason as the refs below: the scroll handler
   * runs dozens of times a second and must not be reading a value from the
   * render it happened to be created in.
   */
  const inHistoryRef = useRef(false);
  inHistoryRef.current = inHistory;
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

  /**
   * A channel id to the name people read, for the three places that hold an id
   * and have to say where it is: a search result, a forward's card, and the
   * line confirming one was sent.
   *
   * Null rather than a placeholder when it is not found, so each caller can
   * decide -- a search result says "unknown", a forward card simply drops the
   * "from #..." rather than claiming the message came from nowhere.
   */
  const channelNameOf = useCallback(
    (id: string): string | null =>
      guilds.flatMap((g) => g.channels).find((c) => c.id === id)?.name ?? null,
    [guilds],
  );

  /** One tagged id back to the person, for turning markers into names. */
  const lookupUser = useCallback(
    (id: string): MentionUser | null =>
      members.find((m) => m.user.id === id)?.user ?? null,
    [members],
  );

  /**
   * What is in the open list right now, for the query being typed.
   *
   * Two memos rather than one of a union type, so each list keeps its own
   * element type and nothing has to be cast at the point of picking. Only one
   * of them is ever non-empty, because only one picker is ever open.
   */
  const mentionMatches = useMemo(
    () => (picker?.kind === 'mention' ? matchUsers(mentionUsers, picker.query) : []),
    [picker, mentionUsers],
  );
  const emojiMatches = useMemo(
    () => (picker?.kind === 'emoji' ? matchEmoji(EMOJI_PAIRS, picker.query) : []),
    [picker],
  );
  /** How many rows the open list has, whichever list it is. */
  const pickerRowCount = mentionMatches.length + emojiMatches.length;

  /* ------------------------------------------------------ initial + socket */

  useEffect(() => {
    void bridge.getSettings().then((s) => {
      setVoiceSettings(s.voice);
      setKeybinds(s.keybinds);
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
    () =>
      bridge.onNotificationActivate(({ channelId, messageId }) =>
        // The messageId has been arriving here since notifications were
        // added and was thrown away for want of anything able to use it.
        messageId ? jumpTo(channelId, messageId) : setActiveChannel(channelId),
      ),
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

  /**
   * The whole table, every time.
   *
   * Sent whole rather than patched because it is an array: a row somebody
   * removed has to actually be gone from what lands on disk, and a merge has
   * no way to express a deletion.
   */
  async function updateKeybinds(rows: Keybind[]) {
    setKeybinds(rows);
    await bridge.setSettings({ keybinds: rows });
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

    // Asked for again on every reconnect, not only at startup. Raising the
    // attachment limit means editing .env and restarting the server, and the
    // restart is the reconnect -- so this is the moment the new number becomes
    // knowable, and the composer should not go on refusing files against the
    // old one until somebody restarts the client too.
    const loadServerConfig = () =>
      void api
        .config()
        .then((cfg) => {
          if (typeof cfg.maxUploadBytes === 'number') {
            setMaxUploadBytes(cfg.maxUploadBytes);
          }
        })
        .catch(() => undefined);
    loadServerConfig();

    connectSocket({
      onStatus: (s) => {
        setStatus(s);
        // Cleared on the way back up, so the label says "updating" only for
        // the gap the update itself caused and not for the next one.
        if (s === 'connected') {
          setServerRestarting(false);
          loadServerConfig();
        }
      },
      onServerRestarting: () => setServerRestarting(true),
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
          // Every quote of it moves too. A reply's strip and a forward's card
          // are drawn from a copy taken when the list was loaded, so without
          // this an edited message goes on being quoted as what it used to
          // say, for as long as the channel stays open.
          prev.map((x) =>
            x.id === m.id ? { ...x, ...m } : requoted(x, m.id, toRef(m)),
          ),
        ),
      // Deleted messages are removed outright rather than tombstoned: history
      // filters them server-side too, so a reload would not bring them back.
      onMessageDeleted: ({ id }) => {
        setMessages((prev) =>
          prev
            .filter((x) => x.id !== id)
            // And every quote of it becomes the line that says so. This is the
            // same rule as the pin board's: nothing a moderator removed should
            // survive on screen, and a quote is a copy of it sitting inside
            // somebody else's message.
            .map((x) => requoted(x, id, null)),
        );
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
      onReactionChanged: ({ channelId, messageId, emoji, userIds }) => {
        if (channelId !== activeChannelRef.current) return;
        setMessages((prev) =>
          prev.map((x) => {
            if (x.id !== messageId) return x;
            const others = (x.reactions ?? []).filter((r) => r.emoji !== emoji);
            // Nobody left in the pile means the last person took theirs back,
            // and the pile goes rather than sitting there reading "👍 0".
            if (userIds.length === 0) return { ...x, reactions: others };
            // Appended when it is new to this message, which is where the
            // server has it too -- piles are ordered by first use. An existing
            // one keeps its place, so the row does not reshuffle under the
            // cursor of whoever is about to click the next one.
            const kept = (x.reactions ?? []).map((r) =>
              r.emoji === emoji ? { emoji, userIds } : r,
            );
            return {
              ...x,
              reactions: kept.length === others.length
                ? [...kept, { emoji, userIds }]
                : kept,
            };
          }),
        );
      },
      onMention: ({ message, channelName, kind }) => {
        // The badge counts what is still unread. A tag in the channel that is
        // open is not: `onMessage` marks it read as it arrives, so counting it
        // here would light a number that the next render immediately clears.
        if (message.channelId !== activeChannelRef.current) {
          setMentionCounts((prev) => ({
            ...prev,
            [message.channelId]: (prev[message.channelId] ?? 0) + 1,
          }));
        }
        announceMention(message, channelName, kind ?? 'mention');
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

  // Same for the search popover: a click anywhere else puts it away. The
  // panel itself stops propagation, so typing in it does not close it.
  useEffect(() => {
    if (!searchOpen) return;
    const close = () => setSearchOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [searchOpen]);

  /* -------------------------------------------------------------- search */

  const [searchText, setSearchText] = useState('');
  const [searchResults, setSearchResults] = useState<MessageDto[] | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  /** What the results on screen were a search for, so stale ones can be told. */
  const searchSeqRef = useRef(0);

  /**
   * Search, debounced.
   *
   * Every keystroke is a query against a database on somebody's home box, so
   * it waits for a pause rather than firing per character. The sequence number
   * is what stops an earlier, slower query landing after a later one and
   * putting the wrong results on screen -- which is the failure people
   * actually see, in the form of results for a prefix of what they typed.
   */
  useEffect(() => {
    if (!searchOpen) return;
    const q = searchText.trim();
    if (q.length < 2) {
      setSearchResults(null);
      setSearchError(null);
      setSearchBusy(false);
      return;
    }

    const seq = ++searchSeqRef.current;
    setSearchBusy(true);
    const timer = window.setTimeout(async () => {
      try {
        const guildId = guilds.find((g) =>
          g.channels.some((c) => c.id === activeChannel),
        )?.id;
        const page = await api.search({ q, guildId });
        if (seq !== searchSeqRef.current) return;
        setSearchResults(page.results);
        setSearchError(null);
      } catch (e: any) {
        if (seq !== searchSeqRef.current) return;
        setSearchResults(null);
        setSearchError(
          e?.status === 404
            ? 'This server is too old to search. Update the server to use this.'
            : (e?.message ?? 'That search did not work.'),
        );
      } finally {
        if (seq === searchSeqRef.current) setSearchBusy(false);
      }
    }, 250);

    return () => window.clearTimeout(timer);
  }, [searchOpen, searchText, activeChannel, guilds]);

  // Closing it clears it: reopening the box to last week's search, already
  // run, is never what somebody opening a search box wants.
  useEffect(() => {
    if (searchOpen) return;
    setSearchText('');
    setSearchResults(null);
    setSearchError(null);
  }, [searchOpen]);

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

  // Shorter than an error's five seconds: this one says a thing that already
  // happened, and there is nothing to do about it.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(t);
  }, [notice]);

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
    // A reply belongs to the channel it was started in -- the server refuses
    // one that points anywhere else -- so it goes with the channel rather than
    // following the composer into the next one.
    setReplyTo(null);
    setReplyPing(true);
    // The board belongs to the channel it was opened from, so it closes with
    // it rather than hanging over the next one showing the wrong pins.
    setPinsOpen(false);
    setPins(null);
    (async () => {
      // A jump takes precedence over the remembered reading position: it is
      // something the reader asked for just now, and the position is where
      // they happened to be last time.
      const jump =
        pendingJumpRef.current?.channelId === activeChannel
          ? pendingJumpRef.current
          : null;
      pendingJumpRef.current = null;

      if (jump) {
        const page = await api.historyAround(activeChannel, jump.messageId);
        if (cancelled) return;
        setMessages(page.messages);
        setCursor(page.nextCursor);
        // `prevCursor` set means there are newer messages below this window,
        // so the view is in history rather than at the live end. An older
        // server that ignored `around` sends none, which correctly reads as
        // "this is the bottom" -- there, the reader lands in the right
        // channel at the newest page, which is the better of the two failures.
        const parked = Boolean(page.prevCursor);
        setInHistory(parked);
        // Only the live end counts as having been read. Landing in March says
        // nothing about the fortnight below it.
        if (!parked) {
          const last = page.messages[page.messages.length - 1];
          if (last) {
            lastSeenIdRef.current = last.id;
            setLatest((prev) => ({ ...prev, [activeChannel]: last.id }));
            void markRead(activeChannel, last.id);
          }
        }
        requestAnimationFrame(() => {
          if (!scrollToMessage(jump.messageId)) scrollToBottom();
          holdAt(jump.messageId);
          flash(jump.messageId);
          updateScrollState();
        });
        return;
      }

      setInHistory(false);
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
    // `jumpNonce` is here so a jump inside the channel that is already open
    // re-runs this. Nothing else about it changes in that case.
  }, [activeChannel, settingsReady, jumpNonce]);

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
  function announceMention(
    message: MessageDto,
    channelName: string,
    kind: 'mention' | 'reply' = 'mention',
  ) {
    const settings = notificationsRef.current;
    if (settings.sound) playPing();
    if (!settings.mentions) return;

    // Already in front of them: the message is on screen and the window has
    // focus, so there is nothing left to tell them.
    const looking =
      message.channelId === activeChannelRef.current && document.hasFocus();
    if (looking) return;

    const who = message.author.displayName || message.author.username;
    // "replied to you" and "mentioned you" are not the same sentence, and the
    // toast is the whole of what somebody sees before they decide whether to
    // open the app. A server too old to say which sends nothing, and the
    // default is the only thing it could have meant.
    const what = kind === 'reply' ? 'replied to you in' : 'in';
    // The body is what the toast shows, so tags in it are rendered as names
    // rather than as the ids they travel as.
    const body = toPlain(message.content, (id) => {
      const user = membersRef.current.find((m) => m.user.id === id)?.user;
      return user ?? null;
    }).trim();

    void bridge.notifyMention({
      title: `${who} ${what} #${channelName}`,
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

  /**
   * What the jump button does: back to the live end, and stop counting
   * arrivals.
   *
   * Scrolling is enough when the newest message is already loaded, which is
   * the ordinary case. After a jump into history it is not: the bottom of the
   * list is the bottom of a window somewhere in March, and there may be
   * thousands of messages below it. That case reloads the newest page, which
   * is also what re-arms the reading position and the read marker.
   */
  function jumpToLatest() {
    releaseHold();
    setHasNew(false);

    if (!inHistoryRef.current) {
      scrollToBottom();
      return;
    }
    if (!activeChannel) return;

    setInHistory(false);
    void (async () => {
      const page = await api.history(activeChannel);
      setMessages(page.messages);
      setCursor(page.nextCursor);
      const last = page.messages[page.messages.length - 1];
      if (last) {
        lastSeenIdRef.current = last.id;
        setLatest((prev) => ({ ...prev, [activeChannel]: last.id }));
        void markRead(activeChannel, last.id);
      }
      requestAnimationFrame(() => {
        scrollToBottom();
        updateScrollState();
      });
    })();
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

    // Not while parked in history. Somebody who jumped to a message from
    // March and then closed the app should come back to where they had got to
    // reading, not to March -- the jump was a look, not a new position.
    if (inHistoryRef.current) return;

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

  /* -------------------------------------------------------------- jumping */

  /**
   * A jump waiting for the channel-load effect to act on it.
   *
   * A ref rather than state because it is a one-shot instruction, not
   * something anything renders: setting state would run the effect again, and
   * the effect is what consumes it.
   */
  const pendingJumpRef = useRef<{ channelId: string; messageId: string } | null>(
    null,
  );

  /** The message to flash on arrival, cleared by a timer. */
  const [flashId, setFlashId] = useState<string | null>(null);

  function flash(id: string) {
    setFlashId(id);
    window.setTimeout(
      () => setFlashId((current) => (current === id ? null : current)),
      2000,
    );
  }

  /**
   * Where a message may be forwarded to: the text channels of the guild it was
   * sent in, and nothing else.
   *
   * Bounded to one guild, and the server enforces the same rule rather than
   * trusting this list. Everyone in a guild can already read every channel in
   * it, so a forward inside one puts nothing in front of anybody that they
   * could not have opened themselves -- and the card's link to the original
   * always leads somewhere they can go. Neither holds across guilds.
   */
  const forwardTargets = useMemo(() => {
    if (!forwarding) return [];
    const guild = guilds.find((g) =>
      g.channels.some((c) => c.id === forwarding.channelId),
    );
    return guild?.channels.filter((c) => c.kind === 'TEXT') ?? [];
  }, [forwarding, guilds]);

  /**
   * Pass a message on to another channel.
   *
   * The ordinary send route with one more field, which is what a forward is: a
   * message in the target channel that happens to point at another one. It
   * gets the same broadcast and the same row as anything else typed there.
   *
   * The chain is followed here as well as on the server, so that the note says
   * where the message will actually appear to have come from. The server is
   * still the one that decides -- this is only so the two agree about what is
   * being sent.
   */
  async function forwardMessage(m: MessageDto, channelId: string, note: string) {
    const original = m.forwardedFrom ?? m;
    await api.send(channelId, note, crypto.randomUUID(), {
      forwardedFromId: original.id,
    });
    // No navigation. Forwarding happens mid-conversation, and being moved to
    // another channel for it would lose the place of whoever did it -- so the
    // confirmation is the whole of what happens here.
    const name = channelNameOf(channelId);
    setNotice(name ? `Forwarded to #${name}.` : 'Forwarded.');
  }

  /**
   * Start answering a message, or stop.
   *
   * The ping switch resets every time, because it applies to one reply and not
   * to replying -- see `replyPing`.
   */
  function beginReply(m: Msg) {
    // Nothing on the server to answer yet, and its id is about to change.
    if (m.pending || m.failed) return;
    setReplyTo(m);
    setReplyPing(true);
    composerRef.current?.focus();
  }

  function cancelReply() {
    setReplyTo(null);
    setReplyPing(true);
  }

  /**
   * Land on a message, wherever it is: a search result, a pin, or the message
   * behind a notification.
   *
   * Two paths. If it is already loaded this is a scroll, which is the common
   * case for a pin. If it is not, the channel is opened with the jump left in
   * a ref for the load effect to find, and that effect asks for a window
   * centred on the message rather than the newest page.
   */
  function jumpTo(channelId: string, messageId: string) {
    setPinsOpen(false);
    setSearchOpen(false);

    if (channelId === activeChannel && scrollToMessage(messageId)) {
      // Held for a moment: attachments load after the messages they hang off,
      // so the list keeps growing underneath and would otherwise slide the
      // target back off screen a second after arriving on it.
      holdAt(messageId);
      flash(messageId);
      return;
    }

    pendingJumpRef.current = { channelId, messageId };
    if (channelId === activeChannel) {
      // Same channel, but scrolled out of what is loaded -- so the effect will
      // not re-run on its own. Bump it.
      setJumpNonce((n) => n + 1);
    } else {
      setActiveChannel(channelId);
    }
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

  /**
   * Stage pasted, dropped or picked files until the message is sent.
   *
   * Anything may be attached now, not only pictures. A picture gets an object
   * URL so the composer can show it before it is sent; everything else gets
   * null there and is drawn as a chip with its name, because there is nothing
   * to look at and inventing a thumbnail for a zip helps nobody.
   *
   * Each file arrives not ready and is checked in the background -- see
   * `checkStaged`. Enter will not send until every chip has come back, which
   * is the point: the alternative is finding out that a file is too big or
   * cannot be read only once the message has left the box.
   */
  function addFiles(files: File[]) {
    if (files.length === 0) return;
    // Built before the state update rather than inside it. The updater has to
    // be a pure function of the previous list -- React is free to call it more
    // than once -- and this one makes object URLs and starts the checks, both
    // of which must happen exactly as often as somebody adds a file.
    const taken = files.slice(0, Math.max(0, MAX_FILES - pending.length));
    const staged: Staged[] = taken.map((file) => ({
      id: crypto.randomUUID(),
      file,
      preview: file.type.startsWith('image/')
        ? URL.createObjectURL(file)
        : null,
      ready: false,
      problem: null,
    }));

    if (staged.length) setPending((prev) => [...prev, ...staged]);
    // Said out loud rather than dropped in silence, which is what it used to
    // do -- picking twelve files and being given ten looks like a bug.
    if (files.length > taken.length) {
      const left = files.length - taken.length;
      setBanner(
        `A message can carry ${MAX_FILES} files, so ${left} of those were ` +
          `left behind.`,
      );
    }
    for (const item of staged) void checkStaged(item);
  }

  /**
   * Decide whether one staged file can actually be sent.
   *
   * Two questions, and both of them are cheaper to ask now than to discover
   * from a failed upload. The size, against the limit this server reports --
   * which is the only place the client has ever known that number, and it was
   * being fetched and thrown away. And whether the bytes are readable at all:
   * a single byte is enough to catch a share that has gone away or a drive
   * that has been unplugged since the file was picked.
   */
  async function checkStaged(item: Staged) {
    const settle = (problem: string | null) =>
      setPending((prev) =>
        prev.map((p) => (p.id === item.id ? { ...p, ready: true, problem } : p)),
      );

    const limit = maxUploadRef.current;
    if (limit !== null && item.file.size > limit) {
      settle(
        `${describeBytes(item.file.size)} — over this server's ` +
          `${describeBytes(limit)} limit`,
      );
      return;
    }

    try {
      await item.file.slice(0, 1).arrayBuffer();
    } catch {
      settle('could not be read — has it moved?');
      return;
    }

    // A picture is not staged until its thumbnail has decoded. It is the only
    // part of this check that takes any real time, and it is the part worth
    // waiting for: the chip and the thumbnail then appear together instead of
    // the chip appearing empty and filling in a moment later.
    if (item.preview) {
      await new Promise<void>((resolve) => {
        const img = new Image();
        img.onload = () => resolve();
        // A picture that will not decode is still a file somebody may want to
        // send, so this is not a problem -- only the end of the wait.
        img.onerror = () => resolve();
        img.src = item.preview!;
      });
    }

    settle(null);
  }

  function removePending(id: string) {
    setPending((prev) => {
      const preview = prev.find((p) => p.id === id)?.preview;
      if (preview) URL.revokeObjectURL(preview);
      return prev.filter((p) => p.id !== id);
    });
  }

  function clearPending() {
    setPending((prev) => {
      for (const p of prev) if (p.preview) URL.revokeObjectURL(p.preview);
      return [];
    });
  }

  /** Every staged file has been checked and none of them was refused. */
  const filesReady = pending.every((p) => p.ready && !p.problem);
  /** An upload of ours is on the wire. */
  const uploading = Object.keys(uploads).length > 0;
  /**
   * Whether Enter should send.
   *
   * A second attachment message is refused while one is uploading, and only
   * then: text is instant and there is no reason to hold it back. Sending two
   * large files at once from one machine does not make either arrive sooner,
   * and it makes the progress the composer is showing a lie about which.
   */
  const canSend =
    Boolean(activeChannel) && filesReady && !(uploading && pending.length > 0);

  /**
   * Ctrl+V of a screenshot, or of a file copied in the file manager.
   *
   * Still only takes clipboard items that are files. Pasting text that happens
   * to have come from a file manager must keep pasting text.
   */
  function onPaste(e: React.ClipboardEvent) {
    const files = [...e.clipboardData.items]
      .filter((i) => i.kind === 'file')
      .map((i) => i.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length) {
      e.preventDefault(); // otherwise the filename lands in the textarea too
      addFiles(files);
    }
  }

  /* ------------------------------------------------------------- sending */

  async function send() {
    // Names become ids here, once, on the way out, and any shortcode still
    // spelled out becomes the emoji it names. The textarea has held plain text
    // the whole time it was being written, which is what keeps the composer a
    // textarea; see mention-utils.ts.
    //
    // Tags first, and the order is load-bearing: `toMarkup` reads display
    // names, which may contain a colon, so converting shortcodes first could
    // rewrite a name out from under it. The reverse cannot happen -- a
    // `<@id>` holds no colon for `toEmoji` to find.
    const content = toEmoji(
      toMarkup(draft, mentionUsers, pickedRef.current),
      emojiFor,
    ).trim();
    const files = pending.map((p) => p.file);
    // A pasted screenshot with nothing typed is a perfectly good message.
    if ((!content && files.length === 0) || !activeChannel) return;
    // Read before anything is cleared, so the optimistic row and the request
    // are built from the same answer.
    const answering = replyTo;
    const extra: SendExtrasDto = answering
      ? // Only when it is off: absent means on, which is what the server
        // defaults to, and sending `true` everywhere would make an ordinary
        // reply carry a field about a switch nobody touched.
        { replyToId: answering.id, ...(replyPing ? {} : { replyPing: false }) }
      : {};
    // A file still being checked, one that was refused, or an upload already
    // on the wire. The composer says which, so this only has to stop.
    if (!canSend) return;
    // Measured on the markup, because that is the string the server measures:
    // a message full of tags is longer on the wire than it looks in the box.
    // Refused here rather than sent, so a long message is never lost to a 400
    // the sender cannot see the reason for.
    if (content.length > MAX_MESSAGE_CHARS) {
      setBanner(
        `That message is ${content.length} characters and the limit is ` +
          `${MAX_MESSAGE_CHARS}. Send it in two.`,
      );
      return;
    }
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
      // Only the pictures: everything else has nothing to preview, and the
      // optimistic copy simply shows the text until the echo brings the
      // real attachment rows back.
      previews: pending.map((p) => p.preview).filter((u): u is string => Boolean(u)),
      pending: true,
      // Built here rather than waited for, so the strip is above the reply the
      // instant it appears. The echo replaces the whole row with the server's
      // version a moment later, which is the same thing derived from the
      // database -- this is only what fills the gap.
      replyTo: answering ? toRef(answering) : null,
      forwardedFrom: null,
    };
    setMessages((prev) => [...prev, optimistic]);
    setDraft('');
    cancelReply();
    pickedRef.current = new Set();
    setPicker(null);
    // The object URLs now belong to the outbox entry rather than to `pending`,
    // so this clears the staged list without revoking them -- the optimistic
    // row is still drawing them, and a retry would need them again.
    outboxRef.current.set(nonce, { row: optimistic, files, extra });
    setPending([]);
    stopTyping();
    requestAnimationFrame(scrollToBottom);

    await deliver(nonce, activeChannel);
  }

  /**
   * Post one outbox entry and reconcile the optimistic row with what came back.
   *
   * A failure leaves the row where it is, marked with the reason and offering
   * a retry, rather than dropping it: quietly losing something somebody typed
   * is the worse of the two. What it must not do is leave the row looking like
   * an ordinary message -- that was the old behaviour, and it produced a
   * message that could not be deleted because there was nothing on the server
   * to delete, and that only went away on a reload.
   */
  async function deliver(nonce: string, channelId: string) {
    const entry = outboxRef.current.get(nonce);
    if (!entry) return;
    const { row, files, extra } = entry;
    // Zero rather than absent, so the ring appears the instant the message
    // does. A file large enough to need one takes long enough that a ring
    // arriving on the first progress event would be a visible stutter.
    if (files.length) setUploads((prev) => ({ ...prev, [nonce]: 0 }));
    try {
      const saved = files.length
        ? await api.sendWithFiles(
            channelId,
            row.content,
            nonce,
            files,
            extra,
            (f) =>
              setUploads((prev) =>
                // Never backwards. A retry starts a second request whose early
                // events would otherwise drag the ring back to nothing.
                prev[nonce] === undefined || f > prev[nonce]
                  ? { ...prev, [nonce]: f }
                  : prev,
              ),
          )
        : await api.send(channelId, row.content, nonce, extra);
      outboxRef.current.delete(nonce);
      for (const url of row.previews ?? []) URL.revokeObjectURL(url);
      // The socket echo usually lands first; reconcile either way by nonce.
      setMessages((prev) => {
        const i = prev.findIndex((x) => x.clientNonce === nonce);
        if (i < 0) return prev;
        const next = prev.slice();
        next[i] = saved;
        return next;
      });
    } catch (e: any) {
      // Marked on the outbox copy as well as the one on screen, because the
      // outbox copy is what the list is rebuilt from after a channel switch.
      const failed = { ...row, failed: e?.message || 'Could not send that message.' };
      outboxRef.current.set(nonce, { row: failed, files, extra });
      setMessages((prev) =>
        prev.map((x) => (x.clientNonce === nonce ? failed : x)),
      );
    } finally {
      // Both ways out, or a send that failed would leave a ring turning for
      // ever and the composer refusing every attachment after it.
      setUploads((prev) => {
        if (prev[nonce] === undefined) return prev;
        const next = { ...prev };
        delete next[nonce];
        return next;
      });
    }
  }

  /** Send it again, with the same nonce so a message cannot be sent twice. */
  function retrySend(m: Msg) {
    const nonce = m.clientNonce;
    const entry = nonce ? outboxRef.current.get(nonce) : undefined;
    if (!nonce || !entry) return;
    const row = { ...entry.row, failed: undefined };
    outboxRef.current.set(nonce, { ...entry, row });
    setMessages((prev) => prev.map((x) => (x.clientNonce === nonce ? row : x)));
    void deliver(nonce, m.channelId);
  }

  /**
   * Throw away a message that never reached the server.
   *
   * Purely local, and deliberately not routed through `askDelete`: there is
   * nothing on the server to delete, so the confirmation would be promising to
   * remove it "for everyone" when nobody else ever saw it, and the DELETE
   * behind it would 404 on an id that only ever existed in this window.
   *
   * The text goes back to the composer when the composer is empty, which is
   * the usual case and the difference between discarding a failed send and
   * losing the paragraph it was carrying.
   */
  function discardFailed(m: Msg) {
    const nonce = m.clientNonce;
    const entry = nonce ? outboxRef.current.get(nonce) : undefined;
    if (entry) {
      for (const url of entry.row.previews ?? []) URL.revokeObjectURL(url);
      outboxRef.current.delete(nonce!);
      if (!draft.trim() && entry.row.content) {
        setDraft(toPlain(entry.row.content, (id) => lookupUser(id)));
      }
    }
    setMessages((prev) => prev.filter((x) => x.id !== m.id));
  }

  /**
   * Put failed sends back after the list has been replaced.
   *
   * Opening a channel, jumping into history and coming back to the live end
   * all reload the list from the server, and the server has never heard of
   * these. Without this they would go on the first channel switch, which is
   * the same disappearing act this whole path exists to stop -- only quieter,
   * because the sender would not have pressed anything to cause it.
   */
  useEffect(() => {
    if (!activeChannel) return;
    const back = [...outboxRef.current.values()]
      .map((e) => e.row)
      .filter(
        (row) =>
          row.failed &&
          row.channelId === activeChannel &&
          !messages.some((m) => m.clientNonce === row.clientNonce),
      );
    if (back.length === 0) return;
    setMessages((prev) => [...prev, ...back]);
  }, [messages, activeChannel]);

  /** Nothing is going to be retried after the window closes. */
  useEffect(
    () => () => {
      for (const { row } of outboxRef.current.values()) {
        for (const url of row.previews ?? []) URL.revokeObjectURL(url);
      }
      outboxRef.current.clear();
    },
    [],
  );

  /**
   * Open, move or close whichever list the caret is now inside.
   *
   * Driven by the caret rather than by the last keystroke, so it behaves the
   * same whether the `@` was typed, pasted, or arrived at with an arrow key.
   * The selected row resets to the top on every change: after another
   * character the old row is answering a question nobody asked any more.
   *
   * Tags are asked about first, and the two cannot both be open because this
   * returns as soon as one of them answers. They rarely both could: an `@`
   * query may contain spaces and a shortcode may not, so "@bob :sm" is a tag
   * query that matches nobody and falls through to the shortcode, and ":sm
   * @bob" is not a shortcode query at all.
   */
  function syncPicker(text: string, caret: number) {
    caretRef.current = caret;
    const done = justPickedRef.current;
    if (done && done.text === text && done.caret === caret) {
      setPicker(null);
      return;
    }
    justPickedRef.current = null;

    // Nothing matching closes it. That is what stops an "@" in ordinary prose
    // from leaving a popup hanging over the rest of the sentence.
    const tag = mentionQuery(text, caret);
    if (tag && matchUsers(mentionUsers, tag.query, 1).length > 0) {
      setPicker({ kind: 'mention', ...tag, index: 0 });
      return;
    }

    const shortcode = emojiQuery(text, caret);
    if (shortcode && matchEmoji(EMOJI_PAIRS, shortcode.query, 1).length > 0) {
      setPicker({ kind: 'emoji', ...shortcode, index: 0 });
      return;
    }

    setPicker(null);
  }

  /* ---------------------------------------------------------- reactions */

  /**
   * Add or take back my reaction, showing the result before the server agrees.
   *
   * Optimistic, and rolled back if the request fails -- the same deal
   * `retrySend` offers. Without it there is a visible pause between clicking
   * an emoji and the number moving, on the one interaction in the app that has
   * to feel instant because people use it instead of typing.
   *
   * The response carries every pile on the message, not just the one that
   * changed, so the answer replaces the guess wholesale and a reaction
   * somebody else added in the same moment arrives with it.
   */
  async function toggleReaction(m: Msg, emoji: string, mine: boolean) {
    if (!activeChannel || m.pending) return;
    const channelId = m.channelId;

    const before = m.reactions ?? [];
    setMessages((prev) =>
      prev.map((x) =>
        x.id === m.id ? { ...x, reactions: guessReactions(before, emoji, mine, me.id) } : x,
      ),
    );

    try {
      const reactions = mine
        ? await api.unreact(channelId, m.id, emoji)
        : await api.react(channelId, m.id, emoji);
      setMessages((prev) =>
        prev.map((x) => (x.id === m.id ? { ...x, reactions } : x)),
      );
    } catch (e: any) {
      // Back to exactly what was there. The cap is the refusal people will
      // actually meet, and it arrives with a sentence worth showing.
      setMessages((prev) =>
        prev.map((x) => (x.id === m.id ? { ...x, reactions: before } : x)),
      );
      setBanner(e?.message ?? 'That reaction could not be saved.');
    }
  }

  /**
   * Put an emoji from the grid into the draft, where the caret last was.
   *
   * Not `applyEmoji`: that one replaces a half-typed `:shortcode`, and there
   * is no query here -- the grid is what you open when you do not know the
   * name.
   */
  function insertEmoji(emoji: string) {
    const at = Math.min(caretRef.current, draft.length);
    const next = draft.slice(0, at) + emoji + draft.slice(at);
    const caret = at + emoji.length;
    caretRef.current = caret;
    setDraft(next);
    setEmojiBrowser(false);
    // After React has written the value, or the caret lands in the old text.
    requestAnimationFrame(() => {
      const box = composerRef.current;
      if (!box) return;
      box.focus();
      box.setSelectionRange(caret, caret);
    });
  }

  /** Put the row at `index` of the open list into the draft, whichever it is. */
  function choosePickerRow(index: number) {
    if (picker?.kind === 'mention') chooseMention(mentionMatches[index]);
    else if (picker?.kind === 'emoji') chooseEmoji(emojiMatches[index]);
  }

  /**
   * Put the chosen emoji in the draft.
   *
   * Nothing is remembered about it, unlike a tag: a name has to be resolved to
   * an id on the way out and two people can answer to one string, whereas the
   * character inserted here *is* what gets sent.
   */
  function chooseEmoji(match: EmojiMatch) {
    if (picker?.kind !== 'emoji') return;
    const next = applyEmoji(draft, picker, match.emoji);
    justPickedRef.current = next;
    setDraft(next.text);
    setPicker(null);
    requestAnimationFrame(() => {
      const box = composerRef.current;
      if (!box) return;
      box.focus();
      box.setSelectionRange(next.caret, next.caret);
    });
  }

  /** Put the chosen name in the draft and remember whose it was. */
  function chooseMention(user: MentionUser) {
    if (picker?.kind !== 'mention') return;
    const next = applyMention(draft, picker, user);
    pickedRef.current.add(user.id);
    justPickedRef.current = next;
    setDraft(next.text);
    setPicker(null);
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
    syncPicker(v, caret);
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
  /**
   * Whether this message can be answered, passed on, or reacted to. Anybody's,
   * including your own -- but not one the server has never heard of, since all
   * three point at an id, and a message still in flight has one that is about
   * to be replaced by a real one.
   */
  const canQuote = (m: Msg) => !m.pending && !m.failed;

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
    // Back to markers and emoji, the same conversion `send` does and in the
    // same order. Compared against the stored content afterwards, so re-saving
    // an untouched message with tags in it is still recognised as no change --
    // which holds for emoji too, because the stored form is already the
    // character and converting it again leaves it alone.
    const content = toEmoji(toMarkup(editDraft, mentionUsers), emojiFor).trim();
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
                          // The AFK room says so before anyone joins it: the
                          // crossed-out speaker is the whole difference between
                          // a quiet channel and one that cannot be spoken in,
                          // and somebody who has to join to find out has
                          // already walked out of the conversation they were
                          // in to do it.
                          title={
                            c.listenOnly
                              ? here
                                ? 'You are parked here — nobody can talk in this channel'
                                : 'Park here — nobody can talk in this channel'
                              : here
                                ? 'You are in this channel'
                                : 'Join voice'
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
                          <span className="hash">{channelIcon(c)}</span>
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
                              {/* One icon, not two: deafening mutes you as
                                  well, and a row carrying both says nothing
                                  the deafen icon did not already say.

                                  And no mute icon at all in an AFK channel,
                                  where every row would carry one: the channel
                                  said it once, at the top, and repeating it
                                  per person reads as something each of them
                                  did. Deafen still shows — that is a choice
                                  somebody made in a room nobody talks in. */}
                              {peer?.deafened ? (
                                <span className="vm-icon" title="Deafened">
                                  🔕
                                </span>
                              ) : (
                                peer?.muted &&
                                !c.listenOnly && (
                                  <span className="vm-icon" title="Muted">
                                    🔇
                                  </span>
                                )
                              )}
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
          // Every key that would work, not just the first: a reminder that
          // names one of two bound keys is wrong about the other.
          pttLabel={pttLabel}
          // A mute of our own is said first when both are true: it is the one
          // that outlives this channel, so it is the one still worth knowing
          // about after leaving. The room's rule stops applying at the door.
          serverMuted={
            iAmMuted
              ? muteLabel(myMutedUntil!)
              : voice.listenOnly
                ? 'Nobody talks in this channel'
                : null
          }
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
            {activeChannelObj ? channelIcon(activeChannelObj) : '#'}
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
                setSearchOpen(false);
                setPinsOpen((open) => !open);
              }}
            >
              📌
            </button>
          )}
          {activeChannelObj?.kind === 'TEXT' && (
            <button
              className={'pin-btn' + (searchOpen ? ' on' : '')}
              title="Search messages"
              onClick={(e) => {
                e.stopPropagation();
                setPinsOpen(false);
                setSearchOpen((open) => !open);
              }}
            >
              🔍
            </button>
          )}
          <div className={'status-dot ' + status} title={status} />
          <span className="status-label">
            {status === 'connected'
              ? 'live'
              : serverRestarting
                ? 'updating…'
                : status === 'connecting'
                  ? 'reconnecting…'
                  : 'offline'}
          </span>

          {searchOpen && (
            <SearchPanel
              text={searchText}
              onText={setSearchText}
              results={searchResults}
              busy={searchBusy}
              error={searchError}
              channelName={(id) => channelNameOf(id) ?? 'unknown'}
              onJump={jumpTo}
              onClose={() => setSearchOpen(false)}
              lookupMention={lookupMention}
            />
          )}

          {pinsOpen && activeChannelObj && (
            <PinsPanel
              channelName={activeChannelObj.name}
              pins={pins}
              error={pinsError}
              canPin={iAmAdmin}
              onUnpin={(m) => void togglePin(m)}
              onJump={(id) => jumpTo(activeChannel!, id)}
              onClose={() => setPinsOpen(false)}
              lookupMention={lookupMention}
            />
          )}
        </div>

        {banner && <div className="banner">{banner}</div>}
        {notice && <div className="banner good">{notice}</div>}

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
                  // A reply always starts its own block. It carries a strip
                  // saying what it answers, and a strip hanging off a message
                  // with no author line above it reads as belonging to the
                  // message before it rather than to this one.
                  !m.replyTo &&
                  prev.author.id === m.author.id &&
                  new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000;
                return (
                  // `data-mid` is how the reading position is both read off the
                  // list and restored to it. Unsent messages are left untagged:
                  // their ids do not survive the round trip.
                  <div
                    key={m.id}
                    data-mid={m.pending ? undefined : m.id}
                    // Landed on by a jump. A brief flash rather than a lasting
                    // mark: it answers "which one" at the moment of arrival,
                    // and a highlight still there five minutes later is a
                    // second unread marker saying something else.
                    className={m.id === flashId ? 'flash' : undefined}
                  >
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
                        (m.failed ? ' failed' : '') +
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
                        {/* Above the author line, because it is what the
                            message is answering and has to be read first --
                            and because a reply is never grouped under the
                            message before it, so there is always room. */}
                        {m.replyTo && (
                          <ReplyStrip
                            refMsg={m.replyTo}
                            lookupMention={lookupMention}
                            onJump={() => jumpTo(m.replyTo!.channelId, m.replyTo!.id)}
                          />
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
                            {/* Under whatever the forwarder said about it,
                                because the note is theirs and the card is
                                somebody else's -- reading it the other way
                                round attributes the note to the wrong person
                                for as long as it takes to reach the name. */}
                            {m.forwardedFrom && (
                              <ForwardCard
                                refMsg={m.forwardedFrom}
                                channelName={channelNameOf(m.forwardedFrom.channelId)}
                                lookupMention={lookupMention}
                                onJump={() =>
                                  jumpTo(
                                    m.forwardedFrom!.channelId,
                                    m.forwardedFrom!.id,
                                  )
                                }
                              />
                            )}
                            {/* Our own pasted images, shown before the server echo. */}
                            {m.previews?.map((url) => (
                              <PreviewImage key={url} url={url} />
                            ))}
                            {/* How far the attachments have got. A message
                                with no files never shows one -- those are gone
                                in a round trip, and a ring that appears and
                                vanishes is worse than nothing at all. */}
                            {m.clientNonce !== null &&
                              m.clientNonce !== undefined &&
                              uploads[m.clientNonce] !== undefined &&
                              !m.failed && (
                                <UploadRing
                                  fraction={uploads[m.clientNonce]}
                                />
                              )}
                            {/* A send that never landed. The buttons live here
                                rather than in the hover row because that row is
                                edit, pin and delete -- all of which need a
                                message the server has, and this is the one
                                message it has not. */}
                            {m.failed && (
                              <div className="msg-failed">
                                <span>{m.failed}</span>
                                <a onClick={() => retrySend(m)}>Retry</a>
                                <a onClick={() => discardFailed(m)}>Discard</a>
                              </div>
                            )}
                            {/* Under everything the message itself carries,
                                because it is what other people said about it
                                rather than part of it. Drawn here rather than
                                inside MessageContent so the pin board and the
                                search results -- which draw the same content
                                -- do not get a count nobody can click. */}
                            <ReactionBar
                              reactions={m.reactions ?? []}
                              meId={me.id}
                              lookupName={(id) => {
                                const user = lookupUser(id);
                                return user ? mentionName(user) : null;
                              }}
                              onToggle={(emoji, mine) =>
                                void toggleReaction(m, emoji, mine)
                              }
                            />
                          </>
                        )}
                      </div>
                      {editingId !== m.id &&
                        (canQuote(m) || canEdit(m) || canPin(m) || canDelete(m)) && (
                          <div className="msg-actions">
                            {/* First in the row, ahead of replying, because it
                                is the lightest thing anybody does to somebody
                                else's message -- and the one people reach for
                                instead of typing. */}
                            {canQuote(m) && (
                              <button
                                className={reactingTo === m.id ? 'on' : undefined}
                                title="Add a reaction"
                                onClick={() =>
                                  setReactingTo((open) => (open === m.id ? null : m.id))
                                }
                              >
                                ☺
                              </button>
                            )}
                            {canQuote(m) && (
                              <button title="Reply" onClick={() => beginReply(m)}>
                                ↩
                              </button>
                            )}
                            {canQuote(m) && (
                              <button
                                title="Forward to another channel"
                                onClick={() => setForwarding(m)}
                              >
                                ↪
                              </button>
                            )}
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
                      {/* Anchored to the message rather than to the row of
                          buttons, which is only there while the pointer is
                          over the message -- and the pointer leaves it the
                          moment it moves into the grid. */}
                      {reactingTo === m.id && (
                        <EmojiBrowser
                          className="over-message"
                          onPick={(emoji) => {
                            setReactingTo(null);
                            void toggleReaction(
                              m,
                              emoji,
                              (m.reactions ?? []).some(
                                (r) => r.emoji === emoji && r.userIds.includes(me.id),
                              ),
                            );
                          }}
                          onClose={() => setReactingTo(null)}
                        />
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
          {replyTo && (
            <div className="reply-bar">
              <span className="reply-hook" aria-hidden />
              <span className="reply-bar-text">
                Replying to{' '}
                <strong>
                  {replyTo.author.displayName || replyTo.author.username}
                </strong>
                <span className="reply-line">
                  {quoteLine(
                    toPlain(replyTo.content, (id) => lookupUser(id)),
                    replyTo.attachments.length,
                    false,
                  )}
                </span>
              </span>
              {/* Not shown when answering yourself: there is nobody to tag,
                  the server drops the ping either way, and a switch that does
                  nothing is worse than no switch. */}
              {replyTo.author.id !== me.id && (
                <button
                  className={'reply-ping' + (replyPing ? ' on' : '')}
                  title={
                    replyPing
                      ? 'They will be tagged. Click to reply quietly.'
                      : 'Replying quietly. Click to tag them.'
                  }
                  onClick={() => setReplyPing((on) => !on)}
                >
                  {replyPing ? '@ on' : '@ off'}
                </button>
              )}
              <button className="reply-x" title="Cancel reply" onClick={cancelReply}>
                ×
              </button>
            </div>
          )}
          {pending.length > 0 && (
            <div className="staged">
              {pending.map((p) => (
                <div
                  className={
                    'staged-item' +
                    (p.preview ? '' : ' as-file') +
                    (p.ready ? '' : ' checking') +
                    (p.problem ? ' rejected' : '')
                  }
                  key={p.id}
                  title={
                    p.problem
                      ? `${p.file.name} — ${p.problem}`
                      : `${p.file.name} (${describeBytes(p.file.size)})`
                  }
                >
                  {p.preview ? (
                    <img src={p.preview} alt="" />
                  ) : (
                    <span className="staged-name">{p.file.name}</span>
                  )}
                  {/* Over the thumbnail rather than beside it: the chip is
                      already as small as it reads at, and the state belongs to
                      the file rather than sitting next to it. */}
                  {!p.ready && <span className="staged-spin" />}
                  {p.problem && <span className="staged-bad">!</span>}
                  <button
                    className="staged-x"
                    onClick={() => removePending(p.id)}
                    title="Remove"
                  >
                    ×
                  </button>
                </div>
              ))}
              {/* One line under the row, because the chips are too small to
                  carry a sentence and the reason has to be readable. */}
              {pending.some((p) => p.problem) && (
                <div className="staged-note bad">
                  {pending.find((p) => p.problem)!.file.name}{' '}
                  {pending.find((p) => p.problem)!.problem}. Remove it to send.
                </div>
              )}
              {!filesReady && !pending.some((p) => p.problem) && (
                <div className="staged-note">Checking…</div>
              )}
            </div>
          )}
          {picker?.kind === 'mention' && mentionMatches.length > 0 && (
            <MentionPicker
              matches={mentionMatches}
              index={picker.index}
              onHover={(i) =>
                setPicker((prev) => (prev ? { ...prev, index: i } : prev))
              }
              onPick={chooseMention}
            />
          )}
          {picker?.kind === 'emoji' && emojiMatches.length > 0 && (
            <EmojiPicker
              matches={emojiMatches}
              index={picker.index}
              onHover={(i) =>
                setPicker((prev) => (prev ? { ...prev, index: i } : prev))
              }
              onPick={chooseEmoji}
            />
          )}
          {emojiBrowser && (
            <EmojiBrowser
              className="over-composer"
              onPick={insertEmoji}
              onClose={() => setEmojiBrowser(false)}
            />
          )}
          {/* Until now files only arrived by paste or drag, which are both
              things you have to already know about. */}
          <button
            className="attach-btn"
            title="Attach a file"
            disabled={!activeChannelObj || activeChannelObj.kind !== 'TEXT'}
            onClick={() => fileInputRef.current?.click()}
          >
            📎
          </button>
          {/* The other half of the shortcodes: `:tada:` is faster than any
              grid for somebody who knows the name, and this is for everybody
              who does not. */}
          <button
            className="attach-btn"
            title="Emoji"
            disabled={!activeChannelObj || activeChannelObj.kind !== 'TEXT'}
            onClick={() => {
              // The textarea loses the caret to the panel's search box, so
              // where it was is read now rather than when something is picked.
              const box = composerRef.current;
              if (box && document.activeElement === box) {
                caretRef.current = box.selectionStart;
              }
              setPicker(null);
              setEmojiBrowser((open) => !open);
            }}
          >
            😀
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles([...(e.target.files ?? [])]);
              // Cleared, or picking the same file twice in a row fires no
              // change event and looks exactly like a broken button.
              e.target.value = '';
            }}
          />
          <textarea
            ref={composerRef}
            rows={1}
            value={draft}
            // A mute is not consulted here any more. It takes the microphone
            // and leaves the keyboard, so a muted person types as normal.
            placeholder={
              activeChannelObj
                ? uploading && pending.length
                  ? 'Waiting for the current upload to finish…'
                  : pending.length
                    ? filesReady
                      ? 'Add a message, or press Enter to send'
                      : 'Checking the files…'
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
                syncPicker(box.value, box.selectionStart);
              }
            }}
            onBlur={() => {
              stopTyping();
              setPicker(null);
            }}
            onKeyDown={(e) => {
              // While a list is open it owns the keys that move around it, and
              // nothing else: every other key still types. Which list it is
              // does not matter here -- only one can be open, and the row
              // count and the pick are asked for without naming it.
              if (picker && pickerRowCount > 0) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  const step = e.key === 'ArrowDown' ? 1 : -1;
                  setPicker((prev) =>
                    prev
                      ? {
                          ...prev,
                          // Wraps, so holding one arrow key cannot strand the
                          // selection at an end of a short list.
                          index:
                            (prev.index + step + pickerRowCount) % pickerRowCount,
                        }
                      : prev,
                  );
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  choosePickerRow(picker.index);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setPicker(null);
                  return;
                }
              }
              // After the picker, which owns Escape while it is open: one
              // press closes the list, the next lets go of the reply.
              if (e.key === 'Escape' && replyTo) {
                e.preventDefault();
                cancelReply();
                return;
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
            {channelIcon(channelMenu.channel)}{' '}
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
      {forwarding && (
        <ForwardModal
          quote={quoteLine(
            toPlain(forwarding.content, (id) => lookupUser(id)),
            forwarding.attachments.length,
            false,
          )}
          channels={forwardTargets}
          onClose={() => setForwarding(null)}
          onSent={(channelId, note) => forwardMessage(forwarding, channelId, note)}
        />
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
          keybinds={keybinds}
          onKeybindsChange={updateKeybinds}
          notifications={notifications}
          voice={voice}
          onChange={(patch) => void updateVoiceSettings(patch)}
          onNotificationsChange={(patch) => void updateNotifications(patch)}
          onProfileSaved={applyUserUpdate}
          updates={updates}
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

/**
 * The list that opens when you type `:` and two more characters.
 *
 * The same box as the tag list above, in the same place, with the same
 * `onMouseDown` rather than `onClick` -- a click blurs the textarea, the blur
 * closes the list, and an `onClick` would land on nothing.
 *
 * Two characters before it opens, where a tag opens on a bare `@`. A colon is
 * ordinary punctuation in a way `@` is not, and the reasoning is in
 * `emoji-utils.ts` beside the constant.
 */
function EmojiPicker({
  matches,
  index,
  onHover,
  onPick,
}: {
  matches: EmojiMatch[];
  index: number;
  onHover: (index: number) => void;
  onPick: (match: EmojiMatch) => void;
}) {
  return (
    <div className="mention-picker">
      <div className="mention-picker-head">Emoji</div>
      {matches.map((match, i) => (
        <button
          key={match.shortcode}
          className={'mention-row' + (i === index ? ' on' : '')}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(match);
          }}
        >
          <span className="emoji-row-glyph">{match.emoji}</span>
          <span className="mention-row-name">:{match.shortcode}:</span>
        </button>
      ))}
    </div>
  );
}

/**
 * How far an attachment upload has got.
 *
 * An SVG ring rather than a bar, because it sits inside a message rather than
 * across one, and it has to read at the size of a line of text. The stroke is
 * drawn by dash offset, which is the one way to do this without a library.
 *
 * At 100% it stops being a measurement and becomes a spinner: the bytes have
 * all left, but the server is still writing the files and the row, and a full
 * ring sitting motionless through that looks like something that has finished
 * and got stuck rather than something still working.
 */
function UploadRing({ fraction }: { fraction: number }) {
  const clamped = Math.max(0, Math.min(1, fraction));
  const done = clamped >= 1;
  // r=7 in a 18x18 box leaves room for the 2px stroke without clipping.
  const circumference = 2 * Math.PI * 7;

  return (
    <div className={'upload-ring' + (done ? ' finishing' : '')}>
      <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
        <circle className="ring-track" cx="9" cy="9" r="7" />
        <circle
          className="ring-arc"
          cx="9"
          cy="9"
          r="7"
          strokeDasharray={circumference}
          // A full circle when it is spinning, so the arc the animation turns
          // is a constant rather than whatever the last reading happened to be.
          strokeDashoffset={done ? circumference * 0.25 : circumference * (1 - clamped)}
        />
      </svg>
      <span>
        {done ? 'Finishing…' : `Uploading… ${Math.round(clamped * 100)}%`}
      </span>
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
