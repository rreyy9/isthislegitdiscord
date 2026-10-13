import { Module } from '@nestjs/common';
import { UpdatesService } from './updates.service';
import { UpdatesAdminController, UpdatesController } from './updates.controller';
import { AndroidUpdatesService } from './android-updates.service';
import { AndroidPageController } from './android-page.controller';
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
    AndroidPageController,
  ],
  providers: [UpdatesService, AndroidUpdatesService],
  exports: [UpdatesService, AndroidUpdatesService],
})
export class UpdatesModule {}
