import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import {
  bearer as bearerPlugin,
  username as usernamePlugin,
} from 'better-auth/plugins';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import type { PrismaService } from '../prisma/prisma.service';
import { newId } from '../common/ids';

export const AUTH = Symbol('BETTER_AUTH');
export type Auth = ReturnType<typeof createAuth>;

/**
 * Usernames are the login identity, but Better Auth is built around email, so
 * we synthesise a stable non-routable address per account. Nothing is ever
 * sent to it.
 */
export function emailForUsername(username: string): string {
  return `${username.toLowerCase()}@local.invalid`;
}

/** Throws unless the code exists, is unrevoked, unexpired and has uses left. */
async function assertUsableInvite(prisma: PrismaService, code: unknown) {
  if (typeof code !== 'string' || code.length === 0) {
    throw new APIError('BAD_REQUEST', { message: 'An invite code is required.' });
  }
  const invite = await prisma.inviteCode.findUnique({
    where: { code: code.toUpperCase() },
  });
  if (
    !invite ||
    invite.revokedAt ||
    (invite.expiresAt && invite.expiresAt < new Date()) ||
    invite.uses >= invite.maxUses
  ) {
    throw new APIError('BAD_REQUEST', {
      message: 'That invite code is not valid.',
    });
  }
  return invite;
}

export function createAuth(prisma: PrismaService) {
  return betterAuth({
    database: prismaAdapter(prisma, { provider: 'postgresql' }),
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      minPasswordLength: 8,
    },

    // A desktop client stays connected for hours; short sessions would drop
    // sockets mid-call for no benefit at this scale.
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },

    // bearer() lets clients authenticate with `Authorization: Bearer <token>`
    // instead of a cookie. The desktop client renders from file:// and the web
    // dev server runs on a different port, and neither can carry a SameSite
    // cookie without TLS — a token sidesteps that entirely.
    plugins: [usernamePlugin(), bearerPlugin()],

    hooks: {
      // Closes the raw sign-up endpoint: no account can exist without a code,
      // whether it is created through our controller or by calling Better
      // Auth directly.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/sign-up/email') {
          await assertUsableInvite(prisma, (ctx.body as any)?.inviteCode);
        }
      }),
    },

    databaseHooks: {
      user: {
        create: {
          // Consume the code and join the guild only once the account really
          // exists, so a failed sign-up cannot burn an invite.
          after: async (user, ctx) => {
            const code = (ctx?.body as any)?.inviteCode;
            if (typeof code !== 'string') return;

            const invite = await prisma.inviteCode.findUnique({
              where: { code: code.toUpperCase() },
            });
            if (!invite) return;

            // Self-bootstrapping: the first person into a guild is its admin,
            // which avoids a chicken-and-egg where creating an invite needs an
            // admin and becoming admin needs an invite.
            const admins = await prisma.guildMember.count({
              where: { guildId: invite.guildId, role: 'ADMIN' },
            });

            await prisma.$transaction([
              prisma.inviteCode.update({
                where: { id: invite.id },
                data: { uses: { increment: 1 } },
              }),
              prisma.guildMember.create({
                data: {
                  id: newId(),
                  guildId: invite.guildId,
                  userId: user.id,
                  role: admins === 0 ? 'ADMIN' : 'MEMBER',
                },
              }),
            ]);
          },
        },
      },
    },
  });
}
