import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';
import {
  PurgeInput,
  RetentionPolicy,
  type PurgeResult,
  type RetentionPolicy as RetentionPolicyType,
  type StorageReport,
} from '@isthislegit/shared';
import { AdminGuard } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { StorageService } from './storage.service';
import { RetentionService } from './retention.service';

/**
 * Disk and database accounting, and the deletions that act on it.
 *
 * Everything destructive here defaults to a dry run and reports the count it
 * would affect. The caller has to ask for the real thing on purpose.
 */
@Controller('api/admin')
@UseGuards(AdminGuard)
export class StorageController {
  constructor(
    private readonly storage: StorageService,
    private readonly retention: RetentionService,
  ) {}

  @Get('storage')
  report(): Promise<StorageReport> {
    return this.storage.report();
  }

  @Post('storage/purge')
  async purge(
    @Body(new ZodPipe(PurgeInput)) body: PurgeInput,
  ): Promise<PurgeResult> {
    if (body.kind === 'retention') {
      // The policy is the retention service's to read; this route only says
      // when to act on it.
      const policy = await this.retention.policy();
      return this.retention.apply(policy, body.dryRun !== false);
    }
    return this.storage.purge(body);
  }

  @Post('storage/vacuum')
  async vacuum(): Promise<{ ok: true }> {
    await this.storage.vacuum();
    return { ok: true };
  }

  @Get('retention')
  policy(): Promise<RetentionPolicyType> {
    return this.retention.policy();
  }

  /**
   * Saving returns what the policy would remove on its next run, so the
   * console can show the consequence of what was just saved rather than
   * leaving somebody to find out at four in the morning.
   */
  @Put('retention')
  async save(
    @Body(new ZodPipe(RetentionPolicy)) body: RetentionPolicyType,
  ): Promise<{ policy: RetentionPolicyType; preview: PurgeResult }> {
    const policy = await this.retention.save(body);
    return { policy, preview: await this.retention.apply(policy, true) };
  }

  /** What a policy would remove, without saving it. */
  @Post('retention/preview')
  preview(
    @Body(new ZodPipe(RetentionPolicy)) body: RetentionPolicyType,
  ): Promise<PurgeResult> {
    return this.retention.apply(body, true);
  }
}
