import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { WebhookReceiver } from 'livekit-server-sdk';
import { VoiceService, channelForRoom } from './voice.service';

/**
 * LiveKit tells us who joined and left. This is the only way the sidebar can
 * show a voice channel's occupants to someone who has not joined it — a
 * LiveKit client only sees participants of rooms it is itself connected to.
 *
 * Authentication is the signed JWT in the Authorization header, checked
 * against the same API key pair that signs join tokens. `AuthGuard` is
 * deliberately absent: the caller is LiveKit, not a logged-in person.
 */
@Controller('api/livekit/webhook')
@SkipThrottle()
export class LivekitWebhookController {
  private readonly log = new Logger(LivekitWebhookController.name);
  private readonly receiver = new WebhookReceiver(
    process.env.LIVEKIT_API_KEY ?? '',
    process.env.LIVEKIT_API_SECRET ?? '',
  );

  constructor(private readonly voice: VoiceService) {}

  @Post()
  @HttpCode(200)
  async receive(@Body() body: Buffer, @Headers('authorization') auth?: string) {
    if (!auth) throw new BadRequestException('unsigned webhook');

    // `receive` verifies the signature over the raw bytes, so the body must not
    // have been through a JSON parser first — see the raw-body mount in main.ts.
    const event = await this.receiver
      .receive(Buffer.isBuffer(body) ? body.toString('utf8') : String(body), auth)
      .catch((err: unknown) => {
        this.log.warn(`rejected webhook: ${(err as Error).message}`);
        return null;
      });
    if (!event) throw new BadRequestException('bad signature');

    const channelId = event.room?.name ? channelForRoom(event.room.name) : null;
    if (!channelId) return { ok: true };

    switch (event.event) {
      case 'participant_joined':
      case 'participant_left':
      case 'room_started':
      case 'room_finished':
        await this.voice.refresh(channelId);
        break;
      default:
        // track_published, egress, recordings — nothing here cares.
        break;
    }

    return { ok: true };
  }
}
