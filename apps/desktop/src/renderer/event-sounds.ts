/**
 * The server's event sounds, as this client sees them.
 *
 * An admin gives particular people a sound for joining a voice channel,
 * leaving it, or going away while in it, and everybody else in that channel
 * hears it when that person does. Not the listener's own sound settings: no
 * switch, master switch or volume slider of theirs applies, because the point
 * is that the server decided. What does apply is being in the channel -- see
 * `peerEventSounds` below.
 *
 * Declared here rather than imported from `@isthislegit/shared`, for the same
 * reason watch-party-types.ts is. The shapes match `EventSoundsConfig` there.
 */

export type EventSoundEvent = 'join' | 'leave' | 'away';

export const EVENT_SOUND_EVENTS: { id: EventSoundEvent; label: string; hint: string }[] = [
  {
    id: 'join',
    label: 'Joins a voice channel',
    hint: 'Played to everyone already in the channel.',
  },
  {
    id: 'leave',
    label: 'Leaves a voice channel',
    hint: 'Played to everyone still in the channel.',
  },
  {
    id: 'away',
    label: 'Goes away while in a voice channel',
    hint: 'Played to everyone else in that channel, whether they are away or not.',
  },
];

export type EventSoundSlot =
  | { source: 'builtin'; file: string; volume: number }
  | { source: 'custom'; id: string; name: string; volume: number };

/** One person's sounds. */
export type UserEventSounds = Record<EventSoundEvent, EventSoundSlot | null>;

/** Everybody who has sounds, by user id. */
export interface EventSoundsConfig {
  users: Record<string, UserEventSounds>;
}

export type SetEventSoundBody =
  | { source: 'none' }
  | { source: 'builtin'; file: string; volume: number }
  /** Keep the file already uploaded for this person and event; change its volume. */
  | { source: 'custom'; volume: number };

export function emptyEventSounds(): EventSoundsConfig {
  return { users: {} };
}

export function emptyUserSounds(): UserEventSounds {
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

export interface PersonSound {
  userId: string;
  event: EventSoundEvent;
  slot: EventSoundSlot;
}

/**
 * What a voice cue plays here: the sounds of the people who came or went, and
 * whether the listener's own cue sound still plays as well.
 *
 * `peerJoin` and `peerLeave` are only raised while sitting in the same call on
 * both sides (voice-sounds.ts), so `prevPeers` and `nextPeers` are the same
 * room a moment apart and the difference between them is who moved.
 *
 * Somebody with a sound of their own gets that instead of the listener's
 * generic one -- two sounds for one person walking in would be noise. The
 * generic one still plays if anybody who moved has none. Only in a server's
 * voice channel: a DM call (`guildId` null) belongs to the people in it, not
 * to the server, and keeps their own sounds.
 */
export function peerEventSounds(
  config: EventSoundsConfig,
  cue: string,
  guildId: string | null,
  prevPeers: readonly string[],
  nextPeers: readonly string[],
): { sounds: PersonSound[]; ownSound: boolean } {
  const event: EventSoundEvent | null =
    cue === 'peerJoin' ? 'join' : cue === 'peerLeave' ? 'leave' : null;
  if (!event || !guildId) return { sounds: [], ownSound: true };

  const [from, to] = event === 'join' ? [prevPeers, nextPeers] : [nextPeers, prevPeers];
  const had = new Set(from);
  const moved = to.filter((id) => !had.has(id));

  const sounds: PersonSound[] = [];
  for (const userId of moved) {
    const slot = config.users[userId]?.[event];
    if (slot) sounds.push({ userId, event, slot });
  }
  return { sounds, ownSound: sounds.length < moved.length };
}

/**
 * The away sound to play here for somebody going away, or null.
 *
 * Only when this client is connected to a server voice channel, the person
 * who went away is one of the others in it, and an admin gave them an away
 * sound. LiveKit identities are user ids, which is what `peers` holds.
 */
export function awaySoundFor(
  config: EventSoundsConfig,
  call: { status: string; guildId: string | null; peers: readonly string[] } | null,
  userId: string,
  meId: string,
): EventSoundSlot | null {
  const slot = config.users[userId]?.away;
  if (!slot || !call) return null;
  if (call.status !== 'connected' || !call.guildId) return null;
  if (userId === meId || !call.peers.includes(userId)) return null;
  return slot;
}
