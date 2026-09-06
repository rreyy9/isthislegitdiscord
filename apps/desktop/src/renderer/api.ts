import { bridge } from './bridge';

/**
 * Thin API client. Holds the bearer token in memory and mirrors it into the
 * main process's encrypted store. Everything is bearer-based — no cookies —
 * because a file:// renderer cannot carry a SameSite cookie without TLS.
 */

let serverUrl = 'http://localhost:3000';
let token = '';

export async function initApi() {
  const settings = await bridge.getSettings();
  serverUrl = settings.serverUrl;
  token = await bridge.getToken();
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

async function request<T>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${serverUrl}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
  attachments: AttachmentDto[];
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

    const res = await fetch(`${serverUrl}/api/channels/${channelId}/messages`, {
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
