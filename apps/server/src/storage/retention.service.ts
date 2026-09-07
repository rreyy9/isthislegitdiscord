import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  RETENTION_DEFAULTS,
  type PurgeResult,
  type RetentionPolicy,
} from '@isthislegit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { StorageService } from './storage.service';

/**
 * Age-based cleanup, so the disk does not fill.
 *
 * Set once on the server rather than per client, for the same reason the voice
 * bitrate is: it is a decision about shared storage. Everything defaults to
 * "keep", and `enabled` is false until somebody turns it on, because this is
 * the one feature whose whole job is to destroy data nobody has a second copy
 * of.
 */

export const RETENTION_KEY = 'retention';

const DAY_MS = 86_400_000;

@Injectable()
export class RetentionService {
  private readonly log = new Logger(RetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly storage: StorageService,
  ) {}

  policy(): Promise<RetentionPolicy> {
    return this.settings.get(RETENTION_KEY, RETENTION_DEFAULTS);
  }

  save(policy: RetentionPolicy): Promise<RetentionPolicy> {
    return this.settings.set(RETENTION_KEY, policy);
  }

  /**
   * Nightly, at a quiet hour.
   *
   * Reads the policy each time rather than caching it, so turning retention
   * off from the console takes effect without a restart.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async nightly(): Promise<void> {
    const policy = await this.policy();
    if (!policy.enabled) return;

    const result = await this.apply(policy, false);
    this.log.log(
      `retention removed ${result.messages} message(s), ${result.attachments} ` +
        `attachment(s), ${result.files} file(s), ${result.bytes} bytes`,
    );
  }

  /**
   * What the policy would do, or does.
   *
   * The dry run is the whole feature: it is the difference between an
   * irreversible setting and a reviewed one, so it runs the same selection
   * logic rather than an approximation of it.
   */
  async apply(policy: RetentionPolicy, dryRun: boolean): Promise<PurgeResult> {
    const messageIds = new Set<string>();
    const attachmentIds = new Set<string>();
    let bytes = 0;

    const cutoff = (days: number | null) =>
      days === null ? null : new Date(Date.now() - days * DAY_MS);

    /* ---------------------------------------------------------- messages */

    const messageCutoff = cutoff(policy.messagesMaxAgeDays);
    if (messageCutoff) {
      const rows = await this.prisma.message.findMany({
        where: { createdAt: { lt: messageCutoff } },
        select: { id: true },
      });
      for (const r of rows) messageIds.add(r.id);
    }

    const tombstoneCutoff = cutoff(policy.softDeletedMaxAgeDays);
    if (tombstoneCutoff) {
      const rows = await this.prisma.message.findMany({
        where: { deletedAt: { lt: tombstoneCutoff } },
        select: { id: true },
      });
      for (const r of rows) messageIds.add(r.id);
    }

    /* ------------------------------------------------------- attachments */

    // Attachments of a doomed message go by cascade, so they are counted here
    // but never deleted separately -- otherwise the same bytes are reported
    // twice and the preview overstates what will be freed.
    if (messageIds.size) {
      const rows = await this.prisma.attachment.findMany({
        where: { messageId: { in: [...messageIds] } },
        select: { id: true, size: true },
      });
      for (const r of rows) {
        attachmentIds.add(r.id);
        bytes += r.size;
      }
    }

    const attachmentCutoff = cutoff(policy.attachmentsMaxAgeDays);
    if (attachmentCutoff) {
      // Media is nearly all of the bytes, so it expires on its own clock. The
      // message survives with its text; only the image goes.
      const rows = await this.prisma.attachment.findMany({
        where: { createdAt: { lt: attachmentCutoff } },
        select: { id: true, size: true },
      });
      for (const r of rows) {
        if (attachmentIds.has(r.id)) continue;
        attachmentIds.add(r.id);
        bytes += r.size;
      }
    }

    /* ------------------------------------------------------------- a cap */

    if (policy.uploadsMaxTotalBytes !== null) {
      const survivors = await this.prisma.attachment.findMany({
        where: { id: { notIn: [...attachmentIds] } },
        select: { id: true, size: true },
        orderBy: { id: 'asc' },
      });
      // Ids are UUIDv7, so ascending id is oldest first with no date column
      // to read. Evict until what remains fits under the cap.
      let total = survivors.reduce((n, a) => n + a.size, 0);
      for (const a of survivors) {
        if (total <= policy.uploadsMaxTotalBytes) break;
        attachmentIds.add(a.id);
        bytes += a.size;
        total -= a.size;
      }
    }

    if (dryRun) {
      return {
        kind: 'retention',
        dryRun: true,
        messages: messageIds.size,
        attachments: attachmentIds.size,
        files: 0,
        bytes,
      };
    }

    /* ------------------------------------------------------------ delete */

    // Rows first, committed, and only then the files. A crash in that order
    // wastes bytes the next sweep collects; the reverse leaves a row pointing
    // at a file that is gone, which no sweep repairs.
    const standalone = [...attachmentIds];
    let attachments = 0;
    for (let i = 0; i < standalone.length; i += 500) {
      const res = await this.prisma.attachment.deleteMany({
        where: { id: { in: standalone.slice(i, i + 500) } },
      });
      attachments += res.count;
      await new Promise((r) => setTimeout(r, 25));
    }

    const ids = [...messageIds];
    let messages = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const res = await this.prisma.message.deleteMany({
        where: { id: { in: ids.slice(i, i + 500) } },
      });
      messages += res.count;
      await new Promise((r) => setTimeout(r, 25));
    }

    const swept = await this.storage.sweepOrphanFiles(false);

    return {
      kind: 'retention',
      dryRun: false,
      messages,
      attachments,
      files: swept.files,
      bytes: swept.bytes || bytes,
    };
  }
}
