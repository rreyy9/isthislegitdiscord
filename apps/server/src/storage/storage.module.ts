import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SettingsService } from '../settings/settings.service';
import { StorageService } from './storage.service';
import { RetentionService } from './retention.service';
import { EphemeralService } from './ephemeral.service';
import { StorageController } from './storage.controller';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [StorageController],
  providers: [StorageService, RetentionService, EphemeralService, SettingsService],
  exports: [StorageService, RetentionService, EphemeralService, SettingsService],
})
export class StorageModule {}
