import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AWAY_AFTER_MS } from '@isthislegit/shared';
import { ChatGateway } from './chat.gateway';

/**
 * Away, and what brings somebody back from it.
 *
 * The gateway is built with stand-ins for everything it talks to: presence
 * is a map, a timer and an emit, and none of that needs a database or a
 * socket server to be wrong.
 */
function harness() {
  const emits: { event: string; payload: any }[] = [];
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    guildMember: {
      updateMany,
      findUnique: vi.fn().mockResolvedValue({ mutedUntil: null }),
    },
    channel: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ guildId: 'g1', listenOnly: false }),
    },
  };
  const parties = { dropUser: () => [] };
  const gateway = new ChatGateway(
    {} as any,
    {} as any,
    prisma as any,
    parties as any,
  );
  gateway.server = {
    emit: (event: string, payload: any) => emits.push({ event, payload }),
  } as any;

  const socket = (userId: string) =>
    ({
      data: { userId, username: userId, clientVersion: null, platform: 'desktop' },
      join: () => {},
      disconnect: () => {},
    }) as any;

  const presence = () =>
    emits.filter((e) => e.event === 'presence:changed').map((e) => e.payload);

  return { gateway, socket, presence, updateMany, prisma };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('away', () => {
  it('turns somebody away after the window with nothing done', () => {
    const { gateway, socket, presence } = harness();
    gateway.handleConnection(socket('ana'));
    expect(gateway.presenceOf('ana')?.away).toBe(false);

    vi.advanceTimersByTime(AWAY_AFTER_MS - 1000);
    expect(gateway.presenceOf('ana')?.away).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(gateway.presenceOf('ana')?.away).toBe(true);
    expect(presence().at(-1)).toMatchObject({ userId: 'ana', online: true, away: true });
  });

  it('restarts the window on every bit of activity', () => {
    const { gateway, socket } = harness();
    gateway.handleConnection(socket('ana'));

    vi.advanceTimersByTime(AWAY_AFTER_MS - 1000);
    gateway.markActive('ana');
    vi.advanceTimersByTime(AWAY_AFTER_MS - 1000);
    expect(gateway.presenceOf('ana')?.away).toBe(false);
  });

  it('brings somebody back, and says so once', () => {
    const { gateway, socket, presence } = harness();
    gateway.handleConnection(socket('ana'));
    vi.advanceTimersByTime(AWAY_AFTER_MS);
    const before = presence().length;

    gateway.markActive('ana');
    gateway.markActive('ana');
    expect(gateway.presenceOf('ana')?.away).toBe(false);
    expect(presence().length).toBe(before + 1);
    expect(presence().at(-1)).toMatchObject({ online: true, away: false });
  });

  it('writes last active with last seen when the last window closes', () => {
    const { gateway, socket, updateMany, presence } = harness();
    const s = socket('ana');
    gateway.handleConnection(s);
    vi.advanceTimersByTime(60_000);
    gateway.markActive('ana');
    const activeAt = new Date();
    vi.advanceTimersByTime(60_000);

    gateway.handleDisconnect(s);
    expect(gateway.presenceOf('ana')).toBeNull();
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { userId: 'ana' },
      data: { lastSeenAt: expect.any(Date), lastActiveAt: activeAt },
    });
    expect(presence().at(-1)).toMatchObject({
      online: false,
      away: false,
      lastActiveAt: activeAt.toISOString(),
    });

    // And no away event fires for somebody who has gone.
    const count = presence().length;
    vi.advanceTimersByTime(AWAY_AFTER_MS);
    expect(presence().length).toBe(count);
  });
});

describe('input activity', () => {
  it('keeps somebody present without moving last active', () => {
    const { gateway, socket } = harness();
    const s = socket('ana');
    gateway.handleConnection(s);
    const connectedAt = gateway.presenceOf('ana')!.lastActiveAt;

    vi.advanceTimersByTime(AWAY_AFTER_MS - 1000);
    gateway.inputActivity(s);
    vi.advanceTimersByTime(AWAY_AFTER_MS - 1000);
    expect(gateway.presenceOf('ana')?.away).toBe(false);
    expect(gateway.presenceOf('ana')?.lastActiveAt).toBe(connectedAt);
  });

  it('drops reports inside half a minute, but never the one that brings them back', () => {
    const { gateway, socket, presence } = harness();
    const s = socket('ana');
    gateway.handleConnection(s);

    vi.advanceTimersByTime(AWAY_AFTER_MS - 10_000);
    gateway.inputActivity(s);
    vi.advanceTimersByTime(5_000);
    // Inside the throttle: ignored, so the timer still runs from the first.
    gateway.inputActivity(s);
    vi.advanceTimersByTime(AWAY_AFTER_MS - 5_000);
    expect(gateway.presenceOf('ana')?.away).toBe(true);

    gateway.inputActivity(s);
    expect(gateway.presenceOf('ana')?.away).toBe(false);
    expect(presence().at(-1)).toMatchObject({ online: true, away: false });
  });

  it('goes away at once when the computer locks, and back on the next input', () => {
    const { gateway, socket, presence } = harness();
    const s = socket('ana');
    gateway.handleConnection(s);
    gateway.inputActivity(s);

    gateway.stepAway(s);
    expect(gateway.presenceOf('ana')?.away).toBe(true);
    expect(presence().at(-1)).toMatchObject({ online: true, away: true });

    // Seconds later, well inside the throttle.
    vi.advanceTimersByTime(2_000);
    gateway.inputActivity(s);
    expect(gateway.presenceOf('ana')?.away).toBe(false);
  });
});

describe('voice activity', () => {
  it('counts joining a call, but not a call found already going on restart', () => {
    const { gateway, socket } = harness();
    gateway.handleConnection(socket('ana'));
    vi.advanceTimersByTime(AWAY_AFTER_MS);
    expect(gateway.presenceOf('ana')?.away).toBe(true);

    gateway.broadcastVoiceParticipants('c1', ['ana', 'bob']);
    expect(gateway.presenceOf('ana')?.away).toBe(false);
    // Bob has no socket: a call the server found already running.
    expect(gateway.presenceOf('bob')).toBeNull();
  });

  it('believes a speaking report only from somebody in a call', async () => {
    const { gateway, socket } = harness();
    const s = socket('ana');
    gateway.handleConnection(s);
    vi.advanceTimersByTime(AWAY_AFTER_MS);

    await gateway.voiceActivity(s);
    expect(gateway.presenceOf('ana')?.away).toBe(true);

    gateway.broadcastVoiceParticipants('c1', ['bob']);
    gateway.broadcastVoiceParticipants('c1', ['bob', 'ana']);
    vi.advanceTimersByTime(AWAY_AFTER_MS);
    expect(gateway.presenceOf('ana')?.away).toBe(true);

    await gateway.voiceActivity(s);
    expect(gateway.presenceOf('ana')?.away).toBe(false);
  });

  it('ignores a report from somebody whose microphone is taken', async () => {
    const { gateway, socket, prisma } = harness();
    const s = socket('ana');
    gateway.handleConnection(s);
    gateway.broadcastVoiceParticipants('c1', ['ana']);
    vi.advanceTimersByTime(AWAY_AFTER_MS);

    prisma.guildMember.findUnique.mockResolvedValueOnce({
      mutedUntil: new Date(Date.now() + 60_000),
    });
    await gateway.voiceActivity(s);
    expect(gateway.presenceOf('ana')?.away).toBe(true);
  });
});
