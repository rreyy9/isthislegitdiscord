import { Module } from '@nestjs/common';
import { UpdatesService } from './updates.service';
import { UpdatesAdminController, UpdatesController } from './updates.controller';

@Module({
  controllers: [UpdatesController, UpdatesAdminController],
  providers: [UpdatesService],
  exports: [UpdatesService],
})
export class UpdatesModule {}
