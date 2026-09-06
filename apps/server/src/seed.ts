import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';
import { newId, newInviteCode } from './common/ids';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  // A placeholder account so the bootstrap invite has an owner. Nobody signs
  // in as this; it exists only to satisfy the foreign key.
  const system = await prisma.user.upsert({
    where: { id: 'system' },
    update: {},
    create: {
      id: 'system',
      name: 'system',
      email: 'system@local.invalid',
      emailVerified: true,
      username: 'system',
      displayUsername: 'system',
    },
  });

  let guild = await prisma.guild.findFirst({ where: { name: 'Home' } });
  if (!guild) {
    guild = await prisma.guild.create({
      data: {
        id: newId(),
        name: 'Home',
        channels: {
          create: [
            { id: newId(), name: 'general', kind: 'TEXT', position: 0 },
            { id: newId(), name: 'random', kind: 'TEXT', position: 1 },
            { id: newId(), name: 'Voice', kind: 'VOICE', position: 2 },
          ],
        },
      },
    });
    console.log(`Created guild "Home" (${guild.id})`);
  }

  // Reuse an existing usable bootstrap code rather than piling up new ones.
  const existing = await prisma.inviteCode.findFirst({
    where: {
      guildId: guild.id,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });

  const invite =
    existing && existing.uses < existing.maxUses
      ? existing
      : await prisma.inviteCode.create({
          data: {
            id: newId(),
            code: newInviteCode(),
            guildId: guild.id,
            createdById: system.id,
            maxUses: 10,
            expiresAt: new Date(Date.now() + 365 * 24 * 3600_000),
          },
        });

  console.log('');
  console.log('  Invite code:  ' + invite.code);
  console.log(`  Uses:         ${invite.uses}/${invite.maxUses}`);
  console.log('');
  console.log('  The first account to register with it becomes the admin.');
  console.log('');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
