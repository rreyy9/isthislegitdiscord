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
  Post,
  UseGuards,
} from '@nestjs/common';
import { MuteMemberInput, RemoveMemberInput } from '@isthislegit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { PermissionService } from '../auth/permission.guard';
import { AUTH, type Auth } from '../auth/auth.factory';
import { ChatGateway } from '../gateway/chat.gateway';
import { VoiceService } from '../voice/voice.service';
import { ZodPipe } from '../common/zod.pipe';
import { newId } from '../common/ids';

/**
 * An indefinite mute is a date that never arrives, so every check stays a
 * single date comparison and nothing has to special-case "forever".
 */
const NEVER = new Date('9999-12-31T23:59:59.000Z');

/**
 * Moderation: mute, kick, ban. Guild-scoped and admin-only — deliberately not
 * behind AdminGuard, which asks "an admin of anything?" for the operator
 * console. Here it has to be an admin of *this* guild.
 */
@Controller('api/guilds/:guildId')
@UseGuards(AuthGuard)
export class ModerationController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly gateway: ChatGateway,
    private readonly voice: VoiceService,
    @Inject(AUTH) private readonly auth: Auth,
  ) {}

  /**
   * Every action here passes through this. Three refusals, in order: not an
   * admin, yourself, another admin. Roles are flat — there is no hierarchy to
   * rank two admins by — so admins simply cannot act on each other, and
   * demoting one (from the console) is the way round it.
   */
  private async assertCanModerate(
    actor: SessionUser,
    guildId: string,
    targetUserId: string,
  ) {
    if (!(await this.permissions.canInGuild(actor.id, guildId, 'member.moderate'))) {
      throw new ForbiddenException('Admins only.');
    }
    if (actor.id === targetUserId) {
      throw new BadRequestException('You cannot moderate yourself.');
    }
    const target = await this.permissions.membership(targetUserId, guildId);
    if (!target) throw new NotFoundException('Not a member of this server.');
    if (target.role === 'ADMIN') {
      throw new ForbiddenException('You cannot moderate another admin.');
    }
    return target;
  }

  /**
   * Voice is live: a removal that only applies on next join is no removal.
   * Kick and ban only — a mute leaves them where they are.
   */
  private async ejectFromVoice(guildId: string, userId: string) {
    const rooms = await this.prisma.channel.findMany({
      where: { guildId, kind: 'VOICE' },
      select: { id: true },
    });
    await Promise.all(
      rooms.map((c) => this.voice.removeParticipant(c.id, userId)),
    );
  }

  /* ----------------------------------------------------------------- mute */

  @Post('members/:userId/mute')
  async mute(
    @CurrentUser() actor: SessionUser,
    @Param('guildId') guildId: string,
    @Param('userId') userId: string,
    @Body(new ZodPipe(MuteMemberInput)) body: MuteMemberInput,
  ) {
    await this.assertCanModerate(actor, guildId, userId);

    const mutedUntil =
      body.durationMinutes === null
        ? NEVER
        : new Date(Date.now() + body.durationMinutes * 60_000);

    await this.prisma.guildMember.update({
      where: { guildId_userId: { guildId, userId } },
      data: { mutedUntil },
    });
    // They stay in whatever call they are in and keep hearing it; what goes is
    // the microphone. If they are not in a call this does nothing, and the
    // grant on their next join carries the same rule.
    await this.voice.syncMutes(guildId);
    this.gateway.broadcastMemberUpdated(guildId, userId, mutedUntil);

    return { ok: true, mutedUntil: mutedUntil.toISOString() };
  }

  @Post('members/:userId/unmute')
  async unmute(
    @CurrentUser() actor: SessionUser,
    @Param('guildId') guildId: string,
    @Param('userId') userId: string,
  ) {
    // Not assertCanModerate: unmuting an admin is harmless, and refusing it
    // would strand anyone who was muted before being promoted.
    if (!(await this.permissions.canInGuild(actor.id, guildId, 'member.moderate'))) {
      throw new ForbiddenException('Admins only.');
    }
    const target = await this.permissions.membership(userId, guildId);
    if (!target) throw new NotFoundException('Not a member of this server.');

    await this.prisma.guildMember.update({
      where: { guildId_userId: { guildId, userId } },
      data: { mutedUntil: null },
    });
    // Hand the microphone back now rather than at the next sweep, which is
    // what somebody sitting in a call being told "you're unmuted" expects.
    await this.voice.syncMutes(guildId);
    this.gateway.broadcastMemberUpdated(guildId, userId, null);

    return { ok: true };
  }

  /* ----------------------------------------------------------- kick / ban */

  @Post('members/:userId/kick')
  async kick(
    @CurrentUser() actor: SessionUser,
    @Param('guildId') guildId: string,
    @Param('userId') userId: string,
    @Body(new ZodPipe(RemoveMemberInput)) body: RemoveMemberInput,
  ) {
    await this.assertCanModerate(actor, guildId, userId);

    await this.ejectFromVoice(guildId, userId);
    await this.prisma.guildMember.delete({
      where: { guildId_userId: { guildId, userId } },
    });

    // Tell them before cutting the wire — after the disconnect there is
    // nobody left to tell.
    this.gateway.notifyRemoved(userId, {
      guildId,
      kind: 'kick',
      reason: body.reason ?? null,
    });
    this.gateway.disconnectUser(userId);

    // Their account and password still work; a kick is "leave", not "never
    // come back". A fresh invite lets them straight back in.
    return { ok: true };
  }

  @Post('members/:userId/ban')
  async ban(
    @CurrentUser() actor: SessionUser,
    @Param('guildId') guildId: string,
    @Param('userId') userId: string,
    @Body(new ZodPipe(RemoveMemberInput)) body: RemoveMemberInput,
  ) {
    await this.assertCanModerate(actor, guildId, userId);

    await this.ejectFromVoice(guildId, userId);
    await this.prisma.$transaction([
      this.prisma.guildMember.delete({
        where: { guildId_userId: { guildId, userId } },
      }),
      this.prisma.guildBan.create({
        data: {
          id: newId(),
          guildId,
          userId,
          bannedById: actor.id,
          reason: body.reason ?? null,
        },
      }),
    ]);

    this.gateway.notifyRemoved(userId, {
      guildId,
      kind: 'ban',
      reason: body.reason ?? null,
    });
    this.gateway.disconnectUser(userId);

    // Unlike a kick, a ban kills their sessions: the stored bearer token stops
    // working, so the app cannot quietly reconnect with it.
    const ctx = await this.auth.$context;
    await ctx.internalAdapter.deleteUserSessions(userId);

    return { ok: true };
  }

  @Get('bans')
  async bans(
    @CurrentUser() actor: SessionUser,
    @Param('guildId') guildId: string,
  ) {
    if (!(await this.permissions.canInGuild(actor.id, guildId, 'member.moderate'))) {
      throw new ForbiddenException('Admins only.');
    }
    const rows = await this.prisma.guildBan.findMany({
      where: { guildId },
      include: {
        user: { select: { id: true, username: true, name: true } },
        bannedBy: { select: { username: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((b) => ({
      userId: b.userId,
      username: b.user.username ?? b.userId,
      displayName: b.user.name ?? null,
      bannedBy: b.bannedBy.username,
      reason: b.reason,
      createdAt: b.createdAt.toISOString(),
    }));
  }

  /**
   * Lifting a ban does not put them back in the server — it only stops the
   * ban from blocking them. They need an invite, same as anyone else.
   */
  @Delete('bans/:userId')
  async unban(
    @CurrentUser() actor: SessionUser,
    @Param('guildId') guildId: string,
    @Param('userId') userId: string,
  ) {
    if (!(await this.permissions.canInGuild(actor.id, guildId, 'member.moderate'))) {
      throw new ForbiddenException('Admins only.');
    }
    await this.prisma.guildBan.deleteMany({ where: { guildId, userId } });
    return { ok: true };
  }
}
