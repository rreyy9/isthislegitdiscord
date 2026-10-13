import { Controller, Get, Header } from '@nestjs/common';
import { renderAndroidPage } from './android-page';
import { AndroidUpdatesService } from './android-updates.service';

/**
 * `/android`: where the desktop client's QR code sends a phone.
 *
 * Unauthenticated, like the feed it links to -- the person scanning has no
 * account on this phone yet, which is the whole reason they are here. It shows
 * nothing the feed does not already serve to anybody who asks: a version
 * number, a size, and the APK.
 *
 * A short path on purpose. It is also the thing somebody types by hand when
 * the camera will not focus, so it should fit on one line of a text message.
 */
@Controller('android')
export class AndroidPageController {
  constructor(private readonly updates: AndroidUpdatesService) {}

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  // Never cached: the page names a specific APK file, and a browser holding
  // yesterday's copy would offer a build that has since been replaced.
  @Header('Cache-Control', 'no-cache')
  async page(): Promise<string> {
    const release = await this.updates.latest();
    return renderAndroidPage(release?.manifest ?? null);
  }
}
