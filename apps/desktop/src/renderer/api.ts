import { bridge } from './bridge';

/**
 * Thin API client. Holds the bearer token in memory and mirrors it into the
 * main process's encrypted store. Everything is bearer-based — no cookies —
 * because a file:// renderer cannot carry a SameSite cookie without TLS.
 */

let serverUrl = 'http://localhost:3000';
let token = '';

/**
 * This build's version, sent with every request and on the socket handshake.
 *
 * Not so the server can refuse anything -- it is telemetry. Knowing which
 * builds are actually connected is what says when a compatibility branch added
 * for one release is safe to delete; without it that code lives forever,
 * because nobody can show it is unused.
 */
let clientVersion = '';

export async function initApi() {
  const settings = await bridge.getSettings();
  serverUrl = settings.serverUrl;
  token = await bridge.getToken();
  clientVersion = await bridge.getVersion().catch(() => '');
}

export function getClientVersion() {
  return clientVersion;
}

export function getServerUrl() {
  return serverUrl;
}

export async function setServerUrl(url: string) {
  serverUrl = url.replace(/\/+$/, '');
  await bridge.setSettings({ serverUrl });
}

export function getToken() {
  return token;
}

export async function setToken(next: string) {
  token = next;
  await bridge.setToken(next);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * fetch rejects with "Failed to fetch" for everything that never reached a
 * server: wrong port, wrong scheme, nothing listening, a name that does not
 * resolve. The address is a field somebody typed, so that is the most likely
 * thing to be wrong and the least likely thing that message will make them
 * check -- and because the request has no response, devtools shows it with
 * provisional headers, which reads like a cross-origin block and is not one.
 *
 * Same idea as joinErrorMessage in voice.ts: name the address that did not
 * answer, because that is the diagnosis nine times out of ten.
 */
async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new ApiError(0, unreachable(url));
  }
}

function unreachable(url: string): string {
  let origin = url;
  try {
    origin = new URL(url).origin;
  } catch {
    // An address too malformed to parse is worth quoting back as typed.
  }
  return (
    `Could not reach ${origin}. ` +
    (origin.startsWith('https://')
      ? 'Nothing answered over TLS there. A server with no reverse proxy in ' +
        'front of it is plain http://, and on its own port — http://host:3000.'
      : 'Check the address and port, and that the server is running.')
  );
}

async function request<T>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await send(`${serverUrl}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(clientVersion ? { 'X-Client-Version': clientVersion } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new ApiError(res.status, data.message || data.error || `HTTP ${res.status}`);
  }
  return data as T;
}

/* ------------------------------------------------------------------ calls */

export interface ServerConfigDto {
  livekitUrl: string;
  maxUploadBytes: number;
  appVersion: string;
  /** Null until a desktop build has been published to this server. */
  latestClientVersion: string | null;
  /** A floor. Expected to stay null; see the README's Older clients. */
  minClientVersion: string | null;
}

export interface Me {
  id: string;
  username: string | null;
  displayName: string | null;
  image: string | null;
}

export interface ChannelDto {
  id: string;
  guildId: string;
  name: string;
  kind: 'TEXT' | 'VOICE';
  position: number;
}
export interface GuildDto {
  id: string;
  name: string;
  channels: ChannelDto[];
}
export interface AttachmentDto {
  id: string;
  fileName: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  /** A path on the API, e.g. /api/attachments/<id>. */
  url: string;
}
export interface MessageDto {
  id: string;
  channelId: string;
  author: { id: string; username: string; displayName: string | null; image: string | null };
  content: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  clientNonce: string | null;
  /**
   * Who this message tagged, as user ids, resolved and validated by the
   * server. Never contains the author: tagging yourself is not a tag.
   *
   * Absent from a server older than the feature, which is the one direction
   * this app's compatibility rules do not otherwise cover -- they are written
   * for an old client against a new server. Read it with `?.`.
   */
  mentions?: string[];
  /**
   * When an admin pinned this message, or null. Optional for the same reason
   * `mentions` is: a server older than the feature sends no such field, and
   * this client has to draw the message anyway.
   */
  pinnedAt?: string | null;
  attachments: AttachmentDto[];
}
/** Unread tags in one channel. Absent from the list when there are none. */
export interface ChannelMentionsDto {
  channelId: string;
  count: number;
}
export interface ChannelReadDto {
  channelId: string;
  lastReadMessageId: string | null;
}
/** Opus settings, chosen once on the server rather than per client. */
export interface VoiceAudioDto {
  quality: 'voice' | 'balanced' | 'high' | 'studio';
  maxBitrate: number;
  stereo: boolean;
  dtx: boolean;
  red: boolean;
}
export interface VoiceTokenDto {
  token: string;
  livekitUrl: string;
  room: string;
  audio: VoiceAudioDto;
}
export interface VoiceChannelStateDto {
  channelId: string;
  userIds: string[];
}
export interface MemberDto {
  guildId: string;
  role: 'ADMIN' | 'MEMBER';
  online: boolean;
  /** ISO date, or null when they are free to talk. */
  mutedUntil: string | null;
  user: { id: string; username: string; displayName: string | null; image: string | null };
}
export interface BanDto {
  userId: string;
  username: string;
  displayName: string | null;
  bannedBy: string | null;
  reason: string | null;
  createdAt: string;
}

export const api = {
  health: () => request<{ ok: boolean }>('/api/health'),
  /**
   * Everything the client would otherwise hardcode, including the newest
   * published build. Read after sign-in; unknown fields are ignored, which is
   * what makes a newer server safe to talk to.
   */
  config: () => request<ServerConfigDto>('/api/config'),
  login: (username: string, password: string) =>
    request<{ token: string }>('/api/login', {
      method: 'POST',
      body: { username, password },
    }),
  register: (body: {
    username: string;
    password: string;
    inviteCode: string;
    displayName?: string;
  }) => request<{ token: string }>('/api/register', { method: 'POST', body }),
  me: () => request<Me>('/api/me'),
  guilds: () => request<GuildDto[]>('/api/guilds'),
  members: () => request<MemberDto[]>('/api/members'),
  history: (channelId: string, before?: string, limit = 50) =>
    request<{ messages: MessageDto[]; nextCursor: string | null }>(
      `/api/channels/${channelId}/messages?limit=${limit}${before ? `&before=${before}` : ''}`,
    ),
  send: (channelId: string, content: string, clientNonce: string) =>
    request<MessageDto>(`/api/channels/${channelId}/messages`, {
      method: 'POST',
      body: { content, clientNonce },
    }),
  /**
   * Send with files. Multipart rather than the JSON route, because upload and
   * send are one request server-side — an attachment cannot exist without its
   * message. Content-Type is deliberately unset: fetch has to add the
   * multipart boundary itself.
   */
  sendWithFiles: async (
    channelId: string,
    content: string,
    clientNonce: string,
    files: File[],
  ): Promise<MessageDto> => {
    const form = new FormData();
    form.append('content', content);
    form.append('clientNonce', clientNonce);
    for (const f of files) form.append('files', f, f.name);

    const res = await send(`${serverUrl}/api/channels/${channelId}/messages`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new ApiError(res.status, data.message || `HTTP ${res.status}`);
    }
    return data as MessageDto;
  },
  editMessage: (channelId: string, id: string, content: string) =>
    request<MessageDto>(`/api/channels/${channelId}/messages/${id}`, {
      method: 'PATCH',
      body: { content },
    }),
  deleteMessage: (channelId: string, id: string) =>
    request<{ ok: boolean }>(`/api/channels/${channelId}/messages/${id}`, {
      method: 'DELETE',
    }),

  /* --------------------------------------------------------------- pins */

  /**
   * The pinned messages in a channel, newest post first and never paged —
   * the server caps how many a channel may hold, which is most of the point
   * of the cap. Asked for when the list is opened rather than on every
   * channel switch: the icon in the header is always there regardless.
   */
  pins: (channelId: string) =>
    request<MessageDto[]>(`/api/channels/${channelId}/messages/pinned`),
  pinMessage: (channelId: string, id: string) =>
    request<MessageDto>(`/api/channels/${channelId}/messages/${id}/pin`, {
      method: 'POST',
    }),
  unpinMessage: (channelId: string, id: string) =>
    request<{ ok: boolean }>(`/api/channels/${channelId}/messages/${id}/pin`, {
      method: 'DELETE',
    }),

  /* --------------------------------------------------------- moderation */

  /** `durationMinutes: null` mutes indefinitely. */
  mute: (guildId: string, userId: string, durationMinutes: number | null) =>
    request<{ ok: boolean; mutedUntil: string }>(
      `/api/guilds/${guildId}/members/${userId}/mute`,
      { method: 'POST', body: { durationMinutes } },
    ),
  unmute: (guildId: string, userId: string) =>
    request<{ ok: boolean }>(`/api/guilds/${guildId}/members/${userId}/unmute`, {
      method: 'POST',
    }),
  kick: (guildId: string, userId: string, reason?: string) =>
    request<{ ok: boolean }>(`/api/guilds/${guildId}/members/${userId}/kick`, {
      method: 'POST',
      body: { reason },
    }),
  ban: (guildId: string, userId: string, reason?: string) =>
    request<{ ok: boolean }>(`/api/guilds/${guildId}/members/${userId}/ban`, {
      method: 'POST',
      body: { reason },
    }),
  bans: (guildId: string) => request<BanDto[]>(`/api/guilds/${guildId}/bans`),
  unban: (guildId: string, userId: string) =>
    request<{ ok: boolean }>(`/api/guilds/${guildId}/bans/${userId}`, {
      method: 'DELETE',
    }),

  reads: () => request<ChannelReadDto[]>('/api/reads'),
  /**
   * Unread tags per channel. Its own call rather than part of `reads`, which
   * moves every time the reader scrolls — this moves only when somebody says
   * your name.
   */
  mentions: () => request<ChannelMentionsDto[]>('/api/mentions'),
  markRead: (channelId: string, lastReadMessageId: string) =>
    request<ChannelReadDto>(`/api/channels/${channelId}/read`, {
      method: 'POST',
      body: { lastReadMessageId },
    }),
  /** Minted per join and short-lived; not worth caching. */
  voiceToken: (channelId: string) =>
    request<VoiceTokenDto>(`/api/channels/${channelId}/voice-token`, {
      method: 'POST',
    }),
  /** Who is already in voice. After this the socket keeps it current. */
  voiceState: () => request<VoiceChannelStateDto[]>('/api/voice/state'),
};

/* --------------------------------------------------------- attachments */

/**
 * Attachments need the bearer token, and an <img src> cannot send a header.
 * So they are fetched here and handed to the DOM as object URLs.
 *
 * Cached by id and never revoked: ids are immutable, a chat session opens a
 * bounded number of images, and revoking one still on screen breaks it.
 */
const objectUrls = new Map<string, Promise<string>>();

export function attachmentUrl(id: string, path: string): Promise<string> {
  const cached = objectUrls.get(id);
  if (cached) return cached;

  const pending = (async () => {
    const res = await fetch(`${serverUrl}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
    return URL.createObjectURL(await res.blob());
  })();

  objectUrls.set(id, pending);
  // A failed fetch must not be cached as permanent: a reconnect should retry.
  pending.catch(() => objectUrls.delete(id));
  return pending;
}
