import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  AddGroupMembersInput,
  OpenDirectMessageInput,
  RegisterDeviceInput,
  RenameGroupInput,
  type DirectMessage,
  type DmDevice,
} from '@isthislegit/shared';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { DmsService } from './dms.service';

/**
 * The DM list and what a channel cannot do: be opened with somebody, gain and
 * lose people, and be closed. Reading and writing a DM is the channel routes.
 */
@Controller('api/dms')
@UseGuards(AuthGuard)
export class DmsController {
  constructor(private readonly dms: DmsService) {}

  @Get()
  list(@CurrentUser() user: SessionUser): Promise<DirectMessage[]> {
    return this.dms.list(user.id);
  }

  @Post()
  open(
    @CurrentUser() user: SessionUser,
    @Body(new ZodPipe(OpenDirectMessageInput)) body: OpenDirectMessageInput,
  ): Promise<DirectMessage> {
    return this.dms.open(user.id, body.userIds, body.name || undefined);
  }

  @Post(':channelId/hide')
  async hide(@CurrentUser() user: SessionUser, @Param('channelId') channelId: string) {
    await this.dms.hide(user.id, channelId);
    return { ok: true };
  }

  @Post(':channelId/members')
  add(
    @CurrentUser() user: SessionUser,
    @Param('channelId') channelId: string,
    @Body(new ZodPipe(AddGroupMembersInput)) body: AddGroupMembersInput,
  ): Promise<DirectMessage> {
    return this.dms.addMembers(user.id, channelId, body.userIds);
  }

  @Patch(':channelId')
  rename(
    @CurrentUser() user: SessionUser,
    @Param('channelId') channelId: string,
    @Body(new ZodPipe(RenameGroupInput)) body: RenameGroupInput,
  ): Promise<DirectMessage> {
    return this.dms.rename(user.id, channelId, body.name);
  }

  @Post(':channelId/leave')
  async leave(@CurrentUser() user: SessionUser, @Param('channelId') channelId: string) {
    await this.dms.leave(user.id, channelId);
    return { ok: true };
  }

  /** What to seal a message in this DM to, and what to verify one against. */
  @Get(':channelId/devices')
  devices(
    @CurrentUser() user: SessionUser,
    @Param('channelId') channelId: string,
  ): Promise<DmDevice[]> {
    return this.dms.devices(user.id, channelId);
  }
}

/**
 * The key directory. Only the public halves ever reach the server; see
 * `DeviceKey` in the schema.
 */
@Controller('api/keys')
@UseGuards(AuthGuard)
export class KeysController {
  constructor(private readonly dms: DmsService) {}

  @Put('devices/:deviceId')
  register(
    @CurrentUser() user: SessionUser,
    @Param('deviceId') deviceId: string,
    @Body(new ZodPipe(RegisterDeviceInput)) body: RegisterDeviceInput,
  ) {
    return this.dms.registerDevice(user.id, deviceId, body);
  }
}
