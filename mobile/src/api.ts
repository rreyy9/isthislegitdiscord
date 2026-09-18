import {
  CLIENT_VERSION,
  CLIENT_VERSION_HEADER,
} from './version';
import type {
  Channel,
  ChannelMentions,
  ChannelRead,
  Guild,
  Me,
  Member,
  Message,
  MessagePage,
  PublicUser,
  Reaction,
  SearchPage,
  SendExtras,
  ServerConfig,
} from './types';

/**
 * The REST client. Bearer token in memory, mirrored into SecureStore by the
 * session provider that owns it.
 *
 * Bearer rather than cookies throughout, which costs nothing here because the
 * server has supported it since the desktop client needed it: a native app has
 * no cookie jar worth the name, and `fetch` on React Native would carry one
 * across a server change without being asked. A token this module holds is a
 * token this module can drop.
 *
 * Note what is *not* here, compared with the desktop client's api.ts: the
 * object-URL cache for attachments. That whole mechanism exists because an
 * `<img src>` cannot send an Authorization header, so every picture had to be
 * fetched by hand and handed to the DOM as a blob. React Native's image
 * components take headers directly, so the picture goes straight into the view
 * and the cache is the platform's problem rather than ours.
 */

let serverUrl = '';
let token = '';

export function configure(next: { serverUrl?: string; token?: string }) {
  if (next.serverUrl !== undefined) serverUrl = next.serverUrl;
  if (next.token !== undefined) token = next.token;
}

export function getServerUrl(): string {
  return serverUrl;
}

export function getToken(): string {
  return token;
}

/** Headers for a raw image or file fetch. Exported for the image components. */
export function authHeaders(): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Absolute URL for a path the API handed back, e.g. an attachment's. */
export function absoluteUrl(path: string): string {
  return `${serverUrl}${path}`;
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
 * `fetch` rejects with a bare "Network request failed" for everything that
 * never reached a server: wrong port, wrong scheme, nothing listening, a name
 * that does not resolve. On a phone there is one more cause than on a desktop
 * and it is the most common of all -- the handset is on mobile data and the
 * server is a box on the home LAN.
 *
 * So the address is named. It is a field somebody typed, it is the most likely
 * thing to be wrong, and it is the least likely thing that message would make
 * them check. Same reasoning as the desktop client's `unreachable`.
 */
function unreachable(url: string): string {
  let origin = url;
  try {
    origin = new URL(url).origin;
  } catch {
    // An address too malformed to parse is worth quoting back as typed.
  }

  if (/^http:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(origin)) {
    return (
      `Could not reach ${origin}. That is a local address, so the phone has ` +
      'to be on the same network as the server — not on mobile data, and not ' +
      'on a guest Wi-Fi that blocks devices from seeing each other.'
    );
  }
  return (
    `Could not reach ${origin}. ` +
    (origin.startsWith('https://')
      ? 'Nothing answered over TLS there. A server with no reverse proxy in ' +
        'front of it is plain http://, and on its own port — http://host:3000.'
      : 'Check the address and port, and that the server is running.')
  );
}

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new ApiError(0, unreachable(url));
  }
}

async function request<T>(
  path: string,
  opts: { method?: string; body?: unknown; baseUrl?: string } = {},
): Promise<T> {
  const base = opts.baseUrl ?? serverUrl;
  const res = await send(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      [CLIENT_VERSION_HEADER]: CLIENT_VERSION,
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
    throw new ApiError(
      res.status,
      data.message || data.error || `HTTP ${res.status}`,
    );
  }
  return data as T;
}

export const api = {
  /**
   * Health, against an address that has not been saved yet.
   *
   * `baseUrl` is the point: the sign-in screen checks a server before it
   * commits to it, so somebody who typed the wrong thing is told by the field
   * they typed it into rather than by a failed sign-in that reads like a wrong
   * password.
   */
  health: (baseUrl?: string) =>
    request<{ ok: boolean }>('/api/health', { baseUrl }),

  config: () => request<ServerConfig>('/api/config'),

  login: (username: string, password: string, baseUrl?: string) =>
    request<{ token: string }>('/api/login', {
      method: 'POST',
      body: { username, password },
      baseUrl,
    }),

  register: (
    body: {
      username: string;
      password: string;
      inviteCode: string;
      displayName?: string;
    },
    baseUrl?: string,
  ) => request<{ token: string }>('/api/register', { method: 'POST', body, baseUrl }),

  me: () => request<Me>('/api/me'),

  guilds: () => request<Guild[]>('/api/guilds'),

  members: () => request<Member[]>('/api/members'),

  history: (channelId: string, before?: string, limit = 50) =>
    request<MessagePage>(
      `/api/channels/${channelId}/messages?limit=${limit}` +
        (before ? `&before=${encodeURIComponent(before)}` : ''),
    ),

  /**
   * The next page of *newer* messages.
   *
   * What the reconnect backfill uses. A phone sleeps far more than a laptop —
   * every time the screen goes off, in effect — so this runs constantly, and
   * walking forward from the last message held is much cheaper than refetching
   * the live page and reconciling it.
   */
  historyAfter: (channelId: string, after: string, limit = 50) =>
    request<MessagePage>(
      `/api/channels/${channelId}/messages?limit=${limit}&after=${encodeURIComponent(after)}`,
    ),

  /**
   * A page centred on one message: what landing on a search result or a pin
   * needs. Both cursors come back set, because a window in the middle of a
   * channel has history above it and live messages below it.
   *
   * Against a server too old to know `around`, the parameter is ignored and
   * the newest page comes back instead -- the reader ends up at the bottom of
   * the right channel rather than seeing an error, which is the better of the
   * two failures.
   */
  historyAround: (channelId: string, around: string, limit = 50) =>
    request<MessagePage>(
      `/api/channels/${channelId}/messages?limit=${limit}&around=${encodeURIComponent(around)}`,
    ),

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
    return request<SearchPage>(`/api/search?${qs}`);
  },

  send: (
    channelId: string,
    content: string,
    clientNonce: string,
    extra: SendExtras = {},
  ) =>
    request<Message>(`/api/channels/${channelId}/messages`, {
      method: 'POST',
      // Spread rather than listed, so a field added to `SendExtras` needs no
      // edit here. Absent keys are dropped by JSON.stringify, which is what
      // keeps an ordinary message an ordinary message on the wire.
      body: { content, clientNonce, ...extra },
    }),

  /**
   * Send with files. Multipart rather than the JSON route, because upload and
   * send are one request server-side -- an attachment cannot exist without its
   * message.
   *
   * XMLHttpRequest rather than `fetch`, for the one thing fetch cannot do:
   * report how much of the body has gone out. React Native's `fetch` is built
   * on the same native networking stack, so this is not a downgrade; it is the
   * only API on either platform that exposes upload progress at all. A phone
   * uploading a video over a bad connection with no sign of movement reads as
   * an app that has hung, and the only honest way to say otherwise is the
   * number itself. `onProgress` is called with 0..1.
   *
   * Content-Type is deliberately unset: the multipart boundary has to be added
   * by whatever builds the request, and setting the header by hand is the
   * classic way to send a body no server can parse.
   */
  sendWithFiles: (
    channelId: string,
    content: string,
    clientNonce: string,
    files: UploadFile[],
    extra: SendExtras = {},
    onProgress?: (fraction: number) => void,
  ): Promise<Message> => {
    const form = new FormData();
    form.append('content', content);
    form.append('clientNonce', clientNonce);
    // Every multipart field is a string, including this one. The server's
    // schema accepts "true"/"false" for exactly this reason -- a reply with a
    // photo on it comes this way rather than as JSON.
    if (extra.replyToId) form.append('replyToId', extra.replyToId);
    if (extra.replyPing === false) form.append('replyPing', 'false');
    if (extra.forwardedFromId) form.append('forwardedFromId', extra.forwardedFromId);
    for (const f of files) form.append('files', fileField(f));

    return upload<Message>(
      `${serverUrl}/api/channels/${channelId}/messages`,
      form,
      onProgress,
    );
  },

  editMessage: (channelId: string, id: string, content: string) =>
    request<Message>(`/api/channels/${channelId}/messages/${id}`, {
      method: 'PATCH',
      body: { content },
    }),

  deleteMessage: (channelId: string, id: string) =>
    request<{ ok: boolean }>(`/api/channels/${channelId}/messages/${id}`, {
      method: 'DELETE',
    }),

  reads: () => request<ChannelRead[]>('/api/reads'),

  mentions: () => request<ChannelMentions[]>('/api/mentions'),

  markRead: (channelId: string, lastReadMessageId: string) =>
    request<ChannelRead>(`/api/channels/${channelId}/read`, {
      method: 'POST',
      body: { lastReadMessageId },
    }),

  /**
   * Change your own display name, or take your picture away. Comes back as the
   * whole public user, which is the same object everyone else gets over the
   * socket -- so the screen that sent this redraws from the same shape as the
   * screens that did not.
   */
  updateProfile: (patch: { displayName?: string; removeAvatar?: true }) =>
    request<PublicUser>('/api/me', { method: 'PATCH', body: patch }),

  /**
   * Replace your avatar.
   *
   * The file is whatever the picker handed back, already cropped square by the
   * system's own editor -- the server stores what it is given and has no image
   * codec to resize with. On the desktop that crop is a canvas and a drag
   * handle written by hand; here it is `allowsEditing` on the picker, which is
   * the platform's cropper and better than anything this app would draw.
   */
  uploadAvatar: (file: UploadFile) => {
    const form = new FormData();
    form.append('file', fileField({ ...file, name: file.name || 'avatar.jpg' }));
    return upload<PublicUser>(`${serverUrl}/api/me/avatar`, form);
  },

  /* --------------------------------------------------------------- pins */

  /**
   * The pinned messages in a channel, newest post first and never paged -- the
   * server caps how many a channel may hold, which is most of the point of the
   * cap. Asked for when the board is opened rather than on every channel
   * switch: the button in the header is always there regardless.
   */
  pins: (channelId: string) =>
    request<Message[]>(`/api/channels/${channelId}/messages/pinned`),
  pinMessage: (channelId: string, id: string) =>
    request<Message>(`/api/channels/${channelId}/messages/${id}/pin`, {
      method: 'POST',
    }),
  unpinMessage: (channelId: string, id: string) =>
    request<{ ok: boolean }>(`/api/channels/${channelId}/messages/${id}/pin`, {
      method: 'DELETE',
    }),

  /* ---------------------------------------------------------- reactions */

  /**
   * Add or take back my reaction. Both hand back every pile on the message,
   * not just the one that changed, so the caller can drop the whole row in
   * rather than patch it -- and so a reaction somebody else added in the same
   * moment arrives with the answer instead of a render later.
   *
   * The emoji is encoded because it is a path segment and some of them are
   * several codepoints; the server decodes and canonicalises before it stores
   * anything, so the spelling sent here is not what decides the row.
   *
   * `PUT` for add: it says "let this exist", which is exactly right for
   * something a double-tap must not do twice.
   */
  react: (channelId: string, id: string, emoji: string) =>
    request<Reaction[]>(
      `/api/channels/${channelId}/messages/${id}/reactions/${encodeURIComponent(emoji)}`,
      { method: 'PUT' },
    ),
  unreact: (channelId: string, id: string, emoji: string) =>
    request<Reaction[]>(
      `/api/channels/${channelId}/messages/${id}/reactions/${encodeURIComponent(emoji)}`,
      { method: 'DELETE' },
    ),
};

/* ------------------------------------------------------------- uploads */

/**
 * A file on this device, on its way to the server.
 *
 * A `uri` and not a `File`: there is no such thing here. Both pickers hand
 * back a content:// or file:// URI, and React Native's `FormData` knows how to
 * read one when it is given this exact shape -- a plain object with `uri`,
 * `name` and `type`. That is not a documented interface so much as a
 * convention the platform's networking module implements, which is why it is
 * written down once, here, rather than built inline at each call.
 */
export interface UploadFile {
  uri: string;
  name: string;
  /** The MIME type. The server validates it; a wrong guess is refused, not stored. */
  type: string;
}

/**
 * The shape React Native's FormData wants. Cast because the DOM's `FormData`
 * types, which is what TypeScript has for it, only admit strings and Blobs --
 * and neither exists on this platform.
 */
function fileField(file: UploadFile): any {
  return { uri: file.uri, name: file.name, type: file.type } as any;
}

/** One multipart POST, with progress. Shared by sends and the avatar route. */
function upload<T>(
  url: string,
  form: FormData,
  onProgress?: (fraction: number) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader(CLIENT_VERSION_HEADER, CLIENT_VERSION);

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) {
          onProgress(Math.min(1, e.loaded / e.total));
        }
      };
      // The last byte leaving is not the same as the message existing: the
      // server still has to write the files and the row. Pinning it at 1 here
      // is what turns the ring into a spinner for that last stretch, rather
      // than leaving it stuck at 99% looking wedged.
      xhr.upload.onload = () => onProgress(1);
    }

    xhr.onload = () => {
      let data: any = {};
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch {
        data = {};
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new ApiError(xhr.status, data.message || `HTTP ${xhr.status}`));
    };
    // Same account as `send` gives: a request that never reached a server has
    // no status and no body, and the address is the likely fault.
    xhr.onerror = () => reject(new ApiError(0, unreachable(url)));
    xhr.onabort = () => reject(new ApiError(0, 'Upload cancelled.'));
    xhr.ontimeout = () => reject(new ApiError(0, 'The upload timed out.'));

    xhr.send(form);
  });
}

export type { Channel, Guild, Message, MessagePage };
