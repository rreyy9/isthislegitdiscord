import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type Action =
  | 'channel.read'
  | 'channel.write'
  | 'channel.manage'
  | 'voice.join'
  | 'message.moderate'
  | 'member.moderate'
  | 'member.kick'
  | 'member.role'
  | 'invite.create';

/** Needs the ADMIN role in the guild, not merely membership. */
const ADMIN_ONLY: ReadonlySet<Action> = new Set<Action>([
  'channel.manage',
  'message.moderate',
  'member.moderate',
  'member.kick',
  'member.role',
  'invite.create',
]);

/**
 * What a mute actually takes away. Reading and listening stay: a mute is
 * "you cannot say anything", not "you are gone" — that is what a kick is for.
 */
const DENIED_WHILE_MUTED: ReadonlySet<Action> = new Set<Action>([
  'channel.write',
  'voice.join',
]);

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
    if (DENIED_WHILE_MUTED.has(action) && isMuted(member)) return false;
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

  /** When the caller needs to explain *why*, not just that it was refused. */
  async mutedUntilInChannel(userId: string, channelId: string): Promise<Date | null> {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { guildId: true },
    });
    if (!channel) return null;
    const member = await this.membership(userId, channel.guildId);
    return isMuted(member) ? member!.mutedUntil : null;
  }
}
