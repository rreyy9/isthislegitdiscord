import {
  BadRequestException,
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Patch,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  Body,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import {
  MAX_AVATAR_BYTES,
  UpdateProfileInput,
  type PublicUser,
} from '@isthislegit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { ChatGateway } from '../gateway/chat.gateway';
import { ZodPipe } from '../common/zod.pipe';
import {
  ALLOWED_TYPES,
  discardStored,
  openStored,
  store,
  storedExists,
} from '../attachments/storage';

/**
 * Your own profile: the name everyone sees, and the picture beside it.
 *
 * Separate from the admin route that edits anybody's display name. This one
 * never takes a user id — it only ever edits the caller, which is what makes
 * it safe to leave open to every member.
 *
 * An avatar is stored the same way an attachment is (bytes on disk, named by
 * id) but deliberately not *as* an Attachment: those hang off a message and
 * are readable by whoever can read that message's channel. An avatar has no
 * message and is readable by every signed-in member, so it gets its own column
 * and its own route rather than a nullable `messageId` and a special case in
 * the attachment permission check.
 */

/** `user.image` holds this shape, and the GET route below serves it back. */
const AVATAR_PATH = '/api/avatars/';

/**
 * The stored file name out of a stored `user.image`, or null.
 *
 * Written as a parse rather than a string chop because the column has held a
 * plain URL in the past (Better Auth writes one for an OAuth account) and a
 * value that is not one of ours must not be handed to the file layer.
 */
function storedNameOf(image: string | null): string | null {
  if (!image || !image.startsWith(AVATAR_PATH)) return null;
  const name = image.slice(AVATAR_PATH.length);
  return /^[A-Za-z0-9_-]+\.[a-z]{3,4}$/.test(name) ? name : null;
}

function toPublicUser(row: {
  id: string;
  username: string | null;
  name: string | null;
  image: string | null;
}): PublicUser {
  return {
    id: row.id,
    username: row.username ?? row.id,
    displayName: row.name ?? null,
    image: row.image ?? null,
  };
}

@Controller('api')
@UseGuards(AuthGuard)
export class ProfileController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: ChatGateway,
  ) {}

  /**
   * Change your display name, or drop your avatar.
   *
   * Returns the whole public user rather than an ok flag: the caller has to
   * redraw itself with the new values, and everyone else gets the same object
   * over the socket, so there is one shape to keep in step instead of two.
   */
  @Patch('me')
  async updateProfile(
    @CurrentUser() user: SessionUser,
    @Body(new ZodPipe(UpdateProfileInput)) body: UpdateProfileInput,
  ): Promise<PublicUser> {
    if (body.displayName === undefined && !body.removeAvatar) {
      throw new BadRequestException('Nothing to change.');
    }

    const current = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { image: true },
    });

    const row = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        ...(body.displayName === undefined ? {} : { name: body.displayName }),
        ...(body.removeAvatar ? { image: null } : {}),
      },
      select: { id: true, username: true, name: true, image: true },
    });

    // After the row, not before: a delete that ran first and then failed to
    // save would leave a user pointing at a file that is gone.
    if (body.removeAvatar) {
      await discardStored(storedNameOf(current?.image ?? null));
    }

    const dto = toPublicUser(row);
    this.gateway.broadcastUserUpdated(dto);
    return dto;
  }

  /**
   * Upload an avatar. The client sends an already-cropped square, so nothing
   * here resizes: this server has no image codec and is not gaining one to
   * make a thumbnail.
   */
  @Post('me/avatar')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_AVATAR_BYTES, files: 1 },
      fileFilter: (_req, file, cb) =>
        ALLOWED_TYPES[file.mimetype]
          ? cb(null, true)
          : cb(
              new BadRequestException(`${file.mimetype} is not an image.`),
              false,
            ),
    }),
  )
  async uploadAvatar(
    @CurrentUser() user: SessionUser,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<PublicUser> {
    if (!file) throw new BadRequestException('No image was sent.');

    const current = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { image: true },
    });

    const stored = await store(file);
    const row = await this.prisma.user.update({
      where: { id: user.id },
      data: { image: AVATAR_PATH + stored.storedName },
      select: { id: true, username: true, name: true, image: true },
    });

    // The one it replaced is now unreachable, so it goes. Best-effort: a file
    // that will not delete is a wasted byte, not a failed upload.
    await discardStored(storedNameOf(current?.image ?? null));

    const dto = toPublicUser(row);
    this.gateway.broadcastUserUpdated(dto);
    return dto;
  }

  /**
   * Serve an avatar back.
   *
   * Behind auth like everything else, but with no per-user check beyond that:
   * an avatar is drawn next to its owner's name in the member list and on
   * every message they have sent, so anyone who can see the guild can already
   * see it.
   */
  @Get('avatars/:name')
  @Header('Cache-Control', 'private, max-age=31536000, immutable')
  async avatar(
    @Param('name') name: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    // The name is a path segment somebody typed at us, so it is validated
    // against the same shape the column is allowed to hold before it reaches
    // the file layer -- which checks again, and is the last line rather than
    // the only one.
    const storedName = storedNameOf(AVATAR_PATH + name);
    if (!storedName) throw new NotFoundException('No such avatar.');

    // Checked rather than assumed: replacing a picture deletes the file the
    // old path pointed at, and a client holding a member row from before the
    // change will still ask for it.
    if (!(await storedExists(storedName))) {
      throw new NotFoundException('No such avatar.');
    }

    const type = Object.entries(ALLOWED_TYPES).find(([, ext]) =>
      storedName.endsWith(ext),
    );
    res.setHeader('Content-Type', type ? type[0] : 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(openStored(storedName));
  }
}
