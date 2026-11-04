/**
 * The server's event sounds, as this client sees them.
 *
 * An admin picks a sound for somebody joining a voice channel, leaving it, or
 * going away while in it, and everybody else in that channel hears it. Not the
 * listener's own sound settings: no switch, master switch or volume slider of
 * theirs applies, because the point is that the server decided. What does
 * apply is being in the channel -- see `eventSoundFor` below.
 *
 * Declared here rather than imported from `@isthislegit/shared`, for the same
 * reason watch-party-types.ts is. The shapes match `EventSoundsConfig` there.
 */

export type EventSoundEvent = 'join' | 'leave' | 'away';

export const EVENT_SOUND_EVENTS: { id: EventSoundEvent; label: string; hint: string }[] = [
  {
    id: 'join',
    label: 'Someone joins a voice channel',
    hint: 'Played to everyone already in the channel.',
  },
  {
    id: 'leave',
    label: 'Someone leaves a voice channel',
    hint: 'Played to everyone still in the channel.',
  },
  {
    id: 'away',
    label: 'Someone in a voice channel goes away',
    hint: 'Played to everyone else in that channel, whether they are away or not.',
  },
];

export type EventSoundSlot =
  | { source: 'builtin'; file: string; volume: number }
  | { source: 'custom'; id: string; name: string; volume: number };

export type EventSoundsConfig = Record<EventSoundEvent, EventSoundSlot | null>;

export type SetEventSoundBody =
  | { source: 'none' }
  | { source: 'builtin'; file: string; volume: number }
  /** Keep the file already uploaded for the event; change its volume. */
  | { source: 'custom'; volume: number };

export function emptyEventSounds(): EventSoundsConfig {
  return { join: null, leave: null, away: null };
}

/** The server's ceiling, checked here too so a big file fails before uploading. */
export const MAX_EVENT_SOUND_BYTES = 1024 * 1024;

/**
 * The files the app ships, with names a person would recognise. Must stay a
 * subset of `BUILTIN_EVENT_SOUND_FILES` in the shared package, which is what
 * the server accepts.
 */
export const BUILTIN_EVENT_SOUNDS: { file: string; label: string }[] = [
  { file: 'maximize_009.wav', label: 'Rise (soft)' },
  { file: 'maximize_006.wav', label: 'Rise' },
  { file: 'maximize_008.wav', label: 'Rise (short)' },
  { file: 'minimize_009.wav', label: 'Fall (soft)' },
  { file: 'minimize_006.wav', label: 'Fall' },
  { file: 'minimize_008.wav', label: 'Fall (short)' },
  { file: 'bong_001.wav', label: 'Bong' },
  { file: 'glass_006.wav', label: 'Glass' },
  { file: 'confirmation_001.wav', label: 'Confirm' },
  { file: 'confirmation_004.wav', label: 'Chime' },
  { file: 'question_004.wav', label: 'Question' },
  { file: 'drop_002.wav', label: 'Drop' },
  { file: 'drop_004.wav', label: 'Drop (deep)' },
  { file: 'open_002.wav', label: 'Open' },
  { file: 'close_002.wav', label: 'Close' },
  { file: 'error_003.wav', label: 'Buzz' },
  { file: 'error_006.wav', label: 'Buzz (short)' },
  { file: 'switch_002.wav', label: 'Switch' },
  { file: 'switch_003.wav', label: 'Switch (low)' },
  { file: 'tick_002.wav', label: 'Tick' },
  { file: 'tick_004.wav', label: 'Tick (bright)' },
  { file: 'mouseclick1.wav', label: 'Click' },
];

/**
 * Which server sound a voice cue calls for, or null for the listener's own.
 *
 * Only in a server's voice channel: a DM call (`guildId` null) belongs to the
 * people in it, not to the server, and keeps their own sounds. And only for
 * somebody else coming or going -- the cues voice-sounds.ts raises for that
 * are `peerJoin` and `peerLeave`, which only fire while sitting in the call.
 */
export function eventSoundFor(
  config: EventSoundsConfig,
  cue: string,
  guildId: string | null,
): EventSoundSlot | null {
  if (!guildId) return null;
  if (cue === 'peerJoin') return config.join;
  if (cue === 'peerLeave') return config.leave;
  return null;
}

/**
 * Whether somebody going away should play the server's away sound here.
 *
 * Only when this client is connected to a server voice channel, and the
 * person who went away is one of the others in it. LiveKit identities are
 * user ids, which is what `peers` holds.
 */
export function awaySoundFor(
  config: EventSoundsConfig,
  call: { status: string; guildId: string | null; peers: readonly string[] } | null,
  userId: string,
  meId: string,
): EventSoundSlot | null {
  if (!config.away || !call) return null;
  if (call.status !== 'connected' || !call.guildId) return null;
  if (userId === meId || !call.peers.includes(userId)) return null;
  return config.away;
}
