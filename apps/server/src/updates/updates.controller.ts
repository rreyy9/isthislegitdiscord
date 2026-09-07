import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  NotFoundException,
  Param,
  PayloadTooLargeException,
  Post,
  Put,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';
import { AdminGuard } from '../auth/auth.guard';
import { ChatGateway } from '../gateway/chat.gateway';
import {
  MAX_UPLOAD_BYTES,
  UpdatesService,
  type PublishedRelease,
} from './updates.service';

/**
 * The update feed itself: no guard, because electron-updater fetches it before
 * anything has signed in, and because the installer holds no secret.
 *
 * Publishing is next door, behind AdminGuard.
 */
@Controller('updates/desktop')
export class UpdatesController {
  constructor(private readonly updates: UpdatesService) {}

  @Get(':name')
  @Header('Cache-Control', 'no-cache')
  async file(
    @Param('name') name: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    let stream: ReturnType<UpdatesService['open']>;
    try {
      stream = this.updates.open(name);
      const size = await this.updates.size(name);
      res.setHeader('Content-Length', String(size));
    } catch {
      throw new NotFoundException('No such update file.');
    }

    res.setHeader(
      'Content-Type',
      /\.ya?ml$/i.test(name) ? 'text/yaml' : 'application/octet-stream',
    );
    return new StreamableFile(stream);
  }
}

@Controller('api/admin/updates')
@UseGuards(AdminGuard)
export class UpdatesAdminController {
  constructor(
    private readonly updates: UpdatesService,
    private readonly gateway: ChatGateway,
  ) {}

  @Get()
  async current(): Promise<{
    release: PublishedRelease | null;
    staged: PublishedRelease | null;
    directory: string;
    stagingDirectory: string;
  }> {
    return {
      release: await this.updates.latest(true),
      staged: await this.updates.staged(),
      directory: this.updates.directory,
      stagingDirectory: this.updates.stagingDirectory,
    };
  }

  /**
   * Receive one file of a release.
   *
   * The client is built on a development machine and this server runs on a
   * different box, so the build has to travel; this is how. A raw body rather
   * than multipart, and streamed straight to disk rather than buffered: the
   * installer is most of two hundred megabytes, and `Invoke-WebRequest
   * -InFile` can send that from Windows PowerShell 5.1 without anybody
   * hand-rolling a multipart body.
   *
   * Files land in staging and are not served to anyone until they are
   * published.
   */
  @Put('staging/:name')
  async upload(
    @Param('name') name: string,
    @Req() req: Request,
  ): Promise<{ name: string; bytes: number }> {
    let out: Awaited<ReturnType<UpdatesService['openStaged']>>;
    try {
      out = await this.updates.openStaged(name);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }

    // Counted as it arrives rather than trusted from Content-Length, which is
    // the sender's claim about a body it is still writing.
    let bytes = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES && !tooBig) {
        tooBig = true;
        req.destroy(new Error('Upload is larger than the limit.'));
      }
    });

    try {
      await pipeline(req, out);
    } catch (e) {
      // A partial file left in staging would look publishable, and its
      // sha512 would not match. Take the whole staging set out of the way.
      await this.updates.clearStaging().catch(() => undefined);
      if (tooBig) {
        throw new PayloadTooLargeException(
          `That file is over the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit.`,
        );
      }
      throw new BadRequestException(
        `Upload of ${name} did not finish: ${(e as Error).message}`,
      );
    }

    return { name, bytes };
  }

  @Delete('staging')
  async discard(): Promise<{ ok: true }> {
    await this.updates.clearStaging();
    return { ok: true };
  }

  /**
   * Copy a built release in, then tell everyone who is connected.
   *
   * The broadcast is why publishing is a server action rather than a file
   * copy the console does by itself: an app that has been open all evening
   * would otherwise not learn about the build until it next reconnected.
   */
  @Post('publish')
  async publish(
    @Body() body: { sourceDir?: string },
  ): Promise<{ release: PublishedRelease; notified: number }> {
    // With no directory named, publish what was uploaded. That is the normal
    // case: the server is not the machine the client was built on. A
    // `sourceDir` is for the local checkout, where both live in one tree.
    const source = String(body?.sourceDir ?? '').trim();
    const release = source
      ? await this.updates.publish(source)
      : await this.updates.publishStaged();
    const notified = this.gateway.announceUpdate(release.version);
    return { release, notified };
  }
}
