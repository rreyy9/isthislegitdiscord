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

/** A user as everyone else sees them: what a profile edit sends back. */
export interface PublicUserDto {
  id: string;
  username: string;
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
  /**
   * When the server will remove the file, or null for one it keeps. Only
   * pictures are kept; anything else is here to be handed over, not stored.
   *
   * Optional because a server older than the feature sends no such field, and
   * this client has to draw the attachment anyway. Read it with `?.` — the
   * same rule as `mentions` and `pinnedAt`.
   */
  expiresAt?: string | null;
  /** Set once the deadline passed and the bytes went. The row stays. */
  expiredAt?: string | null;
  /**
   * Whether the server will hand this back as something drawable. Absent from
   * an older server, where every attachment was a picture — so undefined
   * means "decide from the content type", which is what this build used to do
   * on its own.
   */
  inline?: boolean;
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
export interface MessagePageDto {
  messages: MessageDto[];
  /** Pass as `before` for older messages. Null once fully scrolled back. */
  nextCursor: string | null;
  /**
   * Pass as `after` for newer ones. Null at the live end of the channel — and
   * absent entirely from a server older than the feature, which only ever
   * served the live end, so undefined reads correctly as null.
   */
  prevCursor?: string | null;
}

export interface SearchPageDto {
  results: MessageDto[];
  nextCursor: string | null;
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
  /**
   * ISO date until which their microphone is taken away, or null. It stops
   * them publishing audio in voice and nothing else — they still type, still
   * sit in the channel, still hear everyone.
   */
  mutedUntil: string | null;
  /**
   * ISO date a connection of theirs was last seen, or null for an account
   * that has not signed in since the server started recording it. Only drawn
   * while they are offline, where it is the "last seen 3h ago" under a name.
   */
  lastSeenAt: string | null;
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
  /**
   * Change your own display name. Comes back as the whole public user, which
   * is the same object everyone else gets over the socket -- so the screen
   * that sent this redraws from the same shape as the screens that did not.
   */
  updateProfile: (patch: { displayName?: string; removeAvatar?: true }) =>
    request<PublicUserDto>('/api/me', { method: 'PATCH', body: patch }),
  /**
   * Replace your avatar. The blob is the already-cropped square the editor
   * produced, not the file somebody picked -- the server stores what it is
   * given and has no image codec to resize with.
   */
  uploadAvatar: async (blob: Blob): Promise<PublicUserDto> => {
    const form = new FormData();
    form.append('file', blob, 'avatar.png');
    const res = await send(`${serverUrl}/api/me/avatar`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new ApiError(res.status, data.message || `HTTP ${res.status}`);
    }
    return data as PublicUserDto;
  },
  guilds: () => request<GuildDto[]>('/api/guilds'),

  /* ----------------------------------------------------------- channels */

  /**
   * Channel management, for an admin of the guild. The same three routes the
   * operator console drives, and the server runs both through one service --
   * so a channel made from the app is indistinguishable from one made in the
   * console, including the `guild:changed` every other client hears.
   */
  createChannel: (guildId: string, body: { name: string; kind: 'TEXT' | 'VOICE' }) =>
    request<ChannelDto>(`/api/guilds/${guildId}/channels`, {
      method: 'POST',
      body,
    }),
  renameChannel: (id: string, name: string) =>
    request<ChannelDto>(`/api/channels/${id}`, { method: 'PATCH', body: { name } }),
  deleteChannel: (id: string) =>
    request<{ ok: boolean }>(`/api/channels/${id}`, { method: 'DELETE' }),
  members: () => request<MemberDto[]>('/api/members'),
  history: (channelId: string, before?: string, limit = 50) =>
    request<MessagePageDto>(
      `/api/channels/${channelId}/messages?limit=${limit}${before ? `&before=${before}` : ''}`,
    ),
  /**
   * A page centred on one message: what landing on a search result or a pin
   * needs. Both cursors come back set, because a window in the middle of a
   * channel has history above it and live messages below it.
   *
   * Against a server too old to know `around`, the parameter is ignored and
   * the newest page comes back instead — the reader ends up at the bottom of
   * the right channel rather than seeing an error, which is the better of the
   * two failures.
   */
  historyAround: (channelId: string, around: string, limit = 50) =>
    request<MessagePageDto>(
      `/api/channels/${channelId}/messages?limit=${limit}&around=${encodeURIComponent(around)}`,
    ),
  /** The next page of newer messages, for walking back down to the live end. */
  historyAfter: (channelId: string, after: string, limit = 50) =>
    request<MessagePageDto>(
      `/api/channels/${channelId}/messages?limit=${limit}&after=${encodeURIComponent(after)}`,
    ),

  /* ------------------------------------------------------------- search */

  /**
   * Find a message. Scoped to one guild, newest first, paged by message id.
   *
   * The server decides what this account may read; there is no client-side
   * filtering to forget. Results carry the channel id, and this app already
   * holds the channel list, so "in #general" is drawn without asking.
   */
  search: (params: {
    q: string;
    guildId?: string;
    channelId?: string;
    before?: string;
    limit?: number;
  }) => {
    const qs = new URLSearchParams({ q: params.q });
    if (params.guildId) qs.set('guildId', params.guildId);
    if (params.channelId) qs.set('channelId', params.channelId);
    if (params.before) qs.set('before', params.before);
    qs.set('limit', String(params.limit ?? 25));
    return request<SearchPageDto>(`/api/search?${qs}`);
  },
  send: (channelId: string, content: string, clientNonce: string) =>
    request<MessageDto>(`/api/channels/${channelId}/messages`, {
      method: 'POST',
      body: { content, clientNonce },
    }),
  /**
   * Send with files. Multipart rather than the JSON route, because upload and
   * send are one request server-side — an attachment cannot exist without its
   * message. Content-Type is deliberately unset: the boundary has to be added
   * by whatever builds the request, and both paths below leave it to the
   * FormData.
   *
   * XMLHttpRequest rather than fetch, for the one thing fetch cannot do:
   * report how much of the body has gone out. A video takes long enough that a
   * message sitting there with no sign of movement reads as a client that has
   * hung, and the only honest way to say otherwise is the number itself.
   * `onProgress` is called with 0..1, and only while the length is known.
   */
  sendWithFiles: (
    channelId: string,
    content: string,
    clientNonce: string,
    files: File[],
    onProgress?: (fraction: number) => void,
  ): Promise<MessageDto> => {
    const form = new FormData();
    form.append('content', content);
    form.append('clientNonce', clientNonce);
    for (const f of files) form.append('files', f, f.name);

    const url = `${serverUrl}/api/channels/${channelId}/messages`;
    return new Promise<MessageDto>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      if (clientVersion) xhr.setRequestHeader('X-Client-Version', clientVersion);

      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && e.total > 0) {
            onProgress(Math.min(1, e.loaded / e.total));
          }
        };
        // The last byte leaving is not the same as the message existing: the
        // server still has to write the files and the row. Pinning it at 1
        // here is what turns the ring into a spinner for that last stretch,
        // rather than leaving it stuck at 99% looking wedged.
        xhr.upload.onload = () => onProgress(1);
      }

      xhr.onload = () => {
        let data: any = {};
        try {
          data = xhr.responseText ? JSON.parse(xhr.responseText) : {};
        } catch {
          data = {};
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data as MessageDto);
        else {
          reject(
            new ApiError(xhr.status, data.message || `HTTP ${xhr.status}`),
          );
        }
      };
      // Same account as `send` gives: a request that never reached a server
      // has no status and no body, and the address is the likely fault.
      xhr.onerror = () => reject(new ApiError(0, unreachable(url)));
      xhr.onabort = () => reject(new ApiError(0, 'Upload cancelled.'));
      xhr.ontimeout = () => reject(new ApiError(0, 'The upload timed out.'));

      xhr.send(form);
    });
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

/**
 * An avatar, as an object URL.
 *
 * Same cache as attachments and for the same reason -- it is behind the bearer
 * token, so it cannot go straight in an `<img src>`. Keyed by the path rather
 * than a separate id because that is already unique per upload: changing your
 * picture writes a new file with a new name, so the old entry is simply never
 * asked for again instead of needing to be invalidated.
 */
export function avatarUrl(image: string): Promise<string> {
  return attachmentUrl(image, image);
}

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

/**
 * Fetch a file attachment's bytes so main can write them somewhere.
 *
 * Not an object URL and not the cache above: this is a file somebody is
 * saving once, and holding a 25 MB blob for the rest of the session because
 * they downloaded it is the opposite of what is wanted. The bytes go straight
 * across to main, which owns the save dialog and the disk.
 *
 * An `<a download>` is not the alternative. The renderer has no permission to
 * write anywhere, the file has to be fetched with a bearer token no anchor can
 * send, and a save that silently lands in Downloads is not what "Save" means
 * on a desktop application.
 */
export async function fetchAttachmentBytes(path: string): Promise<ArrayBuffer> {
  const res = await send(`${serverUrl}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 410) {
    throw new ApiError(410, 'That file expired and is no longer on the server.');
  }
  if (!res.ok) throw new ApiError(res.status, `Could not download that file.`);
  return res.arrayBuffer();
}
