import 'reflect-metadata';
/**
 * The environment, loaded before anything else in the process can read it.
 *
 * ConfigModule reads .env too, and does it later -- when Nest constructs
 * AppModule. That is after every module in the graph has been imported, and
 * importing a module runs its decorators. A decorator argument that reads
 * `process.env` therefore sees an empty environment and silently takes its
 * fallback, for the life of the process, whatever .env says and however many
 * times the server is restarted. The attachment size limit was exactly that
 * bug: `MAX_UPLOAD_BYTES` was written, saved and restarted into, and uploads
 * went on being refused at the 25 MB default.
 *
 * dotenv does not overwrite variables that are already set, so ConfigModule
 * running afterwards over the same file changes nothing. This import must stay
 * above `./app.module`; that is the whole of what it does.
 */
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { toNodeHandler } from 'better-auth/node';
import { AppModule } from './app.module';
import { AUTH, type Auth } from './auth/auth.factory';
import { maxUploadBytes } from './attachments/storage';
import { describeBytes } from './common/upload-limit.filter';
import { allowedOrigins, isOriginAllowed } from './common/cors';
import { FileLogger, LOG_DIR } from './common/file-logger';
import { loginThrottle } from './auth/login-throttle';

async function bootstrap() {
  // bodyParser is off so Better Auth's handler can read the raw request; our
  // own JSON parser is added immediately after it, below.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    // Same console output as before, plus a file that outlives the window.
    logger: new FileLogger(),
  });

  // An allowlist, not a mirror. See common/cors.ts for why `null` is on it
  // and why a request with no Origin at all is let through.
  const origins = allowedOrigins();
  app.enableCors({
    origin: (origin, callback) =>
      isOriginAllowed(origin, origins)
        ? callback(null, true)
        : callback(null, false),
    credentials: true,
  });

  // Behind a TLS-terminating reverse proxy on the same box, every request
  // arrives from 127.0.0.1. Without this, ThrottlerGuard sees one client and
  // its per-IP limit becomes a single budget shared by everyone -- ten people
  // reconnecting would rate-limit each other, and a per-IP limit on login
  // would lock out all of them at once or none of them.
  //
  // 'loopback' and not `true`: `true` trusts X-Forwarded-For from whoever sent
  // it, so any client could name its own address and step around every limit.
  // Loopback only, because the proxy is on this machine.
  app.set('trust proxy', 'loopback');

  const auth = app.get<Auth>(AUTH);
  const http = app.getHttpAdapter().getInstance();

  // Ahead of both the Better Auth mount below and Nest's router, which is the
  // only position from which it covers both. `ThrottlerGuard` cannot: it is an
  // APP_GUARD, and the Better Auth handler never enters Nest's pipeline. See
  // auth/login-throttle.ts.
  const throttleLog = new Logger('login');
  http.use(
    loginThrottle({
      limit: Number(process.env.LOGIN_RATE_LIMIT ?? 10),
      windowMs: Number(process.env.LOGIN_RATE_WINDOW_MS ?? 5 * 60_000),
      onBlocked: (key, path) =>
        throttleLog.warn(`rate limited ${key} on ${path}`),
    }),
  );

  // Better Auth owns everything under /api/auth (sign-in, sign-out, session).
  // Express 5 requires a named wildcard.
  http.all('/api/auth/*splat', toNodeHandler(auth));

  // LiveKit signs its webhooks over the raw bytes, so this one route must see
  // them before any JSON parser rewrites the body. Mounted ahead of the JSON
  // parser below, which then skips it (a body is only parsed once).
  http.use('/api/livekit/webhook', express.raw({ type: '*/*', limit: '256kb' }));

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Run the teardown Nest already has on the way out: PrismaService closes its
  // pool, VoiceService clears its timers, and ChatGateway tells everyone still
  // connected that this is a restart rather than the server falling over.
  //
  // Windows caveat, because it decides how much this is worth: a process ended
  // with `taskkill /F`, or by Stop-ScheduledTask, is terminated outright and
  // none of this runs. It fires on Ctrl+C and on a plain `taskkill` without
  // /F, which is what the installer tries first before it resorts to force.
  // Where it does not fire, clients see an ordinary disconnect and reconnect
  // on their own, which is what they did before this existed.
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');

  // The upload limit is said out loud because it is the one setting whose
  // effect is invisible until somebody tries to send a large file and is
  // refused, with no way to tell a limit that did not apply from a file that
  // is genuinely too big. One line in the log answers it before it is asked.
  new Logger('bootstrap').log(
    `listening on http://0.0.0.0:${port} ` +
      `(attachment limit ${describeBytes(maxUploadBytes())}, ` +
      `cors: ${origins.join(', ')})`,
  );
  new Logger('bootstrap').log(`logging to ${LOG_DIR}`);
}

void bootstrap();
