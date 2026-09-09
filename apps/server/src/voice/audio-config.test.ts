import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { voiceAudioConfig } from './audio-config';

const original = process.env.VOICE_QUALITY;
afterEach(() => {
  if (original === undefined) delete process.env.VOICE_QUALITY;
  else process.env.VOICE_QUALITY = original;
});

describe('voiceAudioConfig', () => {
  it('defaults to balanced when unset', () => {
    delete process.env.VOICE_QUALITY;
    expect(voiceAudioConfig()).toEqual({
      quality: 'balanced',
      maxBitrate: 48_000,
      stereo: false,
      dtx: false,
      red: true,
    });
  });

  it('reads the environment on every call, not once at boot', () => {
    // The setting is meant to be changeable by editing .env and restarting;
    // caching it would make the value the process holds and the value the
    // operator can see disagree, which is unfalsifiable from the outside.
    process.env.VOICE_QUALITY = 'voice';
    expect(voiceAudioConfig().quality).toBe('voice');
    process.env.VOICE_QUALITY = 'high';
    expect(voiceAudioConfig().quality).toBe('high');
  });

  it('tolerates case and surrounding whitespace', () => {
    process.env.VOICE_QUALITY = '  HIGH  ';
    expect(voiceAudioConfig().quality).toBe('high');
  });

  it('falls back to the default on a typo rather than refusing to start', () => {
    process.env.VOICE_QUALITY = 'ultra';
    expect(voiceAudioConfig().quality).toBe('balanced');
    process.env.VOICE_QUALITY = '';
    expect(voiceAudioConfig().quality).toBe('balanced');
  });

  it('keeps RED on everywhere it can be, which is everywhere but studio', () => {
    // RED is the difference between "choppy on hotel wifi" and "fine on hotel
    // wifi", and LiveKit only offers it on mono -- hence the one gap.
    for (const q of ['voice', 'balanced', 'high'] as const) {
      process.env.VOICE_QUALITY = q;
      const c = voiceAudioConfig();
      expect(c.red, q).toBe(true);
      expect(c.stereo, q).toBe(false);
    }
    process.env.VOICE_QUALITY = 'studio';
    expect(voiceAudioConfig().red).toBe(false);
  });

  it('turns DTX on only for voice, where the clipped consonant is worth it', () => {
    process.env.VOICE_QUALITY = 'voice';
    expect(voiceAudioConfig().dtx).toBe(true);
    for (const q of ['balanced', 'high', 'studio'] as const) {
      process.env.VOICE_QUALITY = q;
      expect(voiceAudioConfig().dtx, q).toBe(false);
    }
  });

  it('is the only stereo mode, which is what makes it headphones-only', () => {
    // Stereo means Chromium will not echo-cancel, so on speakers it feeds back.
    process.env.VOICE_QUALITY = 'studio';
    expect(voiceAudioConfig()).toEqual({
      quality: 'studio',
      maxBitrate: 128_000,
      stereo: true,
      dtx: false,
      red: false,
    });
  });

  it('raises the bitrate monotonically across the levels', () => {
    const bitrates = (['voice', 'balanced', 'high', 'studio'] as const).map((q) => {
      process.env.VOICE_QUALITY = q;
      return voiceAudioConfig().maxBitrate;
    });
    expect(bitrates).toEqual([...bitrates].sort((a, b) => a - b));
  });
});
