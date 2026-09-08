import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { discardStored } from '../attachments/storage';

/**
 * Files that were only ever going to be here for a while.
 *
 * A non-image upload is given a deadline the moment it is accepted, and this
 * is what keeps that promise. Two things about where it sits are deliberate:
 *
 * **It is not part of the retention policy.** Retention is an operator's
 * decision about other people's messages, switched off until somebody turns it
 * on. This is not a policy at all -- it is the deal the uploader was shown at
 * the moment they sent the file, and the message on screen says when it runs
 * out. A promise that only happens if an administrator opted in is not one.
 *
 * **Hourly, not nightly.** Nightly makes "48 hours" mean anything from 48 to
 * 72 depending on what time of day the file was sent, and the client is
 * displaying a countdown.
 */
@Injectable()
export class EphemeralService {
  private readonly log = new Logger(EphemeralService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async sweep(): Promise<{ files: number; bytes: number }> {
    const due = await this.prisma.attachment.findMany({
      where: {
        expiresAt: { not: null, lte: new Date() },
        // Already dealt with on an earlier pass. The row stays forever, so
        // without this every expired file is reconsidered every hour for the
        // life of the server.
        expiredAt: null,
      },
      select: { id: true, storedName: true, size: true },
    });
    if (due.length === 0) return { files: 0, bytes: 0 };

    let files = 0;
    let bytes = 0;

    for (const row of due) {
      // The file first, then the row that says it is gone. That order is the
      // safe one here, and it is the opposite of the order used when deleting
      // messages: there, the row is the record and an orphaned file is
      // collectable waste. Here the row *is* the tombstone -- stamping it
      // before the delete lands would leave a message claiming a file expired
      // while the bytes sat on the disk with nothing left to collect them.
      await discardStored(row.storedName);
      await this.prisma.attachment.update({
        where: { id: row.id },
        data: { expiredAt: new Date() },
      });
      files += 1;
      bytes += row.size;
    }

    this.log.log(`expired ${files} file(s), ${bytes} bytes`);
    return { files, bytes };
  }
}
