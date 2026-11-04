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
  const bong = { source: 'builtin', file: 'bong_001.wav', volume: 0.5 } as const;

  it('starts with nobody', () => {
    expect(normalizeEventSounds(null)).toEqual({ users: {} });
    expect(normalizeEventSounds({ join: bong })).toEqual({ users: {} });
  });

  it("keeps what parses of each person's sounds and drops what does not", () => {
    const out = normalizeEventSounds({
      users: {
        bob: {
          join: bong,
          leave: { source: 'builtin', file: '../../etc/passwd', volume: 0.5 },
          away: { source: 'custom', id: 'abc', name: 'x.mp3', volume: 2 },
          extra: bong,
        },
      },
    });
    expect(out).toEqual({ users: { bob: { join: bong, leave: null, away: null } } });
  });

  it('drops people with nothing left, and ids that are not ids', () => {
    const out = normalizeEventSounds({
      users: {
        carol: { join: null, leave: { source: 'builtin', file: 'nope.wav', volume: 1 } },
        '../x': { join: bong },
      },
    });
    expect(out).toEqual({ users: {} });
  });
});
