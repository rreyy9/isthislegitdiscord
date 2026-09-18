import {
  BadRequestException,
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
  AndroidUpdatesService,
  MAX_ANDROID_UPLOAD_BYTES,
  type AndroidRelease,
} from './android-updates.service';

/**
 * The Android feed, unauthenticated for the reason the desktop one is: an
 * update matters most to somebody whose session has lapsed, and a feed behind
 * a token fails exactly then.
 *
 * Publishing is next door, behind AdminGuard.
 */
@Controller('updates/android')
export class AndroidUpdatesController {
  constructor(private readonly updates: AndroidUpdatesService) {}

  @Get(':name')
  @Header('Cache-Control', 'no-cache')
  async file(
    @Param('name') name: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    let stream: ReturnType<AndroidUpdatesService['open']>;
    try {
      stream = this.updates.open(name);
      res.setHeader('Content-Length', String(await this.updates.size(name)));
    } catch {
      throw new NotFoundException('No such update file.');
    }

    // The APK type matters: handed `application/octet-stream`, some Android
    // browsers save the file without offering to install it, and the person is
    // left with a download they have to find in a file manager. The manifest is
    // ordinary JSON and is read by fetch, which does not care -- but a wrong
    // type there would still show up the first time somebody opened it in a
    // browser to check what was published.
    res.setHeader(
      'Content-Type',
      /\.apk$/i.test(name)
        ? 'application/vnd.android.package-archive'
        : 'application/json',
    );
    return new StreamableFile(stream);
  }
}

@Controller('api/admin/updates/android')
@UseGuards(AdminGuard)
export class AndroidUpdatesAdminController {
  constructor(
    private readonly updates: AndroidUpdatesService,
    private readonly gateway: ChatGateway,
  ) {}

  @Get()
  async current(): Promise<{
    release: AndroidRelease | null;
    staged: AndroidRelease | null;
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
   * Receive one file of a release -- the manifest, or the APK it names.
   *
   * A raw body rather than multipart, and streamed straight to disk rather
   * than buffered: the APK is tens of megabytes, and `Invoke-WebRequest
   * -InFile` can send that from Windows PowerShell without anybody hand-rolling
   * a multipart body. The same shape the desktop route takes, for the same
   * reason and driven by the same publish script.
   */
  @Put('staging/:name')
  async upload(
    @Param('name') name: string,
    @Req() req: Request,
  ): Promise<{ name: string; bytes: number }> {
    let out: Awaited<ReturnType<AndroidUpdatesService['openStaged']>>;
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
      if (bytes > MAX_ANDROID_UPLOAD_BYTES && !tooBig) {
        tooBig = true;
        req.destroy(new Error('Upload is larger than the limit.'));
      }
    });

    try {
      await pipeline(req, out);
    } catch (e) {
      // A partial APK left in staging would look publishable right up until
      // the sha256 check refused it, which is a confusing place to find out.
      // Take the whole staging set out of the way instead.
      await this.updates.clearStaging().catch(() => undefined);
      if (tooBig) {
        throw new PayloadTooLargeException(
          `That file is over the ${Math.round(
            MAX_ANDROID_UPLOAD_BYTES / 1024 / 1024,
          )} MB limit.`,
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
   * Promote the upload, then tell every connected phone.
   *
   * Its own event rather than the desktop `client:update-available`, which
   * goes to everyone: a desktop client hearing an Android version number would
   * offer it as its own update and then fail to find an installer. Nothing
   * that can tell the two platforms apart exists on that event, and adding a
   * field to it would change an event old clients already listen to -- so this
   * is a new one, which every existing client drops.
   */
  @Post('publish')
  async publish(): Promise<{ release: AndroidRelease; notified: number }> {
    const release = await this.updates.publishStaged();
    const notified = this.gateway.announceAndroidUpdate(
      release.manifest.version,
      release.manifest.versionCode,
    );
    return { release, notified };
  }
}
