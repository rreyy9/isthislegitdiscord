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
  /**
   * The newest desktop build published to this server, or null when none has
   * been. A client compares it with its own version and offers an update; it
   * is never a reason to refuse service.
   */
  latestClientVersion: z.string().nullable(),
  /**
   * A floor, and expected to stay null. Set only for a change that genuinely
   * cannot be made compatible — an auth change, a security fix. Blocking ten
   * people until each notices a dialog is worse than the skew it avoids, so
   * reaching for this is evidence the additive rules were not followed.
   */
  minClientVersion: z.string().nullable(),
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

/* --------------------------------------------------- storage and retention */

/**
 * The retention policy. Every field is nullable and null means "keep", so an
 * unset policy — which is what a fresh install has — deletes nothing at all.
 * Turning retention on is an explicit act, and it has to be, because this is
 * the one feature whose job is to destroy data nobody has a second copy of.
 */
export const RetentionPolicy = z.object({
  /**
   * Media is nearly all of the bytes, so it gets its own knob. Expiring
   * images while the text of the conversation lives forever is the policy
   * most people actually want.
   */
  attachmentsMaxAgeDays: z.number().int().positive().nullable(),
  messagesMaxAgeDays: z.number().int().positive().nullable(),
  /** Soft-deleted messages: the row and its files outlive the deletion. */
  softDeletedMaxAgeDays: z.number().int().positive().nullable(),
  /**
   * The one that actually bounds the disk. Age limits nothing if ten people
   * paste two hundred screenshots in a week; over the cap, oldest goes first.
   */
  uploadsMaxTotalBytes: z.number().int().positive().nullable(),
  /** The sweeper does nothing at all while this is false. */
  enabled: z.boolean(),
});
export type RetentionPolicy = z.infer<typeof RetentionPolicy>;

export const RETENTION_DEFAULTS: RetentionPolicy = {
  attachmentsMaxAgeDays: null,
  messagesMaxAgeDays: null,
  softDeletedMaxAgeDays: null,
  uploadsMaxTotalBytes: null,
  enabled: false,
};

/** What a policy would remove if it ran now. Shown before anything is saved. */
export const RetentionPreview = z.object({
  messages: z.number().int(),
  attachments: z.number().int(),
  bytes: z.number().int(),
});
export type RetentionPreview = z.infer<typeof RetentionPreview>;

export const PURGE_KINDS = [
  'orphaned-files',
  'orphaned-rows',
  'tombstones',
  'retention',
] as const;

export const PurgeInput = z.object({
  kind: z.enum(PURGE_KINDS),
  /** Only for `tombstones`; null means every tombstone regardless of age. */
  olderThanDays: z.number().int().nonnegative().nullable().optional(),
  /**
   * Default true, and the caller has to say `false` on purpose. A destructive
   * endpoint whose safe mode is opt-in is a destructive endpoint that runs by
   * accident.
   */
  dryRun: z.boolean().optional(),
});
export type PurgeInput = z.infer<typeof PurgeInput>;

export const PurgeResult = z.object({
  kind: z.enum(PURGE_KINDS),
  dryRun: z.boolean(),
  messages: z.number().int(),
  attachments: z.number().int(),
  files: z.number().int(),
  bytes: z.number().int(),
});
export type PurgeResult = z.infer<typeof PurgeResult>;

export const TableSize = z.object({
  table: z.string(),
  rows: z.number().int(),
  totalBytes: z.number().int(),
  indexBytes: z.number().int(),
});
export type TableSize = z.infer<typeof TableSize>;

export const StorageReport = z.object({
  database: z.object({
    bytes: z.number().int(),
    tables: z.array(TableSize),
  }),
  uploads: z.object({
    files: z.number().int(),
    bytes: z.number().int(),
    directory: z.string(),
  }),
  /** Null when the volume could not be read; the page still renders. */
  disk: z
    .object({ freeBytes: z.number().int(), totalBytes: z.number().int() })
    .nullable(),
  orphans: z.object({
    /** Rows whose file is gone: a broken image, and unrecoverable. */
    rowsWithoutFile: z.number().int(),
    /** Files no row points at: wasted bytes, and safe to sweep. */
    filesWithoutRow: z.number().int(),
    bytesWithoutRow: z.number().int(),
  }),
  tombstones: z.object({
    messages: z.number().int(),
    attachments: z.number().int(),
    bytes: z.number().int(),
  }),
});
export type StorageReport = z.infer<typeof StorageReport>;

/* ------------------------------------------------------------ client skew */

/**
 * Compare two dotted versions. Positive when `a` is newer than `b`.
 *
 * Written out rather than compared as strings, because "0.10.0" < "0.9.0" is
 * true of strings and false of versions -- and the first time that matters is
 * the tenth release, by which point the wrong answer looks like a client that
 * refuses to update.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    // Build metadata (1.2.3+abc) is not part of ordering at all.
    const [core, ...rest] = v.trim().replace(/^v/i, '').split('+')[0].split('-');
    const nums = (t: string) =>
      t.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : 0));
    return {
      core: nums(core),
      // A prerelease sorts BELOW the release it precedes: 1.2.3-beta.1 is
      // older than 1.2.3, not newer. Treating the suffix as just more numbers
      // gets this backwards, which would offer a beta as an upgrade over the
      // final build and refuse to publish the final build over the beta.
      pre: rest.length ? nums(rest.join('-')) : null,
    };
  };

  const pa = parse(a);
  const pb = parse(b);

  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i += 1) {
    const d = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (d !== 0) return d;
  }

  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;

  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i += 1) {
    const d = (pa.pre[i] ?? 0) - (pb.pre[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}


/**
 * What one connected client says it is. Reported by the client on connect and
 * kept only in memory — this is telemetry for deciding when compatibility code
 * is safe to delete, not a record worth a table.
 */
export const ConnectedClient = z.object({
  userId: z.string(),
  username: z.string().nullable(),
  version: z.string().nullable(),
  connections: z.number().int(),
});
export type ConnectedClient = z.infer<typeof ConnectedClient>;

/** The header a REST call carries its version in. */
export const CLIENT_VERSION_HEADER = 'x-client-version';

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
  /**
   * A newer desktop build has been published. Sent on connect to a client that
   * is already behind, and broadcast when one is published so an app that has
   * been open all evening finds out without reconnecting.
   *
   * Additive by construction: a client too old to have registered a handler
   * drops it, which is the whole reason new features arrive as new events.
   */
  'client:update-available': (payload: { version: string }) => void;
}

/** Client -> server. */
export interface ClientToServerEvents {
  'channel:join': (payload: { channelId: string }) => void;
  'channel:leave': (payload: { channelId: string }) => void;
  'typing:start': (payload: { channelId: string }) => void;
  'typing:stop': (payload: { channelId: string }) => void;
}

export const SOCKET_PATH = '/socket.io';
