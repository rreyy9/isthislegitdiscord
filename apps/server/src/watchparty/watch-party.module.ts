import { Global, Module } from '@nestjs/common';
import { WatchPartyService } from './watch-party.service';

/**
 * Global for the same reason `GatewayModule` is: the gateway is where every
 * party event arrives and leaves, and the gateway is itself global. One
 * in-memory map with one owner does not need a second wiring diagram.
 */
@Global()
@Module({
  providers: [WatchPartyService],
  exports: [WatchPartyService],
})
export class WatchPartyModule {}
