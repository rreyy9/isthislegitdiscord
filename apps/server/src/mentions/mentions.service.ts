import { Injectable } from '@nestjs/common';
import { parseMentionIds, type ChannelMentions } from '@isthislegit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { newId } from '../common/ids';

/**
 * Who a message tags, and who still has not seen that they were tagged.
 *
 * Message text carries `<@userId>` markers; this is the one place that turns
 * them into people. Two rules hold everywhere:
 *
 * - An id in the text is a claim, not a fact. Anyone can type angle brackets,
 *   so every id is checked against the guild before it is stored or notified.
 *   A marker naming somebody who is not in the guild is left in the text and
 *   simply tags nobody — the client will not find a name for it and draws it
 *   as plain text.
 * - Tagging yourself is not a tag. The name still renders, because that is
 *   what you typed, but nothing is stored and nothing is sent: there is
 *   nothing unread about a message you wrote a second ago.
 */
@Injectable()
export class MentionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The ids in `content` that name a real member of the channel's guild.
   *
   * Returned in the order they were typed, which is the order the client will
   * draw them in and the order a "you and two others" summary would read.
   */
  async resolve(channelId: string, content: string): Promise<string[]> {
    const claimed = parseMentionIds(content);
    if (claimed.length === 0) return [];

    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { guildId: true },
    });
    if (!channel) return [];

    const members = await this.prisma.guildMember.findMany({
      where: { guildId: channel.guildId, userId: { in: claimed } },
      select: { userId: true },
    });

    const real = new Set(members.map((m) => m.userId));
    return claimed.filter((id) => real.has(id));
  }

  /**
   * Make the stored tags match the text, and say who is newly tagged.
   *
   * Written as delete-then-insert rather than a diff because an edit is rare
   * and a message tags two or three people at most; the unique constraint on
   * (messageId, userId) is what makes that safe to repeat.
   *
   * `pinged` is everyone the message tags; `newlyPinged` is only those who
   * were not tagged by it a moment ago, so fixing a typo in a message does not
   * ping everybody in it a second time.
   */
  async sync(
    messageId: string,
    channelId: string,
    content: string,
    authorId: string,
  ): Promise<{ pinged: string[]; newlyPinged: string[] }> {
    // Your own name in your own message is not something you need telling.
    const pingable = (await this.resolve(channelId, content)).filter(
      (id) => id !== authorId,
    );

    const before = new Set(
      (
        await this.prisma.messageMention.findMany({
          where: { messageId },
          select: { userId: true },
        })
      ).map((r) => r.userId),
    );

    const wanted = new Set(pingable);
    const gone = [...before].filter((id) => !wanted.has(id));

    if (gone.length > 0) {
      await this.prisma.messageMention.deleteMany({
        where: { messageId, userId: { in: gone } },
      });
    }
    const added = pingable.filter((id) => !before.has(id));
    if (added.length > 0) {
      await this.prisma.messageMention.createMany({
        data: added.map((userId) => ({
          id: newId(),
          messageId,
          channelId,
          userId,
        })),
        // Two clients editing the same message at once would otherwise race on
        // the unique constraint and turn an edit into a 500.
        skipDuplicates: true,
      });
    }

    return { pinged: pingable, newlyPinged: added };
  }

  /**
   * Unread tags per channel, for the badges in the sidebar.
   *
   * "Unread" is `messageId > lastReadMessageId` and nothing else: ids are
   * UUIDv7, so id order is time order and no timestamp is involved. Channels
   * the user has never opened have no read row at all, which is why the
   * comparison there is against the empty string — every id sorts above it.
   *
   * Only channels with something in them come back; a channel with no unread
   * tags is absent rather than present with a zero.
   */
  async unreadCounts(userId: string): Promise<ChannelMentions[]> {
    const guildIds = (
      await this.prisma.guildMember.findMany({
        where: { userId },
        select: { guildId: true },
      })
    ).map((m) => m.guildId);
    if (guildIds.length === 0) return [];

    const channels = await this.prisma.channel.findMany({
      where: { guildId: { in: guildIds }, kind: 'TEXT' },
      select: { id: true },
    });
    if (channels.length === 0) return [];

    const reads = new Map(
      (
        await this.prisma.channelReadState.findMany({
          where: { userId, channelId: { in: channels.map((c) => c.id) } },
          select: { channelId: true, lastReadMessageId: true },
        })
      ).map((r) => [r.channelId, r.lastReadMessageId ?? '']),
    );

    const rows = await this.prisma.messageMention.groupBy({
      by: ['channelId'],
      where: {
        userId,
        // A message an admin deleted takes its ping with it. The row survives
        // for the audit trail; the badge must not.
        message: { deletedAt: null },
        OR: channels.map((c) => ({
          channelId: c.id,
          messageId: { gt: reads.get(c.id) ?? '' },
        })),
      },
      _count: { _all: true },
    });

    return rows.map((r) => ({ channelId: r.channelId, count: r._count._all }));
  }
}
