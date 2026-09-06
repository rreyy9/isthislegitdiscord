import { Controller, Get } from '@nestjs/common';
import type { ServerConfig } from '@isthislegit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { voiceAudioConfig } from '../voice/audio-config';

@Controller('api')
export class AppController {
  constructor(private readonly prisma: PrismaService) {}

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
  config(): ServerConfig {
    return {
      livekitUrl: process.env.LIVEKIT_URL ?? 'ws://localhost:7880',
      maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 26214400),
      appVersion: process.env.npm_package_version ?? '0.1.0',
      // Also on the token response, which is what the client actually applies.
      // Here so the settings screen can show the active quality before anyone
      // has joined a call.
      voiceAudio: voiceAudioConfig(),
    };
  }
}
