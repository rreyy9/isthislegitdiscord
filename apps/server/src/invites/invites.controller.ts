import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CreateInviteInput } from '@isthislegit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { newId, newInviteCode } from '../common/ids';

@Controller('api/guilds/:guildId/invites')
@UseGuards(AuthGuard)
export class InvitesController {
  constructor(private readonly prisma: PrismaService) {}

  private async assertAdmin(userId: string, guildId: string) {
    const member = await this.prisma.guildMember.findUnique({
      where: { guildId_userId: { guildId, userId } },
    });
    if (!member || member.role !== 'ADMIN') {
      throw new ForbiddenException('Admins only.');
    }
  }

  /** Issuing an invite is the whole access-control story: no code, no account. */
  @Post()
  async create(
    @CurrentUser() user: SessionUser,
    @Param('guildId') guildId: string,
    @Body(new ZodPipe(CreateInviteInput)) body: CreateInviteInput,
  ) {
    await this.assertAdmin(user.id, guildId);

    const invite = await this.prisma.inviteCode.create({
      data: {
        id: newId(),
        code: newInviteCode(),
        guildId,
        createdById: user.id,
        maxUses: body.maxUses,
        expiresAt: new Date(Date.now() + body.expiresInHours * 3600_000),
      },
    });

    return {
      code: invite.code,
      maxUses: invite.maxUses,
      uses: invite.uses,
      expiresAt: invite.expiresAt?.toISOString() ?? null,
    };
  }

  @Get()
  async list(
    @CurrentUser() user: SessionUser,
    @Param('guildId') guildId: string,
  ) {
    await this.assertAdmin(user.id, guildId);

    const invites = await this.prisma.inviteCode.findMany({
      where: { guildId },
      orderBy: { createdAt: 'desc' },
    });

    return invites.map((i) => ({
      code: i.code,
      maxUses: i.maxUses,
      uses: i.uses,
      expiresAt: i.expiresAt?.toISOString() ?? null,
      revokedAt: i.revokedAt?.toISOString() ?? null,
    }));
  }
}
