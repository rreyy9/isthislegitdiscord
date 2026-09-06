import { z } from 'zod';

/**
 * Shared contracts. Imported by both the server and the desktop client so the
 * two cannot drift: one declaration gives the server its runtime validator and
 * the client its static type.
 */

/* ------------------------------------------------------------------ enums */

export const ChannelKind = z.enum(['TEXT', 'VOICE']);
export type ChannelKind = z.infer<typeof ChannelKind>;

export const MemberRole = z.enum(['ADMIN', 'MEMBER']);
export type MemberRole = z.infer<typeof MemberRole>;

/* ------------------------------------------------------------------ models */

export const PublicUser = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string().nullable(),
  image: z.string().nullable(),
});
export type PublicUser = z.infer<typeof PublicUser>;

export const Channel = z.object({
  id: z.string(),
  guildId: z.string(),
  name: z.string(),
  kind: ChannelKind,
  position: z.number().int(),
});
export type Channel = z.infer<typeof Channel>;

export const Guild = z.object({
  id: z.string(),
  name: z.string(),
  channels: z.array(Channel),
});
export type Guild = z.infer<typeof Guild>;

export const Attachment = z.object({
  id: z.string(),
  fileName: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  /** Null when the format was not recognised; the list then cannot reserve space. */
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  /** Path on the API, not a full URL — the client knows its own server address. */
  url: z.string(),
});
export type Attachment = z.infer<typeof Attachment>;

export const Message = z.object({
  id: z.string(),
  channelId: z.string(),
  author: PublicUser,
  content: z.string(),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  /** Echoed back so a client can match its optimistic copy and drop the duplicate. */
  clientNonce: z.string().nullable(),
  attachments: z.array(Attachment),
});
export type Message = z.infer<typeof Message>;

/* ------------------------------------------------------------- http inputs */

export const RegisterInput = z.object({
  username: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-z0-9_.]+$/i, 'letters, numbers, underscore and dot only'),
  password: z.string().min(8).max(200),
  inviteCode: z.string().min(4).max(64),
  displayName: z.string().min(1).max(64).optional(),
});
export type RegisterInput = z.infer<typeof RegisterInput>;

export const LoginInput = z.object({
  username: z.string().min(2).max(32),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof LoginInput>;

export const SendMessageInput = z.object({
  channelId: z.string(),
  // Empty content is allowed when there are attachments: a pasted screenshot
  // with nothing typed is a normal thing to send.
  content: z.string().max(4000),
  clientNonce: z.string().max(64).optional(),
  attachmentIds: z.array(z.string()).max(10).optional(),
});
export type SendMessageInput = z.infer<typeof SendMessageInput>;

export const EditMessageInput = z.object({
  content: z.string().max(4000),
});
export type EditMessageInput = z.infer<typeof EditMessageInput>;

export const MessageHistoryQuery = z.object({
  /** Cursor: return messages older than this id. Omit for the newest page. */
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type MessageHistoryQuery = z.infer<typeof MessageHistoryQuery>;

export const CreateInviteInput = z.object({
  maxUses: z.number().int().min(1).max(100).default(1),
  expiresInHours: z.number().int().min(1).max(24 * 365).default(24 * 7),
});
export type CreateInviteInput = z.infer<typeof CreateInviteInput>;

/* ------------------------------------------------------- moderation inputs */

/**
 * A mute is a deadline, not a flag: it expires on its own, so nothing has to
 * remember to lift it. `durationMinutes: null` means indefinite — stored as a
 * date far enough out that it will never arrive.
 */
export const MuteMemberInput = z.object({
  durationMinutes: z.number().int().min(1).max(60 * 24 * 28).nullable(),
  reason: z.string().max(200).optional(),
});
export type MuteMemberInput = z.infer<typeof MuteMemberInput>;

export const RemoveMemberInput = z.object({
  reason: z.string().max(200).optional(),
});
export type RemoveMemberInput = z.infer<typeof RemoveMemberInput>;

/* ------------------------------------------------------------ admin inputs */

export const AdminCreateUserInput = z.object({
  username: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-z0-9_.]+$/i, 'letters, numbers, underscore and dot only'),
  password: z.string().min(8).max(200),
  displayName: z.string().min(1).max(64).optional(),
  role: MemberRole.default('MEMBER'),
  guildId: z.string(),
});
export type AdminCreateUserInput = z.infer<typeof AdminCreateUserInput>;

export const AdminUpdateUserInput = z.object({
  displayName: z.string().min(1).max(64).optional(),
  role: MemberRole.optional(),
  guildId: z.string().optional(),
});
export type AdminUpdateUserInput = z.infer<typeof AdminUpdateUserInput>;

export const AdminSetPasswordInput = z.object({
  password: z.string().min(8).max(200),
});
export type AdminSetPasswordInput = z.infer<typeof AdminSetPasswordInput>;

export const CreateChannelInput = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[^\s#@]+$/, 'no spaces or # @ characters'),
  kind: ChannelKind.default('TEXT'),
  position: z.number().int().min(0).max(999).optional(),
});
export type CreateChannelInput = z.infer<typeof CreateChannelInput>;

export const UpdateChannelInput = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[^\s#@]+$/, 'no spaces or # @ characters')
    .optional(),
  position: z.number().int().min(0).max(999).optional(),
});
export type UpdateChannelInput = z.infer<typeof UpdateChannelInput>;

export const CreateGuildInput = z.object({
  name: z.string().min(1).max(64),
});
export type CreateGuildInput = z.infer<typeof CreateGuildInput>;

/* ------------------------------------------------------------ http outputs */

/**
 * Opus settings, decided by the server rather than each client.
 *
 * Audio quality is a property of the deployment, not of a person's preferences:
 * the bitrate everyone publishes at is what the host's uplink has to carry, and
 * one person quietly picking "studio" costs bandwidth for the whole room. So it
 * is set once in the server's environment and handed to clients, the same way
 * `livekitUrl` is — a shipped desktop app would otherwise need a reinstall to
 * change a constant.
 */
export const VoiceQuality = z.enum(['voice', 'balanced', 'high', 'studio']);
export type VoiceQuality = z.infer<typeof VoiceQuality>;

export const VoiceAudioConfig = z.object({
  quality: VoiceQuality,
  /** Opus target, bits per second. */
  maxBitrate: z.number().int(),
  /**
   * Two channels. Only meaningful with echo cancellation off — Chromium
   * forces a mono capture whenever AEC is on — so the client treats this as a
   * request rather than a promise.
   */
  stereo: z.boolean(),
  /**
   * Discontinuous transmission: stop sending during silence. Saves bandwidth
   * but can clip the start of a word, so it is on only for the lowest preset.
   */
  dtx: z.boolean(),
  /**
   * Redundant audio data. Costs a little bandwidth and buys a lot of
   * resilience to packet loss — the single biggest quality win on a bad link.
   */
  red: z.boolean(),
});
export type VoiceAudioConfig = z.infer<typeof VoiceAudioConfig>;

export const ServerConfig = z.object({
  /** e.g. ws://203.0.113.10:7880 — never baked into the shipped client. */
  livekitUrl: z.string(),
  maxUploadBytes: z.number().int(),
  appVersion: z.string(),
  voiceAudio: VoiceAudioConfig,
});
export type ServerConfig = z.infer<typeof ServerConfig>;

/**
 * A row in the member list. `mutedUntil` is sent to everyone, not just admins:
 * the marker next to a name is what tells people why someone has gone quiet.
 */
export const GuildMemberDto = z.object({
  guildId: z.string(),
  role: MemberRole,
  online: z.boolean(),
  mutedUntil: z.string().nullable(),
  user: PublicUser,
});
export type GuildMemberDto = z.infer<typeof GuildMemberDto>;

export const MessagePage = z.object({
  messages: z.array(Message),
  /** Pass as `before` to fetch the next older page. Null when fully scrolled back. */
  nextCursor: z.string().nullable(),
});
export type MessagePage = z.infer<typeof MessagePage>;

export const VoiceTokenResponse = z.object({
  token: z.string(),
  livekitUrl: z.string(),
  room: z.string(),
  /**
   * Sent with the token, not just from `/api/config`, because this is the
   * moment the client is about to publish. Changing the server's setting
   * therefore takes effect on everyone's next join, with no app restart.
   */
  audio: VoiceAudioConfig,
});
export type VoiceTokenResponse = z.infer<typeof VoiceTokenResponse>;

/**
 * Who is sitting in a voice channel. Kept server-side from LiveKit's webhooks
 * so the sidebar can show occupants to people who have not joined the room —
 * a client only learns about participants in rooms it is actually connected to.
 */
export const VoiceChannelState = z.object({
  channelId: z.string(),
  userIds: z.array(z.string()),
});
export type VoiceChannelState = z.infer<typeof VoiceChannelState>;

/**
 * How far each channel has been read. `lastReadMessageId` is compared against
 * message ids directly — they are UUIDv7, so id order is time order and
 * "anything newer than this" needs no timestamp column.
 */
export const ChannelRead = z.object({
  channelId: z.string(),
  lastReadMessageId: z.string().nullable(),
});
export type ChannelRead = z.infer<typeof ChannelRead>;

export const MarkReadInput = z.object({
  lastReadMessageId: z.string(),
});
export type MarkReadInput = z.infer<typeof MarkReadInput>;

/* ------------------------------------------------------- socket.io events */

/** Server -> client. */
export interface ServerToClientEvents {
  'message:new': (message: Message) => void;
  'message:updated': (message: Message) => void;
  'message:deleted': (payload: { id: string; channelId: string }) => void;
  /**
   * A member's moderation state changed — today that means muted or unmuted.
   * Everyone gets it, because everyone's member list shows the mute marker.
   */
  'member:updated': (payload: {
    guildId: string;
    userId: string;
    mutedUntil: string | null;
  }) => void;
  /**
   * Sent only to the person it happened to. Their client has just lost access
   * and has to stop pretending otherwise.
   */
  'moderation:removed': (payload: {
    guildId: string;
    kind: 'kick' | 'ban';
    reason: string | null;
  }) => void;
  'presence:changed': (payload: { userId: string; online: boolean }) => void;
  'typing:changed': (payload: {
    channelId: string;
    userId: string;
    typing: boolean;
  }) => void;
  'voice:participants': (payload: {
    channelId: string;
    userIds: string[];
  }) => void;
}

/** Client -> server. */
export interface ClientToServerEvents {
  'channel:join': (payload: { channelId: string }) => void;
  'channel:leave': (payload: { channelId: string }) => void;
  'typing:start': (payload: { channelId: string }) => void;
  'typing:stop': (payload: { channelId: string }) => void;
}

export const SOCKET_PATH = '/socket.io';
