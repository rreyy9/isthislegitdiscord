import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { MarkReadInput, type ChannelRead } from '@isthislegit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { PermissionService } from '../auth/permission.guard';
import { ZodPipe } from '../common/zod.pipe';
import { newId } from '../common/ids';

/**
 * How far each channel has been read.
 *
 * The comparison is `messageId > lastReadMessageId`, with no timestamps
 * anywhere: ids are UUIDv7, so id order is time order. That is the whole
 * reason `ChannelReadState` has been sitting in the schema since day one with
 * only an id column to fill in.
 */
@Controller('api')
@UseGuards(AuthGuard)
export class ReadsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
  ) {}

  /** Every channel this user has ever read, for working out what is new. */
  @Get('reads')
  async list(@CurrentUser() user: SessionUser): Promise<ChannelRead[]> {
    const rows = await this.prisma.channelReadState.findMany({
      where: { userId: user.id },
      select: { channelId: true, lastReadMessageId: true },
    });
    return rows.map((r) => ({
      channelId: r.channelId,
      lastReadMessageId: r.lastReadMessageId ?? null,
    }));
  }

  @Post('channels/:channelId/read')
  async mark(
    @CurrentUser() user: SessionUser,
    @Param('channelId') channelId: string,
    @Body(new ZodPipe(MarkReadInput)) body: MarkReadInput,
  ): Promise<ChannelRead> {
    if (!(await this.permissions.canInChannel(user.id, channelId, 'channel.read'))) {
      throw new ForbiddenException('No access to that channel.');
    }

    const existing = await this.prisma.channelReadState.findUnique({
      where: { userId_channelId: { userId: user.id, channelId } },
      select: { lastReadMessageId: true },
    });

    // Never move the marker backwards. Two clients open on two machines will
    // both report, and the older one must not un-read what the newer one read.
    const next =
      existing?.lastReadMessageId && existing.lastReadMessageId > body.lastReadMessageId
        ? existing.lastReadMessageId
        : body.lastReadMessageId;

    const row = await this.prisma.channelReadState.upsert({
      where: { userId_channelId: { userId: user.id, channelId } },
      create: {
        id: newId(),
        userId: user.id,
        channelId,
        lastReadMessageId: next,
      },
      update: { lastReadMessageId: next },
      select: { channelId: true, lastReadMessageId: true },
    });

    return {
      channelId: row.channelId,
      lastReadMessageId: row.lastReadMessageId ?? null,
    };
  }
}
