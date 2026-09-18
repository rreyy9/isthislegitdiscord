import { Module } from '@nestjs/common';
import { UpdatesService } from './updates.service';
import { UpdatesAdminController, UpdatesController } from './updates.controller';
import { AndroidUpdatesService } from './android-updates.service';
import {
  AndroidUpdatesAdminController,
  AndroidUpdatesController,
} from './android-updates.controller';

@Module({
  controllers: [
    UpdatesController,
    UpdatesAdminController,
    AndroidUpdatesController,
    AndroidUpdatesAdminController,
  ],
  providers: [UpdatesService, AndroidUpdatesService],
  exports: [UpdatesService, AndroidUpdatesService],
})
export class UpdatesModule {}
