/**
 * The DTOs this client reads, redeclared rather than imported.
 *
 * `packages/shared` exists and the server validates against it, but this app
 * deliberately does not depend on it -- the same call the desktop client makes,
 * and the README records why: a workspace dependency for a file of pure types
 * is a worse trade than the copy. Here there is a second reason on top. This
 * app lives outside the npm workspace so that Metro resolves one flat
 * `node_modules` of its own; reaching back into `packages/shared` would mean a
 * symlink across that boundary, a CommonJS build step ordered before every
 * bundle, and Metro configuration to match. For a file with no runtime in it.
 *
 * The rule that makes the copy safe is the one the whole project runs on:
 * **every field a newer server adds is optional here, and is read with `?.` or
 * `?? default`.** An old client must draw a message from a new server, so
 * nothing below is `.strict()` and no absent field is ever compared with
 * `=== false`. Change one of these, change the server's declaration too.
 */

export interface Me {
  id: string;
  username: string | null;
  displayName: string | null;
  image: string | null;
}

/** A user as everyone else sees them. */
export interface PublicUser {
  id: string;
  username: string;
  displayName: string | null;
  image: string | null;
}

export interface Channel {
  id: string;
  guildId: string;
  name: string;
  kind: 'TEXT' | 'VOICE';
  position: number;
  /** A voice channel nobody may speak in. Absent from an older server. */
  listenOnly?: boolean;
}

export interface Guild {
  id: string;
  name: string;
  channels: Channel[];
}

export interface Attachment {
  id: string;
  fileName: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  /** A path on the API, e.g. /api/attachments/<id> -- never a full URL. */
  url: string;
  /** When the server will remove the file, or null for one it keeps. */
  expiresAt?: string | null;
  /** Set once the deadline passed and the bytes went. The row stays. */
  expiredAt?: string | null;
  /** Whether the server will hand this back as something drawable. */
  inline?: boolean;
}

/** A message quoted by another: what a reply shows above itself. */
export interface MessageRef {
  id: string;
  channelId: string;
  author: PublicUser;
  /** Empty when `deleted`: the server does not hand back removed content. */
  content: string;
  createdAt: string;
  editedAt: string | null;
  attachments: Attachment[];
  deleted: boolean;
}

export interface Reaction {
  emoji: string;
  userIds: string[];
}

export interface Message {
  id: string;
  channelId: string;
  author: PublicUser;
  content: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  clientNonce: string | null;
  /** Who this message tagged. Never contains the author. */
  mentions?: string[];
  pinnedAt?: string | null;
  attachments: Attachment[];
  replyTo?: MessageRef | null;
  forwardedFrom?: MessageRef | null;
  reactions?: Reaction[];
}

export interface MessagePage {
  messages: Message[];
  /** Pass as `before` for older messages. Null once fully scrolled back. */
  nextCursor: string | null;
  /** Pass as `after` for newer ones. Null at the live end of the channel. */
  prevCursor?: string | null;
}

export interface Member {
  guildId: string;
  role: 'ADMIN' | 'MEMBER';
  online: boolean;
  mutedUntil: string | null;
  lastSeenAt: string | null;
  user: PublicUser;
}

export interface ChannelRead {
  channelId: string;
  lastReadMessageId: string | null;
}

/** Unread tags in one channel. Absent from the list when there are none. */
export interface ChannelMentions {
  channelId: string;
  count: number;
}

export interface ServerConfig {
  livekitUrl: string;
  maxUploadBytes: number;
  appVersion: string;
  latestClientVersion: string | null;
  minClientVersion: string | null;
  /**
   * The newest Android build published to this server. Both of these are
   * absent from a server that predates the Android channel, which reads
   * correctly as "no update has ever been published" -- so an app pointed at
   * an older server simply never offers one, rather than failing.
   */
  latestAndroidVersion?: string | null;
  latestAndroidVersionCode?: number | null;
}
