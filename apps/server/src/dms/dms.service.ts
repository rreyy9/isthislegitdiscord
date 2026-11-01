import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  MAX_GROUP_DM,
  type DirectMessage,
  type DmDevice,
  type Message,
  type RegisterDeviceInput,
} from '@isthislegit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { dmKeyOf, PermissionService } from '../auth/permission.guard';
import { ChatGateway } from '../gateway/chat.gateway';
import { newId } from '../common/ids';

const userSelect = {
  select: { id: true, username: true, name: true, image: true },
} as const;

/**
 * Direct messages: finding them, opening them, groups, the key directory, and
 * telling the people in one that something happened.
 *
 * Everything that is the same as a channel -- history, sending, reactions,
 * pins, read state -- is the channel routes, because a DM is a channel. This
 * holds only what a channel does not have: a list of people, and a row in
 * each of their sidebars.
 */
@Injectable()
export class DmsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly gateway: ChatGateway,
  ) {}

  /** Who is in this DM, or null when it is a guild channel. */
  async participantsOf(channelId: string): Promise<string[] | null> {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { guildId: true, participants: { select: { userId: true } } },
    });
    if (!channel || channel.guildId !== null) return null;
    return channel.participants.map((p) => p.userId);
  }

  /**
   * Every DM this person has not closed, newest conversation first.
   *
   * One summary per conversation, each a few small queries. That is a lot of
   * round trips for a big server and nothing at all for this one.
   */
  async list(userId: string): Promise<DirectMessage[]> {
    const rows = await this.prisma.channelParticipant.findMany({
      where: { userId, hiddenAt: null },
      select: { channelId: true },
    });
    const dms = await Promise.all(rows.map((r) => this.summary(r.channelId, userId)));
    return dms
      .filter((d): d is DirectMessage => d !== null)
      .sort((a, b) => order(b).localeCompare(order(a)));
  }

  /**
   * Start a conversation. One other person opens your DM with them, creating
   * it the first time; more than one starts a new group.
   *
   * Only with people you share a guild with, and a 404 for anyone else -- the
   * same answer the member card gives -- so this cannot be used to find out
   * whether an account exists.
   *
   * A one-to-one DM being opened is not news to the other person: their row
   * appears with the first message. Being put in a group is, so a new group
   * appears for everybody in it straight away.
   */
  async open(userId: string, otherIds: string[], name?: string): Promise<DirectMessage> {
    const others = [...new Set(otherIds)].filter((id) => id !== userId);
    if (others.length === 0) throw new NotFoundException('No such member.');
    await this.assertReachable(userId, others);

    if (others.length === 1) {
      const channelId = await this.findOrCreateDirect(userId, others[0]);
      await this.prisma.channelParticipant.updateMany({
        where: { channelId, userId },
        data: { hiddenAt: null },
      });
      return this.tellOnly(channelId, [userId], userId);
    }

    if (others.length + 1 > MAX_GROUP_DM) {
      throw new BadRequestException(`A group can have at most ${MAX_GROUP_DM} people.`);
    }
    const channel = await this.prisma.channel.create({
      data: {
        id: newId(),
        guildId: null,
        name: name ?? '',
        kind: 'TEXT',
        participants: {
          create: [userId, ...others].map((id) => ({ id: newId(), userId: id })),
        },
      },
      select: { id: true },
    });
    return this.tellOnly(channel.id, [userId, ...others], userId);
  }

  /** Bring more people into a group. Anybody in it who can still write may. */
  async addMembers(userId: string, channelId: string, ids: string[]): Promise<DirectMessage> {
    const group = await this.groupFor(userId, channelId);
    if (!(await this.permissions.canInDm(userId, channelId, 'channel.write'))) {
      throw new ForbiddenException('You can no longer add people to this group.');
    }
    const present = new Set(group.participants.map((p) => p.userId));
    const fresh = [...new Set(ids)].filter((id) => !present.has(id));
    if (fresh.length === 0) return this.tellOnly(channelId, [userId], userId);
    await this.assertReachable(userId, fresh);
    if (present.size + fresh.length > MAX_GROUP_DM) {
      throw new BadRequestException(`A group can have at most ${MAX_GROUP_DM} people.`);
    }

    await this.prisma.channelParticipant.createMany({
      data: fresh.map((id) => ({ id: newId(), channelId, userId: id })),
      skipDuplicates: true,
    });
    return this.tellOnly(channelId, [...present, ...fresh], userId);
  }

  async rename(userId: string, channelId: string, name: string): Promise<DirectMessage> {
    const group = await this.groupFor(userId, channelId);
    await this.prisma.channel.update({ where: { id: channelId }, data: { name } });
    return this.tellOnly(channelId, group.participants.map((p) => p.userId), userId);
  }

  /**
   * Leave a group. The row goes, so nothing new is sealed to you and the
   * conversation leaves your sidebar for good; the last one out takes the
   * group with them.
   */
  async leave(userId: string, channelId: string): Promise<void> {
    const group = await this.groupFor(userId, channelId);
    await this.prisma.channelParticipant.deleteMany({ where: { channelId, userId } });
    const rest = group.participants.map((p) => p.userId).filter((id) => id !== userId);
    if (rest.length === 0) {
      await this.prisma.channel.delete({ where: { id: channelId } });
      return;
    }
    for (const id of rest) {
      const dm = await this.summary(channelId, id);
      if (dm) this.gateway.notifyDm(id, { dm, message: null });
    }
  }

  /** Take it out of the sidebar until the next message in it. */
  async hide(userId: string, channelId: string): Promise<void> {
    const { count } = await this.prisma.channelParticipant.updateMany({
      where: { channelId, userId },
      data: { hiddenAt: new Date() },
    });
    if (count === 0) throw new NotFoundException('No such conversation.');
  }

  /**
   * A message was posted in a DM: bring the row back for anybody who had
   * closed it, and tell every participant, each with their own view of it.
   */
  async announce(message: Message, participants: string[]): Promise<void> {
    await this.prisma.channelParticipant.updateMany({
      where: { channelId: message.channelId, hiddenAt: { not: null } },
      data: { hiddenAt: null },
    });
    for (const userId of participants) {
      const dm = await this.summary(message.channelId, userId);
      if (dm) this.gateway.notifyDm(userId, { dm, message });
    }
  }

  /* --------------------------------------------------------------- keys */

  /**
   * Record a device's public keys.
   *
   * Never changes a key that is already registered. A device that makes new
   * keys picks a new id; one asking to swap the keys under an old id is either
   * confused or somebody else, and either way the clients that pinned the old
   * keys would refuse the new ones.
   */
  async registerDevice(userId: string, deviceId: string, keys: RegisterDeviceInput) {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(deviceId)) {
      throw new BadRequestException('That is not a device id.');
    }
    const existing = await this.prisma.deviceKey.findUnique({ where: { id: deviceId } });
    if (existing) {
      if (
        existing.userId !== userId ||
        existing.encryptionKey !== keys.encryptionKey ||
        existing.signingKey !== keys.signingKey
      ) {
        throw new ConflictException('That device id is already registered with other keys.');
      }
      return { ok: true };
    }
    await this.prisma.deviceKey.create({
      data: { id: deviceId, userId, ...keys },
    });
    return { ok: true };
  }

  /**
   * Every device of everybody in this DM: what to seal a message to, and what
   * to check a signature against.
   */
  async devices(userId: string, channelId: string): Promise<DmDevice[]> {
    if (!(await this.permissions.canInDm(userId, channelId, 'channel.read'))) {
      throw new NotFoundException('No such conversation.');
    }
    const participants = (await this.participantsOf(channelId)) ?? [];
    const recipients = new Set<string>();
    for (const id of participants) {
      if (await this.permissions.sharesGuild(userId, id)) recipients.add(id);
    }
    const rows = await this.prisma.deviceKey.findMany({
      where: { userId: { in: participants } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      userId: r.userId,
      deviceId: r.id,
      encryptionKey: r.encryptionKey,
      signingKey: r.signingKey,
      recipient: recipients.has(r.userId),
    }));
  }

  /* ------------------------------------------------------------ helpers */

  /** Everybody here must share a guild with the asker, or it is a 404. */
  private async assertReachable(userId: string, ids: string[]) {
    for (const id of ids) {
      if (!(await this.permissions.sharesGuild(userId, id))) {
        throw new NotFoundException('No such member.');
      }
    }
  }

  /** A group this person is in, or a 404 -- never a one-to-one DM. */
  private async groupFor(userId: string, channelId: string) {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: {
        guildId: true,
        dmKey: true,
        participants: { select: { userId: true } },
      },
    });
    if (
      !channel ||
      channel.guildId !== null ||
      !channel.participants.some((p) => p.userId === userId)
    ) {
      throw new NotFoundException('No such conversation.');
    }
    if (channel.dmKey !== null) {
      throw new BadRequestException('That is a conversation between two people, not a group.');
    }
    return channel;
  }

  /**
   * Tell these people the conversation changed, and hand back the asker's
   * view of it. Their other windows hear it too, through their `user:` room.
   */
  private async tellOnly(channelId: string, who: string[], asker: string) {
    let mine: DirectMessage | null = null;
    for (const id of who) {
      const dm = await this.summary(channelId, id);
      if (!dm) continue;
      if (id === asker) mine = dm;
      this.gateway.notifyDm(id, { dm, message: null });
    }
    if (!mine) throw new NotFoundException('No such conversation.');
    return mine;
  }

  /**
   * The unique `dmKey` is what makes this safe to race. Two requests that
   * both miss the lookup both try to create, one of them loses on the
   * constraint, and that one reads back the winner's row.
   */
  private async findOrCreateDirect(a: string, b: string): Promise<string> {
    const dmKey = dmKeyOf(a, b);
    const existing = await this.prisma.channel.findUnique({
      where: { dmKey },
      select: { id: true },
    });
    if (existing) return existing.id;

    try {
      const created = await this.prisma.channel.create({
        data: {
          id: newId(),
          guildId: null,
          // Never drawn: a DM is shown as the person on the other end.
          name: '',
          kind: 'TEXT',
          dmKey,
          participants: {
            create: [a, b].map((userId) => ({ id: newId(), userId })),
          },
        },
        select: { id: true },
      });
      return created.id;
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err;
      const winner = await this.prisma.channel.findUnique({
        where: { dmKey },
        select: { id: true },
      });
      if (!winner) throw err;
      return winner.id;
    }
  }

  /** One conversation as `userId` sees it, or null if they are not in it. */
  private async summary(channelId: string, userId: string): Promise<DirectMessage | null> {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: {
        guildId: true,
        dmKey: true,
        name: true,
        participants: {
          select: { userId: true, user: userSelect },
          orderBy: { joinedAt: 'asc' },
        },
      },
    });
    if (!channel || channel.guildId !== null) return null;
    if (!channel.participants.some((p) => p.userId === userId)) return null;
    const others = channel.participants.filter((p) => p.userId !== userId);
    const direct = channel.dmKey !== null;
    // The other account was deleted, which cascades their participant row.
    // Nothing is left to talk to or to draw the conversation as.
    if (direct && others.length === 0) return null;

    const [last, read] = await Promise.all([
      this.prisma.message.findFirst({
        where: { channelId, deletedAt: null },
        orderBy: { id: 'desc' },
        select: { id: true },
      }),
      this.prisma.channelReadState.findUnique({
        where: { userId_channelId: { userId, channelId } },
        select: { lastReadMessageId: true },
      }),
    ]);

    const unread = await this.prisma.message.count({
      where: {
        channelId,
        deletedAt: null,
        // Your own messages are never waiting for you.
        authorId: { not: userId },
        id: { gt: read?.lastReadMessageId ?? '' },
      },
    });

    const departedIds: string[] = [];
    for (const p of others) {
      if (!(await this.permissions.sharesGuild(userId, p.userId))) {
        departedIds.push(p.userId);
      }
    }

    return {
      channelId,
      kind: direct ? 'direct' : 'group',
      name: direct ? null : channel.name || null,
      users: others.map((p) => ({
        id: p.user.id,
        username: p.user.username ?? p.user.id,
        displayName: p.user.name ?? null,
        image: p.user.image ?? null,
      })),
      departedIds,
      lastMessageId: last?.id ?? null,
      unread,
      canSend: others.length > departedIds.length,
    };
  }
}

/**
 * What a conversation sorts by: its newest message, or when it was opened if
 * nothing has been said yet. Both are UUIDv7, so both sort by time.
 */
function order(dm: DirectMessage): string {
  return dm.lastMessageId ?? dm.channelId;
}
