import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  NotFoundException,
  Param,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { PermissionService } from '../auth/permission.guard';
import { openStored } from './storage';

/**
 * Serving an uploaded image back.
 *
 * Behind the same auth as everything else, and behind a channel-membership
 * check — an attachment id is a bearer of nothing on its own. The client
 * fetches these with its token and turns them into blob URLs rather than
 * putting them in an <img src>, because a token in a URL ends up in logs and
 * history.
 */
@Controller('api/attachments')
@UseGuards(AuthGuard)
export class AttachmentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
  ) {}

  @Get(':id')
  @Header('Cache-Control', 'private, max-age=31536000, immutable')
  async download(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const row = await this.prisma.attachment.findUnique({
      where: { id },
      select: {
        storedName: true,
        contentType: true,
        fileName: true,
        message: { select: { channelId: true } },
      },
    });
    if (!row) throw new NotFoundException('No such attachment.');

    const allowed = await this.permissions.canInChannel(
      user.id,
      row.message.channelId,
      'channel.read',
    );
    if (!allowed) throw new ForbiddenException('No access to that attachment.');

    res.setHeader('Content-Type', row.contentType);
    // inline, not attachment: these are shown in the message list, and the
    // filename is only used if someone chooses to save one.
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(row.fileName)}"`,
    );
    // Uploaded bytes rendered in an Electron window: tell the browser not to
    // second-guess the declared type.
    res.setHeader('X-Content-Type-Options', 'nosniff');

    return new StreamableFile(openStored(row.storedName));
  }
}
