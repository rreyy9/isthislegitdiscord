import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  setToken,
  type BanDto,
  type GuildDto,
  type MemberDto,
  type MessageDto,
  type Me,
} from '../api';
import { MessageContent } from './MessageContent';
import {
  connectSocket,
  disconnectSocket,
  joinChannel,
  leaveChannel,
  typingStart,
  typingStop,
} from '../socket';
import { bridge } from '../bridge';
import { useVoice, type VoiceSettings } from '../voice';
import {
  ScreenPicker,
  ScreenStage,
  SettingsModal,
  UserVolumeMenu,
  VoicePanel,
} from './Voice';
import { useImageActions } from './ImageViewer';

type Status = 'connected' | 'disconnected' | 'connecting';

/**
 * A message plus client-only fields for optimistic rendering: `pending` while
 * the server has not confirmed it, and `previews` so a pasted image is visible
 * immediately rather than after the round trip.
 */
type Msg = MessageDto & { pending?: boolean; previews?: string[] };

function initials(name: string) {
  return name.slice(0, 2).toUpperCase();
}
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
 * An indefinite mute is stored as a date in the year 9999, so that every check
 * is one comparison. Nobody wants to read that date, hence this.
 */
const isForever = (iso: string) => new Date(iso).getFullYear() > 9000;

function muteLabel(iso: string) {
  if (isForever(iso)) return 'Muted indefinitely';
  const d = new Date(iso);
  const sameDayAsNow = d.toDateString() === new Date().toDateString();
  return `Muted until ${
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

export function Chat({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const [guilds, setGuilds] = useState<GuildDto[]>([]);
  const [members, setMembers] = useState<MemberDto[]>([]);
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
    pttKeycode: null,
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
  const [showSettings, setShowSettings] = useState(false);
  /** Images pasted or dropped, held locally until the message is sent. */
  const [pending, setPending] = useState<{ file: File; preview: string }[]>([]);
  /** channelId -> last message id this user has read. */
  const [reads, setReads] = useState<Record<string, string>>({});
  /** Newest message id seen per channel, so unread is a comparison of two ids. */
  const [latest, setLatest] = useState<Record<string, string>>({});
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
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [showBans, setShowBans] = useState(false);
  /** Set when the server says we were kicked or banned; the app stops here. */
  const [removed, setRemoved] = useState<{
    kind: 'kick' | 'ban';
    reason: string | null;
  } | null>(null);
  /** A refused moderation action, shown briefly rather than swallowed. */
  const [banner, setBanner] = useState<string | null>(null);

  const voice = useVoice(voiceSettings);

  const msgsRef = useRef<HTMLDivElement>(null);
  const activeChannelRef = useRef<string | null>(null);
  const lastSeenIdRef = useRef<string | null>(null);
  const typingSentRef = useRef(false);

  activeChannelRef.current = activeChannel;

  const activeChannelObj = guilds
    .flatMap((g) => g.channels)
    .find((c) => c.id === activeChannel);

  /**
   * Our own row in the member list is where the client learns both its role
   * and its mute — there is no separate "who am I allowed to do things to"
   * call, and every check the UI makes is repeated on the server anyway.
   */
  const myMember = members.find((m) => m.user.id === me.id);
  const iAmAdmin = myMember?.role === 'ADMIN';
  const myMutedUntil = myMember?.mutedUntil ?? null;
  const iAmMuted = Boolean(myMutedUntil && new Date(myMutedUntil) > new Date());

  /* ------------------------------------------------------ initial + socket */

  useEffect(() => {
    void bridge.getSettings().then((s) => {
      setVoiceSettings(s.voice);
      setLastVoiceChannelId(s.lastVoiceChannelId);
      setSettingsReady(true);
    });
  }, []);

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

  useEffect(() => {
    (async () => {
      const gs = await api.guilds();
      setGuilds(gs);
      const firstText = gs[0]?.channels.find((c) => c.kind === 'TEXT');
      if (firstText) setActiveChannel(firstText.id);
      await loadMembers();
      // A client starting up mid-call would otherwise see empty voice channels
      // until the next person joined or left.
      await loadVoiceState();
      await loadReads(gs);
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
        void markRead(m.channelId, m.id);
      },
      onMessageUpdated: (m) =>
        setMessages((prev) =>
          prev.map((x) => (x.id === m.id ? { ...x, ...m } : x)),
        ),
      // Deleted messages are removed outright rather than tombstoned: history
      // filters them server-side too, so a reload would not bring them back.
      onMessageDeleted: ({ id }) =>
        setMessages((prev) => prev.filter((x) => x.id !== id)),
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
      onPresence: () => loadMembers(),
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
        void loadReads();
      },
    });

    return () => disconnectSocket();
  }, [loadMembers, me.id]);

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
   * so wake up once at the deadline and refresh, or the composer would stay
   * disabled until the next reconnect.
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
   * Walk back into the channel this client was in when it last stopped.
   *
   * Guarded by a ref rather than by state because it has to happen exactly
   * once. The guild list and the settings arrive independently, so this runs
   * again when the second of them lands — and by then somebody may already
   * have left the channel it is about to put them back into.
   */
  const rejoinedRef = useRef(false);
  useEffect(() => {
    if (rejoinedRef.current || !settingsReady) return;
    if (!voiceSettings.rejoinLastChannel || !lastVoiceChannelId) return;
    const channel = guilds
      .flatMap((g) => g.channels)
      .find((c) => c.id === lastVoiceChannelId && c.kind === 'VOICE');
    // A channel that has since been deleted, or that we were kicked out of,
    // simply is not there — leave the stored id alone and try again next time.
    if (!channel) return;
    rejoinedRef.current = true;
    void voice.join(channel.id);
  }, [
    guilds,
    settingsReady,
    voiceSettings.rejoinLastChannel,
    lastVoiceChannelId,
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

  // Errors from a refused action are worth reading, not worth keeping.
  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 5000);
    return () => clearTimeout(t);
  }, [banner]);

  /* --------------------------------------------------------- channel load */

  useEffect(() => {
    if (!activeChannel) return;
    let cancelled = false;
    joinChannel(activeChannel);
    setMessages([]);
    setTypingUsers({});
    clearPending();
    (async () => {
      const page = await api.history(activeChannel);
      if (cancelled) return;
      setMessages(page.messages);
      setCursor(page.nextCursor);
      const last = page.messages[page.messages.length - 1];
      lastSeenIdRef.current = last?.id ?? null;
      if (last) {
        setLatest((prev) => ({ ...prev, [activeChannel]: last.id }));
        void markRead(activeChannel, last.id);
      }
      requestAnimationFrame(scrollToBottom);
    })();
    return () => {
      cancelled = true;
      leaveChannel(activeChannel);
    };
  }, [activeChannel]);

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

  /** Tell the server how far we have read, and stop the dot locally at once. */
  async function markRead(channelId: string, messageId: string) {
    setReads((prev) =>
      !prev[channelId] || messageId > prev[channelId]
        ? { ...prev, [channelId]: messageId }
        : prev,
    );
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
    const content = draft.trim();
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
      attachments: [],
      previews: pending.map((p) => p.preview),
      pending: true,
    };
    setMessages((prev) => [...prev, optimistic]);
    setDraft('');
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

  function onDraftChange(v: string) {
    setDraft(v);
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

  /** Your own messages, and not one that is still in flight. */
  const canEdit = (m: Msg) => m.author.id === me.id && !m.pending && !iAmMuted;
  /** Your own, or anyone's if you administer the server. */
  const canDelete = (m: Msg) => (m.author.id === me.id || iAmAdmin) && !m.pending;

  function beginEdit(m: Msg) {
    setEditingId(m.id);
    setEditDraft(m.content);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft('');
  }

  async function saveEdit(m: Msg) {
    const content = editDraft.trim();
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
              <div className="sb-section">Text</div>
              {g.channels.filter((c) => c.kind === 'TEXT').map((c) => (
                <div
                  key={c.id}
                  className={
                    'chan' +
                    (c.id === activeChannel ? ' active' : '') +
                    (isUnread(c.id) ? ' unread' : '')
                  }
                  onClick={() => setActiveChannel(c.id)}
                >
                  <span className="hash">#</span>
                  {c.name}
                  {isUnread(c.id) && <span className="unread-dot" />}
                </div>
              ))}
              {g.channels.some((c) => c.kind === 'VOICE') && (
                <>
                  <div className="sb-section">Voice</div>
                  {g.channels.filter((c) => c.kind === 'VOICE').map((c) => {
                    const occupants = voiceByChannel[c.id] ?? [];
                    const here = voice.channelId === c.id;
                    return (
                      <div key={c.id}>
                        <div
                          className={'chan' + (here ? ' in-voice' : '')}
                          title={here ? 'You are in this channel' : 'Join voice'}
                          onClick={() => (here ? leaveVoice() : joinVoice(c.id))}
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
                              <div className="avatar tiny">
                                {initials(nameOfUser(id))}
                              </div>
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
          onLeave={leaveVoice}
          onOpenSettings={() => setShowSettings(true)}
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
            <div className="avatar" style={{ width: 30, height: 30, fontSize: 12 }}>
              {initials(me.displayName || me.username || '?')}
            </div>
            <div className="name">{me.displayName || me.username}</div>
            <span className="footer-caret">▾</span>
          </button>
          <button onClick={signOut}>Sign out</button>
        </div>
      </div>

      {/* -------- chat -------- */}
      <div className="col chat">
        <div className="chat-head">
          <span className="hash" style={{ color: 'var(--faint)' }}>
            {activeChannelObj?.kind === 'VOICE' ? '🔊' : '#'}
          </span>
          {activeChannelObj?.name ?? '—'}
          <div className={'status-dot ' + status} title={status} />
          <span className="status-label">
            {status === 'connected' ? 'live' : status === 'connecting' ? 'reconnecting…' : 'offline'}
          </span>
        </div>

        {banner && <div className="banner">{banner}</div>}

        <ScreenStage voice={voice} />

        <div className="msgs" ref={msgsRef}>
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
                <div key={m.id}>
                  {newDay && (
                    <div className="day-sep">
                      <span>{dayLabel(m.createdAt)}</span>
                    </div>
                  )}
                  <div className={'msg' + (grouped ? ' grouped' : '') + (m.pending ? ' pending' : '')}>
                    {grouped ? (
                      <div className="avatar spacer" />
                    ) : (
                      <div className="avatar">{initials(m.author.displayName || m.author.username)}</div>
                    )}
                    <div className="msg-body">
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
                          />
                          {/* Our own pasted images, shown before the server echo. */}
                          {m.previews?.map((url) => (
                            <PreviewImage key={url} url={url} />
                          ))}
                        </>
                      )}
                    </div>
                    {editingId !== m.id && (canEdit(m) || canDelete(m)) && (
                      <div className="msg-actions">
                        {canEdit(m) && (
                          <button title="Edit" onClick={() => beginEdit(m)}>
                            ✎
                          </button>
                        )}
                        {canDelete(m) && (
                          <button
                            className="danger"
                            title={m.author.id === me.id ? 'Delete' : 'Delete as admin'}
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
          <textarea
            rows={1}
            value={draft}
            placeholder={
              iAmMuted
                ? `${muteLabel(myMutedUntil!)} — you cannot send messages`
                : activeChannelObj
                  ? pending.length
                    ? 'Add a message, or press Enter to send'
                    : `Message #${activeChannelObj.name}`
                  : ''
            }
            disabled={
              !activeChannelObj || activeChannelObj.kind !== 'TEXT' || iAmMuted
            }
            onChange={(e) => onDraftChange(e.target.value)}
            onPaste={onPaste}
            onBlur={stopTyping}
            onKeyDown={(e) => {
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
                <div className="avatar">{initials(m.user.displayName || m.user.username)}</div>
                <div className="mname">{m.user.displayName || m.user.username}</div>
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
                        <div className="menu-label">Mute for</div>
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
      {showSettings && (
        <SettingsModal
          settings={voiceSettings}
          voice={voice}
          onChange={(patch) => void updateVoiceSettings(patch)}
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

/** One of our own pasted images, shown until the server echo replaces it. */
function PreviewImage({ url }: { url: string }) {
  const { imageProps } = useImageActions();
  return (
    <div className="attach">
      <img src={url} alt="" {...imageProps({ src: url, name: 'image' })} />
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
