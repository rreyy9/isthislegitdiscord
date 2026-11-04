import { describe, expect, it } from 'vitest';
import { BUILTIN_EVENT_SOUND_FILES } from '@isthislegit/shared';
import {
  BUILTIN_EVENT_SOUNDS,
  awaySoundFor,
  emptyEventSounds,
  eventSoundFor,
  type EventSoundsConfig,
} from './event-sounds';

const join = { source: 'builtin', file: 'bong_001.wav', volume: 0.5 } as const;
const leave = { source: 'custom', id: 'x', name: 'bye.mp3', volume: 1 } as const;
const away = { source: 'builtin', file: 'glass_006.wav', volume: 0.7 } as const;
const all: EventSoundsConfig = { join, leave, away };

describe('eventSoundFor', () => {
  it("replaces somebody else's join and leave in a server channel", () => {
    expect(eventSoundFor(all, 'peerJoin', 'g1')).toBe(join);
    expect(eventSoundFor(all, 'peerLeave', 'g1')).toBe(leave);
  });

  it('leaves a DM call to its own sounds', () => {
    expect(eventSoundFor(all, 'peerJoin', null)).toBeNull();
  });

  it('leaves every other cue alone, your own join included', () => {
    expect(eventSoundFor(all, 'selfJoin', 'g1')).toBeNull();
    expect(eventSoundFor(all, 'mute', 'g1')).toBeNull();
  });

  it('falls back to your own sound where the admin set none', () => {
    expect(eventSoundFor(emptyEventSounds(), 'peerJoin', 'g1')).toBeNull();
  });
});

describe('awaySoundFor', () => {
  const call = { status: 'connected', guildId: 'g1', peers: ['bob', 'carol'] };

  it('plays when somebody else in the same server channel goes away', () => {
    expect(awaySoundFor(all, call, 'bob', 'me')).toBe(away);
  });

  it('is silent for somebody not in the channel', () => {
    expect(awaySoundFor(all, call, 'dave', 'me')).toBeNull();
  });

  it('is silent when this client is not in a channel at all', () => {
    expect(awaySoundFor(all, null, 'bob', 'me')).toBeNull();
    expect(awaySoundFor(all, { ...call, status: 'idle' }, 'bob', 'me')).toBeNull();
  });

  it('is silent in a DM call, and for yourself', () => {
    expect(awaySoundFor(all, { ...call, guildId: null }, 'bob', 'me')).toBeNull();
    expect(
      awaySoundFor(all, { ...call, peers: ['me', 'bob'] }, 'me', 'me'),
    ).toBeNull();
  });

  it('is silent when no away sound is set', () => {
    expect(awaySoundFor(emptyEventSounds(), call, 'bob', 'me')).toBeNull();
  });
});

describe('BUILTIN_EVENT_SOUNDS', () => {
  it('only offers files the server will accept', () => {
    const accepted = new Set<string>(BUILTIN_EVENT_SOUND_FILES);
    for (const s of BUILTIN_EVENT_SOUNDS) expect(accepted.has(s.file)).toBe(true);
  });
});
