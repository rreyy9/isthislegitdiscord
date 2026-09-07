import { Injectable, Logger } from '@nestjs/common';
import { readdir, stat, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { PurgeInput, PurgeResult, StorageReport } from '@isthislegit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { UPLOAD_DIR } from '../attachments/storage';

/**
 * What is on the disk, and how to get some of it back.
 *
 * Uploads are 26 MB a file, uncapped, on the same volume as PostgreSQL, so the
 * first sign of trouble would otherwise be the database refusing writes. This
 * counts before it deletes, and every deletion here is asked for by a person.
 */

/**
 * A file is written before the row that points at it exists, so a sweep in
 * that window would delete a live upload and leave the message showing a
 * broken image. Anything younger than this is left alone; an orphan is still
 * an orphan an hour later.
 */
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

/** The disk walk is stable enough that a page refresh need not redo it. */
const WALK_CACHE_MS = 60 * 1000;

interface DiskFile {
  name: string;
  size: number;
  mtimeMs: number;
}

/** int8 comes back from Postgres as BigInt, which JSON.stringify refuses. */
const num = (v: unknown): number => Number(v ?? 0);

@Injectable()
export class StorageService {
  private readonly log = new Logger(StorageService.name);
  private walkCache: { at: number; files: DiskFile[] } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /* ------------------------------------------------------------- reading */

  private async walk(force = false): Promise<DiskFile[]> {
    if (!force && this.walkCache && Date.now() - this.walkCache.at < WALK_CACHE_MS) {
      return this.walkCache.files;
    }

    let entries: string[] = [];
    try {
      entries = await readdir(UPLOAD_DIR);
    } catch {
      // No upload directory yet is an empty one, not an error.
      this.walkCache = { at: Date.now(), files: [] };
      return [];
    }

    const files: DiskFile[] = [];
    for (const name of entries) {
      try {
        const st = await stat(path.join(UPLOAD_DIR, name));
        if (st.isFile()) files.push({ name, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // Vanished between the listing and the stat. Nothing to count.
      }
    }

    this.walkCache = { at: Date.now(), files };
    return files;
  }

  private async tableSizes() {
    // Exact counts, not `reltuples` or `n_live_tup`.
    //
    // Both of those are estimates maintained by ANALYZE, and on a small quiet
    // database ANALYZE may simply not have run -- which reports 0 accounts on
    // a server with ten of them. A wrong number in an operator console is
    // worse than a slow one, and `count(*)` across fourteen small tables here
    // costs milliseconds.
    //
    // query_to_xml is the way to run one count per table without a round trip
    // each: it evaluates a query built per row and hands the result back as a
    // value. The table name goes through %I, so it is quoted by Postgres and
    // never concatenated.
    const rows = await this.prisma.$queryRaw<
      { table: string; rows: bigint; totalBytes: bigint; indexBytes: bigint }[]
    >`
      SELECT c.relname::text                       AS "table",
             (xpath(
               '/row/c/text()',
               query_to_xml(
                 format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname),
                 false, true, ''
               )
             ))[1]::text::bigint                   AS "rows",
             pg_total_relation_size(c.oid)::bigint AS "totalBytes",
             pg_indexes_size(c.oid)::bigint        AS "indexBytes"
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind = 'r'
       ORDER BY pg_total_relation_size(c.oid) DESC
    `;
    return rows.map((r) => ({
      table: r.table,
      rows: num(r.rows),
      totalBytes: num(r.totalBytes),
      indexBytes: num(r.indexBytes),
    }));
  }

  async report(): Promise<StorageReport> {
    const [dbRows, tables, files, attachments, tombstones] = await Promise.all([
      this.prisma.$queryRaw<{ bytes: bigint }[]>`
        SELECT pg_database_size(current_database())::bigint AS bytes
      `,
      this.tableSizes(),
      this.walk(),
      this.prisma.attachment.findMany({ select: { storedName: true, size: true } }),
      this.tombstoneTotals(),
    ]);

    const onDisk = new Map(files.map((f) => [f.name, f]));
    const known = new Set(attachments.map((a) => a.storedName));

    const rowsWithoutFile = attachments.filter((a) => !onDisk.has(a.storedName)).length;
    const strays = files.filter((f) => !known.has(f.name));

    // statfs is available on Windows under Node 22, so there is no shelling
    // out to wmic. If it fails the page still renders without the figure.
    let disk: StorageReport['disk'] = null;
    try {
      const fsStat = await statfs(UPLOAD_DIR);
      disk = {
        freeBytes: Number(fsStat.bavail) * Number(fsStat.bsize),
        totalBytes: Number(fsStat.blocks) * Number(fsStat.bsize),
      };
    } catch {
      disk = null;
    }

    return {
      database: { bytes: num(dbRows[0]?.bytes), tables },
      uploads: {
        files: files.length,
        bytes: files.reduce((n, f) => n + f.size, 0),
        directory: UPLOAD_DIR,
      },
      disk,
      orphans: {
        rowsWithoutFile,
        filesWithoutRow: strays.length,
        bytesWithoutRow: strays.reduce((n, f) => n + f.size, 0),
      },
      tombstones,
    };
  }

  /** Soft-deleted messages: the row and its files outlive the deletion. */
  private async tombstoneTotals() {
    const [messages, agg] = await Promise.all([
      this.prisma.message.count({ where: { NOT: { deletedAt: null } } }),
      this.prisma.attachment.aggregate({
        where: { message: { NOT: { deletedAt: null } } },
        _count: { _all: true },
        _sum: { size: true },
      }),
    ]);
    return {
      messages,
      attachments: agg._count._all,
      bytes: agg._sum.size ?? 0,
    };
  }

  /* ------------------------------------------------------------ deleting */

  /**
   * Delete every file no row points at, skipping anything written recently.
   *
   * Always called *after* the rows have been deleted and committed, never
   * before. A crash in that order leaves wasted bytes for the next sweep. The
   * reverse leaves a row pointing at a file that is gone, which is a
   * permanently broken image and nothing repairs it.
   */
  async sweepOrphanFiles(dryRun: boolean): Promise<{ files: number; bytes: number }> {
    const [files, attachments] = await Promise.all([
      this.walk(true),
      this.prisma.attachment.findMany({ select: { storedName: true } }),
    ]);
    const known = new Set(attachments.map((a) => a.storedName));
    const cutoff = Date.now() - ORPHAN_GRACE_MS;

    let count = 0;
    let bytes = 0;
    for (const f of files) {
      if (known.has(f.name) || f.mtimeMs > cutoff) continue;
      count += 1;
      bytes += f.size;
      if (!dryRun) {
        await unlink(path.join(UPLOAD_DIR, f.name)).catch(() => undefined);
      }
    }

    if (!dryRun && count) {
      this.walkCache = null;
      this.log.log(`swept ${count} orphaned file(s), ${bytes} bytes`);
    }
    return { files: count, bytes };
  }

  /**
   * Hard-delete messages by id, in batches.
   *
   * Batched because a home box should not spend the night holding a lock on
   * `message`, and because Postgres builds the whole delete plan in one go
   * otherwise. Attachment rows go with them by cascade; their files are swept
   * afterwards by the caller.
   */
  private async deleteMessages(ids: string[]): Promise<number> {
    let done = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const batch = ids.slice(i, i + 500);
      const res = await this.prisma.message.deleteMany({ where: { id: { in: batch } } });
      done += res.count;
      // Let other queries through between batches.
      await new Promise((r) => setTimeout(r, 25));
    }
    return done;
  }

  async purge(input: PurgeInput): Promise<PurgeResult> {
    const dryRun = input.dryRun !== false;
    const empty = { messages: 0, attachments: 0, files: 0, bytes: 0 };

    switch (input.kind) {
      case 'orphaned-files': {
        const swept = await this.sweepOrphanFiles(dryRun);
        return { kind: input.kind, dryRun, ...empty, ...swept };
      }

      case 'orphaned-rows': {
        // A row whose file is already gone. The image is unrecoverable either
        // way; removing the row stops the client asking for it forever.
        const rows = await this.prisma.attachment.findMany({
          select: { id: true, storedName: true },
        });
        const onDisk = new Set((await this.walk(true)).map((f) => f.name));
        const dead = rows.filter((r) => !onDisk.has(r.storedName));
        if (!dryRun && dead.length) {
          await this.prisma.attachment.deleteMany({
            where: { id: { in: dead.map((d) => d.id) } },
          });
        }
        return { kind: input.kind, dryRun, ...empty, attachments: dead.length };
      }

      case 'tombstones': {
        const days = input.olderThanDays ?? null;
        const where = {
          NOT: { deletedAt: null },
          ...(days === null
            ? {}
            : { deletedAt: { lt: new Date(Date.now() - days * 86_400_000) } }),
        };
        const doomed = await this.prisma.message.findMany({
          where,
          select: { id: true },
        });
        const agg = await this.prisma.attachment.aggregate({
          where: { messageId: { in: doomed.map((d) => d.id) } },
          _count: { _all: true },
          _sum: { size: true },
        });

        if (dryRun) {
          return {
            kind: input.kind,
            dryRun,
            messages: doomed.length,
            attachments: agg._count._all,
            files: 0,
            bytes: agg._sum.size ?? 0,
          };
        }

        const messages = await this.deleteMessages(doomed.map((d) => d.id));
        const swept = await this.sweepOrphanFiles(false);
        return {
          kind: input.kind,
          dryRun,
          messages,
          attachments: agg._count._all,
          ...swept,
        };
      }

      default:
        // 'retention' is applied by RetentionService, which owns the policy.
        return { kind: input.kind, dryRun, ...empty };
    }
  }

  /** Reclaim space inside the tables themselves after a large delete. */
  async vacuum(): Promise<void> {
    // Plain, never FULL: VACUUM FULL takes an exclusive lock on every table it
    // touches, which belongs in a maintenance window and not behind a button.
    await this.prisma.$executeRawUnsafe('VACUUM ANALYZE');
  }

  /** Called after any delete that did not go through the walk cache. */
  invalidate(): void {
    this.walkCache = null;
  }
}
