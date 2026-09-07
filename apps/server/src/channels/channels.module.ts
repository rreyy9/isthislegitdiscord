import { Global, Module } from '@nestjs/common';
import { VoiceModule } from '../voice/voice.module';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';

/**
 * Global for the same reason the gateway is: the admin controller is
 * registered on the root module and needs the service too, so that the console
 * and the in-app admin take exactly the same path.
 */
@Global()
@Module({
  imports: [VoiceModule],
  controllers: [ChannelsController],
  providers: [ChannelsService],
  exports: [ChannelsService],
})
export class ChannelsModule {}
