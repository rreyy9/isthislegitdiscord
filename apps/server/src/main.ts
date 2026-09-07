import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { toNodeHandler } from 'better-auth/node';
import { AppModule } from './app.module';
import { AUTH, type Auth } from './auth/auth.factory';

async function bootstrap() {
  // bodyParser is off so Better Auth's handler can read the raw request; our
  // own JSON parser is added immediately after it, below.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  app.enableCors({ origin: true, credentials: true });

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

  new Logger('bootstrap').log(`listening on http://0.0.0.0:${port}`);
}

void bootstrap();
