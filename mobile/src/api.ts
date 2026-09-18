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

  send: (channelId: string, content: string, clientNonce: string) =>
    request<Message>(`/api/channels/${channelId}/messages`, {
      method: 'POST',
      body: { content, clientNonce },
    }),

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

  updateProfile: (patch: { displayName?: string }) =>
    request<PublicUser>('/api/me', { method: 'PATCH', body: patch }),
};

export type { Channel, Guild, Message, MessagePage };
