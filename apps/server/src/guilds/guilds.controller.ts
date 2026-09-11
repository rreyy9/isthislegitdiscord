import { Controller, Get, UseGuards } from '@nestjs/common';
import type { Guild, GuildMemberDto } from '@isthislegit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { ChatGateway } from '../gateway/chat.gateway';

@Controller('api')
@UseGuards(AuthGuard)
export class GuildsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: ChatGateway,
  ) {}

  /** Every guild this user belongs to, with its channels. */
  @Get('guilds')
  async guilds(@CurrentUser() user: SessionUser): Promise<Guild[]> {
    const memberships = await this.prisma.guildMember.findMany({
      where: { userId: user.id },
      include: {
        guild: {
          include: { channels: { orderBy: [{ position: 'asc' }, { name: 'asc' }] } },
        },
      },
    });

    return memberships.map((m) => ({
      id: m.guild.id,
      name: m.guild.name,
      channels: m.guild.channels.map((c) => ({
        id: c.id,
        guildId: c.guildId,
        name: c.name,
        kind: c.kind,
        position: c.position,
        listenOnly: c.listenOnly,
      })),
    }));
  }

  /** Members of every guild the caller shares, plus who is currently online. */
  @Get('members')
  async members(@CurrentUser() user: SessionUser): Promise<GuildMemberDto[]> {
    const guildIds = (
      await this.prisma.guildMember.findMany({
        where: { userId: user.id },
        select: { guildId: true },
      })
    ).map((m) => m.guildId);

    const members = await this.prisma.guildMember.findMany({
      where: { guildId: { in: guildIds } },
      include: {
        user: { select: { id: true, username: true, name: true, image: true } },
      },
    });

    const online = new Set(this.gateway.onlineUserIds());

    const now = new Date();

    return members.map((m) => ({
      guildId: m.guildId,
      role: m.role,
      online: online.has(m.userId),
      // A mute that has already expired is not a mute; sending it would put a
      // marker next to a name that is free to talk.
      mutedUntil:
        m.mutedUntil && m.mutedUntil > now ? m.mutedUntil.toISOString() : null,
      lastSeenAt: m.lastSeenAt ? m.lastSeenAt.toISOString() : null,
      user: {
        id: m.user.id,
        username: m.user.username ?? m.user.id,
        displayName: m.user.name ?? null,
        image: m.user.image ?? null,
      },
    }));
  }
}
