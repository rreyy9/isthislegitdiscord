import { describe, expect, it } from 'vitest';
import type { CreateChannelInput } from '@isthislegit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import type { ChatGateway } from '../gateway/chat.gateway';
import type { VoiceService } from '../voice/voice.service';
import { ChannelsService } from './channels.service';

/**
 * The service with the database and the socket faked out.
 *
 * What is under test is the handful of rules `create` applies on the way past
 * -- which column the kind decides, where in the list a new channel lands --
 * and none of them need Postgres to be running. `written` is whatever the
 * service asked Prisma to store, which is the thing worth asserting on: the
 * DTO it hands back is derived from the same object and would agree with a
 * wrong one.
 */
function service(existing: { position: number } | null = null) {
  const written: Record<string, unknown>[] = [];
  const prisma = {
    guild: { findUnique: async () => ({ id: 'g1', name: 'Home' }) },
    channel: {
      findFirst: async () => existing,
      create: async ({ data }: any) => {
        written.push(data);
        return data;
      },
    },
  } as unknown as PrismaService;

  const gateway = { broadcastGuildChanged: () => undefined } as unknown as ChatGateway;
  const voice = {} as unknown as VoiceService;

  return { channels: new ChannelsService(prisma, gateway, voice), written };
}

/** What the zod schema hands the service once its defaults have been applied. */
const input = (over: Partial<CreateChannelInput> = {}): CreateChannelInput => ({
  name: 'general',
  kind: 'TEXT',
  listenOnly: false,
  ...over,
});

describe('create', () => {
  it('stores an AFK voice channel as listen-only', async () => {
    const { channels, written } = service();
    const dto = await channels.create('g1', input({ kind: 'VOICE', listenOnly: true }));

    expect(written[0].listenOnly).toBe(true);
    // On the DTO too: the client draws the sidebar from this and has no other
    // way to learn a channel it just made cannot be spoken in.
    expect(dto.listenOnly).toBe(true);
  });

  it('refuses to let a text channel be listen-only, however it is asked', async () => {
    // A listen-only text channel would be a read-only one, which is a
    // different feature that does not exist. The kind decides, here, so no
    // caller -- the console, the app, or a hand-written request -- can store
    // a flag that would have to be explained away later.
    const { channels, written } = service();
    const dto = await channels.create('g1', input({ kind: 'TEXT', listenOnly: true }));

    expect(written[0].listenOnly).toBe(false);
    expect(dto.listenOnly).toBe(false);
  });

  it('leaves an ordinary voice channel alone', async () => {
    const { channels } = service();
    const dto = await channels.create('g1', input({ kind: 'VOICE' }));
    expect(dto.listenOnly).toBe(false);
  });

  it('appends rather than inserting, AFK channel or not', async () => {
    // Where somebody who just made one looks for it. Asserted alongside the
    // flag because both are decided in the same object literal.
    const { channels, written } = service({ position: 4 });
    await channels.create('g1', input({ kind: 'VOICE', listenOnly: true }));
    expect(written[0].position).toBe(5);
  });
});
