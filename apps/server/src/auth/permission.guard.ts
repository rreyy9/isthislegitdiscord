import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type Action =
  | 'channel.read'
  | 'channel.write'
  | 'channel.manage'
  | 'voice.join'
  /**
   * Starting or joining a watch party.
   *
   * Its own name rather than `voice.join`, for the reason `message.react`
   * is not `channel.write`: the two are indistinguishable today -- both are
   * plain membership -- and the moment somebody wants a server where people
   * may sit in voice but not start a party, that is a real question with a
   * real answer, and a name is what lets it be answered in one line.
   *
   * Deliberately not admin-only. A channel is the server's furniture; a
   * party is an evening, and anybody may have one.
   */
  | 'party.join'
  | 'message.moderate'
  | 'message.pin'
  /**
   * Adding and removing your own reaction.
   *
   * Its own name rather than riding on `channel.write`, and the two are
   * indistinguishable today -- both are plain membership. That is the point:
   * the moment there is a channel people may read and not post in, "can they
   * still react" is a real question with a real answer (Discord's is yes), and
   * a name is what lets it be answered in one line instead of by unpicking
   * which of `channel.write`'s callers meant which thing.
   *
   * Exactly the argument `message.pin` won against `message.moderate`.
   */
  | 'message.react'
  | 'member.moderate'
  | 'member.kick'
  | 'member.role'
  | 'invite.create';

/** Needs the ADMIN role in the guild, not merely membership. */
const ADMIN_ONLY: ReadonlySet<Action> = new Set<Action>([
  'channel.manage',
  'message.moderate',
  // Pinning is its own action rather than part of moderating, because it is
  // the opposite of one: moderation takes a message away, a pin puts it in
  // front of everybody. Separate names are what let the two rules move apart
  // later -- letting members pin is a plausible setting, letting them delete
  // each other's messages is not.
  'message.pin',
  'member.moderate',
  'member.kick',
  'member.role',
  'invite.create',
]);

/**
 * What a participant may do in a direct message. Everything else is refused,
 * whoever asks -- including a guild admin.
 *
 * Moderation is missing on purpose. A DM is not the server's furniture the way
 * a channel is, and an admin who could delete or read messages in other
 * people's conversations would make "private" a word on a label. What an admin
 * can still do is remove somebody from the guild, which ends their ability to
 * send (see `WRITE_IN_DM`) without touching the history.
 *
 * Pinning is in, for the other reason `message.pin` is its own name: in a
 * channel it puts something in front of everybody, and in a DM "everybody" is
 * the two people already in it.
 */
const DM_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'channel.read',
  'channel.write',
  'message.react',
  'message.pin',
]);

/**
 * The DM actions that need the two people to still share a guild. Reading
 * does not: somebody who was kicked keeps the history of what was said to
 * them, and so does the person who is still here.
 */
const WRITE_IN_DM: ReadonlySet<Action> = new Set<Action>([
  'channel.write',
  'message.react',
  'message.pin',
]);

/** The key that makes a one-to-one DM unique: both ids, in a fixed order. */
export function dmKeyOf(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * No action is denied by a mute, and that is the rule rather than an omission.
 *
 * A mute takes away the microphone and nothing else — see `MuteMemberInput` in
 * the shared package. It used to be listed here as denying `channel.write` and
 * `voice.join`, which meant a muted person was thrown out of the call, refused
 * entry back, and unable to type: three punishments delivered under one name,
 * none of which anybody asks for when they say "mute them". Voice enforces the
 * real one where it belongs, on the LiveKit participant, so there is nothing
 * left for this table to say.
 *
 * The mute state is still read here, via `mutedUntilInGuild` and
 * `mutedUntilInChannel`, because voice needs to know it at join time.
 */

export interface Membership {
  role: 'ADMIN' | 'MEMBER';
  mutedUntil: Date | null;
}

/** A mute in the past has already lifted; nothing has to go and clear it. */
export function isMuted(member: Membership | null): boolean {
  return Boolean(member?.mutedUntil && member.mutedUntil > new Date());
}

/**
 * The permission seam. Every route asks here rather than checking roles
 * inline, so a rule change is one edit in one file.
 */
@Injectable()
export class PermissionService {
  constructor(private readonly prisma: PrismaService) {}

  async membership(userId: string, guildId: string): Promise<Membership | null> {
    const member = await this.prisma.guildMember.findUnique({
      where: { guildId_userId: { guildId, userId } },
      select: { role: true, mutedUntil: true },
    });
    return member ?? null;
  }

  async canInGuild(userId: string, guildId: string, action: Action) {
    const member = await this.membership(userId, guildId);
    if (!member) return false;
    if (ADMIN_ONLY.has(action) && member.role !== 'ADMIN') return false;
    return true;
  }

  async canInChannel(userId: string, channelId: string, action: Action) {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { guildId: true },
    });
    if (!channel) return false;
    // No guild means a DM. Answered by its own rules rather than falling
    // through, though falling through would also refuse: `canInGuild` finds no
    // membership in a guild that is not there.
    if (channel.guildId === null) return this.canInDm(userId, channelId, action);
    return this.canInGuild(userId, channel.guildId, action);
  }

  /**
   * Participant or nothing, and only the actions a DM has.
   *
   * Writing also needs somebody to write to. In a one-to-one DM that is the
   * other person still sharing a guild with you; in a group it is at least one
   * of the others. Without it, being kicked would leave a back door into the
   * inbox of everybody you had ever messaged.
   */
  async canInDm(userId: string, channelId: string, action: Action) {
    if (!DM_ACTIONS.has(action)) return false;
    const participants = await this.prisma.channelParticipant.findMany({
      where: { channelId },
      select: { userId: true },
    });
    if (!participants.some((p) => p.userId === userId)) return false;
    if (!WRITE_IN_DM.has(action)) return true;

    const others = participants.map((p) => p.userId).filter((id) => id !== userId);
    for (const other of others) {
      if (await this.sharesGuild(userId, other)) return true;
    }
    return false;
  }

  /** Whether two people are both members of at least one guild. */
  async sharesGuild(a: string, b: string): Promise<boolean> {
    if (a === b) return true;
    const shared = await this.prisma.guildMember.findFirst({
      where: { userId: a, guild: { members: { some: { userId: b } } } },
      select: { id: true },
    });
    return shared !== null;
  }

  /**
   * When this person's microphone comes back, or null if it was never taken.
   *
   * A date rather than a boolean because the two callers both want to say so:
   * the voice token puts it in front of the person it applies to, and the
   * sweep that keeps LiveKit in step compares it against the clock.
   */
  async mutedUntilInGuild(userId: string, guildId: string): Promise<Date | null> {
    const member = await this.membership(userId, guildId);
    return isMuted(member) ? member!.mutedUntil : null;
  }

  async mutedUntilInChannel(userId: string, channelId: string): Promise<Date | null> {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { guildId: true },
    });
    // A DM has no voice of its own yet, and no guild to have muted anyone in.
    if (!channel?.guildId) return null;
    return this.mutedUntilInGuild(userId, channel.guildId);
  }
}
