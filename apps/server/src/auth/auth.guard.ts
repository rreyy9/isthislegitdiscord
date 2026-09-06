import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import { AUTH, type Auth } from './auth.factory';
import { PrismaService } from '../prisma/prisma.service';

export interface SessionUser {
  id: string;
  username: string | null;
  displayName: string | null;
  image: string | null;
}

/**
 * Accepts either a session cookie or `Authorization: Bearer <token>`; the
 * bearer plugin in auth.factory makes getSession understand both. Clients that
 * cannot carry cookies — the file:// desktop renderer, a dev server on another
 * port — use the token.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AUTH) private readonly auth: Auth) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const session = await this.auth.api
      .getSession({ headers: fromNodeHeaders(req.headers) })
      .catch(() => null);

    if (!session?.user) {
      throw new UnauthorizedException('Not signed in.');
    }
    req.user = {
      id: session.user.id,
      username: (session.user as any).username ?? null,
      displayName: session.user.name ?? null,
      image: session.user.image ?? null,
    } satisfies SessionUser;
    return true;
  }
}

/**
 * Server administration. Roles are per-guild, so "an admin" here means an
 * admin of at least one guild — right for a single-guild deployment, and the
 * place to tighten if that ever stops being true.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const session = await this.auth.api
      .getSession({ headers: fromNodeHeaders(req.headers) })
      .catch(() => null);

    if (!session?.user) throw new UnauthorizedException('Not signed in.');

    const admin = await this.prisma.guildMember.findFirst({
      where: { userId: session.user.id, role: 'ADMIN' },
    });
    if (!admin) throw new ForbiddenException('Admins only.');

    req.user = {
      id: session.user.id,
      username: (session.user as any).username ?? null,
      displayName: session.user.name ?? null,
      image: session.user.image ?? null,
    } satisfies SessionUser;
    return true;
  }
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SessionUser =>
    context.switchToHttp().getRequest().user,
);
