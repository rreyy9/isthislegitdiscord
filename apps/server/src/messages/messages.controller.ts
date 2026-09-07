import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import {
  EditMessageInput,
  MAX_PINS_PER_CHANNEL,
  MessageHistoryQuery,
  SendMessageInput,
  type Message,
  type MessagePage,
} from '@isthislegit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { PermissionService } from '../auth/permission.guard';
import { ChatGateway } from '../gateway/chat.gateway';
import { MentionsService } from '../mentions/mentions.service';
import { ZodPipe } from '../common/zod.pipe';
import { newId } from '../common/ids';
import {
  ALLOWED_TYPES,
  maxUploadBytes,
  store,
  type StoredFile,
} from '../attachments/storage';

const withAuthor = {
  author: {
    select: { id: true, username: true, name: true, image: true },
  },
  attachments: {
    select: {
      id: true,
      fileName: true,
      contentType: true,
      size: true,
      width: true,
      height: true,
    },
  },
  // Who the message tagged. Read from the rows rather than re-parsed out of
  // the text, because the rows are the validated answer -- a `<@id>` naming
  // somebody who is not in the guild was never stored and must not come back
  // out of history looking like it was.
  mentions: { select: { userId: true } },
} as const;

function toDto(row: any): Message {
  return {
    id: row.id,
    channelId: row.channelId,
    author: {
      id: row.author.id,
      username: row.author.username ?? row.author.id,
      displayName: row.author.name ?? null,
      image: row.author.image ?? null,
    },
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    clientNonce: row.clientNonce ?? null,
    pinnedAt: row.pinnedAt ? row.pinnedAt.toISOString() : null,
    mentions: (row.mentions ?? []).map((m: any) => m.userId),
    attachments: (row.attachments ?? []).map((a: any) => ({
      id: a.id,
      fileName: a.fileName,
      contentType: a.contentType,
      size: a.size,
      width: a.width ?? null,
      height: a.height ?? null,
      // A path, not a full URL: the client already knows its server address,
      // and baking one in would break the moment that address changed.
      url: `/api/attachments/${a.id}`,
    })),
  };
}

@Controller('api/channels/:channelId/messages')
@UseGuards(AuthGuard)
export class MessagesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly gateway: ChatGateway,
    private readonly mentions: MentionsService,
  ) {}

  /**
   * Cursor paging, not offset. `before` is a message id; because ids are
   * UUIDv7 they sort chronologically, so this stays correct even while new
   * messages arrive mid-scroll.
   */
  @Get()
  async history(
    @CurrentUser() user: SessionUser,
    @Param('channelId') channelId: string,
    @Query(new ZodPipe(MessageHistoryQuery)) query: MessageHistoryQuery,
  ): Promise<MessagePage> {
    if (!(await this.permissions.canInChannel(user.id, channelId, 'channel.read'))) {
      throw new ForbiddenException('No access to that channel.');
    }

    const rows = await this.prisma.message.findMany({
      where: {
        channelId,
        deletedAt: null,
        ...(query.before ? { id: { lt: query.before } } : {}),
      },
      include: withAuthor,
      orderBy: { id: 'desc' },
      take: query.limit,
    });

    return {
      // Returned oldest-first so the client can append directly to the top.
      messages: rows.map(toDto).reverse(),
      nextCursor: rows.length === query.limit ? rows[rows.length - 1].id : null,
    };
  }

  /**
   * The pinned messages in this channel, newest post first.
   *
   * Ordered by message id rather than by when it was pinned: the list is a
   * reading list, and the thing people look for in it is *when it was said*.
   * Pinning something from last March would otherwise put it at the top of a
   * list whose next entry is from this morning.
   *
   * Not paged. `MAX_PINS_PER_CHANNEL` is what makes that safe -- the cap is
   * low enough that the whole list is one query, and that is most of the
   * reason for having a cap at all.
   */
  @Get('pinned')
  async pinned(
    @CurrentUser() user: SessionUser,
    @Param('channelId') channelId: string,
  ): Promise<Message[]> {
    if (!(await this.permissions.canInChannel(user.id, channelId, 'channel.read'))) {
      throw new ForbiddenException('No access to that channel.');
    }

    const rows = await this.prisma.message.findMany({
      // A deleted message takes its pin with it. The row survives for the
      // audit trail; nothing should be able to bring it back onto a board that
      // everyone in the channel reads.
      where: { channelId, deletedAt: null, pinnedAt: { not: null } },
      include: withAuthor,
      orderBy: { id: 'desc' },
      take: MAX_PINS_PER_CHANNEL,
    });
    return rows.map(toDto);
  }

  /**
   * Takes JSON as it always did, and multipart when there are files.
   *
   * Upload and send are one request on purpose. The alternative — upload
   * first, reference the ids when sending — needs `Attachment.messageId` to be
   * nullable and then something to sweep up the attachments nobody ever sent.
   * One request means an attachment cannot exist without its message.
   */
  @Post()
  @UseInterceptors(
    FilesInterceptor('files', 10, {
      storage: memoryStorage(),
      limits: { fileSize: maxUploadBytes(), files: 10 },
      fileFilter: (_req, file, cb) =>
        ALLOWED_TYPES[file.mimetype]
          ? cb(null, true)
          : cb(new BadRequestException(`Cannot send ${file.mimetype} here.`), false),
    }),
  )
  async send(
    @CurrentUser() user: SessionUser,
    @Param('channelId') channelId: string,
    @Body(new ZodPipe(SendMessageInput.omit({ channelId: true })))
    body: Omit<SendMessageInput, 'channelId'>,
    @UploadedFiles() files?: Express.Multer.File[],
  ): Promise<Message> {
    // Membership is the whole test. A mute is not checked here on purpose: it
    // takes away the microphone, not the keyboard.
    if (!(await this.permissions.canInChannel(user.id, channelId, 'channel.write'))) {
      throw new ForbiddenException('No access to that channel.');
    }
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      // The name is for the notification a tag raises: it has to say which
      // channel, and the person being tagged may never have opened it.
      select: { kind: true, name: true },
    });
    if (!channel) throw new NotFoundException('No such channel.');
    if (channel.kind !== 'TEXT') {
      throw new ForbiddenException('That is not a text channel.');
    }

    const uploads = files ?? [];
    // A message has to say something. Empty content is fine when a screenshot
    // is the message, which is why the schema allows it.
    if (!body.content.trim() && uploads.length === 0) {
      throw new BadRequestException('Nothing to send.');
    }

    // Written to disk before the row exists, so a failed write cannot leave a
    // message pointing at a file that is not there. The reverse — a file with
    // no row — is just an unreferenced byte on disk.
    const stored: StoredFile[] = [];
    for (const file of uploads) {
      stored.push(await store(file));
    }

    const row = await this.prisma.message.create({
      data: {
        id: newId(),
        channelId,
        authorId: user.id,
        content: body.content,
        clientNonce: body.clientNonce ?? null,
        attachments: {
          create: stored.map((f) => ({
            id: f.id,
            uploaderId: user.id,
            fileName: f.fileName,
            storedName: f.storedName,
            contentType: f.contentType,
            size: f.size,
            width: f.width,
            height: f.height,
          })),
        },
      },
      include: withAuthor,
    });

    // Resolved after the row exists, because a mention is a row that points at
    // a message: there is nothing to hang it off until the message is saved.
    const { pinged } = await this.mentions.sync(
      row.id,
      channelId,
      row.content,
      user.id,
    );

    const dto = { ...toDto(row), mentions: pinged };
    this.gateway.broadcastMessage(dto);
    // After the broadcast, so that anyone with the channel open has already
    // been given the message their notification is about.
    this.gateway.notifyMentions(dto, pinged, channel.name);
    return dto;
  }

  /**
   * Edit your own message. Only the author, ever — an admin can delete what
   * someone said but must not be able to change it into something they never
   * said. `editedAt` is what puts the "(edited)" mark on it.
   */
  @Patch(':id')
  async edit(
    @CurrentUser() user: SessionUser,
    @Param('channelId') channelId: string,
    @Param('id') id: string,
    @Body(new ZodPipe(EditMessageInput)) body: EditMessageInput,
  ): Promise<Message> {
    const existing = await this.prisma.message.findUnique({
      where: { id },
      include: { attachments: { select: { id: true } } },
    });
    if (!existing || existing.channelId !== channelId) {
      throw new NotFoundException('No such message.');
    }
    if (existing.deletedAt) {
      throw new NotFoundException('That message was deleted.');
    }
    if (existing.authorId !== user.id) {
      throw new ForbiddenException('You can only edit your own messages.');
    }
    if (!(await this.permissions.canInChannel(user.id, channelId, 'channel.write'))) {
      throw new ForbiddenException('No access to that channel.');
    }

    const content = body.content.trim();
    // Same rule as sending: text may be empty only when images carry it.
    if (!content && existing.attachments.length === 0) {
      throw new BadRequestException('A message cannot be empty. Delete it instead.');
    }

    const row = await this.prisma.message.update({
      where: { id },
      data: { content, editedAt: new Date() },
      include: withAuthor,
    });

    // An edit can add a name that was not there before, and somebody tagged by
    // the edit has to hear about it -- typing a name, realising you forgot the
    // @, and fixing it is how half of all tags get written. Only the ones the
    // edit added are notified, so correcting a typo does not ping the room
    // again.
    const { pinged, newlyPinged } = await this.mentions.sync(
      row.id,
      channelId,
      content,
      user.id,
    );

    const dto = { ...toDto(row), mentions: pinged };
    this.gateway.broadcastMessageUpdated(dto);
    if (newlyPinged.length > 0) {
      const channel = await this.prisma.channel.findUnique({
        where: { id: channelId },
        select: { name: true },
      });
      this.gateway.notifyMentions(dto, newlyPinged, channel?.name ?? '');
    }
    return dto;
  }

  /**
   * Delete a message: your own, or anyone's if you administer the guild.
   * Soft — the row stays with `deletedById` so a deletion can be looked into
   * later — but it is gone from every client and from history.
   */
  @Delete(':id')
  async remove(
    @CurrentUser() user: SessionUser,
    @Param('channelId') channelId: string,
    @Param('id') id: string,
  ) {
    const existing = await this.prisma.message.findUnique({
      where: { id },
      select: { id: true, channelId: true, authorId: true, deletedAt: true },
    });
    if (!existing || existing.channelId !== channelId) {
      throw new NotFoundException('No such message.');
    }
    // Already gone: say so quietly rather than 404, so two moderators
    // clicking at once do not both see an error.
    if (existing.deletedAt) return { ok: true };

    const mine = existing.authorId === user.id;
    if (!mine) {
      if (!(await this.permissions.canInChannel(user.id, channelId, 'message.moderate'))) {
        throw new ForbiddenException('Only the author or an admin can delete that.');
      }
    } else if (!(await this.permissions.canInChannel(user.id, channelId, 'channel.read'))) {
      throw new ForbiddenException('No access to that channel.');
    }

    await this.prisma.message.update({
      where: { id },
      data: { deletedAt: new Date(), deletedById: user.id },
    });

    this.gateway.broadcastMessageDeleted(id, channelId);
    return { ok: true };
  }

  /* ---------------------------------------------------------------- pins */

  /**
   * Pin a message. Admins only — a pin is the one thing in a channel that
   * everybody is shown whether they asked or not, so it is a moderator's
   * decision in the same way an announcement is.
   */
  @Post(':id/pin')
  async pin(
    @CurrentUser() user: SessionUser,
    @Param('channelId') channelId: string,
    @Param('id') id: string,
  ): Promise<Message> {
    if (!(await this.permissions.canInChannel(user.id, channelId, 'message.pin'))) {
      throw new ForbiddenException('Only an admin can pin messages.');
    }

    const existing = await this.prisma.message.findUnique({
      where: { id },
      include: withAuthor,
    });
    if (!existing || existing.channelId !== channelId || existing.deletedAt) {
      throw new NotFoundException('No such message.');
    }
    // Already pinned: hand it back untouched rather than re-stamping it. Two
    // admins clicking at once should not move anything, and `pinnedAt` is a
    // record of when it went up.
    if (existing.pinnedAt) return toDto(existing);

    const pinned = await this.prisma.message.count({
      where: { channelId, deletedAt: null, pinnedAt: { not: null } },
    });
    if (pinned >= MAX_PINS_PER_CHANNEL) {
      throw new BadRequestException(
        `This channel already has ${MAX_PINS_PER_CHANNEL} pinned messages. Unpin one first.`,
      );
    }

    const row = await this.prisma.message.update({
      where: { id },
      data: { pinnedAt: new Date(), pinnedById: user.id },
      include: withAuthor,
    });

    const dto = toDto(row);
    this.gateway.broadcastPinChanged(channelId, id, dto.pinnedAt);
    return dto;
  }

  /** Unpin. Same permission: what an admin put up, an admin takes down. */
  @Delete(':id/pin')
  async unpin(
    @CurrentUser() user: SessionUser,
    @Param('channelId') channelId: string,
    @Param('id') id: string,
  ) {
    if (!(await this.permissions.canInChannel(user.id, channelId, 'message.pin'))) {
      throw new ForbiddenException('Only an admin can unpin messages.');
    }

    const existing = await this.prisma.message.findUnique({
      where: { id },
      select: { id: true, channelId: true, pinnedAt: true },
    });
    if (!existing || existing.channelId !== channelId) {
      throw new NotFoundException('No such message.');
    }
    // Not pinned: say so quietly, so two admins clicking at once do not both
    // see an error for something that ended up the way they wanted.
    if (!existing.pinnedAt) return { ok: true };

    await this.prisma.message.update({
      where: { id },
      // `pinnedById` goes too. It says who pinned the thing that is pinned,
      // and once nothing is, keeping it would only ever mislead.
      data: { pinnedAt: null, pinnedById: null },
    });

    this.gateway.broadcastPinChanged(channelId, id, null);
    return { ok: true };
  }
}
