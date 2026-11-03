import { describe, expect, it } from 'vitest';
import {
  SOUNDS,
  defaultNotificationSettings,
  defaultSoundSwitches,
  normalizeNotifications,
  soundAllowed,
} from './sound-events';

describe('normalizeNotifications', () => {
  it('upgrades a file from before sounds had their own table', () => {
    const s = normalizeNotifications({ mentions: false, sound: false });
    expect(s.mentions).toBe(false);
    // The old tag-sound switch is now the master switch.
    expect(s.sound).toBe(false);
    expect(s.soundEvents).toEqual(defaultSoundSwitches());
    expect(s.guildSounds).toEqual({});
  });

  it('fills in events added since the file was written and drops removed ones', () => {
    const s = normalizeNotifications({
      soundEvents: { peerJoin: false, gone: true },
    });
    expect(s.soundEvents.peerJoin).toBe(false);
    expect(s.soundEvents.selfJoin).toBe(true);
    expect('gone' in s.soundEvents).toBe(false);
    expect(Object.keys(s.soundEvents)).toHaveLength(SOUNDS.length);
  });

  it('keeps only well-formed server overrides', () => {
    const s = normalizeNotifications({
      guildSounds: {
        g1: { mode: 'off' },
        g2: { mode: 'custom', events: { dm: false } },
        g3: { mode: 'loud' },
        g4: 'off',
      },
    });
    expect(s.guildSounds.g1).toEqual({ mode: 'off' });
    expect(s.guildSounds.g2?.mode).toBe('custom');
    expect(s.guildSounds.g3).toBeUndefined();
    expect(s.guildSounds.g4).toBeUndefined();
  });

  it('clamps the volume and the crowd limit', () => {
    expect(normalizeNotifications({ soundVolume: 3 }).soundVolume).toBe(1);
    expect(normalizeNotifications({ soundVolume: 'x' }).soundVolume).toBe(0.5);
    expect(normalizeNotifications({ soundCrowdLimit: -4 }).soundCrowdLimit).toBe(0);
    expect(normalizeNotifications({ soundCrowdLimit: 12.4 }).soundCrowdLimit).toBe(12);
  });

  it('survives garbage', () => {
    expect(normalizeNotifications(null)).toEqual(defaultNotificationSettings());
    expect(normalizeNotifications('nope')).toEqual(defaultNotificationSettings());
  });
});

describe('soundAllowed', () => {
  const base = defaultNotificationSettings();

  it('follows the global table', () => {
    expect(soundAllowed(base, 'selfJoin', null)).toBe(true);
    expect(soundAllowed(base, 'messageElsewhere', null)).toBe(false);
  });

  it('is silenced by the master switch', () => {
    expect(soundAllowed({ ...base, sound: false }, 'mention', null)).toBe(false);
  });

  it('lets a server go quiet or keep its own table', () => {
    const s = {
      ...base,
      guildSounds: {
        quiet: { mode: 'off' as const },
        mine: {
          mode: 'custom' as const,
          events: { ...defaultSoundSwitches(), peerJoin: false, messageElsewhere: true },
        },
      },
    };
    expect(soundAllowed(s, 'mention', 'quiet')).toBe(false);
    expect(soundAllowed(s, 'peerJoin', 'mine')).toBe(false);
    expect(soundAllowed(s, 'messageElsewhere', 'mine')).toBe(true);
    // Somewhere else, and DMs, still follow the global table.
    expect(soundAllowed(s, 'peerJoin', 'other')).toBe(true);
    expect(soundAllowed(s, 'mention', null)).toBe(true);
  });
});
