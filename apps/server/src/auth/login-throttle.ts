import type { NextFunction, Request, Response } from 'express';

/**
 * A per-IP limit on credential endpoints, mounted as Express middleware.
 *
 * It exists because the global `ThrottlerGuard` cannot cover the endpoint that
 * matters. Better Auth is mounted in main.ts straight onto the Express
 * instance (`http.all('/api/auth/*splat', ...)`), which is upstream of Nest's
 * router -- an `APP_GUARD` is part of Nest's request pipeline and never sees
 * those requests. So `/api/auth/sign-in/email` was completely unlimited while
 * `/api/login`, which does the same thing through a controller, sat under a
 * 300-per-minute limit meant for socket reconnects. Both doors open onto the
 * same password check, and a limit on one of two doors is not a limit; it is
 * worse than none, because the console reads as though the question has been
 * settled.
 *
 * Being middleware rather than a guard is what fixes it: this runs ahead of
 * both mounts, so there is one budget no matter which path is used.
 *
 * Only *failures* are counted. Ten friends restarting a client, or one person
 * with a flaky connection signing in repeatedly, are not what this is for, and
 * a limit that locks out the legitimate case is a limit people ask to have
 * turned off. A successful sign-in clears the address entirely.
 */

/** Paths this applies to, matched against the path with no query string. */
export const CREDENTIAL_PATHS = [
  '/api/login',
  '/api/register',
  '/api/auth/sign-in/email',
  '/api/auth/sign-in/username',
  '/api/auth/sign-up/email',
];

export function isCredentialPath(
  path: string,
  paths: readonly string[] = CREDENTIAL_PATHS,
): boolean {
  const clean = path.split('?')[0].replace(/\/+$/, '').toLowerCase();
  return paths.some((p) => p.toLowerCase() === clean);
}

export interface LimiterOptions {
  /** Failures allowed inside the window before the address is refused. */
  limit: number;
  /** How long a failure is remembered, in milliseconds. */
  windowMs: number;
  /** Injectable so tests do not sleep. */
  now?: () => number;
}

/**
 * A sliding window of failure timestamps per key.
 *
 * Sliding rather than a fixed bucket: a fixed window lets an attacker spend
 * the whole budget at the end of one window and the whole of the next
 * immediately after, which is twice the intended rate at exactly the moment
 * they are trying hardest.
 */
export class AttemptLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(opts: LimiterOptions) {
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? Date.now;
  }

  /** Drop expired timestamps for one key, forgetting the key if it empties. */
  private prune(key: string, at: number): number[] {
    const cutoff = at - this.windowMs;
    const kept = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length === 0) this.hits.delete(key);
    else this.hits.set(key, kept);
    return kept;
  }

  /**
   * May this key attempt now? `retryAfterSeconds` is how long until the oldest
   * remembered failure expires, which is the soonest a slot frees up.
   */
  check(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const at = this.now();
    const kept = this.prune(key, at);
    if (kept.length < this.limit) return { allowed: true, retryAfterSeconds: 0 };
    const oldest = kept[0];
    const waitMs = Math.max(0, oldest + this.windowMs - at);
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
  }

  /** Remember one failure. */
  record(key: string): void {
    const at = this.now();
    const kept = this.prune(key, at);
    kept.push(at);
    this.hits.set(key, kept);
  }

  /** Forget a key: what a successful sign-in does. */
  reset(key: string): void {
    this.hits.delete(key);
  }

  /** Failures currently remembered. Exposed for tests and for the console. */
  size(): number {
    return this.hits.size;
  }
}

/**
 * The address a request is attributed to.
 *
 * `req.ip` and not the socket address, because main.ts sets
 * `trust proxy: 'loopback'` -- behind Caddy on this box every request
 * originates from 127.0.0.1, and keying on that would make one shared budget
 * for everybody, so the tenth friend to reconnect would be refused because of
 * the other nine. With the trust setting in place `req.ip` is the real client.
 */
export function clientKey(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

export interface LoginThrottleOptions extends Partial<LimiterOptions> {
  paths?: readonly string[];
  /** Called when an address is refused, for the log line. */
  onBlocked?: (key: string, path: string) => void;
}

/**
 * Express middleware enforcing the above. Mount before the Better Auth handler
 * and before Nest's router.
 */
export function loginThrottle(opts: LoginThrottleOptions = {}) {
  const limiter = new AttemptLimiter({
    limit: opts.limit ?? 10,
    windowMs: opts.windowMs ?? 5 * 60_000,
    now: opts.now,
  });
  const paths = opts.paths ?? CREDENTIAL_PATHS;

  const middleware = (req: Request, res: Response, next: NextFunction) => {
    if (!isCredentialPath(req.path, paths)) return next();

    const key = clientKey(req);
    const { allowed, retryAfterSeconds } = limiter.check(key);
    if (!allowed) {
      opts.onBlocked?.(key, req.path);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      // `message` because that is the field api.ts reads to show a human a
      // reason; anything else surfaces as a bare "HTTP 429".
      res.status(429).json({
        message: `Too many sign-in attempts. Try again in ${retryAfterSeconds} seconds.`,
      });
      return;
    }

    // Judged on the way out, because only a failure should count. 401 and 400
    // are both "wrong credentials" here -- Better Auth uses 400 for an unknown
    // username -- and a 5xx is our fault, not the caller's, so it is not held
    // against them.
    res.on('finish', () => {
      if (res.statusCode >= 400 && res.statusCode < 500) limiter.record(key);
      else if (res.statusCode < 400) limiter.reset(key);
    });

    next();
  };

  // Handed back for tests and for anything that wants to read the state.
  middleware.limiter = limiter;
  return middleware;
}
