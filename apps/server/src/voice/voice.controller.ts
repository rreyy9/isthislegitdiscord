import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AccessToken } from 'livekit-server-sdk';
import type { VoiceChannelState, VoiceTokenResponse } from '@isthislegit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { PermissionService } from '../auth/permission.guard';
import { VoiceService, publishableSources, roomForChannel } from './voice.service';
import { voiceAudioConfig } from './audio-config';

/**
 * The entire backend of the voice feature: check permission, mint a LiveKit
 * token for a room named after the channel. LiveKit does the SFU, TURN, echo
 * cancellation, device handling and screen share.
 */
@Controller('api/channels/:channelId/voice-token')
@UseGuards(AuthGuard)
export class VoiceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
  ) {}

  @Post()
  async token(
    @CurrentUser() user: SessionUser,
    @Param('channelId') channelId: string,
  ): Promise<VoiceTokenResponse> {
    if (!(await this.permissions.canInChannel(user.id, channelId, 'voice.join'))) {
      throw new ForbiddenException('No access to that channel.');
    }

    // A mute does not keep anyone out of the room. It is spent here, on the
    // grant: the token simply does not carry the right to publish a
    // microphone, so they join, they hear everything, and nothing they say
    // leaves the machine. `VoiceService` keeps the same rule applied while
    // they sit there, including handing the microphone back when it expires.
    const mutedUntil = await this.permissions.mutedUntilInChannel(
      user.id,
      channelId,
    );

    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { kind: true },
    });
    if (!channel) throw new NotFoundException('No such channel.');
    if (channel.kind !== 'VOICE') {
      throw new ForbiddenException('That is not a voice channel.');
    }

    const room = roomForChannel(channelId);
    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      {
        identity: user.id,
        name: user.displayName ?? user.username ?? user.id,
        // Short-lived on purpose: signalling is plaintext, so a sniffed token
        // should stop being useful quickly. It only needs to survive the join.
        ttl: '10m',
      },
    );
    at.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      // Spelled out even when nothing is being withheld, because the sweep in
      // VoiceService compares against this list and an absent one means
      // "everything" — two different ways of saying the same thing is one more
      // than that comparison can tell apart.
      canPublishSources: publishableSources(mutedUntil !== null),
    });

    return {
      token: await at.toJwt(),
      livekitUrl: process.env.LIVEKIT_URL ?? 'ws://localhost:7880',
      room,
      // Sent every join so the deployment's quality setting reaches clients
      // without anyone reinstalling anything.
      audio: voiceAudioConfig(),
    };
  }
}

/**
 * The snapshot a client needs on connect. After this the `voice:participants`
 * socket event keeps it current — but a client that starts up mid-call would
 * otherwise see empty voice channels until the next person joined or left.
 */
@Controller('api/voice')
@UseGuards(AuthGuard)
export class VoiceStateController {
  constructor(
    private readonly voice: VoiceService,
    private readonly permissions: PermissionService,
  ) {}

  @Get('state')
  async state(@CurrentUser() user: SessionUser): Promise<VoiceChannelState[]> {
    const all = this.voice.state();
    const visible = await Promise.all(
      all.map(async (s) =>
        (await this.permissions.canInChannel(user.id, s.channelId, 'channel.read'))
          ? s
          : null,
      ),
    );
    return visible.filter((s): s is VoiceChannelState => s !== null);
  }
}
