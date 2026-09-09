import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { loginThrottle } from './login-throttle';

/**
 * The limiter through a real Express app, mounted the way main.ts mounts it.
 *
 * The unit tests next door prove the window arithmetic. This proves the part
 * that was actually broken: that one budget covers a route reached through the
 * router *and* a route mounted straight onto the app ahead of it, which is how
 * Better Auth is mounted and the reason `ThrottlerGuard` never saw it.
 */

let server: Server | null = null;
afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  server = null;
});

async function start(limit = 3) {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(loginThrottle({ limit, windowMs: 60_000 }));

  // Stands in for the Better Auth handler: mounted on the app directly, so it
  // never passes through the router below.
  app.all('/api/auth/*splat', (req, res) => {
    res.status(req.headers['x-succeed'] ? 200 : 401).json({ ok: !!req.headers['x-succeed'] });
  });

  const router = express.Router();
  router.post('/api/login', (req, res) => {
    res.status(req.headers['x-succeed'] ? 200 : 401).json({ ok: !!req.headers['x-succeed'] });
  });
  router.get('/api/messages', (_req, res) => res.status(200).json({ ok: true }));
  app.use(router);

  server = app.listen(0);
  await new Promise((resolve) => server!.once('listening', resolve));
  const { port } = server!.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

const post = (base: string, path: string, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: 'POST', headers });

describe('loginThrottle over HTTP', () => {
  it('refuses with 429 and a Retry-After once the budget is spent', async () => {
    const base = await start(3);
    for (let i = 0; i < 3; i++) {
      expect((await post(base, '/api/login')).status).toBe(401);
    }
    const blocked = await post(base, '/api/login');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    // `message`, because that is the field the client reads to show a human a
    // reason. Anything else surfaces as a bare "HTTP 429".
    expect((await blocked.json()).message).toMatch(/Too many sign-in attempts/);
  });

  it('spends one budget across both doors onto the password check', async () => {
    // The whole bug: /api/auth/sign-in/email is mounted on the app, above the
    // router, so a guard inside Nest's pipeline never sees it. Two failures
    // there plus one here must exhaust a budget of three.
    const base = await start(3);
    expect((await post(base, '/api/auth/sign-in/email')).status).toBe(401);
    expect((await post(base, '/api/auth/sign-in/email')).status).toBe(401);
    expect((await post(base, '/api/login')).status).toBe(401);

    expect((await post(base, '/api/login')).status).toBe(429);
    expect((await post(base, '/api/auth/sign-in/email')).status).toBe(429);
  });

  it('leaves everything that is not a credential endpoint alone', async () => {
    const base = await start(1);
    await post(base, '/api/login');
    expect((await post(base, '/api/login')).status).toBe(429);
    // Same address, ordinary route, unaffected.
    expect((await fetch(base + '/api/messages')).status).toBe(200);
  });

  it('clears the address on a success, so reconnecting never locks anyone out', async () => {
    const base = await start(3);
    await post(base, '/api/login');
    await post(base, '/api/login');
    expect((await post(base, '/api/login', { 'x-succeed': '1' })).status).toBe(200);
    // Budget is back to full rather than one away from refusing.
    for (let i = 0; i < 3; i++) {
      expect((await post(base, '/api/login')).status).toBe(401);
    }
    expect((await post(base, '/api/login')).status).toBe(429);
  });

  it('does not hold a 5xx against the caller', async () => {
    const app = express();
    app.use(loginThrottle({ limit: 1, windowMs: 60_000 }));
    app.post('/api/login', (_req, res) => res.status(500).json({}));
    server = app.listen(0);
    await new Promise((resolve) => server!.once('listening', resolve));
    const { port } = server!.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;

    expect((await post(base, '/api/login')).status).toBe(500);
    // Our fault, not theirs: the budget is untouched.
    expect((await post(base, '/api/login')).status).toBe(500);
  });
});
