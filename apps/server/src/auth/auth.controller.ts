import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { LoginInput, RegisterInput } from '@isthislegit/shared';
import { AUTH, type Auth, emailForUsername } from './auth.factory';
import { AuthGuard, CurrentUser, type SessionUser } from './auth.guard';
import { ZodPipe } from '../common/zod.pipe';

/** Copies a fetch Response from Better Auth onto the Express response. */
async function relay(res: Response, response: Response_ | globalThis.Response) {
  const r = response as globalThis.Response;
  r.headers.forEach((value, key) => {
    // Set-Cookie must be appended, not set, or multiple cookies collapse.
    if (key.toLowerCase() === 'set-cookie') res.append('Set-Cookie', value);
    else res.setHeader(key, value);
  });
  const text = await r.text();
  res.status(r.status);
  try {
    res.json(text ? JSON.parse(text) : {});
  } catch {
    res.send(text);
  }
}
type Response_ = globalThis.Response;

@Controller('api')
export class AuthController {
  constructor(@Inject(AUTH) private readonly auth: Auth) {}

  /**
   * Registration. The client sends a username; Better Auth wants an email, so
   * one is synthesised. The invite code is validated by the before-hook in
   * auth.factory, which also guards the raw Better Auth endpoint.
   */
  @Post('register')
  async register(
    @Body(new ZodPipe(RegisterInput)) body: RegisterInput,
    @Res() res: Response,
  ) {
    const response = await this.auth.api.signUpEmail({
      body: {
        email: emailForUsername(body.username),
        password: body.password,
        name: body.displayName ?? body.username,
        username: body.username,
        inviteCode: body.inviteCode,
      } as any,
      asResponse: true,
    });
    return relay(res, response);
  }

  /** Login by username. */
  @Post('login')
  async login(
    @Body(new ZodPipe(LoginInput)) body: LoginInput,
    @Res() res: Response,
  ) {
    const response = await this.auth.api.signInUsername({
      body: { username: body.username, password: body.password } as any,
      asResponse: true,
    });
    return relay(res, response);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@CurrentUser() user: SessionUser) {
    return user;
  }
}
