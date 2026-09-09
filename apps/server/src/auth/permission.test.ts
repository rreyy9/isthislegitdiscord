import { describe, expect, it } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { type Action, type Membership, PermissionService, isMuted } from './permission.guard';

/**
 * A stand-in for Prisma holding two rows in memory.
 *
 * The matrix is the thing under test, not the query. Faking the two lookups it
 * makes keeps this a unit test with no database, which is what lets it run on
 * a checkout that has never had one.
 */
function service(opts: {
  members?: Record<string, Membership>;
  channels?: Record<string, string>;
}) {
  const prisma = {
    guildMember: {
      findUnique: async ({ where }: any) => {
        const { guildId, userId } = where.guildId_userId;
        return opts.members?.[`${guildId}:${userId}`] ?? null;
      },
    },
    channel: {
      findUnique: async ({ where }: any) => {
        const guildId = opts.channels?.[where.id];
        return guildId ? { guildId } : null;
      },
    },
  } as unknown as PrismaService;
  return new PermissionService(prisma);
}

const ADMIN_ONLY: Action[] = [
  'channel.manage',
  'message.moderate',
  'message.pin',
  'member.moderate',
  'member.kick',
  'member.role',
  'invite.create',
];

const EVERY_MEMBER: Action[] = ['channel.read', 'channel.write', 'voice.join'];

describe('isMuted', () => {
  it('is false for someone who was never muted', () => {
    expect(isMuted(null)).toBe(false);
    expect(isMuted({ role: 'MEMBER', mutedUntil: null })).toBe(false);
  });

  it('is true while the mute is still running', () => {
    const until = new Date(Date.now() + 60_000);
    expect(isMuted({ role: 'MEMBER', mutedUntil: until })).toBe(true);
  });

  it('lifts on its own once the time passes', () => {
    // Nothing sweeps expired mutes, so a past date has to read as unmuted here
    // or a mute would be permanent.
    const past = new Date(Date.now() - 1);
    expect(isMuted({ role: 'MEMBER', mutedUntil: past })).toBe(false);
  });
});

describe('canInGuild', () => {
  const members = {
    'g1:admin': { role: 'ADMIN', mutedUntil: null } as Membership,
    'g1:member': { role: 'MEMBER', mutedUntil: null } as Membership,
  };

  it('refuses a non-member every action', async () => {
    const p = service({ members });
    for (const action of [...EVERY_MEMBER, ...ADMIN_ONLY]) {
      expect(await p.canInGuild('stranger', 'g1', action), action).toBe(false);
    }
  });

  it('lets any member read, write and join voice', async () => {
    const p = service({ members });
    for (const action of EVERY_MEMBER) {
      expect(await p.canInGuild('member', 'g1', action), action).toBe(true);
    }
  });

  it('reserves the administrative actions for admins', async () => {
    const p = service({ members });
    for (const action of ADMIN_ONLY) {
      expect(await p.canInGuild('member', 'g1', action), action).toBe(false);
      expect(await p.canInGuild('admin', 'g1', action), action).toBe(true);
    }
  });

  it('keeps pinning separate from moderating', async () => {
    // They are opposites -- one takes a message away, the other puts it in
    // front of everybody -- and separate names are what lets the two rules
    // move apart later. Today both are admin-only.
    const p = service({ members });
    expect(await p.canInGuild('member', 'g1', 'message.pin')).toBe(false);
    expect(await p.canInGuild('member', 'g1', 'message.moderate')).toBe(false);
  });

  it('denies nothing on account of a mute', async () => {
    // A mute takes away the microphone and nothing else. It used to deny
    // channel.write and voice.join here, which was three punishments under one
    // name; voice enforces the real one on the LiveKit participant instead.
    const muted = {
      'g1:muted': { role: 'MEMBER', mutedUntil: new Date(Date.now() + 60_000) } as Membership,
    };
    const p = service({ members: muted });
    for (const action of EVERY_MEMBER) {
      expect(await p.canInGuild('muted', 'g1', action), action).toBe(true);
    }
  });

  it('scopes membership to one guild', async () => {
    const p = service({ members });
    expect(await p.canInGuild('admin', 'g2', 'channel.read')).toBe(false);
  });
});

describe('canInChannel', () => {
  const members = {
    'g1:admin': { role: 'ADMIN', mutedUntil: null } as Membership,
    'g1:member': { role: 'MEMBER', mutedUntil: null } as Membership,
  };
  const channels = { c1: 'g1' };

  it('resolves the channel to its guild and answers there', async () => {
    const p = service({ members, channels });
    expect(await p.canInChannel('member', 'c1', 'channel.read')).toBe(true);
    expect(await p.canInChannel('member', 'c1', 'channel.manage')).toBe(false);
    expect(await p.canInChannel('admin', 'c1', 'channel.manage')).toBe(true);
  });

  it('refuses a channel that does not exist', async () => {
    // Rather than falling through to a guild-level answer, which would be a
    // yes for an id that names nothing.
    const p = service({ members, channels });
    expect(await p.canInChannel('admin', 'nope', 'channel.read')).toBe(false);
  });
});

describe('mutedUntil', () => {
  it('reports the date while it is running and null once it is not', async () => {
    const until = new Date(Date.now() + 60_000);
    const p = service({
      members: {
        'g1:muted': { role: 'MEMBER', mutedUntil: until },
        'g1:past': { role: 'MEMBER', mutedUntil: new Date(Date.now() - 1) },
        'g1:clear': { role: 'MEMBER', mutedUntil: null },
      },
      channels: { c1: 'g1' },
    });
    expect(await p.mutedUntilInGuild('muted', 'g1')).toEqual(until);
    expect(await p.mutedUntilInGuild('past', 'g1')).toBeNull();
    expect(await p.mutedUntilInGuild('clear', 'g1')).toBeNull();
    expect(await p.mutedUntilInChannel('muted', 'c1')).toEqual(until);
    expect(await p.mutedUntilInChannel('muted', 'nope')).toBeNull();
  });
});
