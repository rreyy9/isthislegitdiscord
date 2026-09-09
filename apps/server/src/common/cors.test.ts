import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALLOWED_ORIGINS,
  isOriginAllowed,
  parseAllowedOrigins,
} from './cors';

describe('parseAllowedOrigins', () => {
  it('falls back to the shipped clients when unset or empty', () => {
    expect(parseAllowedOrigins(undefined)).toEqual(DEFAULT_ALLOWED_ORIGINS);
    expect(parseAllowedOrigins('')).toEqual(DEFAULT_ALLOWED_ORIGINS);
    expect(parseAllowedOrigins('   ')).toEqual(DEFAULT_ALLOWED_ORIGINS);
  });

  it('splits on commas and whitespace alike', () => {
    expect(parseAllowedOrigins('https://a.example, https://b.example')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
    expect(parseAllowedOrigins('https://a.example https://b.example')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('drops a trailing slash, which a browser never sends', () => {
    expect(parseAllowedOrigins('https://a.example/')).toEqual(['https://a.example']);
  });
});

describe('isOriginAllowed', () => {
  const allowed = ['null', 'https://isthislegit.duckdns.org'];

  it('allows a request with no Origin header', () => {
    // The console, curl, and every health probe. A browser always sends one.
    expect(isOriginAllowed(undefined, allowed)).toBe(true);
    expect(isOriginAllowed('', allowed)).toBe(true);
  });

  it('allows file:// clients, which Chromium sends as the string null', () => {
    expect(isOriginAllowed('null', allowed)).toBe(true);
  });

  it('matches case-insensitively and ignores a trailing slash', () => {
    expect(isOriginAllowed('HTTPS://IsThisLegit.duckdns.org', allowed)).toBe(true);
    expect(isOriginAllowed('https://isthislegit.duckdns.org/', allowed)).toBe(true);
  });

  it('refuses anything not named', () => {
    expect(isOriginAllowed('https://evil.example', allowed)).toBe(false);
    expect(isOriginAllowed('http://isthislegit.duckdns.org', allowed)).toBe(false);
  });

  it('does not prefix- or suffix-match', () => {
    // The bug an allowlist grows into if it ever starts using startsWith:
    // both of these contain an allowed origin as a substring.
    expect(isOriginAllowed('https://isthislegit.duckdns.org.evil.example', allowed)).toBe(false);
    expect(isOriginAllowed('https://evil.example/https://isthislegit.duckdns.org', allowed)).toBe(false);
  });
});
