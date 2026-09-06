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

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');

  new Logger('bootstrap').log(`listening on http://0.0.0.0:${port}`);
}

void bootstrap();
