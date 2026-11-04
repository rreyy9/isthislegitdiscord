import {
  CROWD_EVENTS,
  SOUND_BY_ID,
  SOUNDS,
  defaultNotificationSettings,
  soundAllowed,
  type NotificationSettings,
  type SoundEvent,
} from '../sound-events';
import { eventSoundUrl } from './api';
import type { EventSoundEvent, EventSoundSlot } from './event-sounds';

/**
 * The app's sound effects: one short file per event, in the spirit of
 * Mumble's notification sounds.
 *
 * Played through plain audio elements rather than Web Audio. The renderer is
 * loaded from file:// in a packaged build, where `fetch` -- which decoding a
 * buffer would need -- is refused, while an <audio> element loads the same
 * file without complaint. An element can also be pointed at an output device
 * with `setSinkId`, which is how these come out of the headset the call is
 * on rather than the speakers next to it.
 *
 * Which sounds may play is decided in sound-events.ts. This file only adds
 * the rules about *when*: bursts collapsed, chatter deferred behind the sound
 * that matters more.
 */

/** Relative, so it resolves from the dev server and from file:// alike. */
const urlOf = (file: string) => `./sounds/${file}`;

let settings: NotificationSettings = defaultNotificationSettings();
let sinkId = '';

/**
 * One element per file, kept so the file is decoded once and stays in cache.
 * Each play is a clone of it: a clone shares the loaded resource, and lets
 * two of the same sound overlap instead of the second cutting off the first.
 */
const loaded = new Map<string, HTMLAudioElement>();

function base(file: string): HTMLAudioElement {
  let el = loaded.get(file);
  if (!el) {
    el = new Audio(urlOf(file));
    el.preload = 'auto';
    loaded.set(file, el);
  }
  return el;
}

/** Called whenever the settings or the output device change. */
export function configureSounds(
  next: NotificationSettings,
  outputDeviceId: string | null,
) {
  settings = next;
  sinkId = outputDeviceId ?? '';
}

/** Warm the cache, so the first join of the day is not the one that stutters. */
export function preloadSounds() {
  for (const s of SOUNDS) base(s.file);
}

/**
 * The shortest gap between two plays of the same event, in ms.
 *
 * Join and leave are short because a channel filling up should sound like
 * people arriving, just not like a drum roll; the muted-speech cue is long
 * because it fires for as long as somebody keeps talking into a muted mic,
 * and one reminder every few seconds is a reminder rather than a punishment.
 */
const MIN_GAP_MS: Partial<Record<SoundEvent, number>> = {
  peerJoin: 250,
  peerLeave: 250,
  mutedSpeech: 4000,
  messageHere: 1500,
  messageElsewhere: 1500,
  reaction: 1500,
  partyJoin: 400,
  partyLeave: 400,
};
const DEFAULT_GAP_MS = 120;
const lastPlayed = new Map<SoundEvent, number>();

/**
 * Message ticks wait this long before playing, and are dropped if a tag, DM
 * or call sound arrives inside the wait. A tag arrives as two events -- the
 * message itself and the tag about it -- in no promised order, and two sounds
 * for one message is the tick drowning out the sound that meant something.
 */
const CHATTER_DELAY_MS = 150;
const CHATTER: ReadonlySet<SoundEvent> = new Set([
  'messageHere',
  'messageElsewhere',
]);
const PRIORITY: ReadonlySet<SoundEvent> = new Set(['mention', 'dm', 'call']);
let pendingChatter: ReturnType<typeof setTimeout> | null = null;
let lastPriorityAt = 0;

export interface SoundContext {
  /** The server the event happened in; null for DMs and anything outside one. */
  guildId: string | null;
  /** How many people are in the channel, for the crowd limit. */
  crowd?: number;
}

/** Ask for a sound. Whether it plays is up to the settings. */
export function playSound(event: SoundEvent, ctx: SoundContext) {
  if (!soundAllowed(settings, event, ctx.guildId)) return;
  if (
    CROWD_EVENTS.has(event) &&
    settings.soundCrowdLimit > 0 &&
    (ctx.crowd ?? 0) > settings.soundCrowdLimit
  ) {
    return;
  }

  const now = Date.now();
  const gap = MIN_GAP_MS[event] ?? DEFAULT_GAP_MS;
  if (now - (lastPlayed.get(event) ?? 0) < gap) return;

  if (PRIORITY.has(event)) {
    lastPriorityAt = now;
    if (pendingChatter !== null) {
      clearTimeout(pendingChatter);
      pendingChatter = null;
    }
  }
  if (CHATTER.has(event)) {
    if (now - lastPriorityAt < CHATTER_DELAY_MS || pendingChatter !== null) {
      return;
    }
    lastPlayed.set(event, now);
    pendingChatter = setTimeout(() => {
      pendingChatter = null;
      start(event);
    }, CHATTER_DELAY_MS);
    return;
  }

  lastPlayed.set(event, now);
  start(event);
}

/** The settings page's play button: ignores every switch, keeps the volume. */
export function previewSound(event: SoundEvent) {
  start(event);
}

function start(event: SoundEvent) {
  const spec = SOUND_BY_ID.get(event);
  if (!spec) return;
  const volume = Math.min(1, Math.max(0, settings.soundVolume * spec.gain));
  if (volume === 0) return;
  try {
    const el = base(spec.file).cloneNode(true) as HTMLAudioElement;
    el.volume = volume;
    const go = () =>
      el.play().catch(() => {
        // A file that will not play is a missing sound, not a broken app.
        // The synthesised blip stands in for the sounds somebody would
        // otherwise miss entirely; everything else just goes quiet.
        if (PRIORITY.has(event)) fallbackPing(volume);
      });
    // A device that has gone away rejects; the sound still plays, on the
    // default device, which beats not playing it at all.
    if (sinkId && typeof el.setSinkId === 'function') {
      void el.setSinkId(sinkId).catch(() => {}).then(go);
    } else {
      void go();
    }
  } catch {
    if (PRIORITY.has(event)) fallbackPing(volume);
  }
}

/* --------------------------------------------------------- server sounds */

/**
 * The server's join, leave and away sounds -- see event-sounds.ts.
 *
 * Deliberately outside everything above: no master switch, no per-event or
 * per-server switch, no crowd limit and none of this person's volume. The
 * admin's volume is the only one that applies. The output device does, since
 * it is where the call is coming out.
 */
const lastEventPlayed = new Map<string, number>();
const EVENT_GAP_MS = 250;

export function playEventSound(
  userId: string,
  event: EventSoundEvent,
  slot: EventSoundSlot,
) {
  const now = Date.now();
  // Per person: two people walking in together each get their own sound, but
  // one person's connection flapping is not a burst of them.
  const key = `${userId}:${event}`;
  if (now - (lastEventPlayed.get(key) ?? 0) < EVENT_GAP_MS) return;
  lastEventPlayed.set(key, now);
  void startEventSound(slot);
}

/** The settings page's play button. */
export function previewEventSound(slot: EventSoundSlot) {
  void startEventSound(slot);
}

async function startEventSound(slot: EventSoundSlot) {
  const volume = Math.min(1, Math.max(0, slot.volume));
  if (volume === 0) return;
  try {
    let el: HTMLAudioElement;
    if (slot.source === 'builtin') {
      el = base(slot.file).cloneNode(true) as HTMLAudioElement;
    } else {
      // Fetched once with the bearer token and kept as an object URL.
      el = new Audio(await eventSoundUrl(slot.id));
    }
    el.volume = volume;
    if (sinkId && typeof el.setSinkId === 'function') {
      await el.setSinkId(sinkId).catch(() => {});
    }
    await el.play();
  } catch {
    // A sound that cannot be fetched or played is a missing sound, not a
    // broken app.
  }
}

/* ------------------------------------------------------------- fallback */

/**
 * Two sine tones through a gain envelope: what a tag sounded like before the
 * sound pack, kept for the one case where a file cannot be played. Nothing
 * here can 404, which is the whole reason it is still here.
 */
let context: AudioContext | null = null;

function fallbackPing(volume: number) {
  try {
    context ??= new AudioContext();
    if (context.state === 'suspended') void context.resume();
    const now = context.currentTime;
    tone(context, 660, now, 0.11, volume);
    tone(context, 990, now + 0.085, 0.16, volume);
  } catch {
    // No audio device at all.
  }
}

function tone(
  ctx: AudioContext,
  hz: number,
  at: number,
  length: number,
  volume: number,
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = hz;
  const peak = 0.18 * volume;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(peak, at + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + length + 0.02);
}
