import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Server-wide policy, keyed by name, stored as JSON in one table.
 *
 * Not `.env`: that file holds the secrets, it needs a restart to be reread,
 * and it is one of the three deployment files the console's Configuration tab
 * keeps in agreement. A retention policy is none of those things — it is
 * edited live, and it belongs inside the database backup.
 */
@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Read a setting, merged over its defaults.
   *
   * Merged rather than returned raw, because a stored row was written by an
   * older version of this server and will be missing any field added since.
   * Spreading the defaults first means a new knob arrives switched off instead
   * of arriving as `undefined` and being read as a deletion instruction.
   */
  async get<T extends object>(key: string, defaults: T): Promise<T> {
    const row = await this.prisma.serverSetting.findUnique({ where: { key } });
    if (!row || typeof row.value !== 'object' || row.value === null) return defaults;
    return { ...defaults, ...(row.value as Partial<T>) };
  }

  async set<T extends object>(key: string, value: T): Promise<T> {
    await this.prisma.serverSetting.upsert({
      where: { key },
      create: { key, value: value as never },
      update: { value: value as never },
    });
    return value;
  }
}
