import { Module } from '@nestjs/common';
import { VoiceController, VoiceStateController } from './voice.controller';
import { LivekitWebhookController } from './livekit-webhook.controller';
import { VoiceService } from './voice.service';

@Module({
  controllers: [VoiceController, VoiceStateController, LivekitWebhookController],
  providers: [VoiceService],
  exports: [VoiceService],
})
export class VoiceModule {}
