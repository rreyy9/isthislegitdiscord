import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  AdminCreateUserInput,
  AdminSetPasswordInput,
  AdminUpdateUserInput,
  CreateChannelInput,
  CreateGuildInput,
  UpdateChannelInput,
} from '@isthislegit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AdminGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { AUTH, type Auth, emailForUsername } from '../auth/auth.factory';
import { ChatGateway } from '../gateway/chat.gateway';
import { ZodPipe } from '../common/zod.pipe';
import { ChannelsService } from '../channels/channels.service';
import { newId, newInviteCode } from '../common/ids';

/**
 * Everything the server console needs. Guarded by AdminGuard, so a normal
 * member gets 403 on all of it.
 */
@Controller('api/admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: ChatGateway,
    private readonly channels: ChannelsService,
    @Inject(AUTH) private readonly auth: Auth,
  ) {}

  /* ---------------------------------------------------------------- stats */

  @Get('stats')
  async stats() {
    const [users, guilds, channels, messages, invites] = await Promise.all([
      this.prisma.user.count({ where: { NOT: { id: 'system' } } }),
      this.prisma.guild.count(),
      this.prisma.channel.count(),
      this.prisma.message.count({ where: { deletedAt: null } }),
      this.prisma.inviteCode.count({ where: { revokedAt: null } }),
    ]);
    return {
      users,
      guilds,
      channels,
      messages,
      invites,
      online: this.gateway.onlineUserIds().length,
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
    };
  }

  /**
   * Who is connected and which build they are running.
   *
   * The reason to collect this at all: it is what says when a compatibility
   * branch added for one release is safe to delete. Without it, that code
   * lives forever because nobody can show it is unused. A client too old to
   * report its version shows as unknown, which is itself the answer.
   */
  @Get('clients')
  clients() {
    return this.gateway.connectedClients();
  }

  /* ---------------------------------------------------------------- users */

  @Get('users')
  async users() {
    const rows = await this.prisma.user.findMany({
      where: { NOT: { id: 'system' } },
      include: { memberships: { include: { guild: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const online = new Set(this.gateway.onlineUserIds());

    return rows.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.name,
      createdAt: u.createdAt.toISOString(),
      online: online.has(u.id),
      memberships: u.memberships.map((m) => ({
        guildId: m.guildId,
        guildName: m.guild.name,
        role: m.role,
      })),
    }));
  }

  /**
   * Creating an account straight from the console still goes through the
   * normal sign-up path: it mints a single-use invite behind the scenes and
   * consumes it. That keeps one invariant — no account exists without an
   * invite — rather than adding a second way in.
   */
  @Post('users')
  async createUser(
    @CurrentUser() admin: SessionUser,
    @Body(new ZodPipe(AdminCreateUserInput)) body: AdminCreateUserInput,
  ) {
    const guild = await this.prisma.guild.findUnique({
      where: { id: body.guildId },
    });
    if (!guild) throw new NotFoundException('No such guild.');

    const taken = await this.prisma.user.findFirst({
      where: { username: body.username },
    });
    if (taken) throw new BadRequestException('That username is taken.');

    const invite = await this.prisma.inviteCode.create({
      data: {
        id: newId(),
        code: newInviteCode(12),
        guildId: body.guildId,
        createdById: admin.id,
        maxUses: 1,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });

    await this.auth.api.signUpEmail({
      body: {
        email: emailForUsername(body.username),
        password: body.password,
        name: body.displayName ?? body.username,
        username: body.username,
        inviteCode: invite.code,
      } as any,
    });

    const created = await this.prisma.user.findFirst({
      where: { username: body.username },
    });
    if (!created) throw new BadRequestException('Account creation failed.');

    // The sign-up hook always joins as MEMBER (or ADMIN if the guild had
    // none); honour the role the console asked for.
    if (body.role === 'ADMIN') {
      await this.prisma.guildMember.updateMany({
        where: { userId: created.id, guildId: body.guildId },
        data: { role: 'ADMIN' },
      });
    }

    return { id: created.id, username: created.username };
  }

  @Patch('users/:id')
  async updateUser(
    @Param('id') id: string,
    @Body(new ZodPipe(AdminUpdateUserInput)) body: AdminUpdateUserInput,
  ) {
    if (id === 'system') throw new ForbiddenException('Reserved account.');

    if (body.displayName) {
      await this.prisma.user.update({
        where: { id },
        data: { name: body.displayName },
      });
    }

    if (body.role && body.guildId) {
      if (body.role === 'MEMBER') {
        const admins = await this.prisma.guildMember.count({
          where: { guildId: body.guildId, role: 'ADMIN' },
        });
        const isAdmin = await this.prisma.guildMember.findUnique({
          where: { guildId_userId: { guildId: body.guildId, userId: id } },
        });
        // Refuse to remove the last admin: that would lock everyone out of
        // guild administration with no way back in through the app.
        if (admins <= 1 && isAdmin?.role === 'ADMIN') {
          throw new BadRequestException(
            'That is the only admin left in this guild.',
          );
        }
      }
      await this.prisma.guildMember.updateMany({
        where: { userId: id, guildId: body.guildId },
        data: { role: body.role },
      });
    }

    return { ok: true };
  }

  @Post('users/:id/password')
  async setPassword(
    @Param('id') id: string,
    @Body(new ZodPipe(AdminSetPasswordInput)) body: AdminSetPasswordInput,
  ) {
    if (id === 'system') throw new ForbiddenException('Reserved account.');
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('No such user.');

    const ctx = await this.auth.$context;
    const hash = await ctx.password.hash(body.password);
    await ctx.internalAdapter.updatePassword(id, hash);
    // Force them to sign in again everywhere with the new password.
    await ctx.internalAdapter.deleteUserSessions(id);

    return { ok: true };
  }

  @Delete('users/:id')
  async deleteUser(@CurrentUser() admin: SessionUser, @Param('id') id: string) {
    if (id === 'system') throw new ForbiddenException('Reserved account.');
    if (id === admin.id) {
      throw new BadRequestException('You cannot delete your own account.');
    }
    await this.prisma.user.delete({ where: { id } });
    return { ok: true };
  }

  /* -------------------------------------------------------------- invites */

  @Get('invites')
  async invites() {
    const rows = await this.prisma.inviteCode.findMany({
      include: { guild: true, createdBy: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((i) => ({
      id: i.id,
      code: i.code,
      guildId: i.guildId,
      guildName: i.guild.name,
      createdBy: i.createdBy.username,
      uses: i.uses,
      maxUses: i.maxUses,
      expiresAt: i.expiresAt?.toISOString() ?? null,
      revokedAt: i.revokedAt?.toISOString() ?? null,
      usable:
        !i.revokedAt &&
        i.uses < i.maxUses &&
        (!i.expiresAt || i.expiresAt > new Date()),
    }));
  }

  @Post('invites/:id/revoke')
  async revokeInvite(@Param('id') id: string) {
    await this.prisma.inviteCode.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  }

  /* ------------------------------------------------------ guilds/channels */

  @Get('guilds')
  async guilds() {
    const rows = await this.prisma.guild.findMany({
      include: {
        channels: { orderBy: [{ position: 'asc' }, { name: 'asc' }] },
        _count: { select: { members: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((g) => ({
      id: g.id,
      name: g.name,
      memberCount: g._count.members,
      channels: g.channels.map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        position: c.position,
      })),
    }));
  }

  @Post('guilds')
  async createGuild(
    @CurrentUser() admin: SessionUser,
    @Body(new ZodPipe(CreateGuildInput)) body: CreateGuildInput,
  ) {
    const guild = await this.prisma.guild.create({
      data: {
        id: newId(),
        name: body.name,
        channels: {
          create: [{ id: newId(), name: 'general', kind: 'TEXT', position: 0 }],
        },
        // Whoever creates it administers it, or nobody could manage it.
        members: {
          create: [{ id: newId(), userId: admin.id, role: 'ADMIN' }],
        },
      },
    });
    this.gateway.broadcastGuildChanged(guild.id);
    return { id: guild.id, name: guild.name };
  }

  @Post('guilds/:guildId/channels')
  async createChannel(
    @Param('guildId') guildId: string,
    @Body(new ZodPipe(CreateChannelInput)) body: CreateChannelInput,
  ) {
    const channel = await this.channels.create(guildId, body);
    return { id: channel.id, name: channel.name, kind: channel.kind };
  }

  @Patch('channels/:id')
  async updateChannel(
    @Param('id') id: string,
    @Body(new ZodPipe(UpdateChannelInput)) body: UpdateChannelInput,
  ) {
    await this.channels.update(id, body);
    return { ok: true };
  }

  @Delete('channels/:id')
  async deleteChannel(@Param('id') id: string) {
    await this.channels.remove(id);
    return { ok: true };
  }

  /* ------------------------------------------------------------- messages */

  @Get('channels/:id/messages')
  async recentMessages(@Param('id') id: string) {
    const rows = await this.prisma.message.findMany({
      where: { channelId: id },
      include: { author: { select: { username: true } } },
      orderBy: { id: 'desc' },
      take: 50,
    });
    return rows.map((m) => ({
      id: m.id,
      content: m.content,
      author: m.author.username,
      createdAt: m.createdAt.toISOString(),
      deletedAt: m.deletedAt?.toISOString() ?? null,
    }));
  }

  @Delete('messages/:id')
  async deleteMessage(@CurrentUser() admin: SessionUser, @Param('id') id: string) {
    const row = await this.prisma.message.update({
      where: { id },
      data: { deletedAt: new Date(), deletedById: admin.id },
      select: { id: true, channelId: true },
    });
    // Without this the message stayed on every open client until a reload.
    this.gateway.broadcastMessageDeleted(row.id, row.channelId);
    return { ok: true };
  }
}
