import { Global, Module } from '@nestjs/common';
import { MentionsController } from './mentions.controller';
import { MentionsService } from './mentions.service';

/**
 * Global for the same reason the gateway is: the messages controller needs the
 * service on every send and every edit, and it is registered on the root
 * module rather than inside one of its own.
 */
@Global()
@Module({
  controllers: [MentionsController],
  providers: [MentionsService],
  exports: [MentionsService],
})
export class MentionsModule {}
