import { describe, expect, it } from 'vitest';
import { AttemptLimiter, isCredentialPath } from './login-throttle';

/** A clock the test moves by hand, so nothing here sleeps. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('isCredentialPath', () => {
  it('covers both doors onto the same password check', () => {
    // The whole point: /api/login goes through Nest, /api/auth/sign-in/email
    // does not, and limiting only one of them is not a limit.
    expect(isCredentialPath('/api/login')).toBe(true);
    expect(isCredentialPath('/api/auth/sign-in/email')).toBe(true);
    expect(isCredentialPath('/api/auth/sign-in/username')).toBe(true);
    expect(isCredentialPath('/api/register')).toBe(true);
    expect(isCredentialPath('/api/auth/sign-up/email')).toBe(true);
  });

  it('ignores case, a trailing slash and a query string', () => {
    expect(isCredentialPath('/api/Login/')).toBe(true);
    expect(isCredentialPath('/api/login?next=/')).toBe(true);
  });

  it('leaves everything else alone', () => {
    expect(isCredentialPath('/api/messages')).toBe(false);
    expect(isCredentialPath('/api/auth/sign-out')).toBe(false);
    expect(isCredentialPath('/api/loginsomething')).toBe(false);
  });
});

describe('AttemptLimiter', () => {
  it('allows up to the limit, then refuses', () => {
    const c = clock();
    const l = new AttemptLimiter({ limit: 3, windowMs: 60_000, now: c.now });
    for (let i = 0; i < 3; i++) {
      expect(l.check('1.2.3.4').allowed).toBe(true);
      l.record('1.2.3.4');
    }
    expect(l.check('1.2.3.4').allowed).toBe(false);
  });

  it('keys separately, so one address cannot lock out another', () => {
    const c = clock();
    const l = new AttemptLimiter({ limit: 1, windowMs: 60_000, now: c.now });
    l.record('1.2.3.4');
    expect(l.check('1.2.3.4').allowed).toBe(false);
    expect(l.check('5.6.7.8').allowed).toBe(true);
  });

  it('forgets a failure once the window passes', () => {
    const c = clock();
    const l = new AttemptLimiter({ limit: 2, windowMs: 60_000, now: c.now });
    l.record('ip');
    l.record('ip');
    expect(l.check('ip').allowed).toBe(false);

    c.advance(59_000);
    expect(l.check('ip').allowed).toBe(false);
    c.advance(2_000);
    expect(l.check('ip').allowed).toBe(true);
  });

  it('slides rather than resetting in a block', () => {
    // A fixed window would let all of the next window's budget be spent the
    // instant the old one expires, which is twice the intended rate at exactly
    // the wrong moment. Here the oldest failure expires on its own schedule.
    const c = clock();
    const l = new AttemptLimiter({ limit: 2, windowMs: 60_000, now: c.now });
    l.record('ip');
    c.advance(30_000);
    l.record('ip');
    expect(l.check('ip').allowed).toBe(false);

    // The first failure expires here; the second one has 30s left to run.
    c.advance(31_000);
    expect(l.check('ip').allowed).toBe(true);
    l.record('ip');
    expect(l.check('ip').allowed).toBe(false);
  });

  it('reports how long until a slot frees up', () => {
    const c = clock();
    const l = new AttemptLimiter({ limit: 1, windowMs: 60_000, now: c.now });
    l.record('ip');
    c.advance(20_000);
    expect(l.check('ip').retryAfterSeconds).toBe(40);
  });

  it('clears an address on success, so reconnecting never locks anyone out', () => {
    const c = clock();
    const l = new AttemptLimiter({ limit: 2, windowMs: 60_000, now: c.now });
    l.record('ip');
    l.record('ip');
    expect(l.check('ip').allowed).toBe(false);
    l.reset('ip');
    expect(l.check('ip').allowed).toBe(true);
  });

  it('does not remember addresses whose failures have all expired', () => {
    const c = clock();
    const l = new AttemptLimiter({ limit: 5, windowMs: 60_000, now: c.now });
    l.record('a');
    l.record('b');
    expect(l.size()).toBe(2);
    c.advance(61_000);
    l.check('a');
    l.check('b');
    expect(l.size()).toBe(0);
  });
});
