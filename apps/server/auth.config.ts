/**
 * Only used by `npx @better-auth/cli generate`, which needs a module that
 * exports a fully built `auth` instance. The running server builds its own
 * through Nest's DI in src/auth/auth.module.ts.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './src/generated/prisma/client';
import { createAuth } from './src/auth/auth.factory';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

export const auth = createAuth(prisma as any);
