import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CreateChannelInput, UpdateChannelInput } from '@isthislegit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { PermissionService } from '../auth/permission.guard';
import { ZodPipe } from '../common/zod.pipe';
import { ChannelsService } from './channels.service';

/**
 * Channel management from inside the app, for an admin of the guild.
 *
 * Deliberately not behind AdminGuard, which the console uses and which asks
 * "an admin of anything?". Here it has to be an admin of *this* guild, so
 * every route goes through `channel.manage` -- the same seam moderation uses,
 * and the reason the rule lives in one file rather than in each handler.
 */
@Controller('api')
@UseGuards(AuthGuard)
export class ChannelsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly channels: ChannelsService,
  ) {}

  @Post('guilds/:guildId/channels')
  async create(
    @CurrentUser() user: SessionUser,
    @Param('guildId') guildId: string,
    @Body(new ZodPipe(CreateChannelInput)) body: CreateChannelInput,
  ) {
    await this.assertCanManageGuild(user, guildId);
    return this.channels.create(guildId, body);
  }

  @Patch('channels/:id')
  async update(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body(new ZodPipe(UpdateChannelInput)) body: UpdateChannelInput,
  ) {
    await this.assertCanManageChannel(user, id);
    return this.channels.update(id, body);
  }

  @Delete('channels/:id')
  async remove(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    await this.assertCanManageChannel(user, id);
    const { ok } = await this.channels.remove(id);
    return { ok };
  }

  private async assertCanManageGuild(user: SessionUser, guildId: string) {
    if (!(await this.permissions.canInGuild(user.id, guildId, 'channel.manage'))) {
      throw new ForbiddenException('Admins only.');
    }
  }

  /**
   * The channel is looked up first so that a member of another server gets
   * "no such channel" rather than a 403 that confirms the id is real.
   */
  private async assertCanManageChannel(user: SessionUser, channelId: string) {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { guildId: true },
    });
    if (!channel) throw new NotFoundException('No such channel.');
    if (!(await this.permissions.membership(user.id, channel.guildId))) {
      throw new NotFoundException('No such channel.');
    }
    await this.assertCanManageGuild(user, channel.guildId);
  }
}
