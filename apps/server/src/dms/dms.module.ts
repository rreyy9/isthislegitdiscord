import { Global, Module } from '@nestjs/common';
import { DmsController, KeysController } from './dms.controller';
import { DmsService } from './dms.service';

/**
 * Global for the reason mentions is: the messages controller needs the
 * service on every send and every deletion, and lives on the root module.
 */
@Global()
@Module({
  controllers: [DmsController, KeysController],
  providers: [DmsService],
  exports: [DmsService],
})
export class DmsModule {}
