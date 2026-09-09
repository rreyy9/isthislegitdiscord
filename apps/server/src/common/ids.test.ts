import { describe, expect, it } from 'vitest';
import { newId, newInviteCode } from './ids';

describe('newId', () => {
  it('is a UUIDv7', () => {
    expect(newId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('sorts chronologically as a string', () => {
    // The whole reason for v7 over v4: `ORDER BY id` is message order, so
    // paging needs no extra column and no extra index.
    const ids = Array.from({ length: 50 }, () => newId());
    expect([...ids].sort()).toEqual(ids);
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newId()));
    expect(ids.size).toBe(5000);
  });
});

describe('newInviteCode', () => {
  it('uses only characters that do not misread aloud', () => {
    // No I/L/O/0/1: an invite gets read out or typed from a screenshot.
    for (let i = 0; i < 200; i++) {
      expect(newInviteCode()).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    }
  });

  it('honours the requested length', () => {
    expect(newInviteCode(1)).toHaveLength(1);
    expect(newInviteCode(32)).toHaveLength(32);
  });

  it('does not collide across a realistic number of invites', () => {
    const codes = new Set(Array.from({ length: 20_000 }, () => newInviteCode()));
    expect(codes.size).toBe(20_000);
  });

  it('draws every character of the alphabet, with no position biased', () => {
    // A `% alphabet.length` over a power-of-two source would over-represent
    // the first characters; 31 divides nothing, so the bias would be real.
    // 8000 codes puts ~2000 draws in each of 8 positions across 31 symbols,
    // so ~65 expected per cell -- a stuck or skewed position is obvious.
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const counts = new Map<string, number>();
    for (let i = 0; i < 8000; i++) {
      for (const ch of newInviteCode()) {
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
      }
    }
    expect(counts.size).toBe(alphabet.length);
    const seen = [...counts.values()];
    const expected = (8000 * 8) / alphabet.length;
    // Generous bounds: this is here to catch a broken generator, not to be a
    // statistical test that fails once a fortnight in CI.
    expect(Math.min(...seen)).toBeGreaterThan(expected * 0.7);
    expect(Math.max(...seen)).toBeLessThan(expected * 1.3);
  });
});
