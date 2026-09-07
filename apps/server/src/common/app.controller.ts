import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller, Get } from '@nestjs/common';
import type { ServerConfig } from '@isthislegit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { voiceAudioConfig } from '../voice/audio-config';
import { UpdatesService } from '../updates/updates.service';

/**
 * Read once, from package.json rather than npm_package_version: that variable
 * is only set when the process was started by an npm script, and an installed
 * server runs as a bare `node dist/main.js` from a scheduled task. Reading the
 * env var meant the deployment that matters most was the one always reporting
 * a hardcoded fallback version.
 *
 * dist/main.js sits one level under the package root in both layouts.
 */
const APP_VERSION = (() => {
  for (const candidate of ['../package.json', '../../package.json']) {
    try {
      const raw = readFileSync(join(__dirname, candidate), 'utf8');
      const version = JSON.parse(raw)?.version;
      if (typeof version === 'string') return version;
    } catch {
      // Try the next candidate.
    }
  }
  return 'unknown';
})();

@Controller('api')
export class AppController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly updates: UpdatesService,
  ) {}

  @Get('health')
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { ok: true, db: 'up', time: new Date().toISOString() };
  }

  /**
   * Everything the client would otherwise hardcode. A shipped desktop app
   * needs a reinstall to change a constant, so it asks instead.
   */
  @Get('config')
  async config(): Promise<ServerConfig> {
    return {
      livekitUrl: process.env.LIVEKIT_URL ?? 'ws://localhost:7880',
      maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 26214400),
      appVersion: APP_VERSION,
      // Also on the token response, which is what the client actually applies.
      // Here so the settings screen can show the active quality before anyone
      // has joined a call.
      voiceAudio: voiceAudioConfig(),
      // Null until a build has been published. The client offers an update;
      // it is never a reason to refuse service.
      latestClientVersion: await this.updates.latestVersion(),
      // A floor, and expected to stay null. Set it only for a change that
      // genuinely cannot be made compatible -- blocking ten people until each
      // notices a dialog is worse than the skew it avoids.
      minClientVersion: process.env.MIN_CLIENT_VERSION || null,
    };
  }
}
