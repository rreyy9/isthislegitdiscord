import { describe, expect, it } from 'vitest';
import { BUILTIN_EVENT_SOUND_FILES } from '@isthislegit/shared';
import {
  BUILTIN_EVENT_SOUNDS,
  awaySoundFor,
  emptyEventSounds,
  peerEventSounds,
  type EventSoundsConfig,
} from './event-sounds';

const join = { source: 'builtin', file: 'bong_001.wav', volume: 0.5 } as const;
const leave = { source: 'custom', id: 'x', name: 'bye.mp3', volume: 1 } as const;
const away = { source: 'builtin', file: 'glass_006.wav', volume: 0.7 } as const;
/** Bob has all three; Carol has only a join sound; Dave has none. */
const config: EventSoundsConfig = {
  users: {
    bob: { join, leave, away },
    carol: { join, leave: null, away: null },
  },
};

describe('peerEventSounds', () => {
  it("plays the sound of the person who joined, instead of the listener's own", () => {
    expect(peerEventSounds(config, 'peerJoin', 'g1', ['carol'], ['carol', 'bob'])).toEqual({
      sounds: [{ userId: 'bob', event: 'join', slot: join }],
      ownSound: false,
    });
  });

  it('plays the leave sound of the person who left', () => {
    expect(peerEventSounds(config, 'peerLeave', 'g1', ['bob', 'dave'], ['dave'])).toEqual({
      sounds: [{ userId: 'bob', event: 'leave', slot: leave }],
      ownSound: false,
    });
  });

  it('keeps the usual sound for somebody without one', () => {
    expect(peerEventSounds(config, 'peerJoin', 'g1', [], ['dave'])).toEqual({
      sounds: [],
      ownSound: true,
    });
    // Carol has a join sound but no leave sound.
    expect(peerEventSounds(config, 'peerLeave', 'g1', ['carol'], [])).toEqual({
      sounds: [],
      ownSound: true,
    });
  });

  it('plays both when one with a sound and one without arrive together', () => {
    expect(peerEventSounds(config, 'peerJoin', 'g1', [], ['bob', 'dave'])).toEqual({
      sounds: [{ userId: 'bob', event: 'join', slot: join }],
      ownSound: true,
    });
  });

  it('gives each of two people with sounds their own', () => {
    const out = peerEventSounds(config, 'peerJoin', 'g1', [], ['bob', 'carol']);
    expect(out.sounds.map((s) => s.userId)).toEqual(['bob', 'carol']);
    expect(out.ownSound).toBe(false);
  });

  it('leaves a DM call, and every other cue, to their own sounds', () => {
    expect(peerEventSounds(config, 'peerJoin', null, [], ['bob'])).toEqual({
      sounds: [],
      ownSound: true,
    });
    expect(peerEventSounds(config, 'selfJoin', 'g1', [], ['bob'])).toEqual({
      sounds: [],
      ownSound: true,
    });
  });
});

describe('awaySoundFor', () => {
  const call = { status: 'connected', guildId: 'g1', peers: ['bob', 'carol'] };

  it('plays when somebody with an away sound goes away in the same channel', () => {
    expect(awaySoundFor(config, call, 'bob', 'me')).toBe(away);
  });

  it('is silent for somebody in the channel without an away sound', () => {
    expect(awaySoundFor(config, call, 'carol', 'me')).toBeNull();
  });

  it('is silent for somebody not in the channel', () => {
    expect(awaySoundFor(config, { ...call, peers: ['carol'] }, 'bob', 'me')).toBeNull();
  });

  it('is silent when this client is not in a channel at all', () => {
    expect(awaySoundFor(config, null, 'bob', 'me')).toBeNull();
    expect(awaySoundFor(config, { ...call, status: 'idle' }, 'bob', 'me')).toBeNull();
  });

  it('is silent in a DM call, and for yourself', () => {
    expect(awaySoundFor(config, { ...call, guildId: null }, 'bob', 'me')).toBeNull();
    expect(awaySoundFor(config, call, 'bob', 'bob')).toBeNull();
  });

  it('is silent when nobody has sounds', () => {
    expect(awaySoundFor(emptyEventSounds(), call, 'bob', 'me')).toBeNull();
  });
});

describe('BUILTIN_EVENT_SOUNDS', () => {
  it('only offers files the server will accept', () => {
    const accepted = new Set<string>(BUILTIN_EVENT_SOUND_FILES);
    for (const s of BUILTIN_EVENT_SOUNDS) expect(accepted.has(s.file)).toBe(true);
  });
});
