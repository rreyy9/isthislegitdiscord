import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type Action =
  | 'channel.read'
  | 'channel.write'
  | 'channel.manage'
  | 'voice.join'
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
    return this.canInGuild(userId, channel.guildId, action);
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
    if (!channel) return null;
    return this.mutedUntilInGuild(userId, channel.guildId);
  }
}
