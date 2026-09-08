import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  isInlineType,
  SearchQuery,
  type Message,
  type SearchPage,
} from '@isthislegit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';

/**
 * Finding something that was said.
 *
 * Three decisions carry this file.
 *
 * **Permissions are resolved once, not per result.** The obvious shape is to
 * search everything and then ask `canInChannel` about each hit, which is a
 * query per row. Instead the caller's readable channels are worked out first
 * and become the `IN` list, so the database never considers a message this
 * person cannot read.
 *
 * **Deleted messages are excluded, and that is load-bearing.** Somebody
 * removed them on purpose. A search that returned them would be a way to read
 * everything a moderator has ever deleted.
 *
 * **The match runs as raw SQL and returns ids only.** Prisma has no tsvector
 * type, so the `@@` comparison cannot be expressed in `findMany`. Rather than
 * hand-building whole rows out of a raw query -- and keeping that shape in
 * step with the message DTO by hand forever -- the raw query does what only it
 * can do, and Prisma loads the rows it found.
 */
@Controller('api/search')
@UseGuards(AuthGuard)
export class SearchController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async search(
    @CurrentUser() user: SessionUser,
    @Query(new ZodPipe(SearchQuery)) query: SearchQuery,
  ): Promise<SearchPage> {
    const channels = await this.readableChannelIds(user.id, query.guildId);
    // Asked to search one channel: intersect rather than trust, so naming a
    // channel in a guild they are not in finds nothing rather than everything.
    const scope = query.channelId
      ? channels.filter((id) => id === query.channelId)
      : channels;
    if (scope.length === 0) return { results: [], nextCursor: null };

    const ids = await this.matchingIds(scope, query);
    if (ids.length === 0) return { results: [], nextCursor: null };

    const rows = await this.prisma.message.findMany({
      where: { id: { in: ids } },
      include: {
        author: { select: { id: true, username: true, name: true, image: true } },
        attachments: {
          select: {
            id: true,
            fileName: true,
            contentType: true,
            size: true,
            width: true,
            height: true,
            expiresAt: true,
            expiredAt: true,
          },
        },
        mentions: { select: { userId: true } },
      },
    });

    // `IN` does not preserve order, and the order is the answer here. Put them
    // back the way the ranked-by-id query returned them.
    const byId = new Map(rows.map((r) => [r.id, r]));
    const results = ids
      .map((id) => byId.get(id))
      .filter((r): r is NonNullable<typeof r> => Boolean(r))
      .map((r) => this.toDto(r));

    return {
      results,
      // Off `ids`, not `results`: a full page is a full page even if a message
      // was deleted between the two queries, and cutting the cursor there
      // would silently end the results early.
      nextCursor: ids.length === query.limit ? ids[ids.length - 1] : null,
    };
  }

  /**
   * The ids of matching messages, newest first.
   *
   * `websearch_to_tsquery` rather than `plainto_tsquery`, because it already
   * understands what people type into a search box: quoted phrases, `or`, and
   * a leading `-` to exclude. It also cannot throw on malformed input the way
   * `to_tsquery` does, which matters when the input is whatever somebody is
   * halfway through typing.
   *
   * `'simple'` has to match the configuration `searchVector` was generated
   * with, or the index cannot be used and the results are wrong. See the
   * migration for why it is `simple` and not `english`.
   *
   * Newest first, and paged by id rather than by relevance: chat search is a
   * chronological question, ranking would need a second sort key to page
   * stably, and ids are UUIDv7 so this is the same cursor idiom as history.
   */
  private async matchingIds(
    scope: string[],
    query: SearchQuery,
  ): Promise<string[]> {
    // Placeholders are built here, values are always passed as parameters --
    // nothing from the request is ever concatenated into the statement. The
    // channel list is expanded one placeholder at a time rather than passed as
    // an array, so this does not depend on how the driver maps a JS array on
    // to a Postgres one.
    const params: unknown[] = [];
    const placeholder = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };

    const channelList = scope.map(placeholder).join(', ');
    const clauses = [
      `"channelId" IN (${channelList})`,
      `"deletedAt" IS NULL`,
      `"searchVector" @@ websearch_to_tsquery('simple', ${placeholder(query.q)})`,
    ];
    if (query.authorId) {
      clauses.push(`"authorId" = ${placeholder(query.authorId)}`);
    }
    if (query.before) clauses.push(`"id" < ${placeholder(query.before)}`);

    const sql =
      `SELECT "id" FROM "Message" WHERE ${clauses.join(' AND ')} ` +
      `ORDER BY "id" DESC LIMIT ${placeholder(query.limit)}`;

    const hits = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
      sql,
      ...params,
    );
    return hits.map((h) => h.id);
  }

  /**
   * Every channel this person can read, as ids.
   *
   * Membership is the whole test, as everywhere else. Voice channels are left
   * out because they hold no messages to find.
   */
  private async readableChannelIds(
    userId: string,
    guildId?: string,
  ): Promise<string[]> {
    const rows = await this.prisma.channel.findMany({
      where: {
        kind: 'TEXT',
        ...(guildId ? { guildId } : {}),
        guild: { members: { some: { userId } } },
      },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * A result as the client's message renderer expects one.
   *
   * `deletedAt` and `clientNonce` are fixed rather than read: nothing deleted
   * reaches here, and a nonce is an echo to the sender of a message they just
   * sent, which a search result never is.
   */
  private toDto(row: any): Message {
    return {
      id: row.id,
      channelId: row.channelId,
      author: {
        id: row.author.id,
        username: row.author.username ?? row.author.id,
        displayName: row.author.name ?? null,
        image: row.author.image ?? null,
      },
      content: row.content,
      createdAt: row.createdAt.toISOString(),
      editedAt: row.editedAt ? row.editedAt.toISOString() : null,
      deletedAt: null,
      clientNonce: null,
      pinnedAt: row.pinnedAt ? row.pinnedAt.toISOString() : null,
      mentions: (row.mentions ?? []).map((m: any) => m.userId),
      attachments: (row.attachments ?? []).map((a: any) => ({
        id: a.id,
        fileName: a.fileName,
        contentType: a.contentType,
        size: a.size,
        width: a.width ?? null,
        height: a.height ?? null,
        url: `/api/attachments/${a.id}`,
        expiresAt: a.expiresAt ? a.expiresAt.toISOString() : null,
        expiredAt: a.expiredAt ? a.expiredAt.toISOString() : null,
        inline: isInlineType(a.contentType),
      })),
    };
  }
}
