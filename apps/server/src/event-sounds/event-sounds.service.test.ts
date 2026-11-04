import { describe, expect, it } from 'vitest';
import { normalizeEventSounds, sniffAudio } from './event-sounds.service';

const pad = (head: number[] | string) =>
  Buffer.concat([
    typeof head === 'string' ? Buffer.from(head, 'latin1') : Buffer.from(head),
    Buffer.alloc(16),
  ]);

describe('sniffAudio', () => {
  it('knows the formats it claims to', () => {
    expect(sniffAudio(pad('RIFF\0\0\0\0WAVE'))).toBe('audio/wav');
    expect(sniffAudio(pad('OggS'))).toBe('audio/ogg');
    expect(sniffAudio(pad('fLaC'))).toBe('audio/flac');
    expect(sniffAudio(pad('ID3'))).toBe('audio/mpeg');
    expect(sniffAudio(pad([0xff, 0xfb]))).toBe('audio/mpeg');
    expect(sniffAudio(pad('\0\0\0\x20ftypM4A '))).toBe('audio/mp4');
    expect(sniffAudio(pad([0x1a, 0x45, 0xdf, 0xa3]))).toBe('audio/webm');
  });

  it('refuses anything else, whatever it is called', () => {
    expect(sniffAudio(pad('<html><script>'))).toBeNull();
    expect(sniffAudio(pad([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(sniffAudio(Buffer.from('RIFF'))).toBeNull();
  });
});

describe('normalizeEventSounds', () => {
  it('starts with no sounds', () => {
    expect(normalizeEventSounds(null)).toEqual({ join: null, leave: null, away: null });
  });

  it('keeps what parses and drops what does not', () => {
    const out = normalizeEventSounds({
      join: { source: 'builtin', file: 'bong_001.wav', volume: 0.5 },
      leave: { source: 'builtin', file: '../../etc/passwd', volume: 0.5 },
      away: { source: 'custom', id: 'abc', name: 'x.mp3', volume: 2 },
      extra: { source: 'builtin', file: 'bong_001.wav', volume: 0.5 },
    });
    expect(out).toEqual({
      join: { source: 'builtin', file: 'bong_001.wav', volume: 0.5 },
      leave: null,
      away: null,
    });
  });
});
