import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseEnumPipe,
  Post,
  Put,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import {
  EVENT_SOUND_EVENTS,
  MAX_EVENT_SOUND_BYTES,
  SetEventSoundInput,
  type EventSoundEvent,
  type EventSoundsConfig,
} from '@isthislegit/shared';
import { AdminGuard, AuthGuard } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { EventSoundsService } from './event-sounds.service';

/** `:event` as one of the three, or a 400. */
const EventParam = new ParseEnumPipe(
  Object.fromEntries(EVENT_SOUND_EVENTS.map((e) => [e, e])),
);

/**
 * The server's event sounds. Anybody signed in may read the table and fetch
 * the files -- every client has to, to play them. Only an admin may change
 * them; see AdminGuard for what "admin" means on this server.
 */
@Controller('api/event-sounds')
export class EventSoundsController {
  constructor(private readonly sounds: EventSoundsService) {}

  @Get()
  @UseGuards(AuthGuard)
  config(): Promise<EventSoundsConfig> {
    return this.sounds.config();
  }

  @Get('files/:id')
  @UseGuards(AuthGuard)
  // A new upload is a new id, so a file never changes under one.
  @Header('Cache-Control', 'private, max-age=31536000, immutable')
  async file(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { contentType, bytes } = await this.sounds.file(id);
    // Labelled from the sniffed bytes, never from what the uploader claimed,
    // and with the same two headers attachments carry: nothing here is a
    // document, and the browser is not to decide otherwise.
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    return new StreamableFile(bytes);
  }

  @Put(':event')
  @UseGuards(AdminGuard)
  set(
    @Param('event', EventParam) event: EventSoundEvent,
    @Body(new ZodPipe(SetEventSoundInput)) body: SetEventSoundInput,
  ): Promise<EventSoundsConfig> {
    return this.sounds.set(event, body);
  }

  @Post(':event/file')
  @UseGuards(AdminGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_EVENT_SOUND_BYTES, files: 1 },
    }),
  )
  upload(
    @Param('event', EventParam) event: EventSoundEvent,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<EventSoundsConfig> {
    if (!file) throw new BadRequestException('No sound file was sent.');
    return this.sounds.upload(event, file);
  }
}
