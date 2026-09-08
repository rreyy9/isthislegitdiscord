import {
  Controller,
  ForbiddenException,
  Get,
  GoneException,
  Header,
  NotFoundException,
  Param,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { isInlineType } from '@isthislegit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { PermissionService } from '../auth/permission.guard';
import { openStored } from './storage';

/**
 * Serving an uploaded image or video back.
 *
 * Behind the same auth as everything else, and behind a channel-membership
 * check — an attachment id is a bearer of nothing on its own. The client
 * fetches these with its token and turns them into blob URLs rather than
 * putting them in an <img src>, because a token in a URL ends up in logs and
 * history. A <video src> is the same story, and the same object URL answers
 * it: the whole file is fetched once rather than ranged over, which is what
 * the upload limit makes affordable.
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
        expiredAt: true,
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

    // The row outlives its file by design, so this is a normal state rather
    // than a fault: 410 rather than 404, because the difference between "there
    // was never such a file" and "it was here and its time ran out" is the
    // whole thing the reader wants to know.
    if (row.expiredAt) {
      throw new GoneException('That file has expired and is no longer stored.');
    }

    const inline = isInlineType(row.contentType);

    // The safety rule for accepting arbitrary uploads, and the only thing
    // standing between this route and hosting live script on the API's own
    // origin: a picture or a video is served as what it is, and everything
    // else is served as bytes to be saved. An uploaded HTML page handed back
    // inline would run against this origin, with this API's cookies and this
    // API's addresses.
    //
    // Video is on the inline side because a browser can only ever decode an
    // MP4 or a WebM into pixels -- there is no shape of either that becomes a
    // document. `nosniff` below is what holds that true: without it the
    // browser is free to disagree with the label.
    res.setHeader(
      'Content-Type',
      inline ? row.contentType : 'application/octet-stream',
    );
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.fileName)}`,
    );
    // Uploaded bytes rendered in an Electron window: tell the browser not to
    // second-guess the declared type. Load-bearing for the octet-stream above,
    // since sniffing is exactly what would undo it.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Nothing here is a document, and neither is anything it might reference.
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");

    return new StreamableFile(openStored(row.storedName));
  }
}
