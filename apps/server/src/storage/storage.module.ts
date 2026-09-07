import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SettingsService } from '../settings/settings.service';
import { StorageService } from './storage.service';
import { RetentionService } from './retention.service';
import { StorageController } from './storage.controller';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [StorageController],
  providers: [StorageService, RetentionService, SettingsService],
  exports: [StorageService, RetentionService, SettingsService],
})
export class StorageModule {}
