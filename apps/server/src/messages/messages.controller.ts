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
  MessageHistoryQuery,
  SendMessageInput,
  type Message,
  type MessagePage,
} from '@isthislegit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { PermissionService } from '../auth/permission.guard';
import { ChatGateway } from '../gateway/chat.gateway';
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
    if (!(await this.permissions.canInChannel(user.id, channelId, 'channel.write'))) {
      const until = await this.permissions.mutedUntilInChannel(user.id, channelId);
      throw new ForbiddenException(
        until ? 'You are muted in this server.' : 'No access to that channel.',
      );
    }
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { kind: true },
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

    const dto = toDto(row);
    this.gateway.broadcastMessage(dto);
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
    // Being muted stops you editing too, or a mute would just mean rewriting
    // the last thing you said over and over.
    if (!(await this.permissions.canInChannel(user.id, channelId, 'channel.write'))) {
      const until = await this.permissions.mutedUntilInChannel(user.id, channelId);
      throw new ForbiddenException(
        until ? 'You are muted in this server.' : 'No access to that channel.',
      );
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

    const dto = toDto(row);
    this.gateway.broadcastMessageUpdated(dto);
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
}
