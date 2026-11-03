/**
 * Which things make a sound, and whether a given one may right now.
 *
 * Outside main/, preload/ and renderer/ for the same reason keybinds.ts is:
 * main writes the defaults to settings.json and cleans what it reads back,
 * the settings page draws one row per event, and the player asks the rules
 * below before every sound. Written three times they would drift, and the
 * drift would be a switch on the settings page that the player does not obey.
 *
 * Modelled on Mumble's Messages table: one row per event, each with its own
 * switch, all under one master switch. The sounds themselves are Kenney's
 * Interface Sounds and UI Audio packs (CC0) -- see renderer/public/sounds.
 *
 * Nothing here touches Electron or the DOM, which is what lets it be tested;
 * see sound-events.test.ts.
 */

export type SoundEvent =
  | 'selfJoin'
  | 'selfLeave'
  | 'peerJoin'
  | 'peerLeave'
  | 'voiceLost'
  | 'voiceRestored'
  | 'mute'
  | 'unmute'
  | 'deafen'
  | 'undeafen'
  | 'pttOn'
  | 'pttOff'
  | 'mutedSpeech'
  | 'shareStart'
  | 'shareStop'
  | 'mention'
  | 'dm'
  | 'call'
  | 'messageHere'
  | 'messageElsewhere'
  | 'reaction'
  | 'partyStarted'
  | 'partyJoin'
  | 'partyLeave'
  | 'moderated';

export type SoundGroup =
  | 'voice'
  | 'self'
  | 'streams'
  | 'messages'
  | 'party'
  | 'moderation';

export const SOUND_GROUPS: { id: SoundGroup; label: string }[] = [
  { id: 'voice', label: 'Voice channel' },
  { id: 'self', label: 'Your microphone' },
  { id: 'streams', label: 'Screen share' },
  { id: 'messages', label: 'Messages' },
  { id: 'party', label: 'Watch party' },
  { id: 'moderation', label: 'Moderation' },
];

export interface SoundSpec {
  id: SoundEvent;
  group: SoundGroup;
  label: string;
  /** Under renderer/public/sounds. */
  file: string;
  /**
   * Evens the pack out. Kenney's files are all mastered near full scale but
   * some are three times as dense as others, so without this the join sound
   * would be twice as loud as the leave sound the slider was set against.
   * Roughly 0.15 / the file's RMS, capped at 1.
   */
  gain: number;
  /**
   * What a fresh install hears. On for what Mumble plays out of the box; off
   * for anything that would fire on every message in a busy channel, or on
   * every press of a key somebody is already holding on purpose.
   */
  defaultOn: boolean;
}

export const SOUNDS: readonly SoundSpec[] = [
  { id: 'selfJoin', group: 'voice', label: 'You join a voice channel', file: 'maximize_006.wav', gain: 0.74, defaultOn: true },
  { id: 'selfLeave', group: 'voice', label: 'You leave a voice channel', file: 'minimize_006.wav', gain: 0.74, defaultOn: true },
  { id: 'peerJoin', group: 'voice', label: 'Someone joins your channel', file: 'maximize_009.wav', gain: 0.43, defaultOn: true },
  { id: 'peerLeave', group: 'voice', label: 'Someone leaves your channel', file: 'minimize_009.wav', gain: 0.43, defaultOn: true },
  { id: 'voiceLost', group: 'voice', label: 'Connection lost', file: 'error_006.wav', gain: 0.65, defaultOn: true },
  { id: 'voiceRestored', group: 'voice', label: 'Connection restored', file: 'confirmation_001.wav', gain: 0.53, defaultOn: true },

  { id: 'mute', group: 'self', label: 'You mute', file: 'switch_002.wav', gain: 1, defaultOn: true },
  { id: 'unmute', group: 'self', label: 'You unmute', file: 'switch_006.wav', gain: 1, defaultOn: true },
  { id: 'deafen', group: 'self', label: 'You deafen', file: 'switch_003.wav', gain: 0.56, defaultOn: true },
  { id: 'undeafen', group: 'self', label: 'You undeafen', file: 'switch_005.wav', gain: 0.94, defaultOn: true },
  { id: 'pttOn', group: 'self', label: 'Push-to-talk pressed', file: 'mouseclick1.wav', gain: 0.6, defaultOn: false },
  { id: 'pttOff', group: 'self', label: 'Push-to-talk released', file: 'mouserelease1.wav', gain: 0.6, defaultOn: false },
  { id: 'mutedSpeech', group: 'self', label: 'You talk while muted', file: 'question_004.wav', gain: 0.44, defaultOn: true },

  { id: 'shareStart', group: 'streams', label: 'Someone starts sharing', file: 'open_002.wav', gain: 0.95, defaultOn: true },
  { id: 'shareStop', group: 'streams', label: 'Someone stops sharing', file: 'close_002.wav', gain: 0.95, defaultOn: true },

  { id: 'mention', group: 'messages', label: 'Someone tags or replies to you', file: 'glass_006.wav', gain: 0.62, defaultOn: true },
  { id: 'dm', group: 'messages', label: 'Direct message', file: 'drop_004.wav', gain: 0.75, defaultOn: true },
  { id: 'call', group: 'messages', label: 'Incoming call', file: 'confirmation_004.wav', gain: 0.54, defaultOn: true },
  { id: 'messageHere', group: 'messages', label: 'Message in the open channel, window in the background', file: 'tick_004.wav', gain: 0.5, defaultOn: false },
  { id: 'messageElsewhere', group: 'messages', label: 'Message in another channel', file: 'tick_002.wav', gain: 0.5, defaultOn: false },
  { id: 'reaction', group: 'messages', label: 'Someone reacts to your message', file: 'drop_002.wav', gain: 0.6, defaultOn: false },

  { id: 'partyStarted', group: 'party', label: 'A watch party starts', file: 'bong_001.wav', gain: 0.58, defaultOn: true },
  { id: 'partyJoin', group: 'party', label: 'Someone joins your watch party', file: 'maximize_008.wav', gain: 0.5, defaultOn: false },
  { id: 'partyLeave', group: 'party', label: 'Someone leaves your watch party', file: 'minimize_008.wav', gain: 0.5, defaultOn: false },

  { id: 'moderated', group: 'moderation', label: 'You are muted, kicked or banned', file: 'error_003.wav', gain: 0.97, defaultOn: true },
];

export const SOUND_BY_ID: ReadonlyMap<SoundEvent, SoundSpec> = new Map(
  SOUNDS.map((s) => [s.id, s]),
);

/** The events the crowd limit applies to: the ones a busy channel repeats. */
export const CROWD_EVENTS: ReadonlySet<SoundEvent> = new Set([
  'peerJoin',
  'peerLeave',
]);

export type SoundSwitches = Record<SoundEvent, boolean>;

/**
 * One server's exception to the global table.
 *
 * Absent means "same as everywhere else", which is what nearly every server
 * is; it is not stored as a third mode so that a server somebody never
 * touched has nothing written down for it.
 */
export type GuildSoundOverride =
  | { mode: 'off' }
  | { mode: 'custom'; events: SoundSwitches };

/**
 * What the app may do when something happens.
 *
 * `mentions` is the OS notification for tags and DMs, as before. `sound` used
 * to be the switch for the tag blip alone and is now the master switch for
 * every sound -- somebody who had turned the one sound off did not want the
 * twenty new ones either.
 */
export interface NotificationSettings {
  /** Raise an OS notification and flash the taskbar. */
  mentions: boolean;
  /** Master switch: off and nothing below plays. */
  sound: boolean;
  /** 0..1, applied on top of each sound's own `gain`. */
  soundVolume: number;
  /**
   * Join and leave sounds go quiet while more than this many people are in
   * the channel, as Mumble's "limit notifications" does. 0 means no limit.
   */
  soundCrowdLimit: number;
  soundEvents: SoundSwitches;
  /** Keyed by guild id. DMs belong to no guild and follow the global table. */
  guildSounds: Record<string, GuildSoundOverride>;
}

export function defaultSoundSwitches(): SoundSwitches {
  const out = {} as SoundSwitches;
  for (const s of SOUNDS) out[s.id] = s.defaultOn;
  return out;
}

export const DEFAULT_SOUND_VOLUME = 0.5;

export function defaultNotificationSettings(): NotificationSettings {
  return {
    mentions: true,
    sound: true,
    soundVolume: DEFAULT_SOUND_VOLUME,
    soundCrowdLimit: 0,
    soundEvents: defaultSoundSwitches(),
    guildSounds: {},
  };
}

/**
 * A switch table read off disk, made whole.
 *
 * Every known event gets a value -- the stored one if it is a boolean, the
 * default otherwise -- and anything else is dropped. An event added in a
 * later build has to arrive at its default rather than undefined, and one
 * removed has to go rather than be written back out for ever.
 */
export function normalizeSwitches(
  stored: unknown,
  fallback: SoundSwitches = defaultSoundSwitches(),
): SoundSwitches {
  const out = { ...fallback };
  if (stored && typeof stored === 'object') {
    for (const s of SOUNDS) {
      const v = (stored as Record<string, unknown>)[s.id];
      if (typeof v === 'boolean') out[s.id] = v;
    }
  }
  return out;
}

function normalizeOverride(
  stored: unknown,
  global: SoundSwitches,
): GuildSoundOverride | null {
  if (!stored || typeof stored !== 'object') return null;
  const mode = (stored as { mode?: unknown }).mode;
  if (mode === 'off') return { mode: 'off' };
  if (mode === 'custom') {
    return {
      mode: 'custom',
      events: normalizeSwitches((stored as { events?: unknown }).events, global),
    };
  }
  return null;
}

const clamp01 = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.min(Math.max(v, 0), 1)
    : fallback;

/** Whatever settings.json held, as something every field of can be trusted. */
export function normalizeNotifications(stored: unknown): NotificationSettings {
  const base = defaultNotificationSettings();
  if (!stored || typeof stored !== 'object') return base;
  const s = stored as Record<string, unknown>;
  const soundEvents = normalizeSwitches(s.soundEvents);
  const guildSounds: Record<string, GuildSoundOverride> = {};
  if (s.guildSounds && typeof s.guildSounds === 'object') {
    for (const [id, raw] of Object.entries(s.guildSounds)) {
      const o = normalizeOverride(raw, soundEvents);
      if (o) guildSounds[id] = o;
    }
  }
  const crowd = s.soundCrowdLimit;
  return {
    mentions: typeof s.mentions === 'boolean' ? s.mentions : base.mentions,
    sound: typeof s.sound === 'boolean' ? s.sound : base.sound,
    soundVolume: clamp01(s.soundVolume, base.soundVolume),
    soundCrowdLimit:
      typeof crowd === 'number' && Number.isFinite(crowd) && crowd > 0
        ? Math.round(crowd)
        : 0,
    soundEvents,
    guildSounds,
  };
}

/**
 * Whether `event` may make a sound, given where it happened.
 *
 * `guildId` is the server the event belongs to, or null for anything that is
 * not in one: a DM, a DM call, the mute button outside a call. A server set
 * to off silences everything in it; a custom server answers from its own
 * table; everything else answers from the global one. The master switch is
 * above all of it.
 */
export function soundAllowed(
  settings: NotificationSettings,
  event: SoundEvent,
  guildId: string | null,
): boolean {
  if (!settings.sound) return false;
  const override = guildId ? settings.guildSounds[guildId] : undefined;
  if (override?.mode === 'off') return false;
  if (override?.mode === 'custom') return override.events[event] ?? false;
  return settings.soundEvents[event] ?? false;
}
