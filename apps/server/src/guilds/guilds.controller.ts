import { Controller, Get, NotFoundException, Param, UseGuards } from '@nestjs/common';
import type { Guild, GuildMemberDto, MemberActivity } from '@isthislegit/shared';
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
      ...this.activityOf(m.userId, m.lastActiveAt),
      joinedAt: m.joinedAt.toISOString(),
      user: {
        id: m.user.id,
        username: m.user.username ?? m.user.id,
        displayName: m.user.name ?? null,
        image: m.user.image ?? null,
      },
    }));
  }

  /**
   * One person's presence as of now, for the profile card. See
   * `MemberActivity` in shared for why this is asked for rather than pushed.
   *
   * Only for somebody the caller shares a guild with -- the same people the
   * member list would show them -- and a 404 for anyone else, so the route
   * cannot be used to ask whether an account exists.
   */
  @Get('members/:userId/activity')
  async activity(
    @CurrentUser() user: SessionUser,
    @Param('userId') userId: string,
  ): Promise<MemberActivity> {
    const row = await this.prisma.guildMember.findFirst({
      where: {
        userId,
        guild: { members: { some: { userId: user.id } } },
      },
      select: { lastSeenAt: true, lastActiveAt: true },
    });
    if (!row) throw new NotFoundException('No such member.');

    return {
      userId,
      online: this.gateway.onlineUserIds().includes(userId),
      lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
      ...this.activityOf(userId, row.lastActiveAt),
    };
  }

  /**
   * The gateway's answer for somebody connected, the column's for somebody
   * who is not. The column is only written when they leave, so while they are
   * here it is the previous session's figure.
   */
  private activityOf(userId: string, stored: Date | null) {
    const live = this.gateway.presenceOf(userId);
    return {
      away: live?.away ?? false,
      onlineSince: live?.onlineSince ?? null,
      lastActiveAt: live?.lastActiveAt ?? (stored ? stored.toISOString() : null),
    };
  }
}
