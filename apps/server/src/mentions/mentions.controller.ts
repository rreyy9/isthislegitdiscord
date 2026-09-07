import { Controller, Get, UseGuards } from '@nestjs/common';
import type { ChannelMentions } from '@isthislegit/shared';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { MentionsService } from './mentions.service';

/**
 * Unread tags, per channel.
 *
 * Its own call rather than a field on `/api/reads`, because the two answer
 * different questions and are refreshed at different moments: read state moves
 * every time the reader scrolls, and this moves only when somebody says your
 * name. Bundling them would mean re-counting mentions on every scroll.
 */
@Controller('api')
@UseGuards(AuthGuard)
export class MentionsController {
  constructor(private readonly mentions: MentionsService) {}

  @Get('mentions')
  async list(@CurrentUser() user: SessionUser): Promise<ChannelMentions[]> {
    return this.mentions.unreadCounts(user.id);
  }
}
