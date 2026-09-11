import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Channel as ChannelDto, CreateChannelInput, UpdateChannelInput } from '@isthislegit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ChatGateway } from '../gateway/chat.gateway';
import { VoiceService } from '../voice/voice.service';
import { newId } from '../common/ids';

/**
 * Creating, renaming and removing channels.
 *
 * A service rather than controller bodies because there are now two ways in --
 * the operator console and an admin sitting in the desktop app -- and the two
 * must not be able to drift. The rule about the last text channel and the
 * `guild:changed` broadcast are the parts that would rot first: a second copy
 * of either is a second thing to remember to update.
 */
@Injectable()
export class ChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: ChatGateway,
    private readonly voice: VoiceService,
  ) {}

  async create(guildId: string, input: CreateChannelInput): Promise<ChannelDto> {
    const guild = await this.prisma.guild.findUnique({ where: { id: guildId } });
    if (!guild) throw new NotFoundException('No such guild.');

    // Appended, not inserted: a new channel goes to the bottom of its section,
    // which is where somebody who just made one looks for it.
    const last = await this.prisma.channel.findFirst({
      where: { guildId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });

    const channel = await this.prisma.channel.create({
      data: {
        id: newId(),
        guildId,
        name: input.name,
        kind: input.kind,
        position: input.position ?? (last ? last.position + 1 : 0),
        // The kind decides, here, once. A listen-only text channel would be a
        // read-only one, which is a different feature nobody has asked for --
        // so rather than refuse the combination and make every caller think
        // about it, the flag is simply a thing only voice rooms can be.
        listenOnly: input.kind === 'VOICE' ? input.listenOnly : false,
      },
    });

    this.gateway.broadcastGuildChanged(guildId);
    return this.toDto(channel);
  }

  async update(id: string, input: UpdateChannelInput): Promise<ChannelDto> {
    const existing = await this.prisma.channel.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('No such channel.');

    const channel = await this.prisma.channel.update({
      where: { id },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
      },
    });

    this.gateway.broadcastGuildChanged(existing.guildId);
    return this.toDto(channel);
  }

  async remove(id: string): Promise<{ ok: true; guildId: string }> {
    const channel = await this.prisma.channel.findUnique({ where: { id } });
    if (!channel) throw new NotFoundException('No such channel.');

    // The guard is on text channels specifically, not on the count of all of
    // them. A guild whose last text channel went would still have voice rooms
    // and so would pass a bare count, while leaving every client with nowhere
    // to open -- which is the actual failure this is here to prevent. Voice
    // channels have no such floor: a server with none is merely quiet.
    if (channel.kind === 'TEXT') {
      const texts = await this.prisma.channel.count({
        where: { guildId: channel.guildId, kind: 'TEXT' },
      });
      if (texts <= 1) {
        throw new BadRequestException('A server needs at least one text channel.');
      }
    }

    // Messages cascade with the channel — this is not recoverable.
    await this.prisma.channel.delete({ where: { id } });

    // Anyone still in the room is holding a call in a channel that no longer
    // exists; LiveKit would happily keep it alive on its own.
    if (channel.kind === 'VOICE') {
      await this.voice
        .closeRoom(id)
        .catch(() => undefined);
    }

    this.gateway.broadcastGuildChanged(channel.guildId);
    return { ok: true, guildId: channel.guildId };
  }

  private toDto(c: {
    id: string;
    guildId: string;
    name: string;
    kind: string;
    position: number;
    listenOnly: boolean;
  }): ChannelDto {
    return {
      id: c.id,
      guildId: c.guildId,
      name: c.name,
      kind: c.kind as ChannelDto['kind'],
      position: c.position,
      listenOnly: c.listenOnly,
    };
  }
}
