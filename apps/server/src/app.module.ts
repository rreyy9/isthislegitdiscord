import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { GatewayModule } from './gateway/gateway.module';
import { AppController } from './common/app.controller';
import { GuildsController } from './guilds/guilds.controller';
import { MessagesController } from './messages/messages.controller';
import { InvitesController } from './invites/invites.controller';
import { VoiceModule } from './voice/voice.module';
import { AttachmentsController } from './attachments/attachments.controller';
import { ReadsController } from './reads/reads.controller';
import { AdminController } from './admin/admin.controller';
import { ModerationController } from './moderation/moderation.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Stops a client reconnect loop from hammering the box. Generous, because
    // ten friends are not the threat model.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    PrismaModule,
    AuthModule,
    GatewayModule,
    VoiceModule,
  ],
  controllers: [
    AppController,
    GuildsController,
    MessagesController,
    InvitesController,
    AttachmentsController,
    ReadsController,
    AdminController,
    ModerationController,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
