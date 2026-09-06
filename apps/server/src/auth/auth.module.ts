import { Global, Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AUTH, createAuth } from './auth.factory';
import { AdminGuard, AuthGuard } from './auth.guard';
import { PermissionService } from './permission.guard';
import { AuthController } from './auth.controller';

@Global()
@Module({
  controllers: [AuthController],
  providers: [
    {
      provide: AUTH,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => createAuth(prisma),
    },
    AuthGuard,
    AdminGuard,
    PermissionService,
  ],
  exports: [AUTH, AuthGuard, AdminGuard, PermissionService],
})
export class AuthModule {}
